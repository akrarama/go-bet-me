// IDLE: заставка и «покажи 👍, чтобы начать». 👍 → SETUP.
// Запасной путь, если 👍 не ловится: dwell-кнопка «Начать» (палец-курсор, 1 с) → SETUP.
// Ниже спокойная легенда «Как управлять»: жесты для тех, кто открыл ссылку и их не знает.
// Владелец: блок 2 (Жесты). Пока 👍 держится, плашка заполняется (gestures.pending).
// Без звука: браузер разрешает его только после первого касания.

import { GESTURES } from '../config.js';
import { gestures } from '../vision/gestures.js';

/** «1 секунду» для целой секунды, иначе «1,5 с» (значения из config, текст не должен врать при их смене). */
const secText = (ms) => {
  const s = Math.round(ms / 100) / 10;
  return s === 1 ? '1 секунду' : `${String(s).replace('.', ',')} с`;
};

/** Легенда: иконка, название, пояснение. Тексты простым языком, без длинных слов. */
const LEGEND = [
  { icon: '👍', pair: '👎', name: 'Дальше и назад', sub: 'большой палец вверх или вниз' },
  { icon: '☝️', name: 'Палец как курсор', sub: `держи на кнопке ${secText(GESTURES.dwellMs)}` },
  { icon: '✋', name: 'Рука над головой', sub: `старт, держи ${secText(GESTURES.handUpMs)}` },
  { icon: '🙂', name: 'В челлендже', sub: 'ИИ следит за телом и лицом' },
];

let cta = null;

/** Заполнение от удержания жеста: --hold 0..1 и .is-holding. Пишет в DOM, только когда значение изменилось. */
export function setHold(el, value) {
  if (!el) return;
  const v = Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
  if (el.holdValue === v) return;
  el.holdValue = v;
  el.style.setProperty('--hold', v);
  el.classList.toggle('is-holding', v > 0);
}

export default {
  model: 'gesture',

  enter(ctx) {
    ctx.root.innerHTML = `
      <div class="hero idle">
        <h1 class="title">Против</h1>
        <p class="subtitle">Поставь на себя. Друзья ставят против. ИИ судит по камере.</p>
        <div class="gesture-cta idle-cta">
          <span class="gesture-cta__icon" aria-hidden="true">👍</span><span>Покажи 👍, чтобы начать</span>
        </div>
        <div class="idle-alt">
          <p class="idle-alt__text">Не ловится 👍? Наведи палец на кнопку и подержи секунду</p>
          <button class="btn idle-start" data-dwell data-action="start">Начать</button>
        </div>
        <section class="idle-legend" aria-labelledby="idle-legend-title">
          <h2 class="idle-legend__title" id="idle-legend-title">Как управлять</h2>
          <ul class="idle-legend__list">${LEGEND.map(
            (it) => `
            <li class="idle-legend__item">
              <span class="idle-legend__icon${it.pair ? ' idle-legend__icon--pair' : ''}" aria-hidden="true">${it.icon}${it.pair ?? ''}</span>
              <span class="idle-legend__text"><span class="idle-legend__name">${it.name}</span><span class="idle-legend__sub">${it.sub}</span></span>
            </li>`,
          ).join('')}
          </ul>
        </section>
      </div>`;
    cta = ctx.root.querySelector('.idle-cta');
    let left = false; // 👍 и кнопка сработали почти вместе: SETUP открываем один раз
    const start = () => {
      if (left) return;
      left = true;
      ctx.app.go('SETUP');
    };
    ctx.root.querySelector('.idle-start').addEventListener('click', start);
    ctx.on('gesture', ({ name }) => {
      if (name === 'Thumb_Up') start();
    });
  },

  frame() {
    const p = gestures.pending;
    setHold(cta, p?.name === 'Thumb_Up' ? p.progress : 0);
  },

  exit() {
    cta = null;
  },
};
