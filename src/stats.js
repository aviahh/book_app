// Lightweight reading statistics: minutes read per day (local time).

const KEY = 'folio.stats.v1';
const TICK = 15_000;

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

/** Count reading time while `isActive()` and the user interacted recently. Returns a stop function. */
export function trackReading(isActive) {
  let lastInput = Date.now();
  const bump = () => (lastInput = Date.now());
  window.addEventListener('pointerdown', bump);
  window.addEventListener('keydown', bump);
  const timer = setInterval(() => {
    if (!isActive() || Date.now() - lastInput > 5 * 60_000) return;
    const s = load();
    const k = dayKey();
    s[k] = (s[k] || 0) + TICK / 1000;
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {}
  }, TICK);
  return () => {
    clearInterval(timer);
    window.removeEventListener('pointerdown', bump);
    window.removeEventListener('keydown', bump);
  };
}

export function readingStats() {
  const s = load();
  const today = Math.round((s[dayKey()] || 0) / 60);
  let streak = 0;
  const d = new Date();
  // Today doesn't break the streak until it's over.
  if (!s[dayKey(d)]) d.setDate(d.getDate() - 1);
  while (s[dayKey(d)] >= 60) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  let week = 0;
  const w = new Date();
  const days = [];
  for (let i = 0; i < 7; i++) {
    const m = Math.round((s[dayKey(w)] || 0) / 60);
    week += m;
    days.unshift({ label: w.toLocaleDateString('en-GB', { weekday: 'narrow' }), minutes: m });
    w.setDate(w.getDate() - 1);
  }
  return { today, streak, week, days };
}
