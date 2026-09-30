// Тесты блока 1 (Упражнения): движок повторов, правила ошибок, подсказки.
// Синтетика: углы напрямую и полные позы из 33 точек (человек сбоку), 30 кадров в секунду.

import { REPS } from '../src/config.js';
import { angle, tiltFromVertical } from '../src/vision/geometry.js';
import { createFeedback } from '../src/feedback.js';
import { alphaFor, createCounter, createHolds, describeRejected, PRIORITY } from '../src/exercises/reps.js';
import * as squat from '../src/exercises/squat.js';
import * as pushup from '../src/exercises/pushup.js';

// ─── Поза из 33 точек ───────────────────────────────────────────

const WIDTH = 1280;
const HEIGHT = 720;
const ASPECT = WIDTH / HEIGHT;
const FPS = 30;
const rad = (d) => (d * Math.PI) / 180;
const rot = (v, a) => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) });
const add = (p, v, k = 1) => ({ x: p.x + v.x * k, y: p.y + v.y * k });

// Индексы сторон: [плечо, локоть, запястье, таз, колено, щиколотка, пятка, носок]
const SIDES = { left: [11, 13, 15, 23, 25, 27, 29, 31], right: [12, 14, 16, 24, 26, 28, 30, 32] };

/** Точки в единицах высоты кадра → 33 landmarks в нормализованных координатах. */
function build(j, { near = 'left', vis = 0.95, farVis = 0.6, dir = 1, override = {} } = {}) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }));
  const put = (i, p, v) => (lm[i] = { x: 0.5 + p.x / ASPECT, y: p.y, z: 0, visibility: v });
  const far = near === 'left' ? 'right' : 'left';
  const order = ['shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle', 'heel', 'toe'];
  order.forEach((k, n) => {
    put(SIDES[near][n], j[k], vis);
    put(SIDES[far][n], { x: j[k].x - dir * 0.012, y: j[k].y - 0.004 }, farVis);
  });
  for (let i = 0; i <= 10; i++) put(i, { x: j.nose.x + dir * 0.01 * (i % 3), y: j.nose.y + 0.006 * (i % 4) }, vis);
  for (const i of [17, 19, 21]) put(i, j.wrist, vis);
  for (const i of [18, 20, 22]) put(i, { x: j.wrist.x - dir * 0.012, y: j.wrist.y }, farVis);
  for (const [i, v] of Object.entries(override)) lm[i] = { ...lm[i], ...v };
  return lm;
}

/**
 * Человек сбоку, лицом в сторону dir (+1 вправо, -1 влево).
 * knee: угол таз-колено-щиколотка; shin: наклон голени вперёд от вертикали;
 * lean: наклон корпуса вперёд; lift: стопы над полом (прыжок); front: стоит лицом к камере.
 * arm: угол локтя (руки для прыжков с махами), по умолчанию руки вперёд.
 */
function squatPose({ knee = 176, shin = 4, lean = 4, lift = 0, dir = 1, front = false, facing = false, arm = null, ...opts } = {}) {
  const floor = 0.9 - lift;
  const ankle = { x: 0, y: floor };
  const kneeP = add(ankle, { x: dir * Math.sin(rad(shin)), y: -Math.cos(rad(shin)) }, 0.22);
  const u = { x: (ankle.x - kneeP.x) / 0.22, y: (ankle.y - kneeP.y) / 0.22 };
  const h1 = rot(u, rad(knee));
  const h2 = rot(u, -rad(knee));
  const hip = add(kneeP, h1.x * dir <= h2.x * dir ? h1 : h2, 0.22);
  const shoulder = add(hip, { x: dir * Math.sin(rad(lean)), y: -Math.cos(rad(lean)) }, 0.27);
  let elbow = add(shoulder, { x: dir * 0.1, y: 0.08 });
  let wrist = add(shoulder, { x: dir * 0.22, y: 0.07 });
  if (arm != null) {
    // рука вверх-вбок, предплечье согнуто на угол arm
    const upper = { x: dir * Math.sin(rad(150)), y: Math.cos(rad(150)) };
    elbow = add(shoulder, upper, 0.15);
    wrist = add(elbow, rot({ x: -upper.x, y: -upper.y }, rad(arm)), 0.14);
  }
  const lm = build(
    {
      nose: add(shoulder, { x: dir * 0.06, y: -0.09 }),
      shoulder, elbow, wrist, hip, knee: kneeP, ankle,
      heel: { x: ankle.x - dir * 0.03, y: floor + 0.025 },
      toe: { x: front ? ankle.x : ankle.x + dir * 0.085, y: floor + 0.025 },
    },
    { dir, ...opts },
  );
  if (facing) {
    // лицом к камере: левая и правая половины тела разнесены в ширину плеч и таза
    const spread = (i, j, w) => {
      const cx = (lm[i].x + lm[j].x) / 2;
      lm[i] = { ...lm[i], x: cx + w / 2 / ASPECT };
      lm[j] = { ...lm[j], x: cx - w / 2 / ASPECT };
    };
    spread(11, 12, 0.2);
    spread(13, 14, 0.26);
    spread(15, 16, 0.3);
    spread(23, 24, 0.15);
    spread(25, 26, 0.16);
    spread(27, 28, 0.16);
  }
  return lm;
}

/**
 * Упор лёжа сбоку, голова в сторону dir. elbow: угол плечо-локоть-запястье;
 * sag: таз ниже линии плечо-щиколотка (+) или выше (-), доля кадра.
 */
function pushupPose({ elbow = 172, sag = 0, dir = 1, ...opts } = {}) {
  const Lu = 0.15;
  const Lf = 0.14;
  const wrist = { x: 0, y: 0.88 };
  const d = Math.sqrt(Lu * Lu + Lf * Lf - 2 * Lu * Lf * Math.cos(rad(elbow)));
  const shoulder = { x: 0, y: wrist.y - d };
  const along = (Lu * Lu - Lf * Lf + d * d) / (2 * d);
  const elbowP = { x: -dir * Math.sqrt(Math.max(0, Lu * Lu - along * along)), y: shoulder.y + along };
  const ankleY = 0.87;
  const dy = ankleY - shoulder.y;
  const ankle = { x: shoulder.x - dir * Math.sqrt(Math.max(0.01, 0.62 * 0.62 - dy * dy)), y: ankleY };
  const hip = { x: shoulder.x + (ankle.x - shoulder.x) * 0.45, y: shoulder.y + (ankle.y - shoulder.y) * 0.45 + sag };
  const knee = { x: (hip.x + ankle.x) / 2, y: (hip.y + ankle.y) / 2 };
  return build(
    {
      nose: add(shoulder, { x: dir * 0.09, y: 0.01 }),
      shoulder, elbow: elbowP, wrist, hip, knee, ankle,
      heel: { x: ankle.x - dir * 0.02, y: ankleY - 0.02 },
      toe: { x: ankle.x + dir * 0.03, y: ankleY + 0.02 },
    },
    { dir, ...opts },
  );
}

// ─── Время и последовательности ─────────────────────────────────

const ease = (s) => (1 - Math.cos(Math.PI * s)) / 2;

/**
 * Кадры движения: [ms, параметры] ключи, числа плавно переходят между ключами.
 * seq(make, [0, {knee: 176}], [800, {knee: 80}], [1600, {knee: 176}])
 */
function seq(make, ...keys) {
  const frames = [];
  const dt = 1000 / FPS;
  for (let n = 1; n < keys.length; n++) {
    const [t0, a] = keys[n - 1];
    const [t1, b] = keys[n];
    const steps = Math.max(1, Math.round((t1 - t0) / dt));
    for (let s = n === 1 ? 0 : 1; s <= steps; s++) {
      const k = ease(s / steps);
      const p = { ...a };
      for (const key of Object.keys(b)) p[key] = typeof b[key] === 'number' && typeof a[key] === 'number' ? a[key] + (b[key] - a[key]) * k : b[key];
      frames.push(make(p));
    }
  }
  return frames;
}

/** Дрожание точек как у настоящей модели: детерминированный шум, amp в долях кадра. */
function jitter(frames, amp = 0.004, seed = 7) {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  return frames.map((lm) => lm.map((p) => ({ ...p, x: p.x + (rnd() * amp) / ASPECT, y: p.y + rnd() * amp })));
}

/** Каждый второй кадр: 15 fps вместо 30. */
const halfRate = (frames) => frames.filter((_, i) => i % 2 === 0);

/** Повтор: стойка → низ → стойка за ms. */
const rep = (make, top, bottom, ms = 1600) => seq(make, [0, top], [ms / 2, bottom], [ms, top]);
const hold = (lm, n) => Array.from({ length: n }, () => lm);

/** Среда: часы, отложенные таймеры и голос для feedback, шина с журналом. */
function setup(mod, { target = 10, voice = false } = {}) {
  let now = 0;
  let timers = [];
  const spoken = [];
  const sounds = [];
  const synth = { speaking: false, speak: (u) => spoken.push(u.text), cancel() {}, getVoices: () => [] };
  const env = {
    now: () => now,
    later(fn, ms) {
      const tm = { at: now + ms, fn };
      timers.push(tm);
      return () => (timers = timers.filter((x) => x !== tm));
    },
    voice: () => voice,
    synth: () => synth,
    utterance: (text) => ({ text }),
    sound: (name) => sounds.push(name),
  };
  const feedback = createFeedback(env);
  const events = [];
  const bus = { emit: (type, p) => events.push({ type, ...p }) };
  const debug = { enabled: false, set() {}, key() {} };
  const ctrl = mod ? mod.createController({ challenge: { target }, bus, feedback, debug }) : null;
  const clock = {
    get now() {
      return now;
    },
    to(t) {
      now = t;
      for (const tm of timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)) {
        timers = timers.filter((x) => x !== tm);
        tm.fn();
      }
    },
  };
  let t = 0;
  const feed = (frames, { dt = 1000 / FPS } = {}) => {
    for (const lm of frames) {
      clock.to(t);
      ctrl.frame({ t, ran: 'pose', width: WIDTH, height: HEIGHT, pose: { t, landmarks: lm } }, t);
      t += dt;
    }
  };
  /** «Встань в позицию» до отсчёта: ready на тех же часах, что feed; ответ на последнем кадре. */
  const probe = (frames, { dt = 1000 / FPS } = {}) => {
    let res = null;
    for (const lm of frames) {
      clock.to(t);
      res = ctrl.ready({ t, ran: 'pose', width: WIDTH, height: HEIGHT, pose: { t, landmarks: lm } }, t);
      t += dt;
    }
    return res;
  };
  const wait = (ms) => {
    t += ms;
    clock.to(t);
  };
  ctrl?.start(0);
  const of = (type) => events.filter((e) => e.type === type);
  return { ctrl, feedback, events, of, spoken, sounds, clock, feed, probe, wait, synth, get t() { return t; } };
}


/**
 * Трасса настоящего ролика (fixtures/traces, в git не лежит): кадры → контроллер, 15 fps.
 * Только в jsc (readFile) и только если трасса есть рядом с репо, иначе null.
 */
function replayTrace(name, mod) {
  let data = null;
  try {
    data = typeof readFile === 'function' ? JSON.parse(readFile(`../fixtures/traces/${name}.json`)) : null;
  } catch {
    data = null;
  }
  if (!data) return null;
  const s = setup(mod, { target: 999 });
  const { fps, width, height } = data.input;
  data.frames.forEach((f, i) => {
    const t = 1 + (i * 1000) / fps;
    const raw = Array.isArray(f) ? f : f?.lm;
    const lm = raw ? raw.map(([x, y, z, visibility]) => ({ x, y, z, visibility })) : null;
    s.clock.to(t);
    if (i === 0) s.ctrl.start(t);
    s.ctrl.frame({ t, ran: 'pose', width, height, pose: { t, landmarks: lm } }, t);
  });
  return s;
}

const STAND = { knee: 176, shin: 4, lean: 4 };
const DEEP = { knee: 78, shin: 28, lean: 32 };
const TOP = { elbow: 172 };
const LOW = { elbow: 70 };

// ─── Тесты ──────────────────────────────────────────────────────

export default (t) => {
  // Поза генератора совпадает с задуманными углами
  t.test('генератор: углы колена и локтя как задано', (a) => {
    const s = squatPose(DEEP);
    a.near(angle(s[23], s[25], s[27], ASPECT), 78, 1e-6);
    a.near(tiltFromVertical(s[23], s[11], ASPECT), 32, 1e-6);
    const p = pushupPose(LOW);
    a.near(angle(p[11], p[13], p[15], ASPECT), 70, 1e-6);
  });

  // ─── Счётчик ───
  t.test('счётчик: EMA 0.3 на кадр 30 fps, по времени на других частотах', (a) => {
    a.near(alphaFor(1000 / 30), 0.3, 1e-9);
    a.near(alphaFor(2000 / 30), 1 - 0.7 ** 2, 1e-9);
    a.eq(alphaFor(Infinity), 1);
  });

  t.test('счётчик: полный повтор даёт одно событие rep с временем от DOWN до UP', (a) => {
    const c = createCounter({ down: 90, up: 160 });
    const ev = [];
    const angles = [...Array(10).fill(172), ...Array.from({ length: 20 }, (_, i) => 172 - i * 5), ...Array(8).fill(70), ...Array.from({ length: 20 }, (_, i) => 75 + i * 5), ...Array(10).fill(172)];
    angles.forEach((x, i) => ev.push(...c.update(x, i * 33.3)));
    a.deep(ev.filter((e) => ['start', 'down', 'rep'].includes(e.type)).map((e) => e.type), ['start', 'down', 'rep']);
    const r = ev.find((e) => e.type === 'rep');
    a.ok(r.min < 80, `минимум ${r.min}`);
    a.ok(r.downMs > 400, `downMs ${r.downMs}`);
  });

  t.test('счётчик: шум у порога не даёт лишних DOWN (гистерезис)', (a) => {
    const c = createCounter({ down: 90, up: 160 });
    const ev = [];
    let i = 0;
    const noisy = [86, 93, 87, 92, 85, 91, 88, 94, 86, 92, 87, 93, 85, 91, 88, 92];
    for (const x of [...Array(12).fill(172), 150, 130, 110, 95, ...noisy, 91, 93, 89, 92, ...noisy, 110, 140, 165, 172, 172, 172, 172]) ev.push(...c.update(x, i++ * 33.3));
    a.eq(ev.filter((e) => e.type === 'down').length, 1);
    a.eq(ev.filter((e) => e.type === 'rep').length, 1);
  });

  t.test('счётчик: начинает только из верхней точки', (a) => {
    const c = createCounter({ down: 90, up: 160 });
    const ev = [];
    let i = 0;
    for (const x of [80, 80, 80, 100, 130, 165, 170, ...Array(20).fill(172)]) ev.push(...c.update(x, i++ * 33.3));
    a.eq(ev.filter((e) => e.type === 'rep').length, 0, 'повтор снизу вверх без старта сверху');
    a.eq(c.armed, true, 'верх держится 300 мс: дальше считаем');
  });

  // ─── Минимальная длительность правила ───
  t.test('правило: 7 кадров подряд мало, 8-й кадр включает', (a) => {
    const h = createHolds({ minMs: 400, minFrames: 8, releaseMs: 300 });
    const edges = [];
    for (let i = 0; i < 8; i++) edges.push(h.update('x', true, i * 30));
    a.deep(edges, [null, null, null, null, null, null, null, 'on']);
  });

  t.test('правило: 400 мс хватает и при редких кадрах', (a) => {
    const h = createHolds({ minMs: 400, minFrames: 8, releaseMs: 300 });
    a.deep([0, 100, 200, 300, 400].map((ms) => h.update('x', true, ms)), [null, null, null, null, 'on']);
  });

  t.test('правило: «подряд»: один кадр без условия начинает отсчёт заново', (a) => {
    const h = createHolds({ minMs: 400, minFrames: 8, releaseMs: 300 });
    for (let i = 0; i < 6; i++) h.update('x', true, i * 30);
    h.update('x', false, 180);
    const edges = [];
    for (let i = 0; i < 8; i++) edges.push(h.update('x', true, 210 + i * 30));
    a.eq(edges.indexOf('on'), 7);
  });

  t.test('правило: отпускает через releaseMs без условия, короткий провал не дробит', (a) => {
    const h = createHolds({ minMs: 400, minFrames: 8, releaseMs: 300 });
    for (let i = 0; i < 8; i++) h.update('x', true, i * 30);
    a.eq(h.update('x', false, 240), null);
    a.eq(h.update('x', true, 270), null, 'вернулось: та же ошибка, не новая');
    a.eq(h.update('x', false, 300), null);
    a.eq(h.update('x', false, 600), 'off');
  });

  // ─── Приседания ───
  t.test('приседания: чистые повторы засчитываются', (a) => {
    const s = setup(squat);
    s.feed(hold(squatPose(STAND), 10));
    for (let i = 0; i < 3; i++) s.feed(rep(squatPose, STAND, DEEP));
    s.feed(hold(squatPose(STAND), 20));
    a.eq(s.ctrl.count, 3);
    a.eq(s.of('rejected').length, 0);
    a.eq(s.of('fault').length, 0);
  });

  t.test('приседания: прыжки с приземлением в полуприсед не считаются', (a) => {
    const s = setup(squat);
    s.feed(hold(squatPose(STAND), 15));
    for (let i = 0; i < 4; i++) {
      s.feed(seq(squatPose, [0, STAND], [180, { knee: 128, shin: 18, lean: 16 }], [330, { ...STAND, lift: 0 }], [500, { ...STAND, lift: 0.14 }], [680, { ...STAND, lift: 0 }], [880, { knee: 118, shin: 22, lean: 20, lift: 0 }], [1250, STAND]));
    }
    s.feed(hold(squatPose(STAND), 20));
    a.eq(s.ctrl.count, 0, 'прыжки засчитались');
    a.eq(s.of('rejected').length, 0, `прыжки попали в лог: ${JSON.stringify(s.of('rejected'))}`);
  });

  t.test('приседания: прыжок с приземлением в глубокий присед не считается', (a) => {
    const s = setup(squat);
    s.feed(hold(squatPose(STAND), 15));
    s.feed(seq(squatPose, [0, STAND], [180, { knee: 125, shin: 18, lean: 16 }], [330, STAND], [520, { ...STAND, lift: 0.15 }], [700, STAND], [950, DEEP], [1700, STAND]));
    s.feed(hold(squatPose(STAND), 20));
    a.eq(s.ctrl.count, 0);
  });

  t.test('приседания: после прыжков обычные повторы снова считаются', (a) => {
    const s = setup(squat);
    s.feed(hold(squatPose(STAND), 15));
    s.feed(seq(squatPose, [0, STAND], [180, { knee: 128, shin: 18 }], [330, STAND], [500, { ...STAND, lift: 0.14 }], [680, STAND], [880, { knee: 118, shin: 22 }], [1250, STAND]));
    s.feed(hold(squatPose(STAND), 15));
    for (let i = 0; i < 2; i++) s.feed(rep(squatPose, STAND, DEEP));
    s.feed(hold(squatPose(STAND), 10));
    a.eq(s.ctrl.count, 2);
  });

  t.test('приседания: колени за носки: повтор не засчитан, подсказка жюри дословно', (a) => {
    const s = setup(squat);
    s.feed(hold(squatPose(STAND), 10));
    s.feed(rep(squatPose, STAND, { ...DEEP, shin: 42 }, 2000));
    s.feed(hold(squatPose(STAND), 10));
    a.eq(s.ctrl.count, 0);
    a.deep(s.of('rejected').map((e) => [e.code, e.text]), [['knees_over_toes', 'колени за носками']]);
    const f = s.of('fault')[0];
    a.eq(f.text, 'Колени выходят за носки, сядь глубже назад');
    a.deep(f.joints, [25, 27, 31]);
  });

  t.test('приседания: колени за носки лицом влево тоже ловятся', (a) => {
    const s = setup(squat);
    const make = (p) => squatPose({ ...p, dir: -1, near: 'right' });
    s.feed(hold(make(STAND), 10));
    s.feed(rep(make, STAND, { ...DEEP, shin: 42 }, 2000));
    s.feed(hold(make(STAND), 10));
    a.deep(s.of('rejected').map((e) => e.code), ['knees_over_toes']);
    a.deep(s.of('fault')[0].joints, [26, 28, 32]);
  });

  t.test('приседания: лицом к камере правило про носки молчит', (a) => {
    const s = setup(squat);
    const make = (p) => squatPose({ ...p, front: true });
    s.feed(hold(make(STAND), 10));
    s.feed(rep(make, STAND, { ...DEEP, shin: 42 }, 2000));
    a.eq(s.of('fault').filter((e) => e.code === 'knees_over_toes').length, 0);
  });

  t.test('приседания: наклон спины в нижней точке: повтор не засчитан', (a) => {
    const s = setup(squat);
    s.feed(hold(squatPose(STAND), 10));
    s.feed(rep(squatPose, STAND, { ...DEEP, lean: 58 }, 2000));
    s.feed(hold(squatPose(STAND), 10));
    a.eq(s.ctrl.count, 0);
    a.deep(s.of('rejected').map((e) => e.code), ['torso_lean']);
    a.eq(s.of('fault')[0].text, 'Спина наклоняется вперёд, держи грудь, смотри перед собой');
  });

  t.test('приседания: мелкий присед: «недостаточная глубина», не засчитан', (a) => {
    const s = setup(squat);
    s.feed(hold(squatPose(STAND), 10));
    s.feed(rep(squatPose, STAND, { knee: 120, shin: 18, lean: 18 }));
    s.feed(hold(squatPose(STAND), 20));
    a.eq(s.ctrl.count, 0);
    a.deep(s.of('rejected').map((e) => [e.code, e.text]), [['squat_shallow', 'недостаточная глубина']]);
    a.eq(s.feedback.current?.text, 'Недостаточная глубина: бедро выше колена, присядь ниже');
  });

  t.test('приседания: не встал до конца и снова вниз: полуповтор в лог, потом повтор считается', (a) => {
    const s = setup(squat);
    s.feed(hold(squatPose(STAND), 10));
    s.feed(seq(squatPose, [0, STAND], [800, DEEP], [1300, { knee: 142, shin: 10, lean: 12 }], [1800, DEEP], [2600, STAND]));
    s.feed(hold(squatPose(STAND), 20));
    a.eq(s.ctrl.count, 1);
    a.deep(s.of('rejected').map((e) => e.code), ['squat_half_up']);
    a.eq(s.of('fault').find((e) => e.code === 'squat_half_up').text, 'Встань до конца, выпрями колени');
  });

  t.test('приседания: не видно колено: счёт на паузе и подсказка про кадр', (a) => {
    const s = setup(squat);
    const hidden = (p) => squatPose({ ...p, vis: 0.3, farVis: 0.2 });
    s.feed(hold(squatPose(STAND), 10));
    s.feed(rep(hidden, STAND, DEEP));
    s.feed(hold(hidden(STAND), 10));
    a.eq(s.ctrl.count, 0);
    a.eq(s.feedback.current?.text, 'Не весь корпус в кадре, отойди');
    a.eq(s.feedback.current?.priority, PRIORITY.visibility);
    s.feed(hold(squatPose(STAND), 20));
    s.feed(rep(squatPose, STAND, DEEP));
    a.eq(s.ctrl.count, 1, 'после возвращения в кадр счёт идёт');
  });

  t.test('приседания: никого в кадре: своя подсказка', (a) => {
    const s = setup(squat);
    s.feed(hold(null, 12));
    a.eq(s.feedback.current?.text, 'Не вижу тебя, встань в кадр целиком');
  });


  t.test('приседания: лицом к камере не считаем, просим повернуться боком', (a) => {
    const s = setup(squat);
    const make = (p) => squatPose({ ...p, facing: true });
    s.feed(hold(make(STAND), 15));
    for (let i = 0; i < 2; i++) s.feed(rep(make, STAND, DEEP));
    s.feed(hold(make(STAND), 5));
    a.eq(s.ctrl.count, 0);
    a.eq(s.of('rejected').length, 0, 'лицом к камере не пишем ложную «глубину»');
    a.eq(s.feedback.current?.text, 'Повернись боком к камере, так видно колени и спину');
    // повернулся боком: считаем
    s.feed(hold(squatPose(STAND), 20));
    s.feed(rep(squatPose, STAND, DEEP));
    s.feed(hold(squatPose(STAND), 5));
    a.eq(s.ctrl.count, 1);
  });

  t.test('приседания лицом к ноутбуку (30 и 15 fps, с дрожанием): без счёта и ложных ошибок, подсказка «повернись боком» за полсекунды', (a) => {
    const FRONT_UP = { knee: 176, shin: 0, lean: 2 };
    for (const [fps, step] of [[30, 1], [15, 2]]) {
      const s = setup(squat);
      const make = (p) => squatPose({ ...p, facing: true, front: true });
      const play = (frames) => s.feed((step === 1 ? frames : halfRate(frames)), { dt: 1000 / fps });
      // лицом к камере колено в кадре сгибается слабо (бедро уходит на камеру), берём и слабый, и глубокий вариант
      play(jitter(hold(make(FRONT_UP), 16)));
      a.eq(s.feedback.current?.text, 'Повернись боком к камере, так видно колени и спину', `${fps} fps: подсказка сразу`);
      a.eq(s.feedback.current?.level, 'info', `${fps} fps: это совет, не ошибка`);
      for (const low of [{ knee: 130, shin: 6, lean: 10 }, { knee: 92, shin: 10, lean: 16 }]) {
        for (let i = 0; i < 2; i++) play(jitter(rep(make, FRONT_UP, low, 1700)));
      }
      play(jitter(hold(make(FRONT_UP), 10)));
      a.eq(s.ctrl.count, 0, `${fps} fps: лицом не считаем`);
      a.eq(s.of('fault').length, 0, `${fps} fps: ни одной ложной ошибки`);
      a.eq(s.of('rejected').length, 0, `${fps} fps: лог незасчитанных пуст`);
      a.eq(s.feedback.current?.text, 'Повернись боком к камере, так видно колени и спину', `${fps} fps: подсказка висит`);
      a.eq(s.ctrl.summary().faults.length, 0, `${fps} fps: итоги без ошибок`);
    }
  });

  // ─── Отжимания ───
  t.test('отжимания: чистые повторы засчитываются', (a) => {
    const s = setup(pushup);
    s.feed(hold(pushupPose(TOP), 10));
    for (let i = 0; i < 3; i++) s.feed(rep(pushupPose, TOP, LOW, 1400));
    s.feed(hold(pushupPose(TOP), 10));
    a.eq(s.ctrl.count, 3);
    a.eq(s.of('rejected').length, 0);
  });

  t.test('отжимания: прыжки на месте с машущими руками не считаются', (a) => {
    const s = setup(pushup);
    const make = (p) => squatPose({ ...STAND, ...p });
    for (let i = 0; i < 6; i++) s.feed(seq(make, [0, { arm: 175, lift: 0 }], [250, { arm: 70, lift: 0.12 }], [500, { arm: 175, lift: 0 }]));
    a.eq(s.ctrl.count, 0);
    a.eq(s.of('rejected').length, 0);
    a.eq(s.feedback.current?.text, 'Прими упор лёжа, боком к камере');
  });

  t.test('отжимания: стоя сгибает руки, потом ложится: счёт только в упоре', (a) => {
    const s = setup(pushup);
    const stand = (p) => squatPose({ ...STAND, ...p });
    s.feed(seq(stand, [0, { arm: 175 }], [500, { arm: 60 }], [1000, { arm: 175 }]));
    s.feed(hold(pushupPose(LOW), 10)); // лёг сразу в нижнюю точку
    s.feed(seq(pushupPose, [0, LOW], [700, TOP]));
    a.eq(s.ctrl.count, 0, 'подъём с пола без верхней точки не повтор');
    s.feed(hold(pushupPose(TOP), 10));
    s.feed(rep(pushupPose, TOP, LOW, 1400));
    a.eq(s.ctrl.count, 1);
  });

  t.test('отжимания: недожал вниз: угол в тексте, в лог «недостаточная глубина»', (a) => {
    const s = setup(pushup);
    s.feed(hold(pushupPose(TOP), 10));
    s.feed(rep(pushupPose, TOP, { elbow: 135 }, 1400));
    s.feed(hold(pushupPose(TOP), 10));
    a.eq(s.ctrl.count, 0);
    a.deep(s.of('rejected').map((e) => [e.code, e.text]), [['pushup_half_down', 'недостаточная глубина']]);
    const f = s.of('fault')[0];
    a.ok(/^Не до конца опускаешься: локоть 1[34]\d°, нужно меньше 125°$/.test(f.text), f.text);
  });

  t.test('отжимания: не выпрямил руки: угол в тексте', (a) => {
    const s = setup(pushup);
    s.feed(hold(pushupPose(TOP), 10));
    s.feed(seq(pushupPose, [0, TOP], [700, LOW], [1100, { elbow: 143 }], [1500, LOW], [2200, TOP]));
    s.feed(hold(pushupPose(TOP), 10));
    a.eq(s.ctrl.count, 1);
    a.deep(s.of('rejected').map((e) => e.code), ['pushup_half_up']);
    const f = s.of('fault').find((e) => e.code === 'pushup_half_up');
    a.ok(/^Не выпрямил руки: локоть 1[34]\d°, нужно больше 150°$/.test(f.text), f.text);
  });

  t.test('отжимания: таз провис во время повтора: не засчитан', (a) => {
    const s = setup(pushup);
    s.feed(hold(pushupPose(TOP), 10));
    s.feed(rep((p) => pushupPose({ ...p, sag: 0.07 }), TOP, LOW, 1600));
    s.feed(hold(pushupPose(TOP), 10));
    a.eq(s.ctrl.count, 0);
    a.deep(s.of('rejected').map((e) => [e.code, e.text]), [['hip_sag', 'таз провис']]);
    a.eq(s.of('fault')[0].text, 'Таз провисает, напряги живот, выровняй тело');
  });

  t.test('отжимания: таз задран: не засчитан', (a) => {
    const s = setup(pushup);
    s.feed(hold(pushupPose(TOP), 10));
    s.feed(rep((p) => pushupPose({ ...p, sag: -0.07 }), TOP, LOW, 1600));
    s.feed(hold(pushupPose(TOP), 10));
    a.eq(s.ctrl.count, 0);
    a.deep(s.of('rejected').map((e) => e.code), ['hip_pike']);
    a.eq(s.of('fault')[0].text, 'Таз задран вверх, опусти таз в линию с плечами');
  });

  t.test('отжимания: слишком быстро: засчитан, но подсказка про темп', (a) => {
    const s = setup(pushup);
    s.feed(hold(pushupPose(TOP), 10));
    s.feed(seq(pushupPose, [0, TOP], [300, LOW], [450, TOP]));
    s.feed(hold(pushupPose(TOP), 10));
    a.eq(s.ctrl.count, 1);
    a.deep(s.of('fault').map((e) => e.code), ['pushup_tempo']);
    a.eq(s.of('fault')[0].text, 'Слишком быстро, контролируй опускание');
  });



  t.test('шум: чистые повторы с дрожанием точек считаются точно, без ложных ошибок (30 и 15 fps)', (a) => {
    for (const rate of [1, 2]) {
      for (const [mod, make, top, bottom, ms] of [[squat, squatPose, STAND, DEEP, 1800], [pushup, pushupPose, TOP, LOW, 1500]]) {
        const s = setup(mod);
        let frames = [...hold(make(top), 12)];
        for (let i = 0; i < 5; i++) frames.push(...rep(make, top, bottom, ms));
        frames.push(...hold(make(top), 12));
        frames = jitter(frames);
        if (rate === 2) frames = halfRate(frames);
        s.feed(frames, { dt: (1000 / FPS) * rate });
        const tag = `${mod === squat ? 'приседания' : 'отжимания'} ${FPS / rate} fps`;
        a.eq(s.ctrl.count, 5, tag);
        a.eq(s.of('rejected').length, 0, `${tag}: ${JSON.stringify(s.of('rejected'))}`);
        a.eq(s.of('fault').length, 0, `${tag}: ${JSON.stringify(s.of('fault').map((f) => f.code))}`);
      }
    }
  });

  // ─── Подсказки (feedback.js) ───
  t.test('подсказка: старшая вытесняет сразу, младшая ждёт', (a) => {
    const s = setup(null);
    const fb = s.feedback;
    a.eq(fb.hint('темп', { code: 'tempo', priority: PRIORITY.tempo }), true);
    a.eq(fb.hint('форма', { code: 'form', priority: PRIORITY.form, joints: [23] }), true, 'форма старше темпа');
    a.eq(fb.current.code, 'form');
    a.deep([...fb.highlight], [23]);
    s.clock.to(5000);
    a.eq(fb.hint('глубина', { code: 'depth', priority: PRIORITY.depth }), false, 'младшая не вытесняет висящую старшую');
    a.eq(fb.hint('видимость', { code: 'vis', priority: PRIORITY.visibility }), true);
    a.deep([...fb.highlight], [], 'суставы от новой подсказки');
  });

  t.test('подсказка: не короче 1.5 с, даже если правило уже исправили', (a) => {
    const s = setup(null);
    const fb = s.feedback;
    fb.hint('таз', { code: 'sag', priority: 3, level: 'warn' });
    s.clock.to(400);
    fb.clear('sag');
    a.eq(fb.current?.code, 'sag', 'через 0.4 с ещё видна');
    s.clock.to(1499);
    a.eq(fb.current?.code, 'sag');
    s.clock.to(1502);
    a.eq(fb.current, null, 'ушла ровно после 1.5 с');
  });

  t.test('подсказка: той же важности ждёт 1.5 с, потом сменяет', (a) => {
    const s = setup(null);
    const fb = s.feedback;
    fb.hint('раз', { code: 'a', priority: 2 });
    s.clock.to(1000);
    a.eq(fb.hint('два', { code: 'b', priority: 2 }), false);
    s.clock.to(1600);
    a.eq(fb.hint('два', { code: 'b', priority: 2 }), true);
  });

  t.test('подсказка: разовая уходит сама через ttl, тот же code обновляет текст', (a) => {
    const s = setup(null);
    const fb = s.feedback;
    fb.hint('локоть 115°', { code: 'half', priority: 2, ttl: 2600 });
    s.clock.to(1000);
    fb.hint('локоть 120°', { code: 'half', priority: 2, ttl: 2600 });
    a.eq(fb.current.text, 'локоть 120°');
    s.clock.to(3500);
    a.eq(fb.current?.code, 'half', 'ttl считается от последнего вызова');
    s.clock.to(3700);
    a.eq(fb.current, null);
  });

  t.test('звук: warn-подсказка играет ошибку, один code не чаще 1.5 с, info молчит', (a) => {
    const s = setup(null);
    const fb = s.feedback;
    fb.hint('таз', { code: 'sag', priority: 3, level: 'warn' });
    for (let ms = 33; ms < 1400; ms += 33) {
      s.clock.to(ms);
      fb.hint('таз', { code: 'sag', priority: 3, level: 'warn' });
    }
    a.deep(s.sounds, ['error'], 'подсказка висит: звук один раз');
    fb.clearNow();
    s.clock.to(1450);
    fb.hint('таз', { code: 'sag', priority: 3, level: 'warn' });
    a.eq(s.sounds.length, 1, 'снова тот же code раньше 1.5 с: без звука');
    fb.clearNow();
    s.clock.to(3200);
    fb.hint('таз', { code: 'sag', priority: 3, level: 'warn' });
    a.eq(s.sounds.length, 2);
    fb.clearNow();
    fb.hint('встань в упор', { code: 'gate', priority: 4, level: 'info' });
    a.eq(s.sounds.length, 2, 'info без звука');
  });

  t.test('голос выключен: say молчит', (a) => {
    const s = setup(null);
    a.eq(s.feedback.say('Старт'), false);
    s.feedback.hint('таз', { code: 'sag', priority: 3, level: 'warn' });
    a.deep(s.spoken, []);
  });

  t.test('голос включён: без спама по коду и по важности', (a) => {
    const s = setup(null, { voice: true });
    const fb = s.feedback;
    a.eq(fb.say('таз', { code: 'sag', priority: 3 }), true);
    s.synth.speaking = true;
    s.clock.to(300);
    a.eq(fb.say('темп', { code: 'tempo', priority: 1 }), false, 'младшая не перебивает');
    a.eq(fb.say('не видно', { code: 'vis', priority: 4 }), true, 'старшая перебивает');
    a.eq(fb.say('3', '3'), true, 'системная фраза звучит всегда');
    s.synth.speaking = false;
    s.clock.to(2000);
    a.eq(fb.say('таз', { code: 'sag', priority: 3 }), false, 'тот же код раньше 6 с');
    s.clock.to(6100);
    a.eq(fb.say('таз', { code: 'sag', priority: 3 }), true);
    a.deep(s.spoken, ['таз', 'не видно', '3', 'таз']);
  });

  t.test('подсказка в упражнении: суставы правила красные, после исправления гаснут', (a) => {
    const s = setup(pushup);
    s.feed(hold(pushupPose(TOP), 10));
    s.feed(hold(pushupPose({ ...TOP, sag: 0.07 }), 20));
    a.eq(s.feedback.current?.text, 'Таз провисает, напряги живот, выровняй тело');
    a.deep([...s.feedback.highlight], [23]);
    s.feed(hold(pushupPose(TOP), 70));
    a.eq(s.feedback.current, null);
    a.eq(s.feedback.highlight.size, 0);
  });

  t.test('приоритет: видимость важнее формы', (a) => {
    const s = setup(pushup);
    s.feed(hold(pushupPose(TOP), 10));
    s.feed(hold(pushupPose({ ...TOP, sag: 0.07 }), 20));
    a.eq(s.feedback.current?.code, 'hip_sag');
    s.feed(hold(pushupPose({ ...TOP, sag: 0.07, vis: 0.3, farVis: 0.2 }), 12));
    a.eq(s.feedback.current?.code, 'visibility');
  });

  t.test('приоритет: форма важнее глубины, глубина важнее темпа', (a) => {
    const s = setup(pushup);
    s.feed(hold(pushupPose(TOP), 10));
    // таз провис всё время, и повтор мелкий: на экране форма, в логе причина тоже форма
    s.feed(rep((p) => pushupPose({ ...p, sag: 0.07 }), TOP, { elbow: 135 }, 1400));
    a.eq(s.feedback.current?.code, 'hip_sag');
    a.deep(s.of('rejected').map((e) => e.code), ['hip_sag']);
    a.ok(s.of('fault').some((e) => e.code === 'pushup_half_down'), 'глубина всё равно посчитана в ошибках');
    // быстрый повтор сразу после мелкого: на экране глубина, темп ждёт
    const q = setup(pushup);
    q.feed(hold(pushupPose(TOP), 10));
    q.feed(rep(pushupPose, TOP, { elbow: 135 }, 1000));
    q.feed(seq(pushupPose, [0, TOP], [300, LOW], [450, TOP]));
    q.feed(hold(pushupPose(TOP), 6));
    a.eq(q.feedback.current?.code, 'pushup_half_down');
    a.ok(q.of('fault').some((e) => e.code === 'pushup_tempo'), 'темп записан');
  });

  // ─── «Встань в позицию» (ready): галочки до отсчёта LIVE ───
  const ticks = (r) => r.checks.map((c) => [c.id, c.text, c.ok]);
  const byId = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c.ok]));
  const FACING = { ...STAND, facing: true, front: true };

  t.test('ready приседания: боком, прямо, тело видно: три галочки, тексты до 22 символов', (a) => {
    const s = setup(squat);
    const r = s.probe(hold(squatPose(STAND), 3));
    a.deep(ticks(r), [['body', 'Всё тело в кадре', true], ['side', 'Боком к камере', true], ['stand', 'Стоишь прямо', true]]);
    a.eq(r.ok, true);
    a.ok(r.checks.every((c) => c.text.length <= 22), 'text до 22 символов');
  });

  t.test('ready приседания: лицом к камере нет только «боком», повернулся боком: все галочки', (a) => {
    const s = setup(squat);
    let r = s.probe(hold(squatPose(FACING), 6));
    a.deep(byId(r), { body: true, side: false, stand: true });
    a.eq(r.ok, false);
    r = s.probe(hold(squatPose(STAND), 8));
    a.deep(byId(r), { body: true, side: true, stand: true });
    a.eq(r.ok, true);
  });

  t.test('ready приседания: щиколотки не видны, наклонился, никого нет: не готов', (a) => {
    const s = setup(squat);
    const noAnkles = { 27: { visibility: 0.2 }, 28: { visibility: 0.2 } };
    a.deep(byId(s.probe([squatPose({ ...STAND, override: noAnkles })])), { body: false, side: false, stand: false });
    a.deep(byId(s.probe(hold(squatPose({ ...STAND, lean: 78 }), 3))), { body: true, side: true, stand: false });
    for (const pose of [null, undefined]) {
      const r = s.ctrl.ready({ t: s.t, ran: 'pose', width: WIDTH, height: HEIGHT, pose }, s.t);
      a.deep(byId(r), { body: false, side: false, stand: false });
      a.eq(r.ok, false);
    }
    a.deep(byId(s.probe([null])), { body: false, side: false, stand: false }, 'кадр без точек');
  });

  t.test('ready приседания: чистая проверка, счёт после неё тот же, что без неё', (a) => {
    const frames = [...hold(squatPose(STAND), 12), ...rep(squatPose, STAND, DEEP, 1800), ...rep(squatPose, STAND, { ...DEEP, lean: 58 }, 1800), ...hold(squatPose(STAND), 10)];
    const cold = setup(squat);
    cold.feed(frames);
    const warm = setup(squat);
    warm.probe([...hold(squatPose(FACING), 6), ...hold(squatPose(STAND), 30)]); // пришёл, повернулся, встал
    a.eq(warm.events.length, 0, 'ready ничего не шлёт в шину');
    a.eq(warm.feedback.current, null, 'ready не пишет подсказку');
    a.eq(warm.sounds.length + warm.spoken.length, 0, 'ready без звука');
    a.eq(warm.ctrl.count, 0);
    a.deep(warm.ctrl.summary().faults, []);
    warm.wait(3000); // отсчёт 3-2-1
    warm.ctrl.start(warm.t);
    warm.feed(frames);
    a.eq(cold.ctrl.count, 1, 'контроль: без ready один повтор засчитан, один нет');
    a.eq(warm.ctrl.count, cold.ctrl.count);
    a.deep(warm.of('rejected').map((e) => e.code), cold.of('rejected').map((e) => e.code));
    a.deep(warm.of('fault').map((e) => e.code), cold.of('fault').map((e) => e.code));
  });

  t.test('ready приседания: ✓ значит, что счёт пойдёт, ✗ значит, что кадр в счёт не идёт', (a) => {
    for (const [pose, ok] of [[STAND, true], [FACING, false], [{ ...STAND, lean: 78 }, false]]) {
      const s = setup(squat);
      const r = s.probe(hold(squatPose(pose), 12));
      a.eq(r.ok, ok, `ready ${JSON.stringify(pose)}`);
      // тот же кадр в счёте: если ready говорит «готов», кадр доходит до счётчика (угол считается)
      s.feed(hold(squatPose(pose), 12));
      a.eq(s.ctrl.counter.angle != null, ok, `счётчик ${JSON.stringify(pose)}`);
    }
  });

  t.test('ready отжимания: упор лёжа готов, стоя и без ног в кадре нет; тексты до 22 символов', (a) => {
    const s = setup(pushup);
    let r = s.probe(hold(pushupPose(TOP), 3));
    a.deep(ticks(r), [['body', 'Всё тело в кадре', true], ['plank', 'Упор лёжа', true]]);
    a.eq(r.ok, true);
    a.ok(r.checks.every((c) => c.text.length <= 22), 'text до 22 символов');
    r = s.probe(hold(squatPose(STAND), 3)); // стоит
    a.deep(byId(r), { body: true, plank: false });
    a.eq(r.ok, false);
    const noAnkles = { 27: { visibility: 0.2 }, 28: { visibility: 0.2 } };
    r = s.probe([pushupPose({ ...TOP, override: noAnkles })]);
    a.deep(byId(r), { body: false, plank: false });
    r = s.ctrl.ready({ t: s.t, ran: 'pose', width: WIDTH, height: HEIGHT, pose: null }, s.t);
    a.deep(byId(r), { body: false, plank: false });
  });

  t.test('ready отжимания: чистая проверка, счёт после неё тот же, что без неё', (a) => {
    const frames = [...hold(pushupPose(TOP), 10), ...rep(pushupPose, TOP, LOW, 1400), ...rep((p) => pushupPose({ ...p, sag: 0.07 }), TOP, LOW, 1600), ...rep(pushupPose, TOP, LOW, 1400), ...hold(pushupPose(TOP), 10)];
    const cold = setup(pushup);
    cold.feed(frames);
    const warm = setup(pushup);
    warm.probe([...hold(squatPose(STAND), 6), ...hold(pushupPose(TOP), 30)]); // стоял, лёг в упор
    a.eq(warm.events.length, 0, 'ready ничего не шлёт в шину');
    a.eq(warm.feedback.current, null, 'ready не пишет подсказку');
    warm.wait(3000);
    warm.ctrl.start(warm.t);
    warm.feed(frames);
    a.eq(cold.ctrl.count, 2, 'контроль: без ready два повтора засчитаны, провисший нет');
    a.eq(warm.ctrl.count, cold.ctrl.count);
    a.deep(warm.of('rejected').map((e) => e.code), cold.of('rejected').map((e) => e.code));
  });

  // ─── Настоящие ролики (калибровка порогов) ───
  t.test('ролик: приседания сбоку: 5 засчитано, шестой не засчитан за наклон спины', (a) => {
    const s = replayTrace('squat-side', squat);
    if (!s) return;
    a.eq(s.ctrl.count, 5);
    a.deep(s.of('rejected').map((e) => e.code), ['torso_lean']);
  });

  t.test('ролик: отжимания сбоку: 3 полных повтора (четвёртый обрезан заставкой)', (a) => {
    const s = replayTrace('pushup-side-short', pushup);
    if (!s) return;
    a.eq(s.ctrl.count, 3);
    a.eq(s.of('rejected').length, 0);
  });

  t.test('ролик: отжимания с разных ракурсов: 13, спереди счёт на паузе', (a) => {
    const s = replayTrace('pushup-horizontal', pushup);
    if (!s) return;
    a.eq(s.ctrl.count, 13);
  });

  // ─── Итоги ───
  t.test('итоги: «4 незасчитанных: 3 × недостаточная глубина, 1 × таз провис»', (a) => {
    const s = setup(pushup);
    s.feed(hold(pushupPose(TOP), 10));
    for (let i = 0; i < 3; i++) {
      s.feed(rep(pushupPose, TOP, { elbow: 135 }, 1400));
      s.feed(hold(pushupPose(TOP), 5));
    }
    s.feed(rep((p) => pushupPose({ ...p, sag: 0.07 }), TOP, LOW, 1600));
    s.feed(hold(pushupPose(TOP), 5));
    s.feed(rep(pushupPose, TOP, LOW, 1400));
    s.feed(hold(pushupPose(TOP), 10));
    const sum = s.ctrl.summary();
    a.eq(s.ctrl.count, 1);
    a.eq(sum.extra.rejectedText, '4 незасчитанных: 3 × недостаточная глубина, 1 × таз провис');
    a.deep(sum.rejected.map((r) => r.code), ['pushup_half_down', 'pushup_half_down', 'pushup_half_down', 'hip_sag']);
    a.deep(sum.faults.map((f) => [f.code, f.text, f.count]), [['pushup_half_down', 'недостаточная глубина', 3], ['hip_sag', 'таз провис', 1]]);
  });

  t.test('итоги: склонение «незасчитанный»', (a) => {
    const line = (n) => describeRejected([{ text: 'x', count: n }]);
    a.eq(line(1), '1 незасчитанный: 1 × x');
    a.eq(line(2), '2 незасчитанных: 2 × x');
    a.eq(line(5), '5 незасчитанных: 5 × x');
    a.eq(line(11), '11 незасчитанных: 11 × x');
    a.eq(line(21), '21 незасчитанный: 21 × x');
    a.eq(describeRejected([]), '');
  });
};
