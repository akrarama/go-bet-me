// RESULT: сделал / не сделал, повторы, время, ошибки с количеством,
// расчёт кредитов по каждому участнику, баланс. 👍 ещё раз.
// Владелец: блок 3 (Деньги). Сейчас заглушка. Данные: ctx.app.session и ctx.app.challenge.

import { CHALLENGES } from '../config.js';
import { esc } from '../ui.js';

export default {
  model: 'gesture',

  enter(ctx) {
    const s = ctx.app.session;
    const def = CHALLENGES[ctx.app.challenge.type];
    ctx.root.innerHTML = s
      ? `<div class="panel panel--narrow">
          <h2 class="h2">${s.success ? 'Сделал' : 'Не сделал'}</h2>
          <p class="lead">${esc(def.label)}: ${s.count} из ${s.target}, ${s.durationSec} с</p>
          <ul class="bets">${s.faults.map((f) => `<li>${f.count} × ${esc(f.text)}</li>`).join('')}</ul>
          <p class="muted">Расчёт кредитов появится здесь. 👍 ещё раз</p>
        </div>`
      : `<div class="panel panel--narrow"><h2 class="h2">Итогов пока нет</h2><p class="muted">👍 в начало</p></div>`;
    ctx.on('gesture', ({ name }) => {
      if (name === 'Thumb_Up') ctx.app.go(s ? 'SETUP' : 'IDLE');
    });
  },
};
