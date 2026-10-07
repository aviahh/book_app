// "Reading Room" — the entry screen: pick up where you left off, see what
// you've been reading lately, and a gentle look at your reading rhythm.
import { listBooks } from '../db.js';
import { icons } from '../icons.js';
import { readingStats } from '../stats.js';
import { shell, esc, coverUrls, progressOf, addBooksFlow, enableDrop } from './common.js';

export async function mountHome(view, _params, nav) {
  const content = shell(view, 'home');
  const covers = coverUrls();

  async function render() {
    const books = await listBooks();
    await covers.load(books);
    const opened = books.filter((b) => b.lastOpenedAt).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
    const current = opened.find((b) => !b.finished) || opened[0];
    const recent = opened.filter((b) => b !== current).slice(0, 8);
    const fresh = books.filter((b) => !b.lastOpenedAt).sort((a, b) => b.addedAt - a.addedAt).slice(0, 8);
    const stats = readingStats();
    const now = new Date();
    const h = now.getHours();
    const greeting = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    const date = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    const finished = books.filter((b) => b.finished).length;
    const maxDay = Math.max(30, ...stats.days.map((d) => d.minutes));

    content.innerHTML = `
      <section class="greeting">
        <p class="eyebrow">${esc(date)}</p>
        <h1>${greeting}</h1>
      </section>
      ${current ? heroHtml(current) : books.length ? startHtml(books) : emptyHtml()}
      ${
        books.length
          ? `<section class="stats" aria-label="Reading rhythm">
        <div class="stat">
          <span class="stat-num">${stats.today}<small> min</small></span>
          <span class="stat-label">read today</span>
        </div>
        <div class="stat">
          <span class="stat-num">${stats.streak}<small> day${stats.streak === 1 ? '' : 's'}</small></span>
          <span class="stat-label">reading streak</span>
        </div>
        <div class="stat week">
          <div class="bars" aria-hidden="true">${stats.days
            .map((d) => `<span><i style="height:${Math.max(4, (d.minutes / maxDay) * 100)}%" class="${d.minutes ? 'on' : ''}"></i><b>${esc(d.label)}</b></span>`)
            .join('')}</div>
          <span class="stat-label">${stats.week} min this week</span>
        </div>
        <div class="stat">
          <span class="stat-num">${books.length}<small> book${books.length === 1 ? '' : 's'}</small></span>
          <span class="stat-label">${finished} finished</span>
        </div>
      </section>`
          : ''
      }
      ${recent.length ? shelfHtml('Recently opened', recent) : ''}
      ${fresh.length ? shelfHtml('New on your shelf', fresh) : ''}
    `;
  }

  function heroHtml(b) {
    const p = progressOf(b);
    return `
      <section class="hero">
        <a class="hero-cover" href="#/read/${b.id}" aria-label="Continue ${esc(b.title)}">
          <span class="book3d" style="--ar:${b.aspect || 0.7}"><img src="${covers.get(b)}" alt=""></span>
        </a>
        <div class="hero-info">
          <p class="eyebrow">Continue reading</p>
          <h2>${esc(b.title)}</h2>
          ${b.author ? `<p class="author">${esc(b.author)}</p>` : ''}
          <div class="progress" role="progressbar" aria-valuenow="${Math.round(p * 100)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${p * 100}%"></i></div>
          <p class="meta">Page ${b.lastPage} of ${b.pageCount} · ${Math.round(p * 100)}%</p>
          <a class="btn primary" href="#/read/${b.id}">${icons.book} Resume reading</a>
        </div>
      </section>`;
  }

  function startHtml(books) {
    const b = [...books].sort((a, c) => c.addedAt - a.addedAt)[0];
    return `
      <section class="hero">
        <a class="hero-cover" href="#/read/${b.id}"><span class="book3d" style="--ar:${b.aspect || 0.7}"><img src="${covers.get(b)}" alt=""></span></a>
        <div class="hero-info">
          <p class="eyebrow">Ready when you are</p>
          <h2>${esc(b.title)}</h2>
          ${b.author ? `<p class="author">${esc(b.author)}</p>` : ''}
          <p class="meta">${b.pageCount} pages</p>
          <a class="btn primary" href="#/read/${b.id}">${icons.book} Start reading</a>
        </div>
      </section>`;
  }

  function emptyHtml() {
    return `
      <section class="welcome">
        <div class="welcome-art" aria-hidden="true"><span></span><span></span><span></span></div>
        <h2>Your reading room is ready</h2>
        <p>Add PDF books from this device — they're kept privately on the device and open even without internet.</p>
        <button class="btn primary" data-act="add">${icons.plus} Add books</button>
      </section>`;
  }

  function shelfHtml(title, list) {
    return `
      <section class="shelf">
        <div class="shelf-head"><h3>${title}</h3><a href="#/library" class="link">View library</a></div>
        <div class="shelf-row">
          ${list
            .map(
              (b) => `
            <a class="shelf-book" href="#/read/${b.id}" title="${esc(b.title)}">
              <span class="book3d" style="--ar:${b.aspect || 0.7}"><img src="${covers.get(b)}" alt="" loading="lazy"></span>
              <span class="shelf-title">${esc(b.title)}</span>
              ${progressOf(b) > 0 ? `<span class="mini-progress"><i style="width:${progressOf(b) * 100}%"></i></span>` : ''}
            </a>`,
            )
            .join('')}
        </div>
      </section>`;
  }

  content.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="add"]')) addBooksFlow(view, render);
  });
  enableDrop(view, (files) => addBooksFlow(view, render, files));
  await render();
  return () => covers.revoke();
}
