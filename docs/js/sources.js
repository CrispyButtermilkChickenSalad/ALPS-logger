// Sample sources: the real ALPS via Web Serial, and a simulator (demo without hardware).
import { parseLine, newlineRequired } from './parser.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const serialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

export class SerialSource {
  constructor(rec) {
    this.rec = rec;
    this.port = null;
    this.writer = null;
    this.reader = null;
    this.newline = true;
    this.accept = false;
    this.closing = false;
    this._onDisconnect = (e) => { if (e.target === this.port) this._lost('device unplugged'); };
  }

  async connect() {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    this.port = port;
    this.closing = false;
    this.writer = port.writable.getWriter();
    navigator.serial.addEventListener('disconnect', this._onDisconnect);
    this.rec.sendCommand = (cmd) => this.send(cmd);
    this._readLoop(port.readable.getReader());

    // same handshake as Mellow's web tool: stop stream, detect firmware version, read threshold, start stream
    await this._write('uv\n');
    await sleep(300);
    let version = null;
    const wait = new Promise((res) => { this._versionWaiter = (v) => { version = v; res(); }; });
    await this._write('version\n');
    await Promise.race([wait, sleep(1000)]);
    this._versionWaiter = null;
    version = version || '1.0';
    this.newline = newlineRequired(version);
    this.rec.onDevice(true, null, version);
    await this.send('rt');
    this.accept = true;
    await this.send('v');
  }

  async _write(text) {
    await this.writer.write(new TextEncoder().encode(text));
  }

  async send(cmd) {
    if (!this.writer) throw new Error('device not connected');
    await this._write(cmd + (this.newline ? '\n' : ''));
    this.rec.log('> ' + cmd);
  }

  async _readLoop(reader) {
    this.reader = reader;
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const ln of lines) this._handle(ln);
      }
    } catch (e) {
      if (!this.closing) this._lost(e.message || 'read failed');
    }
  }

  _handle(line) {
    const { kind, value } = parseLine(line);
    if (kind === 'sample') { if (this.accept) this.rec.onSample(value[0], value[1]); }
    else if (kind === 'version') { if (this._versionWaiter) this._versionWaiter(value); }
    else if (kind === 'threshold') { this.rec.onThreshold(value); this.rec.log(line.trim()); }
    else if (value) this.rec.log(value);
  }

  _lost(reason) {
    if (this.closing) return;
    this.disconnect(reason);
  }

  async disconnect(reason = null) {
    if (this.closing) return;
    this.closing = true;
    this.accept = false;
    navigator.serial.removeEventListener('disconnect', this._onDisconnect);
    try { if (this.writer && reason == null) await this._write('uv' + (this.newline ? '\n' : '')); } catch { /* ignore */ }
    try { if (this.reader) await this.reader.cancel(); } catch { /* ignore */ }
    try { if (this.writer) this.writer.releaseLock(); } catch { /* ignore */ }
    try { if (this.port) await this.port.close(); } catch { /* ignore */ }
    this.port = this.writer = this.reader = null;
    this.rec.sendCommand = async () => { throw new Error('no device connected'); };
    this.rec.onDevice(false, reason);
  }
}

export class SimulatedSource {
  constructor(rec, rateHz = 100) {
    this.rec = rec;
    this.rate = rateHz;
    this.threshold = 8000;
    this.timer = null;
  }

  async connect() {
    this.rec.sendCommand = async (cmd) => {
      const [c, arg] = cmd.split(/\s+/);
      if (c === 'set' && arg !== undefined) this.threshold = parseInt(arg, 10);
      if (c === 'rt' || c === 'set') { this.rec.onThreshold(this.threshold); this.rec.log('SAMPLE_THRESHOLD=' + this.threshold); }
      this.rec.log('> ' + cmd);
    };
    this.rec.onDevice(true, null, 'sim-2.0.0');
    this.rec.onThreshold(this.threshold);
    let filt = 0;
    const t0 = performance.now();
    let produced = 0;
    this.timer = setInterval(() => {
      const target = Math.floor(((performance.now() - t0) / 1000) * this.rate);
      while (produced < target) {
        const t = produced / this.rate;
        const raw = Math.round(12000 * Math.pow(Math.max(0, Math.sin(t * 0.8)), 6) + (Math.random() - 0.5) * 500);
        filt += 0.2 * (raw - filt);
        this.rec.onSample(raw, Math.round(filt));
        produced++;
      }
    }, 20);
  }

  async disconnect() {
    clearInterval(this.timer);
    this.timer = null;
    this.rec.sendCommand = async () => { throw new Error('no device connected'); };
    this.rec.onDevice(false, null);
  }
}
