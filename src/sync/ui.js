// The Sync section in Settings: one quiet group of rows.
import './sync.css';
import { status, onSyncStatus, runSync, signInWithGoogle, linkWithCode, makeLinkCode, signOut, takeSigninError, takeDriveNote } from './index.js';
import { connectDrive, disconnectDrive, driveSummary, onDriveProgress } from './drive.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

const ERRORS = {
  cancelled: 'Sign-in was cancelled.',
  expired: 'Sign-in took too long. Please try again.',
  google: 'Google didn’t confirm the sign-in. Please try again.',
};

const DRIVE_NOTES = {
  on: 'Google Drive is connected. Your books are being copied to the Folio folder.',
  cancelled: 'Google Drive wasn’t connected.',
  denied: 'Google Drive wasn’t connected: Folio needs permission to keep files in its folder.',
  account: 'Use the same Google account you’re signed in with.',
};
const DRIVE_DESC = 'Copies your books to a “Folio” folder in your own Google Drive, so every device can download them. Folio sees only the files it puts there.';

const row = (title, desc, control, cls = '') =>
  `<div class="set-row${cls}"><div class="set-text"><span class="set-title">${title}</span><span class="set-desc"${desc ? '' : ' hidden'}>${desc}</span></div>${control}</div>`;

/** Fill `group` (a .set-group) with the Sync rows and keep them current. Returns a cleanup function. */
export function mountSyncSettings(group) {
  let note = (() => {
    const e = takeSigninError();
    return e ? ERRORS[e] || ERRORS.expired : '';
  })();
  let entering = false; // typing a link code
  let shownCode = null; // { code, until } on a signed-in device
  let linkError = '';
  let driveNote = (() => {
    const n = takeDriveNote();
    return n ? DRIVE_NOTES[n] || DRIVE_NOTES.cancelled : '';
  })();

  function draw() {
    const st = status();
    let html = '';
    if (st.signingIn) {
      html = row('Signing in…', '', '<span class="sync-spin" aria-hidden="true"></span>');
    } else if (!st.signedIn) {
      const title = st.expired ? 'Signed out on this device' : 'Sync across your devices';
      const desc = st.expired
        ? 'Sign in again to keep your devices in step. Everything here is kept.'
        : 'Your place in every book, bookmarks, series, settings and reading time, the same on all your devices. Folio works fully without it.';
      html += row(title, note ? esc(note) : desc, '<button class="btn subtle" data-sync="google">Sign in with Google</button>');
      html += row(
        'Link with a code',
        linkError ? esc(linkError) : 'Signed in on another device? Choose “Link a device” there and type the code here.',
        entering
          ? `<form class="sync-enter" data-sync-form><input class="sync-input" name="code" maxlength="7" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABC123" aria-label="Link code"><button class="btn subtle" type="submit">Link</button></form>`
          : '<button class="btn subtle" data-sync="enter">Enter code</button>',
        ' sub',
      );
    } else {
      const when = st.busy && !st.lastSync ? 'Syncing…' : st.lastSync ? `Synced ${ago(st.lastSync)}` : 'Not synced yet';
      const quiet = st.error === 'offline' || navigator.onLine === false ? `${when} · offline, changes wait on this device` : st.error && Date.now() - st.lastSync > 3600e3 ? `${when} · couldn’t reach the server` : when;
      html += row(esc(st.email || 'Signed in'), esc(quiet), '<button class="btn subtle" data-sync="out">Sign out</button>');
      html += row(
        'Keep books in Google Drive',
        esc(driveNote || DRIVE_DESC),
        `<button class="switch" role="switch" data-sync="drive" aria-checked="${st.drive}" aria-label="Keep books in Google Drive"><i></i></button>`,
        ' sub sync-drive',
      );
      const live = shownCode && shownCode.until > Date.now();
      html += row(
        'Link a device',
        live ? `Type this code on the other device in Settings › Sync › Enter code. It works once, for 10 minutes.` : 'Show a code to type on another device, instead of signing in with Google there.',
        live ? `<output class="sync-code" aria-label="Link code">${esc(shownCode.code.slice(0, 3))}<i></i>${esc(shownCode.code.slice(3))}</output>` : '<button class="btn subtle" data-sync="code">Show code</button>',
        ' sub',
      );
    }
    group.innerHTML = html;
    const input = group.querySelector('.sync-input');
    if (input) input.focus();
    if (st.drive && !driveNote) {
      driveSummary().then((s) => {
        const d = group.querySelector('.sync-drive .set-desc');
        if (!d || !s.total) return;
        d.textContent = s.uploading
          ? `${s.done} of ${s.total} books in Drive · copying “${s.uploading}”`
          : s.done === s.total
            ? `All ${s.total} book${s.total === 1 ? '' : 's'} on this device are in your Drive’s Folio folder.`
            : `${s.done} of ${s.total} books in Drive · the rest follow when online.`;
      });
    }
  }

  group.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sync]');
    if (!b) return;
    const act = b.dataset.sync;
    if (act === 'google') {
      if (navigator.onLine === false) {
        note = 'You’re offline. Connect to the internet to sign in.';
        return draw();
      }
      b.disabled = true;
      signInWithGoogle();
    } else if (act === 'enter') {
      entering = true;
      linkError = '';
      draw();
    } else if (act === 'out') {
      if (!confirm('Sign out on this device? Your books and progress stay here; this device just stops syncing.')) return;
      b.disabled = true;
      await signOut();
    } else if (act === 'drive') {
      driveNote = '';
      if (b.getAttribute('aria-checked') !== 'true') {
        if (navigator.onLine === false) {
          driveNote = 'You’re offline. Connect to the internet to turn this on.';
          return draw();
        }
        b.disabled = true;
        try {
          await connectDrive();
        } catch (err) {
          driveNote = 'Couldn’t reach Google Drive. Please try again.';
          draw();
        }
        return;
      }
      if (!confirm('Stop keeping books in Google Drive? Books already there stay in your Drive; devices can still read the ones they have.')) return;
      b.disabled = true;
      try {
        await disconnectDrive();
      } catch (err) {}
      draw();
    } else if (act === 'code') {
      b.disabled = true;
      try {
        const r = await makeLinkCode();
        shownCode = { code: r.code, until: Date.now() + (r.expiresIn || 600) * 1000 };
      } catch (err) {
        b.disabled = false;
        b.textContent = 'Try again';
        return;
      }
      draw();
    }
  });

  group.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target.closest('[data-sync-form]');
    if (!form) return;
    const code = form.elements.code.value.trim();
    if (!code) return;
    form.querySelector('button').disabled = true;
    try {
      await linkWithCode(code);
      entering = false;
      linkError = '';
    } catch (err) {
      linkError = navigator.onLine === false ? 'You’re offline. Connect to the internet to link.' : String(err.message || 'That code didn’t work.');
      entering = true;
    }
    draw();
  });

  const update = () => {
    if (!group.isConnected) return stop(); // Settings was closed
    if (!group.querySelector('.sync-input')) draw(); // don't redraw away a code being typed
  };
  const off = onSyncStatus(update);
  const offDrive = onDriveProgress(update);
  const tick = setInterval(update, 30000);
  const stop = () => {
    off();
    offDrive();
    clearInterval(tick);
  };
  draw();
  runSync();
  return stop;
}
