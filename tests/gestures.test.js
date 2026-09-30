// Тесты блока 2 (Жесты): удержание жеста, рука над головой, liveness, dwell, сглаживание курсора.
// Синтетические последовательности кадров, время в мс (шаг 50 мс ≈ 20 кадров/с, целые числа без округлений).

import { GESTURES } from '../src/config.js';
import { createGestureGate, createHandUpTracker, pickLivenessTask, livenessTaskFor, createLivenessJudge, LIVENESS_TEXT } from '../src/vision/gestures.js';
import { createOneEuro2D, createDweller } from '../src/ui/dwell.js';
import { createFeedback } from '../src/feedback.js';
import { VERDICT_HINT } from '../src/screens/liveness.js';
import { cleanName, cleanAvatar, cleanUrl, shortLink, createInvite, attachInvite, betRow, qrSvg, loadQr } from '../src/ui/invite.js';

const G = GESTURES;
const STEP = 50;

// ─── Помощники ──────────────────────────────────────────────────

/** Подаёт жест name с from до to (не включая) с шагом STEP. → [{ name, t }] сработавших. */
function show(gate, name, from, to, score = 0.9) {
  const fired = [];
  for (let t = from; t < to; t += STEP) {
    const f = gate.update(name, score, t);
    if (f) fired.push({ name: f, t });
  }
  return fired;
}

/** Поза из 33 точек. Руки: { wrist, elbow } по y (0 сверху), видимость по умолчанию 0.9. */
const DOWN = { wrist: 0.8, elbow: 0.6 };
const UP = { wrist: 0.1, elbow: 0.2 };
const LOW = { wrist: 0.45, elbow: 0.55 }; // запястье выше локтя, но ниже носа
function body({ left = DOWN, right = DOWN, nose = 0.3, noseVis = 0.95 } = {}) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.7, z: 0, visibility: 0.9 }));
  const put = (i, x, y, v) => (lm[i] = { x, y, z: 0, visibility: v });
  put(0, 0.5, nose, noseVis);
  put(13, 0.6, left.elbow, left.elbowVis ?? 0.9);
  put(15, 0.62, left.wrist, left.wristVis ?? 0.9);
  put(14, 0.4, right.elbow, right.elbowVis ?? 0.9);
  put(16, 0.38, right.wrist, right.wristVis ?? 0.9);
  return lm;
}

/** Подаёт позу (или функцию t → поза) с from до to. → [{ side, t }] сработавших. */
function pose(tr, lm, from, to) {
  const fired = [];
  for (let t = from; t < to; t += STEP) for (const side of tr.update(typeof lm === 'function' ? lm(t) : lm, t)) fired.push({ side, t });
  return fired;
}

const btn = (id, x, y, w = 200, h = 90, disabled = false) => ({ el: { id }, x, y, w, h, disabled });
const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Ведёт курсор pos (или t → pos) по целям targets (или t → targets) с from до to, шаг 20 мс. */
function hover(dw, pos, targets, from, to, step = 20) {
  const clicks = [];
  let last = null;
  for (let t = from; t < to; t += step) {
    last = dw.update(typeof pos === 'function' ? pos(t) : pos, typeof targets === 'function' ? targets(t) : targets, t);
    if (last.click) clicks.push({ id: last.click.id, t });
  }
  return { clicks, last };
}

/** Детерминированный шум 0..1. */
function rng(seed = 7) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}
const variance = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
};

export default (t) => {
  // ─── Удержание жеста ──────────────────────────────────────────

  t.test('жест: срабатывает один раз ровно через holdMs от первого кадра, не раньше', (a) => {
    const g = createGestureGate();
    a.deep(show(g, 'None', 0, 1000), []);
    const fired = show(g, 'Thumb_Up', 1000, 4000);
    a.deep(fired, [{ name: 'Thumb_Up', t: 1000 + G.holdMs }], 'держали 3 с:');
    a.eq(g.current, 'Thumb_Up');
  });

  t.test('жест: за 1 мс до holdMs не срабатывает', (a) => {
    const g = createGestureGate();
    show(g, 'None', 0, 1000);
    for (let t = 1000; t <= 1300; t += STEP) a.eq(g.update('Thumb_Up', 0.9, t), null);
    a.eq(g.update('Thumb_Up', 0.9, 1000 + G.holdMs - 1), null);
    a.eq(g.update('Thumb_Up', 0.9, 1000 + G.holdMs), 'Thumb_Up');
  });

  t.test('жест: низкая уверенность не срабатывает никогда', (a) => {
    const g = createGestureGate();
    a.deep(show(g, 'Thumb_Up', 0, 5000, G.minScore - 0.01), []);
    a.eq(g.current, 'None');
    a.eq(g.pending(5000), null);
  });

  t.test('жест: категории не из names (кулак, V, None) не шлют событие', (a) => {
    for (const name of ['Closed_Fist', 'Victory', 'ILoveYou', 'None', '']) {
      const g = createGestureGate();
      a.deep(show(g, name, 0, 4000), [], `${name}:`);
      a.eq(g.pending(4000), null, `${name} pending:`);
    }
  });

  t.test('жест: 1-2 пропущенных кадра (< dropMs) не сбрасывают удержание', (a) => {
    const g = createGestureGate();
    show(g, 'None', 0, 1000);
    const fired = [...show(g, 'Thumb_Up', 1000, 1200), ...show(g, 'None', 1200, 1300), ...show(g, 'Thumb_Up', 1300, 3000)];
    a.deep(fired, [{ name: 'Thumb_Up', t: 1400 }]);
  });

  t.test('жест: на пропущенном кадре не срабатывает, срабатывает на следующем видимом', (a) => {
    const g = createGestureGate();
    show(g, 'None', 0, 1000);
    const fired = [...show(g, 'Thumb_Up', 1000, 1400), ...show(g, 'Victory', 1400, 1500), ...show(g, 'Thumb_Up', 1500, 2000)];
    a.deep(fired, [{ name: 'Thumb_Up', t: 1500 }]);
  });

  t.test('жест: после срабатывания 1-2 пропущенных кадра не взводят жест заново', (a) => {
    const g = createGestureGate();
    show(g, 'None', 0, 1000);
    const fired = [...show(g, 'Thumb_Up', 1000, 2000), ...show(g, 'None', 2000, 2100), ...show(g, 'Thumb_Up', 2100, 3000), ...show(g, 'Open_Palm', 3000, 3100), ...show(g, 'Thumb_Up', 3100, 6000)];
    a.deep(fired, [{ name: 'Thumb_Up', t: 1400 }]);
  });

  t.test('жест: убрал дольше dropMs и показал снова: сработает, но не раньше cooldownMs', (a) => {
    const g = createGestureGate();
    show(g, 'None', 0, 1000);
    const fired = [...show(g, 'Thumb_Up', 1000, 1450), ...show(g, 'None', 1450, 1750), ...show(g, 'Thumb_Up', 1750, 4000)];
    a.deep(fired, [{ name: 'Thumb_Up', t: 1400 }, { name: 'Thumb_Up', t: 1400 + G.cooldownMs }]);
  });

  t.test('жест: показал снова уже после cooldown: срабатывает через holdMs', (a) => {
    const g = createGestureGate();
    show(g, 'None', 0, 1000);
    const fired = [...show(g, 'Thumb_Up', 1000, 1450), ...show(g, 'None', 1450, 3000), ...show(g, 'Thumb_Up', 3000, 4000)];
    a.deep(fired, [{ name: 'Thumb_Up', t: 1400 }, { name: 'Thumb_Up', t: 3000 + G.holdMs }]);
  });

  t.test('жест: другой жест сразу после срабатывания ждёт cooldown и срабатывает, пока его держат', (a) => {
    const g = createGestureGate();
    show(g, 'None', 0, 1000);
    const fired = [...show(g, 'Thumb_Up', 1000, 1450), ...show(g, 'Open_Palm', 1450, 4000)];
    a.deep(fired, [{ name: 'Thumb_Up', t: 1400 }, { name: 'Open_Palm', t: 1400 + G.cooldownMs }]);
  });

  t.test('жест: другой жест, убранный до конца cooldown, не срабатывает', (a) => {
    const g = createGestureGate();
    show(g, 'None', 0, 1000);
    const fired = [...show(g, 'Thumb_Up', 1000, 1450), ...show(g, 'Open_Palm', 1450, 2400), ...show(g, 'None', 2400, 4000)];
    a.deep(fired, [{ name: 'Thumb_Up', t: 1400 }]);
  });

  t.test('жест: latch блокирует удерживаемый жест, пока его не уберут и не покажут снова', (a) => {
    const g = createGestureGate();
    show(g, 'None', 0, 1000);
    show(g, 'Thumb_Up', 1000, 1250);
    g.latch(); // экран сменился посреди удержания
    a.deep(show(g, 'Thumb_Up', 1250, 4000), [], 'держим дальше:');
    a.eq(g.pending(4000), null);
    a.eq(g.held, 'Thumb_Up');
    a.deep(show(g, 'None', 4000, 4300), []);
    a.eq(g.held, null);
    a.deep(show(g, 'Thumb_Up', 4300, 6000), [{ name: 'Thumb_Up', t: 4300 + G.holdMs }]);
  });

  t.test('жест: latch после срабатывания тоже держит блок', (a) => {
    const g = createGestureGate();
    show(g, 'None', 0, 1000);
    a.eq(show(g, 'Thumb_Up', 1000, 1500).length, 1);
    g.latch();
    a.deep(show(g, 'Thumb_Up', 1500, 5000), []);
  });

  t.test('жест: latch без руки не мешает новому жесту', (a) => {
    const g = createGestureGate();
    show(g, 'None', 0, 500);
    g.latch();
    show(g, 'None', 500, 1000);
    a.deep(show(g, 'Thumb_Up', 1000, 2000), [{ name: 'Thumb_Up', t: 1400 }]);
  });

  t.test('жест: latch на жесте не из names не мешает показать 👍', (a) => {
    const g = createGestureGate();
    show(g, 'Closed_Fist', 0, 1000);
    g.latch();
    a.deep(show(g, 'Thumb_Up', 1000, 2000), [{ name: 'Thumb_Up', t: 1400 }]);
  });

  t.test('жест: смена с одного жеста на другой: удержание с первого кадра нового', (a) => {
    const g = createGestureGate();
    show(g, 'Closed_Fist', 0, 1000);
    a.deep(show(g, 'Open_Palm', 1000, 2000), [{ name: 'Open_Palm', t: 1000 + G.holdMs }]);
  });

  t.test('жест: pending показывает прогресс удержания', (a) => {
    const g = createGestureGate();
    show(g, 'None', 0, 1000);
    a.eq(g.pending(990), null, 'без руки:');
    g.update('Thumb_Up', 0.9, 1000);
    a.deep(g.pending(1100), { name: 'Thumb_Up', progress: 0.25 }, 'кандидат ещё не сменился:');
    show(g, 'Thumb_Up', 1050, 1250);
    a.deep(g.pending(1200), { name: 'Thumb_Up', progress: 0.5 });
    g.update('None', 0, 1250); // пропуск: прогресс замирает на последнем видимом кадре
    a.deep(g.pending(1300), { name: 'Thumb_Up', progress: 0.5 });
    show(g, 'Thumb_Up', 1300, 1400);
    a.deep(g.pending(1350), { name: 'Thumb_Up', progress: 0.875 });
    a.eq(g.update('Thumb_Up', 0.9, 1400), 'Thumb_Up');
    a.eq(g.pending(1400), null, 'после срабатывания:');
  });

  t.test('жест: reset возвращает к началу', (a) => {
    const g = createGestureGate();
    show(g, 'Thumb_Up', 0, 1000);
    g.reset();
    a.eq(g.current, 'None');
    a.deep(show(g, 'Thumb_Up', 1000, 2000), [{ name: 'Thumb_Up', t: 1000 + G.holdMs }], 'cooldown тоже забыт:');
  });

  // ─── Рука над головой ─────────────────────────────────────────

  t.test('рука: левая = точка 15, шлёт left через handUpMs, не раньше', (a) => {
    const tr = createHandUpTracker();
    a.deep(pose(tr, body(), 0, 500), []);
    a.deep(pose(tr, body({ left: UP }), 500, 3000), [{ side: 'left', t: 500 + G.handUpMs }]);
  });

  t.test('рука: правая = точка 16, шлёт right', (a) => {
    const tr = createHandUpTracker();
    a.deep(pose(tr, body({ right: UP }), 0, 3000), [{ side: 'right', t: G.handUpMs }]);
    a.eq(tr.right.up, true);
    a.eq(tr.left.up, false);
  });

  t.test('рука: за 1 мс до handUpMs не срабатывает, прогресс растёт', (a) => {
    const tr = createHandUpTracker();
    a.deep(pose(tr, body({ left: UP }), 0, 550), []);
    a.near(tr.left.progress, 0.5, 1e-9);
    a.deep(pose(tr, body({ left: UP }), 550, G.handUpMs), []);
    a.deep(tr.update(body({ left: UP }), G.handUpMs - 1), []);
    a.deep(tr.update(body({ left: UP }), G.handUpMs), ['left']);
    a.eq(tr.left.progress, 1);
    a.eq(tr.left.fired, true);
  });

  t.test('рука: низкая видимость запястья или носа: не вверх', (a) => {
    const t1 = createHandUpTracker();
    a.deep(pose(t1, body({ left: { ...UP, wristVis: G.minVisibility - 0.01 } }), 0, 3000), []);
    a.eq(t1.left.up, false);
    a.eq(t1.left.visible, false);
    const t2 = createHandUpTracker();
    a.deep(pose(t2, body({ right: UP, noseVis: 0.2 }), 0, 3000), []);
    a.eq(t2.right.up, false);
  });

  t.test('рука: гистерезис у линии носа', (a) => {
    const at = (y) => body({ left: { wrist: y, elbow: 0.45 } });
    const t1 = createHandUpTracker();
    a.deep(pose(t1, at(0.31), 0, 2000), [], 'чуть ниже носа сразу: не вверх:');
    const t2 = createHandUpTracker();
    pose(t2, at(0.29), 0, 200);
    a.eq(t2.left.up, true);
    // опустилась ниже носа, но меньше чем на handReleaseY: всё ещё вверх, срабатывает вовремя
    a.deep(pose(t2, at(0.3 + G.handReleaseY / 2), 200, 1500), [{ side: 'left', t: G.handUpMs }]);
    a.eq(t2.left.up, true);
    pose(t2, at(0.3 + G.handReleaseY * 2), 1500, 1500 + G.handDropMs + 2 * STEP);
    a.eq(t2.left.up, false, 'ниже порога дольше handDropMs:');
  });

  t.test('рука: короткий пропуск (< handDropMs) сохраняет прогресс', (a) => {
    const tr = createHandUpTracker();
    const lost = body({ left: { ...UP, wristVis: 0.1 } });
    const fired = [...pose(tr, body({ left: UP }), 0, 300), ...pose(tr, lost, 300, 400)];
    a.eq(tr.left.up, true, 'в пропуске:');
    a.near(tr.left.progress, 0.25, 1e-9, 'прогресс замер на последнем видимом кадре:');
    fired.push(...pose(tr, body({ left: UP }), 400, 2000));
    a.deep(fired, [{ side: 'left', t: G.handUpMs }]);
  });

  t.test('рука: пропуск без человека (null) короче handDropMs тоже не сбрасывает', (a) => {
    const tr = createHandUpTracker();
    const fired = [...pose(tr, body({ right: UP }), 0, 400), ...pose(tr, null, 400, 500), ...pose(tr, body({ right: UP }), 500, 2000)];
    a.deep(fired, [{ side: 'right', t: G.handUpMs }]);
  });

  t.test('рука: длинный пропуск сбрасывает и взводит заново', (a) => {
    const tr = createHandUpTracker();
    pose(tr, body({ left: UP }), 0, 300);
    pose(tr, body({ left: { ...UP, wristVis: 0.1 } }), 300, 650);
    a.eq(tr.left.up, false);
    a.eq(tr.left.progress, 0);
    a.eq(tr.left.armed, true);
    a.deep(pose(tr, body({ left: UP }), 650, 3000), [{ side: 'left', t: 650 + G.handUpMs }]);
  });

  t.test('рука: один раз за подъём, второй подъём снова срабатывает', (a) => {
    const tr = createHandUpTracker();
    const fired = [...pose(tr, body({ left: UP }), 0, 5000), ...pose(tr, body(), 5000, 5500), ...pose(tr, body({ left: UP }), 5500, 8000)];
    a.deep(fired, [{ side: 'left', t: 1000 }, { side: 'left', t: 6500 }]);
  });

  t.test('рука: обе вверх: срабатывают обе', (a) => {
    const tr = createHandUpTracker();
    a.deep(pose(tr, body({ left: UP, right: UP }), 0, 3000), [{ side: 'left', t: 1000 }, { side: 'right', t: 1000 }]);
  });

  t.test('рука: были подняты обе, одну опустили: оставшаяся сообщает ещё раз, один раз', (a) => {
    const tr = createHandUpTracker();
    pose(tr, body({ left: UP, right: UP }), 0, 1500);
    const fired = pose(tr, body({ left: UP }), 1500, 5000);
    a.eq(fired.length, 1);
    a.eq(fired[0].side, 'left');
    a.ok(fired[0].t > 1500 + G.handDropMs - STEP, 'не раньше, чем правая считается опущенной');
  });

  t.test('рука: latch: сначала нужно увидеть руку внизу', (a) => {
    const tr = createHandUpTracker();
    pose(tr, body({ left: UP }), 0, 500);
    tr.latch();
    a.deep(pose(tr, body({ left: UP }), 500, 3000), [], 'держим после смены экрана:');
    a.eq(tr.left.up, true);
    a.eq(tr.left.armed, false);
    a.eq(tr.left.progress, 0);
    pose(tr, body(), 3000, 3400);
    a.eq(tr.left.armed, true);
    a.deep(pose(tr, body({ left: UP }), 3400, 5000), [{ side: 'left', t: 3400 + G.handUpMs }]);
  });

  t.test('рука: latch после срабатывания: рука вверху не показывает полный прогресс', (a) => {
    const tr = createHandUpTracker();
    pose(tr, body({ right: UP }), 0, 1500);
    a.eq(tr.right.progress, 1);
    tr.latch();
    pose(tr, body({ right: UP }), 1500, 2000);
    a.eq(tr.right.progress, 0);
    a.eq(tr.right.fired, true);
  });

  t.test('рука: latch: рука не видна = опущена, взводится сразу', (a) => {
    const tr = createHandUpTracker();
    tr.latch();
    tr.update(body({ left: { ...DOWN, wristVis: 0 } }), 0);
    a.eq(tr.left.armed, true);
    a.deep(pose(tr, body({ left: UP }), 50, 2000), [{ side: 'left', t: 50 + G.handUpMs }]);
  });

  t.test('рука: «низко» и «вне кадра» считают время', (a) => {
    const tr = createHandUpTracker();
    pose(tr, body({ left: LOW }), 0, 1250);
    a.eq(tr.left.low, true);
    a.eq(tr.left.lowMs, 1200);
    a.eq(tr.left.up, false);
    tr.update(body({ left: UP }), 1250);
    a.eq(tr.left.low, false, 'подняли выше головы:');
    a.eq(tr.left.lowMs, 0);

    const t2 = createHandUpTracker();
    const out = body({ right: { wrist: 0.05, elbow: 0.2, wristVis: 0.1 } }); // локоть выше носа, кисти не видно
    pose(t2, out, 0, 1050);
    a.eq(t2.right.out, true);
    a.eq(t2.right.outMs, 1000);
    t2.update(body({ right: UP }), 1050);
    a.eq(t2.right.out, false, 'кисть снова видна:');
  });

  t.test('рука: «низко» терпит короткий пропуск', (a) => {
    const tr = createHandUpTracker();
    pose(tr, body({ left: LOW }), 0, 500);
    pose(tr, null, 500, 600);
    a.eq(tr.left.low, true);
    pose(tr, body({ left: LOW }), 600, 1100);
    a.eq(tr.left.lowMs, 1050);
  });

  t.test('рука: пауза между кадрами дольше handDropMs сбрасывает подъём', (a) => {
    const tr = createHandUpTracker();
    pose(tr, body({ left: UP }), 0, 650);
    a.near(tr.left.progress, 0.6, 1e-9);
    const fired = pose(tr, body({ left: UP }), 600 + G.handDropMs + STEP, 3000);
    a.deep(fired, [{ side: 'left', t: 600 + G.handDropMs + STEP + G.handUpMs }]);
  });

  t.test('рука: пауза ровно handDropMs не сбрасывает', (a) => {
    const tr = createHandUpTracker();
    pose(tr, body({ left: UP }), 0, 650);
    a.deep(pose(tr, body({ left: UP }), 600 + G.handDropMs, 2000), [{ side: 'left', t: 1000 }]);
  });

  t.test('рука: tick двигает прогресс между кадрами и сбрасывает устаревшее', (a) => {
    const tr = createHandUpTracker();
    tr.update(body({ right: UP }), 0);
    tr.tick(30);
    a.near(tr.right.progress, 0.03, 1e-9);
    tr.tick(G.handDropMs + 1);
    a.eq(tr.right.up, false, 'модель позы замолчала:');
    a.eq(tr.right.progress, 0);
  });

  t.test('рука: нет человека (null) и best()', (a) => {
    const tr = createHandUpTracker();
    a.deep(pose(tr, null, 0, 2000), []);
    a.eq(tr.left.visible, false);
    a.eq(tr.best(), null, 'позы ещё не было:');
    tr.update(body({ right: LOW }), 2000);
    a.eq(tr.best().side, 'right', 'низко лучше, чем ничего:');
    pose(tr, body({ left: UP, right: LOW }), 2050, 2600);
    a.eq(tr.best().side, 'left', 'прогресс больше:');
    const t2 = createHandUpTracker();
    t2.latch();
    t2.update(body({ left: LOW, right: UP }), 0);
    a.eq(t2.right.progress, 0);
    a.eq(t2.best().side, 'right', 'прогрессы по нулям: up лучше low:');
    tr.reset();
    a.eq(tr.best(), null);
    tr.update(body(), 0);
    a.eq(tr.best().side, 'left', 'всё равно: левая:');
  });

  t.test('рука: запястье для отрисовки', (a) => {
    const tr = createHandUpTracker();
    tr.update(body({ left: UP }), 0);
    a.deep(tr.left.wrist, { x: 0.62, y: 0.1 });
    tr.update(body({ left: { ...UP, wristVis: 0 } }), 100);
    a.deep(tr.left.wrist, { x: 0.62, y: 0.1 }, 'короткий пропуск: последняя точка:');
    tr.update(body({ left: { ...UP, wristVis: 0 } }), 400);
    a.eq(tr.left.wrist, null);
  });

  // ─── Liveness ─────────────────────────────────────────────────

  t.test('liveness: задание не повторяет прошлое и может быть любым', (a) => {
    const tasks = G.livenessTasks;
    const sweep = (prev) => new Set([0, 0.2, 0.4, 0.6, 0.8, 0.999999, 1].map((r) => pickLivenessTask(tasks, prev, () => r)));
    const all = sweep(null);
    a.eq(all.size, tasks.length, 'без прошлого выпадает любое:');
    for (const prev of tasks) {
      const got = sweep(prev);
      a.ok(!got.has(prev), `повтор ${prev}`);
      a.eq(got.size, tasks.length - 1, `после ${prev} доступны все остальные:`);
    }
    for (let i = 0; i < 50; i++) a.ok(tasks.includes(pickLivenessTask(tasks, 'Thumb_Up')));
    a.eq(pickLivenessTask(['Open_Palm'], 'Open_Palm', () => 0.5), 'Open_Palm', 'одно задание:');
  });

  t.test('liveness: тексты есть для каждого задания, без длинного тире', (a) => {
    for (const task of G.livenessTasks) {
      const tx = LIVENESS_TEXT[task];
      a.ok(tx && tx.icon && tx.title && tx.say && tx.fail, `нет текста ${task}`);
      a.ok(!/[—–]/.test(tx.title + tx.say + tx.fail), `тире в ${task}`);
    }
    a.eq(LIVENESS_TEXT.left_hand_up.side, 'left');
    a.eq(LIVENESS_TEXT.right_hand_up.side, 'right');
  });

  t.test('liveness: жест: верный = pass, другой = подсказка, руки не считаются', (a) => {
    const want = { Thumb_Up: 'Не тот жест. Покажи большой палец вверх', Open_Palm: 'Не тот жест. Покажи открытую ладонь' };
    for (const task of ['Thumb_Up', 'Open_Palm']) {
      const j = createLivenessJudge(task, { t0: 0 });
      const wrong = task === 'Thumb_Up' ? 'Open_Palm' : 'Thumb_Up';
      a.deep(j.onGesture(wrong, 100), { result: null, hint: want[task] }, `${task}:`);
      a.deep(j.onGesture('Thumb_Down', 150), { result: null, hint: want[task] });
      a.deep(j.onGesture('Closed_Fist', 180), { result: null, hint: null }, 'не из names:');
      a.deep(j.onHandUp('left', 200), { result: null, hint: null });
      a.deep(j.onHandUp('right', 250, { otherUp: true }), { result: null, hint: null });
      a.eq(j.done, null);
      a.deep(j.onGesture(task, 300), { result: 'pass', hint: null });
      a.eq(j.done, 'pass');
    }
  });

  t.test('liveness: рука: верная = pass, не та = подсказка, обе = подсказка', (a) => {
    const cases = {
      left_hand_up: { side: 'left', other: 'right', wrong: 'Это правая рука. Подними левую', only: 'Подними только левую руку' },
      right_hand_up: { side: 'right', other: 'left', wrong: 'Это левая рука. Подними правую', only: 'Подними только правую руку' },
    };
    for (const [task, c] of Object.entries(cases)) {
      const j = createLivenessJudge(task, { t0: 0 });
      a.eq(j.task, task);
      a.deep(j.onGesture(task === 'left_hand_up' ? 'Thumb_Up' : 'Open_Palm', 50), { result: null, hint: null }, 'жесты не считаются:');
      a.deep(j.onHandUp(c.other, 100), { result: null, hint: c.wrong }, `${task} не та:`);
      a.deep(j.onHandUp(c.side, 200, { otherUp: true }), { result: null, hint: c.only }, `${task} обе:`);
      a.deep(j.onHandUp(c.other, 250, { otherUp: true }), { result: null, hint: c.only }, `${task} обе, первой сработала не та:`);
      a.eq(j.done, null);
      a.deep(j.onHandUp(c.side, 300), { result: 'pass', hint: null });
      a.eq(j.done, 'pass');
    }
  });

  t.test('liveness: tick проваливает ровно в livenessSec, не на 1 мс раньше', (a) => {
    const t0 = 1000;
    const j = createLivenessJudge('Thumb_Up', { t0 });
    a.deep(j.tick(t0 + G.livenessSec * 1000 - 1), { result: null, hint: null });
    a.eq(j.done, null);
    a.deep(j.tick(t0 + G.livenessSec * 1000), { result: 'fail', hint: null });
    a.eq(j.done, 'fail');
    const j2 = createLivenessJudge('left_hand_up', { t0, sec: 2 });
    a.eq(j2.tick(t0 + 1999).result, null);
    a.eq(j2.tick(t0 + 2000).result, 'fail');
  });

  t.test('liveness: после итога вердиктов больше нет', (a) => {
    const quiet = { result: null, hint: null };
    const j = createLivenessJudge('Open_Palm', { t0: 0 });
    j.onGesture('Open_Palm', 100);
    a.deep(j.tick(99999), quiet, 'после pass провала нет:');
    a.deep(j.onGesture('Open_Palm', 200), quiet);
    a.deep(j.onGesture('Thumb_Up', 200), quiet);
    a.eq(j.done, 'pass');
    const k = createLivenessJudge('right_hand_up', { t0: 0 });
    k.tick(5000);
    a.deep(k.onHandUp('right', 5100), quiet, 'после fail pass нет:');
    a.deep(k.onHandUp('left', 5100), quiet);
    a.deep(k.tick(6000), quiet);
    a.eq(k.done, 'fail');
  });

  t.test('liveness: событие после дедлайна не засчитывается, провал даёт tick', (a) => {
    const j = createLivenessJudge('Thumb_Up', { t0: 0 });
    a.deep(j.onGesture('Thumb_Up', G.livenessSec * 1000), { result: null, hint: null });
    a.eq(j.tick(G.livenessSec * 1000).result, 'fail');
  });

  t.test('liveness: left() в секундах, не меньше 0', (a) => {
    const j = createLivenessJudge('Thumb_Up', { t0: 1000 });
    a.eq(j.left(1000), G.livenessSec);
    a.near(j.left(3500), G.livenessSec - 2.5, 1e-9);
    a.eq(j.left(1000 + G.livenessSec * 1000), 0);
    a.eq(j.left(99999), 0);
  });

  // ─── Dwell ────────────────────────────────────────────────────

  t.test('dwell: прогресс 0.5 на половине dwellMs, ровно один клик на dwellMs', (a) => {
    const dw = createDweller();
    const A = btn('a', 100, 100);
    const half = hover(dw, center(A), [A], 0, G.dwellMs / 2 + 1);
    a.eq(half.last.target, A.el);
    a.near(half.last.progress, 0.5, 1e-9);
    const r = dw.update(center(A), [A], G.dwellMs);
    a.eq(r.click, A.el);
    a.eq(r.progress, 1);
    const rest = hover(dw, center(A), [A], G.dwellMs + 20, 4000);
    a.deep(rest.clicks, [], 'палец остался на кнопке:');
    a.eq(rest.last.progress, 0);
    a.eq(rest.last.blocked, true);
    a.eq(rest.last.target, A.el, 'наведение видно, кольца нет:');
  });

  t.test('dwell: ушёл с кнопки: прогресс сбрасывается', (a) => {
    const dw = createDweller();
    const A = btn('a', 100, 100);
    hover(dw, center(A), [A], 0, 620);
    const off = dw.update({ x: 900, y: 900 }, [A], 620);
    a.eq(off.target, null);
    a.eq(off.progress, 0);
    const back = hover(dw, center(A), [A], 640, 640 + G.dwellMs / 2 + 1);
    a.near(back.last.progress, 0.5, 1e-9);
    a.deep(back.clicks, []);
  });

  t.test('dwell: pad ловит палец чуть снаружи, далеко снаружи нет', (a) => {
    const A = btn('a', 100, 100);
    const near = createDweller().update({ x: A.x - G.dwellPad + 2, y: 145 }, [A], 0);
    a.eq(near.target, A.el);
    const far = createDweller().update({ x: A.x - G.dwellPad - 4, y: 145 }, [A], 0);
    a.eq(far.target, null);
    const below = createDweller().update({ x: 200, y: A.y + A.h + G.dwellPad - 2 }, [A], 0);
    a.eq(below.target, A.el);
  });

  t.test('dwell: leavePad держит кнопку у края, дальше отпускает', (a) => {
    const dw = createDweller();
    const A = btn('a', 100, 100);
    dw.update(center(A), [A], 0);
    const edge = dw.update({ x: A.x - G.dwellLeavePad + 4, y: 145 }, [A], 20);
    a.eq(edge.target, A.el, 'у края в пределах leavePad:');
    a.near(edge.progress, 20 / G.dwellMs, 1e-9, 'прогресс не сбросился:');
    const out = dw.update({ x: A.x - G.dwellLeavePad - 4, y: 145 }, [A], 40);
    a.eq(out.target, null);
  });

  t.test('dwell: ближайший центр выигрывает', (a) => {
    const A = btn('a', 0, 0);
    const B = btn('b', 212, 0);
    a.eq(createDweller().update({ x: 208, y: 45 }, [A, B], 0).target, B.el);
    a.eq(createDweller().update({ x: 204, y: 45 }, [A, B], 0).target, A.el);
    a.eq(createDweller().update({ x: 208, y: 45 }, [B, A], 0).target, B.el, 'порядок в списке не важен:');
  });

  t.test('dwell: disabled пропускается', (a) => {
    const A = btn('a', 100, 100, 200, 90, true);
    const B = btn('b', 312, 100);
    const dw = createDweller();
    const r = hover(dw, center(A), [A, B], 0, 3000);
    a.eq(r.last.target, null);
    a.deep(r.clicks, []);
    const dw2 = createDweller();
    const C = btn('c', 100, 100);
    hover(dw2, center(C), [C], 0, 300);
    const off = dw2.update(center(C), [{ ...C, disabled: true }], 320);
    a.eq(off.target, null, 'стала disabled под пальцем:');
  });

  t.test('dwell: после клика та же кнопка заблокирована, пока палец не уйдёт и не вернётся', (a) => {
    const dw = createDweller();
    const A = btn('a', 100, 100);
    a.deep(hover(dw, center(A), [A], 0, 3000).clicks, [{ id: 'a', t: G.dwellMs }]);
    hover(dw, { x: 900, y: 900 }, [A], 3000, 3100);
    a.deep(hover(dw, center(A), [A], 3100, 5000).clicks, [{ id: 'a', t: 3100 + G.dwellMs }]);
  });

  t.test('dwell: пропал палец после клика: при возврате снова можно нажать', (a) => {
    const dw = createDweller();
    const A = btn('a', 100, 100);
    hover(dw, center(A), [A], 0, 1100);
    dw.update(null, [A], 1100);
    a.deep(hover(dw, center(A), [A], 1120, 3000).clicks, [{ id: 'a', t: 1120 + G.dwellMs }]);
  });

  t.test('dwell: кнопка перерисована на том же месте после клика: не нажимается снова', (a) => {
    const dw = createDweller();
    const A = btn('a', 100, 100);
    const A2 = btn('a2', 100, 100);
    hover(dw, center(A), [A], 0, G.dwellMs + 20);
    const r = hover(dw, center(A2), [A2], G.dwellMs + 20, 4000);
    a.deep(r.clicks, []);
    a.eq(r.last.target, A2.el);
    a.eq(r.last.blocked, true);
    hover(dw, { x: 900, y: 900 }, [A2], 4000, 4100);
    a.deep(hover(dw, center(A2), [A2], 4100, 6000).clicks, [{ id: 'a2', t: 4100 + G.dwellMs }]);
  });

  t.test('dwell: после клика соседняя кнопка под пальцем в зоне нажатой не нажимается', (a) => {
    // «Пополнить» заменилась кнопками ставок: под пальцем оказалась другая кнопка
    const dw = createDweller();
    const T = btn('topup', 100, 100, 400, 90);
    hover(dw, center(T), [T], 0, G.dwellMs + 20);
    const S = btn('stake', 250, 100, 150, 90);
    const r = hover(dw, center(T), [S], G.dwellMs + 20, 4000);
    a.deep(r.clicks, []);
    a.eq(r.last.blocked, true);
  });

  t.test('dwell: settle прячет цели и блокирует кнопку под неподвижным пальцем', (a) => {
    const dw = createDweller();
    const A = btn('a', 100, 100);
    dw.settle(0);
    const during = hover(dw, center(A), [A], 0, G.dwellSettleMs);
    a.eq(during.last.target, null, 'кнопки ещё въезжают:');
    const after = hover(dw, center(A), [A], G.dwellSettleMs, 4000);
    a.deep(after.clicks, []);
    a.eq(after.last.target, A.el);
    a.eq(after.last.blocked, true);
    hover(dw, { x: 900, y: 900 }, [A], 4000, 4100);
    a.deep(hover(dw, center(A), [A], 4100, 6000).clicks, [{ id: 'a', t: 4100 + G.dwellMs }]);
  });

  t.test('dwell: settle: палец пришёл на кнопку после settle: нажимается как обычно', (a) => {
    const dw = createDweller();
    const A = btn('a', 100, 100);
    dw.settle(0);
    hover(dw, { x: 900, y: 900 }, [A], 0, 600);
    a.deep(hover(dw, center(A), [A], 600, 3000).clicks, [{ id: 'a', t: 600 + G.dwellMs }]);
  });

  t.test('dwell: курсор спрятан во время settle: потом наведение не заблокировано', (a) => {
    const dw = createDweller();
    const A = btn('a', 100, 100);
    dw.settle(0);
    hover(dw, null, [A], 0, 700);
    a.deep(hover(dw, center(A), [A], 700, 3000).clicks, [{ id: 'a', t: 700 + G.dwellMs }]);
  });

  t.test('dwell: цель, которой больше нет в списке, сбрасывается', (a) => {
    const dw = createDweller();
    const A = btn('a', 100, 100);
    hover(dw, center(A), [A], 0, 520);
    const gone = dw.update(center(A), [], 520);
    a.eq(gone.target, null);
    a.eq(gone.progress, 0);
    const back = hover(dw, center(A), [A], 540, 540 + G.dwellMs / 2 + 1);
    a.near(back.last.progress, 0.5, 1e-9, 'наведение заново:');
  });

  t.test('удержание: просадка уверенности у сработавшего 👍 не взводит его снова', (a) => {
    const gate = createGestureGate(G);
    const fired = [
      ...show(gate, 'None', 0, 1000),
      ...show(gate, 'Thumb_Up', 1000, 1800),
      ...show(gate, 'Thumb_Up', 1800, 2100, G.minScore - 0.05), // рука дрогнула: уверенность просела на 300 мс
      ...show(gate, 'Thumb_Up', 2100, 5000),
    ];
    a.deep(fired, [{ name: 'Thumb_Up', t: 1400 }]);
    // слабый жест, который ещё не срабатывал, по-прежнему не срабатывает
    const weak = createGestureGate(G);
    a.eq(show(weak, 'Thumb_Up', 0, 3000, G.minScore - 0.05).length, 0);
  });

  t.test('проверка вживую: совет «не та рука» сменяется сразу и уходит сам, подсказки руки снова видны', (a) => {
    let now = 0;
    let timers = [];
    const env = {
      now: () => now,
      later(fn, ms) {
        const tm = { at: now + ms, fn };
        timers.push(tm);
        return () => (timers = timers.filter((x) => x !== tm));
      },
      voice: () => false,
      synth: () => null,
      utterance: (text) => ({ text }),
      sound: () => {},
    };
    const to = (t) => {
      now = t;
      for (const tm of timers.filter((x) => x.at <= t).sort((p, q) => p.at - q.at)) {
        timers = timers.filter((x) => x !== tm);
        tm.fn();
      }
    };
    const fb = createFeedback(env);
    const coachHint = { code: 'hand-low', level: 'info', speak: false, priority: 1 };
    a.ok(fb.hint('Это правая рука. Подними левую', VERDICT_HINT));
    to(500);
    a.ok(fb.hint('Подними только левую руку', VERDICT_HINT), 'второй совет сразу сменяет первый');
    to(600);
    a.eq(fb.hint('Подними левую руку выше головы', coachHint), false, 'пока совет на экране, подсказка руки ждёт');
    to(2400);
    a.ok(fb.hint('Подними левую руку выше головы', coachHint), 'совет ушёл сам, подсказка руки видна');
  });

  t.test('проверка вживую: ладонь, поднятая для старта в LOBBY, не выпадает заданием', (a) => {
    const gate = createGestureGate(G);
    a.eq(show(gate, 'Open_Palm', 0, 1000).length, 1, 'в LOBBY ладонь сработала');
    gate.latch(); // смена экрана на LIVENESS
    // баг: с заданием «ладонь» та же поднятая ладонь не срабатывает все 5 с → ложный провал
    a.eq(show(gate, 'Open_Palm', 1000, 6000).length, 0, 'ладонь после latch не срабатывает');
    const tasks = new Set();
    for (let i = 0; i < 40; i++) tasks.add(livenessTaskFor(gate.current, null, G.livenessTasks, () => i / 40));
    a.ok(!tasks.has('Open_Palm'), 'ладони нет среди заданий');
    a.eq(tasks.size, 3, 'остальные три задания возможны');
    // задание 👍: смена жеста снимает latch, 👍 срабатывает и проверка проходит
    const judge = createLivenessJudge('Thumb_Up', { t0: 6000 });
    const fired = show(gate, 'Thumb_Up', 6000, 7000);
    a.eq(fired[0]?.name, 'Thumb_Up');
    a.eq(judge.onGesture(fired[0].name, fired[0].t).result, 'pass');
    // без руки в кадре годится любое задание, и прошлое не повторяется
    const any = new Set();
    for (let i = 0; i < 40; i++) any.add(livenessTaskFor('None', 'Thumb_Up', G.livenessTasks, () => i / 40));
    a.eq(any.size, 3);
    a.ok(!any.has('Thumb_Up'));
  });

  t.test('dwell: reset', (a) => {
    const dw = createDweller();
    const A = btn('a', 100, 100);
    hover(dw, center(A), [A], 0, 1100);
    dw.reset();
    a.deep(hover(dw, center(A), [A], 2000, 4000).clicks, [{ id: 'a', t: 2000 + G.dwellMs }]);
  });

  // ─── One Euro ─────────────────────────────────────────────────

  t.test('One Euro: первая точка проходит как есть, reset забывает прошлое', (a) => {
    const f = createOneEuro2D();
    a.deep(f.filter(10, 20, 0), { x: 10, y: 20 });
    f.filter(500, 20, 66);
    f.reset();
    a.deep(f.filter(300, 400, 1000), { x: 300, y: 400 });
  });

  t.test('One Euro: в покое дрожание сильно гаснет', (a) => {
    const f = createOneEuro2D();
    const r = rng(11);
    const raw = { x: [], y: [] };
    const out = { x: [], y: [] };
    for (let i = 0; i < 90; i++) {
      const x = 640 + (r() - 0.5) * 12;
      const y = 360 + (r() - 0.5) * 12;
      const p = f.filter(x, y, i * 66);
      if (i < 15) continue;
      raw.x.push(x);
      raw.y.push(y);
      out.x.push(p.x);
      out.y.push(p.y);
    }
    const ratio = (variance(out.x) + variance(out.y)) / (variance(raw.x) + variance(raw.y));
    a.ok(ratio < 0.35, `дисперсия упала только до ${ratio.toFixed(2)} от исходной`);
  });

  t.test('One Euro: скачок догоняется быстро и до конца', (a) => {
    const f = createOneEuro2D();
    let t = 0;
    for (; t <= 1000; t += 66) f.filter(100, 100, t);
    const first = f.filter(500, 100, t);
    a.ok(first.x > 300, `первый кадр после скачка: ${first.x.toFixed(1)}, ждали больше половины пути`);
    let p = first;
    for (let i = 0; i < 30; i++) p = f.filter(500, 100, (t += 66));
    a.near(p.x, 500, 1, 'через 2 с:');
    a.near(p.y, 100, 1e-9);
  });

  t.test('One Euro: повтор времени не ломает фильтр', (a) => {
    const f = createOneEuro2D();
    f.filter(100, 100, 0);
    const p = f.filter(200, 200, 0);
    a.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  });

  // ─── Приглашение друга в LOBBY (P1): ссылка, QR, «Смотрят: N», ставки по ссылке ──

  t.test('приглашение: короткая ссылка без протокола, длинный id укорочен', (a) => {
    a.eq(shortLink('https://akrarama.github.io/go-bet-me/?join=demo1234'), 'akrarama.github.io/go-bet-me/?join=demo1234');
    a.eq(shortLink('https://a.io/x/?join=123e4567-e89b-12d3-a456-426614174000'), 'a.io/x/?join=123e4…000');
    a.eq(shortLink('http://www.a.io/?join=abc'), 'a.io/?join=abc');
    a.eq(shortLink(null), '');
  });

  t.test('приглашение: cleanUrl пускает только http(s) без пробелов', (a) => {
    a.eq(cleanUrl('https://x.io/?join=1'), 'https://x.io/?join=1');
    a.eq(cleanUrl('  http://x.io  '), 'http://x.io');
    a.eq(cleanUrl('javascript:alert(1)'), null);
    a.eq(cleanUrl('https://x.io/a b'), null);
    a.eq(cleanUrl(''), null);
    a.eq(cleanUrl(42), null);
  });

  t.test('приглашение: имя и аватар друга режутся по длине и не бывают пустыми', (a) => {
    a.eq(cleanName('  Тимур   Иванов '), 'Тимур Иванов');
    a.eq(cleanName('x'.repeat(50)).length, GESTURES.invite.nameMax);
    a.eq(Array.from(cleanName('😀'.repeat(40))).length, GESTURES.invite.nameMax, 'эмодзи режутся по символам, не по половинкам');
    a.eq(cleanName('   '), 'Друг');
    a.eq(cleanName(undefined), 'Друг');
    a.eq(cleanName('<b>Я</b>'), '<b>Я</b>', 'экранирует разметка экрана (esc), не эта логика');
    a.eq(cleanAvatar('👩‍🦰'), '👩‍🦰');
    a.eq(cleanAvatar(''), '🙂');
    a.eq(Array.from(cleanAvatar('a'.repeat(30))).length, 8);
  });

  t.test('приглашение: peer:ready даёт карточку, peer:error убирает', (a) => {
    const inv = createInvite();
    a.eq(inv.on, false);
    inv.ready({ id: 'h1', url: 'https://x.io/?join=h1' });
    a.eq(inv.on, true);
    a.eq(inv.url, 'https://x.io/?join=h1');
    a.eq(inv.id, 'h1');
    inv.fail();
    a.eq(inv.on, false);
    a.eq(inv.url, null);
  });

  t.test('приглашение: без нормальной ссылки карточки нет', (a) => {
    const inv = createInvite();
    inv.ready({ id: 'h1' });
    inv.ready({ id: 'h1', url: 'javascript:1' });
    inv.ready(null);
    inv.ready(undefined);
    a.eq(inv.on, false);
  });

  t.test('приглашение: «Смотрят» считает друзей по join и leave, повторный join не двоит', (a) => {
    const inv = createInvite();
    inv.ready({ id: 'h1', url: 'https://x.io/?join=h1' });
    inv.join({ id: 'a', name: 'Тимур', avatar: '🧑' });
    inv.join({ id: 'a', name: 'Тимур', avatar: '🧑' });
    inv.join({ id: 'b', name: 'Аня', avatar: '👩' });
    a.eq(inv.count, 2);
    a.deep(inv.friends.map((f) => f.name), ['Тимур', 'Аня']);
    inv.leave({ id: 'a' });
    inv.leave({ id: 'нет такого' });
    a.eq(inv.count, 1);
    inv.join({});
    inv.join(null);
    inv.leave(null);
    a.eq(inv.count, 1);
  });

  t.test('приглашение: новый id хоста и peer:error сбрасывают друзей, тот же хост нет', (a) => {
    const inv = createInvite();
    inv.ready({ id: 'h1', url: 'https://x.io/?join=h1' });
    inv.join({ id: 'a' });
    inv.ready({ id: 'h1', url: 'https://x.io/?join=h1' });
    a.eq(inv.count, 1, 'повтор того же peer:ready');
    inv.ready({ id: 'h2', url: 'https://x.io/?join=h2' });
    a.eq(inv.count, 0, 'новый хост');
    inv.join({ id: 'a' });
    inv.fail();
    a.eq(inv.count, 0);
  });

  t.test('приглашение: подписчики получают каждое изменение, после отписки нет', (a) => {
    const inv = createInvite();
    let n = 0;
    const off = inv.subscribe(() => n++);
    inv.ready({ id: 'h', url: 'https://x.io/' });
    inv.join({ id: 'a' });
    inv.leave({ id: 'a' });
    a.eq(n, 3);
    inv.leave({ id: 'a' });
    a.eq(n, 3, 'ушедшего второй раз убрать нельзя: события нет');
    off();
    inv.fail();
    a.eq(n, 3);
    const idle = createInvite();
    let m = 0;
    idle.subscribe(() => m++);
    idle.fail();
    a.eq(m, 0, 'peer:error без карточки ничего не меняет');
  });

  t.test('приглашение: события шины доходят до хранилища, отписка снимает все', (a) => {
    const handlers = new Map();
    const fakeBus = {
      on(type, fn) {
        handlers.set(type, fn);
        return () => handlers.delete(type);
      },
    };
    const inv = createInvite();
    const off = attachInvite(fakeBus, inv);
    a.deep([...handlers.keys()].sort(), ['friend:join', 'friend:leave', 'peer:error', 'peer:pending', 'peer:ready']);
    handlers.get('peer:pending')({});
    a.eq(inv.pending, true);
    handlers.get('peer:ready')({ id: 'h', url: 'https://x.io/?join=h' });
    a.eq(inv.pending, false);
    handlers.get('friend:join')({ id: 'a', name: 'Тимур', avatar: '🧑' });
    a.eq(inv.on, true);
    a.eq(inv.count, 1);
    handlers.get('friend:leave')({ id: 'a' });
    a.eq(inv.count, 0);
    handlers.get('peer:error')({ error: 'нет облака' });
    a.eq(inv.on, false);
    off();
    a.eq(handlers.size, 0);
  });

  t.test('приглашение: peer:pending показывает «готовлю ссылку», ready и error её заканчивают', (a) => {
    const inv = createInvite();
    inv.wait();
    a.eq(inv.on, true);
    a.eq(inv.pending, true);
    a.eq(inv.url, null);
    inv.ready({ id: 'h', url: 'https://x.io/?join=h' });
    a.eq(inv.pending, false);
    a.eq(inv.on, true);
    inv.wait();
    a.eq(inv.pending, false, 'ссылка уже готова: pending не возвращает «готовлю»');
    inv.fail();
    inv.wait();
    inv.fail();
    a.eq(inv.on, false, 'ошибка во время загрузки убирает карточку');
    a.eq(inv.pending, false);
  });

  t.test('приглашение: friends в peer:ready: список сверяет счётчик, число его не трогает', (a) => {
    const inv = createInvite();
    inv.ready({ id: 'h', url: 'https://x.io/?join=h' });
    inv.join({ id: 'a', name: 'Тимур' });
    inv.ready({ id: 'h', url: 'https://x.io/?join=h', friends: 1 });
    a.eq(inv.count, 1, 'число: друзей ведут join и leave');
    inv.ready({ id: 'h', url: 'https://x.io/?join=h', friends: [{ id: 'b', name: 'Аня', avatar: '👩' }, 'c', { name: 'без id' }, null] });
    a.deep(inv.friends.map((f) => f.id), ['b', 'c'], 'список заменил прежних, записи без id пропущены');
    a.eq(inv.friends[0].name, 'Аня');
    a.eq(inv.friends[1].name, 'Друг', 'у строки-id имя по умолчанию');
    inv.ready({ id: 'h', url: 'https://x.io/?join=h', friends: [] });
    a.eq(inv.count, 0, 'пустой список: никого нет');
  });

  t.test('приглашение: peer:error с recoverable оставляет друзей до возврата ссылки', (a) => {
    const inv = createInvite();
    inv.ready({ id: 'h', url: 'https://x.io/?join=h' });
    inv.join({ id: 'a' });
    inv.fail({ recoverable: true });
    a.eq(inv.on, false, 'карточки нет, пока нет связи с облаком');
    a.eq(inv.count, 1, 'друг на месте');
    inv.ready({ id: 'h', url: 'https://x.io/?join=h' });
    a.eq(inv.on, true);
    a.eq(inv.count, 1, 'тот же хост: друг не потерян');
    inv.fail({ recoverable: true });
    inv.ready({ id: 'h2', url: 'https://x.io/?join=h2' });
    a.eq(inv.count, 0, 'после мигания вернулся под другим id: друзья прежнего отвалились');
    inv.join({ id: 'b' });
    inv.fail({ recoverable: false });
    a.eq(inv.count, 0, 'обычная ошибка: друзей нет');
    inv.ready({ id: 'h', url: 'https://x.io/?join=h' });
    a.eq(inv.count, 0);
  });

  t.test('ставки: друг по ссылке отличается от бота, чужие данные приводятся к безопасному виду', (a) => {
    a.eq(betRow({ id: 'bot-dima', name: 'Дима', avatar: '🧔', amount: 5, bot: true }).link, false);
    a.eq(betRow({ id: 'peer:abc', name: 'Тимур', avatar: '🧑', amount: 5, bot: false }).link, true);
    a.eq(betRow({ id: 'peer:xyz', name: 'Аня', amount: 10 }).link, true, 'bot не указан, id вида peer:');
    a.eq(betRow({ id: 'bot-x', name: 'Х', amount: 5 }).link, false);
    a.eq(betRow({ id: 'peer:1', bot: true, name: 'Х', amount: 5 }).link, false, 'бот всегда бот');
    const odd = betRow({ id: 'peer:q', name: 'n'.repeat(60), amount: '7', avatar: null });
    a.eq(odd.name.length, GESTURES.invite.nameMax);
    a.eq(odd.amount, 7);
    a.eq(odd.avatar, '🙂');
    a.eq(betRow({ id: 'peer:z', amount: 'abc' }).amount, 0);
    a.eq(betRow({ id: 'peer:z', amount: 5 }).name, 'Друг');
  });

  // Поддельная библиотека QR: клетки задаёт маска ('#' тёмная)
  const fakeQr = (rows) => () => ({ addData() {}, make() {}, getModuleCount: () => rows.length, isDark: (r, c) => rows[r][c] === '#' });

  t.test('QR: один path, тёмные клетки в ряд склеены, тихая зона внутри viewBox', (a) => {
    const svg = qrSvg(fakeQr(['###', '#.#', '.##']), 'https://x.io');
    a.ok(svg.startsWith('<svg viewBox="-2 -2 7 7"'), svg);
    a.ok(svg.includes('M0 0h3v1h-3z'), 'ряд 0 одним куском');
    a.ok(svg.includes('M0 1h1v1h-1z') && svg.includes('M2 1h1v1h-1z'), 'ряд 1: клетки по краям');
    a.ok(svg.includes('M1 2h2v1h-2z'), 'ряд 2: две клетки справа');
    a.eq((svg.match(/M/g) || []).length, 4);
    a.ok(!svg.includes('x.io'), 'в картинке только клетки, текста ссылки нет');
  });

  t.test('QR: сбой библиотеки или слишком длинный текст дают null', (a) => {
    a.eq(qrSvg(() => { throw new Error('нет'); }, 'x'), null);
    a.eq(qrSvg(() => ({ addData() { throw new Error('переполнение'); }, make() {}, getModuleCount: () => 0, isDark: () => false }), 'x'), null);
  });

  t.test('QR: библиотеке уходит авто-размер, уровень M и текст ссылки', (a) => {
    const seen = [];
    const factory = (type, level) => {
      seen.push(type, level);
      return { addData: (text) => seen.push(text), make() {}, getModuleCount: () => 1, isDark: () => true };
    };
    qrSvg(factory, 'https://x.io/?join=1');
    a.deep(seen, [0, 'M', 'https://x.io/?join=1']);
  });

  t.test('QR: вне браузера loadQr отвечает null и не падает', async (a) => {
    if (typeof window !== 'undefined') return; // в браузере библиотека грузится с CDN по-настоящему
    a.eq(await loadQr(), null);
  });
};
