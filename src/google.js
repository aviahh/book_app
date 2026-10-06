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

/**
 * A pausable, chunk-streaming speech player.
 * Must be started from inside a user gesture (iOS autoplay rules).
 */
export class Speech {
  constructor({ onState, voice = () => 'microsoft' } = {}) {
    this.onState = onState || (() => {});
    this.voicePref = voice;
    // Two elements: one plays while the other preloads the next chunk.
    this.players = [new Audio(), new Audio()];
    for (const a of this.players) {
      a.preload = 'auto';
      a.addEventListener('ended', () => this.#advance());
      a.addEventListener('error', () => this.#onError());
    }
    this.state = 'idle';
  }

  get active() {
    return this.state === 'playing' || this.state === 'paused' || this.state === 'loading';
  }

  speak(text, lang) {
    this.stop(true);
    this.lang = lang;
    this.providers = providersFor(lang, this.voicePref());
    this.usingFallback = false;
    const b = this.players[1];
    // Unlock the second element during the gesture so it can start later.
    b.muted = true;
    b.play()
      .then(() => {
        b.pause();
        b.muted = false;
      })
      .catch(() => (b.muted = false));
    this.#start(text);
  }

  /** (Re)start playback of `text` with the current best provider. */
  #start(text) {
    this.provider = this.providers[0];
    this.chunks = chunkText(text, LIMITS[this.provider], Math.min(LIMITS[this.provider], 160));
    if (!this.chunks.length) return this.#set('idle', true);
    this.index = 0;
    this.cur = 0;
    const [a, b] = this.players;
    a.src = urlFor(this.provider, this.chunks[0], this.lang);
    if (this.chunks[1]) {
      b.src = urlFor(this.provider, this.chunks[1], this.lang);
      b.load();
    }
    this.#set('loading');
    a.play()
      .then(() => this.state === 'loading' && this.#set('playing'))
      .catch(() => this.#onError());
  }

  pause() {
    if (this.usingFallback) speechSynthesis.pause();
    else this.players[this.cur].pause();
    this.#set('paused');
  }

  resume() {
    if (this.usingFallback) speechSynthesis.resume();
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
    for (const a of this.players) {
      a.pause();
      a.removeAttribute('src');
      a.load();
    }
    if (this.usingFallback) speechSynthesis.cancel();
    this.usingFallback = false;
    if (!silent && wasActive) this.#set('idle');
  }

  #advance() {
    if (this.state === 'idle' || this.usingFallback) return;
    this.index++;
    if (this.index >= this.chunks.length) return this.#set('idle', true);
    const playing = this.players[1 - this.cur];
    this.cur = 1 - this.cur;
    playing.play().catch(() => this.#onError());
    // Preload the following chunk into the element that just finished.
    const nextIdx = this.index + 1;
    if (nextIdx < this.chunks.length) {
      const spare = this.players[1 - this.cur];
      spare.src = urlFor(this.provider, this.chunks[nextIdx], this.lang);
      spare.load();
    }
  }

  // A voice service failed: continue from the current piece with the next
  // provider (Microsoft → Google), and finally the device's own voice.
  #onError() {
    if (this.state === 'idle' || this.usingFallback) return;
    const rest = this.chunks.slice(this.index).join(' ');
    for (const a of this.players) a.pause();
    this.providers = this.providers.slice(1);
    if (this.providers.length) return this.#start(rest);
    if (!('speechSynthesis' in window)) return this.#set('idle', true);
    this.usingFallback = true;
    const u = new SpeechSynthesisUtterance(rest);
    u.lang = this.lang === 'iw' ? 'he-IL' : this.lang;
    u.onend = () => this.usingFallback && this.#set('idle', true);
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    this.#set('playing');
  }

  #set(state, finished = false) {
    this.state = state;
    if (state === 'idle') this.usingFallback = false;
    this.onState(state, { finished });
  }
}

/** One-shot pronunciation of a single word, with the same voice fallbacks. */
let wordAudio;
export function pronounce(word, lang, prefer = 'microsoft') {
  wordAudio ??= new Audio();
  const providers = providersFor(lang, prefer);
  const tryNext = () => {
    const p = providers.shift();
    if (!p) {
      if ('speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance(word);
        u.lang = lang === 'iw' ? 'he-IL' : lang;
        speechSynthesis.speak(u);
      }
      return;
    }
    wordAudio.onerror = tryNext;
    wordAudio.src = urlFor(p, word, lang);
    wordAudio.play().catch(() => {});
  };
  tryNext();
}
