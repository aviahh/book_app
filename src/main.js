import '@fontsource-variable/inter';
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
import { mountReader } from './reader/reader.js';
import { requestPersistence } from './db.js';
import { getSettings, onSettingsChange } from './settings.js';
import { initRouter, nav, currentRoute } from './router.js';

function applyTheme({ theme }) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}
applyTheme(getSettings());
onSettingsChange((s, key) => key === 'theme' && applyTheme(s));

registerSW({ immediate: true });
requestPersistence();

const app = document.getElementById('app');
let cleanup = null;
let token = 0;

const routes = [
  [/^#\/read\/([\w-]+)/, (m) => [mountReader, { id: m[1] }]],
  [/^#\/library/, () => [mountLibrary, {}]],
  [/^#\/settings/, () => [mountSettings, {}]],
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
      view.innerHTML = `<div class="error-state"><h2>Something went wrong</h2><p>${String(e.message || e)}</p><a href="#/library" class="btn">Back to library</a></div>`;
    }
    return;
  }
}

initRouter(render);
