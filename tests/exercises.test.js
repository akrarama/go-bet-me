// Тесты новых упражнений: брусья, турник, берпи. Настоящие ролики (fixtures/traces, в git не лежат,
// трассы сняты моделью full через tests/replay.html) и синтетика там, где ролика не хватает.

import * as dips from '../src/exercises/dips.js';
import * as pullup from '../src/exercises/pullup.js';

/** Контроллер с журналом шины и тихим feedback. */
export function setup(mod, { target = 999, options } = {}) {
  const events = [];
  const hints = [];
  const bus = { emit: (type, p) => events.push({ type, ...p }) };
  const feedback = {
    highlight: new Set(),
    hint: (text, o = {}) => hints.push({ text, code: o.code }),
    clear() {},
    clearNow() {},
    say() {},
  };
  const debug = { enabled: false, set() {}, key() {} };
  const ctrl = mod.createController({ challenge: { target }, bus, feedback, debug, ...(options ? { options } : {}) });
  const of = (type) => events.filter((e) => e.type === type);
  return { ctrl, events, hints, of };
}

/** Трасса ролика → контроллер; null, если трассы нет (в браузере или без fixtures). */
export function replay(name, mod, opts) {
  let data = null;
  try {
    data = typeof readFile === 'function' ? JSON.parse(readFile(`../fixtures/traces/${name}.json`)) : null;
  } catch {
    data = null;
  }
  if (!data) return null;
  const s = setup(mod, opts);
  const { fps, width, height } = data.input;
  data.frames.forEach((f, i) => {
    const t = 1 + (i * 1000) / fps;
    const raw = Array.isArray(f) ? f : f?.lm;
    const lm = raw ? raw.map(([x, y, z, visibility]) => ({ x, y, z, visibility })) : null;
    if (i === 0) s.ctrl.start(t);
    s.ctrl.frame({ t, ran: 'pose', width, height, pose: { t, landmarks: lm } }, t);
  });
  return s;
}

const codes = (s, type) => s.of(type).map((e) => e.code);

// ─── Синтетика: 33 точки, кадр квадратный (aspect 1), 30 fps ───
const FPS = 30;
const rad = (d) => (d * Math.PI) / 180;
const blank = () => Array.from({ length: 33 }, () => ({ x: 0.5, y: 1.3, z: 0, visibility: 0.1 }));
const put = (lm, i, p, visibility = 0.95) => (lm[i] = { x: p.x, y: p.y, z: 0, visibility });

/**
 * Вис на турнике спереди: кисти на перекладине (y 0.2), угол локтя elbow. chin: нос относительно плеч
 * (0.12 выше плеч = подбородок над перекладиной вверху; 0.07 = не дотянулся). arms: 'up' (вис) | 'down' (стоит).
 */
function hangPose({ elbow = 170, noseAbove = 0.12, arms = 'up' } = {}) {
  const lm = blank();
  const a = 0.15;
  const d = a * Math.sqrt(2 - 2 * Math.cos(rad(elbow))); // плечо-запястье
  const h = Math.sqrt(Math.max(0, a * a - (d / 2) ** 2)); // локоть в сторону от линии плечо-запястье
  for (const [sh, el, wr, sx] of [[11, 13, 15, 0.4], [12, 14, 16, 0.6]]) {
    const out = sx < 0.5 ? -1 : 1;
    if (arms === 'up') {
      const W = { x: sx, y: 0.2 };
      const S = { x: sx, y: 0.2 + d };
      put(lm, wr, W);
      put(lm, sh, S);
      put(lm, el, { x: sx + out * h, y: 0.2 + d / 2 });
    } else {
      const S = { x: sx, y: 0.45 };
      put(lm, sh, S);
      put(lm, el, { x: sx + out * h, y: S.y + d / 2 });
      put(lm, wr, { x: sx, y: S.y + d });
    }
  }
  put(lm, 0, { x: 0.5, y: lm[11].y - noseAbove });
  return lm;
}

/** Брусья сбоку: плечо (0.5, 0.35), корпус наклонён на lean, предплечье вертикально, угол локтя elbow. */
function dipsPose({ elbow = 165, lean = 20 } = {}) {
  const lm = blank();
  const S = { x: 0.5, y: 0.35 };
  const phi = rad(180 - elbow);
  const E = { x: S.x - 0.15 * Math.sin(phi), y: S.y + 0.15 * Math.cos(phi) };
  const W = { x: E.x, y: E.y + 0.15 };
  const H = { x: S.x - 0.3 * Math.sin(rad(lean)), y: S.y + 0.3 * Math.cos(rad(lean)) };
  [[11, S], [13, E], [15, W], [23, H]].forEach(([i, p]) => put(lm, i, p));
  [[12, S], [14, E], [16, W], [24, H]].forEach(([i, p]) => put(lm, i, { x: p.x + 0.01, y: p.y }, 0.55));
  put(lm, 0, { x: S.x + 0.03, y: S.y - 0.1 });
  return lm;
}

/** Кадры повтора: верх держится hold кадров, вниз и вверх за ms. make(angle) → поза. */
function reps(n, make, top, bottom, { ms = 1600, hold = 12 } = {}) {
  const out = [];
  const half = Math.round(((ms / 2) * FPS) / 1000);
  for (let r = 0; r < n; r++) {
    for (let i = 0; i < hold; i++) out.push(make(top));
    for (let i = 1; i <= half; i++) out.push(make(top + ((bottom - top) * i) / half));
    for (let i = 1; i <= half; i++) out.push(make(bottom + ((top - bottom) * i) / half));
  }
  for (let i = 0; i < hold; i++) out.push(make(top));
  return out;
}

function feed(s, frames) {
  frames.forEach((lm, i) => {
    const t = 1 + (i * 1000) / FPS;
    if (i === 0) s.ctrl.start(t);
    s.ctrl.frame({ t, ran: 'pose', width: 1000, height: 1000, pose: { t, landmarks: lm } }, t);
  });
  return s;
}

export default (t) => {
  // ─── Турник ───
  t.test('турник: подбородок над перекладиной, 3 повтора засчитаны', (a) => {
    const s = feed(setup(pullup), reps(3, (e) => hangPose({ elbow: e }), 170, 45));
    a.eq(s.ctrl.count, 3);
    a.eq(s.of('rejected').length, 0);
  });

  t.test('турник: подбородок не дошёл до перекладины, повтор в лог «подбородок ниже перекладины»', (a) => {
    const s = feed(setup(pullup), reps(2, (e) => hangPose({ elbow: e, noseAbove: 0.07 }), 170, 45));
    a.eq(s.ctrl.count, 0);
    a.deep(codes(s, 'rejected'), ['pullup_chin', 'pullup_chin']);
    a.ok(s.hints.some((h) => /перекладин/.test(h.text)), 'подсказка про перекладину');
  });

  t.test('турник: стоит, руки внизу сгибаются, счёт на паузе с подсказкой «повисни»', (a) => {
    const s = feed(setup(pullup), reps(3, (e) => hangPose({ elbow: e, arms: 'down' }), 170, 45));
    a.eq(s.ctrl.count, 0);
    a.ok(s.hints.some((h) => /Повисни/.test(h.text)), 'подсказка «Повисни на турнике»');
  });

  t.test('турник: не подтянулся (локоть 110°), глубина в лог', (a) => {
    const s = feed(setup(pullup), reps(1, (e) => hangPose({ elbow: e }), 170, 110));
    a.eq(s.ctrl.count, 0);
    a.deep(codes(s, 'rejected'), ['pullup_half_down']);
  });

  t.test('турник: ready: вис ✓, стоя ✗ с подсказкой', (a) => {
    const s = setup(pullup);
    let r = s.ctrl.ready({ t: 1, width: 1000, height: 1000, pose: { t: 1, landmarks: hangPose() } }, 1);
    a.eq(r.ok, true);
    r = s.ctrl.ready({ t: 40, width: 1000, height: 1000, pose: { t: 40, landmarks: hangPose({ arms: 'down' }) } }, 40);
    a.eq(r.ok, false);
    a.ok(/Повисни/.test(r.hint), r.hint);
  });

  // ─── Брусья ───
  t.test('брусья: 3 чистых повтора', (a) => {
    const s = feed(setup(dips), reps(3, (e) => dipsPose({ elbow: e }), 165, 90));
    a.eq(s.ctrl.count, 3);
    a.eq(s.of('rejected').length, 0);
  });

  t.test('брусья: корпус завален вперёд, повтор не засчитан, подсказка про грудь', (a) => {
    const s = feed(setup(dips), reps(2, (e) => dipsPose({ elbow: e, lean: 58 }), 165, 90));
    a.eq(s.ctrl.count, 0);
    a.deep(codes(s, 'rejected'), ['dips_lean', 'dips_lean']);
    a.ok(s.hints.some((h) => /грудь/.test(h.text)));
  });

  t.test('брусья: мелко (локоть 120°), глубина в лог', (a) => {
    const s = feed(setup(dips), reps(1, (e) => dipsPose({ elbow: e }), 165, 120));
    a.eq(s.ctrl.count, 0);
    a.deep(codes(s, 'rejected'), ['dips_half_down']);
  });

  t.test('брусья: упор лёжа на полу (корпус горизонтально) не считается', (a) => {
    const s = feed(setup(dips), reps(2, (e) => dipsPose({ elbow: e, lean: 85 }), 165, 90));
    a.eq(s.ctrl.count, 0);
  });

  // ─── Настоящие ролики (калибровка порогов) ───
  t.test('ролик: брусья сбоку: 12 из 12, недожим на спрыгивании в лог', (a) => {
    const s = replay('dips-side', dips);
    if (!s) return;
    a.eq(s.ctrl.count, 12);
    a.ok(s.of('rejected').length <= 1, `незасчитанные ${JSON.stringify(codes(s, 'rejected'))}`);
  });

  t.test('ролик: турник сзади и спереди: 12 из 13, смена ракурса без ложных повторов', (a) => {
    const s = replay('pullup', pullup);
    if (!s) return;
    a.eq(s.ctrl.count, 12);
    a.ok(s.of('rejected').length <= 1, `незасчитанные ${JSON.stringify(codes(s, 'rejected'))}`);
  });
};
