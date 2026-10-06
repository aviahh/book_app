// IndexedDB storage for books. The PDF file itself lives in a separate store
// so listing the library never loads megabytes of book data.

const DB_NAME = 'folio';
const VERSION = 1;
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then((r) => (result = r));
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export async function listBooks() {
  return tx(['books'], 'readonly', (t) => wrap(t.objectStore('books').getAll()));
}

export async function getBook(id) {
  return tx(['books'], 'readonly', (t) => wrap(t.objectStore('books').get(id)));
}

export async function getBookFile(id) {
  return tx(['files'], 'readonly', (t) => wrap(t.objectStore('files').get(id)));
}

export async function addBook(book, file) {
  return tx(['books', 'files'], 'readwrite', (t) => {
    t.objectStore('books').put(book);
    t.objectStore('files').put(file, book.id);
  });
}

export async function updateBook(id, patch) {
  return tx(['books'], 'readwrite', async (t) => {
    const store = t.objectStore('books');
    const book = await wrap(store.get(id));
    if (book) store.put({ ...book, ...patch });
  });
}

export async function removeBook(id) {
  return tx(['books', 'files'], 'readwrite', (t) => {
    t.objectStore('books').delete(id);
    t.objectStore('files').delete(id);
  });
}

export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {}
}
