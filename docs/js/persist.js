// Durability helpers: persistent-storage request, auto-save mirror to a user-chosen folder, backup/restore.
import { toCsv, kindToCsv, exportMeta, KINDS, safeName } from './data.js';
import { loadCalib, saveCalib, snapshotCalibration } from './calib.js';

export async function requestPersistence(storage = globalThis.navigator?.storage) {
  if (!storage?.persist) return { supported: false, persisted: false };
  try {
    const already = storage.persisted ? await storage.persisted() : false;
    return { supported: true, persisted: already || (await storage.persist()) };
  } catch { return { supported: true, persisted: false }; }
}

// ---- folder handle is kept in a tiny separate IndexedDB so it survives reloads ------------------
const PREFS = 'alps-logger-prefs';
function prefs() {
  return new Promise((res, rej) => {
    const o = indexedDB.open(PREFS, 1);
    o.onupgradeneeded = () => o.result.createObjectStore('kv');
    o.onsuccess = () => res(o.result); o.onerror = () => rej(o.error);
  });
}
export async function saveFolderHandle(h) {
  const d = await prefs();
  await new Promise((res, rej) => { const tx = d.transaction('kv', 'readwrite'); h ? tx.objectStore('kv').put(h, 'dir') : tx.objectStore('kv').delete('dir'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
export async function loadFolderHandle() {
  const d = await prefs();
  return new Promise((res) => { const r = d.transaction('kv').objectStore('kv').get('dir'); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); });
}

// ---- sessions saved as CSV in the auto-save folder ----------------------------------------------
export const isFolderId = (v) => typeof v === 'string' && v.startsWith('f:');
export const parseSessionId = (v) => (isFolderId(v) ? v : +v);

function csvRows(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(cell.replace(/\r$/, '')); cell = '';
      if (c === '\n') { rows.push(row); row = []; }
    } else cell += c;
  }
  if (quoted) throw new Error('Unterminated quoted CSV field');
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

export function parsePositionCsv(text) {
  const [head = [], ...rows] = csvRows(text);
  const fields = ['epoch', 'reported_x', 'reported_y', 'reported_z', 'file_position', 'file_size', 'filename', 'state'];
  const indices = fields.map((f) => head.indexOf(f));
  if (indices.some((i) => i < 0)) throw new Error('Not an ALPS position trace CSV');
  return rows.filter((r) => r.length >= head.length).map((r) => indices.map((k, i) => {
    if (i >= 6) return r[k] || null;
    if (r[k] === '') return null;
    const v = Number(r[k]);
    if (!Number.isFinite(v)) throw new Error('Invalid number in ALPS position trace CSV');
    return v;
  }));
}

// Parses an ALPS CSV (header-driven, extra columns such as force_* are ignored) into a session + rows
// shaped like the browser database: [epoch, raw, filtered, z, x, y].
export function parseCsv(text, name = 'file.csv') {
  const lines = text.split(/\r?\n/);
  const head = (lines[0] || '').split(',').map((s) => s.trim());
  const col = (k) => head.indexOf(k);
  const ie = col('epoch'), it = col('t_s'), ir = col('raw'), ifl = col('filtered'), iz = col('z'), ix = col('x'), iy = col('y');
  if (ie < 0 || ir < 0) throw new Error('Not an ALPS CSV: ' + name);
  const num = (c, i) => { if (i < 0 || c[i] === undefined || c[i] === '') return null; const v = +c[i]; return Number.isFinite(v) ? v : null; };
  const rows = []; let started = null;
  for (let k = 1; k < lines.length; k++) {
    if (!lines[k]) continue;
    const c = lines[k].split(',');
    if (c.length <= Math.max(ie, ir, ifl, iz, ix, iy)) continue; // truncated last line
    const e = num(c, ie); if (e == null) continue;
    if (started === null) started = e - (num(c, it) || 0);
    rows.push([e, num(c, ir), num(c, ifl), num(c, iz), num(c, ix), num(c, iy)]);
  }
  started = started ?? 0;
  return { session: { id: 'f:' + name, name: name.replace(/\.csv$/i, ''), source: 'folder', started, ended: rows.length ? rows[rows.length - 1][0] : started, n: rows.length }, rows };
}

// Fills a <select> with browser sessions plus (if a folder is set) the CSV files saved in it.
export async function fillSessionSelect(sel, db) {
  const keep = sel.value;
  sel.innerHTML = '<option value="">– choose –</option>';
  const group = (label) => { const g = document.createElement('optgroup'); g.label = label; sel.append(g); return g; };
  const add = (g, value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; g.append(o); };
  const rows = await db.listSessions();
  if (rows.length) { const g = group('Recorded in this browser'); for (const s of rows) add(g, s.id, `#${s.id} ${s.name} (${s.n} samples)${s.file ? ' – ' + s.file : ''}`); }
  if (db.listFolder && db.dir) {
    try {
      const f = await db.listFolder();
      if (f.length) { const g = group('Saved in folder: ' + db.dir.name); for (const s of f) add(g, s.id, `${s.file} (${Math.max(1, Math.round(s.size / 1024))} KB)`); }
    } catch { /* folder unreadable: browser sessions still work */ }
  }
  if (keep) sel.value = keep;
}

// Wraps a db. While `dir` is set, every session is also appended to a CSV file in that folder as it records.
// The CSV holds counts only (same columns as the manual export); failures never interrupt recording.
// Ids like "f:name.csv" address CSV files in the folder (read-only) through the same db interface.
export class MirrorDb {
  constructor(inner, { onError = () => {}, getCalibration = () => null } = {}) {
    this.inner = inner; this.dir = null; this.onError = onError; this.getCalibration = getCalibration; this.files = new Map(); this.chains = new Map(); this.lastWrite = null; this.cache = new Map();
    for (const m of ['listSessions', 'deleteSession', 'importSession']) this[m] = (...a) => inner[m](...a);
  }
  setFolder(dir) { this.dir = dir || null; this.files.clear(); this.cache.clear(); }

  async listFolder() {
    if (!this.dir) return [];
    const out = [];
    for await (const [name, h] of this.dir.entries()) {
      if (h.kind !== 'file' || !/\.csv$/i.test(name) || /\.(env|summary|layers|events|positions)\.csv$/i.test(name)) continue;
      const f = await h.getFile();
      out.push({ id: 'f:' + name, name: name.replace(/\.csv$/i, ''), file: name, size: f.size, modified: f.lastModified / 1000 });
    }
    return out.sort((a, b) => b.modified - a.modified);
  }
  async _folderLoad(id) {
    if (!this.dir) throw new Error('No folder selected');
    const name = id.slice(2);
    const f = await (await this.dir.getFileHandle(name)).getFile();
    let positionsFile = null;
    try { positionsFile = await (await this.dir.getFileHandle(name.replace(/\.csv$/i, '.positions.csv'))).getFile(); }
    catch (e) { if (e.name !== 'NotFoundError') throw e; }
    let metadataFile = null;
    try { metadataFile = await (await this.dir.getFileHandle(name.replace(/\.csv$/i, '.meta.json'))).getFile(); }
    catch (e) { if (e.name !== 'NotFoundError') throw e; }
    const c = this.cache.get(id);
    const positionVersion = positionsFile ? `${positionsFile.lastModified}:${positionsFile.size}` : '';
    const metadataVersion = metadataFile ? `${metadataFile.lastModified}:${metadataFile.size}` : '';
    if (c && c.mod === f.lastModified && c.size === f.size && c.positionVersion === positionVersion && c.metadataVersion === metadataVersion) return c.v;
    const v = parseCsv(await f.text(), name);
    if (metadataFile) {
      const metadata = JSON.parse(await metadataFile.text());
      let settings = metadata.recording_calibration ?? metadata.calibration_settings;
      if (settings === undefined && metadata.calibration) {
        const cal = metadata.calibration;
        settings = { tare: cal.tare_counts, countsPerGram: cal.counts_per_gram, unit: cal.unit, invert: !!cal.inverted };
      }
      if (settings !== undefined) v.session.calibration = snapshotCalibration(settings);
    }
    v.positions = positionsFile ? parsePositionCsv(await positionsFile.text()) : [];
    const printed = v.positions.find((r) => r[6] && r[5] > 0);
    if (printed) v.session.file = printed[6];
    this.cache.delete(id); this.cache.set(id, { mod: f.lastModified, size: f.size, positionVersion, metadataVersion, v });
    if (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value);
    return v;
  }
  async getSession(id) { return isFolderId(id) ? (await this._folderLoad(id)).session : this.inner.getSession(id); }
  async getSamples(id, kind = 'raw') {
    if (isFolderId(id)) { const v = await this._folderLoad(id); return kind === 'raw' ? v.rows : kind === 'pos' ? v.positions : []; }
    return this.inner.getSamples(id, kind);
  }
  async scanSamples(id, cb, kind = 'raw') {
    if (isFolderId(id)) { if (kind === 'raw' || kind === 'pos') cb(await this.getSamples(id, kind)); } else await this.inner.scanSamples(id, cb, kind);
  }
  // Copies a folder CSV into the browser database; returns the new session id.
  async importFromFolder(id) {
    const { session, rows, positions } = await this._folderLoad(id);
    return this.inner.importSession({ ...session, id: undefined, source: 'folder import' }, rows, { pos: positions });
  }
  _queue(id, fn) {
    const p = (this.chains.get(id) || Promise.resolve()).then(fn).catch((e) => { this.onError(e); });
    this.chains.set(id, p); return p;
  }
  // Other kinds use matching sidecars: .summary.csv, .layers.csv, .events.csv, .positions.csv.
  async _file(id, kind) {
    const key = `${id}:${kind}`;
    if (this.files.has(key)) return this.files.get(key);
    const s = await this.inner.getSession(id);
    const base = `alps_${id}_${safeName(s.name)}`;
    const fh = await this.dir.getFileHandle(kind === 'raw' ? `${base}.csv` : `${base}.${KINDS[kind].suffix}.csv`, { create: true });
    const f = { fh, session: s, size: 0 };
    this.files.set(key, f);
    await this._append(f, kind === 'raw' ? toCsv(s, []) : kindToCsv(kind, s, []));
    return f;
  }
  async startSession(name, source, meta) {
    const calibration = snapshotCalibration(meta?.calibration ?? this.getCalibration());
    const id = await this.inner.startSession(name, source, { ...meta, calibration });
    if (this.dir) {
      this._queue(id, () => this._file(id, 'raw'));
      this._queue(id, () => this._writeMeta(id));
    }
    return id;
  }
  async _writeMeta(id) {
    const session = await this.inner.getSession(id);
    const metadata = exportMeta(session, [], null);
    metadata.session.samples = session.n;
    const name = `alps_${id}_${safeName(session.name)}.meta.json`;
    const fh = await this.dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(metadata, null, 2)); await w.close();
    this.lastWrite = Date.now();
  }
  async _append(f, text) {
    if (!f || !text) return;
    const w = await f.fh.createWritable({ keepExistingData: true });
    await w.seek(f.size); await w.write(text); await w.close();
    f.size += new TextEncoder().encode(text).length; this.lastWrite = Date.now();
  }
  async addSamples(id, rows, kind = 'raw') {
    await this.inner.addSamples(id, rows, kind);
    if (this.dir && this.chains.has(id)) {
      this._queue(id, async () => {
        const f = await this._file(id, kind);
        const text = kind === 'raw' ? toCsv(f.session, rows) : kindToCsv(kind, f.session, rows, null, [], false);
        await this._append(f, kind === 'raw' ? text.split('\n').slice(1).join('\n') : text);
      });
    }
  }
  async endSession(id) {
    await this.inner.endSession(id);
    if (this.dir && this.chains.has(id)) this._queue(id, () => this._writeMeta(id));
    await (this.chains.get(id) || Promise.resolve());
    for (const k of [...this.files.keys()]) if (k.startsWith(`${id}:`)) this.files.delete(k);
    this.chains.delete(id);
  }
}

// ---- backup / restore ---------------------------------------------------------------------------
export async function exportBackup(db, storage = null) {
  const calibration = storage ? snapshotCalibration(loadCalib(storage)) : null;
  const parts = ['{"format":"alps-logger-backup","version":3,"calibration_settings":' + JSON.stringify(calibration) + ',"sessions":['];
  const list = (await db.listSessions()).sort((a, b) => a.id - b.id);
  let first = true;
  for (const s of list) {
    const extra = {};
    for (const k of Object.keys(KINDS)) { const r = await db.getSamples(s.id, k); if (r.length) extra[k] = r; }
    parts.push((first ? '' : ',') + JSON.stringify({ session: s, rows: await db.getSamples(s.id), extra }));
    first = false;
  }
  parts.push(']}');
  return new Blob(parts, { type: 'application/json' });
}

export async function importBackup(db, text, storage = null) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('Not a valid backup file'); }
  if (doc?.format !== 'alps-logger-backup' || !Array.isArray(doc.sessions)) throw new Error('Not an ALPS logger backup file');
  const calibration = snapshotCalibration(doc.calibration_settings);
  const sessions = doc.sessions.map((entry) => ({
    ...entry, session: entry.session?.calibration === undefined ? entry.session :
      { ...entry.session, calibration: snapshotCalibration(entry.session.calibration) },
  }));
  let n = 0;
  for (const { session, rows, extra } of sessions) { await db.importSession(session, rows, extra || {}); n++; }
  if (storage && calibration) saveCalib(storage, calibration);
  return n;
}
