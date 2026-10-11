import { listBooks, removeBook, updateBook } from '../db.js';
import { icons } from '../icons.js';
import { groupSeries, seriesOf, volumeLabel } from '../series.js';
import { shell, esc, coverUrls, progressOf, addBooksFlow, enableDrop, toast } from './common.js';

const latest = (b) => b.lastOpenedAt || b.addedAt || 0;

// Sorts work on library items: a single book, or a series shelf ({ group }).
const SORTS = {
  recent: (a, b) => b.recent - a.recent,
  title: (a, b) => a.title.localeCompare(b.title),
  author: (a, b) => (a.author || '~').localeCompare(b.author || '~') || a.title.localeCompare(b.title),
};

const bookItem = (b) => ({ book: b, title: b.title, author: b.author, recent: latest(b) });
const groupItem = (g) => ({ group: g, title: g.name, author: g.books[0].author, recent: Math.max(...g.books.map(latest)) });

export async function mountLibrary(view, _params, nav) {
  const content = shell(view, 'library');
  const covers = coverUrls();
  // A series shelf opened on its own page: #/library?series=<key>
  const seriesKey = new URLSearchParams(location.hash.split('?')[1] || '').get('series');
  let sort = sessionStorage.getItem('folio.sort') || 'recent';
  let query = '';
  let books = [];
  let groups = [];

  content.innerHTML = seriesKey
    ? `
    <section class="lib-head series-head">
      <div>
        <a class="crumb" href="#/library">${icons.back}<span>Library</span></a>
        <h1></h1>
        <p class="lib-count"></p>
      </div>
      <div class="lib-tools">
        <button class="btn subtle" data-act="rename">Rename series</button>
        <button class="btn subtle" data-act="ungroup">Ungroup</button>
      </div>
    </section>
    <section class="grid" aria-live="polite"></section>`
    : `
    <section class="lib-head">
      <div>
        <h1>Library</h1>
        <p class="lib-count"></p>
      </div>
      <div class="lib-tools">
        <label class="search">${icons.search}<input type="search" placeholder="Search title, author or series" aria-label="Search library"></label>
        <div class="segmented" role="radiogroup" aria-label="Sort">
          ${Object.keys(SORTS)
            .map((k) => `<button role="radio" data-sort="${k}" aria-checked="${k === sort}">${k[0].toUpperCase() + k.slice(1)}</button>`)
            .join('')}
        </div>
        <button class="btn primary" data-act="add">${icons.plus} Add books</button>
      </div>
    </section>
    <section class="grid" aria-live="polite"></section>
    <div class="drop-hint" aria-hidden="true"><div>Drop PDF or EPUB files to add them</div></div>`;

  const grid = content.querySelector('.grid');

  async function load() {
    books = await listBooks();
    groups = groupSeries(books).groups;
    await covers.load(books);
    draw();
  }

  const currentGroup = () => groups.find((g) => g.key === seriesKey);

  function bookCard(b, vol) {
    const p = progressOf(b);
    const badge = b.finished ? '<span class="badge done">Finished</span>' : !b.lastOpenedAt ? '<span class="badge new">New</span>' : '';
    return `
        <article class="card" data-id="${b.id}">
          <a class="card-cover" href="#/read/${b.id}" aria-label="Open ${esc(b.title)}">
            <span class="book3d" style="--ar:${b.aspect || 0.7}"><img src="${covers.get(b)}" alt="" loading="lazy"></span>
            ${vol ? `<span class="badge vol">${esc(vol)}</span>` : ''}
            ${badge}
          </a>
          <div class="card-info">
            <div class="card-text">
              <h3>${esc(b.title)}</h3>
              <p>${esc(b.author || `${b.pageCount} pages`)}</p>
            </div>
            <button class="icon-btn small" data-act="menu" aria-label="More options for ${esc(b.title)}" aria-haspopup="menu">${icons.more}</button>
          </div>
          ${p > 0 && !b.finished ? `<div class="mini-progress" title="${Math.round(p * 100)}%"><i style="width:${p * 100}%"></i></div>` : ''}
        </article>`;
  }

  function seriesCard(g) {
    const n = g.books.length;
    const done = g.books.filter((b) => b.finished).length;
    // The volume being read (or the next unread one) in front.
    const reading = g.books.filter((b) => b.lastOpenedAt && !b.finished).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];
    const front = reading || g.books.find((b) => !b.finished) || g.books[0];
    const others = g.books.filter((b) => b !== front).slice(0, 2);
    const stack = [...others.reverse(), front];
    const vol = volumeLabel(g.volumes[g.books.indexOf(front)]);
    const status = done === n ? 'All read' : reading ? `Reading ${vol || front.title}` : done ? `${done} of ${n} read` : `${n} volumes`;
    return `
        <article class="card series-card" data-series="${esc(g.key)}">
          <a class="card-cover stacked" href="#/library?series=${encodeURIComponent(g.key)}" aria-label="${esc(g.name)}, ${n} volumes">
            ${stack.map((b, i) => `<span class="book3d s${stack.length - 1 - i}" style="--ar:${b.aspect || 0.7}"><img src="${covers.get(b)}" alt="" loading="lazy"></span>`).join('')}
            <span class="badge count">${n}</span>
          </a>
          <div class="card-info">
            <div class="card-text">
              <h3>${esc(g.name)}</h3>
              <p>${esc(status)}</p>
            </div>
          </div>
          ${done && done < n ? `<div class="mini-progress" title="${done} of ${n} read"><i style="width:${(done / n) * 100}%"></i></div>` : ''}
        </article>`;
  }

  function draw() {
    if (seriesKey) return drawSeries();
    const q = query.trim().toLowerCase();
    content.querySelector('.lib-count').textContent = books.length
      ? `${books.length} book${books.length === 1 ? '' : 's'}${groups.length ? ` · ${groups.length} series` : ''} · ${books.filter((b) => b.finished).length} finished`
      : '';
    if (!books.length) {
      grid.innerHTML = `
        <div class="lib-empty">
          <div class="welcome-art" aria-hidden="true"><span></span><span></span><span></span></div>
          <h2>No books yet</h2>
          <p>Tap <b>Add books</b> to choose PDF or EPUB books from this device — from Files, iCloud Drive, Downloads or any folder you can browse.</p>
          <button class="btn primary" data-act="add">${icons.plus} Add books</button>
        </div>`;
      return;
    }
    let items;
    if (q) {
      // Searching shows matching books themselves, series or not.
      items = books
        .filter((b) => {
          const s = seriesOf(b);
          return `${b.title} ${b.author} ${s ? s.name : ''}`.toLowerCase().includes(q);
        })
        .map(bookItem);
    } else {
      const { singles } = groupSeries(books);
      items = [...groups.map(groupItem), ...singles.map(bookItem)];
    }
    items.sort(SORTS[sort]);
    if (!items.length) {
      grid.innerHTML = `<p class="no-results">Nothing matches “${esc(query)}”.</p>`;
      return;
    }
    grid.innerHTML = items.map((it) => (it.group ? seriesCard(it.group) : bookCard(it.book))).join('');
  }

  function drawSeries() {
    const g = currentGroup();
    if (!g) {
      // The series no longer exists (ungrouped, or its books were removed).
      nav('#/library');
      return;
    }
    content.querySelector('h1').textContent = g.name;
    const done = g.books.filter((b) => b.finished).length;
    content.querySelector('.lib-count').textContent = `${g.books.length} volume${g.books.length === 1 ? '' : 's'} · ${done} finished`;
    grid.innerHTML = g.books.map((b, i) => bookCard(b, volumeLabel(g.volumes[i]))).join('');
  }

  function openMenu(btn) {
    closeMenu();
    const card = btn.closest('.card');
    const b = books.find((x) => x.id === card.dataset.id);
    const inSeries = seriesOf(b) && groups.some((g) => g.books.includes(b));
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <button role="menuitem" data-m="finish">${icons.check} ${b.finished ? 'Mark as unread' : 'Mark as finished'}</button>
      <button role="menuitem" data-m="series">${icons.library} ${inSeries ? 'Series and volume…' : 'Add to a series…'}</button>
      ${inSeries ? `<button role="menuitem" data-m="unseries">${icons.close} Remove from series</button>` : ''}
      <button role="menuitem" data-m="remove" class="danger">${icons.trash} Remove from library</button>`;
    card.append(menu);
    menu.addEventListener('click', async (e) => {
      const m = e.target.closest('[data-m]')?.dataset.m;
      if (!m) return;
      closeMenu();
      if (m === 'finish') {
        await updateBook(b.id, { finished: !b.finished, ...(b.finished ? { lastPage: 1 } : {}) });
        await load();
      } else if (m === 'series') {
        seriesDialog(b);
      } else if (m === 'unseries') {
        await updateBook(b.id, { seriesName: '', seriesIndex: undefined });
        toast(view, 'Removed from the series');
        await load();
      } else if (m === 'remove') {
        if (!confirm(`Remove “${b.title}” from your library? The file on your device is not affected.`)) return;
        await removeBook(b.id);
        toast(view, 'Removed from library');
        await load();
      }
    });
  }

  function closeMenu() {
    content.querySelector('.menu')?.remove();
  }

  /** Put a book in a series (an existing one or a new name) and give its volume number. */
  function seriesDialog(b) {
    const cur = seriesOf(b);
    const names = groups.map((g) => g.name);
    const sheet = document.createElement('div');
    sheet.className = 'sheet-backdrop';
    sheet.innerHTML = `
      <form class="sheet" role="dialog" aria-modal="true" aria-label="Series">
        <h2>Series</h2>
        <p class="sheet-sub">${esc(b.title)}</p>
        <label class="field"><span>Series name</span><input name="name" autocomplete="off" value="${esc(cur ? cur.name : '')}" placeholder="e.g. Re:ZERO"></label>
        ${names.length ? `<div class="chips">${names.map((n) => `<button type="button" class="chip" data-name="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
        <label class="field small"><span>Volume</span><input name="vol" type="number" inputmode="decimal" min="0" step="any" value="${cur && cur.index != null ? cur.index : ''}"></label>
        <div class="sheet-actions">
          <button type="button" class="btn subtle" data-x="cancel">Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>`;
    view.append(sheet);
    const form = sheet.querySelector('form');
    const close = () => sheet.remove();
    sheet.addEventListener('click', (e) => {
      if (e.target === sheet || e.target.closest('[data-x="cancel"]')) return close();
      const chip = e.target.closest('[data-name]');
      if (chip) form.elements.name.value = chip.dataset.name;
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = form.elements.name.value.trim();
      const vol = parseFloat(form.elements.vol.value);
      await updateBook(b.id, { seriesName: name, seriesIndex: name && !isNaN(vol) ? vol : undefined });
      close();
      toast(view, name ? `In “${name}”` : 'Not in a series');
      await load();
    });
    form.elements.name.focus();
  }

  async function renameSeries() {
    const g = currentGroup();
    const name = (prompt('Series name', g.name) || '').trim();
    if (!name || name === g.name) return;
    // Every volume keeps its number; the series is now named by hand.
    await Promise.all(g.books.map((b, i) => updateBook(b.id, { seriesName: name, seriesIndex: g.volumes[i] != null ? g.volumes[i] : undefined })));
    const key = groupSeries(await listBooks()).groups.find((x) => x.name === name)?.key;
    nav(key ? `#/library?series=${encodeURIComponent(key)}` : '#/library');
  }

  async function ungroup() {
    const g = currentGroup();
    if (!confirm(`Show the ${g.books.length} books of “${g.name}” separately in the library?`)) return;
    await Promise.all(g.books.map((b) => updateBook(b.id, { seriesName: '', seriesIndex: undefined })));
    nav('#/library');
  }

  content.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act?.dataset.act === 'add') return addBooksFlow(view, load);
    if (act?.dataset.act === 'menu') return openMenu(act);
    if (act?.dataset.act === 'rename') return renameSeries();
    if (act?.dataset.act === 'ungroup') return ungroup();
    const s = e.target.closest('[data-sort]');
    if (s) {
      sort = s.dataset.sort;
      sessionStorage.setItem('folio.sort', sort);
      for (const x of content.querySelectorAll('[data-sort]')) x.setAttribute('aria-checked', String(x === s));
      draw();
    }
    if (!e.target.closest('.menu')) closeMenu();
  });
  content.querySelector('.search input')?.addEventListener('input', (e) => {
    query = e.target.value;
    draw();
  });
  if (!seriesKey) enableDrop(view, (files) => addBooksFlow(view, load, files));

  await load();
  return () => covers.revoke();
}
