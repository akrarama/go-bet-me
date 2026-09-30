// IDLE: заставка и «покажи 👍, чтобы начать». 👍 → SETUP.
// Запасной путь, если 👍 не ловится: dwell-кнопка «Начать» (палец-курсор, 1 с) → SETUP.
// Владелец: блок 2 (Жесты). Пока 👍 держится, плашка заполняется (gestures.pending).
// Без звука: браузер разрешает его только после первого касания.

import { gestures } from '../vision/gestures.js';

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
