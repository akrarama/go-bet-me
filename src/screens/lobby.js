// LOBBY: друзья ставят против (P0: боты), счётчик пула. Старт: рука выше головы 1 с.
// Владелец: блок 2 (Жесты). Ставки ботов даёт блок 3: bots.join(challenge), событие bet.
// Модель: ['gesture', 'pose'] по очереди: палец-курсор и «рука вверх» одновременно.

import { CHALLENGES } from '../config.js';
import { bots } from '../friends/bots.js';
import { esc } from '../ui.js';

export default {
  model: ['gesture', 'pose'],

  enter(ctx) {
    const ch = ctx.app.challenge;
    const def = CHALLENGES[ch.type];
    const render = () => {
      const pool = ch.bets.reduce((s, b) => s + b.amount, 0);
      ctx.root.innerHTML = `
        <div class="panel panel--narrow">
          <h2 class="h2">${esc(def.emoji)} ${esc(def.label)}: ${ch.target}</h2>
          <p class="lead">Твоя ставка ${ch.stake} кр. Против: ${pool} из ${ch.stake} кр.</p>
          <ul class="bets">${ch.bets.map((b) => `<li>${esc(b.avatar)} ${esc(b.name)} ставит ${b.amount} кр. против</li>`).join('')}</ul>
          <p class="muted">Подними руку над головой, чтобы начать. 👎 назад</p>
        </div>`;
    };
    render();
    ctx.on('bet', render);
    bots.join(ch);
    ctx.on('handup', () => ctx.app.go('LIVENESS'));
    ctx.on('gesture', ({ name }) => {
      if (name === 'Thumb_Down') ctx.app.go('SETUP');
    });
  },
};
