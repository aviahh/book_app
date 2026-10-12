// Account: who you're signed in as, where your library is kept, your
// devices, a copy of your data, and deleting the account.

import { shell, esc, toast } from './common.js';
import { status, signOut } from '../sync/index.js';
import { accountInfo, signOutDevice, accountData, confirmIdentity, deleteAccount } from '../sync/account.js';
import { connectDrive, disconnectDrive } from '../sync/drive.js';
import { deliver } from './settings.js';
import '../sync/sync.css';

const PROVIDERS = { google: 'Google', apple: 'Apple', email: 'Email code', dev: 'Test sign-in' };
const STORAGE = { gdrive: 'Google Drive' };

const CONFIRM_ERRORS = {
  cancelled: 'Confirming was cancelled. Your account is unchanged.',
  account: 'That was a different Google account. Confirm with the one you sign in to Folio with.',
  google: 'Google didn’t confirm it. Please try again.',
  expired: 'That took too long. Please try again.',
};

let confirmed = null; // { code, until } after confirming it's you, for the final step

function ago(t) {
  if (!t) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 3600) return 'in the last hour';
  const h = Math.round(s / 3600);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return day(t);
}
const day = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

const row = (title, desc, control = '', cls = '') =>
  `<div class="set-row${cls}"><div class="set-text"><span class="set-title">${title}</span><span class="set-desc"${desc ? '' : ' hidden'}>${desc}</span></div>${control}</div>`;

export async function mountAccount(view, _p, nav) {
  const content = shell(view, 'settings');
  // Back from confirming with Google: take the one-time code out of the address.
  const m = /[?&]confirm=([\w-]+)/.exec(location.hash);
  const err = /[?&]confirm_error=(\w+)/.exec(location.hash);
  if (m) confirmed = { code: m[1], until: Date.now() + 9 * 60 * 1000 };
  if (m || err) {
    try {
      history.replaceState(history.state, '', '#/account');
    } catch (e) {}
  }
  let note = err ? CONFIRM_ERRORS[err[1]] || CONFIRM_ERRORS.google : '';
  let info = null;
  let failed = '';
  let deleting = false; // the first step of deleting is open

  function draw() {
    const st = status();
    let html = '<section class="settings account"><h1>Account</h1>';
    if (!st.signedIn) {
      html += `<p class="acct-lead">${esc(note || 'You’re not signed in on this device.')}</p>
        <div class="set-group">${row('Sign in', 'Sign in from Settings › Sync to keep your devices in step.', '<a class="btn subtle" href="#/settings">Settings</a>')}</div></section>`;
      content.innerHTML = html;
      return;
    }
    if (!info) {
      html += `<div class="set-group">${row(esc(st.email), esc(failed || 'Loading your account…'), failed ? '<button class="btn subtle" data-acct="retry">Try again</button>' : '<span class="sync-spin" aria-hidden="true"></span>')}</div></section>`;
      content.innerHTML = html;
      return;
    }

    // Who you are
    html += '<h2>Signed in</h2><div class="set-group">';
    const ids = info.signIns.length ? info.signIns : [{ provider: 'google', email: info.email }];
    for (const s of ids) html += row(esc(s.email || info.email), `With ${esc(PROVIDERS[s.provider] || s.provider)}${info.created ? ` · account since ${esc(day(info.created))}` : ''}`);
    html += '</div>';

    // Where the books are
    html += '<h2>Library storage</h2><div class="set-group">';
    if (info.storage) {
      const who = info.storage.account ? `${esc(info.storage.account)} · ` : '';
      html += row(esc(STORAGE[info.storage.provider] || info.storage.provider), `${who}your library is the “Folio” folder there.`, '<button class="btn subtle" data-acct="drive-off">Disconnect</button>');
    } else {
      html += row('Not connected', 'Keep your library in a “Folio” folder in your own Google Drive, so every device has your books.', '<button class="btn subtle" data-acct="drive-on">Connect Google Drive</button>');
    }
    html += '</div>';

    // Devices
    html += '<h2>Devices</h2><div class="set-group">';
    for (const d of info.devices) {
      const desc = d.current ? 'This device' : `Last used ${esc(ago(d.lastSeen))}`;
      html += row(esc(d.name), `${desc} · signed in ${esc(day(d.created))}`, `<button class="btn subtle" data-acct="device" data-id="${esc(d.id)}" data-current="${d.current ? 1 : ''}">Sign out</button>`);
    }
    html += '</div><p class="acct-foot">A device that isn’t used for 6 months is signed out by itself.</p>';

    // Your data
    html += '<h2>Your data</h2><div class="set-group">';
    html += row('Download my data', 'Everything Folio keeps for your account, as one file: your place in each book, bookmarks and notes, series, settings, reading time and devices.', '<button class="btn subtle" data-acct="export">Download</button>');
    if (confirmed && confirmed.until > Date.now()) {
      html += `<div class="sync-join acct-delete">
          <p class="sj-title">Delete your Folio account?</p>
          <p class="sj-desc">This removes your account, your places and bookmarks, settings, reading time, devices and family sharing from Folio, for good, on every device. Folio’s access to your Google Drive is withdrawn.<br>Your books themselves stay: the files in your Drive’s “Folio” folder, and the books already on your devices.</p>
          <button class="rm-choice danger" data-acct="delete-now"><b>Delete my account</b><span>This can’t be undone.</span></button>
          <button class="btn subtle" data-acct="keep">Keep my account</button>
        </div>`;
    } else if (deleting) {
      html += `<div class="sync-join acct-delete">
          <p class="sj-title">First, confirm it’s you</p>
          <p class="sj-desc">To keep your account safe, deleting it needs a fresh sign-in with Google. After that you’ll see exactly what is deleted, and decide.</p>
          <button class="rm-choice" data-acct="confirm"><b>Confirm with Google</b><span>${esc(info.email)}</span></button>
          <button class="btn subtle" data-acct="keep">Cancel</button>
        </div>`;
    } else {
      html += row('Delete account', esc(note || 'Remove your account and everything Folio keeps for it. Your book files stay yours.'), '<button class="btn subtle acct-danger" data-acct="delete">Delete…</button>');
    }
    html += '</div>';
    html += `<div class="acct-out"><button class="btn subtle" data-acct="out">Sign out on this device</button></div></section>`;
    content.innerHTML = html;
  }

  async function load() {
    failed = '';
    try {
      info = await accountInfo();
    } catch (e) {
      info = null;
      failed = navigator.onLine === false ? 'You’re offline. Connect to the internet to see your account.' : 'Couldn’t reach Folio. Please try again.';
      if (!status().signedIn) failed = '';
    }
    if (content.isConnected) draw();
  }

  content.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-acct]');
    if (!b) return;
    const act = b.dataset.acct;
    if (act === 'retry') return draw(), load();
    if (act === 'keep') {
      confirmed = null;
      deleting = false;
      note = '';
      return draw();
    }
    if (act === 'delete') {
      deleting = true;
      return draw();
    }
    if (act !== 'out' && navigator.onLine === false) return toast(view, 'You’re offline. Connect to the internet first.', 4000);
    b.disabled = true;
    try {
      if (act === 'confirm') return await confirmIdentity();
      if (act === 'delete-now') {
        const code = confirmed && confirmed.code;
        confirmed = null;
        await deleteAccount(code);
        return nav('#/settings');
      }
      if (act === 'export') {
        const blob = await accountData();
        b.disabled = false;
        return deliver({ blob, name: `folio-account-data-${new Date().toISOString().slice(0, 10)}.json` }, view);
      }
      if (act === 'drive-on') return await connectDrive();
      if (act === 'drive-off') {
        if (!confirm('Disconnect Google Drive? The books stay in your Drive’s Folio folder; devices keep the ones they have downloaded.')) return (b.disabled = false);
        await disconnectDrive();
        return load();
      }
      if (act === 'device') {
        const current = !!b.dataset.current;
        const msg = current
          ? 'Sign out on this device? Your books and progress stay here; this device just stops syncing.'
          : 'Sign this device out? It stops syncing until someone signs in on it again. Its books stay on it.';
        if (!confirm(msg)) return (b.disabled = false);
        if (current) {
          await signOut();
          return nav('#/settings');
        }
        await signOutDevice(b.dataset.id);
        return load();
      }
      if (act === 'out') {
        if (!confirm('Sign out on this device? Your books and progress stay here; this device just stops syncing.')) return (b.disabled = false);
        await signOut();
        return nav('#/settings');
      }
    } catch (err) {
      b.disabled = false;
      if (act === 'delete-now') {
        note = String(err.message || 'Couldn’t delete the account. Please try again.');
        deleting = false;
        return draw();
      }
      toast(view, String(err.message || 'Something went wrong. Please try again.'), 4000);
    }
  });

  draw();
  if (status().signedIn) load();
}
