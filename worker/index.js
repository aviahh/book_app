// Cloudflare Worker: a small relay for Microsoft Edge's neural voices
// (the same service and voices EZ_shortcut uses via edge-tts).
//
// Browsers can't talk to the voice service directly (it only accepts
// connections that look like the Edge browser), so the reader asks
//   GET /api/tts?v=<voice>&t=<text>[&r=<rate>]
// and this Worker opens the service's WebSocket, forwards the request, and
// streams the MP3 back as it arrives — playback starts within a moment.
//
// Sync (accounts and reading data) lives in sync.js; the relay for book catalogs in fetch.js.
// Everything else is served straight from the static app (see wrangler.jsonc).

import { handleSync } from './sync.js';
import { handleFetch } from './fetch.js';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split('.')[0];
const WSS_BASE = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const MAX_TEXT = 3000;
const VOICE_RE = /^[a-z]{2,3}-[A-Z]{2,4}(-[A-Za-z]+)?-[A-Za-z]+Neural$/;
const RATE_RE = /^[+-]\d{1,3}%$/;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const uuid = () => crypto.randomUUID().replaceAll('-', '');

/** Sec-MS-GEC: SHA-256 of (Windows file time rounded down to 5 minutes) + token. */
async function secMsGec() {
  let secs = Math.floor(Date.now() / 1000) + 11644473600;
  secs -= secs % 300;
  const ticks = (BigInt(secs) * 10_000_000n).toString();
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticks + TRUSTED_CLIENT_TOKEN))).toUpperCase();
}

const jsDate = () => new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');

const escapeXml = (s) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

// The voice service turns away a large share of connections at random (a 403
// before any audio; often several in a row), and a moment later accepts the
// same request. So each request is tried again, after a short pause, until
// audio starts to arrive. Once it has, a failure is passed on as is (the
// listener never hears the start twice).
// (A refusal tends to last for the rest of that request: the app asks again with a fresh one,
// which usually gets through, rather than this one retrying for seconds.)
const RETRY_DELAYS = [150, 300];
const FIRST_AUDIO_MS = 10000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function tts(text, voice, rate) {
  let lastErr;
  for (let i = 0; i <= RETRY_DELAYS.length; i++) {
    if (i) await wait(RETRY_DELAYS[i - 1]);
    try {
      return await attempt(text, voice, rate);
    } catch (e) {
      lastErr = e;
    }
  }
  return new Response(`Voice service unavailable (${lastErr.message})`, { status: 502 });
}

/** One connection to the voice service; resolves with the audio stream once its first bytes arrive. */
async function attempt(text, voice, rate) {
  const url =
    `${WSS_BASE}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&ConnectionId=${uuid()}` +
    `&Sec-MS-GEC=${await secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}`;
  const upstream = await fetch(url, {
    headers: {
      Upgrade: 'websocket',
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`,
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: `muid=${uuid().toUpperCase()};`,
    },
  });
  const ws = upstream.webSocket;
  if (!ws) throw new Error(`refused: ${upstream.status}`);
  ws.accept();

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  let started = false;
  let begin;
  let fail;
  const firstAudio = new Promise((resolve, reject) => {
    begin = resolve;
    fail = reject;
  });
  let done = false;
  const finish = (err) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try {
      ws.close(1000);
    } catch {}
    if (!started) {
      // Nothing sent yet: this attempt failed and the caller tries again.
      writer.abort(err).catch(() => {});
      return fail(err || new Error('no audio'));
    }
    (err ? writer.abort(err) : writer.close()).catch(() => {});
  };
  const timer = setTimeout(() => finish(new Error('no audio in time')), FIRST_AUDIO_MS);

  // Messages are processed strictly in order (binary frames may arrive as Blobs).
  let queue = Promise.resolve();
  ws.addEventListener('message', (ev) => {
    queue = queue.then(async () => {
      if (typeof ev.data === 'string') {
        if (ev.data.includes('Path:turn.end')) finish();
        return;
      }
      const buf = ev.data instanceof ArrayBuffer ? ev.data : await ev.data.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (bytes.length < 2) return;
      const headerLen = (bytes[0] << 8) | bytes[1];
      const header = new TextDecoder().decode(bytes.subarray(2, 2 + headerLen));
      if (!header.includes('Path:audio')) return;
      const audio = bytes.subarray(2 + headerLen);
      if (!audio.length || done) return;
      if (!started) {
        started = true;
        clearTimeout(timer);
        begin();
      }
      await writer.write(audio).catch(() => finish());
    });
  });
  ws.addEventListener('close', () => (queue = queue.then(() => finish())));
  ws.addEventListener('error', () => finish(new Error('voice service error')));

  ws.send(
    `X-Timestamp:${jsDate()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
      '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},' +
      '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n',
  );
  const ssml =
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${voice}'><prosody pitch='+0Hz' rate='${rate}' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`;
  ws.send(`X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${jsDate()}Z\r\nPath:ssml\r\n\r\n${ssml}`);

  await firstAudio;
  return new Response(readable, {
    headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=3600' },
  });
}

/** The same neural voices through Microsoft's official Speech service (REST, one request per piece). */
async function azureTts(env, text, voice, rate) {
  const region = String(env.AZURE_SPEECH_REGION).replace(/[^a-z0-9]/gi, '');
  const lang = voice.split('-').slice(0, 2).join('-');
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>` +
    `<voice name='${voice}'><prosody rate='${rate}'>${escapeXml(text)}</prosody></voice></speak>`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'Folio',
      },
      body: ssml,
      signal: ac.signal,
    });
    if (!res.ok || !res.body) return null;
    return new Response(res.body, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=3600', 'X-Folio-Voice': 'azure' } });
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const synced = await handleSync(request, env);
    if (synced) return synced;
    const fetched = await handleFetch(request, env);
    if (fetched) return fetched;
    if (url.pathname !== '/api/tts') return new Response('Not found', { status: 404 });
    // Only serve the app itself, not other websites.
    const site = request.headers.get('Sec-Fetch-Site');
    if (site && site !== 'same-origin' && site !== 'none') return new Response('Forbidden', { status: 403 });
    const text = (url.searchParams.get('t') || '').trim();
    const voice = url.searchParams.get('v') || 'en-US-JennyNeural';
    const rate = url.searchParams.get('r') || '+0%';
    if (!text || text.length > MAX_TEXT || !VOICE_RE.test(voice) || !RATE_RE.test(rate)) {
      return new Response('Bad request', { status: 400 });
    }
    try {
      // Microsoft's official speech service when it's set up (AZURE_SPEECH_KEY and AZURE_SPEECH_REGION
      // as Worker secrets; its free tier covers 500,000 characters a month); the unofficial
      // Edge relay below when it isn't, or when the official one can't answer (e.g. the month's
      // free allowance is used up).
      if (env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION) {
        const official = await azureTts(env, text, voice, rate).catch(() => null);
        if (official) return official;
      }
      return await tts(text, voice, rate);
    } catch (e) {
      return new Response(`Voice service error: ${e.message}`, { status: 502 });
    }
  },
};
