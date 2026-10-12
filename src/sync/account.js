// The account itself: what it holds (sign-ins, devices, storage), signing
// other devices out, a copy of the data, and deleting it all.

import { account, post, forgetAccount } from './engine.js';
import { forgetFamily } from './family.js';

const token = () => {
  const a = account();
  return a && a.token;
};

/** { email, created, signIns: [...], devices: [{ id, name, lastSeen, current }], storage } */
export function accountInfo() {
  return post('account', {}, token());
}

/** Sign one of the account's devices out. Returns true if that was this one. */
export async function signOutDevice(id) {
  const r = await post('account/device/remove', { id }, token());
  if (r.self) {
    await forgetAccount();
    forgetFamily();
  }
  return !!r.self;
}

/** Everything the server keeps for the account, as a file (Blob). */
export async function accountData() {
  const data = await post('account/export', {}, token());
  return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
}

/** Deleting starts with confirming it's you: to Google and back (to #/account?confirm=…). */
export async function confirmIdentity() {
  const r = await post('account/confirm', {}, token());
  location.href = new URL(r.url, document.baseURI).href; // (local testing: straight back to the Account screen)
}

/** Delete the account (with the code from confirming). This device then forgets it; its books stay. */
export async function deleteAccount(code) {
  await post('account/delete', { code }, token());
  await forgetAccount();
  forgetFamily();
}
