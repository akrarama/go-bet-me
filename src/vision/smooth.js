// Сглаживание точек скелета фильтром One Euro (Casiez и др., CHI 2012): стандарт для живого трекинга.
// В покое сильно гасит дрожание, в быстром движении почти не отстаёт (частота среза растёт со скоростью).
// Чистые функции, без DOM (тесты идут в jsc). Используется для отрисовки скелета (draw.js):
// счёт повторов откалиброван на своём EMA по углам и этот фильтр не трогает.

import { VISION } from '../config.js';

const alphaOf = (cutoff, dt) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

/**
 * Фильтр одного числа. t в мс.
 * minCutoff (Гц): меньше = глаже в покое; beta: больше = меньше отставания в движении.
 */
export function createOneEuro({ minCutoff = 1.0, beta = 1, dCutoff = 1 } = {}) {
  let x = null;
  let dx = 0;
  let lastT = null;
  return {
    filter(value, t) {
      if (x == null || lastT == null || !(t > lastT)) {
        x = value;
        dx = 0;
        lastT = t;
        return x;
      }
      const dt = (t - lastT) / 1000;
      lastT = t;
      const rawDx = (value - x) / dt;
      dx += alphaOf(dCutoff, dt) * (rawDx - dx);
      const cutoff = minCutoff + beta * Math.abs(dx);
      x += alphaOf(cutoff, dt) * (value - x);
      return x;
    },
    reset() {
      x = null;
      dx = 0;
      lastT = null;
    },
  };
}

/**
 * Сглаживатель набора точек { x, y, z, visibility }: свой фильтр на каждую координату.
 * Если между кадрами пауза больше resetMs (человек пропал из кадра), начинаем заново, без «хвоста».
 * smooth(landmarks, t) → новый массив той же длины (visibility не сглаживается).
 */
export function createLandmarkSmoother({ minCutoff = VISION.smooth.minCutoff, beta = VISION.smooth.beta, resetMs = VISION.smooth.resetMs } = {}) {
  let filters = [];
  let lastT = null;
  const make = () => ({ x: createOneEuro({ minCutoff, beta }), y: createOneEuro({ minCutoff, beta }), z: createOneEuro({ minCutoff, beta }) });
  return {
    smooth(lm, t) {
      if (!lm) return lm;
      if (lastT == null || t - lastT > resetMs || filters.length !== lm.length) filters = lm.map(make);
      lastT = t;
      return lm.map((p, i) => ({
        x: filters[i].x.filter(p.x, t),
        y: filters[i].y.filter(p.y, t),
        z: filters[i].z.filter(p.z ?? 0, t),
        visibility: p.visibility,
      }));
    },
    reset() {
      filters = [];
      lastT = null;
    },
  };
}

/**
 * Какая сторона тела ближе к камере, если человек стоит в профиль: 'left' | 'right' | null (стоит лицом,
 * обе стороны видны одинаково). По разнице средней visibility руки и ноги каждой стороны.
 */
export function nearSide(lm, gap = VISION.smooth.farSideGap) {
  if (!lm) return null;
  const avg = (ids) => ids.reduce((s, i) => s + (lm[i]?.visibility ?? 0), 0) / ids.length;
  const l = avg([11, 13, 15, 23, 25, 27]);
  const r = avg([12, 14, 16, 24, 26, 28]);
  if (Math.abs(l - r) < gap) return null;
  return l > r ? 'left' : 'right';
}
