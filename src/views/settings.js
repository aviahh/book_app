import { getSettings, setSetting, LANGUAGES, DEFAULTS } from '../settings.js';
import { icons } from '../icons.js';
import { shell, esc, toast } from './common.js';
import { backupSizes, createBackup, backupFileName, restoreBackup } from '../backup.js';

export async function mountSettings(view, _p, nav) {
  const content = shell(view, 'settings');

  const seg = (key, options) => `
    <div class="segmented" role="radiogroup">
      ${options.map(([v, l]) => `<button role="radio" data-key="${key}" data-val="${v}" aria-checked="${getSettings()[key] === v}">${l}</button>`).join('')}
    </div>`;
  const toggle = (key) => `<button class="switch" role="switch" data-toggle="${key}" aria-checked="${getSettings()[key]}"><i></i></button>`;
  const UNITS = { autoHideSeconds: ' s', popupSeconds: ' s' };
  const shown = (key, v) => (key === 'popupSeconds' && v === 0 ? 'Never' : `${v}${UNITS[key] || ''}`);
  const stepper = (key, min, max, step = 1) => `
    <div class="stepper" data-stepper="${key}" data-min="${min}" data-max="${max}" data-step="${step}">
      <button data-d="-1" aria-label="Decrease">−</button><output>${shown(key, getSettings()[key])}</output><button data-d="1" aria-label="Increase">+</button>
    </div>`;
  const select = (key, options) => `
    <select data-select="${key}">${options.map(([v, l]) => `<option value="${v}" ${getSettings()[key] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

  const row = (title, desc, control) => `
    <div class="set-row"><div class="set-text"><span class="set-title">${title}</span>${desc ? `<span class="set-desc">${desc}</span>` : ''}</div>${control}</div>`;

  let storage = '';
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.usage != null) storage = `${(est.usage / 1048576).toFixed(0)} MB used on this device`;
  } catch {}

  let sizes = { count: 0, bookBytes: 0 };
  try {
    sizes = await backupSizes();
  } catch (e) {}
  const mb = (n) => (n < 1048576 ? 'under 1 MB' : `about ${Math.round(n / 1048576)} MB`);
  let withBooks = false;

  content.innerHTML = `
    <section class="settings">
      <h1>Settings</h1>

      <h2>Appearance</h2>
      <div class="set-group">
        ${row('Theme', 'Automatic follows your device’s light or dark mode.', seg('theme', [['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']]))}
      </div>

      <h2>Turning pages</h2>
      <div class="set-group">
        ${row('Turn with a single tap on hidden arrows', 'When off, the first tap reveals the side arrows and a second tap turns the page.', toggle('singleTapArrows'))}
        ${row('Double arrows « » jump by', 'Chapters uses the book’s table of contents. Books without one jump by pages.', seg('jumpMode', [['chapters', 'Chapters'], ['pages', 'Pages']]))}
        ${row('Pages per double-arrow jump', 'Used for books without a table of contents, or when jumping by pages.', stepper('jumpPages', 2, 50))}
        ${row('Turning pages while zoomed in', 'Landscape only. “Stay zoomed” jumps straight to the top of the next pages without leaving the zoom.', select('zoomTurn', [['stay', 'Stay zoomed, jump to top'], ['zoomOut', 'Zoom out, then turn'], ['animate', 'Turn while zoomed']]))}
        ${row('Page-turn effect', 'Used in landscape (two pages). In portrait, pages scroll.', select('pageTurn', [['bend', 'Soft page'], ['fold', 'Paper corner'], ['curl', 'Classic 3D'], ['slide', 'Slide'], ['none', 'None']]))}
      </div>

      <h2>Reading view</h2>
      <div class="set-group">
        ${row('Full screen while reading', 'Hides the browser bars and other apps when a book opens.', toggle('fullscreen'))}
        ${row('Toolbar position', '', seg('toolbarPosition', [['top', 'Top'], ['bottom', 'Bottom']]))}
        ${row('Hide controls after', 'Toolbar and arrows fade away after this many seconds.', stepper('autoHideSeconds', 2, 10, 0.5))}
        ${row('Page tone', 'Warm and Night are easier on the eyes in the evening.', seg('pageTone', [['original', 'Original'], ['warm', 'Warm'], ['night', 'Night']]))}
        ${row('Surroundings', 'The colour around the book.', seg('backdrop', [['night', 'Ink'], ['walnut', 'Walnut'], ['linen', 'Linen']]))}
      </div>

      <h2>Language</h2>
      <div class="set-group">
        ${row('Close translation bubble after', 'The bubble from double-tapping a word closes by itself. Touching it restarts the countdown.', stepper('popupSeconds', 0, 15, 0.5))}
        ${row('Translate words into', 'Double-tap any word while reading.', select('translateTo', LANGUAGES))}
        ${row('Voice', 'For reading passages aloud. Microsoft is the natural voice from EZ_shortcut (Jenny in English, Hila in Hebrew).', seg('speechVoice', [['microsoft', 'Microsoft'], ['google', 'Google']]))}
        ${row('Read-aloud language', 'Auto detects from the text itself.', select('speechLang', [['auto', 'Automatic'], ...LANGUAGES]))}
      </div>

      <h2>Backup</h2>
      <div class="set-group">
        ${row('What to back up', `Progress only: your library list, reading progress, statistics and settings (tiny). With books: the PDFs too (${sizes.count} book${sizes.count === 1 ? '' : 's'}, ${mb(sizes.bookBytes)}).`, `
          <div class="segmented" role="radiogroup">
            <button role="radio" data-bk="0" aria-checked="true">Progress only</button><button role="radio" data-bk="1" aria-checked="false">With books</button>
          </div>`)}
        ${row('Back up now', 'Choose Google Drive, iCloud Drive or Files in the share menu to keep it safe, or it is saved to Downloads.', '<button class="btn subtle" data-act="backup">Back up</button>')}
        ${row('Restore from a backup', 'Pick a Folio backup file (Drive, Files, Downloads…). It merges with this device: newer progress wins, nothing is deleted. Progress for books not on this device is applied when you add them.', '<button class="btn subtle" data-act="restore">Restore</button><input type="file" data-restore hidden>')}
      </div>

      <h2>About</h2>
      <div class="set-group">
        ${row('Folio', 'Books stay on this device. Translation and read-aloud use online services (Google, Microsoft) and need an internet connection.', '')}
        ${storage ? row('Storage', storage, '') : ''}
        ${row('Reset preferences', '', '<button class="btn subtle" data-act="reset">Reset</button>')}
        ${row('Relaunch Folio', `Closes and reopens the app, picking up the newest version if there is one. Version: ${buildLabel()}.`, '<button class="btn subtle" data-act="relaunch">Relaunch</button>')}
      </div>
    </section>`;

  content.addEventListener('click', (e) => {
    const r = e.target.closest('[data-key]');
    if (r) {
      setSetting(r.dataset.key, r.dataset.val);
      for (const b of content.querySelectorAll(`[data-key="${r.dataset.key}"]`)) b.setAttribute('aria-checked', String(b === r));
    }
    const t = e.target.closest('[data-toggle]');
    if (t) {
      const v = !getSettings()[t.dataset.toggle];
      setSetting(t.dataset.toggle, v);
      t.setAttribute('aria-checked', String(v));
    }
    const s = e.target.closest('[data-d]');
    if (s) {
      const st = s.closest('[data-stepper]');
      const key = st.dataset.stepper;
      const step = +st.dataset.step;
      const v = Math.min(+st.dataset.max, Math.max(+st.dataset.min, getSettings()[key] + step * +s.dataset.d));
      setSetting(key, v);
      st.querySelector('output').textContent = shown(key, v);
    }
    const bk = e.target.closest('[data-bk]');
    if (bk) {
      withBooks = bk.dataset.bk === '1';
      for (const b of content.querySelectorAll('[data-bk]')) b.setAttribute('aria-checked', String(b === bk));
    }
    const bu = e.target.closest('[data-act="backup"]');
    if (bu) backup(bu, withBooks);
    if (e.target.closest('[data-act="restore"]')) content.querySelector('[data-restore]').click();
    const rl = e.target.closest('[data-act="relaunch"]');
    if (rl) relaunch(rl);
    if (e.target.closest('[data-act="reset"]')) {
      for (const [k, v] of Object.entries(DEFAULTS)) setSetting(k, v);
      mountSettings((view.replaceChildren(), view), _p, nav);
    }
  });
  content.addEventListener('change', async (e) => {
    if (e.target.matches('[data-restore]')) {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const btn = content.querySelector('[data-act="restore"]');
      btn.disabled = true;
      btn.textContent = 'Restoring…';
      try {
        const r = await restoreBackup(file, (i, n) => (btn.textContent = `Restoring ${i + 1}/${n}…`));
        const parts = [];
        if (r.added) parts.push(`${r.added} book${r.added > 1 ? 's' : ''} added`);
        if (r.updated) parts.push(`progress updated for ${r.updated}`);
        if (r.waiting) parts.push(`progress saved for ${r.waiting} book${r.waiting > 1 ? 's' : ''} not on this device yet`);
        mountSettings((view.replaceChildren(), view), _p, nav).then(() => toast(view, `Restored${parts.length ? ': ' + parts.join(', ') : ''}.`, 5000));
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Restore';
        toast(view, err.message || 'Could not restore this file.', 4000);
      }
      return;
    }
    const sel = e.target.closest('[data-select]');
    if (sel) setSetting(sel.dataset.select, sel.value);
  });
}

/** Make the backup file, then hand it to the share menu (Drive etc.) or save it. */
async function backup(button, withBooks) {
  const view = button.closest('.view') || document;
  // A file ready from an earlier tap: share it now, inside this tap.
  if (button._file) {
    const f = button._file;
    button._file = null;
    button.textContent = 'Back up';
    return deliver(f, view);
  }
  button.disabled = true;
  button.textContent = 'Preparing…';
  let blob;
  try {
    blob = await createBackup({ withBooks });
  } catch (e) {
    button.disabled = false;
    button.textContent = 'Back up';
    return toast(view, 'Could not create the backup.', 4000);
  }
  button.disabled = false;
  const file = { blob, name: backupFileName(withBooks) };
  try {
    await deliver(file, view, true);
    button.textContent = 'Back up';
  } catch (e) {
    // Too long since the tap for the share menu (big backups): one more tap.
    button._file = file;
    button.textContent = 'Save backup';
    toast(view, 'Backup ready. Tap “Save backup” to choose where to keep it.', 5000);
  }
}

async function deliver({ blob, name }, view, strict = false) {
  // The share menu offers Google Drive, iCloud Drive, Files… Android only
  // shares a few file types, so fall back to a plain-text label there; the
  // contents are the same and Restore reads either.
  if (navigator.canShare) {
    for (const [n, type] of [[name, 'application/octet-stream'], [name + '.txt', 'text/plain']]) {
      const f = new File([blob], n, { type });
      if (!navigator.canShare({ files: [f] })) continue;
      try {
        await navigator.share({ files: [f], title: 'Folio backup' });
        return toast(view, 'Backup saved.');
      } catch (e) {
        if (e.name === 'AbortError') return; // closed the menu
        if (strict && e.name === 'NotAllowedError') throw e;
        break;
      }
    }
  }
  if (/(iPad|iPhone|iPod).*OS 1[0-2]_/.test(navigator.userAgent)) {
    return toast(view, 'This iOS version can’t save files from a web page. Make the backup on another device.', 6000);
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  toast(view, 'Backup saved to Downloads.');
}

function buildLabel() {
  const d = new Date(__BUILD_TIME__);
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Fetch any newer version, then fade out and reload the app from its start page. */
async function relaunch(button) {
  button.disabled = true;
  button.textContent = 'Relaunching…';
  try {
    const reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
    if (reg) {
      await Promise.race([reg.update(), wait(6000)]);
      const incoming = reg.installing || reg.waiting;
      if (incoming) {
        // A new version is downloading: let it finish and take over first.
        await Promise.race([
          new Promise((resolve) => {
            if (incoming.state === 'activated') return resolve();
            incoming.addEventListener('statechange', () => incoming.state === 'activated' && resolve());
            if (incoming.state === 'installed') incoming.postMessage({ type: 'SKIP_WAITING' });
          }),
          wait(15000),
        ]);
      }
    }
  } catch (e) {}
  const app = document.getElementById('app');
  app.style.transition = 'opacity 0.3s ease';
  app.style.opacity = '0';
  await wait(320);
  location.replace(location.pathname + location.search);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
