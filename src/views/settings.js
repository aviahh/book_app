import { getSettings, setSetting, LANGUAGES, DEFAULTS } from '../settings.js';
import { icons } from '../icons.js';
import { shell, esc } from './common.js';

export async function mountSettings(view, _p, nav) {
  const content = shell(view, 'settings');

  const seg = (key, options) => `
    <div class="segmented" role="radiogroup">
      ${options.map(([v, l]) => `<button role="radio" data-key="${key}" data-val="${v}" aria-checked="${getSettings()[key] === v}">${l}</button>`).join('')}
    </div>`;
  const toggle = (key) => `<button class="switch" role="switch" data-toggle="${key}" aria-checked="${getSettings()[key]}"><i></i></button>`;
  const stepper = (key, min, max, step = 1, unit = '') => `
    <div class="stepper" data-stepper="${key}" data-min="${min}" data-max="${max}" data-step="${step}">
      <button data-d="-1" aria-label="Decrease">−</button><output>${getSettings()[key]}${unit}</output><button data-d="1" aria-label="Increase">+</button>
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
        ${row('Pages per double-arrow jump', 'How far the « and » buttons move.', stepper('jumpPages', 2, 50))}
        ${row('Page-turn effect', 'Used in landscape (two pages). In portrait, pages scroll.', select('pageTurn', [['bend', 'Soft page'], ['fold', 'Paper corner'], ['curl', 'Classic 3D'], ['slide', 'Slide'], ['none', 'None']]))}
      </div>

      <h2>Reading view</h2>
      <div class="set-group">
        ${row('Full screen while reading', 'Hides the browser bars and other apps when a book opens.', toggle('fullscreen'))}
        ${row('Toolbar position', '', seg('toolbarPosition', [['top', 'Top'], ['bottom', 'Bottom']]))}
        ${row('Hide controls after', 'Toolbar and arrows fade away after this many seconds.', stepper('autoHideSeconds', 2, 10, 0.5, ' s'))}
        ${row('Page tone', 'Warm and Night are easier on the eyes in the evening.', seg('pageTone', [['original', 'Original'], ['warm', 'Warm'], ['night', 'Night']]))}
        ${row('Surroundings', 'The colour around the book.', seg('backdrop', [['night', 'Ink'], ['walnut', 'Walnut'], ['linen', 'Linen']]))}
      </div>

      <h2>Language</h2>
      <div class="set-group">
        ${row('Translate words into', 'Double-tap any word while reading.', select('translateTo', LANGUAGES))}
        ${row('Read-aloud language', 'Auto detects from the text itself.', select('speechLang', [['auto', 'Automatic'], ...LANGUAGES]))}
      </div>

      <h2>About</h2>
      <div class="set-group">
        ${row('Folio', 'Books stay on this device. Translation and read-aloud use Google services and need an internet connection.', '')}
        ${storage ? row('Storage', storage, '') : ''}
        ${row('Reset preferences', '', '<button class="btn subtle" data-act="reset">Reset</button>')}
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
      st.querySelector('output').textContent = `${v}${key === 'autoHideSeconds' ? ' s' : ''}`;
    }
    if (e.target.closest('[data-act="reset"]')) {
      for (const [k, v] of Object.entries(DEFAULTS)) setSetting(k, v);
      mountSettings((view.replaceChildren(), view), _p, nav);
    }
  });
  content.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-select]');
    if (sel) setSetting(sel.dataset.select, sel.value);
  });
}
