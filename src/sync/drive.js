// Books in the account's own Google Drive, in a folder called "Folio".
//
// Folio only has the narrowest access (drive.file): it sees the files it put
// there itself, nothing else in the Drive. Files go straight between the
// device and Google; the Worker only hands out a short-lived access token.
//
// While "Keep books in Google Drive" is on, every device puts its books that
// aren't there yet into the folder, one at a time, quietly. Other devices
// then show those books in the library and download one when it's opened
// (or with "Download for offline"). "Remove download" frees the space on one
// device; the book, its progress and its copy in Drive stay.

import { listBooks, getBookFile, removeBook } from '../db.js';
import { importFile } from '../pdf.js';
import { account, post, noteDrive, driveCopy, cloudBooks, onRemovedEverywhere, removeEverywhere } from './engine.js';
import { isFamilyBook } from './family.js';

const API = 'https://www.googleapis.com';
const FOLDER_KEY = 'folio.drive.v1';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

let token = null; // { token, until }

async function accessToken(fresh) {
  if (!fresh && token && token.until > Date.now() + 60000) return token.token;
  const a = account();
  const res = await post('drive/token', {}, a && a.token);
  token = { token: res.token, until: Date.now() + (res.expiresIn || 3600) * 1000 };
  return token.token;
}

/** A request to Drive, with the access token (fetched again once if it ran out). */
async function drive(path, opts = {}, retried) {
  const headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + (await accessToken(retried)) });
  const res = await fetch(path.indexOf('http') === 0 ? path : API + path, Object.assign({}, opts, { headers }));
  if (res.status === 401 && !retried) return drive(path, opts, true);
  if (!res.ok) throw new Error('Drive: HTTP ' + res.status);
  return res;
}

const q = (s) => encodeURIComponent(s);

/** The "Folio" folder (made the first time). */
async function folder() {
  let id = '';
  try {
    id = (JSON.parse(localStorage.getItem(FOLDER_KEY) || '{}') || {}).folder || '';
  } catch (e) {}
  if (id) return id;
  const found = await (await drive(`/drive/v3/files?q=${q(`name='Folio' and mimeType='${FOLDER_MIME}' and trashed=false`)}&fields=files(id,createdTime)&orderBy=createdTime`)).json();
  if (found.files && found.files.length) id = found.files[0].id;
  else {
    const made = await (await drive('/drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Folio', mimeType: FOLDER_MIME }) })).json();
    id = made.id;
  }
  try {
    localStorage.setItem(FOLDER_KEY, JSON.stringify({ folder: id }));
  } catch (e) {}
  return id;
}

/** A copy of this book already in Drive (put there from another device), if any. */
async function findCopy(sid) {
  const res = await (await drive(`/drive/v3/files?q=${q(`appProperties has { key='folioSid' and value='${sid}' } and trashed=false`)}&fields=files(id,size)`)).json();
  return res.files && res.files[0] ? { id: res.files[0].id, size: +res.files[0].size || 0 } : null;
}

/** Put one book's file into the Folio folder. */
async function upload(book) {
  const file = await getBookFile(book.id);
  if (!file) return null;
  const type = book.format === 'epub' ? 'application/epub+zip' : 'application/pdf';
  const name = book.fileName || `${book.title}.${book.format === 'epub' ? 'epub' : 'pdf'}`;
  const meta = { name, mimeType: type, parents: [await folder()], appProperties: { folioSid: book.syncId } };
  const start = await drive('/upload/drive/v3/files?uploadType=resumable&fields=id,size', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type },
    body: JSON.stringify(meta),
  });
  const session = start.headers.get('Location');
  if (!session) throw new Error('Drive: no upload address');
  const res = await fetch(session, { method: 'PUT', headers: { 'Content-Type': type }, body: file });
  if (!res.ok) throw new Error('Drive: upload HTTP ' + res.status);
  const made = await res.json();
  return { id: made.id, size: file.size };
}

export const driveOn = () => {
  const a = account();
  return !!(a && a.token && a.drive);
};

// ---------------------------------------------------------------- keeping books in Drive

let busy = null;
const progress = { done: 0, total: 0, uploading: null };
const listeners = new Set();
const tell = () => listeners.forEach((fn) => fn(Object.assign({}, progress)));
export const onDriveProgress = (fn) => (listeners.add(fn), () => listeners.delete(fn));

/** Put every book on this device that isn't in Drive yet there. One at a time, quietly; stops on any problem and tries again later. */
export function keepBooksInDrive() {
  if (!driveOn() || busy || navigator.onLine === false) return busy || Promise.resolve();
  busy = (async () => {
    // Books from a family library stay out of this account's Drive.
    const books = (await listBooks()).filter((b) => b.syncId && !isFamilyBook(b.syncId));
    progress.total = books.length;
    progress.done = 0;
    for (const b of books) {
      if (!driveOn()) break;
      if (await driveCopy(b.syncId)) {
        progress.done++;
        continue;
      }
      progress.uploading = b.title;
      tell();
      const copy = (await findCopy(b.syncId)) || (await upload(b));
      if (copy) await noteDrive(b.syncId, copy);
      progress.done++;
    }
    progress.uploading = null;
    tell();
  })()
    .catch((e) => {
      progress.uploading = null;
      tell();
      console.warn(e);
    })
    .then(() => {
      busy = null;
    });
  return busy;
}

/** How many of the books here are in Drive: { done, total, uploading }. */
export async function driveSummary() {
  const books = (await listBooks()).filter((b) => b.syncId && !isFamilyBook(b.syncId));
  let done = 0;
  for (const b of books) if (await driveCopy(b.syncId)) done++;
  return { done, total: books.length, uploading: progress.uploading };
}

// ---------------------------------------------------------------- downloading

/** Download a book from Drive into the library here. onProgress(fraction). Returns the local book. */
export async function downloadBook(sid, onProgress = () => {}) {
  const copy = await driveCopy(sid);
  if (!copy) throw new Error('This book isn’t in Google Drive.');
  const blob = await new Promise((resolve, reject) => {
    // XMLHttpRequest: download progress works everywhere (also on older iPads).
    accessToken().then((t) => {
      const x = new XMLHttpRequest();
      x.open('GET', `${API}/drive/v3/files/${encodeURIComponent(copy.id)}?alt=media`);
      x.responseType = 'blob';
      x.setRequestHeader('Authorization', 'Bearer ' + t);
      x.onprogress = (e) => onProgress(e.lengthComputable ? e.loaded / e.total : copy.size ? Math.min(0.99, e.loaded / copy.size) : 0);
      x.onload = () => (x.status === 200 ? resolve(x.response) : reject(new Error(x.status === 404 ? 'This book is no longer in Google Drive.' : 'Download failed (' + x.status + ')')));
      x.onerror = () => reject(new Error('Download failed. Check the connection.'));
      x.send();
    }, reject);
  });
  const books = (await cloudBooks()).filter((b) => b.sid === sid);
  const meta = (books[0] && books[0].meta) || {};
  const name = meta.fileName || `${meta.title || 'Book'}.${meta.format === 'epub' ? 'epub' : 'pdf'}`;
  const file = new File([blob], name, { type: blob.type || (meta.format === 'epub' ? 'application/epub+zip' : 'application/pdf') });
  const ids = new Set((await listBooks()).map((b) => b.id));
  const book = await importFile(file, ids);
  // Already here under the same local id: find it.
  return book || (await listBooks()).find((b) => b.syncId === sid || b.fileName === name) || null;
}

/** Free the space on this device; the book stays in the library (in Drive) with its progress. */
export async function removeDownload(id) {
  await removeBook(id, 'download');
}

/** A book that isn't on this device: remove it from the library everywhere. */
export function removeCloudBook(sid) {
  return removeEverywhere(sid);
}

// A book removed from the library: its copy goes to the Drive trash (recoverable there for 30 days).
onRemovedEverywhere((sid, copy) => {
  if (!copy || !driveOn()) return;
  drive(`/drive/v3/files/${encodeURIComponent(copy.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) })
    .then(() => noteDrive(sid, null))
    .catch(() => {});
});

/** Turn "Keep books in Google Drive" on: Google asks for access (once per account). */
export async function connectDrive() {
  const a = account();
  const res = await post('drive/connect', {}, a && a.token);
  const to = new URL(res.url, document.baseURI);
  location.href = to.href;
  if (to.origin === location.origin) location.reload(); // local testing: no trip to Google, so load the page again
}

/** Turn it off for the account. Books already in Drive stay there. */
export async function disconnectDrive() {
  const a = account();
  await post('drive/disconnect', {}, a && a.token);
  token = null;
  if (a) {
    a.drive = false;
    try {
      localStorage.setItem('folio.sync.v1', JSON.stringify(a));
    } catch (e) {}
  }
}
