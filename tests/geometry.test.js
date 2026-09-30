// Тесты геометрии. Владелец: координатор.

import { angle, belowLine, ema, pickSide, tiltFromVertical } from '../src/vision/geometry.js';
import { createLandmarkSmoother, createOneEuro, nearSide } from '../src/vision/smooth.js';

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
  // ─── Сглаживание скелета (One Euro) ───
  t.test('One Euro: в покое гасит дрожание точки в разы', (a) => {
    const f = createOneEuro({ minCutoff: 1.0, beta: 1 });
    const raw = [];
    const out = [];
    for (let i = 0; i < 90; i++) {
      const v = 0.5 + (i % 2 ? 0.01 : -0.01); // дрожь ±1% кадра на 30 fps
      raw.push(v);
      out.push(f.filter(v, i * 33.3));
    }
    const spread = (xs) => Math.max(...xs.slice(30)) - Math.min(...xs.slice(30));
    a.ok(spread(out) < spread(raw) / 4, `разброс ${spread(out).toFixed(4)} против ${spread(raw).toFixed(4)}`);
  });

  t.test('One Euro: быстрое движение догоняет за пару кадров, без долгого хвоста', (a) => {
    const f = createOneEuro({ minCutoff: 1.0, beta: 1 });
    let v = 0;
    for (let i = 0; i < 10; i++) v = f.filter(0.2, i * 33.3);
    for (let i = 10; i < 16; i++) v = f.filter(0.8, i * 33.3); // рывок на 60% кадра (прыжок)
    a.ok(Math.abs(v - 0.8) < 0.06, `через 6 кадров ${v.toFixed(3)}`);
  });

  t.test('сглаживатель точек: пауза в данных начинает заново, visibility как есть', (a) => {
    const s = createLandmarkSmoother({ minCutoff: 1.0, beta: 1, resetMs: 500 });
    s.smooth([p(0.1, 0.1, 0.9)], 0);
    s.smooth([p(0.1, 0.1, 0.9)], 33);
    const after = s.smooth([p(0.9, 0.9, 0.4)], 2000);
    a.near(after[0].x, 0.9, 1e-9);
    a.eq(after[0].visibility, 0.4);
  });

  t.test('nearSide: в профиль ближняя сторона, лицом к камере null', (a) => {
    const lm = Array.from({ length: 33 }, () => p(0.5, 0.5, 0.95));
    a.eq(nearSide(lm), null);
    for (const i of [12, 14, 16, 24, 26, 28]) lm[i].visibility = 0.55;
    a.eq(nearSide(lm), 'left');
  });

  // Настоящий ролик (fixtures/traces, в git не лежит): дрожание запястья в упоре меньше хотя бы вдвое
  t.test('ролик: One Euro уменьшает дрожание точек скелета', (a) => {
    let data = null;
    try {
      data = typeof readFile === 'function' ? JSON.parse(readFile('../fixtures/traces/squat-side.json')) : null;
    } catch {
      data = null;
    }
    if (!data) return;
    const s = createLandmarkSmoother({ minCutoff: 1.0, beta: 1, resetMs: 500 });
    const jitter = (xs) => xs.slice(2).reduce((sum, x, i) => sum + Math.abs(x - 2 * xs[i + 1] + xs[i]), 0) / (xs.length - 2);
    const raw = [];
    const sm = [];
    data.frames.forEach((f, i) => {
      const lm = (Array.isArray(f) ? f : f?.lm)?.map(([x, y, z, visibility]) => ({ x, y, z, visibility }));
      if (!lm) return;
      const out = s.smooth(lm, (i * 1000) / data.input.fps);
      raw.push(lm[15].y);
      sm.push(out[15].y);
    });
    a.ok(jitter(sm) < jitter(raw) / 2, `рывки ${jitter(sm).toFixed(4)} против ${jitter(raw).toFixed(4)}`);
  });
};
