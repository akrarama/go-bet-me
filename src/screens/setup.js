// SETUP: dwell-кнопки: тип, цель, ставка. 👍 дальше, 👎 назад.
// Владелец: блок 2 (Жесты). Сейчас заглушка: показывает значения по умолчанию.
// Варианты брать из config: CHALLENGES[type].targets, STAKES. Результат писать в ctx.app.challenge.

import { CHALLENGES } from '../config.js';
import { esc } from '../ui.js';

export default {
  model: 'gesture',

  enter(ctx) {
    const prev = ctx.app.challenge;
    const ch = (ctx.app.challenge = ctx.app.newChallenge(prev.type, { target: prev.target, stake: prev.stake }));
    const def = CHALLENGES[ch.type];
    ctx.root.innerHTML = `
      <div class="panel panel--narrow">
        <h2 class="h2">Новый челлендж</h2>
        <p class="lead">${esc(def.emoji)} ${esc(def.label)}: ${ch.target} ${esc(def.unit)}, ставка ${ch.stake} кр.</p>
        <p class="muted">Выбор жестами появится здесь. 👍 дальше, 👎 назад</p>
      </div>`;
    ctx.on('gesture', ({ name }) => {
      if (name === 'Thumb_Up') ctx.app.go('LOBBY');
      if (name === 'Thumb_Down') ctx.app.go('IDLE');
    });
  },
};
