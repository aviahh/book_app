// Fetching from catalogs: straight from the browser when the catalog allows
// it, otherwise through Folio's relay (/api/fetch), which only passes on
// catalogs and book files. A catalog's login goes only to that catalog.

const api = (path) => new URL('api/' + path, document.baseURI).href;
const relayed = new Set(); // "feed:origin" / "book:origin" that need the relay

export class NeedsLogin extends Error {}

/** The login, only for an address on the catalog's own origin (over https); never for links elsewhere. */
const authTo = (url, login) => (login && originOf(url) === login.origin && /^https:/.test(url) ? login.auth : '');
const relayHeaders = (url, login) => (authTo(url, login) ? { 'X-Folio-Auth': login.auth, 'X-Folio-Auth-Origin': login.origin } : {});

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch (e) {
    return '';
  }
};
const viaRelay = (kind, url) => location.protocol === 'https:' && /^http:/.test(url) ? true : relayed.has(`${kind}:${originOf(url)}`);

async function relayError(res) {
  let msg = `The catalog couldn’t be reached (${res.status}).`;
  try {
    msg = (await res.json()).error || msg;
  } catch (e) {}
  if (res.status === 401) throw new NeedsLogin(msg);
  throw new Error(msg);
}

/** A catalog page as text: { text, url } (url = where it ended up, for its relative links). */
export async function getText(url, login) {
  const auth = authTo(url, login);
  if (!viaRelay('feed', url)) {
    try {
      const headers = { Accept: 'application/atom+xml, application/opds+json, application/xml, application/json;q=0.9, */*;q=0.5' };
      if (auth) headers.Authorization = auth;
      const res = await fetch(url, { mode: 'cors', credentials: 'omit', headers, referrerPolicy: 'no-referrer' });
      if (res.status === 401) throw new NeedsLogin('This catalog needs a login.');
      if (!res.ok) throw new Error(`The catalog answered ${res.status}.`);
      return { text: await res.text(), url: res.url || url };
    } catch (e) {
      if (e instanceof NeedsLogin || !(e instanceof TypeError)) throw e;
      relayed.add(`feed:${originOf(url)}`); // not allowed from a browser: use the relay from now on
    }
  }
  const res = await fetch(api(`fetch?url=${encodeURIComponent(url)}`), { headers: relayHeaders(url, login), cache: 'no-store' });
  if (!res.ok) await relayError(res);
  if (res.headers.get('X-Folio-Kind') !== 'feed') throw new Error('That isn’t a catalog page.');
  return { text: await res.text(), url: res.headers.get('X-Folio-Url') || url };
}

function xhr(url, headers, onProgress, hint = 0, ctl = null) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('GET', url);
    x.responseType = 'blob';
    for (const k of Object.keys(headers)) x.setRequestHeader(k, headers[k]);
    x.onprogress = (e) => {
      const total = e.lengthComputable ? e.total : Number(x.getResponseHeader('X-Folio-Length')) || hint;
      onProgress(total ? Math.min(0.99, e.loaded / total) : 0, e.loaded);
    };
    x.onload = () => resolve(x);
    x.onerror = () => reject(new TypeError('network'));
    x.onabort = () => reject(new Error('cancelled'));
    if (ctl) ctl.onCancel(() => x.abort());
    x.send();
  });
}

/** A book file: { blob, type, url }. onProgress(fraction, bytes). */
export async function getBook(url, login, onProgress = () => {}, sizeHint = 0, ctl = null) {
  const auth = authTo(url, login);
  if (!viaRelay('book', url)) {
    try {
      const x = await xhr(url, auth ? { Authorization: auth } : {}, onProgress, sizeHint, ctl);
      if (x.status === 401) throw new NeedsLogin('This catalog needs a login.');
      if (x.status === 200) return { blob: x.response, type: x.getResponseHeader('Content-Type') || '', url: x.responseURL || url };
      if (x.status !== 0) throw new Error(`Download failed (${x.status}).`);
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      if (ctl && ctl.cancelled) throw new Error('cancelled');
    }
    relayed.add(`book:${originOf(url)}`);
  }
  const x = await xhr(api(`fetch?url=${encodeURIComponent(url)}`), relayHeaders(url, login), onProgress, sizeHint, ctl).catch((e) => {
    throw new Error(ctl && ctl.cancelled ? 'cancelled' : 'Download failed. Check the connection.');
  });
  if (x.status !== 200) {
    const text = await new Response(x.response).text().catch(() => '');
    let msg = `Download failed (${x.status}).`;
    try {
      msg = JSON.parse(text).error || msg;
    } catch (e) {}
    if (x.status === 401) throw new NeedsLogin(msg);
    throw new Error(msg);
  }
  if (x.getResponseHeader('X-Folio-Kind') !== 'book') throw new Error('That isn’t a book file Folio can read.');
  return { blob: x.response, type: x.getResponseHeader('X-Folio-Type') || '', url: x.getResponseHeader('X-Folio-Url') || url };
}
