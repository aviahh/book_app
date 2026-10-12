// Google Translate (text + speech) and Microsoft neural voices, via free, key-less endpoints — the same
// services the EZ_shortcut project uses (translate.py / gTTS), called directly
// from the browser.
//
// Speech is "streamed" the way gTTS works under the hood: the text is split
// into short chunks (Google caps each request at ~200 characters) and each
// chunk's MP3 is played by an <audio> element as soon as its first bytes
// arrive, while the next chunk is already buffering in a second element.
// Playback therefore starts within a fraction of a second, even for long
// passages.

// ---------------------------------------------------------------- language

const SCRIPTS = [
  [/[֐-׿]/, 'iw'],
  [/[؀-ۿ]/, 'ar'],
  [/[Ѐ-ӿ]/, 'ru'],
  [/[Ͱ-Ͽ]/, 'el'],
  [/[぀-ヿ]/, 'ja'],
  [/[가-힯]/, 'ko'],
  [/[一-鿿]/, 'zh-CN'],
  [/[ऀ-ॿ]/, 'hi'],
];

/** Cheap script-based language guess; Latin text defaults to English. */
export function guessLang(text) {
  for (const [re, code] of SCRIPTS) if (re.test(text)) return code;
  return 'en';
}

export const isRtl = (code) => ['iw', 'he', 'ar', 'fa', 'ur'].includes(code);

// ---------------------------------------------------------------- translate

const ENDPOINTS = [
  (q, tl) =>
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&dt=bd&dj=1&q=${encodeURIComponent(q)}`,
  (q, tl) => `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=${tl}&q=${encodeURIComponent(q)}`,
];

const cache = new Map();

/**
 * Translate `text` into `target`. Resolves to
 * { text, source, alternatives: [{ pos, terms[] }] }.
 */
export async function translate(text, target) {
  const key = `${target}|${text}`;
  if (cache.has(key)) return cache.get(key);
  let lastErr;
  for (const build of ENDPOINTS) {
    try {
      const res = await fetch(build(text, target), { referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = parse(await res.json());
      if (out.text) {
        cache.set(key, out);
        return out;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('No translation');
}

function parse(data) {
  // gtx with dj=1: { sentences: [{trans}], src, dict: [{pos, terms}] }
  if (data && !Array.isArray(data) && data.sentences) {
    return {
      text: data.sentences.map((s) => s.trans || '').join(''),
      source: data.src,
      alternatives: (data.dict || []).map((d) => ({ pos: d.pos, terms: d.terms.slice(0, 5) })),
    };
  }
  // clients5 shapes: "text" | ["text"] | [["text","src"], ...]
  if (typeof data === 'string') return { text: data, source: null, alternatives: [] };
  if (Array.isArray(data)) {
    let src = null;
    const parts = data.map((item) => {
      if (typeof item === 'string') return item;
      if (Array.isArray(item)) {
        src ??= typeof item[1] === 'string' ? item[1] : null;
        return item[0] || '';
      }
      return '';
    });
    return { text: parts.join(''), source: src, alternatives: [] };
  }
  return { text: '', source: null, alternatives: [] };
}

// ---------------------------------------------------------------- speech

// Voices: Microsoft's neural voices (the ones EZ_shortcut uses), relayed by
// the app's own Cloudflare Worker at /api/tts. Google's voice is the fallback
// (and the only option on the local dev server), then the device's own voice.

/** Microsoft neural voice per language — Jenny and Hila match EZ_shortcut. */
export const EDGE_VOICES = {
  en: 'en-US-JennyNeural',
  iw: 'he-IL-HilaNeural',
  ar: 'ar-SA-ZariyahNeural',
  ru: 'ru-RU-SvetlanaNeural',
  fr: 'fr-FR-DeniseNeural',
  es: 'es-ES-ElviraNeural',
  de: 'de-DE-KatjaNeural',
  it: 'it-IT-ElsaNeural',
  pt: 'pt-BR-FranciscaNeural',
  nl: 'nl-NL-FennaNeural',
  pl: 'pl-PL-ZofiaNeural',
  uk: 'uk-UA-PolinaNeural',
  tr: 'tr-TR-EmelNeural',
  el: 'el-GR-AthinaNeural',
  hi: 'hi-IN-SwaraNeural',
  ja: 'ja-JP-NanamiNeural',
  ko: 'ko-KR-SunHiNeural',
  'zh-CN': 'zh-CN-XiaoxiaoNeural',
};

const LIMITS = { edge: 1200, google: 190 };

/**
 * Split text into pieces of at most `max` chars at sentence, then clause, then
 * word breaks. `firstMax` keeps the opening piece short so playback starts fast.
 */
export function chunkText(text, max = LIMITS.google, firstMax = max) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const chunks = [];
  let rest = clean;
  let limit = firstMax;
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    let cut = -1;
    for (const re of [/[.!?…]["'”’)]?\s/g, /[,;:—–]\s/g, /\s/g]) {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(window))) if (m.index > 40) cut = m.index + m[0].length;
      if (cut > 0) break;
    }
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
    limit = max;
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export const ttsUrl = (text, lang) =>
  `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}&total=1&idx=0&textlen=${text.length}&q=${encodeURIComponent(text)}`;

const edgeUrl = (text, voice) => `${new URL('api/tts', document.baseURI).href}?v=${encodeURIComponent(voice)}&t=${encodeURIComponent(text)}`;

/** Providers to try, best first, for a language and the user's voice preference. */
function providersFor(lang, prefer) {
  const list = [];
  if (prefer !== 'google' && EDGE_VOICES[lang]) list.push('edge');
  list.push('google');
  return list;
}

const urlFor = (provider, text, lang) => (provider === 'edge' ? edgeUrl(text, EDGE_VOICES[lang]) : ttsUrl(text, lang));

// A tenth of a second of silence, played inside a tap to "unlock" audio
// elements: iOS only lets an element play later, without a tap, once it has
// played something during one. It is in the same quality as the voices
// (24 kHz, 16-bit): some devices keep the audio output at the quality of the
// first sound an element plays, and an earlier telephone-quality (8 kHz)
// silence made the voices that followed sound muffled.
const SILENCE = (() => {
  const rate = 24000;
  const n = (rate / 10) * 2; // 0.1 s of 16-bit samples
  const b = new Uint8Array(44 + n); // zero-filled: 16-bit silence
  const dv = new DataView(b.buffer);
  const str = (o, t) => t.split('').forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  str(0, 'RIFF');
  dv.setUint32(4, 36 + n, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true); // bytes per second
  dv.setUint16(32, 2, true); // bytes per frame
  dv.setUint16(34, 16, true); // bits per sample
  str(36, 'data');
  dv.setUint32(40, n, true);
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return 'data:audio/wav;base64,' + btoa(bin);
})();

/** Apple devices need the unlock above; other browsers allow audio after any earlier tap. */
const NEEDS_UNLOCK = /iP(hone|ad|od)/.test(navigator.platform) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/**
 * A pausable, piece-by-piece speech player.
 *
 * Two ways to use it:
 *  - speak(text): one passage, split into pieces here;
 *  - speakFeed(feed): continuous reading. `feed()` resolves with the next
 *    pieces (sentences, each short enough for every voice) or null at the
 *    end; it is asked for more while earlier pieces play. `onPiece(i)` hears
 *    each piece as it starts, so the reader can highlight it and turn pages.
 *
 * Sound always goes through an ordinary <audio> element (the device's media
 * player, with its usual sound quality and effects; Web Audio was tried and
 * sounded thinner on some tablets).
 *
 * The Microsoft voice is gapless where the browser supports Media Source
 * Extensions: the pieces are joined into one continuous stream on a single
 * element. Upcoming pieces are downloaded ahead (READY_AHEAD); each clip's
 * own leading and trailing silence is cut at the join and replaced by a
 * pause that fits its punctuation, so sentences flow like one recording.
 * Elsewhere (older iPads, iPhones, the Google voice) two elements take
 * turns: one plays while the other holds the next piece.
 *
 * Only the last few pieces are kept behind the current one (for back()).
 */
const KEEP_BACK = 3; // pieces kept behind the current one (a few lines)
const READY_AHEAD = 4; // pieces downloaded ahead
const BUFFER_AHEAD = 40; // seconds of joined audio queued in the stream at most
const MAX_FETCHES = 2; // voice requests in flight at once (the service refuses bursts)
const MS = window.MediaSource;
const MSE_MP3 = !!(MS && MS.isTypeSupported && MS.isTypeSupported('audio/mpeg'));
const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;

/**
 * Where the voice really starts and ends in a clip (seconds), measured by
 * decoding it offline (no sound is played), and the pause to leave after it.
 */
function measureClip(bytes, text) {
  const t = text.trim();
  const pause = /[.!?…]["'”’)\]]*$/.test(t) ? 0.3 : /[,;:—–]["'”’)\]]*$/.test(t) ? 0.16 : 0.05;
  if (!OAC) return Promise.resolve({ lead: 0, voiceEnd: Infinity, pause });
  return new Promise((resolve) => {
    let ctx;
    try {
      ctx = new OAC(1, 2, 24000);
    } catch (e) {
      return resolve({ lead: 0, voiceEnd: Infinity, pause });
    }
    const done = (buffer) => {
      const d = buffer.getChannelData(0);
      const sr = buffer.sampleRate;
      const quiet = 0.006;
      let a = 0;
      while (a < d.length && Math.abs(d[a]) < quiet) a++;
      let b = d.length - 1;
      while (b > a && Math.abs(d[b]) < quiet) b--;
      if (b <= a) return resolve({ lead: 0, voiceEnd: Infinity, pause });
      // Small margins: the stream's timeline can differ from the decoder's by a frame.
      resolve({ lead: Math.max(0, a / sr - 0.06), voiceEnd: b / sr + 0.06, pause });
    };
    const fail = () => resolve({ lead: 0, voiceEnd: Infinity, pause });
    const p = ctx.decodeAudioData(bytes.slice(0), done, fail);
    if (p && p.then) p.then(done, fail);
  });
}

export class Speech {
  constructor({ onState, voice = () => 'microsoft', onPiece } = {}) {
    this.onState = onState || (() => {});
    this.onPiece = onPiece || (() => {});
    this.voicePref = voice;
    // Two elements: one plays while the other holds the next piece (or the
    // first one carries the whole joined stream).
    this.players = [new Audio(), new Audio()];
    for (const a of this.players) {
      a.preload = 'auto';
      a.addEventListener('ended', () => (a.dataset.real ? this.#advance() : this.ms && a === this.ms.audio && this.#msEnded()));
      a.addEventListener('error', () => (a.dataset.real || (this.ms && a === this.ms.audio)) && this.#onError());
    }
    this.state = 'idle';
    this.gen = 0;
    this.session = 0;
    this.blobs = new Map();
    this.bytes = new Map();
    this.chunks = [];
    this.index = 0;
    this.fetching = 0;
    this.waiting = [];
  }

  get active() {
    return this.state === 'playing' || this.state === 'paused' || this.state === 'loading';
  }

  /** Call from inside a tap (e.g. the speaker button): lets audio start later without one. */
  unlock() {
    if (this.active || !NEEDS_UNLOCK) return;
    for (const a of this.players) {
      delete a.dataset.real;
      a.src = SILENCE;
      const p = a.play();
      if (p && p.then) p.then(() => a.pause()).catch(() => {});
    }
    if (!this.speechUnlocked && 'speechSynthesis' in window) {
      this.speechUnlocked = true;
      try {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        speechSynthesis.speak(u);
      } catch (e) {}
    }
  }

  #begin(lang) {
    this.stop(true);
    this.unlock(); // in case this call is itself inside a tap
    this.lang = lang;
    this.providers = providersFor(lang, this.voicePref());
    this.preferred = this.providers[0];
    this.provider = this.providers[0];
    this.usingFallback = false;
  }

  speak(text, lang) {
    this.#begin(lang);
    this.feed = null;
    this.feedDone = true;
    this.chunks = chunkText(text, LIMITS[this.provider], Math.min(LIMITS[this.provider], 160));
    this.#playFrom(0);
  }

  /** Continuous reading: pieces come from `feed` as needed (see above). */
  speakFeed(feed, lang) {
    this.#begin(lang);
    this.feed = feed;
    this.feedDone = false;
    this.feeding = null;
    this.chunks = [];
    this.#playFrom(0);
  }

  /** Make sure piece i exists, asking the feed for more if needed. */
  async #ensure(i) {
    // Pieces belong to the reading (session), not to one playback attempt:
    // a rewind or a voice switch mid-request still keeps what arrives.
    const gen = this.gen;
    while (i >= this.chunks.length && !this.feedDone) {
      const session = this.session;
      if (!this.feeding) {
        this.feeding = Promise.resolve()
          .then(() => this.feed())
          .catch(() => null)
          .then((more) => {
            if (session !== this.session) return;
            this.feeding = null;
            if (more && more.length) this.chunks.push(...more);
            else this.feedDone = true;
          });
      }
      await this.feeding;
      if (gen !== this.gen) return false;
    }
    return i < this.chunks.length && this.chunks[i] != null;
  }

  /** Download piece i from the Microsoft voice (a few at a time, each retried once). */
  #download(i) {
    if (this.bytes.has(i)) return this.bytes.get(i);
    const url = urlFor('edge', this.chunks[i], this.lang);
    const get = () =>
      Promise.race([fetch(url), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))]).then((r) =>
        r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status)),
      );
    const slot = () => (this.fetching < MAX_FETCHES ? Promise.resolve() : new Promise((r) => this.waiting.push(r)));
    // The sentence playback starts with goes first, alone: the service turns requests away when
    // several come at once, and that is the one being waited for. The ones after it follow.
    const first = i !== this.startPiece && this.bytes.get(this.startPiece);
    const p = Promise.resolve(first && first.catch(() => {}))
      .then(slot)
      .then(() => {
        this.fetching++;
        const done = () => {
          this.fetching--;
          const next = this.waiting.shift();
          if (next) next();
        };
        // The voice service turns some requests away (it is shared with many); a fresh request
        // a moment later usually gets through. A few quick tries before giving up on the voice.
        const tries = (k) => get().catch((e) => (k >= 3 || navigator.onLine === false ? Promise.reject(e) : new Promise((r) => setTimeout(r, [300, 700, 1200][k])).then(() => tries(k + 1))));
        const q = tries(0).then((b) => (b.size > 64 && /audio|mpeg|octet/.test(b.type || 'audio') ? b : Promise.reject(new Error('no audio'))));
        q.then(done, done);
        return q;
      });
    this.bytes.set(i, p);
    return p;
  }

  /** A playable URL for piece i (two-element path): a blob for the Microsoft voice, the direct address for Google's. */
  #src(i) {
    if (this.provider !== 'edge') return Promise.resolve(urlFor(this.provider, this.chunks[i], this.lang));
    if (!this.blobs.has(i)) this.blobs.set(i, this.#download(i).then((b) => URL.createObjectURL(b)));
    return this.blobs.get(i);
  }

  #freeBlobs(keep = () => false) {
    for (const [i, p] of [...this.blobs]) {
      if (keep(i)) continue;
      p.then((u) => u.indexOf('blob:') === 0 && URL.revokeObjectURL(u), () => {});
      this.blobs.delete(i);
    }
    for (const i of [...this.bytes.keys()]) if (!keep(i)) this.bytes.delete(i);
  }

  /** Forget what lies more than a few pieces behind (audio, and the text of a continuous reading). */
  #forgetOld() {
    const first = this.index - KEEP_BACK;
    this.#freeBlobs((i) => i >= first);
    if (this.feed) for (let i = Math.max(0, first - 4); i < first; i++) this.chunks[i] = null;
  }

  /** (Re)start playback at piece i with the current provider. */
  #playFrom(i) {
    this.#msStop();
    const gen = ++this.gen;
    for (const a of this.players) {
      delete a.dataset.real;
      a.pause();
    }
    this.index = i;
    this.startPiece = i;
    this.cur = 0;
    this.#set('loading');
    if (this.provider === 'edge' && MSE_MP3 && !this.noMse) return this.#msStart(i, gen);
    return this.#elStart(i, gen);
  }

  // ---- one joined stream (Media Source Extensions)

  #msStart(i, gen) {
    const audio = this.players[0];
    const source = new MS();
    const ms = (this.ms = { gen, audio, source, sb: null, url: URL.createObjectURL(source), pieces: new Map(), next: 0, nextIndex: i, first: i, shown: -1, ended: false, pumping: false, started: false });
    audio.src = ms.url;
    source.addEventListener('sourceopen', () => {
      if (this.ms !== ms) return;
      try {
        ms.sb = source.addSourceBuffer('audio/mpeg');
        if (ms.sb.mode !== 'sequence') ms.sb.mode = 'sequence';
      } catch (e) {
        return this.#msFailed(ms);
      }
      this.#msPump();
    });
    this.msTimer = setInterval(() => this.#msTick(), 50);
  }

  #msStop() {
    clearInterval(this.msTimer);
    const ms = this.ms;
    this.ms = null;
    if (!ms) return;
    ms.audio.pause();
    ms.audio.removeAttribute('src');
    ms.audio.load();
    URL.revokeObjectURL(ms.url);
  }

  /** The stream can't be used here after all: carry on with two elements. */
  #msFailed(ms) {
    if (this.ms !== ms) return;
    this.noMse = true;
    this.#playFrom(this.index);
  }

  #appendTo(sb, bytes) {
    return new Promise((resolve, reject) => {
      const ok = () => (sb.removeEventListener('updateend', ok), sb.removeEventListener('error', bad), resolve());
      const bad = () => (sb.removeEventListener('updateend', ok), sb.removeEventListener('error', bad), reject(new Error('append failed')));
      sb.addEventListener('updateend', ok);
      sb.addEventListener('error', bad);
      sb.appendBuffer(bytes);
    });
  }

  /** Keep the stream fed: download ahead, and join pieces on as they arrive. */
  async #msPump() {
    const ms = this.ms;
    if (!ms || !ms.sb || ms.pumping || ms.ended) return;
    ms.pumping = true;
    try {
      while (this.ms === ms) {
        for (let k = ms.nextIndex; k < ms.nextIndex + READY_AHEAD; k++) {
          if (k < this.chunks.length && this.chunks[k] != null) this.#download(k).catch(() => {});
        }
        if (this.chunks.length < ms.nextIndex + READY_AHEAD && !this.feedDone) this.#ensure(ms.nextIndex + READY_AHEAD - 1);
        if (ms.next - ms.audio.currentTime > BUFFER_AHEAD) break; // plenty queued; the tick calls again
        if (!(await this.#ensure(ms.nextIndex))) {
          if (this.ms === ms && this.feedDone) {
            ms.ended = true;
            if (ms.source.readyState === 'open' && !ms.sb.updating) ms.source.endOfStream();
          }
          break;
        }
        const i = ms.nextIndex;
        const text = this.chunks[i];
        const blob = await this.#download(i);
        const bytes = await new Response(blob).arrayBuffer(); // Blob.arrayBuffer() is newer than some iPads
        const m = await measureClip(bytes, text);
        if (this.ms !== ms) return;
        const sb = ms.sb;
        // Place the clip so its voice starts right at the end of the last one,
        // and cut off its own silence on both sides.
        const at = ms.next;
        sb.appendWindowEnd = Infinity;
        sb.appendWindowStart = at;
        sb.timestampOffset = at - m.lead;
        if (m.voiceEnd !== Infinity) sb.appendWindowEnd = at - m.lead + m.voiceEnd + m.pause;
        await this.#appendTo(sb, bytes);
        if (this.ms !== ms) return;
        const end = sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : at;
        ms.pieces.set(i, { start: at, end, voice: m.voiceEnd !== Infinity ? m.voiceEnd - m.lead : 0 });
        ms.next = end;
        ms.nextIndex = i + 1;
        if (!ms.started) {
          ms.started = true;
          const gen = ms.gen;
          ms.audio.play().catch((e) => gen === this.gen && this.#playFailed(e));
        }
        this.#msTrim();
      }
    } catch (e) {
      if (this.ms === ms) {
        ms.pumping = false;
        // A download failed (voice service down): switch voice. Anything else: the stream itself.
        return /HTTP|timeout|no audio|fetch/i.test(String(e && e.message)) ? this.#onError() : this.#msFailed(ms);
      }
    }
    ms.pumping = false;
  }

  /** Drop audio from more than a few pieces back (memory). */
  #msTrim() {
    const ms = this.ms;
    const keep = ms && ms.pieces.get(this.index - KEEP_BACK);
    if (!keep || ms.sb.updating || keep.start < 1) return;
    try {
      ms.sb.remove(0, keep.start);
    } catch (e) {}
  }

  #msTick() {
    const ms = this.ms;
    if (!ms) return;
    const t = ms.audio.currentTime;
    for (const [i, p] of ms.pieces) {
      if (t >= p.start - 0.02 && t < p.end) {
        if (i !== ms.shown) {
          ms.shown = i;
          this.index = i;
          if (this.state === 'loading' && !ms.audio.paused) this.#set('playing');
          this.onPiece(i);
          this.#forgetOld();
          for (const k of [...ms.pieces.keys()]) if (k < i - KEEP_BACK) ms.pieces.delete(k);
        }
        break;
      }
    }
    if (!ms.pumping) this.#msPump();
  }

  #msEnded() {
    if (!this.ms || !this.ms.ended) return;
    this.#msStop();
    this.#set('idle', true);
  }

  // ---- two <audio> elements taking turns

  async #load(player, i, gen) {
    if (!(await this.#ensure(i))) return false;
    const url = await this.#src(i);
    if (gen !== this.gen) return false;
    player.dataset.real = '1';
    player.src = url;
    player.load();
    return true;
  }

  async #elStart(i, gen) {
    const [a, b] = this.players;
    try {
      if (!(await this.#load(a, i, gen))) {
        if (gen === this.gen) this.#set('idle', true);
        return;
      }
    } catch (e) {
      if (gen === this.gen) this.#onError();
      return;
    }
    if (gen !== this.gen) return;
    this.#load(b, i + 1, gen).catch(() => {});
    if (this.provider === 'edge') for (let k = i + 2; k < i + READY_AHEAD; k++) this.#ensure(k).then((ok) => ok && gen === this.gen && this.#src(k).catch(() => {}));
    this.onPiece(i);
    a.play()
      .then(() => gen === this.gen && this.state === 'loading' && this.#set('playing'))
      .catch((e) => gen === this.gen && this.#playFailed(e));
  }

  async #advance() {
    if (this.state === 'idle' || this.usingFallback || this.ms) return;
    const gen = this.gen;
    this.index++;
    const next = this.players[1 - this.cur];
    this.cur = 1 - this.cur;
    // Normally already loaded while the previous piece played; wait if not.
    try {
      if (!next.dataset.real && !(await this.#load(next, this.index, gen))) {
        if (gen === this.gen) this.#set('idle', true);
        return;
      }
    } catch (e) {
      if (gen === this.gen) this.#onError();
      return;
    }
    if (gen !== this.gen) return;
    this.onPiece(this.index);
    next.play().catch((e) => gen === this.gen && this.#playFailed(e));
    // Fetch the following piece into the element that just finished, and download further ahead.
    const spare = this.players[1 - this.cur];
    delete spare.dataset.real;
    this.#load(spare, this.index + 1, gen).catch(() => {});
    if (this.provider === 'edge') {
      const k = this.index + READY_AHEAD - 1;
      this.#ensure(k).then((ok) => ok && gen === this.gen && this.#src(k).catch(() => {}));
    }
    this.#forgetOld();
  }

  // ---- controls

  /** Back one piece, or to the start of this one if it has been playing a while. */
  back() {
    if (!this.active || this.usingFallback) return;
    const ms = this.ms;
    if (ms) {
      const here = ms.pieces.get(this.index);
      const t = ms.audio.currentTime;
      const target = here && t - here.start > 2.5 ? this.index : this.index - 1;
      const p = ms.pieces.get(target) || here;
      if (p) {
        // Still in the stream: just step back in it.
        ms.audio.currentTime = p.start + 0.001;
        ms.shown = -1;
        if (this.state === 'paused') this.resume();
        return;
      }
    }
    const elapsed = ms ? 0 : this.players[this.cur].currentTime;
    this.#playFrom(elapsed > 2.5 || !this.canGoBack ? this.index : this.index - 1);
  }

  get canGoBack() {
    return this.index > 0 && this.chunks[this.index - 1] != null;
  }

  pause() {
    if (this.usingFallback) speechSynthesis.pause();
    else if (this.ms) this.ms.audio.pause();
    else this.players[this.cur].pause();
    this.#set('paused');
  }

  resume() {
    if (this.usingFallback) speechSynthesis.resume();
    else if (this.ms) this.ms.audio.play().catch(() => {});
    else this.players[this.cur].play().catch(() => {});
    this.#set('playing');
  }

  toggle() {
    if (this.state === 'paused') this.resume();
    else if (this.state === 'playing' || this.state === 'loading') this.pause();
  }

  stop(silent = false) {
    const wasActive = this.state !== 'idle';
    this.state = 'idle'; // first, so resetting the players can't trigger fallbacks
    this.gen++;
    this.session++;
    this.#msStop();
    for (const a of this.players) {
      delete a.dataset.real;
      a.pause();
      a.removeAttribute('src');
      a.load();
    }
    this.#freeBlobs();
    this.feeding = null;
    if (this.usingFallback) speechSynthesis.cancel();
    this.usingFallback = false;
    if (!silent && wasActive) this.#set('idle');
  }

  /** True when this passage is not in the chosen voice (it had to fall back). */
  get fellBack() {
    return this.usingFallback || (!!this.provider && this.provider !== this.preferred);
  }

  #playFailed(e) {
    // The browser wants a fresh tap before playing sound: pause, so the Play
    // button continues in the same voice, rather than switching voices.
    if (e && e.name === 'NotAllowedError') return this.#set('paused');
    this.#onError();
  }

  // A voice service failed: continue from the current piece with the next
  // provider (Microsoft → Google), and finally the device's own voice.
  #onError() {
    if (this.state === 'idle' || this.usingFallback) return;
    this.#msStop();
    for (const a of this.players) a.pause();
    this.providers = this.providers.slice(1);
    this.#freeBlobs();
    if (this.providers.length) {
      this.provider = this.providers[0];
      // A passage split for the Microsoft voice has longer pieces than Google takes.
      if (!this.feed) this.chunks = this.chunks.slice(0, this.index).concat(chunkText(this.chunks.slice(this.index).join(' '), LIMITS[this.provider]));
      return this.#playFrom(this.index);
    }
    if (!('speechSynthesis' in window)) return this.#set('idle', true);
    this.gen++;
    this.usingFallback = true;
    this.#set('playing');
    speechSynthesis.cancel();
    this.#deviceSay(this.index, this.gen);
  }

  /** The device's own voice, piece by piece. */
  async #deviceSay(i, gen) {
    if (!(await this.#ensure(i)) || gen !== this.gen) {
      if (gen === this.gen) this.#set('idle', true);
      return;
    }
    this.index = i;
    this.onPiece(i);
    const u = new SpeechSynthesisUtterance(this.chunks[i]);
    u.lang = this.lang === 'iw' ? 'he-IL' : this.lang;
    this.devFrac = 0;
    const len = this.chunks[i].length || 1;
    u.onboundary = (e) => gen === this.gen && (this.devFrac = Math.min(1, (e.charIndex || 0) / len));
    u.onend = () => this.usingFallback && gen === this.gen && this.#deviceSay(i + 1, gen);
    speechSynthesis.speak(u);
  }

  /** How far into the piece being read the voice is (0 to 1), or null when that isn't known. */
  progress() {
    if (this.state !== 'playing') return null;
    const clamp = (x) => Math.max(0, Math.min(1, x));
    const ms = this.ms;
    if (ms) {
      const p = ms.pieces.get(this.index);
      if (!p) return null;
      const len = p.voice || p.end - p.start;
      return len > 0 ? clamp((ms.audio.currentTime - p.start) / len) : null;
    }
    if (this.usingFallback) return this.devFrac == null ? null : this.devFrac;
    const a = this.players[this.cur];
    return a && a.duration && isFinite(a.duration) ? clamp(a.currentTime / a.duration) : null;
  }

  #set(state, finished = false) {
    this.state = state;
    if (state === 'idle') this.usingFallback = false;
    this.onState(state, { finished });
  }
}

/**
 * Pronunciation of the word (or phrase) in the translation bubble: Google's
 * voice, or the device's own if that can't play. `onState` hears 'loading',
 * 'playing' and finally 'idle' (finished, stopped, or replaced by a newer one).
 */
let wordAudio;
let wordUtterance = null;
let wordToken = 0;
let wordState = 'idle';
let wordListener = null;

function setWordState(state) {
  wordState = state;
  if (wordListener) wordListener(state);
  if (state === 'idle') wordListener = null;
}

export function pronounce(word, lang, onState) {
  stopPronounce();
  wordAudio ??= new Audio();
  const a = wordAudio;
  const token = ++wordToken;
  const mine = () => token === wordToken;
  wordListener = onState || null;
  setWordState('loading');
  // Give up on a sound that never arrives.
  const timer = setTimeout(() => mine() && wordState === 'loading' && stopPronounce(), 10000);
  a.onplaying = () => mine() && (clearTimeout(timer), setWordState('playing'));
  a.onended = () => mine() && (clearTimeout(timer), setWordState('idle'));
  a.src = ttsUrl(word, lang);
  a.play().catch(() => {
    if (!mine()) return;
    a.onplaying = a.onended = null;
    if (!('speechSynthesis' in window)) return (clearTimeout(timer), setWordState('idle'));
    const u = (wordUtterance = new SpeechSynthesisUtterance(word));
    u.lang = lang === 'iw' ? 'he-IL' : lang;
    u.onstart = () => mine() && (clearTimeout(timer), setWordState('playing'));
    u.onend = u.onerror = () => mine() && (clearTimeout(timer), setWordState('idle'));
    speechSynthesis.speak(u);
  });
}

/** Stop the pronunciation now (does nothing if none is loading or playing). */
export function stopPronounce() {
  wordToken++;
  if (wordAudio) {
    wordAudio.onplaying = wordAudio.onended = null;
    wordAudio.pause();
    wordAudio.removeAttribute('src');
  }
  if (wordUtterance) {
    wordUtterance = null;
    try {
      speechSynthesis.cancel();
    } catch (e) {}
  }
  if (wordState !== 'idle') setWordState('idle');
}

