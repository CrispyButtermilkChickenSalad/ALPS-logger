// Durability helpers: persistent-storage request, auto-save mirror to a user-chosen folder, backup/restore.
import { toCsv, safeName } from './data.js';

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

// Wraps a db. While `dir` is set, every session is also appended to a CSV file in that folder as it records.
// The CSV holds counts only (same columns as the manual export); failures never interrupt recording.
export class MirrorDb {
  constructor(inner, { onError = () => {} } = {}) {
    this.inner = inner; this.dir = null; this.onError = onError; this.files = new Map(); this.chains = new Map(); this.lastWrite = null;
    for (const m of ['listSessions', 'getSession', 'deleteSession', 'getSamples', 'scanSamples', 'importSession']) this[m] = (...a) => inner[m](...a);
  }
  setFolder(dir) { this.dir = dir || null; this.files.clear(); }
  _queue(id, fn) {
    const p = (this.chains.get(id) || Promise.resolve()).then(fn).catch((e) => { this.onError(e); });
    this.chains.set(id, p); return p;
  }
  async startSession(name, source, meta) {
    const id = await this.inner.startSession(name, source, meta);
    if (this.dir) {
      this._queue(id, async () => {
        const s = await this.inner.getSession(id);
        const fh = await this.dir.getFileHandle(`alps_${id}_${safeName(name)}.csv`, { create: true });
        this.files.set(id, { fh, session: s, size: 0 });
        await this._append(id, toCsv(s, []));
      });
    }
    return id;
  }
  async _append(id, text) {
    const f = this.files.get(id); if (!f || !text) return;
    const w = await f.fh.createWritable({ keepExistingData: true });
    await w.seek(f.size); await w.write(text); await w.close();
    f.size += new TextEncoder().encode(text).length; this.lastWrite = Date.now();
  }
  async addSamples(id, rows) {
    await this.inner.addSamples(id, rows);
    if (this.dir && this.chains.has(id)) {
      this._queue(id, async () => {
        const f = this.files.get(id); if (!f) return;
        await this._append(id, toCsv(f.session, rows).split('\n').slice(1).join('\n'));
      });
    }
  }
  async endSession(id) {
    await this.inner.endSession(id);
    await (this.chains.get(id) || Promise.resolve());
    this.files.delete(id); this.chains.delete(id);
  }
}

// ---- backup / restore ---------------------------------------------------------------------------
export async function exportBackup(db) {
  const parts = ['{"format":"alps-logger-backup","version":1,"sessions":['];
  const list = (await db.listSessions()).sort((a, b) => a.id - b.id);
  let first = true;
  for (const s of list) {
    parts.push((first ? '' : ',') + JSON.stringify({ session: s, rows: await db.getSamples(s.id) }));
    first = false;
  }
  parts.push(']}');
  return new Blob(parts, { type: 'application/json' });
}

export async function importBackup(db, text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('Not a valid backup file'); }
  if (doc?.format !== 'alps-logger-backup' || !Array.isArray(doc.sessions)) throw new Error('Not an ALPS logger backup file');
  let n = 0;
  for (const { session, rows } of doc.sessions) { await db.importSession(session, rows); n++; }
  return n;
}
