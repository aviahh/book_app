// User preferences, persisted in localStorage.

const KEY = 'folio.settings.v1';

export const DEFAULTS = {
  // Off = first tap reveals the hidden side arrows, a second tap turns the page.
  // On  = tapping the (even invisible) arrows turns the page right away.
  singleTapArrows: false,
  jumpMode: 'chapters', // double arrows: 'chapters' (when the book has a table of contents) | 'pages'
  jumpPages: 5,
  toolbarPosition: 'bottom', // 'top' | 'bottom'
  autoHideSeconds: 3.5,
  pageTurn: 'fold', // landscape only: 'fold' | 'bend' | 'curl' | 'slide' | 'none'
  fullscreen: true, // enter full screen when a book opens
  zoomTurn: 'stay', // landscape, zoomed in: 'stay' (instant, keep zoom) | 'zoomOut' (zoom out, then turn) | 'animate'
  pageTone: 'original', // 'original' | 'warm' | 'night'
  backdrop: 'night', // 'night' | 'walnut' | 'linen'
  theme: 'auto', // 'auto' (follow the device) | 'light' | 'dark'
  popupSeconds: 2.5, // translation bubble closes by itself after this long; 0 = never
  translateTo: 'iw',
  speechLang: 'auto',
  speechVoice: 'microsoft', // 'microsoft' (natural voices, as in EZ_shortcut) | 'google'
};

let current = load();
const listeners = new Set();

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function getSettings() {
  return current;
}

export function setSetting(key, value) {
  current = { ...current, [key]: value };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {}
  for (const fn of listeners) fn(current, key);
}

export function onSettingsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const LANGUAGES = [
  ['iw', 'Hebrew'],
  ['en', 'English'],
  ['ar', 'Arabic'],
  ['ru', 'Russian'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
  ['pl', 'Polish'],
  ['uk', 'Ukrainian'],
  ['tr', 'Turkish'],
  ['el', 'Greek'],
  ['hi', 'Hindi'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['zh-CN', 'Chinese (Simplified)'],
];
