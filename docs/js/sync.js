// Session <-> G-code synchronisation: time mapping, automatic alignment from logged toolhead positions,
// and per-segment aggregation of ALPS samples.
import { posAt } from './gcode.js';

// Piecewise-linear monotone map between gcode time and session time (seconds). Slope is 1 outside the anchors.
export class TimeMap {
  constructor(g, s) { this.g = Float64Array.from(g); this.s = Float64Array.from(s); }
  static linear(offset, scale, total) {
    const T = total > 0 ? total : 1;
    return new TimeMap([0, T], [offset, offset + scale * T]);
  }
  static _interp(xs, ys, x) {
    const n = xs.length;
    if (x <= xs[0]) return ys[0] + (x - xs[0]);
    if (x >= xs[n - 1]) return ys[n - 1] + (x - xs[n - 1]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
    return ys[lo] + ((ys[hi] - ys[lo]) * (x - xs[lo])) / (xs[hi] - xs[lo]);
  }
  toSession(tg) { return TimeMap._interp(this.g, this.s, tg); }
  toGcode(ts) { return TimeMap._interp(this.s, this.g, ts); }
}

// ---- session columns ------------------------------------------------------------------------
// Rows are [t, raw, filt, z, x, y]; returns typed columns with t relative to session start (NaN = missing).
export async function loadColumns(db, id, session) {
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
  return { n, t: t.subarray(0, n), raw: c.raw.subarray(0, n), filt: c.filt.subarray(0, n), x: c.x.subarray(0, n), y: c.y.subarray(0, n), z: c.z.subarray(0, n) };
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
// signal: 'filt' | 'raw'. Returns {mean,min,max} (counts, NaN = no data) for every segment.
export function aggregate(g, map, cols, signal = 'filt') {
  const n = g.n, m = cols.n, T = cols.t, V = cols[signal];
  const mean = new Float32Array(n).fill(NaN), lo = new Float32Array(n).fill(NaN), hi = new Float32Array(n).fill(NaN);
  if (!m) return { mean, min: lo, max: hi };
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (g.flags[i] & 4) continue;
    const s0 = map.toSession(g.t0[i]), s1 = map.toSession(g.t0[i] + g.dur[i]);
    while (j < m && T[j] < s0) j++;
    let sum = 0, c = 0, mn = Infinity, mx = -Infinity;
    for (let k = j; k < m && T[k] < s1; k++) {
      const v = V[k];
      if (Number.isNaN(v)) continue;
      sum += v; c++;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (!c) {
      const mid = (s0 + s1) / 2;
      let k = j < m && (j === 0 || Math.abs(T[j] - mid) < Math.abs(T[j - 1] - mid)) ? j : j - 1;
      if (k < 0 || k >= m || Math.abs(T[k] - mid) > 0.5 || Number.isNaN(V[k])) continue;
      sum = V[k]; c = 1; mn = mx = V[k];
    }
    mean[i] = sum / c; lo[i] = mn; hi[i] = mx;
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
