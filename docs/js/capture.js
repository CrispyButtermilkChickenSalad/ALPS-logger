// Long-print capture: turns the raw sample stream into
//   env   - fixed-width envelope buckets  [t, min, mean, max, std, filtMean, z, x, y, n]
//   layer - per-layer statistics          [t0, t1, z, layerNo, baseline, noiseStd, min, max, peakDev, events, n]
//   evt   - triggered events              [t0, t1, triggers, peakDev, peakT, baseline, z, x, y]
//   raw   - raw rows to keep (all of them, only event windows, or none, depending on mode)
// Pure logic: rows go in through push(), results leave through sink(kind, row).

export const DEFAULT_CAPTURE = {
  mode: 'events', // 'full' | 'events' | 'envelope'
  bucketS: 0.1,
  preS: 2,
  postS: 2,
  maxEventS: 30,
  warmupS: 3,
  layerStableS: 1.5,
  layerMinDz: 0.05,
  triggers: {
    band: { on: true, k: 6 },
    abs: { on: false, counts: 2000 },
    slope: { on: false, counts: 1000, windowMs: 50 },
    layer: { on: true },
  },
};

const num = (v, d, lo = -Infinity, hi = Infinity) => (Number.isFinite(+v) && v !== '' && v !== null ? Math.min(hi, Math.max(lo, +v)) : d);
const r2 = (v) => Math.round(v * 100) / 100;

export function normalizeCapture(c = {}) {
  const d = DEFAULT_CAPTURE, t = c.triggers || {}, td = d.triggers;
  return {
    mode: ['full', 'events', 'envelope'].includes(c.mode) ? c.mode : d.mode,
    bucketS: num(c.bucketS, d.bucketS, 0.01, 60),
    preS: num(c.preS, d.preS, 0, 30),
    postS: num(c.postS, d.postS, 0, 60),
    maxEventS: num(c.maxEventS, d.maxEventS, 1, 600),
    warmupS: num(c.warmupS, d.warmupS, 0, 60),
    layerStableS: num(c.layerStableS, d.layerStableS, 0, 60),
    layerMinDz: num(c.layerMinDz, d.layerMinDz, 0.001, 10),
    triggers: {
      band: { on: t.band?.on ?? td.band.on, k: num(t.band?.k, td.band.k, 1, 1000) },
      abs: { on: t.abs?.on ?? td.abs.on, counts: num(t.abs?.counts, td.abs.counts, 1) },
      slope: { on: t.slope?.on ?? td.slope.on, counts: num(t.slope?.counts, td.slope.counts, 1), windowMs: num(t.slope?.windowMs, td.slope.windowMs, 1, 5000) },
      layer: { on: t.layer?.on ?? td.layer.on },
    },
  };
}

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

export class Capture {
  constructor(cfg, sink) {
    this.cfg = normalizeCapture(cfg);
    this.sink = sink;
    this.base = null; this.absDev = 0; this.lastT = null; this.t0 = null;
    this.buf = []; this.bufHead = 0; // pre-roll rows
    this.sl = []; this.slHead = 0; // [t, value] for the slope trigger
    this.lastEmitT = -Infinity;
    this.ev = null;
    this.bucket = null;
    this.layer = null; this.layerNo = 0; this.cand = null;
    this.markPending = false; this.layerPending = false;
    this.total = 0; this.lastRow = null;
  }

  setConfig(cfg) { this.cfg = normalizeCapture(cfg); }
  mark() { this.markPending = true; }

  // ---- per-sample entry point --------------------------------------------------------------------
  push(row) {
    const [t, raw, filt, z, x, y] = row;
    this.total++;
    this.lastRow = row;
    this.buf.push(row);
    while (this.bufHead < this.buf.length && this.buf[this.bufHead][0] < t - this.cfg.preS) this.bufHead++;
    if (this.bufHead > 2000) { this.buf = this.buf.slice(this.bufHead); this.bufHead = 0; }
    if (this.t0 === null) this.t0 = t;
    this._layers(t, z);

    if (raw != null) {
      this._bucket(t, raw, filt, z, x, y);
      const dev = this._baseline(t, raw);
      this._events(t, raw, filt, dev, z, x, y);
    }
    if (this.cfg.mode === 'full') { this.lastEmitT = t; this.sink('raw', row); } else if (this.cfg.mode === 'events' && this.ev) this._emitRaw(row);
    this.lastT = t;
  }

  // ---- baseline / noise tracking (frozen while an event is open so events don't absorb it) -----------
  _baseline(t, raw) {
    if (this.base === null) { this.base = raw; return 0; }
    const dev = raw - this.base;
    if (!this.ev) {
      const dt = Math.max(0, t - (this.lastT ?? t));
      // time constants ramp up from the start so the first seconds average instead of under-estimating the noise
      const age = Math.max(0.5, t - this.t0);
      this.base += (1 - Math.exp(-dt / Math.min(10, age))) * dev;
      this.absDev += (1 - Math.exp(-dt / Math.min(30, age))) * (Math.abs(dev) - this.absDev);
    }
    return dev;
  }

  _events(t, raw, filt, dev, z, x, y) {
    const c = this.cfg, tr = c.triggers, hit = [];
    const v = filt ?? raw;
    this.sl.push([t, v]);
    const win = tr.slope.windowMs / 1000;
    while (this.sl.length - this.slHead > 1 && this.sl[this.slHead + 1][0] <= t - win) this.slHead++;
    if (this.slHead > 500) { this.sl = this.sl.slice(this.slHead); this.slHead = 0; }

    if (t - this.t0 >= c.warmupS) {
      if (tr.band.on && Math.abs(dev) > tr.band.k * Math.max(1.25 * this.absDev, 1)) hit.push('band');
      if (tr.abs.on && Math.abs(dev) > tr.abs.counts) hit.push('abs');
      if (tr.slope.on && Math.abs(v - this.sl[this.slHead][1]) > tr.slope.counts) hit.push('slope');
      if (tr.layer.on && this.layerPending) hit.push('layer');
    }
    this.layerPending = false;
    if (this.markPending) { hit.push('marker'); this.markPending = false; }

    if (hit.length && !this.ev) {
      this.ev = { t0: t, until: t + c.postS, trig: new Set(hit), peak: dev, peakT: t, base: this.base, z, x, y, lastT: t };
      if (c.mode === 'events') for (let i = this.bufHead; i < this.buf.length; i++) this._emitRaw(this.buf[i]);
    } else if (this.ev) {
      for (const h of hit) this.ev.trig.add(h);
      if (hit.length) this.ev.until = Math.max(this.ev.until, t + c.postS);
    }
    const e = this.ev;
    if (!e) return;
    e.lastT = t;
    if (Math.abs(dev) > Math.abs(e.peak)) { e.peak = dev; e.peakT = t; }
    const tooLong = t - e.t0 >= c.maxEventS;
    if (t > e.until || tooLong) {
      this._closeEvent();
      if (tooLong) this.base = raw; // a sustained shift is a new baseline, not one endless event
    }
  }

  _closeEvent() {
    const e = this.ev; if (!e) return;
    this.ev = null;
    this.sink('evt', [r2(e.t0), r2(e.lastT), [...e.trig].join('+'), r2(e.peak), r2(e.peakT), r2(e.base), e.z ?? null, e.x ?? null, e.y ?? null]);
    if (this.layer) this.layer.events++;
  }

  _emitRaw(row) { if (row[0] > this.lastEmitT) { this.lastEmitT = row[0]; this.sink('raw', row); } }

  // ---- envelope -----------------------------------------------------------------------------------
  _bucket(t, raw, filt, z, x, y) {
    const w = this.cfg.bucketS, k = Math.floor(t / w);
    let b = this.bucket;
    if (b && b.k !== k) { this._emitBucket(); b = null; }
    if (!b) b = this.bucket = { k, t: k * w, n: 0, min: raw, max: raw, mean: 0, m2: 0, fs: 0, fn: 0, z, x, y };
    b.n++;
    const d = raw - b.mean; b.mean += d / b.n; b.m2 += d * (raw - b.mean);
    if (raw < b.min) b.min = raw; if (raw > b.max) b.max = raw;
    if (filt != null) { b.fs += filt; b.fn++; }
    if (z != null) b.z = z; if (x != null) b.x = x; if (y != null) b.y = y;
  }

  _emitBucket() {
    const b = this.bucket; if (!b) return;
    this.bucket = null;
    const std = b.n > 1 ? Math.sqrt(b.m2 / (b.n - 1)) : 0;
    this.sink('env', [r2(b.t), b.min, r2(b.mean), b.max, r2(std), b.fn ? r2(b.fs / b.fn) : null, b.z ?? null, b.x ?? null, b.y ?? null, b.n]);
    const L = this.layer;
    if (L) { L.means.push(b.mean); L.stdSum += std; L.min = Math.min(L.min, b.min); L.max = Math.max(L.max, b.max); L.n += b.n; L.tEnd = b.t + this.cfg.bucketS; }
  }

  // ---- layers (need Z from Moonraker) -----------------------------------------------------------------
  _layers(t, z) {
    if (z == null) return;
    const c = this.cfg;
    if (!this.layer) { this._openLayer(t, z); return; }
    if (Math.abs(z - this.layer.z) < c.layerMinDz) { this.cand = null; return; }
    if (!this.cand || Math.abs(z - this.cand.z) > 0.01) { this.cand = { z, t }; return; }
    if (t - this.cand.t >= c.layerStableS) {
      const at = this.cand.t; this.cand = null;
      this._closeLayer(at); this._openLayer(at, z); this.layerPending = true;
    }
  }

  _openLayer(t, z) {
    this.layerNo++;
    this.layer = { z, t0: t, tEnd: t, no: this.layerNo, means: [], stdSum: 0, min: Infinity, max: -Infinity, n: 0, events: 0 };
  }

  _closeLayer(t1) {
    const L = this.layer; this.layer = null;
    if (!L || !L.means.length) return;
    const base = median(L.means), up = L.max - base, down = base - L.min;
    this.sink('layer', [r2(L.t0), r2(Math.max(t1 ?? L.tEnd, L.t0)), L.z, L.no, r2(base), r2(L.stdSum / L.means.length), L.min, L.max, r2(up >= down ? up : -down), L.events, L.n]);
  }

  // ---- end of session -------------------------------------------------------------------------------
  close() {
    this._emitBucket();
    this._closeEvent();
    this._closeLayer(this.lastRow ? this.lastRow[0] : undefined);
  }
}
