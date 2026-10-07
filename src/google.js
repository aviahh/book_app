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

// A tenth of a second of silence (8 kHz, 8-bit WAV), played inside a tap to
// "unlock" audio elements: iOS only lets an element play later, without a tap,
// once it has played something during one.
const SILENCE = (() => {
  const n = 800;
  const b = new Uint8Array(44 + n);
  const dv = new DataView(b.buffer);
  const str = (o, t) => t.split('').forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  str(0, 'RIFF');
  dv.setUint32(4, 36 + n, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, 8000, true);
  dv.setUint32(28, 8000, true);
  dv.setUint16(32, 1, true);
  dv.setUint16(34, 8, true);
  str(36, 'data');
  dv.setUint32(40, n, true);
  b.fill(128, 44);
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return 'data:audio/wav;base64,' + btoa(bin);
})();

/**
 * A pausable, chunk-by-chunk speech player.
 *
 * The Microsoft voice is downloaded piece by piece and played from memory
 * (blob URLs): iOS Safari refuses to play audio straight from a server that
 * streams it without byte-range support, which our voice relay does. The
 * first piece is short, so playback still starts quickly, and the next piece
 * downloads while the current one plays.
 */
export class Speech {
  constructor({ onState, voice = () => 'microsoft' } = {}) {
    this.onState = onState || (() => {});
    this.voicePref = voice;
    // Two elements: one plays while the other holds the next piece.
    this.players = [new Audio(), new Audio()];
    for (const a of this.players) {
      a.preload = 'auto';
      a.addEventListener('ended', () => a.dataset.real && this.#advance());
      a.addEventListener('error', () => a.dataset.real && this.#onError());
    }
    this.state = 'idle';
    this.gen = 0;
    this.blobs = new Map();
  }

  get active() {
    return this.state === 'playing' || this.state === 'paused' || this.state === 'loading';
  }

  /** Call from inside a tap (e.g. the speaker button): lets audio start later without one. */
  unlock() {
    if (this.active) return;
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

  speak(text, lang) {
    this.stop(true);
    this.unlock(); // in case this call is itself inside a tap
    this.lang = lang;
    this.providers = providersFor(lang, this.voicePref());
    this.preferred = this.providers[0];
    this.usingFallback = false;
    this.#start(text);
  }

  /** A playable URL for piece i: a downloaded blob for the Microsoft voice, the direct address for Google's. */
  #src(i) {
    if (this.provider !== 'edge') return Promise.resolve(urlFor(this.provider, this.chunks[i], this.lang));
    if (!this.blobs.has(i)) {
      const url = urlFor(this.provider, this.chunks[i], this.lang);
      const get = () =>
        Promise.race([
          fetch(url),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000)),
        ])
          .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status))))
          .then((b) => (b.size > 64 && /audio|mpeg|octet/.test(b.type || 'audio') ? URL.createObjectURL(b) : Promise.reject(new Error('no audio'))));
      // A passing hiccup (weak Wi-Fi, a busy moment at the voice service)
      // shouldn't swap the voice: try again before giving up on it.
      this.blobs.set(
        i,
        get().catch(() => new Promise((r) => setTimeout(r, 600)).then(get)),
      );
    }
    return this.blobs.get(i);
  }

  #freeBlobs() {
    for (const p of this.blobs.values()) p.then((u) => u.indexOf('blob:') === 0 && URL.revokeObjectURL(u), () => {});
    this.blobs = new Map();
  }

  #load(player, i, gen) {
    return this.#src(i).then((url) => {
      if (gen !== this.gen) return false;
      player.dataset.real = '1';
      player.src = url;
      player.load();
      return true;
    });
  }

  /** (Re)start playback of `text` with the current best provider. */
  async #start(text) {
    const gen = ++this.gen;
    this.#freeBlobs();
    this.provider = this.providers[0];
    this.chunks = chunkText(text, LIMITS[this.provider], Math.min(LIMITS[this.provider], 160));
    if (!this.chunks.length) return this.#set('idle', true);
    this.index = 0;
    this.cur = 0;
    this.#set('loading');
    const [a, b] = this.players;
    try {
      if (!(await this.#load(a, 0, gen))) return;
    } catch (e) {
      if (gen === this.gen) this.#onError();
      return;
    }
    if (this.chunks[1]) this.#load(b, 1, gen).catch(() => {});
    a.play()
      .then(() => gen === this.gen && this.state === 'loading' && this.#set('playing'))
      .catch((e) => gen === this.gen && this.#playFailed(e));
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
    this.gen++;
    for (const a of this.players) {
      delete a.dataset.real;
      a.pause();
      a.removeAttribute('src');
      a.load();
    }
    this.#freeBlobs();
    if (this.usingFallback) speechSynthesis.cancel();
    this.usingFallback = false;
    if (!silent && wasActive) this.#set('idle');
  }

  async #advance() {
    if (this.state === 'idle' || this.usingFallback) return;
    const gen = this.gen;
    this.index++;
    if (this.index >= this.chunks.length) return this.#set('idle', true);
    const next = this.players[1 - this.cur];
    this.cur = 1 - this.cur;
    // Normally already loaded while the previous piece played; wait if not.
    try {
      if (!next.dataset.real) await this.#load(next, this.index, gen);
    } catch (e) {
      if (gen === this.gen) this.#onError();
      return;
    }
    if (gen !== this.gen) return;
    next.play().catch((e) => gen === this.gen && this.#playFailed(e));
    // Fetch the following piece into the element that just finished.
    const after = this.index + 1;
    const spare = this.players[1 - this.cur];
    delete spare.dataset.real;
    if (after < this.chunks.length) this.#load(spare, after, gen).catch(() => {});
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
    const rest = this.chunks.slice(this.index).join(' ');
    for (const a of this.players) a.pause();
    this.providers = this.providers.slice(1);
    if (this.providers.length) return this.#start(rest);
    if (!('speechSynthesis' in window)) return this.#set('idle', true);
    this.gen++;
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

/** One-shot pronunciation of a single word (Google voice; device voice if offline). */
let wordAudio;
export function pronounce(word, lang) {
  wordAudio ??= new Audio();
  wordAudio.src = ttsUrl(word, lang);
  wordAudio.play().catch(() => {
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(word);
      u.lang = lang === 'iw' ? 'he-IL' : lang;
      speechSynthesis.speak(u);
    }
  });
}
