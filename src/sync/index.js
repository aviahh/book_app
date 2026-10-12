// Sync, as the rest of the app sees it: start it, sign in and out, and hear
// how it's doing. Without an account nothing here does anything; the app
// works the same, fully offline.
//
// When it syncs: shortly after the app opens, whenever it comes back to the
// screen or back online, a few seconds after a change, and every couple of
// minutes while it's on screen. It never waits for the network to let you
// read: everything is saved on the device first.

import { account, setAccount, forgetAccount, syncNow, watchLocal, deviceName, post, onRemoteBook, accountSummary } from './engine.js';
import { listBooks, removeBook } from '../db.js';
import { keepBooksInDrive, syncFolder } from './drive.js';
import { forgetFamily } from './family.js';

const listeners = new Set();
let state = { busy: false };
let timer = 0;
let poll = 0;
let pendingCode = null;
let started = false;

const AFTER_CHANGE = 4000;
const EVERY = 2 * 60 * 1000;

function emit() {
  for (const fn of listeners) {
    try {
      fn(status());
    } catch (e) {
      console.error(e);
    }
  }
}

/** { signedIn, email, lastSync, error, busy, signingIn } */
export function status() {
  const a = account();
  return {
    signedIn: !!(a && a.token),
    expired: !!(a && !a.token && a.error === 'signed-out'),
    email: (a && a.email) || '',
    lastSync: (a && a.lastSync) || 0,
    error: (a && a.error) || null,
    busy: state.busy,
    signingIn: !!pendingCode,
    joining: joining ? { here: joining.here, account: joining.account, email: joining.email } : null,
    drive: !!(a && a.token && a.drive),
  };
}

export function onSyncStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Sync now (or soon after the one running). */
export async function runSync() {
  const a = account();
  if (!a || !a.token) return;
  if (navigator.onLine === false) return;
  state.busy = true;
  emit();
  try {
    await syncNow();
  } finally {
    state.busy = false;
    emit();
  }
  // Books not in Drive yet go up in the background (when that's on).
  // The Drive folder first (books put there or taken out by any means); then books only on this device go up.
  syncFolder()
    .catch((e) => console.warn(e))
    .then((n) => (n ? syncNow() : null))
    .then(() => keepBooksInDrive())
    .then(emit);
}

function soon(ms = AFTER_CHANGE) {
  clearTimeout(timer);
  timer = setTimeout(runSync, ms);
}

function startPolling() {
  clearInterval(poll);
  poll = setInterval(() => document.visibilityState === 'visible' && runSync(), EVERY);
}

/** Called once at startup, before the router draws the first screen. */
export function startSync() {
  if (started) return;
  started = true;
  // Back from Google: take the one-time code out of the address (it is used once, here).
  const m = /[?&]signin=([\w-]+)/.exec(location.hash);
  const err = /[?&]signin_error=(\w+)/.exec(location.hash);
  const drive = /[?&]drive(_error)?=(\w+)/.exec(location.hash);
  if (drive) state.driveNote = drive[1] ? drive[2] : 'on';
  if (m || err || drive) {
    try {
      history.replaceState(history.state, '', '#/settings');
    } catch (e) {}
  }
  if (err) state.signinError = err[1];
  watchLocal(() => soon());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') soon(300);
    else if (status().signedIn) runSync(); // send what's waiting before the app is put away
  });
  window.addEventListener('online', () => soon(500));
  startPolling();
  if (m) {
    pendingCode = m[1];
    redeem('auth/redeem', { code: pendingCode }).catch(() => {
      state.signinError = 'expired';
      pendingCode = null;
      emit();
    });
  } else if (status().signedIn) {
    soon(drive ? 200 : 1500);
  }
}

/** What happened when coming back from allowing Drive ('on', 'cancelled', 'account', 'denied'), once. */
export function takeDriveNote() {
  const n = state.driveNote;
  state.driveNote = null;
  return n || null;
}

/** The last sign-in problem (shown once in Settings), then forgotten. */
export function takeSigninError() {
  const e = state.signinError;
  state.signinError = null;
  return e || null;
}

let joining = null; // signed in, waiting for "combine or use the account's library"

async function redeem(path, body) {
  const res = await post(path, Object.assign({ name: deviceName() }, body));
  pendingCode = null;
  // This device already has books, and so does the account: ask how to join before changing anything.
  const here = (await listBooks()).filter((b) => !b.cloud);
  if (here.length && !(account() && account().email === res.email)) {
    let summary = { books: [] };
    try {
      summary = await accountSummary(res.token);
    } catch (e) {}
    if (summary.books.length) {
      joining = { token: res.token, email: res.email, here: here.length, account: summary.books.length, accountBooks: new Set(summary.books) };
      emit();
      return res;
    }
  }
  await setAccount(res.token, res.email);
  emit();
  await runSync();
  return res;
}

/**
 * How this device joins an account that already has books:
 *   'combine'  everything from both (the newer place in each book wins)
 *   'account'  the account's library and places; books only on this device leave it (nothing in Drive is touched)
 *   'cancel'   don't sign in after all
 */
export async function finishJoining(choice) {
  const j = joining;
  if (!j) return;
  joining = null;
  if (choice === 'cancel') {
    try {
      await post('auth/signout', {}, j.token);
    } catch (e) {}
    emit();
    return;
  }
  if (choice === 'account') {
    const { contentId } = await import('./items.js');
    const { getBookFile } = await import('../db.js');
    for (const b of await listBooks()) {
      let sid = b.syncId;
      if (!sid) {
        try {
          sid = await contentId(await getBookFile(b.id));
        } catch (e) {}
      }
      if (!sid || !j.accountBooks.has(sid)) await removeBook(b.id, 'download');
    }
  }
  await setAccount(j.token, j.email, { preferAccount: choice === 'account' });
  emit();
  await runSync();
}

/** Go to Google to sign in (the page comes back to Settings). */
export function signInWithGoogle() {
  location.href = new URL(`api/auth/google/start?name=${encodeURIComponent(deviceName())}`, document.baseURI).href;
}

/** Link this device with a code shown on another one. */
export function linkWithCode(code) {
  return redeem('pair/redeem', { code });
}

/** A code to type on another device (valid for 10 minutes). */
export async function makeLinkCode() {
  const a = account();
  return post('pair/create', {}, a && a.token);
}

/** Sign out on this device: it stops syncing; nothing here is deleted. */
export async function signOut() {
  const a = account();
  if (a && a.token) {
    // Send anything still waiting first, then end this device's session.
    try {
      await syncNow();
    } catch (e) {}
    try {
      await post('auth/signout', {}, a.token);
    } catch (e) {}
  }
  await forgetAccount();
  forgetFamily();
  emit();
}

export { onRemoteBook };
