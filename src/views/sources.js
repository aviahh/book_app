// Find books: free catalogs (OPDS), browsed and searched here, and books
// downloaded straight into the library (and from there into Drive, when that's on).
//
//   #/sources                         the catalogs
//   #/sources?c=<id>                  a catalog's start page
//   #/sources?c=<id>&u=<feed>         a page in it (a section, a search, a book)
//   …&e=<entry id>                    one book from that page

import { shell, esc, toast } from './common.js';
import { icons } from '../icons.js';
import { catalogs, catalogOf, loginFor, addCatalog, removeCatalog } from '../sources/catalogs.js';
import { getText, getBook, NeedsLogin } from '../sources/net.js';
import { parseFeed, parseOsd, searchUrl, formatOf } from '../sources/opds.js';
import { listBooks, updateBook } from '../db.js';
import { importFile } from '../pdf.js';
import { control, roomFor } from '../sync/downloads.js';
import '../sources/sources.css';

const pages = new Map(); // feed url → parsed page (so going back is instant)
const osds = new Map(); // description url → search template
const downloading = new Map(); // file url → { fraction }

const EXT = { epub: 'epub', pdf: 'pdf', cbz: 'cbz', cbr: 'cbr' };
const TYPE = { epub: 'application/epub+zip', pdf: 'application/pdf', cbz: 'application/vnd.comicbook+zip', cbr: 'application/vnd.comicbook-rar' };
const LABEL = { epub: 'EPUB', pdf: 'PDF', cbz: 'CBZ', cbr: 'CBR' };

const mb = (n) => (!n ? '' : n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`);
const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
};
const link = (params) => '#/sources?' + Object.keys(params).filter((k) => params[k]).map((k) => `${k}=${encodeURIComponent(params[k])}`).join('&');
const img = (src, cls = '') => (src ? `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '');

async function loadPage(url, auth) {
  if (pages.has(url)) return pages.get(url);
  const got = await getText(url, auth);
  const page = parseFeed(got.text, got.url);
  pages.set(url, page);
  return page;
}

async function templateOf(search, auth) {
  if (!search) return null;
  if (search.template) return search.template;
  if (osds.has(search.osd)) return osds.get(search.osd);
  const got = await getText(search.osd, auth);
  const t = parseOsd(got.text, got.url);
  osds.set(search.osd, t);
  return t;
}

/** The best file to offer: EPUB (with images, newest kind) first, then PDF, then comics. */
function bestFiles(files) {
  const score = (f) => {
    let s = { epub: 400, pdf: 200, cbz: 300, cbr: 290 }[f.format] || 0;
    if (/no\s?images|noimages/i.test(f.title + ' ' + f.href)) s -= 50;
    if (/epub3/i.test(f.title + ' ' + f.href)) s += 10;
    return s;
  };
  const seen = new Set();
  return files
    .slice()
    .sort((a, b) => score(b) - score(a))
    .filter((f) => !seen.has(f.href) && seen.add(f.href));
}

/** Is this book already in the library (from this catalog entry)? */
async function inLibrary(entryId, title) {
  const books = await listBooks();
  return books.find((b) => (b.source && b.source.entry === entryId) || (!b.cloud && title && b.title && b.title.toLowerCase() === title.toLowerCase())) || null;
}

export async function mountSources(view, _p, nav) {
  const content = shell(view, 'library');
  // Moving within Find books keeps a trail, so Back goes one step up at a time.
  content.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#/"]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    nav(a.getAttribute('href'));
  });
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const cat = q.get('c') && catalogOf(q.get('c'));
  if (!cat) return drawCatalogs(content, view, nav);
  const url = q.get('u') || cat.url;
  return drawPage(content, view, nav, cat, url, q.get('e'), q.get('s') || '');
}

// ---------------------------------------------------------------- the catalogs

function drawCatalogs(content, view, nav) {
  let adding = false;
  let note = '';
  const draw = () => {
    const list = catalogs();
    content.innerHTML = `
      <section class="src">
        <a class="crumb" href="#/library">${icons.back}<span>Library</span></a>
        <h1>Find books</h1>
        <p class="src-lead">Free books from open catalogs, straight into your library.</p>
        <div class="src-cats">
          ${list
            .map(
              (c) => `
            <div class="src-cat">
              <a class="src-cat-main" href="${esc(link({ c: c.id }))}">
                <span class="src-cat-name">${esc(c.name)}</span>
                <span class="src-cat-desc">${esc(c.desc || host(c.url))}</span>
              </a>
              ${c.builtIn ? `<span class="src-chev">${icons.chevronRight}</span>` : `<button class="btn subtle" data-src="remove" data-id="${esc(c.id)}">Remove</button>`}
            </div>`,
            )
            .join('')}
        </div>
        ${
          adding
            ? `<form class="src-add" data-src-form>
                <p class="src-add-title">Add a catalog</p>
                <p class="src-add-desc">Any OPDS catalog on the web: a library, a bookshop’s free section, or your own book server (Calibre, Kavita, Komga…).</p>
                <input name="url" type="text" inputmode="url" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="https://example.org/opds" aria-label="Catalog address" required>
                <input name="name" type="text" autocomplete="off" placeholder="Name (optional)" aria-label="Name">
                <details><summary>This catalog needs a login</summary>
                  <input name="user" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="User name" aria-label="User name">
                  <input name="pass" type="password" autocomplete="current-password" placeholder="Password" aria-label="Password">
                  <p class="src-add-desc">Kept on this device only, and sent only to this catalog, over a secure connection.</p>
                </details>
                ${note ? `<p class="src-note">${esc(note)}</p>` : ''}
                <div class="src-add-btns"><button class="btn subtle" type="button" data-src="cancel">Cancel</button><button class="btn primary" type="submit">Add</button></div>
              </form>`
            : `<button class="src-addbtn" data-src="add">${icons.plus}<span>Add a catalog</span></button>`
        }
        <p class="src-foot">Only add catalogs you trust. Books from them are yours to read under their own terms.</p>
      </section>`;
    const f = content.querySelector('[data-src-form] input[name=url]');
    if (f) f.focus();
  };
  content.addEventListener('click', (e) => {
    const b = e.target.closest('[data-src]');
    if (!b) return;
    if (b.dataset.src === 'add') (adding = true), (note = ''), draw();
    if (b.dataset.src === 'cancel') (adding = false), draw();
    if (b.dataset.src === 'remove' && confirm('Remove this catalog? Books you downloaded from it stay in your library.')) {
      removeCatalog(b.dataset.id);
      draw();
    }
  });
  content.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target.closest('[data-src-form]');
    if (!form) return;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    const v = (n) => form.elements[n].value;
    try {
      const c = await addCatalog({ url: v('url'), name: v('name'), user: v('user').trim(), pass: v('pass') });
      adding = false;
      nav(link({ c: c.id }));
    } catch (err) {
      note = navigator.onLine === false ? 'You’re offline. Connect to the internet to add a catalog.' : String(err.message || err);
      const keep = { url: v('url'), name: v('name'), user: v('user') };
      draw();
      const f2 = content.querySelector('[data-src-form]');
      for (const k of Object.keys(keep)) f2.elements[k].value = keep[k];
      if (keep.user) f2.querySelector('details').open = true;
    }
  });
  draw();
}

// ---------------------------------------------------------------- a page of a catalog

async function drawPage(content, view, nav, cat, url, entryId, words) {
  const auth = loginFor(cat); // (sent only to the catalog's own address)
  const isStart = url === cat.url && !words;
  content.innerHTML = `<section class="src"><a class="crumb" href="${esc(isStart ? '#/sources' : link({ c: cat.id }))}">${icons.back}<span>${esc(isStart ? 'Find books' : cat.name)}</span></a><div class="src-wait"><span class="sync-spin" aria-hidden="true"></span></div></section>`;
  let page;
  try {
    page = await loadPage(url, auth);
  } catch (e) {
    const msg =
      navigator.onLine === false
        ? 'You’re offline. Catalogs need an internet connection.'
        : e instanceof NeedsLogin
          ? 'This catalog needs a login. Remove it and add it again with your user name and password.'
          : String(e.message || 'Couldn’t open the catalog.');
    content.querySelector('.src-wait').outerHTML = `<p class="src-note">${esc(msg)}</p><button class="btn subtle" data-src="retry">Try again</button>`;
    content.addEventListener('click', (ev) => ev.target.closest('[data-src="retry"]') && (pages.delete(url), drawPage(content, view, nav, cat, url, entryId, words)));
    return;
  }
  if (!content.isConnected) return;

  // One book: from the list it was opened from, or a page that is just that book.
  // (A page of editions of one title, e.g. with and without images, is one book with several files.)
  const books = page.items.filter((i) => i.files.length);
  const sameTitle = books.length === page.items.length && books.length > 0 && books.every((b) => b.title.toLowerCase() === books[0].title.toLowerCase());
  const allFiles = sameTitle ? bestFiles([].concat(...books.map((b) => b.files))) : [];
  const richest = sameTitle && (books.find((b) => b.files.some((f) => f.href === allFiles[0].href) && b.image) || books.find((b) => b.image) || books[0]);
  const merged = sameTitle ? Object.assign({}, richest, { files: allFiles }) : null;
  const one = entryId ? page.items.find((i) => i.id === entryId) : merged;
  if (one && one.files.length) return drawBook(content, view, nav, cat, url, one, isStart);

  let items = page.items.slice();
  let next = page.next;
  const template = cat.search || (await templateOf(page.search, auth).catch(() => null));
  const groups = {};
  for (const f of page.facets) (groups[f.group] = groups[f.group] || []).push(f);
  const row = (it) => {
    const href = it.files.length ? link({ c: cat.id, u: url, e: it.id }) : link({ c: cat.id, u: it.href });
    const pic = (cat.cover && cat.cover(it.href)) || it.thumb || it.image;
    const sub = it.author || it.summary.split('\n')[0];
    return `<a class="src-item${pic && !/^data:/.test(pic) ? ' has-cover' : ''}" href="${esc(href)}">
        ${pic ? `<span class="src-thumb">${img(pic)}</span>` : ''}
        <span class="src-item-text"><span class="src-item-title">${esc(it.title)}</span>${sub ? `<span class="src-item-sub">${esc(sub.slice(0, 160))}</span>` : ''}</span>
        <span class="src-chev">${icons.chevronRight}</span>
      </a>`;
  };
  const draw = () => {
    const title = words ? `“${words}”` : isStart ? cat.name : page.title;
    content.innerHTML = `
      <section class="src">
        <a class="crumb" href="${esc(isStart ? '#/sources' : link({ c: cat.id }))}">${icons.back}<span>${esc(isStart ? 'Find books' : cat.name)}</span></a>
        <h1 class="src-title">${esc(title)}</h1>
        ${template ? `<form class="search src-search" data-src-search>${icons.search}<input type="search" name="q" placeholder="Search ${esc(cat.name)}" aria-label="Search this catalog" value="${esc(words)}"></form>` : ''}
        ${Object.keys(groups)
          .map((g) => `<div class="src-facets" role="group" aria-label="${esc(g)}">${groups[g].map((f) => `<a class="src-facet${f.active ? ' on' : ''}" href="${esc(link({ c: cat.id, u: f.href }))}">${esc(f.title)}</a>`).join('')}</div>`)
          .join('')}
        <div class="src-list">${items.length ? items.map(row).join('') : `<p class="src-note">${words ? 'Nothing found. Try other words.' : 'Nothing here.'}</p>`}</div>
        ${next ? '<button class="btn subtle src-more" data-src="more">More</button>' : ''}
      </section>`;
  };
  content.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-src-search]');
    if (!form) return;
    e.preventDefault();
    const w = form.elements.q.value.trim();
    if (w && template) nav(link({ c: cat.id, u: searchUrl(template, w), s: w }));
  });
  content.addEventListener('click', async (e) => {
    const more = e.target.closest('[data-src="more"]');
    if (!more || !next) return;
    more.disabled = true;
    more.textContent = 'Loading…';
    try {
      const p = await loadPage(next, auth);
      items = items.concat(p.items);
      next = p.next;
      const y = window.scrollY;
      draw();
      window.scrollTo(0, y);
    } catch (err) {
      more.disabled = false;
      more.textContent = 'More';
      toast(view, String(err.message || 'Couldn’t load more.'), 4000);
    }
  });
  draw();
}

// ---------------------------------------------------------------- one book

async function drawBook(content, view, nav, cat, url, it, isStart) {
  const auth = loginFor(cat); // (sent only to the catalog's own address)
  const files = bestFiles(it.files);
  let have = await inLibrary(it.id, it.title);
  let note = '';
  let more = false;
  let ctl = null; // the download running from this page (to cancel it)
  const draw = () => {
    const main = files[0];
    const busy = files.find((f) => downloading.has(f.href));
    const sum = it.summary ? it.summary.split('\n') : [];
    const long = sum.join(' ').length > 520;
    content.innerHTML = `
      <section class="src src-book">
        <a class="crumb" href="${esc(isStart ? '#/sources' : url === cat.url ? link({ c: cat.id }) : link({ c: cat.id, u: url }))}">${icons.back}<span>${esc(cat.name)}</span></a>
        <div class="src-book-top">
          <div class="src-cover">${img(it.image || it.thumb) || `<span class="src-cover-blank">${esc(it.title.slice(0, 60))}</span>`}</div>
          <div class="src-book-info">
            <h1>${esc(it.title)}</h1>
            ${it.author ? `<p class="src-author">${esc(it.author)}</p>` : ''}
            <div class="src-actions">
              ${
                have
                  ? `<a class="btn primary" href="#/read/${esc(have.id)}">Open book</a><span class="src-have">${icons.check} In your library</span>`
                  : busy
                    ? `<div class="src-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(downloading.get(busy.href).fraction * 100)}"><i style="width:${Math.round(downloading.get(busy.href).fraction * 100)}%"></i></div><span class="src-have">Downloading…</span><button class="src-link src-cancel" data-src="cancel">Cancel</button>`
                    : `<button class="btn primary" data-get="${esc(main.href)}">Download ${LABEL[main.format]}${main.size ? ` · ${mb(main.size)}` : ''}</button>`
              }
            </div>
            ${!have && !busy && files.length > 1 ? `<p class="src-alt">Also: ${files.slice(1).map((f) => `<button class="src-link" data-get="${esc(f.href)}">${esc(f.title || LABEL[f.format])}${f.size ? ` · ${mb(f.size)}` : ''}</button>`).join(' ')}</p>` : ''}
            ${note ? `<p class="src-note">${esc(note)}</p>` : ''}
          </div>
        </div>
        ${sum.length ? `<div class="src-summary${long && !more ? ' clamp' : ''}">${sum.map((p) => `<p>${esc(p)}</p>`).join('')}</div>${long && !more ? '<button class="src-link" data-src="moretext">More</button>' : ''}` : ''}
        ${it.related.length ? `<div class="src-facets">${it.related.map((r) => `<a class="src-facet" href="${esc(link({ c: cat.id, u: r.href }))}">${esc(r.title)}</a>`).join('')}</div>` : ''}
      </section>`;
  };
  content.addEventListener('click', async (e) => {
    if (e.target.closest('[data-src="moretext"]')) return (more = true), draw();
    if (e.target.closest('[data-src="cancel"]')) return ctl && ctl.cancel();
    const g = e.target.closest('[data-get]');
    if (!g) return;
    const f = files.find((x) => x.href === g.dataset.get);
    if (!f || downloading.size) return;
    if (navigator.onLine === false) return toast(view, 'You’re offline. Connect to the internet to download.', 4000);
    if (!(await roomFor(f.size))) return;
    note = '';
    ctl = control();
    downloading.set(f.href, { fraction: 0 });
    draw();
    try {
      const got = await getBook(
        f.href,
        auth,
        (fr) => {
          downloading.get(f.href).fraction = fr;
          const bar = content.querySelector('.src-progress');
          if (bar) {
            bar.firstElementChild.style.width = `${Math.round(fr * 100)}%`;
            bar.setAttribute('aria-valuenow', String(Math.round(fr * 100)));
          }
        },
        f.size,
        ctl,
      );
      const kind = await sniff(got.blob);
      const format = kind === 'zip' ? (f.format === 'epub' ? 'epub' : 'cbz') : kind || formatOf(got.type, got.url) || f.format;
      const name = `${it.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 120) || 'Book'}.${EXT[format]}`;
      const file = new File([got.blob], name, { type: TYPE[format] });
      const ids = new Set((await listBooks()).map((b) => b.id));
      const added = await importFile(file, ids);
      const book = added || (await listBooks()).find((b) => b.fileName === name) || null;
      if (book) await updateBook(book.id, { source: { catalog: cat.id, entry: it.id } });
      have = book || (await inLibrary(it.id, it.title));
      toast(view, 'Added to your library.');
    } catch (err) {
      note = ctl.cancelled ? '' : navigator.onLine === false ? 'The connection dropped. Please try again.' : String(err.message || 'Download failed.');
    } finally {
      downloading.delete(f.href);
    }
    if (content.isConnected) draw();
  });
  draw();
}

/** What the file really is, from its first bytes (a ZIP may be an EPUB or a comic). */
async function sniff(blob) {
  const b = new Uint8Array(await new Response(blob.slice(0, 120)).arrayBuffer()); // (Blob.arrayBuffer is newer than iOS 12)
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf';
  if (b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21) return 'cbr';
  if (b[0] === 0x50 && b[1] === 0x4b) return /application\/epub\+zip/.test(String.fromCharCode.apply(null, b)) ? 'epub' : 'zip';
  return null;
}
