import test from 'node:test';
import assert from 'node:assert/strict';
import { Recorder } from '../docs/js/recorder.js';
import { MemoryDb } from '../docs/js/db.js';
import { KlipperBridgeSource, KlipperPollSource, statusToCounts, defaultBridgeUrl } from '../docs/js/klipper.js';

test('statusToCounts needs a calibrated and tared load cell', () => {
  assert.equal(statusToCounts({ is_calibrated: false, counts_per_gram: 138, tare_counts: null }), null);
  assert.equal(statusToCounts(null), null);
  const c = statusToCounts({ force_g: 10, min_force_g: 8, max_force_g: 12, counts_per_gram: 100, tare_counts: 5000 });
  assert.deepEqual(c, { mean: 6000, min: 5800, max: 6200 });
});

test('defaultBridgeUrl uses the Moonraker host on 7126', () => {
  assert.equal(defaultBridgeUrl('http://192.168.68.109'), 'http://192.168.68.109:7126');
  assert.equal(defaultBridgeUrl('http://printer.local:7125/'), 'http://printer.local:7126');
  assert.equal(defaultBridgeUrl('nonsense'), '');
});

test('bridge lines become timestamped samples on the PC clock, in order', () => {
  const rec = new Recorder(new MemoryDb());
  const got = []; rec.onsample = (r) => got.push(r);
  const src = new KlipperBridgeSource(rec, { url: 'http://x:7126' });
  const now = Date.now() / 1000;
  // Klipper host clock is 100 s ahead of this PC
  src.handleLine(JSON.stringify({ now: now + 100, rows: [[now + 99.9, 1000, null], [now + 99.902, 1010, null], [now + 99.902, 1020, null]] }));
  src.handleLine('');
  src.handleLine('not json');
  src.handleLine(JSON.stringify({ error: 'Klipper closed the API socket' }));
  assert.equal(got.length, 3);
  assert.ok(Math.abs(got[0][0] - (now - 0.1)) < 0.5);
  assert.ok(got[1][0] - got[0][0] > 0.0019 && got[1][0] - got[0][0] < 0.0021);
  assert.ok(got[2][0] > got[1][0]);
  assert.deepEqual(got.map((r) => r[1]), [1000, 1010, 1020]);
  assert.match(rec.messages.at(-1), /bridge: Klipper closed/);
});

test('bridge connect streams a response body and reports a closed stream', async () => {
  const rec = new Recorder(new MemoryDb());
  const body = new ReadableStream({
    start(c) {
      const e = new TextEncoder(), now = Date.now() / 1000;
      c.enqueue(e.encode(JSON.stringify({ now, rows: [[now, 5, 0.1]] }) + '\n{"now":'));
      c.enqueue(e.encode(`${now},"rows":[[${now + 0.01},6,0.2]]}\n`));
      c.close();
    },
  });
  const src = new KlipperBridgeSource(rec, { url: 'http://x:7126', fetchFn: async (u) => { assert.match(u, /\/stream\?cell=load_cell_probe$/); return { ok: true, body: body }; } });
  const rows = []; rec.onsample = (r) => rows.push(r[1]);
  await src.connect();
  assert.equal(rec.connected, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(rows, [5, 6]);
  assert.equal(rec.connected, false);
  assert.match(rec.deviceError, /closed/);
});

test('poll source records counts once Klipper reports force, and fails over after repeated errors', async () => {
  const rec = new Recorder(new MemoryDb());
  let mode = 'noforce', calls = 0;
  const fetchFn = async () => {
    calls++;
    if (mode === 'down') throw new Error('offline');
    const st = mode === 'noforce' ? { counts_per_gram: 138, tare_counts: null, sample_rate: 488.3 }
      : { force_g: 2, min_force_g: 1, max_force_g: 3, counts_per_gram: 100, tare_counts: 1000, sample_rate: 488.3 };
    return { ok: true, json: async () => ({ result: { status: { load_cell_probe: st } } }) };
  };
  const src = new KlipperPollSource(rec, { url: 'http://x', interval: 5, fetchFn });
  const rows = []; rec.onsample = (r) => rows.push(r[1]);
  await src.connect();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(rows.length, 0);
  assert.ok(rec.messages.some((m) => /calibrated/.test(m)));
  mode = 'force';
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(rows.length > 0 && rows.every((v) => v === 1200));
  mode = 'down';
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(rec.connected, false);
  assert.match(rec.deviceError, /offline/);
});
