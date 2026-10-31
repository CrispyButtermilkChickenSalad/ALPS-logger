// Pressure-advance (PA) test: G-code generator and anti-timing-anchor step-response analysis.
// Pattern per K: a long slow "gap" leg, then `cycles` x [fast, slow]. Blocks (one per K) are found from the
// longer interval between bursts, so no absolute clock sync with the printer is needed.
import { percentile } from './sync.js';

export const DEFAULT_PA = {
  mode: 'air', kstart: 0, kend: 0.08, kstep: 0.005, cycles: 8, tslow: 1.0, tfast: 0.25, tgap: 3.0,
  vfr: 19.24, vfrLow: 1.92, wobble: 0.05, axis: 'Y', x: 110, y: 110, z: 30,
  vSlow: 10, vFast: 60, width: 0.45, height: 0.3, x0: 20, y0: 20, yStep: 2, retract: 0.8, bedLen: 200,
  filament: 1.75, accel: 1000,
};

export function kValues(p) {
  const n = Math.round((p.kend - p.kstart) / p.kstep), out = [];
  for (let i = 0; i <= n; i++) out.push(+(p.kstart + i * p.kstep).toFixed(6));
  return out;
}

export function checkParams(p) {
  if (!(p.kstep > 0) || !(p.kend > p.kstart)) throw new Error('K range must increase (kend > kstart, kstep > 0)');
  if (!(p.cycles >= 3)) throw new Error('Use at least 3 cycles per K');
  if (!(p.tslow > 0 && p.tfast > 0)) throw new Error('Leg durations must be positive');
  if (p.tgap < 0.6 * (p.tslow + p.tfast)) throw new Error('Gap leg must be at least 0.6 x (slow + fast) so K blocks can be separated');
  if (!(p.filament > 0)) throw new Error('Filament diameter must be positive');
  if (kValues(p).length > 200) throw new Error('Too many K values');
}

const f = (v, d = 3) => +v.toFixed(d);

export function genGcode(p) {
  checkParams(p);
  const ks = kValues(p), area = Math.PI * (p.filament / 2) ** 2, P = p.tslow + p.tfast;
  const L = [`; ALPS pressure-advance sweep (${p.mode}) - K ${ks[0]}..${ks[ks.length - 1]} step ${p.kstep}`,
    `; ${p.cycles} cycles/K, slow ${p.tslow}s, fast ${p.tfast}s, gap ${p.tgap}s. Heat the nozzle first (M109).`, 'M83'];
  const notes = [];
  let seconds = 0;
  if (p.mode === 'air') {
    notes.push(`Set [extruder] max_extrude_cross_section: ${Math.ceil(p.vfr * p.tfast / p.wobble)} (or higher) in printer.cfg, otherwise Klipper rejects the fast legs.`);
    notes.push('Position the nozzle clear of the bed and any part: it extrudes in the air at the park position.');
    L.push('G90', `G1 Z${p.z} F600`, `G1 X${p.x} Y${p.y} F6000`, `SET_VELOCITY_LIMIT ACCEL=${p.accel}`, 'G91');
    let sign = 1;
    const leg = (flow, t) => {
      const d = p.wobble * sign; sign = -sign;
      L.push(`G1 ${p.axis}${f(d)} E${f(flow * t / area)} F${f(Math.abs(d) / t * 60, 2)}`);
      seconds += t;
    };
    for (const k of ks) {
      L.push(`SET_PRESSURE_ADVANCE ADVANCE=${k.toFixed(4)}`);
      leg(p.vfrLow, p.tgap);
      for (let c = 0; c < p.cycles; c++) { leg(p.vfr, p.tfast); leg(p.vfrLow, p.tslow); }
    }
    L.push('G90');
  } else {
    const lineLen = p.vSlow * p.tgap + p.cycles * (p.vSlow * p.tslow + p.vFast * p.tfast);
    if (lineLen > p.bedLen) throw new Error(`Each line would be ${lineLen.toFixed(0)} mm (> ${p.bedLen}): reduce cycles/speeds/durations`);
    notes.push(`Each line is ${lineLen.toFixed(0)} mm long; ${ks.length} lines spaced ${p.yStep} mm. Check the first-layer Z offset; the lines are printed in contact with the bed.`);
    notes.push(`Peak flow ${f(p.width * p.height * p.vFast, 1)} mm3/s.`);
    L.push('G90', `SET_VELOCITY_LIMIT ACCEL=${p.accel}`);
    ks.forEach((k, i) => {
      const y = p.y0 + i * p.yStep;
      let x = p.x0;
      L.push(`G1 Z${f(p.height + 0.6)} F600`, `G1 X${p.x0} Y${y} F9000`, `G1 Z${p.height} F600`, `G1 E${p.retract} F1800`, `SET_PRESSURE_ADVANCE ADVANCE=${k.toFixed(4)}`);
      const seg = (v, t) => {
        const len = v * t; x += len;
        L.push(`G1 X${f(x, 2)} E${f(p.width * p.height * len / area)} F${f(v * 60, 0)}`);
        seconds += t;
      };
      seg(p.vSlow, p.tgap);
      for (let c = 0; c < p.cycles; c++) { seg(p.vFast, p.tfast); seg(p.vSlow, p.tslow); }
      L.push(`G1 E-${p.retract} F1800`, `G1 Z${f(p.height + 0.6)} F600`);
      seconds += 3;
    });
  }
  L.push('M83');
  return { gcode: L.join('\n') + '\n', ks, seconds: Math.round(seconds), notes, period: P };
}

// ---- analysis -------------------------------------------------------------------------------------
const lb = (t, x) => { let lo = 0, hi = t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; } return lo; };
function med(t, y, a, b) {
  const i = lb(t, a), j = lb(t, b);
  if (j - i < 2) return NaN;
  const s = Float64Array.from(y.subarray(i, j)).sort();
  return s[s.length >> 1];
}
function interp(t, y, x) {
  const j = lb(t, x);
  if (j <= 0) return y[0];
  if (j >= t.length) return y[t.length - 1];
  return y[j - 1] + ((x - t[j - 1]) / (t[j] - t[j - 1] || 1)) * (y[j] - y[j - 1]);
}
function integ(t, y, a, b, ideal) {
  let s = 0;
  for (let x = a; x < b; x += 0.001) s += (interp(t, y, x) - ideal(x)) * 0.001;
  return s;
}
const median = (a) => { const v = a.filter(Number.isFinite).sort((p, q) => p - q); return v.length ? v[v.length >> 1] : NaN; };

function burstMetrics(t, y, tr, tf, o) {
  const dur = tf - tr, ts = o.tslow;
  const base = med(t, y, tr - 0.4 * ts, tr - 0.05 * ts);
  const plat = med(t, y, tr + 0.6 * dur, tf - 0.05 * dur);
  const post = med(t, y, tf + 0.5 * ts, tf + 0.95 * ts);
  const step = plat - base;
  if (![base, plat, post].every(Number.isFinite) || !(step > 0)) return null;
  const early = med(t, y, tr + 0.35 * dur, tr + 0.65 * dur), late = med(t, y, tr + 0.7 * dur, tr + 0.95 * dur);
  const tail = med(t, y, tf + 0.05, tf + Math.min(0.15, 0.4 * ts));
  let mx = -Infinity, mn = Infinity;
  for (let i = lb(t, tr), e = lb(t, tr + 0.5 * dur); i < e; i++) mx = Math.max(mx, y[i]);
  for (let i = lb(t, tf), e = lb(t, tf + 0.4 * ts); i < e; i++) mn = Math.min(mn, y[i]);
  const w = Math.min(0.15, 0.45 * o.tfast, 0.45 * ts);
  const R = integ(t, y, tr - w, tr + w, (x) => (x < tr ? base : plat)) / step;
  const F = integ(t, y, tf - w, tf + w, (x) => (x < tf ? plat : post)) / step;
  return {
    step, overshoot: Math.max(0, (mx - plat) / step), undershoot: Math.max(0, (post - mn) / step),
    creep: (late - early) / step, tail: (tail - post) / step, R: R * 1000, F: F * 1000, S: (R - F) * 1000,
  };
}

function parabolicArgmin(ks, c) {
  let bi = -1;
  c.forEach((v, i) => { if (Number.isFinite(v) && (bi < 0 || v < c[bi])) bi = i; });
  if (bi < 0) return NaN;
  if (bi === 0 || bi === c.length - 1 || !Number.isFinite(c[bi - 1]) || !Number.isFinite(c[bi + 1])) return ks[bi];
  const d = c[bi - 1] - 2 * c[bi] + c[bi + 1];
  if (d <= 0) return ks[bi];
  return ks[bi] + (0.5 * (c[bi - 1] - c[bi + 1]) / d) * (ks[bi + 1] - ks[bi]);
}
function zeroCrossings(ks, v) {
  const out = [];
  for (let i = 0; i + 1 < ks.length; i++) {
    const a = v[i], b = v[i + 1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (a === 0) out.push(ks[i]);
    else if (a * b < 0) out.push(ks[i] + (-a * (ks[i + 1] - ks[i])) / (b - a));
  }
  return out;
}

// t: seconds (sorted), v: force counts. opts: tslow,tfast,tgap,ks, invert ('auto'|'yes'|'no'), tStart,tEnd,blockOffset
export function analyzePa(t0, v0, opts) {
  const o = { invert: 'auto', blockOffset: 0, ...opts };
  const warnings = [];
  let a = 0, b = t0.length;
  if (Number.isFinite(o.tStart)) a = lb(t0, o.tStart);
  if (Number.isFinite(o.tEnd)) b = lb(t0, o.tEnd);
  if (b - a < 100) return { ok: false, message: 'Not enough samples in the selected range', warnings };
  const t = Float64Array.from(t0.subarray(a, b)), raw = Float64Array.from(v0.subarray(a, b));
  const p1 = percentile(raw, 1), p50 = percentile(raw, 50), p99 = percentile(raw, 99);
  const invert = o.invert === 'yes' || (o.invert === 'auto' && p50 - p1 > p99 - p50);
  const y = invert ? raw.map((x) => -x) : raw;
  const lo = percentile(y, 1), hi = percentile(y, 99), span = hi - lo;
  if (!(span > 0)) return { ok: false, message: 'Signal is flat', warnings };
  const up = lo + 0.6 * span, dn = lo + 0.4 * span, mid = lo + 0.5 * span;

  const rises = [], falls = [];
  let high = false;
  for (let i = 1; i < t.length; i++) {
    if (!high && y[i] > up) {
      let j = i; while (j > 0 && y[j] > mid) j--;
      const d = y[j + 1] - y[j] || 1;
      rises.push(t[j] + ((mid - y[j]) / d) * (t[j + 1] - t[j])); high = true;
    } else if (high && y[i] < dn) {
      let j = i; while (j > 0 && y[j] < mid) j--;
      const d = y[j] - y[j + 1] || 1;
      falls.push(t[j] + ((y[j] - mid) / d) * (t[j + 1] - t[j])); high = false;
    }
  }
  const bursts = [];
  for (let i = 0; i < rises.length; i++) {
    const f2 = falls.find((x) => x > rises[i]);
    if (f2 === undefined) continue;
    if (i + 1 < rises.length && f2 > rises[i + 1]) continue;
    const d = f2 - rises[i];
    if (d > 0.5 * o.tfast && d < 1.6 * o.tfast) bursts.push([rises[i], f2]);
  }
  if (bursts.length < 3) return { ok: false, message: `Found only ${bursts.length} bursts of about ${o.tfast}s: check the timing values, polarity and range`, warnings, polarity: invert ? -1 : 1 };

  const P = o.tslow + o.tfast, split = P + 0.5 * o.tgap;
  let blocks = [[bursts[0]]];
  for (let i = 1; i < bursts.length; i++) {
    if (bursts[i][0] - bursts[i - 1][0] > split) blocks.push([]);
    blocks[blocks.length - 1].push(bursts[i]);
  }
  blocks = blocks.filter((bl) => bl.length >= 3).slice(o.blockOffset || 0);
  const ks = o.ks;
  if (blocks.length !== ks.length) warnings.push(`Found ${blocks.length} K blocks but expected ${ks.length}; K values were assigned in order from the first block`);
  blocks = blocks.slice(0, ks.length);

  const rows = [], overlay = [];
  const grid = [];
  const g0 = -0.3 * o.tslow, g1 = o.tfast + 0.5 * o.tslow;
  for (let x = g0; x <= g1; x += 0.002) grid.push(x);
  blocks.forEach((bl, bi) => {
    const use = bl.slice(1), ms = use.map(([tr, tf]) => ({ tr, m: burstMetrics(t, y, tr, tf, o) })).filter((x) => x.m);
    if (!ms.length) { rows.push({ k: ks[bi], nBursts: 0 }); overlay.push(null); return; }
    const row = { k: ks[bi], nBursts: ms.length };
    for (const key of ['step', 'overshoot', 'undershoot', 'creep', 'tail', 'R', 'F', 'S']) row[key] = median(ms.map((x) => x.m[key]));
    rows.push(row);
    const acc = new Float64Array(grid.length);
    for (const { tr, m } of ms) {
      const base = med(t, y, tr - 0.4 * o.tslow, tr - 0.05 * o.tslow);
      grid.forEach((x, i) => { acc[i] += (interp(t, y, tr + x) - base) / m.step; });
    }
    overlay.push({ x: grid, y: Array.from(acc, (s) => s / ms.length) });
  });

  const kk = rows.map((r) => r.k);
  const cols = ['overshoot', 'undershoot', 'creep', 'tail', 'S'].map((key) => rows.map((r) => Math.abs(r[key])));
  const mx = cols.map((c) => Math.max(...c.filter(Number.isFinite), 0));
  const cost = rows.map((_, i) => {
    let s = 0, n = 0;
    cols.forEach((c, j) => { if (mx[j] > 0 && Number.isFinite(c[i])) { s += c[i] / mx[j]; n++; } });
    return n ? s / n : NaN;
  });
  const kComposite = parabolicArgmin(kk, cost);
  const crossings = zeroCrossings(kk, rows.map((r) => r.S));
  const kSigned = crossings.length ? crossings.reduce((p, c) => (Math.abs(c - kComposite) < Math.abs(p - kComposite) ? c : p)) : NaN;
  if (!crossings.length) warnings.push('Signed edge error never crosses zero: widen the K range');
  else if (crossings.length > 1) warnings.push(`Signed edge error crosses zero ${crossings.length} times: the data is noisy or the range is too wide`);
  return { ok: true, polarity: invert ? -1 : 1, nBursts: bursts.length, nBlocks: blocks.length, rows, cost, overlay, kComposite, kSigned, crossings, warnings };
}
