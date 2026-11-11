import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '../docs/js/db.js';
import { MirrorDb, exportBackup, importBackup, requestPersistence, parseCsv, parseSessionId, parsePositionCsv } from '../docs/js/persist.js';
import { kindToCsv, exportMeta } from '../docs/js/data.js';
import { DEFAULT_CALIB, loadCalib, saveCalib, snapshotCalibration, toUnits } from '../docs/js/calib.js';

function fakeDir() {
  const files = new Map(), modified = new Map();
  let clock = 5000;
  const handle = (name) => ({
    kind: 'file',
    async getFile() { const s = files.get(name); return { size: s.length, lastModified: modified.get(name) || 5000, text: async () => s }; },
    async createWritable() {
      let buf = files.get(name), pos = 0;
      return { async seek(p) { pos = p; }, async write(t) { buf = buf.slice(0, pos) + t; pos += t.length; }, async close() { files.set(name, buf); modified.set(name, ++clock); } };
    },
  });
  return {
    files, name: 'fake',
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) throw Object.assign(new Error('File not found'), { name: 'NotFoundError' });
        files.set(name, '');
      }
      return handle(name);
    },
    async *entries() { for (const n of files.keys()) yield [n, handle(n)]; },
  };
}

const calibration = () => ({ ...DEFAULT_CALIB, tare: -674000, countsPerGram: 73.5, unit: 'kg', invert: true,
  points: [{ grams: 0, counts: -674000 }, { grams: 500, counts: -637250 }] });
function fakeStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('recording snapshots are immutable and survive auto-save, folder import and backup', async () => {
  const active = calibration(), expected = snapshotCalibration(active), inner = new MemoryDb(), dir = fakeDir(), errors = [];
  const m = new MirrorDb(inner, { getCalibration: () => active, onError: (e) => errors.push(e) }); m.setFolder(dir);
  const id = await m.startSession('calibrated', 'manual');
  await m.chains.get(id);
  const metadataName = 'alps_1_calibrated.meta.json';
  assert.deepEqual(JSON.parse(dir.files.get(metadataName)).recording_calibration, expected, 'snapshot is written before recording ends');
  active.points[0].counts = 42; active.countsPerGram = 100;
  assert.deepEqual((await m.getSession(id)).calibration, expected);
  const t = (await m.getSession(id)).started;
  const rows = [[t, -600500, -637250, null, null, null]];
  await m.addSamples(id, rows); await m.endSession(id);
  assert.deepEqual(errors, []);
  const metadata = JSON.parse(dir.files.get(metadataName));
  assert.deepEqual(metadata.recording_calibration, expected);
  assert.equal(metadata.calibration, null, 'auto-save CSV stays in counts');
  assert.equal(metadata.session.samples, 1); assert.ok(metadata.session.ended_epoch);
  assert.deepEqual((await m.getSession('f:alps_1_calibrated.csv')).calibration, expected);
  assert.equal((await m.getSession('f:alps_1_calibrated.csv')).name, 'calibrated');
  const imported = await m.importFromFolder('f:alps_1_calibrated.csv');
  assert.deepEqual((await m.getSession(imported)).calibration, expected);
  assert.equal((await m.getSession(imported)).name, 'calibrated');
  const restored = new MemoryDb();
  await importBackup(restored, await (await exportBackup(inner)).text());
  assert.deepEqual((await restored.getSession(id)).calibration, expected);
  assert.deepEqual(await restored.getSamples(id), rows);
  assert.equal(toUnits(rows[0][1], (await restored.getSession(id)).calibration), -1);
  const exported = exportMeta(await m.getSession(id), rows, active);
  assert.deepEqual(exported.recording_calibration, expected);
  assert.equal(exported.calibration_settings.countsPerGram, 100, 'recording and later export calibrations remain distinguishable');
});

test('metadata-only changes invalidate folder cache, and corrupt metadata is reported', async () => {
  const dir = fakeDir(), m = new MirrorDb(new MemoryDb(), { getCalibration: calibration }); m.setFolder(dir);
  const id = await m.startSession('cache', 'manual'); await m.endSession(id);
  const folderId = 'f:alps_1_cache.csv', name = 'alps_1_cache.meta.json';
  assert.equal((await m.getSession(folderId)).calibration.unit, 'kg');
  const metadata = JSON.parse(dir.files.get(name)); metadata.recording_calibration.invert = false;
  const w = await (await dir.getFileHandle(name)).createWritable();
  await w.write(JSON.stringify(metadata, null, 2)); await w.close();
  assert.equal((await m.getSession(folderId)).calibration.invert, false);
  dir.files.set(name, 'invalid JSON');
  await assert.rejects(() => m.getSession(folderId), SyntaxError);
});

test('metadata failures are surfaced without losing recorded samples or their snapshot', async () => {
  const dir = fakeDir(), getFileHandle = dir.getFileHandle.bind(dir), errors = [];
  dir.getFileHandle = (name, options) => {
    if (name.endsWith('.meta.json')) throw new Error('metadata write denied');
    return getFileHandle(name, options);
  };
  const m = new MirrorDb(new MemoryDb(), { getCalibration: calibration, onError: (e) => errors.push(e.message) }); m.setFolder(dir);
  const id = await m.startSession('denied', 'manual');
  await m.addSamples(id, [[1000, 1, 2, null, null, null]]); await m.endSession(id);
  assert.ok(errors.includes('metadata write denied'));
  assert.equal((await m.getSamples(id)).length, 1);
  assert.deepEqual((await m.getSession(id)).calibration, calibration());
});

test('backup restores current settings separately from recording snapshots and supports legacy backups', async () => {
  const source = fakeStorage(), destination = fakeStorage(), db = new MirrorDb(new MemoryDb(), { getCalibration: calibration });
  const id = await db.startSession('snapshot', 'manual'); await db.endSession(id);
  const current = { ...DEFAULT_CALIB, points: [{ grams: 0, counts: 10 }], estimated: true };
  saveCalib(source, current);
  const text = await (await exportBackup(db, source)).text();
  const restored = new MemoryDb();
  await importBackup(restored, text, destination);
  assert.deepEqual(loadCalib(destination), current, 'even unapplied points and uncalibrated state are restored');
  assert.deepEqual((await restored.getSession(1)).calibration, calibration());
  const legacy = JSON.parse(text); legacy.version = 2; delete legacy.calibration_settings;
  delete legacy.sessions[0].session.calibration;
  saveCalib(destination, calibration());
  await importBackup(restored, JSON.stringify(legacy), destination);
  assert.deepEqual(loadCalib(destination), calibration(), 'legacy backup must not reset current settings');
  assert.equal((await restored.getSession(2)).calibration, undefined);
  const invalid = JSON.parse(text); invalid.calibration_settings.points = 'bad';
  await assert.rejects(() => importBackup(restored, JSON.stringify(invalid), destination), /Invalid calibration/);
  invalid.calibration_settings = current; invalid.sessions[0].session.calibration.unit = 'invalid';
  await assert.rejects(() => importBackup(restored, JSON.stringify(invalid), destination), /Invalid calibration/);
  assert.equal((await restored.listSessions()).length, 2, 'invalid calibration metadata is rejected before importing sessions');
});

test('folder CSVs are listed, parsed and importable through the db interface', async () => {
  const dir = fakeDir();
  dir.files.set('a.csv', 't_s,epoch,raw,filtered,z,x,y,force_raw_g\n0.0000,1000.0000,5,6,,,,0.1\n1.0000,1001.0000,7,8,0.2,10,20,0.2\n');
  dir.files.set('notes.txt', 'x');
  const m = new MirrorDb(new MemoryDb()); m.setFolder(dir);
  const list = await m.listFolder();
  assert.deepEqual(list.map((f) => f.id), ['f:a.csv']);
  const s = await m.getSession('f:a.csv');
  assert.equal(s.started, 1000); assert.equal(s.n, 2);
  assert.deepEqual((await m.getSamples('f:a.csv'))[1], [1001, 7, 8, 0.2, 10, 20]);
  const got = []; await m.scanSamples('f:a.csv', (r) => got.push(...r)); assert.equal(got.length, 2);
  const nid = await m.importFromFolder('f:a.csv');
  assert.equal((await m.getSession(nid)).n, 2); assert.equal((await m.getSamples(nid)).length, 2);
  assert.throws(() => parseCsv('a,b\n1,2', 'bad.csv'), /Not an ALPS CSV/);
  assert.equal(parseSessionId('f:a.csv'), 'f:a.csv'); assert.equal(parseSessionId('7'), 7);
});

test('mirror appends a CSV file live and matches inner storage', async () => {
  const inner = new MemoryDb(), dir = fakeDir(), errs = [];
  const m = new MirrorDb(inner, { onError: (e) => errs.push(e) });
  m.setFolder(dir);
  const id = await m.startSession('run 1', 'manual');
  const t0 = (await m.getSession(id)).started;
  await m.addSamples(id, [[t0 + 1, 100, 100, null, null, null]]);
  await m.addSamples(id, [[t0 + 2, 200, 190, 0.2, 1, 2]]);
  await m.endSession(id);
  assert.deepEqual(errs, []);
  const [name, text] = [...dir.files][0];
  assert.match(name, /^alps_1_run_1\.csv$/);
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 't_s,epoch,raw,filtered,z,x,y');
  assert.match(lines[2], /^2\.0000,.*,200,190,0.2,1,2$/);
  assert.equal((await m.getSamples(id)).length, 2);
});

test('importing auto-saved job names preserves repeat numbering', async () => {
  const dir = fakeDir(), original = new MirrorDb(new MemoryDb()); original.setFolder(dir);
  for (let i = 0; i < 2; i++) {
    const id = await original.startSession('part.gcode', 'moonraker', { autoName: true });
    await original.endSession(id);
  }
  const restored = new MirrorDb(new MemoryDb()); restored.setFolder(dir);
  for (const file of await restored.listFolder()) await restored.importFromFolder(file.id);
  const id = await restored.startSession('part.gcode', 'moonraker', { autoName: true });
  assert.equal((await restored.getSession(id)).name, 'part.gcode (3)');
  await restored.endSession(id);
});

test('mirror without folder only stores, and write errors do not break recording', async () => {
  const m = new MirrorDb(new MemoryDb(), { onError: () => {} });
  const id = await m.startSession('a', 'manual');
  await m.addSamples(id, [[1, 1, 1, null, null, null]]);
  await m.endSession(id);
  const bad = new MirrorDb(new MemoryDb(), { onError: () => {} });
  bad.setFolder({ getFileHandle: async () => { throw new Error('denied'); } });
  const id2 = await bad.startSession('b', 'manual');
  await bad.addSamples(id2, [[1, 1, 1, null, null, null]]);
  await bad.endSession(id2);
  assert.equal((await bad.getSamples(id2)).length, 1);
});

test('backup round trip restores sessions as new ones', async () => {
  const a = new MemoryDb();
  const id = await a.startSession('x', 'manual');
  await a.addSamples(id, [[10, 1, 1, null, null, null], [11, 2, 2, null, null, null]]);
  await a.endSession(id);
  const text = await (await exportBackup(a)).text();
  const b = new MemoryDb();
  assert.equal(await importBackup(b, text), 1);
  const [s] = await b.listSessions();
  assert.equal(s.name, 'x'); assert.equal(s.n, 2);
  assert.equal((await b.getSamples(s.id)).length, 2);
  await assert.rejects(() => importBackup(b, '{"a":1}'), /backup/);
  await assert.rejects(() => importBackup(b, 'nope'), /valid/);
});

test('position traces round-trip through CSV, folder import and backups without changing reported data', async () => {
  const inner = new MemoryDb(), dir = fakeDir(), errors = [];
  const m = new MirrorDb(inner, { onError: (e) => errors.push(e) }); m.setFolder(dir);
  const file = 'folder/part,"quoted".gcode';
  const id = await m.startSession('virtual', 'moonraker', { file });
  const t = (await m.getSession(id)).started;
  const positions = [[t, 0, 0, 0, 0, 100, file, 'printing'], [t + 1, 0, 0, 0, 100, 100, file, 'complete']];
  await m.addSamples(id, [[t, 12, 13, 0, 0, 0]]);
  await m.addSamples(id, positions, 'pos');
  await m.endSession(id);
  assert.deepEqual(errors, []);
  const csv = dir.files.get('alps_1_virtual.positions.csv');
  assert.match(csv, /"folder\/part,""quoted""\.gcode"/);
  const rounded = positions.map((r) => [Number(r[0].toFixed(4)), ...r.slice(1)]);
  assert.deepEqual(parsePositionCsv(csv), rounded);
  assert.deepEqual((await m.listFolder()).map((f) => f.file), ['alps_1_virtual.csv']);
  const folderId = 'f:alps_1_virtual.csv';
  assert.equal((await m.getSession(folderId)).file, file);
  assert.deepEqual(await m.getSamples(folderId, 'pos'), rounded);
  const imported = await m.importFromFolder(folderId);
  assert.deepEqual(await inner.getSamples(imported, 'pos'), rounded);
  const restored = new MemoryDb();
  await importBackup(restored, await (await exportBackup(inner)).text());
  assert.deepEqual(await restored.getSamples(id, 'pos'), positions);
  assert.deepEqual(await restored.getSamples(id), [[t, 12, 13, 0, 0, 0]]);
  assert.deepEqual(parsePositionCsv(kindToCsv('pos', { started: 1 }, [[1, null, null, null, null, null, null, null]])), [[1, null, null, null, null, null, null, null]]);
  assert.throws(() => parsePositionCsv('epoch,reported_x\n1,2'), /position trace/);
});

test('persistence request handles missing and granted storage', async () => {
  assert.equal((await requestPersistence(undefined)).supported, false);
  assert.deepEqual(await requestPersistence({ persist: async () => true, persisted: async () => false }), { supported: true, persisted: true });
});
