import './polyfills.js'; // first: older browsers (iOS 12) need these before anything runs
import '@fontsource-variable/inter';
import '@fontsource-variable/literata/wght.css'; // EPUB text
import '@fontsource-variable/literata/wght-italic.css';
import '@fontsource/cormorant-garamond/500.css';
import '@fontsource/cormorant-garamond/600.css';
import '@fontsource/cormorant-garamond/500-italic.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/reader.css';
import { registerSW } from 'virtual:pwa-register';
import { mountHome } from './views/home.js';
import { mountLibrary } from './views/library.js';
import { mountSettings } from './views/settings.js';
import { mountAccount } from './views/account.js';
import { mountSources } from './views/sources.js';
import { mountReader, READING_KEY, REOPENING_KEY } from './reader/reader.js';
import { requestPersistence } from './db.js';
import { getSettings, onSettingsChange } from './settings.js';
import { initRouter, nav, currentRoute } from './router.js';
import { startSync } from './sync/index.js';
import { watchProblems } from './problems.js';

watchProblems();

// If the app didn't stay up for a few seconds the last time it started (it
// froze or was closed while starting), start more carefully this time: the
// last book isn't opened again, and syncing waits a little.
const STARTING_KEY = 'folio.starting.v1';
let careful = false;
try {
  careful = !!localStorage.getItem(STARTING_KEY);
  localStorage.setItem(STARTING_KEY, '1');
  setTimeout(() => {
    try {
      localStorage.removeItem(STARTING_KEY);
    } catch (e) {}
  }, 4000);
} catch (e) {}

function applyTheme({ theme }) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}
applyTheme(getSettings());
onSettingsChange((s, key) => key === 'theme' && applyTheme(s));

registerSW({ immediate: true });
requestPersistence();
if (careful) setTimeout(startSync, 15000);
else startSync();

const app = document.getElementById('app');
let cleanup = null;
let token = 0;

const routes = [
  [/^#\/read\/([\w-]+)/, (m) => [mountReader, { id: m[1] }]],
  [/^#\/sources/, () => [mountSources, {}]],
  [/^#\/library/, () => [mountLibrary, {}]],
  [/^#\/settings/, () => [mountSettings, {}]],
  [/^#\/account/, () => [mountAccount, {}]],
  [/^/, () => [mountHome, {}]],
];

async function render() {
  const my = ++token;
  if (cleanup) {
    try {
      cleanup();
    } catch (e) {
      console.error(e);
    }
    cleanup = null;
  }
  app.replaceChildren();
  const hash = currentRoute();
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (!m) continue;
    const [mount, params] = fn(m);
    const view = document.createElement('div');
    view.className = 'view';
    app.append(view);
    try {
      const c = await mount(view, params, nav);
      if (my !== token) c?.();
      else cleanup = c || null;
    } catch (e) {
      console.error(e);
      window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: e }));
      view.innerHTML = `<div class="error-state"><h2>Something went wrong</h2><p>${String(e.message || e)}</p><a href="#/library" class="btn">Back to library</a></div>`;
    }
    return;
  }
}

// The app went to the background with a book open (e.g. to look something up
// in Google Translate) and the system closed it meanwhile: open that book
// again rather than the Reading Room. (The reader forgets it once the book
// is closed normally.)
// Only once: if the book didn't open properly last time (the app froze or
// closed while opening it), or the app didn't start properly, it starts in the
// Reading Room instead, so a book that won't open can never keep the app from
// starting.
try {
  const open = JSON.parse(localStorage.getItem(READING_KEY) || 'null');
  const home = !location.hash || location.hash === '#/' || location.hash === '#';
  if (careful || localStorage.getItem(REOPENING_KEY)) {
    localStorage.removeItem(REOPENING_KEY);
    localStorage.removeItem(READING_KEY);
  } else if (open && open.v === 2 && home && Date.now() - open.at < 12 * 3600 * 1000) {
    localStorage.setItem(REOPENING_KEY, open.id);
    history.replaceState(null, '', `#/read/${open.id}`);
  }
} catch (e) {}

initRouter(render);
