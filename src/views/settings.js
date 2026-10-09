import { getSettings, setSetting, onSettingsChange, LANGUAGES, DEFAULTS } from '../settings.js';
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

  // Rows can depend on another setting: `sub` indents them under the row
  // they belong to, and `dyn` (settings → { desc, off }) updates their
  // description, or switches them off, whenever settings change.
  const live = new Map();
  const row = (title, desc, control, { sub = false, dyn } = {}) => {
    const id = dyn ? `d${live.size}` : '';
    if (dyn) live.set(id, dyn);
    const d = dyn ? dyn(getSettings()) : { desc };
    return `
    <div class="set-row${sub ? ' sub' : ''}${d.off ? ' off' : ''}"${id ? ` data-live="${id}"` : ''}><div class="set-text"><span class="set-title">${title}</span><span class="set-desc"${d.desc ? '' : ' hidden'}>${d.desc || ''}</span></div>${control}</div>`;
  };

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
        ${row('Page-turn effect', 'How pages turn in landscape (two pages). In portrait, pages scroll.', select('pageTurn', [['bend', 'Soft page'], ['fold', 'Paper corner'], ['curl', 'Classic 3D'], ['slide', 'Slide'], ['none', 'None']]))}
        ${row('While zoomed in', '', select('zoomTurn', [['stay', 'Stay zoomed'], ['zoomOut', 'Zoom out first'], ['animate', 'Turn while zoomed']]), {
          sub: true,
          dyn: (s) => ({
            desc:
              s.zoomTurn === 'stay'
                ? 'Goes straight to the top of the next pages without leaving the zoom.'
                : s.zoomTurn === 'zoomOut'
                  ? 'Zooms back out first, then turns the page.'
                  : s.pageTurn === 'none'
                    ? 'With no page-turn effect, the pages simply switch, still zoomed in.'
                    : 'Plays the page-turn effect without leaving the zoom.',
          }),
        })}
        ${row('Turn with a single tap on hidden arrows', 'When off, the first tap reveals the side arrows and a second tap turns the page.', toggle('singleTapArrows'))}
        ${row('Double arrows « » jump by', '', seg('jumpMode', [['chapters', 'Chapters'], ['pages', 'Pages']]), {
          dyn: (s) => ({
            desc: s.jumpMode === 'pages' ? 'Always a fixed number of pages, set below.' : 'From chapter to chapter, using the book’s table of contents.',
          }),
        })}
        ${row('Pages per jump', '', stepper('jumpPages', 2, 50), {
          sub: true,
          dyn: (s) => ({
            desc: s.jumpMode === 'pages' ? 'Each « » jump skips this many pages.' : 'If a book has no table of contents, « » skips this many pages instead.',
          }),
        })}
      </div>

      <h2>Reading view</h2>
      <div class="set-group">
        ${row('Full screen while reading', 'Hides the browser bars and other apps when a book opens.', toggle('fullscreen'))}
        ${row('One page when zoomed in', 'Landscape: zoom in on a page and it becomes a single page you scroll down, like portrait, so you can zoom much further. Zoom out past the whole page to get the two-page view back.', toggle('focusZoom'))}
        ${row('Toolbar position', '', seg('toolbarPosition', [['top', 'Top'], ['bottom', 'Bottom']]))}
        ${row('Hide toolbar and arrows after', 'They fade away after this many seconds; tap to bring them back.', stepper('autoHideSeconds', 2, 10, 0.5), { sub: true })}
        ${row('Page tone', '', seg('pageTone', [['original', 'Original'], ['warm', 'Warm'], ['night', 'Night']]), {
          dyn: (s) => ({
            desc:
              s.pageTone === 'original'
                ? 'Pages look exactly as printed.'
                : s.pageTone === 'warm'
                  ? 'Softer, warmer paper for the evening. Pictures keep their colours.'
                  : 'Light text on dark paper for reading in the dark. Pictures keep their colours.',
          }),
        })}
        ${row('Surroundings', 'The colour around the book.', seg('backdrop', [['night', 'Ink'], ['walnut', 'Walnut'], ['linen', 'Linen']]), { sub: true })}
      </div>

      <h2>Translation</h2>
      <div class="set-group">
        ${row('Translate words into', 'Double-tap any word while reading; drag the handles to translate a phrase.', select('translateTo', LANGUAGES))}
        ${row('Close the bubble after', '', stepper('popupSeconds', 0, 15, 0.5), {
          sub: true,
          dyn: (s) => ({ desc: s.popupSeconds === 0 ? 'The bubble stays until you tap elsewhere.' : 'Touching the bubble restarts the countdown.' }),
        })}
      </div>

      <h2>Read aloud</h2>
      <div class="set-group">
        ${row('Voice', '', seg('speechVoice', [['microsoft', 'Microsoft'], ['google', 'Google']]), {
          dyn: (s) => ({
            desc:
              s.speechVoice === 'microsoft'
                ? 'Natural voices, as in EZ_shortcut (Jenny in English, Hila in Hebrew). Falls back to Google if unavailable.'
                : 'Google’s voice.',
          }),
        })}
        ${row('Language', 'Automatic detects it from the text itself.', select('speechLang', [['auto', 'Automatic'], ...LANGUAGES]), { sub: true })}
      </div>

      <h2>Backup</h2>
      <div class="set-group">
        ${row('What to back up', 'Progress only: your library list, reading progress, statistics and settings. With books: the PDFs as well.', `
          <div class="segmented" role="radiogroup">
            <button role="radio" data-bk="0" aria-checked="true">Progress only</button><button role="radio" data-bk="1" aria-checked="false">With books</button>
          </div>`)}
        ${row('Back up now', '', '<button class="btn subtle" data-act="backup">Back up</button>', {
          sub: true,
          dyn: () => ({
            desc: `${withBooks ? `Progress and ${sizes.count} book${sizes.count === 1 ? '' : 's'} (${mb(sizes.bookBytes)}).` : 'Progress only, a tiny file.'} Choose Google Drive, iCloud Drive or Files in the share menu, or it is saved to Downloads.`,
          }),
        })}
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

  // Keep dependent rows in step with the settings they depend on.
  const refresh = () => {
    const s = getSettings();
    for (const el of content.querySelectorAll('[data-live]')) {
      const d = live.get(el.dataset.live)(s);
      const desc = el.querySelector('.set-desc');
      desc.textContent = d.desc || '';
      desc.hidden = !d.desc;
      el.classList.toggle('off', !!d.off);
      for (const c of el.querySelectorAll('button, select, input')) c.disabled = !!d.off;
    }
  };
  const unwatch = onSettingsChange(() => (content.isConnected ? refresh() : unwatch()));

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
      refresh();
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
