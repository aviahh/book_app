// Errors the app ran into on this device, kept (the last few, messages only)
// so they can be copied from Settings when something goes wrong.

const KEY = 'folio.problems.v1';
const KEEP = 12;

export function problems() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

export function clearProblems() {
  try {
    localStorage.removeItem(KEY);
  } catch (e) {}
}

function note(what) {
  try {
    const list = problems();
    const msg = String(what || 'Unknown error').slice(0, 300);
    const last = list[list.length - 1];
    if (last && last.msg === msg && Date.now() - last.at < 60000) return; // the same one again
    list.push({ at: Date.now(), msg, where: location.hash.slice(0, 40), build: typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '' });
    localStorage.setItem(KEY, JSON.stringify(list.slice(-KEEP)));
  } catch (e) {}
}

export function watchProblems() {
  window.addEventListener('error', (e) => {
    if (e.message && e.message !== 'Script error.') note(`${e.message}${e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : ''}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    note(r && r.message ? `${r.name || 'Error'}: ${r.message}` : String(r));
  });
}
