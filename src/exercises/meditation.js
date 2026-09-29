// Медитация. Владелец: блок 4 (Медитация).
// Сейчас заглушка от основы: секунды идут, пока глаза закрыты. Без жизней и нарушений.
// Правила: раздел 5-6 спеки, config.MEDITATION. Контракт контроллера: см. squat.js.

import { MEDITATION } from '../config.js';

export function createController({ challenge }) {
  let last = 0;

  const c = {
    model: 'face',
    unit: 'секунды',
    count: 0,
    done: false,
    failed: false,
    lives: MEDITATION.lives,
    maxLives: MEDITATION.lives,

    start(t) {
      last = t;
    },

    frame(frame, t) {
      const dt = Math.min(0.5, (t - last) / 1000);
      last = t;
      const bs = frame.face?.blendshapes?.[0];
      if (!bs) return;
      const closed = ((bs.eyeBlinkLeft ?? 0) + (bs.eyeBlinkRight ?? 0)) / 2 > MEDITATION.eyesClosedMin;
      if (closed) c.count += dt;
      c.done = c.count >= challenge.target;
    },

    summary() {
      return { faults: [], rejected: [] };
    },
  };
  return c;
}
