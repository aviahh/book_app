// Opening an EPUB: unzip it, read its package file (title, author, reading
// order, table of contents, cover) and hand out its files on request.
//
// An EPUB is a zip of web pages (XHTML), stylesheets and images, plus:
//   META-INF/container.xml → where the package file (.opf) is
//   package file           → metadata, every file (manifest), reading order (spine)
//   nav.xhtml / toc.ncx    → the table of contents
import { unzipSync, strFromU8 } from 'fflate';

const parseXml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const byLocal = (root, name) => Array.prototype.filter.call(root.getElementsByTagName('*'), (e) => (e.localName || e.nodeName.replace(/^.*:/, '')) === name);
const first = (root, name) => byLocal(root, name)[0] || null;

/** Resolve `href` (relative, may have #fragment) against the folder of `base`. */
export function resolvePath(base, href) {
  const [path, frag] = href.split('#');
  if (!path) return { path: base, frag: frag || '' };
  const out = base.split('/').slice(0, -1);
  for (const part of decodeURIComponent(path).split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return { path: out.join('/'), frag: frag || '' };
}

export class Epub {
  constructor(bytes) {
    this.zip = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    // Some zips store paths with a leading "./" or differently cased folders; index both ways.
    this.lower = new Map(Object.keys(this.zip).map((k) => [k.toLowerCase(), k]));
    const container = parseXml(this.text('META-INF/container.xml'));
    const rootfile = first(container, 'rootfile');
    this.opfPath = rootfile ? rootfile.getAttribute('full-path') : Object.keys(this.zip).find((k) => /\.opf$/i.test(k));
    if (!this.opfPath) throw new Error('Not an EPUB book');
    const opf = parseXml(this.text(this.opfPath));

    // Metadata
    const meta = first(opf, 'metadata') || opf;
    const dc = (name) => {
      const el = first(meta, name);
      return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
    };
    this.title = dc('title');
    this.author = byLocal(meta, 'creator')
      .map((e) => e.textContent.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(', ');
    this.language = dc('language');

    // Manifest: every file, by id
    this.manifest = new Map();
    for (const it of byLocal(opf, 'item')) {
      const href = it.getAttribute('href');
      if (!href) continue;
      this.manifest.set(it.getAttribute('id'), {
        id: it.getAttribute('id'),
        path: resolvePath(this.opfPath, href).path,
        type: it.getAttribute('media-type') || '',
        props: it.getAttribute('properties') || '',
      });
    }

    // Spine: the reading order
    const spine = first(opf, 'spine');
    this.direction = (spine && spine.getAttribute('page-progression-direction')) || '';
    this.spine = [];
    for (const ref of spine ? byLocal(spine, 'itemref') : []) {
      const item = this.manifest.get(ref.getAttribute('idref'));
      if (!item || !/html|xml/.test(item.type)) continue;
      this.spine.push({ path: item.path, linear: ref.getAttribute('linear') !== 'no' });
    }
    // Non-linear items (pop-up notes) still get pages, at the end, so links to them work.
    this.spine = this.spine.filter((s) => s.linear).concat(this.spine.filter((s) => !s.linear));
    if (!this.spine.length) throw new Error('This EPUB has no pages');

    // Cover image: EPUB 3 marks it in the manifest, EPUB 2 in a <meta name="cover">.
    let cover = [...this.manifest.values()].find((m) => /\bcover-image\b/.test(m.props));
    if (!cover) {
      const m = byLocal(meta, 'meta').find((e) => e.getAttribute('name') === 'cover');
      if (m) cover = this.manifest.get(m.getAttribute('content'));
    }
    if (!cover) cover = [...this.manifest.values()].find((m) => /^image\//.test(m.type) && /cover/i.test(m.id + m.path));
    this.coverPath = cover && /^image\//.test(cover.type) ? cover.path : null;

    // Table of contents
    const nav = [...this.manifest.values()].find((m) => /\bnav\b/.test(m.props));
    const ncxId = spine && spine.getAttribute('toc');
    const ncx = (ncxId && this.manifest.get(ncxId)) || [...this.manifest.values()].find((m) => m.type === 'application/x-dtbncx+xml');
    this.toc = [];
    try {
      if (nav) this.toc = this.#navToc(nav.path);
    } catch (e) {}
    try {
      if (!this.toc.length && ncx) this.toc = this.#ncxToc(ncx.path);
    } catch (e) {}
  }

  #navToc(path) {
    const doc = parseXml(this.text(path));
    const navs = byLocal(doc, 'nav');
    const toc = navs.find((n) => /\btoc\b/.test(n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '')) || navs[0];
    const walk = (ol) =>
      (ol ? Array.prototype.filter.call(ol.children, (c) => c.localName === 'li') : []).map((li) => {
        const a = Array.prototype.find.call(li.children, (c) => c.localName === 'a' || c.localName === 'span');
        const href = a && a.getAttribute('href');
        return {
          title: a ? a.textContent.replace(/\s+/g, ' ').trim() : '',
          target: href ? resolvePath(path, href) : null,
          items: walk(Array.prototype.find.call(li.children, (c) => c.localName === 'ol')),
        };
      });
    return toc ? walk(first(toc, 'ol')) : [];
  }

  #ncxToc(path) {
    const doc = parseXml(this.text(path));
    const walk = (parent) =>
      Array.prototype.filter.call(parent.children, (c) => c.localName === 'navPoint').map((np) => {
        const label = first(np, 'text');
        const content = Array.prototype.find.call(np.children, (c) => c.localName === 'content');
        const src = content && content.getAttribute('src');
        return { title: label ? label.textContent.replace(/\s+/g, ' ').trim() : '', target: src ? resolvePath(path, src) : null, items: walk(np) };
      });
    const map = first(doc, 'navMap');
    return map ? walk(map) : [];
  }

  #key(path) {
    if (this.zip[path]) return path;
    return this.lower.get(path.toLowerCase()) || null;
  }

  has(path) {
    return !!this.#key(path);
  }

  bytes(path) {
    const k = this.#key(path);
    if (!k) throw new Error(`Missing in EPUB: ${path}`);
    return this.zip[k];
  }

  text(path) {
    const b = this.bytes(path);
    // Strip a UTF-8 byte order mark: XML parsers choke on it after decoding.
    const s = strFromU8(b);
    return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  }

  typeOf(path) {
    for (const m of this.manifest.values()) if (m.path === path) return m.type;
    const ext = (path.split('.').pop() || '').toLowerCase();
    return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }[ext] || '';
  }

  blob(path) {
    return new Blob([this.bytes(path)], { type: this.typeOf(path) });
  }
}

/** Width and height of an image from its first bytes (PNG, JPEG, GIF, WebP), or null. */
export function imageSize(b) {
  if (!b || b.length < 24) return null;
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50) return { w: (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19], h: (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23] };
  // GIF
  if (b[0] === 0x47 && b[1] === 0x49) return { w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8) };
  // JPEG: walk the segments to a start-of-frame marker
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        i += 2;
        continue;
      }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
    return null;
  }
  // WebP
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const f = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (f === 'VP8 ') return { w: (b[26] | (b[27] << 8)) & 0x3fff, h: (b[28] | (b[29] << 8)) & 0x3fff };
    if (f === 'VP8L') {
      const n = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1 };
    }
    if (f === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  }
  return null;
}
