import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, newlineRequired } from '../docs/js/parser.js';
import { Recorder } from '../docs/js/recorder.js';
import { MemoryDb } from '../docs/js/db.js';
import { downsample, toCsv } from '../docs/js/data.js';
import { MoonrakerPoller, mixedContentProblem } from '../docs/js/moonraker.js';

test('parser', () => {
  assert.deepEqual(parseLine('a=123,b=-4'), { kind: 'sample', value: [123, -4] });
  assert.deepEqual(parseLine('a=5'), { kind: 'sample', value: [5, null] });
  assert.deepEqual(parseLine('b=6'), { kind: 'sample', value: [null, 6] });
  assert.deepEqual(parseLine('version:2.0.1'), { kind: 'version', value: '2.0.1' });
  assert.deepEqual(parseLine('SAMPLE_THRESHOLD=8000'), { kind: 'threshold', value: 8000 });
  assert.deepEqual(parseLine(' hi '), { kind: 'text', value: 'hi' });
  assert.equal(newlineRequired('1.0'), false);
  assert.equal(newlineRequired('1.0.0'), false);
  assert.equal(newlineRequired('1.0.5'), true);
});

test('print lifecycle makes exactly one session and stores samples', async () => {
  const db = new MemoryDb(); const rec = new Recorder(db);
  rec.onPrintUpdate('standby', null, 0, true);
  assert.equal(rec.session, null);
  rec.onPrintUpdate('printing', 'benchy.gcode', 0.2, true);
  for (let i = 0; i < 5; i++) rec.onSample(100 + i, 90 + i);
  rec.onPrintUpdate('printing', 'benchy.gcode', 0.4, true);
  rec.onPrintUpdate('paused', 'benchy.gcode', 0.4, true);
  assert.ok(rec.session);
  rec.onPrintUpdate('complete', 'benchy.gcode', 10, true);
  assert.equal(rec.session, null);
  await rec.settle();
  await new Promise((r) => setTimeout(r, 20));
  const [s] = await db.listSessions();
  assert.equal((await db.listSessions()).length, 1);
  assert.equal(s.n, 5); assert.notEqual(s.ended, null); assert.equal(s.name, 'benchy.gcode');
  assert.equal((await db.getSamples(s.id)).length, 5);
});

test('manual session ignores print end; moonraker outage keeps auto session', async () => {
  const db = new MemoryDb(); const rec = new Recorder(db);
  rec.startSession('manual');
  rec.onPrintUpdate('complete', null, 0, true);
  assert.ok(rec.session);
  await rec.stopSession();
  rec.onPrintUpdate('printing', 'a.gcode', 1, true);
  const s = rec.session;
  rec.onPrintUpdate(null, null, null, false);
  assert.equal(rec.session, s);
  assert.throws(() => { rec.startSession('x'); });
  await rec.stopSession();
  await assert.rejects(rec.stopSession());
});

test('samples arriving before the db returns an id are not lost', async () => {
  const db = new MemoryDb(); const rec = new Recorder(db, { flushInterval: 0 });
  rec.startSession('x');
  for (let i = 0; i < 50; i++) rec.onSample(i, i);
  await rec.stopSession();
  const [s] = await db.listSessions();
  assert.equal((await db.getSamples(s.id)).length, 50);
});

test('Z from moonraker is stamped on samples', () => {
  const rec = new Recorder(new MemoryDb()); const got = [];
  rec.onsample = (r) => got.push(r);
  rec.onPrintUpdate('printing', 'a', 3.5, true);
  rec.onSample(1, 2);
  assert.equal(got[0][3], 3.5);
});

test('downsample keeps spikes and caps points; csv shape', () => {
  const rows = Array.from({ length: 5000 }, (_, i) => [1000 + i * 0.01, i === 777 ? 9999 : 10, 10, null]);
  const pts = downsample(rows, 500);
  assert.ok(pts.length <= 500);
  assert.equal(Math.max(...pts.map((p) => p[3])), 9999);
  assert.equal(downsample(rows, 1e6)[0][1], 10);
  assert.deepEqual(downsample([], 10), []);
  const csv = toCsv({ started: 1000 }, rows.slice(0, 2)).split('\n');
  assert.equal(csv[0], 't_s,epoch,raw,filtered,z,x,y');
  assert.equal(csv[1], '0.0000,1000.0000,10,10,,,');
  const cal = { tare: 10, countsPerGram: 2, unit: 'g', invert: false };
  const c2 = toCsv({ started: 1000 }, [[1000, 30, 30, null, null, null]], cal).split('\n');
  assert.equal(c2[0], 't_s,epoch,raw,filtered,z,x,y,force_raw_g,force_filtered_g');
  assert.equal(c2[1], '0.0000,1000.0000,30,30,,,,10.00000,10.00000');
});

test('moonraker poller parses state and reports outages', async () => {
  const updates = [];
  const ok = async () => ({ ok: true, json: async () => ({ result: { status: { print_stats: { state: 'printing', filename: 'f.gcode' }, toolhead: { position: [1, 2, 3.25, 0] } } } }) });
  await new MoonrakerPoller('http://h:7125/', (...a) => updates.push(a), { fetchFn: ok }).pollOnce();
  assert.deepEqual(updates[0], ['printing', 'f.gcode', 3.25, true, 1, 2, { filePosition: null, fileSize: null }]);
  await new MoonrakerPoller('http://h:7125', (...a) => updates.push(a), { fetchFn: async () => { throw new Error('x'); } }).pollOnce();
  assert.deepEqual(updates[1], [null, null, null, false]);
  await new MoonrakerPoller('http://h:7125', (...a) => updates.push(a), { fetchFn: async () => ({ ok: false, status: 403 }) }).pollOnce();
  assert.equal(updates[2][3], false);
});

test('Moonraker captures file bytes alongside live XYZ and preserves G-code BOM', async () => {
  const updates = [], urls = [];
  const bytes = new TextEncoder().encode('\uFEFF; comment\r\nG1 X20\r\n');
  const poller = new MoonrakerPoller('http://h:7125', (...a) => updates.push(a), { fetchFn: async (url) => {
    urls.push(url);
    return {
      ok: true, arrayBuffer: async () => bytes.buffer,
      json: async () => ({ result: { status: {
        print_stats: { state: 'printing', filename: 'folder/a b.gcode' },
        toolhead: { position: [10, 20, 30, 0] }, motion_report: { live_position: [1, 2, 3, 0] },
        virtual_sdcard: { file_position: 17, file_size: 100 },
      } } }),
    };
  } });
  await poller.pollOnce();
  assert.match(urls[0], /&virtual_sdcard/);
  assert.deepEqual(updates[0], ['printing', 'folder/a b.gcode', 3, true, 1, 2, { filePosition: 17, fileSize: 100 }]);
  assert.equal(await poller.fetchGcode('folder/a b.gcode'), '\uFEFF; comment\r\nG1 X20\r\n');
  assert.match(urls[1], /folder\/a%20b\.gcode$/);
});

test('reported positions and file progress survive summary-only capture and outages', async () => {
  const db = new MemoryDb(); let now = 100;
  const rec = new Recorder(db, { now: () => now, flushInterval: 0 });
  rec.setCapture({ mode: 'envelope' });
  rec.onPrintUpdate('printing', 'part.gcode', 3, true, 1, 2, { filePosition: 10, fileSize: 50 });
  const recording = rec.session;
  rec.onSample(100, 90);
  now++;
  rec.onPrintUpdate(null, null, null, false);
  now++;
  rec.onPrintUpdate('paused', 'part.gcode', 3, true, 1, 2, { filePosition: 20, fileSize: 50 });
  now++;
  rec.onPrintUpdate('complete', 'part.gcode', 3, true, 1, 2, { filePosition: 50, fileSize: 50 });
  await recording.chain;
  const [s] = await db.listSessions();
  assert.equal(s.file, 'part.gcode');
  assert.equal(s.n, 0);
  assert.equal(s.n_env, 1);
  assert.equal(s.n_pos, 4);
  assert.deepEqual(await db.getSamples(s.id, 'pos'), [
    [100, 1, 2, 3, 10, 50, 'part.gcode', 'printing'],
    [101, null, null, null, null, null, null, null],
    [102, 1, 2, 3, 20, 50, 'part.gcode', 'paused'],
    [103, 1, 2, 3, 50, 50, 'part.gcode', 'complete'],
  ]);
});

test('mixed content detection', () => {
  assert.equal(mixedContentProblem('https:', 'http://192.168.1.5:7125'), true);
  assert.equal(mixedContentProblem('https:', 'http://localhost:7125'), false);
  assert.equal(mixedContentProblem('https:', 'https://printer.local'), false);
  assert.equal(mixedContentProblem('http:', 'http://192.168.1.5:7125'), false);
  assert.equal(mixedContentProblem('https:', 'garbage'), false);
});
