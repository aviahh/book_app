// The library lives in the account's own Google Drive, in a folder called
// "Folio" (and the folders inside it).
//
// Books get there any way at all: copied from a computer, uploaded from a
// phone, added in Folio. Folio finds them there (see syncFolder) and never
// makes a second copy. Books added in Folio on a device go up into the
// folder, one at a time, quietly. Other devices show every book in the
// folder and download one when it's opened (or with "Download for
// offline"). "Remove download" frees the space on one device; the book, its
// progress and its file in Drive stay. A file deleted from the folder
// leaves every device.
//
// Folio has access to the whole Drive (it must see files it didn't put
// there) but only ever works inside that folder. Files go straight between
// the device and Google; the Worker only hands out a short-lived access token.

import { listBooks, getBookFile, removeBook } from '../db.js';
import { importFile } from '../pdf.js';
import { account, post, noteDrive, driveCopy, driveCopies, cloudBooks, onRemovedEverywhere, removeEverywhere, itemOf, noteFolderBook, noteValue } from './engine.js';
import { isFamilyBook } from './family.js';
import { fileKind, contentIdOf, CHUNK } from './items.js';

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
/**
 * The library folder. The account remembers which one it is (item
 * "d:folder"), so every device uses the same folder; a device never decides
 * on its own by searching (Drive's search can miss a folder made moments
 * ago on another device, which would give a second "Folio" folder).
 * Only when the account has none yet: the oldest "Folio" at the top of My
 * Drive (one you made yourself, say), else a new one.
 */
let folderLookup = null;
function folder() {
  // One lookup at a time: two parts of the app asking at once must not make two folders.
  if (!folderLookup) folderLookup = findFolder().finally(() => (folderLookup = null));
  return folderLookup;
}

async function findFolder() {
  const known = await itemOf('d:folder');
  let id = known && !known.d && known.v && known.v.id;
  if (id) {
    try {
      const r = await drive(`/drive/v3/files/${encodeURIComponent(id)}?fields=id,trashed`);
      if (!(await r.json()).trashed) return id;
    } catch (e) {
      if (!/HTTP 404/.test(String(e && e.message))) throw e; // not sure it's gone: don't replace it
    }
  }
  const found = await (await drive(`/drive/v3/files?q=${q(`name='Folio' and mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`)}&fields=files(id,createdTime)&orderBy=createdTime`)).json();
  if (found.files && found.files.length) id = found.files[0].id;
  else {
    const made = await (await drive('/drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Folio', mimeType: FOLDER_MIME }) })).json();
    id = made.id;
  }
  await noteValue('d:folder', { id });
  try {
    localStorage.removeItem(FOLDER_KEY);
  } catch (e) {}
  return id;
}

/** Every "Folio" folder at the top of My Drive (normally one; two if devices ever made one each): all count as the library. */
async function folioFolders() {
  const found = await (await drive(`/drive/v3/files?q=${q(`name='Folio' and mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`)}&fields=files(id)`)).json();
  return (found.files || []).map((f) => f.id);
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
  const kind = fileKind(book.format, book.fileName);
  const type = kind.type;
  const name = book.fileName || `${book.title}.${kind.ext}`;
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

// ---------------------------------------------------------------- the folder is the library

const CHECKED_KEY = 'folio.drive.checked.v1';
const CHECK_EVERY = 60 * 1000;
const MISSING_KEY = 'folio.drive.missing.v1';
const CONFIRM_AFTER = 4 * 60 * 1000; // a file must still be missing this much later before its book leaves
const BOOK_FILE = /\.(pdf|epub|cbz|cbr)$/i;
const MAX_FOLDERS = 300;

/** The files directly in one Drive folder (not in the trash). */
async function children(folderId) {
  const out = [];
  let pageToken = '';
  do {
    const res = await (
      await drive(
        `/drive/v3/files?q=${q(`'${folderId}' in parents and trashed=false`)}&fields=${q('nextPageToken,files(id,name,mimeType,size,createdTime)')}&pageSize=1000${pageToken ? '&pageToken=' + q(pageToken) : ''}`,
      )
    ).json();
    for (const f of res.files || []) out.push(f);
    pageToken = res.nextPageToken || '';
  } while (pageToken);
  return out;
}

/** Every book file in the Folio folder and the folders inside it: { files, folders }. */
async function scanFolder() {
  const root = await folder();
  const tops = [root].concat((await folioFolders()).filter((id) => id !== root));
  const folders = new Set(tops);
  const queue = tops.slice();
  const files = [];
  while (queue.length) {
    for (const f of await children(queue.shift())) {
      if (f.mimeType === FOLDER_MIME) {
        if (!folders.has(f.id) && folders.size < MAX_FOLDERS) folders.add(f.id), queue.push(f.id);
      } else if (BOOK_FILE.test(f.name || '') && +f.size > 0) files.push(f);
    }
  }
  return { files, folders };
}

/** Part of a file in Drive (bytes a..b), without downloading the rest. */
async function range(id, a, b) {
  const res = await drive(`/drive/v3/files/${encodeURIComponent(id)}?alt=media`, { headers: { Range: `bytes=${a}-${b}` } });
  return new Uint8Array(await res.arrayBuffer());
}

/** A Drive file's content id (the same as the book's on any device), from its first and last 64 KB. */
async function remoteContentId(f) {
  const size = +f.size;
  const head = await range(f.id, 0, Math.min(size, CHUNK) - 1);
  const tail = size > CHUNK ? await range(f.id, Math.max(CHUNK, size - CHUNK), size - 1) : null;
  return contentIdOf(size, head, tail);
}

/** What the library shows for a book found in the folder, until a device opens it and reads its real details. */
function metaOf(f) {
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  const meta = {
    title: f.name.replace(/\.(pdf|epub|cbz|cbr)$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled',
    author: '',
    pageCount: 0,
    size: +f.size || 0,
    fileName: f.name,
    aspect: ext === 'pdf' ? 0.7 : 0.66,
    addedAt: Date.parse(f.createdTime) || Date.now(),
  };
  if (ext === 'epub') meta.format = 'epub';
  else if (ext === 'cbz' || ext === 'cbr') meta.format = 'comic';
  return meta;
}

const trash = (id) => drive(`/drive/v3/files/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });

/**
 * The library follows the Folio folder in Drive (and the folders inside it):
 *   - a book file put there by any means (a computer, a phone, the Drive
 *     app, or Folio) is in the library on every device, without a copy;
 *   - a book file deleted, put in the trash or moved out of the folder
 *     leaves the library on every device (downloads included).
 * Files are recognised by their content (first and last 64 KB, read from
 * Drive), so a book already on a device is matched, never uploaded twice.
 * Each missing file is confirmed on its own before anything is removed, so
 * a failed or partial answer from Drive never empties the library.
 * Returns how many books came or went.
 */
export async function syncFolder({ force = false, confirmAfter = CONFIRM_AFTER } = {}) {
  if (!driveOn() || navigator.onLine === false) return 0;
  let last = 0;
  try {
    last = +localStorage.getItem(CHECKED_KEY) || 0;
  } catch (e) {}
  if (!force && Date.now() - last < CHECK_EVERY) return 0;
  const { files, folders } = await scanFolder();
  const alive = new Map(files.map((f) => [f.id, f]));
  const known = await driveCopies();
  const knownIds = new Set(known.map((k) => k.copy.id));
  let changes = 0;

  // New files in the folder.
  for (const f of files) {
    if (knownIds.has(f.id)) continue;
    const sid = await remoteContentId(f);
    if (!sid) continue;
    const copy = await driveCopy(sid);
    // The same book twice in the folder: the first one found stands for it.
    if (copy && copy.id !== f.id && alive.has(copy.id)) continue;
    // Removed from the library in Folio a moment ago, its file on its way to the trash: leave it be.
    // (Otherwise a book file in the folder is in the library, also one that had been removed.)
    const meta = await itemOf(`b:${sid}:meta`);
    if (meta && meta.d && copy && copy.id === f.id) continue;
    await noteFolderBook(sid, metaOf(f), { id: f.id, size: +f.size, name: f.name });
    knownIds.add(f.id);
    changes++;
  }

  // Files that left the folder. Only after they were missing in two checks a few
  // minutes apart (Drive's lists can lag behind), and each confirmed on its own.
  let missing = {};
  try {
    missing = JSON.parse(localStorage.getItem(MISSING_KEY) || '{}') || {};
  } catch (e) {}
  const stillMissing = {};
  for (const { sid, copy } of known) {
    if (alive.has(copy.id)) continue;
    const since = missing[copy.id] || Date.now();
    stillMissing[copy.id] = since;
    if (Date.now() - since < confirmAfter) continue;
    let gone = false;
    try {
      const r = await fetch(`${API}/drive/v3/files/${encodeURIComponent(copy.id)}?fields=id,trashed,parents`, { headers: { Authorization: 'Bearer ' + (await accessToken()) } });
      if (r.status === 404) gone = true;
      else if (r.ok) {
        const f = await r.json();
        gone = f.trashed === true || !(f.parents || []).some((p) => folders.has(p));
      }
    } catch (e) {}
    if (!gone) {
      delete stillMissing[copy.id];
      continue;
    }
    delete stillMissing[copy.id];
    // Off this device, and (by the tombstone) off every other one.
    await noteDrive(sid, null);
    const here = (await listBooks()).filter((b) => b.syncId === sid);
    for (const b of here) await removeBook(b.id);
    if (!here.length) await removeEverywhere(sid);
    changes++;
  }
  try {
    localStorage.setItem(CHECKED_KEY, String(Date.now()));
    localStorage.setItem(MISSING_KEY, JSON.stringify(stillMissing));
  } catch (e) {}
  return changes;
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
  const kind = fileKind(meta.format, meta.fileName);
  const name = meta.fileName || `${meta.title || 'Book'}.${kind.ext}`;
  const file = new File([blob], name, { type: kind.type });
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
  trash(copy.id)
    .then(() => noteDrive(sid, null))
    .catch(() => {});
});

/** Turn "Library in Google Drive" on: Google asks for access (once per account). */
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
