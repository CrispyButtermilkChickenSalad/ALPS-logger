import test from 'node:test';
import assert from 'node:assert/strict';
import { genGcode, analyzePa, DEFAULT_PA, kValues, checkParams } from '../docs/js/pa.js';

const FS = 1300;
// First-order back-pressure model: the filament pressure follows the commanded flow through a time constant tau,
// and pressure advance feeds forward K * dq/dt, so the response is a clean step only when K == tau.
function simulate(tau, p, { invert = false, noise = 3, lead = 2 } = {}) {
  const ks = kValues(p), dt = 1 / FS, ramp = 0.008, slow = 0.1, fast = 1;
  const ev = []; // [t_on, t_off] fast windows, in order
  let T = lead;
  const kStart = [];
  for (const k of ks) {
    T += p.tgap; kStart.push(T);
    for (let c = 0; c < p.cycles; c++) { ev.push([T, T + p.tfast, k]); T += p.tfast + p.tslow; }
  }
  const total = T + 2, n = Math.floor(total * FS);
  const t = new Float64Array(n), v = new Float64Array(n);
  const clamp = (x) => Math.min(1, Math.max(0, x));
  let pr = slow, qPrev = slow, e = 0, seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  for (let i = 0; i < n; i++) {
    const tt = i * dt;
    while (e < ev.length && tt > ev[e][1] + 0.5) e++;
    let q = slow, k = 0;
    for (let j = Math.max(0, e - 1); j < Math.min(ev.length, e + 2); j++) {
      q += (fast - slow) * (clamp((tt - ev[j][0]) / ramp) - clamp((tt - ev[j][1]) / ramp));
      if (tt >= ev[j][0] - 0.3 && tt <= ev[j][1] + 1) k = ev[j][2];
    }
    if (!k) { const idx = kStart.findIndex((s, b) => tt >= s - p.tgap && (b + 1 >= kStart.length || tt < kStart[b + 1] - p.tgap)); k = idx >= 0 ? ks[idx] : 0; }
    const eff = q + k * (q - qPrev) / dt;
    qPrev = q;
    pr += (dt * (eff - pr)) / tau;
    t[i] = tt;
    v[i] = (invert ? -1 : 1) * (1000 * pr - 670000 + noise * rnd());
  }
  return { t, v, ks };
}

const P = { ...DEFAULT_PA, kstart: 0, kend: 0.1, kstep: 0.005, cycles: 6 };

test('generator: air mode emits one K block per value with correct counts', () => {
  const g = genGcode({ ...DEFAULT_PA, kend: 0.02, kstep: 0.01, cycles: 3 });
  assert.equal(g.ks.length, 3);
  assert.equal((g.gcode.match(/SET_PRESSURE_ADVANCE/g) || []).length, 3);
  assert.equal((g.gcode.match(/^G1 Y/gm) || []).length, 3 * (1 + 2 * 3));
  assert.ok(g.gcode.includes('G91'));
  const fast = g.gcode.split('\n').find((l) => l.startsWith('G1 Y') && / E2 /.test(l));
  assert.ok(fast, 'fast leg extrudes 19.24*0.25/2.405 = 2.0 mm');
});

test('generator: line mode validates length and alternates nothing in Z', () => {
  const g = genGcode({ ...DEFAULT_PA, mode: 'line', kend: 0.02, kstep: 0.01, cycles: 3 });
  assert.ok(g.gcode.includes('G1 X'));
  assert.throws(() => genGcode({ ...DEFAULT_PA, mode: 'line', cycles: 30 }), /mm/);
});

test('parameter validation', () => {
  assert.throws(() => checkParams({ ...DEFAULT_PA, kend: -1 }));
  assert.throws(() => checkParams({ ...DEFAULT_PA, tgap: 0.2 }));
});

for (const tau of [0.03, 0.05]) {
  test(`analysis recovers K_opt = tau = ${tau}`, () => {
    const { t, v, ks } = simulate(tau, P);
    const r = analyzePa(t, v, { ...P, ks });
    assert.ok(r.ok, r.message);
    assert.equal(r.nBlocks, ks.length);
    assert.ok(Math.abs(r.kComposite - tau) < 0.012, `composite ${r.kComposite}`);
    assert.ok(Math.abs(r.kSigned - tau) < 0.01, `signed ${r.kSigned}`);
    assert.ok(r.rows[0].S < 0 && r.rows[r.rows.length - 1].S > 0, 'S goes from negative (under) to positive (over)');
    assert.ok(r.rows[r.rows.length - 1].overshoot > r.rows[0].overshoot);
  });
}

test('analysis auto-detects inverted polarity', () => {
  const { t, v, ks } = simulate(0.04, P, { invert: true });
  const r = analyzePa(t, v, { ...P, ks });
  assert.ok(r.ok, r.message);
  assert.equal(r.polarity, -1);
  assert.ok(Math.abs(r.kSigned - 0.04) < 0.01);
});

test('analysis reports a clear failure on flat/noise data', () => {
  const n = 20000, t = Float64Array.from({ length: n }, (_, i) => i / FS), v = new Float64Array(n).fill(-670000);
  const r = analyzePa(t, v, { ...P, ks: kValues(P) });
  assert.equal(r.ok, false);
});
