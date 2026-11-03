// Klipper sources: the ALPS flashed as a Klipper MCU (see https://github.com/G0BL1N/autopa/blob/main/docs/ALPS.md).
// Both classes have the same surface as SerialSource/SimulatedSource: connect(), disconnect(reason).
//
//  * KlipperBridgeSource - full rate (about 488 SPS). Reads the NDJSON stream served by bridge/alps_klipper_bridge.py,
//    which runs on the Klipper host. Moonraker itself cannot forward Klipper's bulk "load_cell/dump_force" stream.
//  * KlipperPollSource   - Moonraker only, no extra software. Polls the load_cell status object a few times a second.
//    Klipper only reports force once the load cell is calibrated and tared, and the value is a short rolling mean.

const trimUrl = (u) => u.replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Default bridge address: the Moonraker host on port 7126.
export function defaultBridgeUrl(moonrakerUrl) {
  try { const u = new URL(moonrakerUrl); return `${u.protocol}//${u.hostname}:7126`; } catch { return ''; }
}

// Converts a Klipper status object into raw counts (mean/min/max over Klipper's ~0.5 s buffer), or null when
// Klipper has no force reading yet. counts = tare + force_g * counts_per_gram (sensor_orientation: normal).
export function statusToCounts(st) {
  if (!st || st.force_g == null || st.tare_counts == null || !st.counts_per_gram) return null;
  const c = (g) => Math.round(st.tare_counts + g * st.counts_per_gram);
  return { mean: c(st.force_g), min: c(st.min_force_g ?? st.force_g), max: c(st.max_force_g ?? st.force_g) };
}

export class KlipperPollSource {
  constructor(rec, { url, cell = 'load_cell_probe', apiKey = '', interval = 200, fetchFn = (...a) => fetch(...a) } = {}) {
    Object.assign(this, { rec, base: trimUrl(url), cell, apiKey, interval, fetch: fetchFn, running: false, warned: false });
  }

  async _query() {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 3000);
    try {
      const headers = this.apiKey ? { 'X-Api-Key': this.apiKey } : {};
      const r = await this.fetch(`${this.base}/printer/objects/query?${encodeURIComponent(this.cell)}`, { headers, signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const st = (await r.json()).result.status;
      if (!(this.cell in st)) throw new Error(`Klipper has no "${this.cell}" object`);
      return st[this.cell];
    } finally { clearTimeout(to); }
  }

  async connect() {
    const st = await this._query(); // throws when Moonraker is unreachable or the object name is wrong
    this.running = true;
    this.rec.sendCommand = async () => { throw new Error('threshold commands are not available over Klipper'); };
    this.rec.onDevice(true, null, 'Klipper (Moonraker poll)');
    this.rec.log(`Klipper "${this.cell}": ${st.sample_rate ? st.sample_rate.toFixed(0) + ' SPS, ' : ''}${statusToCounts(st) ? 'force readings available' : 'no force reading yet'}`);
    this._loop();
  }

  async _loop() {
    let fails = 0;
    while (this.running) {
      try {
        const c = statusToCounts(await this._query());
        fails = 0;
        if (c) { this.warned = false; this.rec.onSample(c.mean, c.mean); }
        else if (!this.warned) {
          this.warned = true;
          this.rec.log('Klipper reports no force yet: the load cell must be calibrated (LOAD_CELL_CALIBRATE) and tared. Use the bridge for raw counts without calibration.');
        }
      } catch (e) {
        if (++fails >= 5) { this.disconnect(e.message || 'Klipper unreachable'); return; }
      }
      await sleep(this.interval);
    }
  }

  async disconnect(reason = null) {
    if (!this.running) return;
    this.running = false;
    this.rec.sendCommand = async () => { throw new Error('no device connected'); };
    this.rec.onDevice(false, reason);
  }
}

export class KlipperBridgeSource {
  constructor(rec, { url, cell = 'load_cell_probe', fetchFn = (...a) => fetch(...a) } = {}) {
    Object.assign(this, { rec, base: trimUrl(url), cell, fetch: fetchFn, ctl: null, closing: false, offset: null, last: 0 });
  }

  async connect() {
    this.ctl = new AbortController();
    this.closing = false;
    const r = await this.fetch(`${this.base}/stream?cell=${encodeURIComponent(this.cell)}`, { signal: this.ctl.signal });
    if (!r.ok) throw new Error(`bridge answered HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    this.rec.sendCommand = async () => { throw new Error('threshold commands are not available over Klipper'); };
    this.rec.onDevice(true, null, 'Klipper (bridge, full rate)');
    this._read(r.body.getReader());
  }

  async _read(reader) {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const ln of lines) this.handleLine(ln);
      }
      this.disconnect('bridge closed the stream');
    } catch (e) {
      if (!this.closing) this.disconnect(e.message || 'bridge stream failed');
    }
  }

  // {"now": bridge clock, "rows": [[epoch, counts, grams|null], ...]} per line; {"error": "..."} on a bridge problem.
  handleLine(line) {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.error) { this.rec.log('bridge: ' + m.error); return; }
    if (!Array.isArray(m.rows)) return;
    // The Klipper host clock may differ from this PC's: map sample times onto the PC clock using the batch clock.
    const off = Date.now() / 1000 - m.now;
    this.offset = this.offset == null ? off : this.offset + 0.05 * (off - this.offset);
    for (const [t, c] of m.rows) {
      const ts = Math.max(t + this.offset, this.last + 1e-6);
      this.last = ts;
      this.rec.onSample(c, c, ts);
    }
  }

  async disconnect(reason = null) {
    if (this.closing) return;
    this.closing = true;
    try { this.ctl && this.ctl.abort(); } catch { /* ignore */ }
    this.rec.sendCommand = async () => { throw new Error('no device connected'); };
    this.rec.onDevice(false, reason);
  }
}
