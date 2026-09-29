// Общие мелочи интерфейса: поиск элементов, экранирование, тосты, загрузка, фатальная ошибка.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const ui = {
  loader: {
    show(text) {
      $('#loader').classList.remove('is-hidden');
      $('#loader-text').textContent = text;
    },
    hide() {
      $('#loader').classList.add('is-hidden');
    },
  },

  /** Ошибка, после которой работать нельзя (нет камеры, не загрузились модели). */
  fatal(title, text) {
    ui.loader.hide();
    $('#screen').innerHTML = `
      <div class="panel panel--narrow">
        <h2 class="h2">${esc(title)}</h2>
        <p class="muted">${esc(text)}</p>
      </div>`;
  },

  /** Всплывашка сверху: ui.toast('Дима поставил 5 против', { icon: '🧔', tone: 'danger' }) */
  toast(text, { icon = '', ms = 3200, tone = '' } = {}) {
    const el = document.createElement('div');
    el.className = `toast${tone ? ` toast--${tone}` : ''}`;
    el.innerHTML = `${icon ? `<span class="toast__icon">${esc(icon)}</span>` : ''}<span>${esc(text)}</span>`;
    $('#toasts').append(el);
    setTimeout(() => {
      el.classList.add('is-out');
      setTimeout(() => el.remove(), 400);
    }, ms);
    return el;
  },
};

/** 75 → "01:15" */
export function formatTime(sec) {
  const s = Math.max(0, Math.ceil(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
