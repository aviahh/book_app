import { listBooks, removeBook, updateBook } from '../db.js';
import { icons } from '../icons.js';
import { shell, esc, coverUrls, progressOf, addBooksFlow, enableDrop, toast } from './common.js';

const SORTS = {
  recent: (a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt),
  title: (a, b) => a.title.localeCompare(b.title),
  author: (a, b) => (a.author || '~').localeCompare(b.author || '~') || a.title.localeCompare(b.title),
};

export async function mountLibrary(view) {
  const content = shell(view, 'library');
  const covers = coverUrls();
  let sort = sessionStorage.getItem('folio.sort') || 'recent';
  let query = '';
  let books = [];

  content.innerHTML = `
    <section class="lib-head">
      <div>
        <h1>Library</h1>
        <p class="lib-count"></p>
      </div>
      <div class="lib-tools">
        <label class="search">${icons.search}<input type="search" placeholder="Search title or author" aria-label="Search library"></label>
        <div class="segmented" role="radiogroup" aria-label="Sort">
          ${Object.keys(SORTS)
            .map((k) => `<button role="radio" data-sort="${k}" aria-checked="${k === sort}">${k[0].toUpperCase() + k.slice(1)}</button>`)
            .join('')}
        </div>
        <button class="btn primary" data-act="add">${icons.plus} Add books</button>
      </div>
    </section>
    <section class="grid" aria-live="polite"></section>
    <div class="drop-hint" aria-hidden="true"><div>Drop PDF files to add them</div></div>`;

  const grid = content.querySelector('.grid');

  async function load() {
    books = await listBooks();
    await covers.load(books);
    draw();
  }

  function draw() {
    const q = query.trim().toLowerCase();
    const list = books.filter((b) => !q || `${b.title} ${b.author}`.toLowerCase().includes(q)).sort(SORTS[sort]);
    content.querySelector('.lib-count').textContent = books.length
      ? `${books.length} book${books.length === 1 ? '' : 's'} · ${books.filter((b) => b.finished).length} finished`
      : '';
    if (!books.length) {
      grid.innerHTML = `
        <div class="lib-empty">
          <div class="welcome-art" aria-hidden="true"><span></span><span></span><span></span></div>
          <h2>No books yet</h2>
          <p>Tap <b>Add books</b> to choose PDF files from this device — from Files, iCloud Drive, Downloads or any folder you can browse.</p>
          <button class="btn primary" data-act="add">${icons.plus} Add books</button>
        </div>`;
      return;
    }
    if (!list.length) {
      grid.innerHTML = `<p class="no-results">Nothing matches “${esc(query)}”.</p>`;
      return;
    }
    grid.innerHTML = list
      .map((b) => {
        const p = progressOf(b);
        const badge = b.finished ? '<span class="badge done">Finished</span>' : !b.lastOpenedAt ? '<span class="badge new">New</span>' : '';
        return `
        <article class="card" data-id="${b.id}">
          <a class="card-cover" href="#/read/${b.id}" aria-label="Open ${esc(b.title)}">
            <span class="book3d" style="--ar:${b.aspect || 0.7}"><img src="${covers.get(b)}" alt="" loading="lazy"></span>
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
      })
      .join('');
  }

  function openMenu(btn) {
    closeMenu();
    const card = btn.closest('.card');
    const b = books.find((x) => x.id === card.dataset.id);
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <button role="menuitem" data-m="finish">${icons.check} ${b.finished ? 'Mark as unread' : 'Mark as finished'}</button>
      <button role="menuitem" data-m="remove" class="danger">${icons.trash} Remove from library</button>`;
    card.append(menu);
    menu.addEventListener('click', async (e) => {
      const m = e.target.closest('[data-m]')?.dataset.m;
      if (m === 'finish') {
        await updateBook(b.id, { finished: !b.finished, ...(b.finished ? { lastPage: 1 } : {}) });
        await load();
      } else if (m === 'remove') {
        if (!confirm(`Remove “${b.title}” from your library? The file on your device is not affected.`)) return;
        await removeBook(b.id);
        toast(view, 'Removed from library');
        await load();
      }
      closeMenu();
    });
  }

  function closeMenu() {
    content.querySelector('.menu')?.remove();
  }

  content.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act?.dataset.act === 'add') return addBooksFlow(view, load);
    if (act?.dataset.act === 'menu') return openMenu(act);
    const s = e.target.closest('[data-sort]');
    if (s) {
      sort = s.dataset.sort;
      sessionStorage.setItem('folio.sort', sort);
      for (const x of content.querySelectorAll('[data-sort]')) x.setAttribute('aria-checked', String(x === s));
      draw();
    }
    if (!e.target.closest('.menu')) closeMenu();
  });
  content.querySelector('.search input').addEventListener('input', (e) => {
    query = e.target.value;
    draw();
  });
  enableDrop(view, (files) => addBooksFlow(view, load, files));

  await load();
  return () => covers.revoke();
}
