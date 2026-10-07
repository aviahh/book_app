// App-style navigation.
//
// The app keeps its own stack of screens (Reading Room → Library → book →
// Settings …) and the browser history never holds more than two entries: the
// Reading Room underneath, and the current screen on top. Pressing the
// device's Back button lands on the Reading Room entry; we then pop one screen
// off our stack and, if anything is left, put the new top screen back on.
// So Back always means "one level up", however much you moved around, and
// Back from the Reading Room leaves the app.

const ROOT = '#/';
let stack = [ROOT];
let onRootEntry = true; // is the browser currently on the bottom (Reading Room) entry?
let goingRoot = false; // we asked the browser to step back to the bottom entry ourselves
let render = () => {};

const norm = (h) => (!h || h === '#' ? ROOT : h);
const top = () => stack[stack.length - 1];
export const currentRoute = () => top();

/** A sensible stack for a screen opened directly (reload, shared link). */
function defaultStack(hash) {
  if (hash === ROOT) return [ROOT];
  if (hash.startsWith('#/library')) return [ROOT, hash];
  if (hash.startsWith('#/read/')) return [ROOT, '#/library', hash];
  if (hash.startsWith('#/settings')) {
    const from = new URLSearchParams(hash.split('?')[1] || '').get('from');
    const below = from && !from.startsWith('#/settings') ? defaultStack(norm(from)) : [ROOT];
    return [...below, hash];
  }
  return [ROOT, hash];
}

function show() {
  // Put the browser's single "top" entry in step with our stack, then draw.
  if (stack.length === 1) {
    if (!onRootEntry) {
      goingRoot = true;
      history.back(); // popstate will draw the Reading Room
      return;
    }
    history.replaceState({ stack }, '', ROOT);
  } else if (onRootEntry) {
    history.pushState({ stack }, '', top());
    onRootEntry = false;
  } else {
    history.replaceState({ stack }, '', top());
  }
  render();
}

/** Go to a screen. Going to a screen already below us counts as going back to it. */
export function nav(target) {
  target = norm(target);
  const i = stack.indexOf(target);
  if (i >= 0) stack = stack.slice(0, i + 1);
  else if (target === ROOT) stack = [ROOT];
  else if (target.startsWith('#/library')) stack = [ROOT, target]; // a main tab
  else stack = [...stack, target];
  show();
}

/** One level up (the in-app equivalent of the device's Back button). */
export function back() {
  if (stack.length > 1) nav(stack[stack.length - 2]);
}
nav.back = back;

export function initRouter(onRender) {
  render = onRender;
  const hash = norm(location.hash);
  const saved = history.state?.stack;
  if (saved?.length > 1 && saved[saved.length - 1] === hash) {
    // Reloaded on the top entry: the Reading Room entry is already below it.
    stack = saved;
    onRootEntry = false;
  } else if (hash === ROOT) {
    stack = [ROOT];
    history.replaceState({ stack }, '', ROOT);
  } else {
    stack = defaultStack(hash);
    history.replaceState({ stack: [ROOT] }, '', ROOT);
    history.pushState({ stack }, '', hash);
    onRootEntry = false;
  }

  window.addEventListener('popstate', (e) => {
    if (goingRoot) {
      goingRoot = false;
      onRootEntry = true;
      stack = [ROOT];
      return render();
    }
    const s = e.state?.stack;
    if (s?.length > 1) {
      // Forward button: back onto a top entry.
      stack = s;
      onRootEntry = false;
      return render();
    }
    // Back button: we're on the Reading Room entry now. Step one screen up.
    onRootEntry = true;
    stack = stack.length > 1 ? stack.slice(0, -1) : [ROOT];
    show();
  });

  // Someone typed a different address by hand.
  window.addEventListener('hashchange', () => {
    const h = norm(location.hash);
    if (h === top()) return;
    stack = defaultStack(h);
    onRootEntry = false;
    history.replaceState({ stack }, '', h);
    render();
  });

  // In-app links navigate through the router instead of piling up history.
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href^="#"]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || a.target) return;
    e.preventDefault();
    nav(a.getAttribute('href'));
  });

  render();
}
