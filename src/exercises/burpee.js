// Берпи. Контракт контроллера: см. squat.js. Камера сбоку, всё тело в кадре.
// Один повтор = полный круг из положения стоя (так просил пользователь):
//   стоя → упор присев (руки на полу) → упор лёжа → отжимание → упор присев → прыжок → стоя.
// Это не угол одного сустава, поэтому свой движок: машина фаз createCycle (чистая, тесты в jsc) по позе кадра
// classify: stand | crouch | plank | move. Повтор засчитан, когда после прыжка человек снова стоит.
// Режим «Ошибка»: пропущенный шаг называется прямо, повтор в лог незасчитанных:
//   не было упора лёжа (присел и встал), не было отжимания (в упоре руки не сгибались), не было прыжка.
// Пороги в config.REPS.burpee, калибровка по ролику fixtures/burpee (сбоку, 15 fps, модель full).

import { REPS, VISION } from '../config.js';
import { angle, tiltFromVertical } from '../vision/geometry.js';
import { alphaFor, createHolds, createSight, describeRejected, PRIORITY, readyResult, SIDE_CHECK } from './reps.js';

const SIDE_KEYS = ['shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle'];
const GATE = 'burpee_stand';

export const RULES = {
  plank: { code: 'burpee_no_plank', kind: 'depth', label: 'не было упора лёжа', hint: 'Выбрось ноги назад в упор лёжа, потом отжимание' },
  pushup: { code: 'burpee_no_pushup', kind: 'depth', label: 'не было отжимания', hint: 'В упоре лёжа отожмись: грудь к полу и обратно' },
  jump: { code: 'burpee_no_jump', kind: 'depth', label: 'не было прыжка', hint: 'В конце выпрыгни вверх, ноги отрываются от пола' },
};

export const GATES = {
  stand: { hint: 'Встань прямо боком к камере, с этого начинается берпи' },
};

/** Метрики кадра. tilt: линия плечо-щиколотка к горизонтали (0 лежит, 90 стоит). */
export function measure({ lm, idx, aspect, sm }) {
  const shoulder = lm[idx.shoulder];
  const wrist = lm[idx.wrist];
  const knee = lm[idx.knee];
  const ankle = lm[idx.ankle];
  return {
    knee: sm('knee', angle(lm[idx.hip], knee, ankle, aspect)),
    elbow: sm('elbow', angle(shoulder, lm[idx.elbow], wrist, aspect)),
    tilt: sm('tilt', 90 - tiltFromVertical(shoulder, ankle, aspect)),
    handsDown: wrist.y > knee.y, // кисти ниже колен: руки на полу (присед или упор)
    armsUp: wrist.y < shoulder.y, // руки над плечами: прыжок с руками вверх
    ankleY: ankle.y,
  };
}

/** Поза кадра для машины фаз. */
export function classify(m, cfg = REPS.burpee) {
  if (m.handsDown && m.tilt < cfg.plankMaxTilt && m.knee > cfg.plankKneeMin) return 'plank';
  if (m.handsDown && m.knee < cfg.crouchKneeMax) return 'crouch';
  if (!m.handsDown && m.tilt > cfg.standMinTilt && m.knee > cfg.standKneeMin) return 'stand';
  return 'move';
}

/**
 * Машина фаз одного берпи. update(m, t) → события кадра:
 *   { type: 'armed' }                        впервые постоял armMs: счёт начался
 *   { type: 'stage', stage }                 шаг круга: down | plank | pushup | up | rise
 *   { type: 'warn', rule }                   шаг пропущен прямо сейчас (ушёл из упора без отжимания)
 *   { type: 'rep' }                          полный круг, повтор засчитан
 *   { type: 'miss', rule }                   круг закончился без шага rule: повтор не засчитан
 * opts: { requirePushup, requireJump } (по умолчанию из cfg; без них берпи без отжимания или прыжка).
 */
export function createCycle(cfg = REPS.burpee, opts = {}) {
  const requirePushup = opts.requirePushup ?? cfg.requirePushup;
  const requireJump = opts.requireJump ?? cfg.requireJump;
  const s = { stage: 'wait', since: 0, standSince: null, bent: false, pushup: false, floor: null, jumped: false };
  const go = (stage, t, ev) => {
    s.stage = stage;
    s.since = t;
    ev.push({ type: 'stage', stage });
  };
  const resolve = (ev) => {
    const rule = requirePushup && !s.pushup ? RULES.pushup : requireJump && !s.jumped ? RULES.jump : null;
    ev.push(rule ? { type: 'miss', rule } : { type: 'rep' });
    s.stage = 'top';
  };
  const startCycle = (t, ev) => {
    Object.assign(s, { bent: false, pushup: false, floor: null, jumped: false });
    go('down', t, ev);
  };

  return {
    get stage() {
      return s.stage;
    },
    update(m, t) {
      const ev = [];
      const pose = classify(m, cfg);
      if (s.stage === 'wait') {
        s.standSince = pose === 'stand' ? s.standSince ?? t : null;
        if (s.standSince != null && t - s.standSince >= cfg.armMs) {
          s.stage = 'top';
          ev.push({ type: 'armed' });
        }
        return ev;
      }
      if (s.stage !== 'top' && t - s.since > cfg.cycleMaxMs) s.stage = 'top'; // застрял посреди круга: начать заново
      step(pose, m, t, ev);
      return ev;
    },
  };

  function step(pose, m, t, ev) {
    switch (s.stage) {
      case 'top':
        if (pose === 'crouch' || pose === 'plank') startCycle(t, ev);
        if (pose === 'plank') go('plank', t, ev);
        break;
      case 'down':
        if (pose === 'plank') go('plank', t, ev);
        else if (pose === 'stand') {
          ev.push({ type: 'miss', rule: RULES.plank });
          s.stage = 'top';
        }
        break;
      case 'plank':
        if (m.elbow < cfg.pushDown) s.bent = true;
        if (s.bent && !s.pushup && m.elbow > cfg.pushUp) {
          s.pushup = true;
          ev.push({ type: 'stage', stage: 'pushup' });
        }
        if (pose === 'crouch' || pose === 'stand') {
          if (requirePushup && !s.pushup) ev.push({ type: 'warn', rule: RULES.pushup });
          go('up', t, ev);
          s.floor = m.ankleY;
          if (pose === 'stand') go('rise', t, ev);
        }
        break;
      case 'up':
        if (pose === 'plank') go('plank', t, ev); // ещё раз в упор (второе отжимание)
        else if (pose === 'crouch') s.floor = Math.max(s.floor ?? m.ankleY, m.ankleY);
        else if (pose === 'stand' || (m.tilt > cfg.standMinTilt && !m.handsDown)) go('rise', t, ev);
        break;
      case 'rise':
        if (s.floor != null && s.floor - m.ankleY >= cfg.jumpRise) s.jumped = true;
        if (m.armsUp && m.knee > cfg.standKneeMin) s.jumped = true;
        if (s.jumped && (!requirePushup || s.pushup)) resolve(ev);
        else if (pose === 'crouch' || pose === 'plank' || t - s.since >= cfg.jumpWindowMs) {
          resolve(ev);
          if (pose === 'crouch' || pose === 'plank') step(pose, m, t, ev); // сразу следующий круг
        }
        break;
      default:
        break;
    }
  }
}

export function createController({ challenge, bus, feedback, debug, options }) {
  const cfg = REPS.burpee;
  const cycle = createCycle(cfg, options ?? {});
  const holds = createHolds();
  const faults = new Map();
  const rejected = [];
  const smooth = {};
  let k = 1;
  const sm = (key, v) => (smooth[key] = v == null || !Number.isFinite(v) ? null : smooth[key] == null ? v : smooth[key] + k * (v - smooth[key]));
  let lastT = null;
  let t0 = null;
  let stopped = false;
  let armed = false;
  let last = null;
  let streak = 0;
  let bestStreak = 0;

  function fire(rule) {
    const f = faults.get(rule.code) ?? { code: rule.code, text: rule.label, count: 0 };
    f.count += 1;
    faults.set(rule.code, f);
    bus?.emit('fault', { code: rule.code, text: rule.hint, joints: [], label: rule.label });
  }
  const sight = createSight({ sideKeys: SIDE_KEYS, visible: SIDE_KEYS }, { holds, fire, feedback, armed: () => armed });
  const aspectOf = (frame) => (frame.width > 0 && frame.height > 0 ? frame.width / frame.height : 1);
  const say = (rule, level = 'warn') =>
    feedback?.hint(rule.hint, { code: rule.code, priority: PRIORITY.depth, level, speak: true, ttl: REPS.fault.hintTtlMs });

  function onEvent(e, t) {
    if (e.type === 'armed') armed = true;
    else if (e.type === 'warn') say(e.rule);
    else if (e.type === 'rep') {
      c.count += 1;
      streak += 1;
      bestStreak = Math.max(bestStreak, streak);
      if (streak % 3 === 0) feedback?.hint('Полный круг, так держать', { code: 'praise', priority: 0, level: 'ok', speak: false, ttl: 2200 });
    } else if (e.type === 'miss') {
      streak = 0;
      fire(e.rule);
      say(e.rule);
      const r = { code: e.rule.code, text: e.rule.label, at: Math.round((t - (t0 ?? t)) / 100) / 10 };
      rejected.push(r);
      bus?.emit('rejected', { ...r });
    }
  }

  function step(frame, t) {
    k = alphaFor(lastT == null ? Infinity : t - lastT);
    lastT = t;
    const lm = frame.pose?.landmarks ?? null;
    const { pick, seen, reason } = sight.look(lm);
    sight.watch(seen, reason, t);
    if (!seen) return;
    const m = measure({ lm, idx: pick.idx, aspect: aspectOf(frame), sm });
    last = { lm, idx: pick.idx, side: pick.side, m };
    for (const e of cycle.update(m, t)) onEvent(e, t);
    if (holds.update(GATE, !armed, t) === 'off') feedback?.clear(GATE);
  }

  function present() {
    if (sight.active) sight.show();
    else if (!armed && holds.active(GATE)) feedback?.hint(GATES.stand.hint, { code: GATE, priority: PRIORITY.visibility, level: 'info', speak: true });
  }

  const c = {
    model: 'pose',
    unit: 'повторы',
    count: 0,
    done: false,
    failed: false,
    lives: null,
    maxLives: null,

    start(t) {
      t0 = t;
    },

    frame(frame, t = frame.t) {
      if (stopped) return;
      if (t0 == null) t0 = t;
      step(frame, t);
      present();
      c.done = c.count >= challenge.target;
      if (debug?.enabled) {
        debug.set('берпи', `${cycle.stage}, ${last ? classify(last.m, cfg) : '·'}`);
        debug.set('видимость', sight.active ? sight.rule.label : 'ок');
      }
    },

    /** «Встань в позицию»: всё тело в кадре, стоишь прямо; «боком к камере» только совет. */
    ready(frame, t = frame.t) {
      k = alphaFor(lastT == null ? Infinity : t - lastT);
      lastT = t;
      const lm = frame.pose?.landmarks ?? null;
      const { pick, seen, reason } = sight.look(lm);
      const m = seen ? measure({ lm, idx: pick.idx, aspect: aspectOf(frame), sm }) : null;
      const stand = m != null && classify(m, cfg) === 'stand';
      const side = m != null && SIDE_CHECK.test(m, cfg, lm);
      return readyResult([
        { id: 'body', text: 'Всё тело в кадре', ok: seen, ...(seen ? {} : { hint: sight.hintFor(reason) }) },
        { id: 'stand', text: 'Стоишь прямо', ok: stand, ...(m != null && !stand ? { hint: GATES.stand.hint } : {}) },
        { id: 'side', text: SIDE_CHECK.text, ok: side, soft: true, ...(m != null && !side ? { hint: SIDE_CHECK.hint } : {}) },
      ]);
    },

    stop() {
      stopped = true;
    },

    summary() {
      const reasons = new Map();
      for (const r of rejected) {
        const g = reasons.get(r.code) ?? { code: r.code, text: r.text, count: 0 };
        g.count += 1;
        reasons.set(r.code, g);
      }
      const byReason = [...reasons.values()].sort((a, b) => b.count - a.count);
      return {
        faults: [...faults.values()].map((f) => ({ ...f })).sort((a, b) => b.count - a.count),
        rejected: rejected.map((r) => ({ ...r })),
        extra: { rejectedCount: rejected.length, rejectedByReason: byReason, rejectedText: describeRejected(byReason), bestStreak },
      };
    },

    /** Скелет (сглаженный) поверх видео. */
    draw(frame, draw) {
      const pose = frame.pose;
      if (!pose?.landmarks || frame.t - pose.t > VISION.staleMs) return;
      draw.pose(draw.smoothPose ? draw.smoothPose(pose) : pose.landmarks, { highlight: feedback?.highlight ?? new Set() });
    },
  };
  return c;
}
