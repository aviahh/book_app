// The catalogs Folio offers (free, legal ones built in) and the ones you add.
// Your list syncs with your other devices (as a setting); a catalog's login
// stays on this device only, and is sent only to that catalog.

import { getSettings, setSetting } from '../settings.js';
import { getText, NeedsLogin } from './net.js';
import { parseFeed } from './opds.js';

export const BUILT_IN = [
  {
    id: 'gutenberg',
    name: 'Project Gutenberg',
    url: 'https://www.gutenberg.org/ebooks.opds/',
    desc: 'Over 75,000 free classics whose copyright has expired.',
    // (Its own search description still points to a mobile server that no longer answers.)
    search: 'https://www.gutenberg.org/ebooks/search.opds/?query={searchTerms}',
    // Its lists show a generic icon per book; the real cover has a fixed address.
    cover: (href) => {
      const m = /^https:\/\/www\.gutenberg\.org\/ebooks\/(\d+)\.opds$/.exec(href || '');
      return m ? `https://www.gutenberg.org/cache/epub/${m[1]}/pg${m[1]}.cover.small.jpg` : null;
    },
  },
  { id: 'unglue', name: 'Unglue.it', url: 'https://unglue.it/api/opds/', desc: 'Free ebooks, many under Creative Commons, released by their authors and publishers.' },
];

const AUTH_KEY = 'folio.sources.auth.v1';
const readAuth = () => {
  try {
    return JSON.parse(localStorage.getItem(AUTH_KEY) || '{}') || {};
  } catch (e) {
    return {};
  }
};

export function catalogs() {
  const mine = (getSettings().sources || []).filter((c) => c && c.id && c.url);
  return BUILT_IN.map((c) => Object.assign({ builtIn: true }, c)).concat(mine);
}

export const catalogOf = (id) => catalogs().find((c) => c.id === id) || null;

/** A catalog's login, bound to the catalog's own origin: { auth, origin }, or null. */
export function loginFor(cat) {
  const auth = cat && readAuth()[cat.id];
  if (!auth) return null;
  try {
    const u = new URL(cat.url);
    return u.protocol === 'https:' ? { auth, origin: u.origin } : null;
  } catch (e) {
    return null;
  }
}

const basic = (user, pass) => 'Basic ' + btoa(unescape(encodeURIComponent(`${user}:${pass}`)));

/** Check an address really is a catalog, then add it. Returns the new catalog. */
export async function addCatalog({ url, name, user, pass }) {
  let u;
  try {
    u = new URL(/^\w+:\/\//.test(url.trim()) ? url.trim() : `https://${url.trim()}`);
  } catch (e) {
    throw new Error('That address doesn’t look right.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only web addresses (https://…) can be added.');
  if (u.username || u.password) throw new Error('Put the user name and password in their own boxes, not in the address.');
  if (user && u.protocol !== 'https:') throw new Error('A login is only sent over a secure (https) connection.');
  const auth = user ? basic(user, pass || '') : '';
  let feed;
  try {
    const page = await getText(u.href, auth ? { auth, origin: u.origin } : null);
    feed = parseFeed(page.text, page.url);
  } catch (e) {
    if (e instanceof NeedsLogin) throw new Error(user ? 'The catalog didn’t accept that user name and password.' : 'This catalog needs a login: add your user name and password.');
    throw new Error(e.message && !/JSON|token/i.test(e.message) ? e.message : 'That address isn’t an OPDS catalog.');
  }
  const id = 'c' + Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(6)), (b) => ('0' + b.toString(16)).slice(-2)).join('');
  const entry = { id, name: String(name || feed.title || u.hostname).trim().slice(0, 80), url: u.href };
  setSetting('sources', (getSettings().sources || []).concat([entry]));
  if (auth) {
    const all = readAuth();
    all[id] = auth;
    try {
      localStorage.setItem(AUTH_KEY, JSON.stringify(all));
    } catch (e) {}
  }
  return entry;
}

export function removeCatalog(id) {
  setSetting(
    'sources',
    (getSettings().sources || []).filter((c) => c.id !== id),
  );
  const all = readAuth();
  delete all[id];
  try {
    localStorage.setItem(AUTH_KEY, JSON.stringify(all));
  } catch (e) {}
}
