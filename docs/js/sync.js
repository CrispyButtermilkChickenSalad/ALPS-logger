// Session <-> G-code synchronisation: time mapping, automatic alignment from logged toolhead positions,
// and per-segment aggregation of ALPS samples.
import { posAt, positionAtFile } from './gcode.js';

// Monotone map between G-code and session seconds. Repeated G-code anchors represent file-progress holds.
// At a hold, toSession() chooses its end. Slope is 1 outside the anchors.
export class TimeMap {
  constructor(g, s, { coverage = null } = {}) { this.g = Float64Array.from(g); this.s = Float64Array.from(s); this.coverage = coverage; }
  static linear(offset, scale, total) {
    const T = total > 0 ? total : 1;
    return new TimeMap([0, T], [offset, offset + scale * T]);
  }
  static _interp(xs, ys, x) {
    const n = xs.length;
    if (x < xs[0]) return ys[0] + (x - xs[0]);
    if (x >= xs[n - 1]) return ys[n - 1] + (x - xs[n - 1]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
    return ys[lo] + ((ys[hi] - ys[lo]) * (x - xs[lo])) / (xs[hi] - xs[lo]);
  }
  toSession(tg) { return TimeMap._interp(this.g, this.s, tg); }
  toGcode(ts) { return TimeMap._interp(this.s, this.g, ts); }
}

// Session boundaries are recording boundaries, not necessarily actual print boundaries.
export function endpointSync(g, session) {
  const duration = session?.ended - session?.started;
  if (!Number.isFinite(session?.started) || !Number.isFinite(session?.ended) ||
      !(duration > 0) || !Number.isFinite(g?.totalTime) || !(g.totalTime > 0)) return null;
  return TimeMap.linear(0, duration / g.totalTime, g.totalTime);
}

// ---- session columns ------------------------------------------------------------------------
// Rows are [t, raw, filt, z, x, y]; returns typed columns with t relative to session start (NaN = missing).
// Sessions captured as 'events' or 'envelope' only have gaps in the raw rows, so they are loaded from the
// envelope instead (raw = bucket mean, filt = bucket filtered mean); `fromEnv` is set on the result.
export async function loadColumns(db, id, session, { preferRaw = false } = {}) {
  const loadEnvelope = async () => {
    if (typeof db.getSamples !== 'function') return null;
    const env = await db.getSamples(id, 'env');
    if (env.length) {
      const n = env.length, t = new Float64Array(n), raw = new Float32Array(n), filt = new Float32Array(n);
      const rawMin = new Float32Array(n), rawMax = new Float32Array(n);
      const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n);
      const nz = (v) => (v == null ? NaN : v);
      env.forEach((r, i) => { t[i] = r[0] - session.started; rawMin[i] = nz(r[1]); raw[i] = nz(r[2]); rawMax[i] = nz(r[3]); filt[i] = nz(r[5]); z[i] = nz(r[6]); x[i] = nz(r[7]); y[i] = nz(r[8]); });
      return { n, t, raw, filt, rawMin, rawMax, x, y, z, fromEnv: true, bucketS: session.capture?.bucketS > 0 ? session.capture.bucketS : null };
    }
    return null;
  };
  if (!preferRaw && (session.capture?.mode ?? 'full') !== 'full') {
    const env = await loadEnvelope();
    if (env) return env;
  }
  let cap = Math.max(1024, (session.n || 0) + 1024), n = 0;
  let t = new Float64Array(cap);
  let c = { raw: new Float32Array(cap), filt: new Float32Array(cap), x: new Float32Array(cap), y: new Float32Array(cap), z: new Float32Array(cap) };
  const grow = () => {
    cap *= 2;
    const nt = new Float64Array(cap); nt.set(t); t = nt;
    for (const k in c) { const a = new Float32Array(cap); a.set(c[k]); c[k] = a; }
  };
  const nz = (v) => (v == null ? NaN : v);
  await db.scanSamples(id, (rows) => {
    for (const r of rows) {
      if (n === cap) grow();
      t[n] = r[0] - session.started;
      c.raw[n] = nz(r[1]); c.filt[n] = nz(r[2]); c.z[n] = nz(r[3]); c.x[n] = nz(r[4]); c.y[n] = nz(r[5]);
      n++;
    }
  });
  const cols = { n, t: t.subarray(0, n), raw: c.raw.subarray(0, n), filt: c.filt.subarray(0, n), x: c.x.subarray(0, n), y: c.y.subarray(0, n), z: c.z.subarray(0, n) };
  if (!preferRaw) {
    const duration = session.ended - session.started;
    let incomplete = !n || (Number.isFinite(duration) && (t[0] > 1 || t[n - 1] < duration - 1));
    for (let i = 1; i < n && !incomplete; i++) incomplete = t[i] - t[i - 1] > 1;
    if (incomplete) {
      const env = await loadEnvelope();
      if (env) return env;
    }
  }
  return cols;
}

// Distinct toolhead poses (rows where x/y/z changed) – these come from the Moonraker poll.
export function extractPoses(cols) {
  const t = [], x = [], y = [], z = [];
  let px = NaN, py = NaN, pz = NaN;
  for (let i = 0; i < cols.n; i++) {
    const a = cols.x[i], b = cols.y[i], d = cols.z[i];
    if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(d)) continue;
    if (a === px && b === py && d === pz) continue;
    px = a; py = b; pz = d;
    t.push(cols.t[i]); x.push(a); y.push(b); z.push(d);
  }
  return { n: t.length, t: Float64Array.from(t), x: Float64Array.from(x), y: Float64Array.from(y), z: Float64Array.from(z) };
}

// Position trace rows: [epoch, reportedX, reportedY, reportedZ, filePosition, fileSize, filename, state].
export function reportedPoses(rows, session) {
  const nz = (v) => v == null ? NaN : v;
  return extractPoses({
    n: rows.length, t: rows.map((r) => r[0] - session.started),
    x: rows.map((r) => nz(r[1])), y: rows.map((r) => nz(r[2])), z: rows.map((r) => nz(r[3])),
  });
}

export function fileProgressSync(g, rows, session, filename) {
  const valid = rows.filter((r) => r[6] && ['printing', 'paused', 'complete'].includes(r[7]) &&
    Number.isSafeInteger(r[4]) && r[4] >= 0 && Number.isSafeInteger(r[5]) && r[5] > 0);
  if (!valid.length) throw new Error('No recorded file progress. Record with Moonraker enabled; older sessions and streamed G-code cannot use virtual alignment.');
  const expected = session.file || valid[0][6];
  if (filename.split('/').pop() !== expected.split('/').pop()) throw new Error('Virtual alignment needs the original G-code file: ' + expected);
  const matching = valid.filter((r) => r[6] === expected);
  if (!matching.length) throw new Error('No recorded file progress for ' + expected);
  if (matching.some((r) => r[5] !== g.fileSize)) throw new Error('G-code byte size differs from the recorded job. Load the original, unmodified file.');
  const gs = [], ss = [], x = [], y = [], z = [];
  let prevBytes = -1;
  for (const r of matching) {
    if (r[4] < prevBytes) throw new Error('Recorded file position moved backwards; virtual alignment cannot map a restarted or rewound job.');
    prevBytes = r[4];
    const p = positionAtFile(g, r[4]), t = r[0] - session.started;
    if (!p) throw new Error('Recorded file position is outside the G-code file.');
    if (!Number.isFinite(t) || (ss.length && t < ss[ss.length - 1])) throw new Error('Recorded position timestamps are not increasing.');
    if (ss.length && t === ss[ss.length - 1]) continue;
    gs.push(p.time); ss.push(t); x.push(p.xyz[0]); y.push(p.xyz[1]); z.push(p.xyz[2]);
  }
  if (gs.length < 2 || gs[0] === gs[gs.length - 1]) throw new Error('Insufficient changing file progress to align this session.');
  const coverage = [gs[0], gs[gs.length - 1]];
  return {
    map: new TimeMap(gs, ss, { coverage }),
    poses: { n: ss.length, t: Float64Array.from(ss), x: Float32Array.from(x), y: Float32Array.from(y), z: Float32Array.from(z) },
  };
}

// ---- automatic alignment -----------------------------------------------------------------------
const CAP2 = 15 * 15;
const KZ = 10;
const GOOD = 64; // mean capped squared error (mm^2) for a window to count as matched
const tmp = [0, 0, 0];

function windowCost(g, P, a, b, off) {
  let c = 0;
  for (let i = a; i < b; i++) {
    posAt(g, P.t[i] - off, tmp);
    const dx = tmp[0] - P.x[i], dy = tmp[1] - P.y[i], dz = (tmp[2] - P.z[i]) * KZ;
    c += Math.min(dx * dx + dy * dy + dz * dz, CAP2);
  }
  return c / (b - a);
}

function search(g, P, a, b, lo, hi, step) {
  let best = Infinity, bo = lo;
  const all = [];
  for (let o = lo; o <= hi; o += step) {
    const c = windowCost(g, P, a, b, o);
    all.push(c);
    if (c < best) { best = c; bo = o; }
  }
  for (let o = bo - step; o <= bo + step; o += step / 10) {
    const c = windowCost(g, P, a, b, o);
    if (c < best) { best = c; bo = o; }
  }
  all.sort((p, q) => p - q);
  return { off: bo, cost: best, median: all[all.length >> 1] || best };
}

export function autoSync(g, P, { windowSeconds = 12 } = {}) {
  if (!g.n || P.n < 20) return null;
  const wins = [];
  let a = 0;
  while (a < P.n) {
    let b = a + 1;
    while (b < P.n && (P.t[b] - P.t[a] < windowSeconds || b - a < 20)) b++;
    if (b - a >= 10) wins.push([a, b]);
    a = b;
  }
  const W = wins.length;
  if (W < 3) return null;
  const maxOff = Math.min(P.t[P.n - 1], 3600);
  const offs = new Array(W).fill(null);
  const narrow = (k, ref) => {
    const r = search(g, P, wins[k][0], wins[k][1], ref - 6, ref + 6, 0.1);
    return r.cost < GOOD ? r.off : null;
  };
  const recover = (k, ref) => {
    const r = search(g, P, wins[k][0], wins[k][1], ref - 300, ref + 300, 0.1);
    return r.cost < GOOD && r.cost < 0.3 * r.median ? r.off : null;
  };

  // acquire: first window (within the first minutes) with a clear, verified match
  let k0 = -1;
  for (let k = 0; k < Math.min(W - 2, 60) && k0 < 0; k++) {
    const r = search(g, P, wins[k][0], wins[k][1], -30, maxOff, 0.1);
    if (!(r.cost < GOOD && r.cost < 0.3 * r.median)) continue;
    const n1 = narrow(k + 1, r.off), n2 = n1 == null ? null : narrow(k + 2, n1);
    if (n1 != null && n2 != null) { offs[k] = r.off; offs[k + 1] = n1; offs[k + 2] = n2; k0 = k; }
  }
  if (k0 < 0) return null;

  const track = (from, to, dir) => {
    let ref = offs[from], misses = 0;
    for (let k = from + dir; k >= 0 && k < W && k !== to + dir; k += dir) {
      let o = narrow(k, ref);
      if (o == null && misses >= 1) o = recover(k, ref);
      if (o == null) { misses++; if (dir < 0 && misses >= 3) break; continue; }
      misses = 0; offs[k] = o; ref = o;
    }
  };
  track(k0 + 2, W - 1, 1);
  track(k0, 0, -1);

  const idx = [];
  for (let k = 0; k < W; k++) if (offs[k] != null) idx.push(k);
  const med3 = idx.map((k, j) => {
    const v = [offs[idx[Math.max(0, j - 1)]], offs[k], offs[idx[Math.min(idx.length - 1, j + 1)]]].sort((p, q) => p - q);
    return v[1];
  });
  const gs = [], ss = [];
  idx.forEach((k, j) => {
    let ts = 0;
    for (let i = wins[k][0]; i < wins[k][1]; i++) ts += P.t[i];
    ts /= wins[k][1] - wins[k][0];
    const tg = ts - med3[j];
    if (gs.length && tg <= gs[gs.length - 1] + 0.01) return;
    gs.push(tg); ss.push(ts);
  });
  if (gs.length < 1) return null;
  if (gs.length === 1) { gs.push(gs[0] + 1); ss.push(ss[0] + 1); }
  if (gs.length >= 3) {
    // extend with the overall slope so extrapolated ends keep the time-scale drift
    const m = gs.length - 1;
    const slope = Math.min(1.5, Math.max(0.67, (ss[m] - ss[0]) / (gs[m] - gs[0])));
    if (gs[0] > 0) { gs.unshift(0); ss.unshift(ss[0] - gs[1] * slope); }
    if (gs[gs.length - 1] < g.totalTime) { gs.push(g.totalTime); ss.push(ss[ss.length - 1] + (g.totalTime - gs[gs.length - 2]) * slope); }
  }
  const map = new TimeMap(gs, ss);
  let err = 0;
  idx.forEach((k) => { err += Math.sqrt(windowCost(g, P, wins[k][0], wins[k][1], offs[k])); });
  return {
    map,
    windows: W,
    matched: idx.length,
    rmsMm: Math.round((err / idx.length) * 10) / 10,
    firstOffset: med3[0],
    printSeconds: map.toSession(g.totalTime) - map.toSession(0),
  };
}

// ---- per-segment aggregation ---------------------------------------------------------------------
// Nearest-sample intervals, split at move boundaries. No averaging or summary fallback.
export function projectCurve(g, map, cols, signal = 'filt') {
  if (cols.fromEnv) throw new RangeError('Full-curve preview needs saved full-rate samples, not summary buckets.');
  const T = cols.t, V = cols[signal], m = cols.n;
  const offsets = new Uint32Array(g.n + 1), capacity = m + g.n;
  const f0 = new Float32Array(capacity), f1 = new Float32Array(capacity), values = new Float32Array(capacity);
  const intervals = [];
  let previous = -1;
  for (let k = 0; k < m; k++) {
    if (!Number.isFinite(T[k]) || (k && T[k] < T[k - 1])) throw new RangeError('Sample timestamps must be finite and in recording order.');
    if (!Number.isFinite(V[k])) continue;
    if (previous >= 0 && T[k] > T[previous] && intervals.length < 100000) intervals.push(T[k] - T[previous]);
    previous = k;
  }
  intervals.sort((a, b) => a - b);
  const maxGap = Math.min(1, 4 * (intervals[intervals.length >> 1] || 0));
  const nextSample = (k) => { while (k < m && !Number.isFinite(V[k])) k++; return k; };
  const endTime = (i) => i + 1 < g.n ? g.t0[i + 1] : g.totalTime;
  let n = 0, samples = 0, move = 0, prev = -1, k = nextSample(0);
  while (k < m) {
    const next = nextSample(k + 1), t = T[k];
    const s0 = prev >= 0 && t - T[prev] <= maxGap ? (T[prev] + t) / 2 : t;
    const s1 = next < m && T[next] - t <= maxGap ? (t + T[next]) / 2 : t;
    const a = Math.max(0, map.coverage ? map.coverage[0] : 0, map.toGcode(s0));
    const b = Math.min(g.totalTime, map.coverage ? map.coverage[1] : g.totalTime, map.toGcode(s1));
    const before = n;
    if (b > a) {
      while (move < g.n && endTime(move) <= a) move++;
      for (let i = move; i < g.n && g.t0[i] < b; i++) {
        const end = endTime(i), duration = end - g.t0[i];
        const lo = Math.max(a, g.t0[i]), hi = Math.min(b, end);
        if (!(g.flags[i] & 4) && duration > 0 && hi > lo) {
          f0[n] = (lo - g.t0[i]) / duration; f1[n] = (hi - g.t0[i]) / duration;
          values[n++] = V[k]; offsets[i + 1]++;
        }
        if (end <= b) move = i + 1;
      }
    }
    if (n > before) samples++;
    prev = k; k = next;
  }
  for (let i = 1; i < offsets.length; i++) offsets[i] += offsets[i - 1];
  return { n, samples, offsets, f0: f0.subarray(0, n), f1: f1.subarray(0, n), values: values.subarray(0, n) };
}

export function curveValueAt(curve, move, fraction) {
  if (!curve || move < 0 || move + 1 >= curve.offsets.length) return NaN;
  const start = curve.offsets[move], end = curve.offsets[move + 1];
  let lo = start, hi = end;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (curve.f0[mid] <= fraction) lo = mid + 1; else hi = mid; }
  const k = lo - 1;
  return k >= start && fraction <= curve.f1[k] ? curve.values[k] : NaN;
}

// signal: 'filt' | 'raw'. Returns {mean,min,max} (counts, NaN = no data) for every segment.
export function aggregate(g, map, cols, signal = 'filt') {
  const n = g.n, m = cols.n, T = cols.t, V = cols[signal];
  const mean = new Float32Array(n).fill(NaN), lo = new Float32Array(n).fill(NaN), hi = new Float32Array(n).fill(NaN);
  if (!m) return { mean, min: lo, max: hi };
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (g.flags[i] & 4) continue;
    // Use planner boundaries for file anchors: rounded durations can fall on the wrong side of a hold.
    const end = map.coverage ? (i + 1 < n ? g.t0[i + 1] : g.totalTime) : g.t0[i] + g.dur[i];
    if (map.coverage && (g.t0[i] < map.coverage[0] - 1e-6 || end > map.coverage[1] + 1e-6)) continue;
    const s0 = map.toSession(g.t0[i]), s1 = map.toSession(end);
    const width = cols.fromEnv ? cols.bucketS : 0;
    if (cols.fromEnv && !(width > 0)) continue;
    if (!cols.fromEnv && (s0 < T[0] - 1e-6 || s1 > T[m - 1] + 1e-6)) continue;
    while (j < m && (cols.fromEnv ? T[j] + width <= s0 : T[j] < s0)) j++;
    let sum = 0, c = 0, mn = Infinity, mx = -Infinity;
    let gap = !cols.fromEnv && j > 0 && j < m && T[j] - T[j - 1] > 1;
    for (let k = j; k < m && T[k] < s1; k++) {
      if (!cols.fromEnv && k > 0 && T[k] - T[k - 1] > 1) gap = true;
      const v = V[k];
      if (!Number.isFinite(v)) continue;
      const weight = cols.fromEnv ? Math.max(0, Math.min(s1, T[k] + width) - Math.max(s0, T[k])) : 1;
      if (!weight) continue;
      sum += v * weight; c += weight;
      const vmin = cols.fromEnv && signal === 'raw' ? cols.rawMin[k] : v;
      const vmax = cols.fromEnv && signal === 'raw' ? cols.rawMax[k] : v;
      if (Number.isFinite(vmin) && vmin < mn) mn = vmin;
      if (Number.isFinite(vmax) && vmax > mx) mx = vmax;
    }
    if (!cols.fromEnv && j < m && T[j] < s1) {
      let end = j;
      while (end < m && T[end] < s1) end++;
      if (end < m && end > 0 && T[end] - T[end - 1] > 1) gap = true;
    }
    if (gap) continue;
    if (!c && !cols.fromEnv) {
      const mid = (s0 + s1) / 2;
      if (mid < T[0] || mid > T[m - 1]) continue;
      let k = j < m && (j === 0 || Math.abs(T[j] - mid) < Math.abs(T[j - 1] - mid)) ? j : j - 1;
      if (j > 0 && j < m && T[j] - T[j - 1] > 1) continue;
      if (k < 0 || k >= m || Math.abs(T[k] - mid) > 0.5 || Number.isNaN(V[k])) continue;
      sum = V[k]; c = 1; mn = mx = V[k];
    }
    // Do not paint a whole move from a partially covered summary interval.
    if (cols.fromEnv && c < (s1 - s0) - 0.001) continue;
    if (c) { mean[i] = sum / c; lo[i] = Number.isFinite(mn) ? mn : NaN; hi[i] = Number.isFinite(mx) ? mx : NaN; }
  }
  return { mean, min: lo, max: hi };
}

export function percentile(values, p) {
  const v = Array.from(values).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  return v[Math.min(v.length - 1, Math.max(0, Math.round((p / 100) * (v.length - 1))))];
}

// Median of up to ~100k evenly spaced finite samples (used as the automatic tare).
export function medianOf(arr) {
  const stride = Math.max(1, Math.floor(arr.length / 100000));
  const v = [];
  for (let i = 0; i < arr.length; i += stride) if (Number.isFinite(arr[i])) v.push(arr[i]);
  if (!v.length) return NaN;
  v.sort((a, b) => a - b);
  return v[v.length >> 1];
}
