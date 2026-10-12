// The sync engine: notices changes here, sends them, takes in changes from
// other devices, and decides who wins.
//
// Everything is saved on the device first; sync only ever follows. Each
// item carries the time it was changed (this device's clock, corrected to
// the server's), and the newer change wins, item by item. While offline,
// changes wait (only the latest per item) and go out on the next sync.

import { listBooks, getBook, getBookFile, updateBook, removeBook, onBooksChange } from '../db.js';
import { getSettings, setSetting, onSettingsChange, DEFAULTS } from '../settings.js';
import { loadItems, saveItems, clearItems } from './store.js';
import { contentId, bookItems, sameValue, parseKey, patchFor, coverThumb } from './items.js';

const ACCOUNT_KEY = 'folio.sync.v1';
const DEVICE_KEY = 'folio.device.v1';
const STATS_KEY = 'folio.stats.v1';
const OTHERS_KEY = 'folio.stats.others.v1';
const KNOWN_KEY = 'folio.sync.books.v1'; // local book id → content id, for books sync has looked at here

const readJson = (key, dflt) => {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') || dflt;
  } catch (e) {
    return dflt;
  }
};
const writeJson = (key, v) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch (e) {}
};

/** This device's id (kept even when signing out) and a friendly name. */
export function deviceId() {
  let id = '';
  try {
    id = localStorage.getItem(DEVICE_KEY) || '';
  } catch (e) {}
  if (!/^[\w-]{8,40}$/.test(id)) {
    const r = crypto.getRandomValues(new Uint8Array(9));
    id = Array.prototype.map.call(r, (b) => ('0' + b.toString(16)).slice(-2)).join('');
    try {
      localStorage.setItem(DEVICE_KEY, id);
    } catch (e) {}
  }
  return id;
}

export function deviceName() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Windows/.test(ua)) return 'Windows computer';
  if (/Mac/.test(ua)) return 'Mac';
  if (/CrOS/.test(ua)) return 'Chromebook';
  return 'Device';
}

export const account = () => readJson(ACCOUNT_KEY, null);
const saveAccount = (a) => writeJson(ACCOUNT_KEY, a);

const api = (path) => new URL('api/' + path, document.baseURI).href;

class SignedOut extends Error {}

async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(api(path), { method: 'POST', headers, body: JSON.stringify(body || {}), cache: 'no-store' });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {}
  if (res.status === 401) throw new SignedOut('signed-out');
  if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
  return data;
}

// ---------------------------------------------------------------- state

let items = null; // Map k → { k, v, t, d, dirty }
let known = null; // { local id: content id } of books already looked at on this device
let applying = 0; // > 0 while writing changes that came from the server
let changed = () => {}; // asks for a sync soon (set by start())
const remoteListeners = new Set();

/** The current time on the server's clock, never repeating per item. */
function clock(prev) {
  const a = account();
  const now = Date.now() + ((a && a.offset) || 0);
  return Math.max(now, (prev || 0) + 1);
}

async function ready() {
  if (!items) items = await loadItems();
  if (!known) known = readJson(KNOWN_KEY, {});
  return items;
}

function remember(id, sid) {
  if (sid ? known[id] === sid : !(id in known)) return;
  if (sid) known[id] = sid;
  else delete known[id];
  writeJson(KNOWN_KEY, known);
}

/** Record a value for an item. `t` given = a seed time (first sight); otherwise now. Returns the record if it changed. */
function note(k, v, { d = 0, t } = {}) {
  const cur = items.get(k);
  if (cur) {
    if (d ? cur.d : !cur.d && sameValue(k, cur.v, v)) {
      // Same as known: just keep the latest details (lastOpenedAt) without sending.
      if (!d && /:prog$/.test(k) && cur.v && v && v.lastOpenedAt > (cur.v.lastOpenedAt || 0)) cur.v = Object.assign({}, cur.v, { lastOpenedAt: v.lastOpenedAt });
      return null;
    }
  }
  const rec = { k, v: d ? null : v, t: t != null && !cur ? t : clock(cur && cur.t), d: d ? 1 : 0, dirty: true };
  items.set(k, rec);
  return rec;
}

/** The book's content id, worked out once (from the file) and kept on the book. */
async function syncIdFor(book) {
  if (book.syncId) return book.syncId;
  const sid = await contentId(await getBookFile(book.id));
  if (!sid) return null;
  book.syncId = sid;
  applying++;
  try {
    await updateBook(book.id, { syncId: sid }, 'sync');
  } finally {
    applying--;
  }
  return sid;
}

/**
 * Look at one local book and record what changed. `seeded` uses the times
 * the book itself records for items this device has never synced (first
 * sign-in, a newly added book); otherwise changes count as made now.
 */
async function scanBook(book, { seeded = false, added = false } = {}) {
  const sid = await syncIdFor(book);
  if (!sid) return [];
  // A book this device hasn't looked at before (added while signed out):
  // what it records is as old as it says, not new.
  if (!known[book.id]) seeded = true;
  remember(book.id, sid);
  const out = [];
  const seen = new Set();
  const remote = {}; // newer server values to bring into this book
  for (const it of bookItems(book)) {
    seen.add(it.k);
    const cur = items.get(it.k);
    if (added && /:meta$/.test(it.k)) {
      // Adding a book is a real change now (it brings back a book removed elsewhere).
      const r = note(it.k, it.v, cur && cur.d ? {} : { t: it.seed });
      if (r) out.push(r);
      continue;
    }
    if (cur && !cur.dirty && (seeded || added) && !sameValue(it.k, cur.v, it.v) && (cur.t >= it.seed || preferAccount())) {
      // The server knows something newer than what this copy of the book recorded.
      remote[it.k] = cur;
      continue;
    }
    const r = note(it.k, it.v, seeded || added ? { t: it.seed } : {});
    if (r) out.push(r);
  }
  // A small cover, for devices that don't have the book (yet).
  const ck = `b:${sid}:cover`;
  if (book.cover && !items.has(ck)) {
    const thumb = await coverThumb(book.cover);
    if (thumb) out.push(note(ck, thumb, { t: book.addedAt || 0 }));
  }
  // Items that are gone from the book (bookmark removed, mark cleared …).
  const prefix = `b:${sid}:`;
  for (const cur of items.values()) {
    if (cur.k.indexOf(prefix) !== 0 || seen.has(cur.k) || cur.d || /:(meta|cover|drive)$/.test(cur.k)) continue;
    if ((seeded || added) && !cur.dirty) {
      remote[cur.k] = cur; // known on the server, not here yet: bring it in
      continue;
    }
    const r = note(cur.k, null, { d: 1 });
    if (r) out.push(r);
  }
  const keys = Object.keys(remote);
  if (keys.length) await applyToBook(book, keys.map((k) => remote[k]));
  return out;
}

function scanSettings({ seeded = false } = {}) {
  const s = getSettings();
  const out = [];
  for (const key of Object.keys(DEFAULTS)) {
    const r = note(`s:${key}`, s[key], seeded ? { t: 0 } : {});
    if (r) out.push(r);
  }
  return out;
}

function scanStats() {
  const own = readJson(STATS_KEY, {});
  const dev = deviceId();
  const out = [];
  const cutoff = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  for (const day of Object.keys(own)) {
    if (day < cutoff || !(own[day] > 0)) continue;
    const r = note(`st:${dev}:${day}`, Math.round(own[day]));
    if (r) out.push(r);
  }
  return out;
}

/** Other devices' reading time, per day, for the Home screen. */
function writeOthers() {
  const dev = deviceId();
  const sum = {};
  for (const it of items.values()) {
    const p = parseKey(it.k);
    if (p.kind !== 'stats' || p.dev === dev || it.d) continue;
    sum[p.day] = (sum[p.day] || 0) + (+it.v || 0);
  }
  writeJson(OTHERS_KEY, sum);
}

// ---------------------------------------------------------------- applying server changes

async function applyToBook(book, list) {
  let patch = {};
  let pos = null;
  for (const it of list) {
    const p = patchFor(book, it, items);
    if (!p) continue;
    if (p.syncPos) pos = Object.assign(pos || {}, p.syncPos);
    delete p.syncPos;
    Object.assign(patch, p);
  }
  if (pos) {
    // Kept for the pages that still have a place, bookmark or mark on them.
    const all = Object.assign({}, book.syncPos, pos);
    const used = new Set([patch.lastPage || book.lastPage, patch.readingPos || book.readingPos]);
    for (const b of patch.bookmarks || book.bookmarks || []) used.add(b.page);
    const stop = 'stopMark' in patch ? patch.stopMark : book.stopMark;
    if (stop) used.add(stop.page);
    patch.syncPos = {};
    for (const n of Object.keys(all)) if (used.has(+n)) patch.syncPos[n] = all[n];
  }
  if (!Object.keys(patch).length) return;
  applying++;
  try {
    await updateBook(book.id, patch, 'sync');
  } finally {
    applying--;
  }
  Object.assign(book, patch);
  const prog = list.find((it) => /:prog$/.test(it.k));
  for (const fn of remoteListeners) {
    try {
      fn(book.id, patch, { from: prog && prog.v && prog.v.from });
    } catch (e) {
      console.error(e);
    }
  }
}

/** Take in changes from the server: newer than what we have wins. */
async function applyIncoming(list) {
  const books = await listBooks();
  const bySid = new Map();
  for (const b of books) if (b.syncId) (bySid.get(b.syncId) || bySid.set(b.syncId, []).get(b.syncId)).push(b);
  const toSave = [];
  const perBook = new Map(); // sid → items to apply
  let settingsTouched = false;
  let statsTouched = false;
  for (const inc of list) {
    const cur = items.get(inc.k);
    const p = parseKey(inc.k);
    // Never seen here: compare with what this device itself recorded, if anything.
    let localT = cur ? cur.t : -1;
    if (!cur && p.kind === 'book') {
      const local = (bySid.get(p.sid) || [])[0];
      const mine = local && bookItems(local).find((x) => x.k === inc.k);
      if (mine) localT = mine.seed;
    }
    if (!cur && p.kind === 'setting') localT = 0;
    if (inc.t < localT || (inc.t === localT && cur && cur.dirty)) continue;
    if (cur && cur.t === inc.t && !!cur.d === !!inc.d && sameValue(inc.k, cur.v, inc.v)) continue;
    const rec = { k: inc.k, v: inc.d ? null : inc.v, t: inc.t, d: inc.d ? 1 : 0, dirty: false };
    items.set(inc.k, rec);
    toSave.push(rec);
    if (p.kind === 'setting') {
      if (!inc.d && p.key in DEFAULTS && getSettings()[p.key] !== inc.v) {
        applying++;
        try {
          setSetting(p.key, inc.v);
        } finally {
          applying--;
        }
        settingsTouched = true;
      }
    } else if (p.kind === 'stats') {
      statsTouched = true;
    } else if (p.kind === 'book') {
      if (!perBook.has(p.sid)) perBook.set(p.sid, []);
      perBook.get(p.sid).push(rec);
    }
  }
  await saveItems(toSave);
  for (const [sid, recs] of perBook) {
    for (const book of bySid.get(sid) || []) {
      const meta = recs.find((r) => /:meta$/.test(r.k));
      if (meta && meta.d) {
        // Removed from the library on another device.
        applying++;
        try {
          await removeBook(book.id, 'sync');
        } finally {
          applying--;
        }
        remember(book.id, null);
        continue;
      }
      await applyToBook(book, recs.filter((r) => !/:meta$/.test(r.k)));
    }
  }
  if (statsTouched) writeOthers();
  return { settingsTouched, applied: toSave.length };
}

// ---------------------------------------------------------------- local changes

async function onLocalBook(e) {
  if (applying || e.source === 'sync' || !account()) return;
  await ready();
  if (e.type === 'remove') {
    const sid = known[e.id];
    remember(e.id, null);
    // "Remove download" only takes the file off this device; the book stays in the library.
    if (e.source === 'download' || !sid || Object.keys(known).some((id) => known[id] === sid)) return;
    return removeEverywhere(sid);
  }
  const book = await getBook(e.id);
  if (!book) return;
  const recs = await scanBook(book, { added: e.type === 'add' });
  await saveItems(recs);
  if (recs.length) changed();
}

const removedListeners = new Set();

/** Remove a book from the library on every device (a tombstone; its progress stays known). */
export async function removeEverywhere(sid) {
  await ready();
  const r = note(`b:${sid}:meta`, null, { d: 1 });
  if (r) await saveItems([r]);
  const drive = items.get(`b:${sid}:drive`);
  for (const fn of removedListeners) {
    try {
      fn(sid, drive && !drive.d ? drive.v : null);
    } catch (e) {
      console.error(e);
    }
  }
  changed();
}

/** Hear books removed from the library here (fn(sid, driveCopy)), e.g. to move the Drive copy to the trash. */
export function onRemovedEverywhere(fn) {
  removedListeners.add(fn);
  return () => removedListeners.delete(fn);
}

/** Record where a book's copy is in Drive (or that it's gone: null). */
export async function noteDrive(sid, v) {
  await ready();
  const r = v ? note(`b:${sid}:drive`, v) : note(`b:${sid}:drive`, null, { d: 1 });
  if (r) {
    await saveItems([r]);
    changed();
  }
}

/** Record an account-wide value (e.g. which Drive folder is the library) and send it. */
export async function noteValue(k, v) {
  await ready();
  const r = note(k, v);
  if (r) {
    await saveItems([r]);
    changed();
  }
}

/** One item as sync knows it ({ k, v, t, d }), or null. */
export async function itemOf(k) {
  await ready();
  return items.get(k) || null;
}

/**
 * A book file found in the Drive library folder: it is in the library
 * (again, if it had been removed and is back), and this is its file.
 */
export async function noteFolderBook(sid, meta, copy) {
  await ready();
  const out = [];
  const m = items.get(`b:${sid}:meta`);
  if (!m || m.d) out.push(note(`b:${sid}:meta`, meta));
  const r = note(`b:${sid}:drive`, copy);
  if (r) out.push(r);
  const recs = out.filter(Boolean);
  if (recs.length) {
    await saveItems(recs);
    changed();
  }
}

/** Every book the account has a copy of in Drive: [{ sid, copy: { id, size } }]. */
export async function driveCopies() {
  await ready();
  const out = [];
  for (const it of items.values()) {
    const m = /^b:([0-9a-f]+):drive$/.exec(it.k);
    if (m && !it.d && it.v && it.v.id) out.push({ sid: m[1], copy: it.v });
  }
  return out;
}

export async function driveCopy(sid) {
  await ready();
  const it = items.get(`b:${sid}:drive`);
  return it && !it.d ? it.v : null;
}

/**
 * Books in the library that aren't on this device but have a copy in Drive:
 * [{ sid, meta, prog, series, cover, drive }].
 */
export async function cloudBooks() {
  await ready();
  const here = new Set((await listBooks()).map((b) => b.syncId).filter(Boolean));
  const by = new Map();
  for (const it of items.values()) {
    const p = parseKey(it.k);
    if (p.kind !== 'book' || p.field === 'bm' || it.d || here.has(p.sid)) continue;
    if (!by.has(p.sid)) by.set(p.sid, { sid: p.sid });
    by.get(p.sid)[p.field] = it.v;
  }
  return [...by.values()].filter((x) => x.meta && x.drive);
}

async function onLocalSetting(s, key) {
  if (applying || !account() || !(key in DEFAULTS)) return;
  await ready();
  const r = note(`s:${key}`, s[key]);
  if (r) {
    await saveItems([r]);
    changed();
  }
}

// ---------------------------------------------------------------- sync

let running = null;

/**
 * One sync: look over everything, send what changed, take in what's new.
 * Resolves with { ok, error? }. Calls made while one runs share it.
 */
export function syncNow() {
  if (!running) {
    running = doSync().finally(() => {
      running = null;
    });
  }
  return running;
}

async function doSync() {
  const a = account();
  if (!a || !a.token) return { ok: false, error: 'signed-out' };
  await ready();
  const first = !a.since;
  const dev = deviceId();
  try {
    if (first) {
      // First sync on this device: hear what the account already has before
      // offering anything, so older data here doesn't overrule it.
      await exchange(a, [], dev);
    }
    const books = await listBooks();
    let recs = [];
    for (const b of books) recs = recs.concat(await scanBook(b, { seeded: first }));
    recs = recs.concat(scanSettings({ seeded: first }), scanStats());
    await saveItems(recs);
    const dirty = [...items.values()].filter((it) => it.dirty);
    for (let i = 0; i < dirty.length || i === 0; i += 400) {
      await exchange(account(), dirty.slice(i, i + 400), dev);
    }
    const b = account();
    if (b) saveAccount(Object.assign(b, { lastSync: Date.now(), error: null }));
    return { ok: true };
  } catch (e) {
    if (e instanceof SignedOut) {
      // This device was signed out elsewhere (or the account is gone): stay quiet, keep everything here.
      const b = account();
      if (b) saveAccount(Object.assign(b, { token: null, error: 'signed-out' }));
      return { ok: false, error: 'signed-out' };
    }
    const b = account();
    if (b) saveAccount(Object.assign(b, { error: navigator.onLine === false ? 'offline' : String(e.message || e) }));
    return { ok: false, error: String(e.message || e) };
  }
}

/** Send some changes and take in everything new (in parts, if there is a lot). */
async function exchange(a, dirty, dev) {
  let since = a.since || 0;
  let send = dirty;
  const name = deviceName();
  for (let round = 0; round < 50; round++) {
    const changes = send.map((it) => {
      const c = { k: it.k, t: it.t };
      if (it.d) c.d = 1;
      else c.v = /:prog$/.test(it.k) ? Object.assign({}, it.v, { from: name }) : it.v;
      return c;
    });
    const t0 = Date.now();
    const res = await post('sync', { since, dev, changes }, a.token);
    const t1 = Date.now();
    const offset = Math.round(res.now - (t0 + t1) / 2);
    // Accepted: no longer waiting (unless it changed again meanwhile).
    const done = [];
    for (const c of changes) {
      const it = items.get(c.k);
      if (it && it.t === c.t && it.dirty) {
        it.dirty = false;
        done.push(it);
      }
    }
    await saveItems(done);
    await applyIncoming(res.changes || []);
    since = res.rev;
    const cur = account();
    if (!cur || cur.token !== a.token) return; // signed out meanwhile
    saveAccount(Object.assign(cur, { since, offset, email: res.email || cur.email, drive: !!res.drive }));
    if (!res.more) return;
    send = [];
  }
}

// ---------------------------------------------------------------- account

/** Signed in: remember the account; everything here will be offered on the first sync. */
/** Signing in chose "use the account's library": on the first sync, what the account knows wins over this device. */
const preferAccount = () => {
  const a = account();
  return !!(a && a.preferAccount && !a.lastSync);
};

/**
 * What the account already holds, without taking any of it in yet (to ask
 * how a device that already has books should join): { books: [sid] }.
 */
export async function accountSummary(token) {
  const sids = new Set();
  let since = 0;
  for (let round = 0; round < 20; round++) {
    const res = await post('sync', { since, dev: deviceId(), changes: [] }, token);
    for (const c of res.changes || []) {
      const m = /^b:([0-9a-f]+):meta$/.exec(c.k);
      if (m) c.d ? sids.delete(m[1]) : sids.add(m[1]);
    }
    since = res.rev;
    if (!res.more) break;
  }
  return { books: [...sids] };
}

export async function setAccount(token, email, { preferAccount: prefer = false } = {}) {
  const prev = account();
  await ready();
  if (!prev || prev.email !== email) {
    // A different account (or none before): start from a clean slate.
    await clearItems();
    items = new Map();
    known = {};
    try {
      localStorage.removeItem(KNOWN_KEY);
    } catch (e) {}
  }
  saveAccount({ token, email, since: 0, offset: (prev && prev.offset) || 0, lastSync: 0, error: null, preferAccount: !!prefer });
}

/** Forget the account on this device. The library and progress here stay as they are. */
export async function forgetAccount() {
  try {
    localStorage.removeItem(ACCOUNT_KEY);
    localStorage.removeItem(OTHERS_KEY);
    localStorage.removeItem(KNOWN_KEY);
  } catch (e) {}
  await clearItems();
  items = new Map();
  known = {};
}

/** Hear changes that arrived for books from other devices: fn(localId, patch, { from }). */
export function onRemoteBook(fn) {
  remoteListeners.add(fn);
  return () => remoteListeners.delete(fn);
}

/** Start listening for local changes. `soon` is called when something should be synced. */
export function watchLocal(soon) {
  changed = soon;
  onBooksChange((e) => onLocalBook(e).catch((err) => console.error(err)));
  onSettingsChange((s, key) => onLocalSetting(s, key).catch((err) => console.error(err)));
}

export { post, SignedOut };
