// LIVENESS: случайное задание из {левая рука вверх, правая рука вверх, 👍, 🖐}, 5 с.
// Не выполнил → LOBBY. Выполнил → LIVE.
// Владелец: блок 2 (Жесты). Сейчас заглушка: 👍 = прошёл, 5 с без него = назад в LOBBY.

import { GESTURES } from '../config.js';

export default {
  model: ['gesture', 'pose'],

  enter(ctx) {
    ctx.root.innerHTML = `
      <div class="panel panel--narrow">
        <h2 class="h2">Проверка, что ты живой</h2>
        <p class="lead">Покажи 👍</p>
      </div>`;
    ctx.on('gesture', ({ name }) => {
      if (name === 'Thumb_Up') ctx.app.go('LIVE');
    });
    ctx.timeout(() => ctx.app.go('LOBBY', { reason: 'liveness' }), GESTURES.livenessSec * 1000);
  },
};
