import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Capture, normalizeCapture } from '../docs/js/capture.js';
import { Recorder } from '../docs/js/recorder.js';
import { MemoryDb } from '../docs/js/db.js';
import { MirrorDb, exportBackup, importBackup } from '../docs/js/persist.js';
import { kindToCsv, exportTare } from '../docs/js/data.js';

// Deterministic noise so tests are stable.
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };

function run(cfg, gen, seconds = 30, hz = 200) {
  const out = { raw: [], env: [], layer: [], evt: [] };
  const cap = new Capture(cfg, (k, r) => out[k].push(r));
  for (let i = 0; i < seconds * hz; i++) {
    const t = 1000 + i / hz;
    const s = gen(t - 1000);
    cap.push([t, Math.round(s.raw), Math.round(s.raw), s.z ?? null, null, null]);
    if (s.mark) cap.mark();
  }
  cap.close();
  return { out, cap };
}
const quiet = (t) => ({ raw: -670000 + rnd() * 100 });
const withSpike = (at, h = 3000) => (t) => ({ raw: -670000 + rnd() * 100 + (t >= at && t < at + 0.2 ? h : 0) });

test('normalizeCapture fills defaults and clamps', () => {
  const c = normalizeCapture({ mode: 'bogus', bucketS: -5, triggers: { band: { k: 'x' } } });
  assert.equal(c.mode, 'events'); assert.equal(c.bucketS, 0.01); assert.equal(c.triggers.band.k, 6); assert.equal(c.triggers.slope.on, false);
});

test('quiet signal: envelope only, no events, no raw in events mode', () => {
  const { out } = run({ mode: 'events' }, quiet);
  assert.equal(out.evt.length, 0); assert.equal(out.raw.length, 0);
  assert.ok(out.env.length >= 290 && out.env.length <= 301, 'about 10 buckets per second for 30 s: ' + out.env.length);
  const e = out.env[50];
  assert.ok(e[1] <= e[2] && e[2] <= e[3] && e[4] > 0); assert.equal(e[9], 20);
});

test('a spike produces one event and a pre/post raw window only', () => {
  const { out } = run({ mode: 'events', preS: 1, postS: 1 }, withSpike(15));
  assert.equal(out.evt.length, 1);
  const [t0, t1, trig, peak] = out.evt[0];
  assert.match(trig, /band/); assert.ok(peak > 2500 && t0 >= 1014.9 && t0 <= 1015.1 && t1 > 1016);
  assert.ok(out.raw.length > 0 && out.raw.length < 0.15 * 30 * 200, 'only the window is kept: ' + out.raw.length);
  assert.ok(out.raw[0][0] >= 1013.9 && out.raw[out.raw.length - 1][0] <= 1017.3);
  for (let i = 1; i < out.raw.length; i++) assert.ok(out.raw[i][0] > out.raw[i - 1][0], 'no duplicate rows');
});

test('modes: full keeps all raw, envelope keeps none, events still recorded in both', () => {
  const full = run({ mode: 'full' }, withSpike(10), 15).out, env = run({ mode: 'envelope' }, withSpike(10), 15).out;
  assert.equal(full.raw.length, 15 * 200); assert.equal(env.raw.length, 0);
  assert.equal(full.evt.length, 1); assert.equal(env.evt.length, 1);
});

test('triggers can be toggled off individually', () => {
  const off = { band: { on: false }, abs: { on: false }, slope: { on: false }, layer: { on: false } };
  assert.equal(run({ triggers: off }, withSpike(10), 15).out.evt.length, 0);
  const abs = run({ triggers: { ...off, abs: { on: true, counts: 2000 } } }, withSpike(10), 15).out.evt;
  assert.equal(abs.length, 1); assert.equal(abs[0][2], 'abs');
  const small = run({ triggers: { ...off, abs: { on: true, counts: 5000 } } }, withSpike(10), 15).out.evt;
  assert.equal(small.length, 0, 'spike below the absolute threshold');
});

test('slope trigger fires on a fast change but not a slow ramp', () => {
  const off = { band: { on: false }, abs: { on: false }, slope: { on: true, counts: 1000, windowMs: 50 }, layer: { on: false } };
  const slow = run({ triggers: off }, (t) => ({ raw: -670000 + t * 40 + rnd() * 50 }), 20).out.evt;
  assert.equal(slow.length, 0);
  const fast = run({ triggers: off }, withSpike(10), 15).out.evt;
  assert.ok(fast.length >= 1 && /slope/.test(fast[0][2]));
});

test('events close at maxEventS and a sustained step re-baselines', () => {
  const step = (t) => ({ raw: -670000 + rnd() * 100 + (t >= 10 ? 5000 : 0) });
  const { out } = run({ mode: 'events', maxEventS: 3 }, step, 40);
  assert.ok(out.evt.length >= 1 && out.evt.length <= 2, 'step ends one capped event, not a continuous stream: ' + out.evt.length);
  assert.ok(out.evt[0][1] - out.evt[0][0] <= 3.1);
});

test('manual marker records a window even when everything else is off', () => {
  const off = { band: { on: false }, abs: { on: false }, slope: { on: false }, layer: { on: false } };
  const { out } = run({ mode: 'events', triggers: off }, (t) => ({ ...quiet(t), mark: Math.abs(t - 12) < 0.001 }), 20);
  assert.equal(out.evt.length, 1); assert.equal(out.evt[0][2], 'marker'); assert.ok(out.raw.length > 100);
});

test('layers split on a stable Z change, ignore a brief Z hop, and count events', () => {
  const z = (t) => (t < 10 ? 0.2 : t < 20 ? 0.4 : 0.6) + (t > 5 && t < 5.8 ? 0.4 : 0); // hop at 5 s
  const { out } = run({ mode: 'envelope', triggers: { layer: { on: false } } }, (t) => ({ ...withSpike(14)(t), z: z(t) }), 30);
  assert.equal(out.layer.length, 3, JSON.stringify(out.layer.map((l) => l[2])));
  assert.deepEqual(out.layer.map((l) => l[2]), [0.2, 0.4, 0.6]);
  const l2 = out.layer[1];
  assert.ok(Math.abs(l2[4] + 670000) < 100, 'baseline is the median'); assert.ok(l2[5] > 0); assert.equal(l2[9], 1, 'spike counted in layer 2'); assert.ok(l2[8] > 2500);
  assert.equal(out.layer[0][9], 0);
  assert.ok(Math.abs(out.layer[0][1] - 1010) < 0.2, 'boundary at the Z change');
});

test('layer change trigger captures raw around a layer change', () => {
  const off = { band: { on: false }, abs: { on: false }, slope: { on: false }, layer: { on: true } };
  const { out } = run({ mode: 'events', triggers: off }, (t) => ({ ...quiet(t), z: t < 10 ? 0.2 : 0.4 }), 20);
  assert.equal(out.evt.length, 1); assert.equal(out.evt[0][2], 'layer'); assert.ok(out.raw.length > 100);
});

test('recorder stores each kind and counts them on the session', async () => {
  const db = new MemoryDb(); let now = 1000;
  const rec = new Recorder(db, { now: () => now, flushInterval: 0 });
  rec.setCapture({ mode: 'events' });
  rec.startSession('long');
  for (let i = 0; i < 2000; i++) { now = 1000 + i / 100; rec.onSample(-670000 + (i === 1200 ? 4000 : Math.round(rnd() * 100)), -670000); }
  await rec.stopSession();
  const id = 1, s = await db.getSession(id);
  assert.equal(s.capture.mode, 'events');
  assert.ok((await db.getSamples(id, 'env')).length > 150); assert.equal((await db.getSamples(id, 'evt')).length, 1);
  assert.ok(s.n < 600 && s.n > 0, 'raw count reflects only kept rows: ' + s.n); assert.equal(s.n_evt, 1); assert.ok(s.n_env > 150);
});

test('backup round-trips envelope, layer and event rows', async () => {
  const db = new MemoryDb(); const id = await db.startSession('x', 'manual');
  await db.addSamples(id, [[1, 1, 1, null, null, null]]); await db.addSamples(id, [[1, 1, 2, 3, 0.5, 0, 0, 0, 0, 5]], 'env'); await db.addSamples(id, [[1, 2, 'band', 5, 1.5, 2, null, null, null]], 'evt');
  const text = await (await exportBackup(db)).text();
  const db2 = new MemoryDb(); await importBackup(db2, text);
  assert.equal((await db2.getSamples(1, 'env')).length, 1); assert.equal((await db2.getSamples(1, 'evt'))[0][2], 'band'); assert.equal((await db2.getSamples(1)).length, 1);
});

test('kind CSVs have names, calibrated columns, and use the envelope for tare', () => {
  const s = { started: 1000 };
  const env = [[1000.5, -670010, -670000, -669990, 5, -670000, 0.2, null, null, 20], [1001, -670500, -670400, -670300, 5, -670400, 0.2, null, null, 20]];
  const plain = kindToCsv('env', s, env).split('\n');
  assert.equal(plain[0], 't_s,epoch,raw_min,raw_mean,raw_max,raw_std,filtered_mean,z,x,y,n'); assert.equal(plain[1].split(',')[0], '0.5000');
  const cal = { tare: null, countsPerGram: 100, unit: 'g', invert: false };
  assert.equal(exportTare(s, [], cal, env), -670000);
  const c = kindToCsv('env', s, env, cal, env).split('\n');
  assert.ok(c[0].endsWith('raw_min_g,raw_mean_g,raw_max_g,filtered_mean_g,raw_std_g'));
  assert.equal(c[2].split(',').slice(-5)[1], '-4.00000');
  const ev = kindToCsv('evt', s, [[1010, 1012, 'band+slope', 3000, 1010.5, -670000, 0.2, null, null]], cal, env).split('\n');
  assert.ok(ev[0].endsWith('baseline_g,peak_dev_g')); assert.equal(ev[1].split(',').pop(), '30.00000');
  assert.equal(ev[1].split(',')[2], '2.000');
});

function fakeDir() {
  const files = new Map();
  const handle = (name) => ({ kind: 'file', async getFile() { const s = files.get(name); return { size: s.length, lastModified: 5000, text: async () => s }; },
    async createWritable() { let buf = files.get(name), pos = 0; return { async seek(p) { pos = p; }, async write(t) { buf = buf.slice(0, pos) + t; pos += t.length; }, async close() { files.set(name, buf); } }; } });
  return { files, name: 'd', async getFileHandle(n) { if (!files.has(n)) files.set(n, ''); return handle(n); }, async *entries() { for (const n of files.keys()) yield [n, handle(n)]; } };
}

test('mirror writes sidecar CSVs and the folder list hides them', async () => {
  const dir = fakeDir(), m = new MirrorDb(new MemoryDb()); m.setFolder(dir);
  const id = await m.startSession('p', 'manual');
  await m.addSamples(id, [[1000, 1, 1, null, null, null]]);
  await m.addSamples(id, [[1000, 1, 2, 3, 0.5, 1, null, null, null, 5]], 'env');
  await m.addSamples(id, [[1000, 1001, 'marker', 0, 1000, 1, null, null, null]], 'evt');
  await m.endSession(id);
  const names = [...dir.files.keys()].sort();
  assert.deepEqual(names, ['alps_1_p.csv', 'alps_1_p.events.csv', 'alps_1_p.summary.csv']);
  assert.ok(dir.files.get('alps_1_p.events.csv').includes('marker'));
  assert.deepEqual((await m.listFolder()).map((f) => f.file), ['alps_1_p.csv']);
});

test('loadColumns uses the envelope for triggered sessions and raw when asked', async () => {
  const { loadColumns } = await import('../docs/js/sync.js');
  const db = new MemoryDb();
  const id = await db.startSession('x', 'test', { capture: { mode: 'events' } }); db.sessions.get(id).started = 1000;
  await db.addSamples(id, [[1001, 5, 5, null, null, null]], 'raw');
  await db.addSamples(id, [[1000.5, 1, 10, 20, 0.1, 5, 2, 3, 4, 10], [1001.5, 1, 12, 20, 0.1, 6, 2, 3, 4, 10]], 'env');
  const s = await db.getSession(id);
  const e = await loadColumns(db, id, s);
  assert.equal(e.fromEnv, true); assert.equal(e.n, 2); assert.equal(e.raw[0], 10); assert.equal(e.z[1], 2);
  const r = await loadColumns(db, id, s, { preferRaw: true });
  assert.equal(r.n, 1); assert.ok(!r.fromEnv);
});
