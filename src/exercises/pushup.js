// Отжимания. Владелец: блок 1 (Упражнения).
// Сейчас заглушка от основы: простой счёт по углу локтя, без режима «Ошибка».
// Правила и пороги: раздел 5-6 спеки, config.REPS.pushup. Контракт контроллера: см. squat.js.

import { REPS } from '../config.js';
import { angle, ema, pickSide } from '../vision/geometry.js';

export function createController({ challenge, feedback }) {
  const cfg = REPS.pushup;
  let phase = 'UP';
  let elbow = null;

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
      const { idx, vis } = pickSide(lm, ['shoulder', 'elbow', 'wrist', 'hip', 'ankle']);
      if (vis < REPS.minVisibility) {
        feedback.hint('Не весь корпус в кадре, отойди', { level: 'warn', priority: 3, code: 'visibility' });
        return;
      }
      feedback.clear('visibility');
      elbow = ema(elbow, angle(lm[idx.shoulder], lm[idx.elbow], lm[idx.wrist], frame.width / frame.height), REPS.emaAlpha);
      if (phase === 'UP' && elbow < cfg.down) phase = 'DOWN';
      else if (phase === 'DOWN' && elbow > cfg.up) {
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
