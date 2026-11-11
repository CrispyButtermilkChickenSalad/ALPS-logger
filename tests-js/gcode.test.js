import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGcode, posAt, motionAt, positionAtFile } from '../docs/js/gcode.js';
import { TimeMap, autoSync, endpointSync, aggregate, projectCurve, curveValueAt, extractPoses, reportedPoses, fileProgressSync, loadColumns, percentile } from '../docs/js/sync.js';
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

test('virtual positions follow complete UTF-8 byte-indexed commands and coordinate modes', () => {
  const lines = ['\uFEFF; caf\u00e9', 'G90', 'G1 X10 Y20 Z1', 'G91', 'G1 X5 Y-2 Z0.2', 'G92 X0', 'G1 X2', 'G28 X', '; tail'];
  const text = lines.join('\r\n'), g = parseGcode(text);
  const end = (i) => new TextEncoder().encode(lines.slice(0, i + 1).join('\r\n') + '\r\n').length;
  assert.equal(g.fileSize, new TextEncoder().encode(text).length);
  assert.deepEqual(positionAtFile(g, end(2) - 1).xyz, [0, 0, 0]);
  assert.deepEqual(positionAtFile(g, end(2)).xyz, [10, 20, 1]);
  assert.deepEqual(positionAtFile(g, end(4)).xyz.slice(0, 2), [15, 18]);
  assert.ok(Math.abs(positionAtFile(g, end(4)).xyz[2] - 1.2) < 1e-6);
  assert.equal(positionAtFile(g, end(5)).xyz[0], 0);
  assert.equal(positionAtFile(g, end(6)).xyz[0], 2);
  assert.deepEqual(positionAtFile(g, g.fileSize).xyz.slice(0, 2), [0, 18], 'axis-specific homing preserves Y');
  assert.equal(positionAtFile(g, -1), null);
  assert.equal(positionAtFile(g, g.fileSize + 1), null);
});

test('a virtual arc endpoint includes the whole arc and dwell advances only time', () => {
  const prefix = 'G1 X10 Y0\nG3 X0 Y10 I-10 J0\n';
  const g = parseGcode(prefix + 'G4 P2000\n; end\n');
  const arc = positionAtFile(g, prefix.length);
  assert.deepEqual(arc.xyz, [0, 10, 0]);
  assert.equal(arc.index, g.n - 2);
  assert.deepEqual(positionAtFile(g, g.fileSize).xyz, arc.xyz);
  assert.ok(Math.abs(positionAtFile(g, g.fileSize).time - arc.time - 2) < 1e-6);
});

test('file progress aligns virtual XYZ despite constant reported coordinates and retains holds', () => {
  const lines = ['G1 X10 F600\n', 'G1 X20\n', 'G1 X30\n'];
  const g = parseGcode(lines.join('')), session = { started: 100, file: 'folder/part.gcode' };
  const row = (t, bytes) => [t, 0, 0, 0, bytes, g.fileSize, session.file, 'printing'];
  const rows = [row(100, 0), row(101, lines[0].length), row(110, lines[0].length),
    row(111, lines[0].length + lines[1].length), row(112, g.fileSize)];
  assert.equal(reportedPoses(rows, session).n, 1);
  const { map, poses } = fileProgressSync(g, rows, session, 'part.gcode');
  assert.deepEqual(Array.from(poses.x), [0, 10, 10, 20, 30]);
  assert.equal(map.toGcode(5), g.t0[1], 'hold does not advance virtual path');
  assert.equal(map.toSession(g.t0[1]), 10, 'move after hold starts at resume');
  assert.equal(map.toSession(g.totalTime), 12);
  assert.equal(map.toGcode(11), g.t0[2]);
});

test('virtual alignment rejects missing progress, wrong files, size changes and rewinds', () => {
  const g = parseGcode('G1 X10\nG1 X20\n'), session = { started: 100, file: 'part.gcode' };
  const row = (t, bytes) => [t, 0, 0, 0, bytes, g.fileSize, session.file, 'printing'];
  const rows = [row(100, 0), row(101, g.fileSize)];
  assert.throws(() => fileProgressSync(g, [], session, 'part.gcode'), /No recorded file progress/);
  assert.throws(() => fileProgressSync(g, rows, session, 'different.gcode'), /original G-code/);
  assert.throws(() => fileProgressSync(parseGcode('G1 X100\n'), rows, session, 'part.gcode'), /byte size/);
  assert.throws(() => fileProgressSync(g, [row(100, g.fileSize), row(101, 0)], session, 'part.gcode'), /backwards/);
  assert.throws(() => fileProgressSync(g, [row(100, 0), row(101, 0)], session, 'part.gcode'), /Insufficient/);
  assert.throws(() => fileProgressSync(g, [row(100, 0), row(101, g.fileSize + 1)], session, 'part.gcode'), /outside/);
});

test('partial virtual recordings leave unobserved segments unavailable', () => {
  const first = 'G1 X10 F600\n', second = 'G1 X20\n', g = parseGcode(first + second + 'G1 X30\n');
  const session = { started: 100, file: 'part.gcode' };
  const rows = [
    [100, 0, 0, 0, first.length, g.fileSize, session.file, 'printing'],
    [101, 0, 0, 0, first.length + second.length, g.fileSize, session.file, 'printing'],
  ];
  const { map } = fileProgressSync(g, rows, session, 'part.gcode');
  const cols = { n: 31, t: Array.from({ length: 31 }, (_, i) => -1 + i / 10), filt: new Float32Array(31).fill(42) };
  const a = aggregate(g, map, cols);
  assert.ok(Number.isNaN(a.mean[0]));
  assert.equal(a.mean[1], 42);
  assert.ok(Number.isNaN(a.mean[2]));
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

test('endpoint fit uses recording boundaries and rejects invalid durations', () => {
  const g = parseGcode('G1 X100 F6000');
  const map = endpointSync(g, { started: 100, ended: 400 });
  assert.equal(map.toSession(0), 0);
  assert.ok(Math.abs(map.toSession(g.totalTime) - 300) < 1e-9);
  assert.ok(Math.abs(map.toGcode(150) - g.totalTime / 2) < 1e-9);
  for (const session of [{ started: 100, ended: null }, { started: 100, ended: 100 }, { started: NaN, ended: 200 }]) assert.equal(endpointSync(g, session), null);
  assert.equal(endpointSync({ totalTime: 0 }, { started: 1, ended: 2 }), null);
});

test('motion cursor reports commanded direction, not orientation', () => {
  const g = parseGcode('G1 X10 F600\nG4 P1000\nG1 Y-10');
  const moving = motionAt(g, g.t0[0] + g.dur[0] / 2);
  assert.deepEqual(moving.direction, [1, 0, 0]);
  assert.equal(moving.xyz[0], 5);
  assert.equal(motionAt(g, g.t0[1] + 0.5).direction, null);
  assert.equal(motionAt(parseGcode(''), 0), null);
});

test('commanded A words are tracked per segment without claiming measured tilt', () => {
  const g = parseGcode('G1 X10 F600\nG1 A5 F6000\nG1 X20 A5 F600\nG92 A0\nG1 X30');
  assert.equal(motionAt(g, 0).a, 0);
  const mid = motionAt(g, g.t0[2] + g.dur[2] / 2);
  assert.equal(mid.a, 5);
  assert.equal(g.a1[1], 5);
  assert.ok(g.dur[1] > 0, 'A-only move adds estimated time');
  assert.equal(motionAt(g, g.totalTime).a, 0);
});

test('summary aggregation uses bucket intervals and leaves gaps uncoloured', async () => {
  const db = new MemoryDb();
  const session = { started: 100, ended: 104, capture: { mode: 'events', bucketS: 1 } };
  const id = await db.importSession(session, [[100, 1, 1, 0, 0, 0]], { env: [
    [100, 8, 10, 12, 0, 9, 0, 0, 0, 5],
    [101, 18, 20, 22, 0, 19, 0, 0, 0, 5],
    [103, 28, 30, 32, 0, 29, 0, 0, 0, 5],
  ] });
  const cols = await loadColumns(db, id, session);
  assert.equal(cols.fromEnv, true);
  const g = { n: 4, flags: [1, 1, 1, 1], t0: [0.25, 0.5, 2, 1.5], dur: [0.25, 1, 0.5, 1] };
  const a = aggregate(g, TimeMap.linear(0, 1, 4), cols, 'raw');
  assert.equal(a.mean[0], 10);
  assert.equal(a.mean[1], 15);
  assert.equal(a.min[1], 8);
  assert.equal(a.max[1], 22);
  assert.ok(Number.isNaN(a.mean[2]));
  // Segment times normally increase; test a partial interval independently.
  const partial = { n: 1, flags: [1], t0: [1.5], dur: [1] };
  assert.ok(Number.isNaN(aggregate(partial, TimeMap.linear(0, 1, 4), cols, 'raw').mean[0]));
});

test('incomplete raw capture falls back to available summary even with full metadata', async () => {
  const db = new MemoryDb(), session = { started: 100, ended: 110, capture: { mode: 'full', bucketS: 1 } };
  const id = await db.importSession(session, [[100, 1, 1, 0, 0, 0]], { env: [[109, 1, 2, 3, 0, 2, 0, 0, 0, 1]] });
  assert.equal((await loadColumns(db, id, session)).fromEnv, true);
  assert.equal((await loadColumns(db, id, session, { preferRaw: true })).fromEnv, undefined);
});

test('raw aggregation does not extrapolate beyond capture or bridge large gaps', () => {
  const cols = { n: 2, t: [0, 10], raw: [1, 2], filt: [1, 2] };
  for (const t of [-0.4, 0.1, 9.5, 10.1]) {
    const g = { n: 1, flags: [1], t0: [t], dur: [0.1] };
    assert.ok(Number.isNaN(aggregate(g, TimeMap.linear(0, 1, 20), cols).mean[0]));
  }
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
  for (let k = 0; k < 2001; k++) { const t = 1000 + 10 + (k / 2000) * g.totalTime; rows.push([t, 0, k < 1000 ? 100 : 500, 0, null, null]); }
  await db.addSamples(id, rows);
  const cols = await loadColumns(db, id, { started: 1000, n: rows.length });
  const a = aggregate(g, map, cols, 'filt');
  assert.ok(a.mean[0] < 200 && a.mean[1] > 400, `${a.mean[0]} ${a.mean[1]}`);
  assert.ok(Number.isNaN(aggregate(g, TimeMap.linear(5000, 1, g.totalTime), cols).mean[0]));
});

test('full curve preserves individual peaks and variation within one move', () => {
  const g = { n: 1, flags: [1], t0: [0], dur: [10], totalTime: 10 };
  const t = Array.from({ length: 101 }, (_, i) => i / 10);
  const filt = t.map((_, i) => i === 50 ? 1000 : i < 50 ? 10 : 30);
  const cols = { n: t.length, t, filt, raw: filt.map((v) => v * 2) }, map = TimeMap.linear(0, 1, 10);
  const curve = projectCurve(g, map, cols);
  assert.equal(curve.samples, 101);
  assert.equal(curve.n, 101);
  assert.deepEqual(Array.from(curve.offsets), [0, 101]);
  assert.equal(curve.f0[0], 0);
  assert.equal(curve.f1[curve.n - 1], 1);
  assert.equal(curveValueAt(curve, 0, 0.25), 10);
  assert.equal(curveValueAt(curve, 0, 0.5), 1000);
  assert.equal(curveValueAt(curve, 0, 0.75), 30);
  assert.ok(aggregate(g, map, cols).max[0] > aggregate(g, map, cols).mean[0]);
  assert.equal(curveValueAt(projectCurve(g, map, cols, 'raw'), 0, 0.5), 2000);
});

test('full curve keeps raw event windows without bridging missing intervals or using summaries', async () => {
  const db = new MemoryDb(), session = { started: 100, ended: 104, capture: { mode: 'events', bucketS: 1 } };
  const id = await db.importSession(session, [0, 0.01, 0.02, 3, 3.01, 3.02].map((t) => [100 + t, 10, 20, 0, 0, 0]), {
    env: [[100, 1, 1000, 2000, 0, 1000, 0, 0, 0, 100]],
  });
  const cols = await loadColumns(db, id, session, { preferRaw: true });
  assert.equal(cols.fromEnv, undefined);
  const g = { n: 1, flags: [1], t0: [0], dur: [4], totalTime: 4 }, map = TimeMap.linear(0, 1, 4);
  const curve = projectCurve(g, map, cols);
  assert.equal(curveValueAt(curve, 0, 0.01 / 4), 20);
  assert.ok(Number.isNaN(curveValueAt(curve, 0, 1.5 / 4)));
  assert.equal(curveValueAt(curve, 0, 3.01 / 4), 20);
  assert.ok(Number.isNaN(curveValueAt(curve, 0, 3.5 / 4)));
  assert.throws(() => projectCurve(g, map, { ...cols, fromEnv: true }), /not summary buckets/);
  const gaps = projectCurve(g, map, { n: 9, t: [0, 0.01, 0.02, 0.059, 0.069, 0.079, 0.12, 0.13, 0.14], filt: new Float32Array(9).fill(10) });
  assert.equal(curveValueAt(gaps, 0, 0.04 / 4), 10, 'a gap below four typical intervals is supported');
  assert.ok(Number.isNaN(curveValueAt(gaps, 0, 0.1 / 4)), 'a gap above four typical intervals stays grey');
  const slow = projectCurve(g, map, { n: 4, t: [0, 0.8, 1.9, 2.7], filt: [1, 2, 3, 4] });
  assert.ok(Number.isNaN(curveValueAt(slow, 0, 1.3 / 4)), 'even slow capture does not bridge gaps above one second');
});

test('full curve follows non-linear alignment, splits moves, and leaves dwells and holds unmapped', () => {
  const g = { n: 3, flags: [1, 4, 1], t0: [0, 1, 2], dur: [1, 1, 1], totalTime: 3 };
  const map = new TimeMap([0, 1, 1, 2, 3], [0, 2, 4, 6, 8]);
  const t = Array.from({ length: 81 }, (_, i) => i / 10);
  const cols = { n: t.length, t, filt: t.map((v) => v > 2 && v < 4 ? 999 : v) };
  const curve = projectCurve(g, map, cols);
  assert.equal(curve.offsets[1], curve.offsets[2], 'dwell has no path colour');
  assert.equal(curveValueAt(curve, 0, 0.5), 1);
  assert.equal(curveValueAt(curve, 2, 0.5), 7);
  assert.ok(!curve.values.includes(999), 'samples during a progress hold cannot advance along the path');
  const adjacent = { n: 2, flags: [1, 1], t0: [0, 1], dur: [1, 1], totalTime: 2 };
  const crossing = projectCurve(adjacent, TimeMap.linear(0, 1, 2), { n: 4, t: [0, 0.8, 1.6, 2], filt: [1, 10, 20, 30] });
  assert.equal(curveValueAt(crossing, 0, 0.9), 10);
  assert.equal(curveValueAt(crossing, 1, 0.1), 10, 'one sample interval is split across the corner');
});

test('full curve clips virtual coverage and handles coincident or missing sample timestamps explicitly', () => {
  const g = { n: 1, flags: [1], t0: [0], dur: [10], totalTime: 10 };
  const cols = { n: 6, t: [0, 2, 2, 4, 6, 10], filt: [1, 2, NaN, 4, 6, 10] };
  const map = new TimeMap([0, 10], [0, 10], { coverage: [2, 8] });
  const dense = { n: 101, t: Array.from({ length: 101 }, (_, i) => i / 10), filt: new Float32Array(101).fill(10) };
  const curve = projectCurve(g, map, dense);
  assert.ok(Number.isNaN(curveValueAt(curve, 0, 0.1)));
  assert.equal(curveValueAt(curve, 0, 0.5), 10);
  assert.ok(Number.isNaN(curveValueAt(curve, 0, 0.9)));
  assert.doesNotThrow(() => projectCurve(g, map, cols));
  assert.throws(() => projectCurve(g, map, { ...cols, t: [0, 2, 1, 4, 6, 10] }), /recording order/);
  assert.throws(() => projectCurve(g, map, { ...cols, t: [0, NaN, 2, 4, 6, 10] }), /finite/);
});

test('full curve does not cap saved samples at the interactive drawing limit', () => {
  const n = 100005, g = { n: 1, flags: [1], t0: [0], dur: [1], totalTime: 1 };
  const t = Float64Array.from({ length: n }, (_, i) => i / (n - 1)), filt = new Float32Array(n).fill(5);
  filt[n - 2] = 1000;
  const curve = projectCurve(g, TimeMap.linear(0, 1, 1), { n, t, filt });
  assert.equal(curve.samples, n);
  assert.equal(curve.n, n);
  assert.equal(curve.values[n - 2], 1000);
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
