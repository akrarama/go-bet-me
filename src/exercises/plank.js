// Планка. Владелец: блок 1 (Упражнения). Контракт контроллера: см. squat.js.
// Удержание по позе: count = секунды в правильной планке, done при count ≥ цели, лимит времени даёт LIVE.
// Правильная планка = упор лёжа по гейту отжиманий (линия плечо-щиколотка почти горизонтальна, кисти на полу)
// и линия плечо-таз-щиколотка не хуже REPS.pushup.bodyLineMin. Время идёт только в правильной позе:
// провис таза, задранный таз, колени на полу или уход из упора ставят счёт на паузу.
// Режим «Ошибка» (подсказка, красные суставы, событие fault):
//   таз провис, таз задран (правила отжиманий), колени на полу (колено согнуто и ступни в воздухе за коленями,
//   держится 1 с: реже путается с потерей ног на краю кадра), вышел из планки (после того, как уже стоял в упоре).
// Видимость как у отжиманий (createSight в reps.js): плечи, локоть, запястье, таз, колено, щиколотка, край кадра.
// Похвала «Корпус ровный, держи» за каждые 15 с ровной планки подряд, уровень ok, никогда поверх ошибки.
// ready(): тело в кадре, упор лёжа, ровное тело (те же условия, что у счёта), у непройденной галочки hint.
// summary(): faults, extra { bestHoldSec (лучшее удержание подряд), holdSec (всего) }.

import { REPS, VISION } from '../config.js';
import { angle, dist } from '../vision/geometry.js';
import { alphaFor, createHolds, createSight, drawAngle, PRIORITY } from './reps.js';
import { GATES as PUSHUP_GATES, RULES as PUSHUP_RULES, isPlank, measure as pushupMeasure } from './pushup.js';

const SIDE_KEYS = ['shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle'];
const GATE = 'pose_gate'; // код подсказки «прими упор лёжа», пока человек ещё не вставал в планку

export const RULES = {
  sag: PUSHUP_RULES.sag,
  pike: PUSHUP_RULES.pike,
  // Колено согнуто и ступни выше колен: колени на полу. В прямой планке колено не ниже щиколотки.
  knees: {
    code: 'plank_knees',
    kind: 'form',
    label: 'колени на полу',
    hint: 'Колени на полу: подними их, ноги прямые',
    joints: ['knee'],
    test: (m, cfg) => m.knee != null && m.kneeUp != null && m.knee < cfg.kneeMin && m.kneeUp > cfg.kneeUpMin,
  },
  // Уже стоял в упоре и вышел из него
  left: {
    code: 'plank_left',
    kind: 'form',
    label: 'вышел из планки',
    hint: PUSHUP_GATES.plank.hint,
    joints: [],
  },
};

const PRAISE = ['Корпус ровный, держи', 'Ровная линия, так держать', 'Дыши ровно, держи планку'];

/** Положение до старта: те же условия, что пускают время в счёт. Тело в кадре добавляет ready сам. */
export function readyChecks(m, cfg) {
  const plank = m != null && isPlank(m, cfg);
  const line = plank && m.body >= cfg.bodyLineMin && !RULES.knees.test(m, cfg);
  let hint = null;
  if (m != null && plank && !line) hint = RULES.knees.test(m, cfg) ? RULES.knees.hint : m.hipBelow > 0 ? RULES.sag.hint : RULES.pike.hint;
  return [
    { id: 'plank', text: 'Упор лёжа', ok: plank, hint: m != null && !plank ? PUSHUP_GATES.plank.hint : null },
    { id: 'line', text: 'Тело ровное', ok: line, hint },
  ];
}

export function createController({ challenge, bus, feedback, debug }) {
  const cfg = { ...REPS.pushup, ...REPS.plank };
  const holds = createHolds();
  const kneeHolds = createHolds({ minMs: cfg.kneesMs, minFrames: Infinity });
  const faults = new Map(); // code → { code, text, count }
  const smooth = {};
  let k = 1; // EMA этого кадра
  const sm = (key, v) => (smooth[key] = v == null || !Number.isFinite(v) ? null : smooth[key] == null ? v : smooth[key] + k * (v - smooth[key]));
  let lastT = null;
  let stopped = false;
  let last = null; // последний кадр с видимым телом: { lm, idx, side, m }
  let inPlankMs = 0; // в упоре подряд
  let everPlank = false; // уже стоял в упоре (standMs подряд): дальше уход из него ошибка
  let counting = false; // на этом кадре время идёт
  let streakMs = 0; // ровной планки подряд (короткие паузы её не рвут)
  let pauseMs = 0;
  let bestMs = 0;
  let praised = 0; // сколько похвал за эту серию уже было
  let praiseN = 0;

  const jointsOf = (rule) => (last ? (rule.joints ?? []).map((key) => last.idx[key]).filter((i) => i != null) : []);

  /** Правило сработало: счёт в итогах и событие fault для ленты друзей. */
  function fire(rule) {
    const f = faults.get(rule.code) ?? { code: rule.code, text: rule.label, count: 0 };
    f.count += 1;
    faults.set(rule.code, f);
    bus?.emit('fault', { code: rule.code, text: rule.hint, joints: jointsOf(rule), label: rule.label });
  }

  const sight = createSight({ sideKeys: SIDE_KEYS, visible: SIDE_KEYS }, { holds, fire, feedback, armed: () => everPlank });

  const GATE_RULE = { code: GATE }; // «прими упор лёжа» до первой планки: подсказка без записи в ошибки

  function track(h, rule, cond, t) {
    const edge = h.update(rule.code, cond, t);
    if (edge === 'on' && rule !== GATE_RULE) fire(rule);
    else if (edge === 'off') feedback?.clear(rule.code);
  }

  function measure(lm, idx, aspect) {
    const m = pushupMeasure({ lm, idx, aspect, sm, cfg });
    const hip = lm[idx.hip];
    const knee = lm[idx.knee];
    const ankle = lm[idx.ankle];
    const shin = dist(knee, ankle, aspect);
    return {
      ...m,
      knee: sm('knee', angle(hip, knee, ankle, aspect)),
      kneeUp: sm('kneeUp', shin > 0 ? (knee.y - ankle.y) / shin : null),
    };
  }

  const aspectOf = (frame) => (frame.width > 0 && frame.height > 0 ? frame.width / frame.height : 1);

  function cheer() {
    if (!feedback) return;
    const shown = feedback.hint(PRAISE[praiseN % PRAISE.length], { code: 'praise', priority: 0, level: 'ok', speak: false, ttl: cfg.praiseTtlMs });
    if (shown) praiseN += 1;
  }

  function step(frame, t) {
    const dtRaw = lastT == null ? 0 : Math.max(0, t - lastT);
    const dt = Math.min(dtRaw, cfg.maxDtMs);
    k = alphaFor(lastT == null ? Infinity : dtRaw);
    lastT = t;
    const lm = frame.pose?.landmarks ?? null;
    const { pick, seen, reason } = sight.look(lm);
    sight.watch(seen, reason, t);

    let good = false;
    if (seen) {
      const m = measure(lm, pick.idx, aspectOf(frame));
      last = { lm, idx: pick.idx, side: pick.side, m };
      const plank = isPlank(m, cfg);
      inPlankMs = plank ? inPlankMs + dt : 0;
      if (inPlankMs >= cfg.standMs) everPlank = true;
      // На коленях таз низко из-за колен, а не из-за спины: тогда «таз провис» не пишем, говорим про колени
      const knees = plank && RULES.knees.test(m, cfg);
      const sag = plank && !knees && RULES.sag.test(m, cfg);
      const pike = plank && !knees && RULES.pike.test(m, cfg);
      track(holds, RULES.sag, sag, t);
      track(holds, RULES.pike, pike, t);
      track(kneeHolds, RULES.knees, knees, t);
      track(holds, RULES.left, everPlank && !plank, t);
      track(holds, GATE_RULE, !everPlank && !plank, t);
      good = plank && !sag && !pike && !knees && !holds.active(RULES.sag.code) && !holds.active(RULES.pike.code) && !kneeHolds.active(RULES.knees.code);
    } else {
      inPlankMs = 0;
    }

    counting = good;
    if (good) {
      c.count += dt / 1000;
      streakMs += dt;
      pauseMs = 0;
    } else {
      pauseMs += dt;
      if (pauseMs > cfg.gapMs) {
        streakMs = 0;
        praised = 0;
      }
    }
    bestMs = Math.max(bestMs, streakMs);
    const due = Math.floor(streakMs / (cfg.praiseSec * 1000));
    if (good && due > praised) {
      praised = due;
      cheer();
    }
  }

  /** Подсказка по кадру: видимость, потом ошибка планки, потом «прими упор лёжа» (разовые разводит feedback по приоритету). */
  function present() {
    if (sight.active) {
      sight.show();
      return;
    }
    const top = [RULES.left, RULES.knees, RULES.sag, RULES.pike].find((rule) => (rule === RULES.knees ? kneeHolds : holds).active(rule.code));
    if (top) {
      feedback?.hint(top.hint, { code: top.code, priority: PRIORITY.form, joints: jointsOf(top), level: 'warn', speak: true });
      return;
    }
    if (holds.active(GATE)) feedback?.hint(PUSHUP_GATES.plank.hint, { code: GATE, priority: PRIORITY.visibility, level: 'info', speak: true });
  }

  function report() {
    const m = last?.m ?? {};
    const num = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v ?? '·');
    debug.set('планка', `${c.count.toFixed(1)} с, подряд ${(streakMs / 1000).toFixed(1)} с, лучшая ${(bestMs / 1000).toFixed(1)} с, ${counting ? 'идёт' : 'пауза'}`);
    debug.set('сторона', last?.side ?? '·');
    debug.set('видимость', sight.active ? sight.rule.label : 'ок');
    debug.set('метрики', Object.entries(m).filter(([key]) => key !== 'angle').map(([key, v]) => `${key} ${num(v)}`).join(', '));
  }

  const c = {
    model: 'pose',
    unit: 'секунды',
    count: 0, // секунды в правильной планке (дробные; на экране целые)
    done: false,
    failed: false,
    lives: null,
    maxLives: null,

    start(t) {
      lastT = t;
    },

    frame(frame, t = frame.t) {
      if (stopped) return;
      step(frame, t);
      present();
      c.done = c.count >= challenge.target;
      if (debug?.enabled) report();
    },

    /**
     * «Встань в позицию» до отсчёта: те же условия, что пускают время. Без событий, подсказок и счёта,
     * прогревает только сглаживание метрик. У непройденной галочки hint: что сделать.
     */
    ready(frame, t = frame.t) {
      k = alphaFor(lastT == null ? Infinity : t - lastT);
      lastT = t;
      const lm = frame.pose?.landmarks ?? null;
      const { pick, seen, reason } = sight.look(lm);
      const m = seen ? measure(lm, pick.idx, aspectOf(frame)) : null;
      const checks = [
        { id: 'body', text: 'Всё тело в кадре', ok: seen, ...(seen ? {} : { hint: sight.hintFor(reason) }) },
        ...readyChecks(m, cfg).map(({ hint, ...check }) => (hint ? { ...check, hint } : check)),
      ];
      return { ok: checks.every((check) => check.ok), checks, hint: checks.find((check) => !check.ok)?.hint ?? null };
    },

    stop() {
      stopped = true;
    },

    summary() {
      return {
        faults: [...faults.values()].map((f) => ({ ...f })).sort((a, b) => b.count - a.count),
        rejected: [],
        extra: { bestHoldSec: Math.floor(bestMs / 1000), holdSec: Math.floor(c.count) },
      };
    },

    /** Скелет с красными суставами правила + дуга угла тела у таза (зелёная, пока время идёт). */
    draw(frame, draw) {
      const pose = frame.pose;
      if (!pose?.landmarks || frame.t - pose.t > VISION.staleMs) return;
      const highlight = feedback?.highlight ?? new Set();
      draw.pose(pose.landmarks, { highlight });
      if (!last || last.lm !== pose.landmarks || last.m.body == null) return;
      const { shoulder, hip, ankle } = last.idx;
      const tone = highlight.has(hip) ? 'bad' : counting ? 'deep' : 'idle';
      drawAngle(draw, pose.landmarks[shoulder], pose.landmarks[hip], pose.landmarks[ankle], last.m.body, tone, null, frame.t);
    },
  };
  return c;
}
