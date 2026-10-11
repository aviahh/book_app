// What sync knows about each piece of data, in its own small database
// (separate from the library's, so neither can get in the other's way).
//
// One record per item: { k, v, t, d, dirty }
//   k      key ("s:theme", "b:<book>:prog" …)
//   v      the last value seen, here or from the server
//   t      when it was changed
//   d      1 = removed (tombstone)
//   dirty  changed here and not yet accepted by the server

const DB_NAME = 'folio-sync';
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('items', { keyPath: 'k' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(['items'], mode);
        let result;
        const r = fn(t.objectStore('items'));
        if (r) r.onsuccess = () => (result = r.result);
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

/** All items, as a Map by key. */
export async function loadItems() {
  const list = (await run('readonly', (s) => s.getAll())) || [];
  const map = new Map();
  for (const it of list) map.set(it.k, it);
  return map;
}

/** Save these items (records) in one go. */
export function saveItems(list) {
  if (!list.length) return Promise.resolve();
  return run('readwrite', (s) => {
    for (const it of list) s.put(it);
  });
}

export function clearItems() {
  return run('readwrite', (s) => {
    s.clear();
  });
}
