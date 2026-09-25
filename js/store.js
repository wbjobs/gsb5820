// IndexedDB persistence. Every op is stored ENCRYPTED ({ k, src, seq, iv, data });
// only non-secret metadata (salt, key verifier) is stored in the clear.

const DB_NAME = 'gsb-kanban';
const DB_VERSION = 1;

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'k' });
      }
      if (!db.objectStoreNames.contains('ops')) {
        const ops = db.createObjectStore('ops', { keyPath: 'k' });
        ops.createIndex('src', 'src', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => resolve(out && out._result !== undefined ? out._result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function getMeta(db, k) {
  return reqToPromise(db.transaction('meta', 'readonly').objectStore('meta').get(k))
    .then((row) => (row ? row.v : undefined));
}

export function putMeta(db, k, v) {
  return tx(db, 'meta', 'readwrite', (s) => s.put({ k, v }));
}

// blob: { iv, data } — already encrypted
export function appendOp(db, src, seq, blob) {
  return tx(db, 'ops', 'readwrite', (s) =>
    s.put({ k: src + ':' + seq, src, seq, iv: blob.iv, data: blob.data }));
}

export function getAllOps(db) {
  return reqToPromise(db.transaction('ops', 'readonly').objectStore('ops').getAll());
}

export function getOpsBySrc(db, src, fromSeq, toSeq) {
  return reqToPromise(
    db.transaction('ops', 'readonly').objectStore('ops').index('src').getAll(src)
  ).then((rows) =>
    rows.filter((r) => r.seq >= fromSeq && (toSeq === undefined || r.seq <= toSeq))
      .sort((a, b) => a.seq - b.seq));
}

// Max contiguous seq per source, used as the sync version vector.
export function versionVector(rows) {
  const v = {};
  for (const r of rows) {
    if (v[r.src] === undefined || r.seq > v[r.src]) v[r.src] = r.seq;
  }
  return v;
}
