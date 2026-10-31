// IndexedDB storage. Samples are stored as chunks (one record per flush) for efficient hours-long recordings.
const DB_NAME = 'alps-logger';

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

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

  // Close sessions left open by a crash / closed tab, ending them at their last sample.
  async _closeStale() {
    for (const s of await this.listSessions()) {
      if (s.ended != null) continue;
      const rows = await this.getSamples(s.id);
      const tx = this.db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').put({ ...s, ended: rows.length ? rows[rows.length - 1][0] : s.started });
      await done(tx);
    }
  }

  async startSession(name, source, meta = {}) {
    const tx = this.db.transaction('sessions', 'readwrite');
    const id = await req(tx.objectStore('sessions').add({ name, source, started: Date.now() / 1000, ended: null, n: 0, ...meta }));
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

  async addSamples(id, rows) {
    if (!rows.length) return;
    const tx = this.db.transaction(['sessions', 'chunks'], 'readwrite');
    tx.objectStore('chunks').add({ sid: id, rows });
    const st = tx.objectStore('sessions');
    const s = await req(st.get(id));
    if (s) st.put({ ...s, n: s.n + rows.length });
    await done(tx);
  }

  async importSession(session, rows) {
    const { id, ...rest } = session;
    const tx = this.db.transaction(['sessions', 'chunks'], 'readwrite');
    const sid = await req(tx.objectStore('sessions').add({ ...rest, n: rows.length }));
    for (let i = 0; i < rows.length; i += 5000) tx.objectStore('chunks').add({ sid, rows: rows.slice(i, i + 5000) });
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

  async getSamples(id) {
    const chunks = await req(this.db.transaction('chunks').objectStore('chunks').index('sid').getAll(id));
    chunks.sort((a, b) => a.id - b.id);
    return chunks.flatMap((c) => c.rows);
  }

  // Streams chunk by chunk so hours-long sessions do not need to be held as row arrays.
  async scanSamples(id, cb) {
    const keys = (await req(this.db.transaction('chunks').objectStore('chunks').index('sid').getAllKeys(id))).sort((a, b) => a - b);
    for (const k of keys) {
      const c = await req(this.db.transaction('chunks').objectStore('chunks').get(k));
      if (c) cb(c.rows);
    }
  }
}

// Same interface, in memory (tests).
export class MemoryDb {
  constructor() { this.sessions = new Map(); this.rows = new Map(); this.next = 1; }
  async startSession(name, source, meta = {}) {
    const id = this.next++;
    this.sessions.set(id, { id, name, source, started: Date.now() / 1000, ended: null, n: 0, ...meta });
    this.rows.set(id, []);
    return id;
  }
  async importSession(session, rows) {
    const { id, ...rest } = session;
    const nid = this.next++;
    this.sessions.set(nid, { ...rest, id: nid, n: rows.length }); this.rows.set(nid, rows.slice());
    return nid;
  }
  async endSession(id) { this.sessions.get(id).ended = Date.now() / 1000; }
  async addSamples(id, rows) { this.rows.get(id).push(...rows); this.sessions.get(id).n += rows.length; }
  async listSessions() { return [...this.sessions.values()].sort((a, b) => b.id - a.id); }
  async getSession(id) { return this.sessions.get(id); }
  async deleteSession(id) { this.sessions.delete(id); this.rows.delete(id); }
  async getSamples(id) { return this.rows.get(id) || []; }
  async scanSamples(id, cb) { cb(this.rows.get(id) || []); }
}
