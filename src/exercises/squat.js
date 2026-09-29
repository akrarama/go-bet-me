// Приседания. Владелец: блок 1 (Упражнения).
// Сейчас заглушка от основы: простой счёт по углу колена, без режима «Ошибка».
// Правила и пороги: раздел 5-6 спеки, config.REPS.squat. Общий движок повторов: reps.js.
//
// Контракт контроллера (его читает screens/live.js):
//   model: 'pose'            какая модель нужна
//   unit: 'повторы'          подпись счётчика
//   count                    число на большом счётчике (для медитации секунды, можно дробные)
//   done / failed            цель выполнена / провал раньше времени
//   lives, maxLives          жизни (null, если не нужны)
//   start(t)                 старт после отсчёта
//   frame(frame, t)          кадр, где frame.ran === model
//   stop()                   уход с экрана (необязательно)
//   summary() → { faults: [{ code, text, count }], rejected: [{ code, text, at }], extra }

import { REPS } from '../config.js';
import { angle, ema, pickSide } from '../vision/geometry.js';

export function createController({ challenge, feedback }) {
  const cfg = REPS.squat;
  let phase = 'UP';
  let knee = null;

  const c = {
    model: 'pose',
    unit: 'повторы',
    count: 0,
    done: false,
    failed: false,
    lives: null,

    start() {},

    frame(frame) {
      const lm = frame.pose?.landmarks;
      if (!lm) return;
      const { idx, vis } = pickSide(lm, ['hip', 'knee', 'ankle']);
      if (vis < REPS.minVisibility) {
        feedback.hint('Не весь корпус в кадре, отойди', { level: 'warn', priority: 3, code: 'visibility' });
        return;
      }
      feedback.clear('visibility');
      knee = ema(knee, angle(lm[idx.hip], lm[idx.knee], lm[idx.ankle], frame.width / frame.height), REPS.emaAlpha);
      if (phase === 'UP' && knee < cfg.down) phase = 'DOWN';
      else if (phase === 'DOWN' && knee > cfg.up) {
        phase = 'UP';
        c.count += 1;
        c.done = c.count >= challenge.target;
      }
    },

    summary() {
      return { faults: [], rejected: [] };
    },
  };
  return c;
}
