// Reading OPDS catalogs (1.x Atom XML and 2.0 JSON) into one plain shape:
//
//   { title, items: [item], next, search, facets: [{ group, title, href, active }] }
//   item = { id, title, author, summary, image, thumb, href (a feed to open) | null,
//            files: [{ href, type, format, title, size }], related: [{ title, href }] }
//
// Everything in a catalog is somebody else's text: links are kept only when
// they are http(s) (images may also be data:image), and descriptions become
// plain text, never markup.

const ACQ = 'http://opds-spec.org/acquisition';
const IMG = 'http://opds-spec.org/image';
const THUMB = 'http://opds-spec.org/image/thumbnail';
const SKIP_ACQ = /\/(buy|borrow|subscribe|sample|preview)$/;

/** The formats Folio reads, from a file's declared type (or its address). */
export function formatOf(type, href) {
  const t = String(type || '').toLowerCase();
  const h = String(href || '').toLowerCase().split(/[?#]/)[0];
  if (/epub/.test(t) || /\.epub3?$|\.epub\.(no)?images$|\.epub3\.images$/.test(h)) return 'epub';
  if (/pdf/.test(t) || /\.pdf$/.test(h)) return 'pdf';
  if (/comicbook-rar|x-cbr/.test(t) || /\.cbr$/.test(h)) return 'cbr';
  if (/comicbook|x-cbz/.test(t) || /\.cbz$/.test(h)) return 'cbz';
  return null;
}

const clean = (s) =>
  String(s || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f�]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();

/** An absolute http(s) address, or null. */
export function safeUrl(href, base, { image = false } = {}) {
  if (!href) return null;
  const raw = String(href).trim();
  if (image && /^data:image\/(png|jpe?g|gif|webp);base64,[\w+/=\s]+$/i.test(raw)) return raw.replace(/\s+/g, '');
  try {
    const u = new URL(raw, base);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    return u.href;
  } catch (e) {
    return null;
  }
}

export function parseFeed(text, base) {
  const t = String(text || '').replace(/^﻿/, '').replace(/^\s+/, '');
  if (t[0] === '{') return parseJson(JSON.parse(t), base);
  return parseAtom(t, base);
}

// ---------------------------------------------------------------- OPDS 1 (Atom)

const kids = (el, name) => {
  const out = [];
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (c.localName === name) out.push(c);
  return out;
};
const kid = (el, name) => kids(el, name)[0] || null;
const textOf = (el) => (el ? clean(el.textContent) : '');

/** Plain text from an Atom text construct (text, html or xhtml), paragraphs kept apart. */
function plain(el) {
  if (!el) return '';
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  if (type === 'text') return clean(el.textContent).slice(0, 4000);
  if (type === 'html' || type === 'text/html') return plainHtml(el.textContent);
  return blocksText(el);
}

/** Markup as plain text. Parsed as an inert document: nothing in it runs or loads. */
function plainHtml(html) {
  return blocksText(new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body);
}

function blocksText(root) {
  const parts = [];
  const walk = (n) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) parts.push(c.nodeValue.replace(/\s+/g, ' ')); // line breaks in the source are just spacing
      else if (c.nodeType === 1) {
        const tag = c.localName.toLowerCase();
        if (tag === 'script' || tag === 'style') continue;
        if (tag === 'br') parts.push('\n');
        const block = /^(p|div|li|h[1-6]|blockquote|tr)$/.test(tag);
        if (block) parts.push('\n');
        walk(c);
        if (block) parts.push('\n');
      }
    }
  };
  walk(root);
  return parts
    .join('')
    .split(/\n+/)
    .map(clean)
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000);
}

function linksOf(el, base) {
  return kids(el, 'link').map((l) => {
    const rel = l.getAttribute('rel') || 'alternate';
    const type = l.getAttribute('type') || '';
    const image = rel.indexOf(IMG) === 0 || /stanza-cover-image/.test(rel);
    return {
      rel,
      type,
      title: clean(l.getAttribute('title')),
      href: safeUrl(l.getAttribute('href'), base, { image }),
      length: Number(l.getAttribute('length')) || 0,
      facetGroup: clean(l.getAttributeNS('http://opds-spec.org/2010/catalog', 'facetGroup') || l.getAttribute('opds:facetGroup')),
      active: (l.getAttributeNS('http://opds-spec.org/2010/catalog', 'activeFacet') || l.getAttribute('opds:activeFacet')) === 'true',
    };
  });
}

const isFeedType = (type) => /atom\+xml|opds\+json|opds-catalog/i.test(type || '');

function searchOf(links) {
  for (const l of links) {
    if (l.rel !== 'search' || !l.href) continue;
    if (/opensearchdescription/i.test(l.type)) return { osd: l.href };
    if (/\{searchTerms\}/.test(decodeURI(l.href))) return { template: decodeURI(l.href) };
  }
  return null;
}

function parseAtom(text, base) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const root = doc.documentElement;
  if (!root || doc.getElementsByTagName('parsererror').length || (root.localName !== 'feed' && root.localName !== 'entry')) {
    throw new Error('That isn’t an OPDS catalog.');
  }
  const links = root.localName === 'feed' ? linksOf(root, base) : [];
  const next = links.find((l) => l.rel === 'next' && l.href);
  const facets = links
    .filter((l) => l.rel === 'http://opds-spec.org/facet' && l.href && l.title)
    .map((l) => ({ group: l.facetGroup || 'More', title: l.title, href: l.href, active: l.active }));
  const entries = root.localName === 'feed' ? kids(root, 'entry') : [root];
  return {
    title: textOf(kid(root, 'title')) || 'Catalog',
    items: entries.map((e, i) => atomEntry(e, base, i)).filter((x) => x.title && (x.href || x.files.length)),
    next: next ? next.href : null,
    search: searchOf(links),
    facets,
  };
}

function atomEntry(e, base, i) {
  const links = linksOf(e, base);
  const files = [];
  for (const l of links) {
    if (l.rel.indexOf(ACQ) !== 0 || SKIP_ACQ.test(l.rel) || !l.href) continue;
    const format = formatOf(l.type, l.href);
    if (format) files.push({ href: l.href, type: l.type, format, title: l.title, size: l.length });
  }
  const image = links.find((l) => l.href && (l.rel === IMG || l.rel === 'http://opds-spec.org/cover' || l.rel === 'x-stanza-cover-image'));
  const thumb = links.find((l) => l.href && (l.rel === THUMB || l.rel === 'x-stanza-cover-image-thumbnail'));
  const nav = links.find((l) => l.href && isFeedType(l.type) && !/^(self|start|search|related|up)$/.test(l.rel) && l.rel.indexOf(ACQ) !== 0);
  const authors = kids(e, 'author').map((a) => personName(textOf(kid(a, 'name')))).filter(Boolean);
  return {
    id: textOf(kid(e, 'id')) || `#${i}`,
    title: textOf(kid(e, 'title')),
    author: authors.join(', '),
    summary: summaryOf(plain(kid(e, 'summary')) || plain(kid(e, 'content'))),
    image: image ? image.href : thumb ? thumb.href : null,
    thumb: thumb ? thumb.href : image ? image.href : null,
    href: files.length ? null : nav ? nav.href : null,
    files,
    related: links
      .filter((l) => l.rel === 'related' && l.href && l.title && isFeedType(l.type))
      .slice(0, 8)
      .map((l) => ({ title: l.title.replace(/(…|\.\.\.)$/, '').trim(), href: l.href })),
  };
}

/** "Shelley, Mary Wollstonecraft" → "Mary Wollstonecraft Shelley" (catalogs often file names surname first). */
function personName(n) {
  const m = /^([^,]+),\s*([^,]+)$/.exec(n);
  return m && !/\d/.test(n) ? `${m[2]} ${m[1]}` : n;
}

/** A catalog's description, trimmed to the description itself when it is labelled ("Summary: …"). */
function summaryOf(text) {
  const lines = text.split('\n');
  const s = lines.find((l) => /^Summary:\s*\S/i.test(l));
  return s ? s.replace(/^Summary:\s*/i, '') : text;
}

// ---------------------------------------------------------------- OPDS 2 (JSON)

const str = (v) => (typeof v === 'string' ? clean(v) : v && typeof v === 'object' && typeof v.name === 'string' ? clean(v.name) : '');
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);

function parseJson(j, base) {
  if (!j || typeof j !== 'object') throw new Error('That isn’t an OPDS catalog.');
  const links = list(j.links);
  const linkHref = (l) => safeUrl(l && l.href, base);
  const items = [];
  const nav = (n) => {
    const href = linkHref(n);
    if (href && str(n.title)) items.push({ id: href, title: str(n.title), author: '', summary: '', image: null, thumb: null, href, files: [], related: [] });
  };
  const pub = (p, i) => {
    const m = (p && p.metadata) || {};
    const files = [];
    for (const l of list(p.links)) {
      const rel = list(l.rel).join(' ');
      if (rel.indexOf(ACQ) < 0 || SKIP_ACQ.test(rel)) continue;
      const href = linkHref(l);
      const format = href && formatOf(l.type, href);
      if (format) files.push({ href, type: l.type || '', format, title: str(l.title), size: Number(l.properties && l.properties.size) || 0 });
    }
    const imgs = list(p.images).filter((x) => x && x.href);
    const big = imgs.slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0];
    const small = imgs.slice().sort((a, b) => (a.width || 1e9) - (b.width || 1e9))[0];
    const self = list(p.links).find((l) => list(l.rel).indexOf('self') >= 0 && /opds-publication|opds\+json/.test(l.type || ''));
    items.push({
      id: str(m.identifier) || `#${i}`,
      title: str(m.title),
      author: list(m.author).map(str).filter(Boolean).join(', '),
      summary: m.description ? plainHtml(String(m.description)) : '',
      image: big ? safeUrl(big.href, base, { image: true }) : null,
      thumb: small ? safeUrl(small.href, base, { image: true }) : null,
      href: files.length ? null : self ? linkHref(self) : null,
      files,
      related: [],
    });
  };
  list(j.navigation).forEach(nav);
  list(j.publications).forEach(pub);
  for (const g of list(j.groups)) {
    list(g.navigation).forEach(nav);
    list(g.publications).forEach(pub);
  }
  if (j.metadata && j.metadata.title && !j.publications && !j.navigation && !j.groups && j.links) pub(j, 0); // a single publication
  const next = links.find((l) => list(l.rel).indexOf('next') >= 0);
  const search = links.find((l) => list(l.rel).indexOf('search') >= 0 && l.href);
  let s = null;
  if (search) {
    const href = String(search.href);
    if (/opensearchdescription/.test(search.type || '')) s = { osd: safeUrl(href, base) };
    else if (search.templated) s = { template: absTemplate(href.replace(/\{\?query[^}]*\}/, '?query={searchTerms}').replace(/\{query\}/, '{searchTerms}'), base) };
  }
  const facets = [];
  for (const f of list(j.facets)) {
    for (const l of list(f.links)) {
      const href = linkHref(l);
      if (href && str(l.title)) facets.push({ group: str(f.metadata && f.metadata.title) || 'More', title: str(l.title), href, active: list(l.rel).indexOf('self') >= 0 });
    }
  }
  return { title: str(j.metadata && j.metadata.title) || 'Catalog', items: items.filter((x) => x.title && (x.href || x.files.length)), next: next ? linkHref(next) : null, search: s, facets };
}

function absTemplate(t, base) {
  // Keep the {searchTerms} marker through URL resolution.
  const abs = safeUrl(t.replace('{searchTerms}', 'FOLIOQ'), base);
  return abs ? abs.replace('FOLIOQ', '{searchTerms}') : null;
}

// ---------------------------------------------------------------- search

/** The search address template from an OpenSearch description. */
export function parseOsd(text, base) {
  const doc = new DOMParser().parseFromString(String(text).replace(/^﻿/, ''), 'application/xml');
  const urls = [...doc.getElementsByTagName('*')].filter((e) => e.localName === 'Url' && e.getAttribute('template'));
  const pick = urls.find((u) => /atom\+xml|opds/i.test(u.getAttribute('type') || '')) || urls[0];
  return pick ? absTemplate(pick.getAttribute('template'), base) : null;
}

/** Fill a search template: the words go in {searchTerms}; other optional parts are left out. */
export function searchUrl(template, words) {
  return template
    .replace(/\{searchTerms\??\}/g, encodeURIComponent(words))
    .replace(/\{startPage\??\}/g, '1')
    .replace(/\{startIndex\??\}/g, '')
    .replace(/\{[\w:]+\??\}/g, '');
}
