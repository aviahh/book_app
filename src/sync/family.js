// Family libraries: read the books someone shared from their Google Drive.
// Their files come through the app's own server, streamed from their Drive;
// nothing is copied to your Drive, and your progress is your own.

import { listBooks } from '../db.js';
import { importFile } from '../pdf.js';
import { account, post } from './engine.js';

const SIDS_KEY = 'folio.family.sids.v1'; // books that came from a family library: never put into this account's Drive
const LIST_KEY = 'folio.family.v1'; // the last list, so the library can show it at once
let cache = null; // the last list: { libraries, members }
try {
  cache = JSON.parse(localStorage.getItem(LIST_KEY) || 'null');
} catch (e) {}

const token = () => {
  const a = account();
  return a && a.token;
};

function familySids() {
  try {
    return JSON.parse(localStorage.getItem(SIDS_KEY) || '[]');
  } catch (e) {
    return [];
  }
}
function markFamily(sid) {
  const s = familySids();
  if (s.indexOf(sid) < 0) s.push(sid);
  try {
    localStorage.setItem(SIDS_KEY, JSON.stringify(s));
  } catch (e) {}
}

/** Is this book from someone else's library (so it stays out of this account's Drive)? */
export const isFamilyBook = (sid) => familySids().indexOf(sid) >= 0;

/** { libraries: [{ owner, email, books: [{ sid, meta, cover, series, drive: { size } }] }], members: [{ id, email }] } */
export async function familyList(fresh) {
  if (!token()) return { libraries: [], members: [] };
  if (cache && !fresh) return cache;
  cache = await post('family/list', {}, token());
  for (const lib of cache.libraries) for (const b of lib.books) markFamily(b.sid);
  try {
    const text = JSON.stringify(cache);
    if (text.length < 1500000) localStorage.setItem(LIST_KEY, text); // covers included; skip if it would crowd storage
    else localStorage.removeItem(LIST_KEY);
  } catch (e) {}
  return cache;
}

/** The last list without asking the server (or null). */
export const familyCached = () => (token() ? cache : null);

/** Forget the lists (signing out). */
export function forgetFamily() {
  cache = null;
  try {
    localStorage.removeItem(LIST_KEY);
  } catch (e) {}
}

export const shareCode = () => post('family/invite', {}, token());
export const joinFamily = (code) => post('family/join', { code }, token()).then(() => familyList(true));
export const stopSharingWith = (member) => post('family/remove', { member }, token()).then(() => familyList(true));
export const leaveFamily = (owner) => post('family/remove', { owner }, token()).then(() => familyList(true));

export const ownerName = (email) => (email || 'Family').split('@')[0];

/** Download a book from a family library into this device's library. Returns the local book. */
export async function downloadFamilyBook(owner, book, onProgress = () => {}) {
  markFamily(book.sid);
  const blob = await new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('GET', new URL(`api/family/file?owner=${encodeURIComponent(owner)}&sid=${encodeURIComponent(book.sid)}`, document.baseURI).href);
    x.responseType = 'blob';
    x.setRequestHeader('Authorization', 'Bearer ' + token());
    const size = (book.drive && book.drive.size) || (book.meta && book.meta.size) || 0;
    x.onprogress = (e) => onProgress(e.lengthComputable ? e.loaded / e.total : size ? Math.min(0.99, e.loaded / size) : 0);
    x.onload = () => {
      if (x.status === 200) return resolve(x.response);
      const r = new FileReader();
      r.onload = () => {
        let msg = 'Download failed (' + x.status + ')';
        try {
          msg = JSON.parse(r.result).error || msg;
        } catch (e) {}
        reject(new Error(msg));
      };
      r.onerror = () => reject(new Error('Download failed (' + x.status + ')'));
      r.readAsText(x.response);
    };
    x.onerror = () => reject(new Error('Download failed. Check the connection.'));
    x.send();
  });
  const meta = book.meta || {};
  const name = meta.fileName || `${meta.title || 'Book'}.${meta.format === 'epub' ? 'epub' : 'pdf'}`;
  const file = new File([blob], name, { type: blob.type || (meta.format === 'epub' ? 'application/epub+zip' : 'application/pdf') });
  const ids = new Set((await listBooks()).map((b) => b.id));
  const added = await importFile(file, ids);
  return added || (await listBooks()).find((b) => b.syncId === book.sid || b.fileName === name) || null;
}
