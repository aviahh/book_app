// Sync: accounts, devices and the small reading data (progress, bookmarks,
// series, settings, statistics), stored in Cloudflare D1.
//
// Every piece of data is one row, `items(user_id, k, v, t, dev, deleted, rev)`:
//   k        what it is ("s:theme", "b:<book>:prog", "b:<book>:bm:12" …)
//   v        its value (JSON)
//   t        when it was last changed (ms, the device's clock corrected to ours)
//   deleted  1 = removed (a tombstone, so the removal reaches other devices)
//   rev      a per-account counter: a device asks for everything newer than
//            the last rev it saw
// The newer change wins, row by row (on a tie the stored one stays).
//
// Sign-in is Google's (a plain redirect, no script from Google in the app),
// or a short code shown on a device that is already signed in. Each device
// then holds its own random token; only its SHA-256 is stored here.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const fail = (status, error) => json({ error }, status);

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));

const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O, 1/I/L
const randomCode = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');

const MINUTE = 60 * 1000;
const MAX_CHANGES = 500; // per request
const MAX_VALUE = 16 * 1024; // bytes of JSON per row
const KEY_RE = /^[\w:.\-]{1,200}$/;

// ---------------------------------------------------------------- schema

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, google_sub TEXT UNIQUE, email TEXT, rev INTEGER NOT NULL DEFAULT 0, grant_enc TEXT, created_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS devices (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, created_at INTEGER, last_seen INTEGER)`,
  `CREATE INDEX IF NOT EXISTS devices_user ON devices(user_id)`,
  `CREATE TABLE IF NOT EXISTS items (user_id TEXT NOT NULL, k TEXT NOT NULL, v TEXT, t INTEGER NOT NULL, dev TEXT, deleted INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL, PRIMARY KEY (user_id, k))`,
  `CREATE INDEX IF NOT EXISTS items_rev ON items(user_id, rev)`,
  // One-time codes: sign-in hand-over (after Google), device linking, and OAuth state.
  `CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id TEXT, data TEXT, expires INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS attempts (ip TEXT NOT NULL, hour INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (ip, hour))`,
  // Family libraries: the member may read the books in the owner's Drive.
  `CREATE TABLE IF NOT EXISTS shares (owner_id TEXT NOT NULL, member_id TEXT NOT NULL, created_at INTEGER, PRIMARY KEY (owner_id, member_id))`,
  `CREATE INDEX IF NOT EXISTS shares_member ON shares(member_id)`,
];

let schemaReady = null;
function ensureSchema(db) {
  schemaReady ??= db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => {
    schemaReady = null;
    throw e;
  });
  return schemaReady;
}

// ---------------------------------------------------------------- helpers

async function deviceOf(request, env) {
  const m = /^Bearer (.+)$/.exec(request.headers.get('Authorization') || '');
  if (!m) return null;
  const hash = await sha256(m[1]);
  const row = await env.DB.prepare(`SELECT d.user_id, d.name, d.last_seen, u.email FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?`)
    .bind(hash)
    .first();
  if (!row) return null;
  // Remember roughly when each device was last seen (at most one write a day).
  if (Date.now() - (row.last_seen || 0) > 24 * 60 * MINUTE) {
    await env.DB.prepare(`UPDATE devices SET last_seen = ? WHERE token_hash = ?`).bind(Date.now(), hash).run();
  }
  return { hash, userId: row.user_id, email: row.email, name: row.name };
}

/** A new device token for this account. */
async function newDevice(env, userId, name) {
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO devices (token_hash, user_id, name, created_at, last_seen) VALUES (?, ?, ?, ?, ?)`)
    .bind(await sha256(token), userId, String(name || 'Device').slice(0, 60), now, now)
    .run();
  return token;
}

async function putCode(env, kind, minutes, { userId = null, data = null, length = 0 } = {}) {
  const code = length ? randomCode(length) : randomToken(24);
  await env.DB.prepare(`DELETE FROM codes WHERE expires < ?`).bind(Date.now()).run();
  await env.DB.prepare(`INSERT INTO codes (code, kind, user_id, data, expires) VALUES (?, ?, ?, ?, ?)`)
    .bind(code, kind, userId, data, Date.now() + minutes * MINUTE)
    .run();
  return code;
}

/** Use a one-time code (it is gone afterwards). */
async function takeCode(env, kind, code) {
  const row = await env.DB.prepare(`DELETE FROM codes WHERE code = ? AND kind = ? RETURNING user_id, data, expires`).bind(code, kind).first();
  return row && row.expires > Date.now() ? row : null;
}

/** At most `max` failed tries per address per hour (guessing link codes). */
async function tooManyTries(env, request, max = 20) {
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const hour = Math.floor(Date.now() / (60 * MINUTE));
  const row = await env.DB.prepare(`SELECT n FROM attempts WHERE ip = ? AND hour = ?`).bind(ip, hour).first();
  return { blocked: !!row && row.n >= max, ip, hour };
}
async function countTry(env, { ip, hour }) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM attempts WHERE hour < ?`).bind(hour - 1),
    env.DB.prepare(`INSERT INTO attempts (ip, hour, n) VALUES (?, ?, 1) ON CONFLICT (ip, hour) DO UPDATE SET n = n + 1`).bind(ip, hour),
  ]);
}

async function readBody(request) {
  try {
    return await request.json();
  } catch (e) {
    return null;
  }
}

const userIdFor = (sub) => sha256('folio-user:' + sub).then((h) => h.slice(0, 22));

/** Find or create the account for a Google identity. */
async function upsertUser(env, sub, email) {
  const id = await userIdFor(sub);
  await env.DB.prepare(
    `INSERT INTO users (id, google_sub, email, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET email = excluded.email`,
  )
    .bind(id, sub, email, Date.now())
    .run();
  return id;
}

// ---------------------------------------------------------------- Drive grant (stored encrypted)

async function grantKey(env) {
  if (!env.TOKEN_KEY) throw new Error('TOKEN_KEY is not set');
  const raw = await crypto.subtle.digest('SHA-256', enc.encode('folio-grant:' + env.TOKEN_KEY));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function sealGrant(env, refreshToken) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await grantKey(env), enc.encode(refreshToken)));
  const all = new Uint8Array(12 + ct.length);
  all.set(iv);
  all.set(ct, 12);
  return 'v1.' + b64url(all);
}

async function openGrant(env, sealed) {
  const s = sealed.slice(3).replace(/-/g, '+').replace(/_/g, '/');
  const all = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await grantKey(env), all.slice(12));
  return new TextDecoder().decode(pt);
}

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** Start giving Folio access to its own folder in the account's Google Drive. */
async function driveConnect(url, dev, env) {
  if (env.DEV_LOGIN === '1' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    await env.DB.prepare(`UPDATE users SET grant_enc = 'dev' WHERE id = ?`).bind(dev.userId).run();
    return json({ url: '/#/settings?drive=on' });
  }
  if (!env.GOOGLE_CLIENT_ID) return fail(503, 'Google Drive is not set up yet.');
  const state = await putCode(env, 'state', 15, { data: JSON.stringify({ drive: dev.userId }) });
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(url),
    response_type: 'code',
    scope: `openid email ${DRIVE_SCOPE}`,
    state,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    login_hint: dev.email || '',
  });
  return json({ url: `${GOOGLE_AUTH}?${q}` });
}

/** A short-lived Drive access token for this account (the app talks to Drive itself). */
async function driveToken(dev, env) {
  const r = await accessTokenFor(env, dev.userId);
  return r.error ? fail(r.status, r.error) : json({ token: r.token, expiresIn: r.expiresIn });
}

async function accessTokenFor(env, userId) {
  const row = await env.DB.prepare(`SELECT grant_enc FROM users WHERE id = ?`).bind(userId).first();
  if (!row || !row.grant_enc) return { status: 409, error: 'no-drive' };
  if (row.grant_enc === 'dev' && env.DEV_LOGIN === '1') return { token: 'dev-token', expiresIn: 3600 };
  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: await openGrant(env, row.grant_enc),
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Access was withdrawn in the Google account: forget it, so the switch shows off.
    if (data.error === 'invalid_grant') {
      await env.DB.prepare(`UPDATE users SET grant_enc = NULL WHERE id = ?`).bind(userId).run();
      return { status: 409, error: 'no-drive' };
    }
    return { status: 502, error: 'Google didn’t answer' };
  }
  return { token: data.access_token, expiresIn: data.expires_in || 3600 };
}

async function driveDisconnect(dev, env) {
  const row = await env.DB.prepare(`SELECT grant_enc FROM users WHERE id = ?`).bind(dev.userId).first();
  if (row && row.grant_enc && row.grant_enc !== 'dev') {
    try {
      const token = await openGrant(env, row.grant_enc);
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' });
    } catch (e) {}
  }
  await env.DB.prepare(`UPDATE users SET grant_enc = NULL WHERE id = ?`).bind(dev.userId).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------- Google sign-in

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

function callbackUrl(url) {
  return `${url.origin}/api/auth/google/callback`;
}

async function googleStart(url, env) {
  if (!env.GOOGLE_CLIENT_ID) return new Response('Sign-in is not set up yet.', { status: 503 });
  const name = (url.searchParams.get('name') || '').slice(0, 60);
  const state = await putCode(env, 'state', 15, { data: JSON.stringify({ name }) });
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(url),
    response_type: 'code',
    scope: 'openid email',
    state,
    prompt: 'select_account',
  });
  return Response.redirect(`${GOOGLE_AUTH}?${q}`, 302);
}

/** Back from Google: check who it is, then hand a one-time code to the app (never the token itself in an address). */
async function googleCallback(url, env) {
  const back = (hash) => Response.redirect(`${url.origin}/#/settings?${hash}`, 302);
  const st = await takeCode(env, 'state', url.searchParams.get('state') || '');
  if (!st) return back('signin_error=expired');
  if (url.searchParams.get('error') || !url.searchParams.get('code')) return back(st.data && st.data.indexOf('"drive"') >= 0 ? 'drive_error=cancelled' : 'signin_error=cancelled');
  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: url.searchParams.get('code'),
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl(url),
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) return back('signin_error=google');
  const tok = await res.json();
  // The ID token came straight from Google over TLS, so its claims can be read without checking the signature.
  let claims;
  try {
    const part = tok.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part), (c) => c.charCodeAt(0))));
  } catch (e) {
    return back('signin_error=google');
  }
  if (claims.aud !== env.GOOGLE_CLIENT_ID || !claims.sub || claims.email_verified === false) return back('signin_error=google');
  const asked = JSON.parse(st.data || '{}');
  if (asked.drive) {
    // Back from allowing Drive: only for the same Google account that is signed in.
    if ((await userIdFor(claims.sub)) !== asked.drive) return back('drive_error=account');
    if (!tok.refresh_token || !String(tok.scope || '').includes(DRIVE_SCOPE)) return back('drive_error=denied');
    await env.DB.prepare(`UPDATE users SET grant_enc = ? WHERE id = ?`).bind(await sealGrant(env, tok.refresh_token), asked.drive).run();
    return back('drive=on');
  }
  const userId = await upsertUser(env, claims.sub, claims.email || '');
  const name = asked.name || '';
  const code = await putCode(env, 'login', 5, { userId, data: JSON.stringify({ name }) });
  return back(`signin=${code}`);
}

/** Local testing only (`wrangler dev` with DEV_LOGIN=1 in .dev.vars): sign in as any address without Google. */
async function devLogin(url, env) {
  const host = url.hostname;
  if (env.DEV_LOGIN !== '1' || !(host === 'localhost' || host === '127.0.0.1')) return fail(404, 'Not found');
  const email = url.searchParams.get('email') || 'test@example.com';
  const userId = await upsertUser(env, 'dev:' + email, email);
  const code = await putCode(env, 'login', 5, { userId, data: JSON.stringify({ name: url.searchParams.get('name') || '' }) });
  return Response.redirect(`${url.origin}/#/settings?signin=${code}`, 302);
}

// ---------------------------------------------------------------- family libraries
//
// An owner shares with a code; whoever enters it may list the owner's books
// that are in Drive (title, cover) and download them, streamed from the
// owner's Drive through here. Nothing is stored or copied on the way, and
// the reader's progress stays in the reader's own account.

async function familyInvite(dev, env) {
  const g = await env.DB.prepare(`SELECT grant_enc FROM users WHERE id = ?`).bind(dev.userId).first();
  if (!g || !g.grant_enc) return fail(409, 'Turn on “Keep books in Google Drive” first: family read the books from there.');
  const code = await putCode(env, 'family', 24 * 60, { userId: dev.userId, length: 8 });
  return json({ code, expiresIn: 24 * 3600 });
}

async function familyJoin(request, dev, env) {
  const tries = await tooManyTries(env, request);
  if (tries.blocked) return fail(429, 'Too many tries. Wait an hour.');
  const body = await readBody(request);
  const code = String((body && body.code) || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
  const row = code.length === 8 && (await takeCode(env, 'family', code));
  if (!row) {
    await countTry(env, tries);
    return fail(400, 'That code didn’t work. Family codes last a day.');
  }
  if (row.user_id === dev.userId) return fail(400, 'That’s your own library.');
  await env.DB.prepare(`INSERT OR IGNORE INTO shares (owner_id, member_id, created_at) VALUES (?, ?, ?)`).bind(row.user_id, dev.userId, Date.now()).run();
  return json({ ok: true });
}

/** Libraries shared with me (their books in Drive), and who I share mine with. */
async function familyList(dev, env) {
  const db = env.DB;
  const owners = (await db.prepare(`SELECT s.owner_id AS id, u.email FROM shares s JOIN users u ON u.id = s.owner_id WHERE s.member_id = ?`).bind(dev.userId).all()).results;
  const members = (await db.prepare(`SELECT s.member_id AS id, u.email FROM shares s JOIN users u ON u.id = s.member_id WHERE s.owner_id = ?`).bind(dev.userId).all()).results;
  const libraries = [];
  for (const o of owners) {
    const { results } = await db
      .prepare(`SELECT k, v FROM items WHERE user_id = ? AND deleted = 0 AND (k LIKE 'b:%:meta' OR k LIKE 'b:%:cover' OR k LIKE 'b:%:drive' OR k LIKE 'b:%:series')`)
      .bind(o.id)
      .all();
    const by = new Map();
    for (const r of results) {
      const m = /^b:([0-9a-f]+):(\w+)$/.exec(r.k);
      if (!m) continue;
      if (!by.has(m[1])) by.set(m[1], { sid: m[1] });
      const v = JSON.parse(r.v);
      by.get(m[1])[m[2]] = m[2] === 'drive' ? { size: v && v.size } : v; // the file's Drive id stays private
    }
    libraries.push({ owner: o.id, email: o.email, books: [...by.values()].filter((b) => b.meta && b.drive) });
  }
  return json({ libraries, members });
}

async function familyRemove(request, dev, env) {
  const body = (await readBody(request)) || {};
  if (body.member) await env.DB.prepare(`DELETE FROM shares WHERE owner_id = ? AND member_id = ?`).bind(dev.userId, String(body.member)).run();
  if (body.owner) await env.DB.prepare(`DELETE FROM shares WHERE owner_id = ? AND member_id = ?`).bind(String(body.owner), dev.userId).run();
  return json({ ok: true });
}

/** A book from a family library, streamed from the owner's Drive. */
async function familyFile(url, dev, env) {
  const owner = url.searchParams.get('owner') || '';
  const sid = url.searchParams.get('sid') || '';
  if (!/^[0-9a-f]{8,64}$/.test(sid)) return fail(400, 'Bad request');
  const share = await env.DB.prepare(`SELECT 1 AS ok FROM shares WHERE owner_id = ? AND member_id = ?`).bind(owner, dev.userId).first();
  if (!share) return fail(403, 'This library isn’t shared with you any more.');
  const item = await env.DB.prepare(`SELECT v FROM items WHERE user_id = ? AND k = ? AND deleted = 0`).bind(owner, `b:${sid}:drive`).first();
  const copy = item && JSON.parse(item.v);
  if (!copy || !copy.id) return fail(404, 'This book is no longer in the shared library.');
  const tok = await accessTokenFor(env, owner);
  if (tok.error) return fail(409, 'The owner’s Google Drive isn’t connected any more.');
  const api = env.DEV_LOGIN === '1' && env.DRIVE_API ? env.DRIVE_API : 'https://www.googleapis.com'; // a stand-in Drive, for local tests only
  const url2 = `${api}/drive/v3/files/${encodeURIComponent(copy.id)}?alt=media`;
  const res = await fetch(url2, { headers: { Authorization: 'Bearer ' + tok.token } });
  if (!res.ok) return fail(res.status === 404 ? 404 : 502, 'Couldn’t get the book from Google Drive.');
  const headers = { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream', 'Cache-Control': 'no-store' };
  if (res.headers.get('Content-Length')) headers['Content-Length'] = res.headers.get('Content-Length');
  return new Response(res.body, { headers });
}

// ---------------------------------------------------------------- endpoints

async function redeemLogin(request, env) {
  const body = await readBody(request);
  const row = body && typeof body.code === 'string' && (await takeCode(env, 'login', body.code));
  if (!row) return fail(400, 'expired');
  const user = await env.DB.prepare(`SELECT email FROM users WHERE id = ?`).bind(row.user_id).first();
  const token = await newDevice(env, row.user_id, body.name);
  return json({ token, email: user ? user.email : '' });
}

async function pairCreate(dev, env) {
  const code = await putCode(env, 'pair', 10, { userId: dev.userId, length: 6 });
  return json({ code, expiresIn: 600 });
}

async function pairRedeem(request, env) {
  const tries = await tooManyTries(env, request);
  if (tries.blocked) return fail(429, 'Too many tries. Wait an hour.');
  const body = await readBody(request);
  const code = String((body && body.code) || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
  const row = code.length === 6 && (await takeCode(env, 'pair', code));
  if (!row) {
    await countTry(env, tries);
    return fail(400, 'That code didn’t work. Codes last 10 minutes.');
  }
  const user = await env.DB.prepare(`SELECT email FROM users WHERE id = ?`).bind(row.user_id).first();
  const token = await newDevice(env, row.user_id, body.name);
  return json({ token, email: user ? user.email : '' });
}

async function signOut(dev, env) {
  await env.DB.prepare(`DELETE FROM devices WHERE token_hash = ?`).bind(dev.hash).run();
  return json({ ok: true });
}

/**
 * One round trip: take this device's changes, return everything newer than
 * `since` (except what this device itself just sent).
 *   → { since, dev, changes: [{ k, v, t, d }] }
 *   ← { rev, now, changes: [{ k, v, t, d }], more }
 */
async function sync(request, dev, env) {
  const body = await readBody(request);
  if (!body || !Array.isArray(body.changes || [])) return fail(400, 'Bad request');
  const since = Math.max(0, Number(body.since) || 0);
  const devId = String(body.dev || '').slice(0, 40);
  const now = Date.now();
  const changes = (body.changes || []).slice(0, MAX_CHANGES).filter((c) => c && KEY_RE.test(c.k) && Number.isFinite(c.t));
  const db = env.DB;
  let rev;
  if (changes.length) {
    // One transaction: the new rev and the rows that carry it appear together,
    // so a device reading "everything after rev N" can never skip a row.
    const stmts = [db.prepare(`UPDATE users SET rev = rev + 1 WHERE id = ?`).bind(dev.userId)];
    for (const c of changes) {
      const v = c.d ? null : JSON.stringify(c.v === undefined ? null : c.v);
      if (v && v.length > MAX_VALUE) continue;
      // A clock far in the future can't win forever.
      const t = Math.min(Math.max(0, Math.floor(c.t)), now + 5 * MINUTE);
      stmts.push(
        db
          .prepare(
            `INSERT INTO items (user_id, k, v, t, dev, deleted, rev) VALUES (?, ?, ?, ?, ?, ?, (SELECT rev FROM users WHERE id = ?))
             ON CONFLICT (user_id, k) DO UPDATE SET v = excluded.v, t = excluded.t, dev = excluded.dev, deleted = excluded.deleted, rev = excluded.rev
             WHERE excluded.t > items.t`,
          )
          .bind(dev.userId, c.k, v, t, devId, c.d ? 1 : 0, dev.userId),
      );
    }
    stmts.push(db.prepare(`SELECT rev FROM users WHERE id = ?`).bind(dev.userId));
    const res = await db.batch(stmts);
    rev = res[res.length - 1].results[0].rev;
  } else {
    const r = await db.prepare(`SELECT rev FROM users WHERE id = ?`).bind(dev.userId).first();
    rev = r ? r.rev : 0;
  }
  const LIMIT = 2000;
  const { results } = await db
    .prepare(`SELECT k, v, t, deleted, rev, dev FROM items WHERE user_id = ? AND rev > ? ORDER BY rev LIMIT ?`)
    .bind(dev.userId, since, LIMIT + 1)
    .all();
  let more = false;
  let rows = results;
  let upTo = rev;
  if (rows.length > LIMIT) {
    // Very first sync of a big account: send it in parts, whole revs at a time.
    more = true;
    const lastRev = rows[LIMIT - 1].rev;
    rows = rows.filter((x) => x.rev < lastRev);
    if (!rows.length) rows = results.filter((x) => x.rev === lastRev);
    upTo = rows[rows.length - 1].rev;
  }
  const out = [];
  for (const x of rows) {
    if (x.rev === rev && x.dev === devId && changes.length) continue; // its own changes, just sent
    out.push(x.deleted ? { k: x.k, t: x.t, d: 1 } : { k: x.k, t: x.t, v: x.v == null ? null : JSON.parse(x.v) });
  }
  const g = await db.prepare(`SELECT grant_enc FROM users WHERE id = ?`).bind(dev.userId).first();
  return json({ rev: upTo, now, changes: out, more, email: dev.email, drive: !!(g && g.grant_enc) });
}

// ---------------------------------------------------------------- router

/** Handles /api/auth/*, /api/pair/*, /api/sync. Returns null for other paths. */
export async function handleSync(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!/^\/api\/(auth|pair|sync|drive|family)(\/|$)/.test(path)) return null;
  if (!env.DB) return fail(503, 'Sync is not set up yet.');
  await ensureSchema(env.DB);

  if (request.method === 'GET') {
    if (path === '/api/auth/google/start') return googleStart(url, env);
    if (path === '/api/auth/google/callback') return googleCallback(url, env);
    if (path === '/api/auth/dev') return devLogin(url, env);
    if (path === '/api/family/file') {
      const dev = await deviceOf(request, env);
      return dev ? familyFile(url, dev, env) : fail(401, 'signed-out');
    }
    return fail(404, 'Not found');
  }
  if (request.method !== 'POST') return fail(405, 'Method not allowed');
  // Only the app itself (same site) may call these.
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') return fail(403, 'Forbidden');

  if (path === '/api/auth/redeem') return redeemLogin(request, env);
  if (path === '/api/pair/redeem') return pairRedeem(request, env);

  const dev = await deviceOf(request, env);
  if (!dev) return fail(401, 'signed-out');
  if (path === '/api/sync') return sync(request, dev, env);
  if (path === '/api/pair/create') return pairCreate(dev, env);
  if (path === '/api/auth/signout') return signOut(dev, env);
  if (path === '/api/drive/connect') return driveConnect(url, dev, env);
  if (path === '/api/drive/token') return driveToken(dev, env);
  if (path === '/api/drive/disconnect') return driveDisconnect(dev, env);
  if (path === '/api/family/invite') return familyInvite(dev, env);
  if (path === '/api/family/join') return familyJoin(request, dev, env);
  if (path === '/api/family/list') return familyList(dev, env);
  if (path === '/api/family/remove') return familyRemove(request, dev, env);
  return fail(404, 'Not found');
}
