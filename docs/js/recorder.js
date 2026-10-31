// Recording logic: live feed, session lifecycle (manual or following Moonraker print state), batching to a db.
// db interface: startSession(name, source)->id, endSession(id), addSamples(id, rows),
//               listSessions(), getSession(id), deleteSession(id), getSamples(id)->rows
// Row format: [t_epoch_seconds, raw|null, filt|null, z|null, x|null, y|null]

const ACTIVE = new Set(['printing']);
const END = new Set(['complete', 'cancelled', 'error', 'standby']);

export class Recorder {
  constructor(db, { flushInterval = 1, now = () => Date.now() / 1000 } = {}) {
    this.db = db;
    this.flushInterval = flushInterval;
    this.now = now;
    this.session = null;
    this.printState = 'unknown';
    this.filename = null;
    this.z = null;
    this.x = null;
    this.y = null;
    this.moonrakerOk = null; // null = not configured
    this.connected = false;
    this.deviceError = null;
    this.version = null;
    this.threshold = null;
    this.messages = [];
    this.sendCommand = async () => { throw new Error('no device connected'); };
    this.onsample = () => {};
    this.onchange = () => {};
    this._recent = [];
    this._lastFlush = 0;
  }

  _changed() { this.onchange(); }

  log(text) {
    this.messages.push(text);
    if (this.messages.length > 200) this.messages.shift();
    this._changed();
  }

  // ---- device callbacks
  onSample(raw, filt) {
    const t = this.now();
    const row = [t, raw, filt, this.z, this.x, this.y];
    this._recent.push(t);
    if (this._recent.length > 500) this._recent.shift();
    if (this.session) {
      this.session.pending.push(row);
      if (t - this._lastFlush >= this.flushInterval) this._flush(this.session);
    }
    this.onsample(row);
  }

  onDevice(connected, error = null, version) {
    this.connected = connected;
    this.deviceError = error;
    if (version !== undefined) this.version = version;
    if (!connected) this._recent = [];
    this._changed();
  }

  onThreshold(value) { this.threshold = value; this._changed(); }

  rateHz() {
    const t = this.now();
    const r = this._recent.filter((x) => t - x <= 2);
    return r.length > 2 && r[r.length - 1] > r[0] ? (r.length - 1) / (r[r.length - 1] - r[0]) : 0;
  }

  // ---- moonraker callback
  onPrintUpdate(state, filename, z, ok, x = null, y = null) {
    this.moonrakerOk = ok;
    if (!ok) { this._changed(); return; }
    this.z = z;
    this.x = x;
    this.y = y;
    this.filename = filename || null;
    this.printState = state || 'unknown';
    if (ACTIVE.has(this.printState) && !this.session) {
      this._start(this.filename || 'print', 'moonraker', true);
    } else if (END.has(this.printState) && this.session && this.session.auto) {
      this.stopSession();
    }
    this._changed();
  }

  // ---- sessions
  startSession(name) {
    if (this.session) throw new Error('a session is already recording');
    this._start(name || `manual ${new Date().toLocaleString()}`, 'manual', false);
  }

  _start(name, source, auto) {
    const s = { id: null, name, auto, pending: [], chain: Promise.resolve() };
    s.ready = Promise.resolve(this.db.startSession(name, source, source === 'moonraker' && this.filename ? { file: this.filename } : {})).then((id) => { s.id = id; });
    s.ready.catch((e) => this.log('db error: ' + e.message));
    this.session = s;
    this._lastFlush = this.now();
    this._changed();
  }

  _flush(s) {
    this._lastFlush = this.now();
    const rows = s.pending;
    if (!rows.length) return s.chain;
    s.pending = [];
    s.chain = s.chain
      .then(() => s.ready)
      .then(() => this.db.addSamples(s.id, rows))
      .catch((e) => this.log('db error: ' + e.message));
    return s.chain;
  }

  async stopSession() {
    const s = this.session;
    if (!s) throw new Error('no session is recording');
    this.session = null;
    this._flush(s);
    s.chain = s.chain.then(() => s.ready).then(() => this.db.endSession(s.id)).catch((e) => this.log('db error: ' + e.message));
    this._changed();
    await s.chain;
  }

  // Resolves once everything queued for the current session has reached the db.
  async settle() {
    if (this.session) await this._flush(this.session);
  }

  status() {
    return {
      connected: this.connected,
      deviceError: this.deviceError,
      version: this.version,
      threshold: this.threshold,
      rateHz: Math.round(this.rateHz() * 10) / 10,
      recording: !!this.session,
      sessionName: this.session ? this.session.name : null,
      sessionAuto: this.session ? this.session.auto : false,
      printState: this.printState,
      filename: this.filename,
      z: this.z,
      moonrakerOk: this.moonrakerOk,
    };
  }
}
