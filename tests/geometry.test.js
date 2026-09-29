// Тесты геометрии. Владелец: координатор.

import { angle, belowLine, ema, pickSide, tiltFromVertical } from '../src/vision/geometry.js';

const p = (x, y, visibility = 1) => ({ x, y, visibility });

export default (t) => {
  t.test('прямой угол = 90°', (a) => a.near(angle(p(0, 0), p(0, 1), p(1, 1)), 90, 1e-9));
  t.test('прямая линия = 180°', (a) => a.near(angle(p(0, 0), p(0.5, 0.5), p(1, 1)), 180, 1e-9));
  t.test('aspect растягивает x: 45° в нормализованных = 60.6° в кадре 16:9', (a) => {
    a.near(angle(p(1, 0), p(0, 0), p(1, 1)), 45, 1e-9);
    a.near(angle(p(1, 0), p(0, 0), p(1, 1), 16 / 9), (Math.atan2(1, 16 / 9) * 180) / Math.PI, 1e-9);
  });
  t.test('наклон к вертикали', (a) => {
    a.near(tiltFromVertical(p(0.5, 0.2), p(0.5, 0.6)), 0, 1e-9);
    a.near(tiltFromVertical(p(0, 0), p(1, 1)), 45, 1e-9);
  });
  t.test('belowLine: y растёт вниз, провис > 0', (a) => {
    a.near(belowLine(p(0.5, 0.6), p(0, 0.5), p(1, 0.5)), 0.1, 1e-9);
    a.near(belowLine(p(0.5, 0.4), p(0, 0.5), p(1, 0.5)), -0.1, 1e-9);
  });
  t.test('ema: первое значение как есть, дальше сглаживает', (a) => {
    a.eq(ema(null, 100, 0.3), 100);
    a.near(ema(100, 200, 0.3), 130, 1e-9);
  });
  t.test('pickSide берёт сторону, которую лучше видно', (a) => {
    const lm = Array.from({ length: 33 }, () => p(0.5, 0.5, 0.2));
    for (const i of [12, 14, 16, 24, 26, 28]) lm[i].visibility = 0.9;
    a.eq(pickSide(lm).side, 'right');
  });
};
