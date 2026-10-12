// Book sources (OPDS catalogs): a careful relay for catalogs and book files
// that a browser can't fetch itself (no CORS on the other side, or plain http).
//
//   GET /api/fetch?url=<https://…>   (optional X-Folio-Auth + X-Folio-Auth-Origin: a catalog's login and
//                                    the only origin it may go to; never stored, never logged)
//
// It only ever passes on two kinds of thing, checked by their first bytes, not
// by what the other server claims: catalog feeds (XML or JSON text) and book
// files (ZIP-based EPUB/CBZ, PDF, RAR-based CBR). Never a page, a script or an
// image. What comes back is always an inert download (octet-stream, attachment,
// sandboxed), so nothing fetched can run on Folio's own address.
//
// Only public web addresses: no IP literals of private networks, no local
// names, no unusual ports, never Folio itself; every redirect is checked the
// same way, and a login is never carried to another host.

const MAX_FEED = 8 * 1024 * 1024; // bytes
const MAX_BOOK = 300 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const PER_HOUR = 1200; // requests per address
const TIMEOUT_MS = 30000;

const HEADERS = {
  'Content-Type': 'application/octet-stream',
  'Content-Disposition': 'attachment',
  'Content-Security-Policy': "sandbox; default-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};
const fail = (status, error) =>
  new Response(JSON.stringify({ error }), { status, headers: Object.assign({}, HEADERS, { 'Content-Type': 'application/json', 'Content-Disposition': 'inline' }) });

/** Is this an address on the public web that may be fetched? */
export function publicUrl(raw, selfHost) {
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null; // logins travel in the header, never in an address
  if (u.port && !((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80'))) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === selfHost) return null;
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home|arpa|test|invalid|onion)$/.test(host) || host.indexOf('.') < 0) return null;
  if (host[0] === '[' || host.indexOf(':') >= 0) return null; // IPv6 literals: none needed for public catalogs
  if (/^[\d.]+$/.test(host) || /^0x/i.test(host)) {
    // IPv4 literal: only public ones
    const p = host.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !(n >= 0 && n <= 255))) return null;
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return null;
    if (a === 100 && b >= 64 && b <= 127) return null;
    if (a === 169 && b === 254) return null;
    if (a === 172 && b >= 16 && b <= 31) return null;
    if (a === 192 && (b === 168 || (b === 0 && p[2] === 0) || (b === 0 && p[2] === 2))) return null;
    if (a === 198 && (b === 18 || b === 19)) return null;
  }
  u.hash = '';
  return u;
}

/** What the first bytes say this is: 'feed', 'book', or null (refused). */
export function kindOf(bytes) {
  const b = bytes;
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7)) return 'book'; // ZIP: EPUB, CBZ
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'book'; // %PDF-
  if (b.length >= 4 && b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21) return 'book'; // Rar!: CBR
  let i = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3; // UTF-8 BOM
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;
  if (i >= b.length) return null;
  if (b[i] === 0x7b) return 'feed'; // { (OPDS 2 JSON)
  if (b[i] === 0x3c) {
    // XML, but not an HTML page
    const head = new TextDecoder().decode(b.subarray(i, Math.min(b.length, i + 512))).toLowerCase();
    if (/^<!doctype\s+html|^<html|<html[\s>]/.test(head)) return null;
    return 'feed';
  }
  return null;
}

async function tooMany(env, request) {
  if (!env.DB) return false;
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const hour = Math.floor(Date.now() / 3600000);
  const db = env.DB;
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS fetches (ip TEXT NOT NULL, hour INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (ip, hour))`).run();
    const [, , row] = await db.batch([
      db.prepare(`DELETE FROM fetches WHERE hour < ?`).bind(hour - 1),
      db.prepare(`INSERT INTO fetches (ip, hour, n) VALUES (?, ?, 1) ON CONFLICT (ip, hour) DO UPDATE SET n = n + 1`).bind(ip, hour),
      db.prepare(`SELECT n FROM fetches WHERE ip = ? AND hour = ?`).bind(ip, hour),
    ]);
    return row.results[0].n > PER_HOUR;
  } catch (e) {
    return false; // the limit is a safeguard; a database hiccup doesn't stop reading
  }
}

export async function handleFetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/fetch') return null;
  if (request.method !== 'GET') return fail(405, 'Method not allowed');
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') return fail(403, 'Forbidden');
  const selfHost = url.hostname.toLowerCase();
  let target = publicUrl(url.searchParams.get('url') || '', selfHost);
  if (!target) return fail(400, 'That address can’t be opened.');
  if (await tooMany(env, request)) return fail(429, 'Too many requests. Please wait a little.');

  // A login is forwarded only to the catalog it belongs to (its origin, over https), on every hop.
  const auth = request.headers.get('X-Folio-Auth') || '';
  const authOrigin = request.headers.get('X-Folio-Auth-Origin') || '';
  let res;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    for (let hop = 0; ; hop++) {
      const headers = {
        'User-Agent': 'Folio-Reader/1.0 (OPDS)',
        Accept: 'application/atom+xml, application/opds+json, application/xml, application/json, application/epub+zip, application/pdf, */*;q=0.5',
      };
      // The catalog's login goes only to the catalog's own host, never on to another one.
      if (auth && /^(Basic|Bearer) [\w+/=.\-~]{1,2000}$/.test(auth) && target.protocol === 'https:' && target.origin === authOrigin) headers.Authorization = auth;
      res = await fetch(target.href, { headers, redirect: 'manual', signal: ac.signal });
      if (res.status < 300 || res.status > 399) break;
      const next = res.headers.get('Location');
      if (!next || hop >= MAX_REDIRECTS) return fail(502, 'The catalog sent Folio round in circles.');
      target = publicUrl(new URL(next, target).href, selfHost);
      if (!target) return fail(400, 'The catalog pointed somewhere Folio doesn’t go.');
    }
  } catch (e) {
    clearTimeout(timer);
    return fail(502, 'Couldn’t reach the catalog.');
  }
  if (res.status === 401) {
    clearTimeout(timer);
    return fail(401, 'This catalog needs a login.');
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    return fail(502, `The catalog answered ${res.status}.`);
  }
  const declared = Number(res.headers.get('Content-Length') || 0);
  if (declared > MAX_BOOK) {
    clearTimeout(timer);
    return fail(413, 'That file is too big.');
  }

  // Look at the first bytes, then pass the rest on as it arrives (counting, with a ceiling).
  const reader = res.body.getReader();
  let first = new Uint8Array(0);
  while (first.length < 512) {
    const { value, done } = await reader.read();
    if (done) break;
    const joined = new Uint8Array(first.length + value.length);
    joined.set(first);
    joined.set(value, first.length);
    first = joined;
  }
  const kind = kindOf(first);
  if (!kind) {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
    return fail(415, 'That isn’t a catalog or a book Folio can read.');
  }
  const max = kind === 'feed' ? MAX_FEED : MAX_BOOK;
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  (async () => {
    let total = first.length;
    try {
      if (total > max) throw new Error('too big');
      await writer.write(first);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > max) throw new Error('too big');
        await writer.write(value);
      }
      await writer.close();
    } catch (e) {
      reader.cancel().catch(() => {});
      writer.abort(e).catch(() => {});
    } finally {
      clearTimeout(timer);
    }
  })();
  const headers = Object.assign({}, HEADERS, {
    // For the app: what it really is, and where it ended up (to resolve the catalog's relative links).
    'X-Folio-Kind': kind,
    'X-Folio-Type': (res.headers.get('Content-Type') || '').replace(/[^\x20-\x7e]/g, '').slice(0, 200),
    'X-Folio-Url': target.href,
  });
  // (A hint for progress bars: the real length is only known for uncompressed answers.)
  if (declared && declared <= max && !res.headers.get('Content-Encoding')) headers['X-Folio-Length'] = String(declared);
  return new Response(readable, { headers });
}
