// IndexedDB storage. Samples are stored as chunks (one record per flush) for efficient hours-long recordings.
const DB_NAME = 'alps-logger';

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

function nextPrintName(base, sessions) {
  let next = 1n;
  const prefix = base + ' (';
  for (const { name } of sessions) {
    if (name === base && next < 2n) next = 2n;
    if (typeof name !== 'string' || !name.startsWith(prefix) || !name.endsWith(')')) continue;
    const suffix = name.slice(prefix.length, -1);
    if (/^[1-9]\d*$/.test(suffix) && BigInt(suffix) >= next) next = BigInt(suffix) + 1n;
  }
  return next === 1n ? base : `${base} (${next})`;
}

export class IdbDb {
  static async open() {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      const d = open.result;
      d.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
      d.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true }).createIndex('sid', 'sid');
    };
    const db = new IdbDb(await req(open));
    await db._closeStale();
    return db;
  }

  constructor(db) { this.db = db; }

  // Close sessions left open by a crash / closed tab at their last sample or position poll.
  async _closeStale() {
    for (const s of await this.listSessions()) {
      if (s.ended != null) continue;
      const rows = await this.getSamples(s.id), env = await this.getSamples(s.id, 'env'), pos = await this.getSamples(s.id, 'pos');
      const last = Math.max(...[rows, env, pos].map((r) => r.length ? r[r.length - 1][0] : s.started));
      const tx = this.db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').put({ ...s, ended: last });
      await done(tx);
    }
  }

  async startSession(name, source, meta = {}) {
    const { autoName = false, ...details } = meta;
    const tx = this.db.transaction('sessions', 'readwrite');
    const store = tx.objectStore('sessions');
    if (autoName) name = nextPrintName(name, await req(store.getAll()));
    const id = await req(store.add({ name, source, started: Date.now() / 1000, ended: null, n: 0, ...details }));
    await done(tx);
    return id;
  }

  async endSession(id) {
    const tx = this.db.transaction('sessions', 'readwrite');
    const st = tx.objectStore('sessions');
    const s = await req(st.get(id));
    if (s) st.put({ ...s, ended: Date.now() / 1000 });
    await done(tx);
  }

  async addSamples(id, rows, kind = 'raw') {
    if (!rows.length) return;
    const tx = this.db.transaction(['sessions', 'chunks'], 'readwrite');
    tx.objectStore('chunks').add({ sid: id, kind, rows });
    const st = tx.objectStore('sessions');
    const s = await req(st.get(id));
    if (s) st.put(kind === 'raw' ? { ...s, n: s.n + rows.length } : { ...s, [`n_${kind}`]: (s[`n_${kind}`] || 0) + rows.length });
    await done(tx);
  }

  // `extra` holds the non-raw kinds ({env, layer, evt, pos}) of a backed-up session.
  async importSession(session, rows, extra = {}) {
    const { id, ...rest } = session;
    const tx = this.db.transaction(['sessions', 'chunks'], 'readwrite');
    const sid = await req(tx.objectStore('sessions').add({ ...rest, n: rows.length }));
    for (let i = 0; i < rows.length; i += 5000) tx.objectStore('chunks').add({ sid, kind: 'raw', rows: rows.slice(i, i + 5000) });
    for (const [kind, kr] of Object.entries(extra)) for (let i = 0; i < kr.length; i += 5000) tx.objectStore('chunks').add({ sid, kind, rows: kr.slice(i, i + 5000) });
    await done(tx);
    return sid;
  }

  async listSessions() {
    const tx = this.db.transaction('sessions');
    const all = await req(tx.objectStore('sessions').getAll());
    return all.sort((a, b) => b.id - a.id);
  }

  async getSession(id) {
    return req(this.db.transaction('sessions').objectStore('sessions').get(id));
  }

  async deleteSession(id) {
    const tx = this.db.transaction(['sessions', 'chunks'], 'readwrite');
    tx.objectStore('sessions').delete(id);
    const idx = tx.objectStore('chunks').index('sid');
    const keys = await req(idx.getAllKeys(id));
    for (const k of keys) tx.objectStore('chunks').delete(k);
    await done(tx);
  }

  async getSamples(id, kind = 'raw') {
    const chunks = await req(this.db.transaction('chunks').objectStore('chunks').index('sid').getAll(id));
    return chunks.filter((c) => (c.kind || 'raw') === kind).sort((a, b) => a.id - b.id).flatMap((c) => c.rows);
  }

  // Streams chunk by chunk so hours-long sessions do not need to be held as row arrays.
  async scanSamples(id, cb, kind = 'raw') {
    const keys = (await req(this.db.transaction('chunks').objectStore('chunks').index('sid').getAllKeys(id))).sort((a, b) => a - b);
    for (const k of keys) {
      const c = await req(this.db.transaction('chunks').objectStore('chunks').get(k));
      if (c && (c.kind || 'raw') === kind) cb(c.rows);
    }
  }
}

// Same interface, in memory (tests).
export class MemoryDb {
  constructor() { this.sessions = new Map(); this.rows = new Map(); this.next = 1; }
  _k(id, kind) { const m = this.rows.get(id); return m ? (m[kind] ||= []) : []; }
  async startSession(name, source, meta = {}) {
    const { autoName = false, ...details } = meta;
    if (autoName) name = nextPrintName(name, this.sessions.values());
    const id = this.next++;
    this.sessions.set(id, { id, name, source, started: Date.now() / 1000, ended: null, n: 0, ...details });
    this.rows.set(id, { raw: [] });
    return id;
  }
  async importSession(session, rows, extra = {}) {
    const { id, ...rest } = session;
    const nid = this.next++;
    this.sessions.set(nid, { ...rest, id: nid, n: rows.length }); this.rows.set(nid, { raw: rows.slice() });
    for (const [k, v] of Object.entries(extra)) this.rows.get(nid)[k] = v.slice();
    return nid;
  }
  async endSession(id) { this.sessions.get(id).ended = Date.now() / 1000; }
  async addSamples(id, rows, kind = 'raw') {
    this._k(id, kind).push(...rows);
    const s = this.sessions.get(id);
    if (kind === 'raw') s.n += rows.length; else s[`n_${kind}`] = (s[`n_${kind}`] || 0) + rows.length;
  }
  async listSessions() { return [...this.sessions.values()].sort((a, b) => b.id - a.id); }
  async getSession(id) { return this.sessions.get(id); }
  async deleteSession(id) { this.sessions.delete(id); this.rows.delete(id); }
  async getSamples(id, kind = 'raw') { return this._k(id, kind); }
  async scanSamples(id, cb, kind = 'raw') { cb(this._k(id, kind)); }
}
