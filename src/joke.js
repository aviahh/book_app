// A one-off joke: a fake "rate the app" bubble that appears a few seconds
// after the app opens. Shown until it is answered or closed, then never again
// on that device. Everything (markup, styles, behaviour) lives in this file;
// to remove it, delete this file and its import line in main.js.

const SEEN_KEY = 'folio.joke.rate.v1';

function seen() {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch (e) {
    return false;
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch (e) {}
}

const CSS = `
.joke-rate {
  position: fixed;
  left: 50%;
  bottom: calc(28px + env(safe-area-inset-bottom, 0px));
  z-index: 9999;
  width: min(360px, calc(100% - 32px));
  transform: translate(-50%, 20px);
  opacity: 0;
  padding: 22px 22px 18px;
  border-radius: 20px;
  background: #fffdf9;
  color: #2a241d;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(0, 0, 0, 0.06);
  font-family: -apple-system, 'Segoe UI', Arial, sans-serif;
  text-align: center;
  direction: rtl;
  transition: transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1.2), opacity 0.3s ease;
}
.joke-rate.in {
  transform: translate(-50%, 0);
  opacity: 1;
}
.joke-rate p {
  margin: 0 18px 14px;
  font-size: 1.08rem;
  font-weight: 600;
  line-height: 1.45;
}
.joke-rate .joke-stars {
  display: flex;
  justify-content: center;
  direction: ltr;
}
.joke-rate .joke-stars button {
  -webkit-appearance: none;
  appearance: none;
  border: 0;
  background: none;
  padding: 4px;
  margin: 0 2px;
  cursor: pointer;
  color: #d8cfc2;
  transition: transform 0.15s ease, color 0.15s ease;
}
.joke-rate .joke-stars button.on {
  color: #f5b301;
}
.joke-rate .joke-stars button:active {
  transform: scale(0.88);
}
.joke-rate .joke-stars svg {
  display: block;
  width: 38px;
  height: 38px;
}
.joke-rate .joke-close {
  position: absolute;
  top: 8px;
  left: 8px;
  -webkit-appearance: none;
  appearance: none;
  border: 0;
  background: none;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  font-size: 22px;
  line-height: 34px;
  color: #9a8f82;
  cursor: pointer;
}
.joke-rate .joke-thanks {
  margin: 12px 0 0;
  font-size: 0.95rem;
  font-weight: 500;
  color: #7a6f63;
}
@media (prefers-color-scheme: dark) {
  html:not([data-theme='light']) .joke-rate {
    background: #26221d;
    color: #f1ebe2;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.08);
  }
  html:not([data-theme='light']) .joke-rate .joke-stars button:not(.on) {
    color: #5a5148;
  }
}
html[data-theme='dark'] .joke-rate {
  background: #26221d;
  color: #f1ebe2;
}
html[data-theme='dark'] .joke-rate .joke-stars button:not(.on) {
  color: #5a5148;
}
`;

const STAR =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9z"/></svg>';

function show() {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const box = document.createElement('div');
  box.className = 'joke-rate';
  box.setAttribute('role', 'dialog');
  box.innerHTML =
    '<button class="joke-close" aria-label="סגירה">×</button>' +
    '<p>אהבת את האפליקציה? אל תהיה אפס כמו אלפי תדרג:</p>' +
    '<div class="joke-stars">' +
    [1, 2, 3, 4, 5].map((n) => `<button data-n="${n}" aria-label="${n}">${STAR}</button>`).join('') +
    '</div>';
  document.body.appendChild(box);
  requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('in')));

  const close = () => {
    markSeen();
    box.classList.remove('in');
    setTimeout(() => {
      box.remove();
      style.remove();
    }, 400);
  };
  const stars = [...box.querySelectorAll('.joke-stars button')];
  const light = (n) => stars.forEach((s, i) => s.classList.toggle('on', i < n));

  box.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target.closest('.joke-close')) return close();
    const star = e.target.closest('.joke-stars button');
    if (!star || box.dataset.done) return;
    box.dataset.done = '1';
    light(+star.dataset.n);
    const thanks = document.createElement('p');
    thanks.className = 'joke-thanks';
    thanks.textContent = 'תודה! 🙂';
    box.appendChild(thanks);
    setTimeout(close, 1400);
  });
  // Keep taps on the bubble from reaching the reader underneath.
  for (const t of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown']) {
    box.addEventListener(t, (e) => e.stopPropagation());
  }
}

if (!seen()) setTimeout(show, 2500);
