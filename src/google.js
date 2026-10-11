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
 * The Microsoft voice plays gaplessly through Web Audio: upcoming pieces are
 * downloaded and decoded ahead (READY_AHEAD), and a couple are already placed
 * on the audio clock (QUEUED_AHEAD) so each one starts the instant the
 * previous one ends, even if the page is busy or in the background. Each
 * clip's own leading and trailing silence is trimmed and replaced by a pause
 * that fits the punctuation, so sentences flow like one recording.
 * The Google voice (and any browser without Web Audio) plays through two
 * <audio> elements: one plays while the other holds the next piece.
 *
 * Only the last few pieces are kept behind the current one (for back()).
 */
const KEEP_BACK = 3; // pieces kept behind the current one (a few lines)
const READY_AHEAD = 4; // pieces downloaded and decoded ahead (Microsoft voice)
const QUEUED_AHEAD = 2; // pieces already scheduled on the audio clock beyond the current one
const MAX_FETCHES = 3; // voice requests in flight at once
const AC = window.AudioContext || window.webkitAudioContext;

const decode = (ctx, data) =>
  new Promise((resolve, reject) => {
    // Old Safari only has the callback form.
    const p = ctx.decodeAudioData(data, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });

/** Where the voice really starts and ends in a clip, and the pause to leave after it. */
function trimClip(buffer, text) {
  const d = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const quiet = 0.006;
  let a = 0;
  while (a < d.length && Math.abs(d[a]) < quiet) a++;
  let b = d.length - 1;
  while (b > a && Math.abs(d[b]) < quiet) b--;
  if (b <= a) return { offset: 0, length: buffer.duration, slot: buffer.duration };
  const t = text.trim();
  const pause = /[.!?…]["'”’)\]]*$/.test(t) ? 0.3 : /[,;:—–]["'”’)\]]*$/.test(t) ? 0.16 : 0.05;
  const offset = Math.max(0, a / sr - 0.025);
  const voiceEnd = b / sr + 0.03;
  return { offset, length: Math.min(buffer.duration, voiceEnd + pause) - offset, slot: voiceEnd - offset + pause };
}

export class Speech {
  constructor({ onState, voice = () => 'microsoft', onPiece } = {}) {
    this.onState = onState || (() => {});
    this.onPiece = onPiece || (() => {});
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
    this.session = 0;
    this.blobs = new Map();
    this.clips = new Map();
    this.chunks = [];
    this.index = 0;
    this.fetching = 0;
    this.waiting = [];
    document.addEventListener('visibilitychange', () => {
      // iOS can suspend the audio clock while the app is away.
      if (!document.hidden && this.wa && this.state === 'playing' && this.ctx.state !== 'running') this.ctx.resume();
    });
  }

  get active() {
    return this.state === 'playing' || this.state === 'paused' || this.state === 'loading';
  }

  /** Call from inside a tap (e.g. the speaker button): lets audio start later without one. */
  unlock() {
    if (AC) {
      try {
        if (!this.ctx) this.ctx = new AC();
        if (this.ctx.state !== 'running') this.ctx.resume();
        // A moment of silence through the clock, inside the tap (older iOS needs it).
        const s = this.ctx.createBufferSource();
        s.buffer = this.ctx.createBuffer(1, 1, 22050);
        s.connect(this.ctx.destination);
        s.start(0);
        // iOS: speech is real playback, not a sound effect (so the ring/silent switch doesn't mute it).
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
      } catch (e) {}
    }
    if (this.active || !NEEDS_UNLOCK) return;
    for (const a of this.players) {
      delete a.dataset.real;
      a.src = SILENCE;
      const p = a.play();
      if (p && p.then) p.then(() => a.pause()).catch(() => {});
    }
    if (!this.keepAlive) {
      // Older iOS mutes Web Audio with the silent switch unless an <audio>
      // element is playing too: a silent, looping one keeps it audible.
      this.keepAlive = new Audio(SILENCE);
      this.keepAlive.loop = true;
    }
    const k = this.keepAlive.play();
    if (k && k.then) k.then(() => !this.active && this.keepAlive.pause()).catch(() => {});
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
    const url = urlFor('edge', this.chunks[i], this.lang);
    const get = () =>
      Promise.race([fetch(url), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))]).then((r) =>
        r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status)),
      );
    const slot = () =>
      this.fetching < MAX_FETCHES ? Promise.resolve() : new Promise((r) => this.waiting.push(r));
    return slot().then(() => {
      this.fetching++;
      const done = () => {
        this.fetching--;
        const next = this.waiting.shift();
        if (next) next();
      };
      // A passing hiccup (weak Wi-Fi, a busy moment at the voice service)
      // shouldn't swap the voice: try again before giving up on it.
      const p = get()
        .catch(() => new Promise((r) => setTimeout(r, 600)).then(get))
        .then((b) => (b.size > 64 && /audio|mpeg|octet/.test(b.type || 'audio') ? b : Promise.reject(new Error('no audio'))));
      p.then(done, done);
      return p;
    });
  }

  /** A playable URL for piece i (<audio> path): a blob for the Microsoft voice, the direct address for Google's. */
  #src(i) {
    if (this.provider !== 'edge') return Promise.resolve(urlFor(this.provider, this.chunks[i], this.lang));
    if (!this.blobs.has(i)) this.blobs.set(i, this.#download(i).then((b) => URL.createObjectURL(b)));
    return this.blobs.get(i);
  }

  /** Piece i decoded and trimmed, ready for the audio clock (Web Audio path). */
  #clip(i) {
    if (!this.clips.has(i)) {
      const text = this.chunks[i];
      this.clips.set(
        i,
        this.#download(i)
          .then((b) => b.arrayBuffer())
          .then((data) => decode(this.ctx, data))
          .then((buffer) => ({ buffer, ...trimClip(buffer, text) })),
      );
    }
    return this.clips.get(i);
  }

  #freeBlobs(keep = () => false) {
    for (const [i, p] of [...this.blobs]) {
      if (keep(i)) continue;
      p.then((u) => u.indexOf('blob:') === 0 && URL.revokeObjectURL(u), () => {});
      this.blobs.delete(i);
    }
    for (const i of [...this.clips.keys()]) if (!keep(i)) this.clips.delete(i);
  }

  /** Forget what lies more than a few pieces behind (audio, and the text of a continuous reading). */
  #forgetOld() {
    const first = this.index - KEEP_BACK;
    this.#freeBlobs((i) => i >= first);
    if (this.feed) for (let i = Math.max(0, first - 4); i < first; i++) this.chunks[i] = null;
  }

  /** (Re)start playback at piece i with the current provider. */
  #playFrom(i) {
    this.#waStop();
    const gen = ++this.gen;
    for (const a of this.players) {
      delete a.dataset.real;
      a.pause();
    }
    this.index = i;
    this.cur = 0;
    this.#set('loading');
    if (this.provider === 'edge' && this.ctx) return this.#waStart(i, gen);
    return this.#elStart(i, gen);
  }

  // ---- Web Audio (gapless) path

  #waStart(i, gen) {
    this.wa = { gen, queue: [], next: 0, nextIndex: i, shown: -1, ended: false, pumping: false };
    if (this.ctx.state !== 'running') this.ctx.resume();
    if (this.keepAlive) this.keepAlive.play().catch(() => {});
    this.waTimer = setInterval(() => this.#waTick(), 40);
    this.#waPump();
  }

  #waStop() {
    clearInterval(this.waTimer);
    const wa = this.wa;
    this.wa = null;
    if (!wa) return;
    for (const q of wa.queue) {
      try {
        q.src.onended = null;
        q.src.stop();
        q.src.disconnect();
      } catch (e) {}
    }
  }

  /** Keep the clock fed: decode ahead, and schedule pieces back to back. */
  async #waPump() {
    const wa = this.wa;
    if (!wa || wa.pumping || wa.ended) return;
    wa.pumping = true;
    try {
      while (this.wa === wa) {
        const now = this.ctx.currentTime;
        // Download and decode the next few in the background.
        for (let k = wa.nextIndex; k < wa.nextIndex + READY_AHEAD; k++) {
          if (k < this.chunks.length && this.chunks[k] != null) this.#clip(k).catch(() => {});
        }
        if (this.chunks.length < wa.nextIndex + READY_AHEAD && !this.feedDone) this.#ensure(wa.nextIndex + READY_AHEAD - 1);
        const queued = wa.queue.filter((q) => q.end > now).length;
        if (queued > QUEUED_AHEAD) break; // enough on the clock; the tick calls again
        if (!(await this.#ensure(wa.nextIndex))) {
          if (this.wa === wa && this.feedDone) wa.ended = true;
          break;
        }
        const i = wa.nextIndex;
        const clip = await this.#clip(i);
        if (this.wa !== wa) return;
        const src = this.ctx.createBufferSource();
        src.buffer = clip.buffer;
        src.connect(this.ctx.destination);
        // Right after the previous piece, or now if we fell behind (a slow connection).
        const at = Math.max(wa.next, this.ctx.currentTime + 0.05);
        src.start(at, clip.offset, clip.length);
        wa.queue.push({ i, src, start: at, end: at + clip.slot });
        wa.next = at + clip.slot;
        wa.nextIndex = i + 1;
      }
    } catch (e) {
      if (this.wa === wa) {
        wa.pumping = false;
        return this.#onError();
      }
    }
    wa.pumping = false;
  }

  #waTick() {
    const wa = this.wa;
    if (!wa) return;
    const now = this.ctx.currentTime;
    const cur = wa.queue.find((q) => now >= q.start && now < q.end);
    if (cur && cur.i !== wa.shown) {
      wa.shown = cur.i;
      this.index = cur.i;
      if (this.state === 'loading') this.#set('playing');
      this.onPiece(cur.i);
      this.#forgetOld();
    }
    // Drop finished pieces from the queue.
    while (wa.queue.length && wa.queue[0].end < now - 1) wa.queue.shift();
    if (wa.ended && !wa.queue.some((q) => q.end > now)) {
      this.#waStop();
      if (this.keepAlive) this.keepAlive.pause();
      return this.#set('idle', true);
    }
    if (!wa.pumping) this.#waPump();
  }

  // ---- <audio> element path

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
    this.onPiece(i);
    a.play()
      .then(() => gen === this.gen && this.state === 'loading' && this.#set('playing'))
      .catch((e) => gen === this.gen && this.#playFailed(e));
  }

  async #advance() {
    if (this.state === 'idle' || this.usingFallback || this.wa) return;
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
    // Fetch the following piece into the element that just finished.
    const spare = this.players[1 - this.cur];
    delete spare.dataset.real;
    this.#load(spare, this.index + 1, gen).catch(() => {});
    this.#forgetOld();
  }

  // ---- controls

  /** Back one piece, or to the start of this one if it has been playing a while. */
  back() {
    if (!this.active || this.usingFallback) return;
    let elapsed;
    if (this.wa) {
      const q = this.wa.queue.find((x) => x.i === this.index);
      elapsed = q ? this.ctx.currentTime - q.start : 0;
    } else elapsed = this.players[this.cur].currentTime;
    const resume = this.state === 'paused';
    this.#playFrom(elapsed > 2.5 || !this.canGoBack ? this.index : this.index - 1);
    if (resume && this.ctx && this.ctx.state !== 'running') this.ctx.resume();
  }

  get canGoBack() {
    return this.index > 0 && this.chunks[this.index - 1] != null;
  }

  pause() {
    if (this.usingFallback) speechSynthesis.pause();
    else if (this.wa) this.ctx.suspend();
    else this.players[this.cur].pause();
    this.#set('paused');
  }

  resume() {
    if (this.usingFallback) speechSynthesis.resume();
    else if (this.wa) this.ctx.resume();
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
    this.#waStop();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); // a paused reading leaves the clock stopped
    if (this.keepAlive) this.keepAlive.pause();
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
    this.#waStop();
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
    u.onend = () => this.usingFallback && gen === this.gen && this.#deviceSay(i + 1, gen);
    speechSynthesis.speak(u);
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

