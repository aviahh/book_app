// Cloudflare Worker: a small relay for Microsoft Edge's neural voices
// (the same service and voices EZ_shortcut uses via edge-tts).
//
// Browsers can't talk to the voice service directly (it only accepts
// connections that look like the Edge browser), so the reader asks
//   GET /api/tts?v=<voice>&t=<text>[&r=<rate>]
// and this Worker opens the service's WebSocket, forwards the request, and
// streams the MP3 back as it arrives — playback starts within a moment.
//
// Everything else is served straight from the static app (see wrangler.jsonc).

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

async function tts(text, voice, rate) {
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
  if (!ws) return new Response(`Voice service refused the connection (${upstream.status})`, { status: 502 });
  ws.accept();

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  let done = false;
  const finish = (err) => {
    if (done) return;
    done = true;
    try {
      ws.close(1000);
    } catch {}
    (err ? writer.abort(err) : writer.close()).catch(() => {});
  };

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
      if (audio.length && !done) await writer.write(audio).catch(() => finish());
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

  return new Response(readable, {
    headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=3600' },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
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
      return await tts(text, voice, rate);
    } catch (e) {
      return new Response(`Voice service error: ${e.message}`, { status: 502 });
    }
  },
};
