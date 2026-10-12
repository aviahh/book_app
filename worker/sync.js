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
// Accounts are Folio's own: a random id, with one or more sign-in identities
// attached (Google now; Apple and email codes later; never passwords).
// Library storage (Google Drive) is a separate connection of the account,
// and may be a different Google account than the one used to sign in.
//
// Sign-in is Google's (a plain redirect with PKCE and a nonce, no script from
// Google in the app), or a short code shown on a device that is already
// signed in. Each device then holds its own random token; only its SHA-256 is
// stored here, and a device unused for DEVICE_IDLE_DAYS is signed out.

const SECURE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, SECURE_HEADERS, extra) });
const fail = (status, error) => json({ error }, status);
const redirect = (to) => new Response(null, { status: 302, headers: Object.assign({ Location: to }, SECURE_HEADERS) });

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));

const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O, 1/I/L
// 256 is not a multiple of 31: draw again above the largest multiple, so every character is equally likely.
function randomCode(n) {
  let out = '';
  while (out.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) {
      if (b < 248 && out.length < n) out += CODE_CHARS[b % CODE_CHARS.length];
    }
  }
  return out;
}

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const MAX_CHANGES = 500; // per request
const MAX_VALUE = 16 * 1024; // bytes of JSON per row
const MAX_BODY = 1024 * 1024; // bytes per request
const KEY_RE = /^[\w:.\-]{1,200}$/;
const DEVICE_IDLE_DAYS = 180; // a device not used for this long has to sign in again
const REAUTH_SECONDS = 600; // deleting the account needs a Google sign-in this recent

// ---------------------------------------------------------------- schema

const SCHEMA = [
  // google_sub and grant_enc are from before accounts had identities and storage of their own (moved out, then cleared).
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, google_sub TEXT UNIQUE, email TEXT, rev INTEGER NOT NULL DEFAULT 0, grant_enc TEXT, created_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS devices (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, created_at INTEGER, last_seen INTEGER, id TEXT)`,
  `CREATE INDEX IF NOT EXISTS devices_user ON devices(user_id)`,
  `CREATE TABLE IF NOT EXISTS items (user_id TEXT NOT NULL, k TEXT NOT NULL, v TEXT, t INTEGER NOT NULL, dev TEXT, deleted INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL, PRIMARY KEY (user_id, k))`,
  `CREATE INDEX IF NOT EXISTS items_rev ON items(user_id, rev)`,
  // One-time codes: sign-in hand-over (after Google), device linking, OAuth state, recent re-sign-in.
  `CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id TEXT, data TEXT, expires INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS attempts (ip TEXT NOT NULL, hour INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (ip, hour))`,
  // Family libraries: the member may read the books in the owner's Drive.
  `CREATE TABLE IF NOT EXISTS shares (owner_id TEXT NOT NULL, member_id TEXT NOT NULL, created_at INTEGER, PRIMARY KEY (owner_id, member_id))`,
  `CREATE INDEX IF NOT EXISTS shares_member ON shares(member_id)`,
  // How someone signs in (provider "google"; later "apple", "email"). Several may lead to one account.
  `CREATE TABLE IF NOT EXISTS identities (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT, created_at INTEGER, last_used INTEGER, PRIMARY KEY (provider, subject))`,
  `CREATE INDEX IF NOT EXISTS identities_user ON identities(user_id)`,
  // Where the account's books live (Google Drive now). The grant is sealed with TOKEN_KEY.
  `CREATE TABLE IF NOT EXISTS storage (user_id TEXT PRIMARY KEY, provider TEXT NOT NULL, account TEXT, grant_enc TEXT NOT NULL, created_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,
];

// Accounts from before identities and storage were separate: move each one's
// Google identity and Drive grant into the new tables (one transaction), give
// every device a public id, then clear the old columns. Safe to run twice.
async function migrate(db) {
  const v = await db.prepare(`SELECT v FROM meta WHERE k = 'schema'`).first();
  if (v && Number(v.v) >= 2) return;
  try {
    await db.prepare(`ALTER TABLE devices ADD COLUMN id TEXT`).run();
  } catch (e) {
    if (!/duplicate column/i.test(String(e && e.message))) throw e;
  }
  await db.batch([
    db.prepare(`UPDATE devices SET id = lower(hex(randomblob(9))) WHERE id IS NULL`),
    db.prepare(
      `INSERT OR IGNORE INTO identities (provider, subject, user_id, email, created_at, last_used)
       SELECT CASE WHEN google_sub LIKE 'dev:%' THEN 'dev' ELSE 'google' END,
              CASE WHEN google_sub LIKE 'dev:%' THEN substr(google_sub, 5) ELSE google_sub END,
              id, email, created_at, created_at FROM users WHERE google_sub IS NOT NULL`,
    ),
    db.prepare(`INSERT OR IGNORE INTO storage (user_id, provider, account, grant_enc, created_at) SELECT id, 'gdrive', email, grant_enc, created_at FROM users WHERE grant_enc IS NOT NULL`),
    db.prepare(`UPDATE users SET google_sub = NULL, grant_enc = NULL WHERE google_sub IS NOT NULL OR grant_enc IS NOT NULL`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS devices_id ON devices(id)`),
    db.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', '2')`),
  ]);
}

let schemaReady = null;
function ensureSchema(db) {
  schemaReady ??= db
    .batch(SCHEMA.map((s) => db.prepare(s)))
    .then(() => migrate(db))
    .catch((e) => {
      schemaReady = null;
      throw e;
    });
  return schemaReady;
}

// ---------------------------------------------------------------- helpers

async function deviceOf(request, env) {
  const m = /^Bearer ([\w-]{20,100})$/.exec(request.headers.get('Authorization') || '');
  if (!m) return null;
  const hash = await sha256(m[1]);
  const row = await env.DB.prepare(`SELECT d.id, d.user_id, d.name, d.last_seen, u.email FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?`)
    .bind(hash)
    .first();
  if (!row) return null;
  const idle = Date.now() - (row.last_seen || 0);
  if (idle > DEVICE_IDLE_DAYS * DAY) {
    // Not used for months: that sign-in has ended (a lost or sold device stops being a way in).
    await env.DB.prepare(`DELETE FROM devices WHERE token_hash = ?`).bind(hash).run();
    return null;
  }
  // Remember roughly when each device was last seen (at most one write a day).
  if (idle > DAY) {
    await env.DB.prepare(`UPDATE devices SET last_seen = ? WHERE token_hash = ?`).bind(Date.now(), hash).run();
  }
  return { hash, id: row.id, userId: row.user_id, email: row.email, name: row.name };
}

/** A device name to show in the account: plain, short text. */
const cleanName = (name) =>
  String(name || '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 60) || 'Device';

/** A new device token for this account. */
async function newDevice(env, userId, name) {
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO devices (token_hash, id, user_id, name, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(await sha256(token), randomToken(9), userId, cleanName(name), now, now)
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
  if (typeof code !== 'string' || !code || code.length > 64) return null;
  const row = await env.DB.prepare(`DELETE FROM codes WHERE code = ? AND kind = ? RETURNING user_id, data, expires`).bind(code, kind).first();
  return row && row.expires > Date.now() ? row : null;
}

/** At most `max` failed tries per address per hour (guessing short codes). */
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
    if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) return null;
    const text = await request.text();
    return text.length > MAX_BODY ? null : JSON.parse(text);
  } catch (e) {
    return null;
  }
}

const isLocal = (url) => url.hostname === 'localhost' || url.hostname === '127.0.0.1';
const devMode = (url, env) => env.DEV_LOGIN === '1' && isLocal(url);

// ---------------------------------------------------------------- accounts and identities

/**
 * The account a sign-in identity belongs to, created on its first sign-in.
 * Account ids are random: they say nothing about the identity behind them.
 */
async function accountFor(env, provider, subject, email) {
  const db = env.DB;
  const now = Date.now();
  const found = await accountOf(env, provider, subject);
  if (found) {
    await db.batch([
      db.prepare(`UPDATE identities SET email = ?, last_used = ? WHERE provider = ? AND subject = ?`).bind(email, now, provider, subject),
      db.prepare(`UPDATE users SET email = ? WHERE id = ?`).bind(email, found),
    ]);
    return found;
  }
  const id = randomToken(16);
  // Two first sign-ins at once: the identity's key lets only one account in.
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO identities (provider, subject, user_id, email, created_at, last_used) VALUES (?, ?, ?, ?, ?, ?)`).bind(provider, subject, id, email, now, now),
    db
      .prepare(`INSERT INTO users (id, email, created_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM identities WHERE provider = ? AND subject = ? AND user_id = ?)`)
      .bind(id, email, now, provider, subject, id),
  ]);
  return accountOf(env, provider, subject);
}

/** The account that a sign-in identity belongs to (null if none). */
async function accountOf(env, provider, subject) {
  const r = await env.DB.prepare(`SELECT user_id FROM identities WHERE provider = ? AND subject = ?`).bind(provider, subject).first();
  return r ? r.user_id : null;
}

// ---------------------------------------------------------------- Drive grant (stored encrypted)

async function grantKey(env) {
  if (!env.TOKEN_KEY) throw new Error('TOKEN_KEY is not set');
  const raw = await crypto.subtle.digest('SHA-256', enc.encode('folio-grant:' + env.TOKEN_KEY));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// The account id is bound into the encryption (additional data): a sealed
// grant copied onto another account's row doesn't open there.
async function sealGrant(env, userId, refreshToken) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(userId) }, await grantKey(env), enc.encode(refreshToken)));
  const all = new Uint8Array(12 + ct.length);
  all.set(iv);
  all.set(ct, 12);
  return 'v2.' + b64url(all);
}

async function openGrant(env, userId, sealed) {
  const s = sealed.slice(3).replace(/-/g, '+').replace(/_/g, '/');
  const all = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const params = { name: 'AES-GCM', iv: all.slice(0, 12) };
  if (sealed.slice(0, 3) === 'v2.') params.additionalData = enc.encode(userId); // v1: sealed before accounts had their own ids
  const pt = await crypto.subtle.decrypt(params, await grantKey(env), all.slice(12));
  return new TextDecoder().decode(pt);
}

/** Withdraw a Drive grant at Google (best effort: it is forgotten here either way). */
async function revokeGrant(env, userId, sealed) {
  if (!sealed || sealed === 'dev') return;
  try {
    const token = await openGrant(env, userId, sealed);
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
  } catch (e) {}
}

// The whole Drive: Folio's library is a folder you can also fill by hand (from a computer,
// a phone …), and Folio must see those files too. Folio itself only ever touches that folder.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

/** Start giving Folio access to its folder in a Google Drive (any Google account; usually the one signed in with). */
async function driveConnect(url, dev, env) {
  if (devMode(url, env)) {
    // Local testing: no trip to Google, but the same hand-over as after one.
    const code = await putCode(env, 'drive', 10, { userId: dev.userId, data: JSON.stringify({ sealed: 'dev', account: dev.email }) });
    return json({ url: `/#/settings?drive_code=${code}` });
  }
  if (!env.GOOGLE_CLIENT_ID) return fail(503, 'Google Drive is not set up yet.');
  return json({
    url: await googleUrl(url, env, { drive: dev.userId }, { scope: `openid email ${DRIVE_SCOPE}`, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', login_hint: dev.email || '' }),
  });
}

/** A short-lived Drive access token for this account (the app talks to Drive itself). */
async function driveToken(dev, env) {
  const r = await accessTokenFor(env, dev.userId);
  return r.error ? fail(r.status, r.error) : json({ token: r.token, expiresIn: r.expiresIn });
}

async function accessTokenFor(env, userId) {
  const row = await env.DB.prepare(`SELECT grant_enc FROM storage WHERE user_id = ? AND provider = 'gdrive'`).bind(userId).first();
  if (!row) return { status: 409, error: 'no-drive' };
  if (row.grant_enc === 'dev') return env.DEV_LOGIN === '1' ? { token: 'dev-token', expiresIn: 3600 } : { status: 409, error: 'no-drive' };
  let refresh;
  try {
    refresh = await openGrant(env, userId, row.grant_enc);
  } catch (e) {
    return { status: 500, error: 'Couldn’t open the Drive connection.' };
  }
  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: 'refresh_token' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Access was withdrawn in the Google account: forget it, so the switch shows off.
    if (data.error === 'invalid_grant') {
      await env.DB.prepare(`DELETE FROM storage WHERE user_id = ?`).bind(userId).run();
      return { status: 409, error: 'no-drive' };
    }
    return { status: 502, error: 'Google didn’t answer' };
  }
  return { token: data.access_token, expiresIn: data.expires_in || 3600 };
}

/** Back from allowing Drive: keep the grant, if this is the account that asked for it. */
async function driveFinish(request, dev, env) {
  const body = (await readBody(request)) || {};
  const row = await takeCode(env, 'drive', String(body.code || ''));
  if (!row) return fail(400, 'expired');
  const got = JSON.parse(row.data || '{}');
  if (row.user_id !== dev.userId) {
    // Someone else's trip ended here: that grant is withdrawn, never kept.
    await revokeGrant(env, row.user_id, got.sealed);
    return fail(403, 'account');
  }
  const old = await env.DB.prepare(`SELECT grant_enc FROM storage WHERE user_id = ?`).bind(dev.userId).first();
  await env.DB.prepare(`INSERT OR REPLACE INTO storage (user_id, provider, account, grant_enc, created_at) VALUES (?, 'gdrive', ?, ?, ?)`)
    .bind(dev.userId, got.account || '', got.sealed, Date.now())
    .run();
  if (old && old.grant_enc !== got.sealed) await revokeGrant(env, dev.userId, old.grant_enc); // replaced: the old one is withdrawn
  return json({ ok: true });
}

async function driveDisconnect(dev, env) {
  const row = await env.DB.prepare(`SELECT grant_enc FROM storage WHERE user_id = ?`).bind(dev.userId).first();
  if (row) await revokeGrant(env, dev.userId, row.grant_enc);
  await env.DB.prepare(`DELETE FROM storage WHERE user_id = ?`).bind(dev.userId).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------- Google sign-in

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

function callbackUrl(url) {
  return `${url.origin}/api/auth/google/callback`;
}

/**
 * The address of Google's sign-in page. What the trip is for (`asked`)
 * stays here, under a one-time state code, with a PKCE verifier and a nonce:
 * the answer must come back to this server, from this very trip.
 */
async function googleUrl(url, env, asked, params) {
  const verifier = randomToken(48);
  const nonce = randomToken(24);
  const state = await putCode(env, 'state', 15, { data: JSON.stringify(Object.assign({ verifier, nonce }, asked)) });
  const q = new URLSearchParams(
    Object.assign(
      {
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: callbackUrl(url),
        response_type: 'code',
        state,
        nonce,
        code_challenge: await sha256(verifier),
        code_challenge_method: 'S256',
      },
      params,
    ),
  );
  return `${GOOGLE_AUTH}?${q}`;
}

async function googleStart(url, env) {
  if (!env.GOOGLE_CLIENT_ID) return new Response('Sign-in is not set up yet.', { status: 503, headers: SECURE_HEADERS });
  const name = cleanName(url.searchParams.get('name'));
  return redirect(await googleUrl(url, env, { name }, { scope: 'openid email', prompt: 'select_account' }));
}

/** Read the ID token that came straight from Google's token endpoint (over TLS, for our client secret). */
function idClaims(tok, env, asked) {
  let claims;
  try {
    const part = tok.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part), (c) => c.charCodeAt(0))));
  } catch (e) {
    return null;
  }
  const now = Date.now() / 1000;
  if (GOOGLE_ISSUERS.indexOf(claims.iss) < 0 || claims.aud !== env.GOOGLE_CLIENT_ID || !claims.sub) return null;
  if (!(claims.exp > now - 60) || claims.nonce !== asked.nonce) return null;
  if (claims.email_verified !== true && claims.email_verified !== 'true') return null;
  return claims;
}

/** Back from Google: check who it is, then hand a one-time code to the app (never a token in an address). */
async function googleCallback(url, env) {
  const back = (hash) => redirect(`${url.origin}/#/settings?${hash}`);
  const st = await takeCode(env, 'state', url.searchParams.get('state') || '');
  if (!st) return back('signin_error=expired');
  const asked = JSON.parse(st.data || '{}');
  const why = asked.drive ? 'drive_error' : asked.reauth ? 'confirm_error' : 'signin_error';
  const backTo = (hash) => (asked.reauth ? redirect(`${url.origin}/#/account?${hash}`) : back(hash));
  if (url.searchParams.get('error') || !url.searchParams.get('code')) return backTo(`${why}=cancelled`);
  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: url.searchParams.get('code'),
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl(url),
      grant_type: 'authorization_code',
      code_verifier: asked.verifier,
    }),
  });
  if (!res.ok) return backTo(`${why}=google`);
  const tok = await res.json();
  const claims = idClaims(tok, env, asked);
  if (!claims) return backTo(`${why}=google`);
  if (asked.drive) {
    // The account that asked still exists, and Drive access was really given.
    const user = await env.DB.prepare(`SELECT 1 AS ok FROM users WHERE id = ?`).bind(asked.drive).first();
    if (!user) return back('drive_error=expired');
    if (!tok.refresh_token || String(tok.scope || '').split(' ').indexOf(DRIVE_SCOPE) < 0) return back('drive_error=denied');
    // Not stored yet: whoever finished this trip may not be the account that started it (a link
    // forwarded to someone else). The grant waits under a one-time code that only the starting
    // account, signed in on this very browser, can take (POST /api/drive/finish).
    const sealed = await sealGrant(env, asked.drive, tok.refresh_token);
    const code = await putCode(env, 'drive', 10, { userId: asked.drive, data: JSON.stringify({ sealed, account: claims.email || '' }) });
    return back(`drive_code=${code}`);
  }
  if (asked.reauth) {
    // Confirming it's really you (before deleting the account): the same Google identity, signed in just now.
    if ((await accountOf(env, 'google', claims.sub)) !== asked.reauth) return backTo('confirm_error=account');
    // Google states when the person last really signed in (auth_time) when it knows; a stale one is refused.
    if (claims.auth_time && !(claims.auth_time > Date.now() / 1000 - REAUTH_SECONDS)) return backTo('confirm_error=google');
    const code = await putCode(env, 'reauth', 10, { userId: asked.reauth });
    return backTo(`confirm=${code}`);
  }
  const userId = await accountFor(env, 'google', claims.sub, claims.email || '');
  const code = await putCode(env, 'login', 5, { userId, data: JSON.stringify({ name: asked.name || '' }) });
  return back(`signin=${code}`);
}

/** Local testing only (`wrangler dev` with DEV_LOGIN=1 in .dev.vars): sign in as any address without Google. */
async function devLogin(url, env) {
  if (!devMode(url, env)) return fail(404, 'Not found');
  const email = url.searchParams.get('email') || 'test@example.com';
  const userId = await accountFor(env, 'dev', email, email);
  const code = await putCode(env, 'login', 5, { userId, data: JSON.stringify({ name: url.searchParams.get('name') || '' }) });
  return redirect(`${url.origin}/#/settings?signin=${code}`);
}

// ---------------------------------------------------------------- the account itself

/** Everything the Account screen shows. */
async function accountInfo(dev, env) {
  const db = env.DB;
  const [user, ids, devices, store] = await db.batch([
    db.prepare(`SELECT email, created_at FROM users WHERE id = ?`).bind(dev.userId),
    db.prepare(`SELECT provider, email, created_at, last_used FROM identities WHERE user_id = ? ORDER BY created_at`).bind(dev.userId),
    db.prepare(`SELECT id, name, created_at, last_seen FROM devices WHERE user_id = ? ORDER BY last_seen DESC`).bind(dev.userId),
    db.prepare(`SELECT provider, account, created_at FROM storage WHERE user_id = ?`).bind(dev.userId),
  ]);
  const u = user.results[0] || {};
  const s = store.results[0];
  return json({
    email: u.email || '',
    created: u.created_at || 0,
    signIns: ids.results.map((r) => ({ provider: r.provider, email: r.email, created: r.created_at, lastUsed: r.last_used })),
    devices: devices.results.map((r) => ({ id: r.id, name: r.name, created: r.created_at, lastSeen: r.last_seen, current: r.id === dev.id })),
    storage: s ? { provider: s.provider, account: s.account, created: s.created_at } : null,
  });
}

/** Sign another of this account's devices out (or this one). */
async function removeDevice(request, dev, env) {
  const body = (await readBody(request)) || {};
  const id = String(body.id || '');
  if (!/^[\w-]{6,40}$/.test(id)) return fail(400, 'Bad request');
  await env.DB.prepare(`DELETE FROM devices WHERE id = ? AND user_id = ?`).bind(id, dev.userId).run();
  return json({ ok: true, self: id === dev.id });
}

/** A copy of everything the account holds here, as one JSON file (nothing secret in it). */
async function exportData(dev, env) {
  const db = env.DB;
  const [user, ids, devices, store, items, owners, members] = await db.batch([
    db.prepare(`SELECT email, created_at FROM users WHERE id = ?`).bind(dev.userId),
    db.prepare(`SELECT provider, email, created_at, last_used FROM identities WHERE user_id = ?`).bind(dev.userId),
    db.prepare(`SELECT name, created_at, last_seen FROM devices WHERE user_id = ?`).bind(dev.userId),
    db.prepare(`SELECT provider, account, created_at FROM storage WHERE user_id = ?`).bind(dev.userId),
    db.prepare(`SELECT k, v, t FROM items WHERE user_id = ? AND deleted = 0 ORDER BY k`).bind(dev.userId),
    db.prepare(`SELECT u.email, s.created_at FROM shares s JOIN users u ON u.id = s.owner_id WHERE s.member_id = ?`).bind(dev.userId),
    db.prepare(`SELECT u.email, s.created_at FROM shares s JOIN users u ON u.id = s.member_id WHERE s.owner_id = ?`).bind(dev.userId),
  ]);
  const when = (t) => (t ? new Date(t).toISOString() : null);
  const u = user.results[0] || {};
  const data = {
    about: 'Everything Folio keeps for your account on its server. Your book files are not here: they are in your own Google Drive (or on your devices).',
    exported: when(Date.now()),
    account: { email: u.email || '', created: when(u.created_at) },
    signIns: ids.results.map((r) => ({ provider: r.provider, email: r.email, created: when(r.created_at), lastUsed: when(r.last_used) })),
    devices: devices.results.map((r) => ({ name: r.name, signedIn: when(r.created_at), lastSeen: when(r.last_seen) })),
    storage: store.results.map((r) => ({ provider: r.provider, account: r.account, connected: when(r.created_at) })),
    family: {
      librariesSharedWithYou: owners.results.map((r) => ({ from: r.email, since: when(r.created_at) })),
      yourLibrarySharedWith: members.results.map((r) => ({ with: r.email, since: when(r.created_at) })),
    },
    readingData: items.results.map((r) => ({ key: r.k, value: r.v == null ? null : JSON.parse(r.v), changed: when(r.t) })),
  };
  return json(data, 200, { 'Content-Disposition': 'attachment; filename="folio-account-data.json"' });
}

/** Deleting needs a fresh "it's me": a recent Google sign-in as this account. */
async function confirmStart(url, dev, env) {
  if (devMode(url, env)) {
    const code = await putCode(env, 'reauth', 10, { userId: dev.userId });
    return json({ url: `/#/account?confirm=${code}` });
  }
  if (!env.GOOGLE_CLIENT_ID) return fail(503, 'Sign-in is not set up yet.');
  const g = await env.DB.prepare(`SELECT email FROM identities WHERE user_id = ? AND provider = 'google'`).bind(dev.userId).first();
  if (!g) return fail(409, 'No Google sign-in on this account.');
  return json({ url: await googleUrl(url, env, { reauth: dev.userId }, { scope: 'openid email', max_age: String(Math.floor(REAUTH_SECONDS / 2)), login_hint: g.email || '', prompt: 'select_account' }) });
}

/** Delete the account and everything Folio keeps for it. Book files in the user's Drive are theirs and stay. */
async function deleteAccount(request, dev, env) {
  const body = (await readBody(request)) || {};
  const ok = await takeCode(env, 'reauth', String(body.code || ''));
  if (!ok || ok.user_id !== dev.userId) return fail(403, 'Please confirm it’s you again.');
  const db = env.DB;
  const id = dev.userId;
  const store = await db.prepare(`SELECT grant_enc FROM storage WHERE user_id = ?`).bind(id).first();
  if (store) await revokeGrant(env, id, store.grant_enc);
  await db.batch([
    db.prepare(`DELETE FROM items WHERE user_id = ?`).bind(id),
    db.prepare(`DELETE FROM devices WHERE user_id = ?`).bind(id),
    db.prepare(`DELETE FROM identities WHERE user_id = ?`).bind(id),
    db.prepare(`DELETE FROM storage WHERE user_id = ?`).bind(id),
    db.prepare(`DELETE FROM shares WHERE owner_id = ? OR member_id = ?`).bind(id, id),
    db.prepare(`DELETE FROM codes WHERE user_id = ?`).bind(id),
    db.prepare(`DELETE FROM users WHERE id = ?`).bind(id),
  ]);
  return json({ ok: true });
}

// ---------------------------------------------------------------- family libraries
//
// An owner shares with a code; whoever enters it may list the owner's books
// that are in Drive (title, cover) and download them, streamed from the
// owner's Drive through here. Nothing is stored or copied on the way, and
// the reader's progress stays in the reader's own account.

async function familyInvite(dev, env) {
  const g = await env.DB.prepare(`SELECT 1 AS ok FROM storage WHERE user_id = ?`).bind(dev.userId).first();
  if (!g) return fail(409, 'Turn on “Library in Google Drive” first: family read the books from there.');
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
  if (!copy || typeof copy.id !== 'string' || !/^[\w-]{1,200}$/.test(copy.id)) return fail(404, 'This book is no longer in the shared library.');
  const tok = await accessTokenFor(env, owner);
  if (tok.error) return fail(409, 'The owner’s Google Drive isn’t connected any more.');
  const api = env.DEV_LOGIN === '1' && env.DRIVE_API ? env.DRIVE_API : 'https://www.googleapis.com'; // a stand-in Drive, for local tests only
  const res = await fetch(`${api}/drive/v3/files/${encodeURIComponent(copy.id)}?alt=media`, { headers: { Authorization: 'Bearer ' + tok.token } });
  if (!res.ok) return fail(res.status === 404 ? 404 : 502, 'Couldn’t get the book from Google Drive.');
  // Always a download, never a page: whatever is in the file can't run here.
  const headers = Object.assign({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment' }, SECURE_HEADERS);
  if (res.headers.get('Content-Length')) headers['Content-Length'] = res.headers.get('Content-Length');
  return new Response(res.body, { headers });
}

// ---------------------------------------------------------------- endpoints

async function redeemLogin(request, env) {
  const body = await readBody(request);
  const row = body && (await takeCode(env, 'login', body.code));
  if (!row) return fail(400, 'expired');
  const user = await env.DB.prepare(`SELECT email FROM users WHERE id = ?`).bind(row.user_id).first();
  if (!user) return fail(400, 'expired');
  const token = await newDevice(env, row.user_id, body.name);
  return json({ token, email: user.email || '' });
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
  if (!user) return fail(400, 'That code didn’t work. Codes last 10 minutes.');
  const token = await newDevice(env, row.user_id, body.name);
  return json({ token, email: user.email || '' });
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
  const changes = (body.changes || []).slice(0, MAX_CHANGES).filter((c) => c && typeof c.k === 'string' && KEY_RE.test(c.k) && Number.isFinite(c.t));
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
  const g = await db.prepare(`SELECT 1 AS ok FROM storage WHERE user_id = ?`).bind(dev.userId).first();
  return json({ rev: upTo, now, changes: out, more, email: dev.email, drive: !!g });
}

// ---------------------------------------------------------------- router

const SIGNED_IN = {
  '/api/sync': (req, dev, env) => sync(req, dev, env),
  '/api/pair/create': (req, dev, env) => pairCreate(dev, env),
  '/api/auth/signout': (req, dev, env) => signOut(dev, env),
  '/api/drive/connect': (req, dev, env, url) => driveConnect(url, dev, env),
  '/api/drive/token': (req, dev, env) => driveToken(dev, env),
  '/api/drive/disconnect': (req, dev, env) => driveDisconnect(dev, env),
  '/api/drive/finish': (req, dev, env) => driveFinish(req, dev, env),
  '/api/family/invite': (req, dev, env) => familyInvite(dev, env),
  '/api/family/join': (req, dev, env) => familyJoin(req, dev, env),
  '/api/family/list': (req, dev, env) => familyList(dev, env),
  '/api/family/remove': (req, dev, env) => familyRemove(req, dev, env),
  '/api/account': (req, dev, env) => accountInfo(dev, env),
  '/api/account/device/remove': (req, dev, env) => removeDevice(req, dev, env),
  '/api/account/export': (req, dev, env) => exportData(dev, env),
  '/api/account/confirm': (req, dev, env, url) => confirmStart(url, dev, env),
  '/api/account/delete': (req, dev, env) => deleteAccount(req, dev, env),
};

/** Handles /api/auth/*, /api/pair/*, /api/sync, /api/drive/*, /api/family/*, /api/account/*. Returns null for other paths. */
export async function handleSync(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!/^\/api\/(auth|pair|sync|drive|family|account)(\/|$)/.test(path)) return null;
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
  // Only the app itself (same site) may call these. (Sign-in is a bearer token, never a cookie,
  // so another site can't act as the user anyway; this is a second lock.)
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') return fail(403, 'Forbidden');

  if (path === '/api/auth/redeem') return redeemLogin(request, env);
  if (path === '/api/pair/redeem') return pairRedeem(request, env);

  const handler = SIGNED_IN[path];
  if (!handler) return fail(404, 'Not found');
  const dev = await deviceOf(request, env);
  if (!dev) return fail(401, 'signed-out');
  return handler(request, dev, env, url);
}
