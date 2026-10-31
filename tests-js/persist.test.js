import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '../docs/js/db.js';
import { MirrorDb, exportBackup, importBackup, requestPersistence, parseCsv, parseSessionId } from '../docs/js/persist.js';

function fakeDir() {
  const files = new Map();
  const handle = (name) => ({
    kind: 'file',
    async getFile() { const s = files.get(name); return { size: s.length, lastModified: 5000, text: async () => s }; },
    async createWritable() {
      let buf = files.get(name), pos = 0;
      return { async seek(p) { pos = p; }, async write(t) { buf = buf.slice(0, pos) + t; pos += t.length; }, async close() { files.set(name, buf); } };
    },
  });
  return {
    files, name: 'fake',
    async getFileHandle(name) { if (!files.has(name)) files.set(name, ''); return handle(name); },
    async *entries() { for (const n of files.keys()) yield [n, handle(n)]; },
  };
}

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

test('persistence request handles missing and granted storage', async () => {
  assert.equal((await requestPersistence(undefined)).supported, false);
  assert.deepEqual(await requestPersistence({ persist: async () => true, persisted: async () => false }), { supported: true, persisted: true });
});
