import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGcode, posAt } from '../docs/js/gcode.js';
import { TimeMap, autoSync, aggregate, extractPoses, loadColumns, percentile } from '../docs/js/sync.js';
import { fitCalibration, toUnits, estimateCountsPerGram, isCalibrated, DEFAULT_CALIB, VOLTS_PER_COUNT_G1 } from '../docs/js/calib.js';
import { MemoryDb } from '../docs/js/db.js';

function zigzagGcode(layers = 10) {
  const out = ['G90', 'M83', 'G28', 'G1 Z0.2 F600', 'G1 X20 Y20 F6000'];
  for (let L = 0; L < layers; L++) {
    out.push(`G1 Z${(0.2 * (L + 1)).toFixed(2)} F600`);
    const sweep = L % 2 === 0;
    for (let i = 0; i <= 40; i++) {
      const a = 20 + i, fwd = i % 2 === 0;
      const p = (u) => (sweep ? `X${a} Y${u}` : `X${u} Y${a}`);
      out.push(`G1 ${p(fwd ? 20 : 60)} F600`.replace('F600', 'F6000'));
      out.push(`G1 ${p(fwd ? 60 : 20)} E1.2 F3600`);
    }
  }
  return out.join('\n');
}

test('parses moves, extrusion flags, layers and bounds', () => {
  const g = parseGcode('G90\nM83\nG1 X10 Y0 F6000 ; travel\nG1 X10 Y10 E0.5\nG1 Z0.4\nG1 X0 Y10 E0.5\n');
  assert.equal(g.n, 4);
  assert.deepEqual(Array.from(g.flags), [0, 1, 0, 1]);
  assert.equal(g.layerStart.length, 2);
  assert.equal(g.bounds.maxX, 10);
  assert.ok(g.totalTime > 0.2 && g.totalTime < 3, 'timeline ' + g.totalTime);
});

test('relative positioning, absolute extruder and G92', () => {
  const g = parseGcode('G91\nM82\nG92 E0\nG1 X5 E1\nG1 X5 E2\nG1 X5 E2\n');
  assert.deepEqual(Array.from(g.flags), [1, 1, 0]);
  assert.equal(g.x1[2], 15);
});

test('arcs are linearised and end exactly at the target', () => {
  const g = parseGcode('G90\nM83\nG1 X10 Y0\nG3 X0 Y10 I-10 J0 E1\n');
  assert.ok(g.n > 20);
  assert.ok(Math.abs(g.x1[g.n - 1]) < 1e-6 && Math.abs(g.y1[g.n - 1] - 10) < 1e-6);
});

test('dwell and retract add time without geometry', () => {
  const g = parseGcode('G90\nM83\nG1 X10 F6000\nG4 P500\nG1 E-1 F2400\n');
  assert.equal(g.flags[1], 4);
  assert.ok(Math.abs(g.dur[1] - 0.5) < 1e-6);
  assert.equal(g.flags[2], 4);
});

test('planner: speed ~ feedrate on a long straight, slower with sharp corners', () => {
  const straight = parseGcode('G1 X100 F6000\n');
  assert.ok(Math.abs(straight.totalTime - (1 + 100 / 100 * 0 + 100 / 100)) < 0.2 + 100 / 100, 'straight ' + straight.totalTime);
  const zig = parseGcode('G1 X10 F6000\nG1 X10 Y0.01 F6000\nG1 X0 Y0.01 F6000\n');
  assert.ok(zig.totalTime > 0.2);
});

test('posAt interpolates along the toolpath', () => {
  const g = parseGcode('G1 X100 F6000\n');
  const out = [0, 0, 0];
  posAt(g, g.totalTime / 2, out);
  assert.ok(out[0] > 30 && out[0] < 70);
  posAt(g, g.totalTime + 5, out);
  assert.equal(out[0], 100);
});

test('TimeMap is piecewise linear and invertible', () => {
  const m = new TimeMap([0, 10, 20], [5, 25, 30]);
  assert.equal(m.toSession(5), 15);
  assert.equal(m.toSession(15), 27.5);
  assert.ok(Math.abs(m.toGcode(m.toSession(13.3)) - 13.3) < 1e-9);
  assert.equal(m.toSession(30), 40);
});

test('autoSync recovers a time offset, scale drift and ignores pre-print macro moves', () => {
  const g = parseGcode(zigzagGcode(12));
  const poses = { t: [], x: [], y: [], z: [] };
  const out = [0, 0, 0];
  const OFF = 95, SC = 1.07;
  const f = (tg) => OFF + SC * tg + 1.5 * Math.sin(tg / 40);
  let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let t = 0; t < OFF; t += 0.25) { poses.t.push(t); poses.x.push(100 + 80 * Math.sin(t)); poses.y.push(100 + 80 * Math.cos(t * 1.3)); poses.z.push(10 + 20 * Math.sin(t / 5)); }
  for (let tg = 0; tg < g.totalTime; tg += 0.25 / SC) {
    posAt(g, tg, out);
    poses.t.push(f(tg)); poses.x.push(out[0] + rnd() * 2); poses.y.push(out[1] + rnd() * 2); poses.z.push(out[2]);
  }
  const P = { n: poses.t.length, t: Float64Array.from(poses.t), x: Float64Array.from(poses.x), y: Float64Array.from(poses.y), z: Float64Array.from(poses.z) };
  const r = autoSync(g, P);
  assert.ok(r, 'sync should succeed');
  for (const frac of [0.1, 0.3, 0.5, 0.8, 0.95]) {
    const tg = g.totalTime * frac;
    assert.ok(Math.abs(r.map.toSession(tg) - f(tg)) < 2, `error at ${frac}: ${r.map.toSession(tg) - f(tg)}`);
  }
});

test('autoSync gives up on unrelated data', () => {
  const g = parseGcode(zigzagGcode(4));
  const n = 400;
  const P = { n, t: new Float64Array(n).map((_, i) => i * 0.25), x: new Float64Array(n).fill(300), y: new Float64Array(n).fill(300), z: new Float64Array(n).fill(50) };
  assert.equal(autoSync(g, P), null);
});

test('aggregate assigns samples to segments through the time map', async () => {
  const g = parseGcode('G90\nM83\nG1 X100 F6000 E1\nG1 X100 Y100 E1\n');
  const map = TimeMap.linear(10, 1, g.totalTime);
  const db = new MemoryDb();
  const id = await db.startSession('t', 'manual');
  const rows = [];
  for (let k = 0; k < 2000; k++) { const t = 1000 + 10 + (k / 2000) * g.totalTime; rows.push([t, 0, k < 1000 ? 100 : 500, 0, null, null]); }
  await db.addSamples(id, rows);
  const cols = await loadColumns(db, id, { started: 1000, n: rows.length });
  const a = aggregate(g, map, cols, 'filt');
  assert.ok(a.mean[0] < 200 && a.mean[1] > 400, `${a.mean[0]} ${a.mean[1]}`);
  assert.ok(Number.isNaN(aggregate(g, TimeMap.linear(5000, 1, g.totalTime), cols).mean[0]));
});

test('extractPoses keeps only changed positions', () => {
  const cols = { n: 4, t: Float64Array.from([0, 1, 2, 3]), x: Float32Array.from([1, 1, 2, NaN]), y: Float32Array.from([1, 1, 1, 1]), z: Float32Array.from([0, 0, 0, 0]) };
  assert.equal(extractPoses(cols).n, 2);
});

test('percentile', () => assert.equal(percentile([5, 1, 3, NaN], 50), 3));

test('calibration fit, units and defaults', () => {
  assert.equal(isCalibrated(DEFAULT_CALIB), false);
  assert.equal(toUnits(-670000, DEFAULT_CALIB, -674000), 4000);
  const pts = [0, 500, 1000, 2000].map((grams) => ({ grams, counts: -674000 + 73.5 * grams }));
  const fit = fitCalibration(pts);
  assert.ok(Math.abs(fit.countsPerGram - 73.5) < 1e-6 && Math.abs(fit.tare + 674000) < 1e-6 && fit.r2 > 0.999999);
  const c = { ...DEFAULT_CALIB, tare: fit.tare, countsPerGram: fit.countsPerGram };
  assert.ok(Math.abs(toUnits(-674000 + 735, c) - 10) < 1e-6);
  assert.ok(Math.abs(toUnits(-674000 + 735, { ...c, unit: 'N' }) - 0.0980665) < 1e-6);
  assert.ok(Math.abs(toUnits(-674000 + 735, { ...c, invert: true }) + 10) < 1e-6);
  assert.equal(fitCalibration([{ grams: 0, counts: 1 }]), null);
});

test('estimateCountsPerGram uses the ADS131M02 LSB size', () => {
  const e = estimateCountsPerGram({ capacityKg: 1, sensitivityMvV: 1, excitationV: 3.3, gain: 128 });
  assert.ok(Math.abs(e.nanovoltsPerCount - (VOLTS_PER_COUNT_G1 * 1e9) / 128) < 1e-9);
  assert.ok(e.countsPerGram > 2900 && e.countsPerGram < 3000);
});
