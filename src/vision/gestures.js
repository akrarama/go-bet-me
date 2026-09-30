// Жесты и «рука вверх» → события шины. Владелец: блок 2 (Жесты).
//
// Шлёт в шину:
//   gesture {name}           Thumb_Up | Thumb_Down | Open_Palm | Pointing_Up (GESTURES.names).
//                            Жест держится GESTURES.holdMs → одно событие за показ,
//                            между событиями не меньше GESTURES.cooldownMs.
//   handup  {side}           запястье выше носа GESTURES.handUpMs, side: 'left' | 'right' (сторона тела).
//                            Нужна поза: экран включает модель 'pose' (например ['gesture', 'pose']).
//   cursor  {x, y, visible}  кончик указательного пальца (точка руки 8) в CSS px экрана.
//                            Рука пропала или модель жестов не работает → один {visible: false}.
//
// Экранам (только читать, обновляется каждый кадр):
//   gestures.current   стабильный жест ('None', когда руки нет)
//   gestures.pending   { name, progress 0..1 }: жест, который сейчас набирает удержание, или null
//   gestures.latched   жест, который держат, но он уже сработал или пришёл с прошлого экрана, или null
//   gestures.arms      { left, right }: состояние рук (ArmState, см. createHandUpTracker)
//   gestures.bestArm   рука, которая ближе к срабатыванию (null, пока позы не было)
//   gestures.poseSeen  в последнем кадре позы (не старше 500 мс) есть человек
//
// Смена экрана (событие state): жест, который держат сейчас, и поднятая рука не сработают,
// пока их не уберут и не покажут снова (latch). Так 👍 из IDLE не проскакивает через SETUP.
//
// Зеркало и стороны:
// - Кадр камеры НЕ зеркальный, зеркалится только показ (draw.project это учитывает).
// - PoseLandmarker размечает стороны тела по незеркальному кадру: 11/13/15 это левые плечо,
//   локоть и запястье ЧЕЛОВЕКА. На зеркальном экране его левая рука видна слева.
// - handedness у GestureRecognizer считается так, будто кадр зеркальный, поэтому у нас он
//   перевёрнут («Left» = правая рука). Для заданий его не используем: стороны берём из позы.

import { GESTURES } from '../config.js';

const NONE = 'None';
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ─── Удержание жеста ────────────────────────────────────────────

/**
 * Удержание + пауза между срабатываниями + «один раз за показ» + терпимость к миганию + latch.
 * gate.update(name, score, t) → имя жеста, сработавшего на этом кадре, или null (t в мс).
 * gate.current   стабильный кандидат ('None', когда руки нет)
 * gate.pending(t) → { name, progress } | null: жест, который может сработать и набирает удержание
 * gate.held      кандидат, который держат, но он уже сработал или заблокирован latch(), или null
 * gate.latch()   смена экрана: жест, который держат сейчас, не сработает, пока его не уберут
 */
export function createGestureGate(opts = GESTURES) {
  let cand; // стабильный кандидат
  let since; // с какого кадра его держат
  let seen; // когда его видели последний раз
  let alt; // { name, since }: другой жест, который пытается сменить кандидата
  let done; // кандидат уже сработал (или заблокирован latch) до смены кандидата
  let lastFire;
  let lastRaw;
  const fireable = (name) => opts.names.includes(name);

  const gate = {
    get current() {
      return cand;
    },

    get held() {
      return done && lastRaw === cand && fireable(cand) ? cand : null;
    },

    update(rawName, score, t) {
      // уже сработавший (или пришедший с прошлого экрана) жест держим и на просадке уверенности до minScore / 2:
      // иначе короткий провал уверенности снимал бы latch, и 👍 срабатывал бы снова на следующем экране
      const keep = done && rawName === cand && score >= opts.minScore / 2;
      const raw = rawName && (score >= opts.minScore || keep) ? rawName : NONE;
      lastRaw = raw;
      if (raw === cand) {
        seen = t;
        alt = null;
      } else {
        if (!alt || alt.name !== raw) alt = { name: raw, since: t };
        // 1-2 пропущенных или неверных кадра не сбрасывают удержание и не взводят жест заново
        if (t - seen > opts.dropMs) {
          cand = raw;
          since = alt.since; // удержание нового жеста считается с его первого кадра
          seen = t;
          alt = null;
          done = false;
        }
      }
      // срабатывает только на кадре, где жест реально виден
      if (raw !== cand || done || !fireable(cand)) return null;
      if (t - since < opts.holdMs || t - lastFire < opts.cooldownMs) return null;
      done = true;
      lastFire = t;
      return cand;
    },

    pending(t) {
      if (!done && fireable(cand)) {
        // на пропущенном кадре прогресс замирает (удержание при этом не сбрасывается)
        const until = lastRaw === cand ? t : seen;
        return { name: cand, progress: clamp01((until - since) / opts.holdMs) };
      }
      if (alt && fireable(alt.name)) return { name: alt.name, progress: clamp01((t - alt.since) / opts.holdMs) };
      return null;
    },

    latch() {
      if (cand !== NONE) done = true;
    },

    reset() {
      cand = NONE;
      since = 0;
      seen = -Infinity;
      alt = null;
      done = false;
      lastFire = -Infinity;
      lastRaw = NONE;
    },
  };
  gate.reset();
  return gate;
}

// ─── Рука над головой ───────────────────────────────────────────

const SIDES = ['left', 'right'];
const NOSE = 0;
const ARM = { left: { elbow: 13, wrist: 15 }, right: { elbow: 14, wrist: 16 } };
const OTHER = { left: 'right', right: 'left' };

const blankArm = (side) => ({
  side,
  visible: false, // запястье и нос видны в последнем кадре позы
  up: false, // запястье выше носа (гистерезис + терпимость к пропускам)
  armed: true, // рука была внизу после последнего latch()
  progress: 0, // 0..1 до срабатывания; 1 после, пока рука вверху
  fired: false, // handup уже отправлен за этот подъём
  low: false, // рука поднята, но не выше головы (запястье выше локтя)
  lowMs: 0,
  out: false, // локоть выше носа, а запястья не видно: кисть вне кадра
  outMs: 0,
  wrist: null, // последняя видимая точка запястья {x, y} (нормализованная), для отрисовки
  t: 0, // время последнего кадра позы
});

const blankTiming = () => ({
  upSince: 0,
  upSeen: -Infinity,
  lowSince: 0,
  lowSeen: -Infinity,
  outSince: 0,
  outSeen: -Infinity,
  wristSeen: -Infinity,
  withOther: false, // сработала, когда вторая рука тоже была поднята
});

/**
 * Рука выше головы, по сторонам тела (левая = 11/13/15, правая = 12/14/16, нос = 0).
 * tracker.update(landmarks | null, t) → ['left' | 'right']: стороны, где handup сработал на этом кадре
 * tracker.tick(t)   между кадрами позы: плавный прогресс, устаревшее состояние сбрасывается
 * tracker.left, tracker.right → ArmState (поля в blankArm)
 * tracker.best() → ArmState | null: у кого прогресс больше; при равенстве up > low > out > левая
 * tracker.latch()   смена экрана: поднятая рука сработает только после того, как её опустят
 */
export function createHandUpTracker(opts = GESTURES) {
  const arms = { left: blankArm('left'), right: blankArm('right') };
  const tm = { left: blankTiming(), right: blankTiming() };
  let lastT = null;
  let everSeen = false;
  let stale = false; // модель позы замолчала, состояние уже сброшено

  const point = (lm, i) => {
    const p = lm?.[i];
    return p && (p.visibility ?? 0) >= opts.minVisibility ? p : null;
  };

  function progressAt(a, m, now) {
    if (!a.up || !a.armed) return 0;
    if (a.fired) return 1;
    // на пропущенном кадре прогресс замирает, дальше идёт от момента, когда руку видели
    const until = m.upSeen >= a.t ? now : m.upSeen;
    return clamp01((until - m.upSince) / opts.handUpMs);
  }

  /** Модель позы не работала: подъём, «низко» и «вне кадра» начинаются заново. */
  function expire() {
    for (const s of SIDES) {
      const a = arms[s];
      const armed = a.armed;
      Object.assign(a, blankArm(s), { armed, t: a.t });
      tm[s] = blankTiming();
    }
  }

  function step(a, m, lm, t) {
    const idx = ARM[a.side];
    const nose = point(lm, NOSE);
    const wrist = point(lm, idx.wrist);
    const elbow = point(lm, idx.elbow);
    a.t = t;
    a.visible = !!(nose && wrist);
    if (wrist) {
      a.wrist = { x: wrist.x, y: wrist.y };
      m.wristSeen = t;
    } else if (t - m.wristSeen > opts.handDropMs) a.wrist = null;

    // вверх: запястье выше носа; опущена, когда ниже носа на handReleaseY (без дрожания на границе)
    const upNow = a.visible && wrist.y < nose.y + (a.up ? opts.handReleaseY : 0);
    if (upNow) {
      m.upSeen = t;
      if (!a.up) {
        a.up = true;
        m.upSince = t;
      }
    } else if (!a.up || t - m.upSeen > opts.handDropMs) {
      a.up = false;
      a.fired = false;
      a.armed = true;
      m.withOther = false;
    }

    const lowNow = !a.up && !!(wrist && elbow) && wrist.y < elbow.y;
    if (lowNow) {
      m.lowSeen = t;
      if (!a.low) {
        a.low = true;
        m.lowSince = t;
      }
    } else if (a.up || t - m.lowSeen > opts.handDropMs) a.low = false;
    a.lowMs = a.low ? t - m.lowSince : 0;

    const outNow = !wrist && !!(elbow && nose) && elbow.y < nose.y;
    if (outNow) {
      m.outSeen = t;
      if (!a.out) {
        a.out = true;
        m.outSince = t;
      }
    } else if (wrist || t - m.outSeen > opts.handDropMs) a.out = false;
    a.outMs = a.out ? t - m.outSince : 0;

    return upNow;
  }

  const tracker = {
    left: arms.left,
    right: arms.right,

    update(landmarks, t) {
      if (lastT !== null && t - lastT > opts.handDropMs && !stale) expire();
      lastT = t;
      stale = false;
      if (landmarks) everSeen = true;
      const seenUp = { left: step(arms.left, tm.left, landmarks, t), right: step(arms.right, tm.right, landmarks, t) };
      const fired = [];
      for (const s of SIDES) {
        const a = arms[s];
        const m = tm[s];
        const other = arms[OTHER[s]];
        if (!seenUp[s] || !a.armed) continue;
        if (!a.fired && t - m.upSince >= opts.handUpMs) {
          a.fired = true;
          m.withOther = other.up;
          fired.push(s);
        } else if (a.fired && m.withOther && !other.up) {
          // были подняты обе, вторую опустили: эта рука теперь поднята одна, сообщаем ещё раз
          m.withOther = false;
          fired.push(s);
        }
      }
      for (const s of SIDES) arms[s].progress = progressAt(arms[s], tm[s], t);
      return fired;
    },

    tick(t) {
      if (lastT === null) return;
      if (t - lastT > opts.handDropMs) {
        if (!stale) expire();
        stale = true;
        return;
      }
      for (const s of SIDES) arms[s].progress = progressAt(arms[s], tm[s], t);
    },

    best() {
      if (!everSeen) return null;
      const L = arms.left;
      const R = arms.right;
      if (L.progress !== R.progress) return L.progress > R.progress ? L : R;
      if (L.up !== R.up) return L.up ? L : R;
      if (L.low !== R.low) return L.low ? L : R;
      if (L.out !== R.out) return L.out ? L : R;
      return L;
    },

    latch() {
      for (const s of SIDES) {
        arms[s].armed = false;
        arms[s].progress = 0;
      }
    },

    reset() {
      for (const s of SIDES) {
        Object.assign(arms[s], blankArm(s));
        tm[s] = blankTiming();
      }
      lastT = null;
      everSeen = false;
      stale = false;
    },
  };
  return tracker;
}

// ─── Проверка «вживую» (LIVENESS) ───────────────────────────────

/** Тексты заданий: один источник для экрана LIVENESS и баннера в LOBBY. */
export const LIVENESS_TEXT = {
  Thumb_Up: { icon: '👍', title: 'Покажи 👍', say: 'Покажи большой палец вверх', fail: 'не увидели 👍' },
  Open_Palm: { icon: '🖐', title: 'Покажи открытую ладонь', say: 'Покажи открытую ладонь', fail: 'не увидели открытую ладонь' },
  left_hand_up: { icon: '✋', title: 'Подними левую руку', say: 'Подними левую руку над головой', fail: 'не увидели левую руку над головой', side: 'left' },
  right_hand_up: { icon: '✋', title: 'Подними правую руку', say: 'Подними правую руку над головой', fail: 'не увидели правую руку над головой', side: 'right' },
};

const LABEL = { Thumb_Up: 'большой палец вверх', Thumb_Down: 'палец вниз', Open_Palm: 'открытую ладонь', Pointing_Up: 'указательный палец' };
const SIDE_WORD = { left: 'левую', right: 'правую' };
const SIDE_NAME = { left: 'левая', right: 'правая' };

/** Случайное задание, не повторяет предыдущее (если есть из чего выбрать). rnd() → 0..1. */
export function pickLivenessTask(tasks = GESTURES.livenessTasks, prev = null, rnd = Math.random) {
  const pool = tasks.length > 1 ? tasks.filter((task) => task !== prev) : tasks;
  const list = pool.length ? pool : tasks;
  return list[Math.min(list.length - 1, Math.floor(rnd() * list.length))];
}

/**
 * Задание для LIVENESS: не тот жест, что человек уже держит (held = gestures.current).
 * Его заблокировал latch при смене экрана, и держать его дальше бесполезно: засчитан не будет.
 */
export function livenessTaskFor(held, prev = null, tasks = GESTURES.livenessTasks, rnd = Math.random) {
  return pickLivenessTask(tasks.filter((task) => task !== held), prev, rnd);
}

/**
 * Судья задания. Verdict = { result: 'pass' | 'fail' | null, hint: string | null }.
 * judge.onGesture(name, t), judge.onHandUp(side, t, { otherUp }), judge.tick(t) → Verdict
 * judge.left(t) → секунд осталось; judge.done: null | 'pass' | 'fail' (после него всё молчит).
 * Провал только из tick(): так экран ловит его в одном месте.
 */
export function createLivenessJudge(task, { t0 = 0, sec = GESTURES.livenessSec } = {}) {
  const side = LIVENESS_TEXT[task]?.side ?? null; // задание на руку
  const limitMs = sec * 1000;
  const QUIET = { result: null, hint: null };
  const hint = (text) => ({ result: null, hint: text });
  const finish = (result) => {
    judge.done = result;
    return { result, hint: null };
  };
  const over = (t) => judge.done !== null || t - t0 >= limitMs;

  const judge = {
    task,
    done: null,

    onGesture(name, t) {
      if (over(t) || side) return QUIET;
      if (name === task) return finish('pass');
      if (GESTURES.names.includes(name)) return hint(`Не тот жест. Покажи ${LABEL[task] ?? task}`);
      return QUIET;
    },

    onHandUp(upSide, t, { otherUp = false } = {}) {
      if (over(t) || !side || (upSide !== 'left' && upSide !== 'right')) return QUIET;
      const only = `Подними только ${SIDE_WORD[side]} руку`;
      if (upSide === side) return otherUp ? hint(only) : finish('pass');
      // подняли не ту руку; если нужная тоже вверху, значит подняты обе
      if (otherUp) return hint(only);
      const other = SIDE_NAME[upSide];
      return hint(`Это ${other} рука. Подними ${SIDE_WORD[side]}`);
    },

    tick(t) {
      if (judge.done !== null) return QUIET;
      return t - t0 >= limitMs ? finish('fail') : QUIET;
    },

    left(t) {
      return Math.max(0, (limitMs - (t - t0)) / 1000);
    },
  };
  return judge;
}

// ─── Подключение к кадрам и шине (браузер) ──────────────────────

const STALE_MS = GESTURES.cursorGraceMs + 150; // результат жестов старше этого: модель жестов не работает
const POSE_SEEN_MS = 500;

const gate = createGestureGate();
const tracker = createHandUpTracker();
let bus = null;
let draw = null;
let debug = null;
let cursorShown = false;

export const gestures = {
  current: NONE,
  pending: null,
  latched: null,
  arms: { left: tracker.left, right: tracker.right },
  bestArm: null,
  poseSeen: false,

  /** Один раз из main.js, когда модели готовы. */
  start(ctx) {
    if (bus) return;
    ({ bus, draw, debug } = ctx);
    ctx.vision.onFrame(onFrame);
    // не ctx.on: такие подписки снимаются при каждой смене экрана
    bus.on('state', () => {
      gate.latch();
      tracker.latch();
      gestures.pending = null;
    });
    debug.key('j', () => bus.emit('handup', { side: 'left', source: 'debug' }), 'рука над головой: левая');
  },
};

function hideCursor() {
  cursorShown = false;
  bus.emit('cursor', { visible: false });
}

function onHands(hand, t) {
  const fired = gate.update(hand?.gesture ?? NONE, hand?.score ?? 0, t);
  if (fired) bus.emit('gesture', { name: fired });
  const tip = hand?.landmarks?.[8];
  if (tip) {
    const { x, y } = draw.project(tip);
    cursorShown = true;
    bus.emit('cursor', { x, y, visible: true });
  } else if (cursorShown) hideCursor();
}

function onFrame(frame) {
  const t = frame.t;
  if (frame.ran === 'gesture' && frame.gesture) onHands(frame.gesture.hands?.[0] ?? null, t);
  if (frame.ran === 'pose') {
    for (const side of tracker.update(frame.pose?.landmarks ?? null, t)) bus.emit('handup', { side });
  } else tracker.tick(t);

  // в LIVE модель жестов не работает: курсор прячем, жесты не показываем
  const fresh = !!frame.gesture && t - frame.gesture.t <= STALE_MS;
  if (!fresh && cursorShown) hideCursor();
  gestures.current = fresh ? gate.current : NONE;
  gestures.pending = fresh ? gate.pending(t) : null;
  gestures.latched = fresh ? gate.held : null;
  gestures.bestArm = tracker.best();
  gestures.poseSeen = !!frame.pose?.landmarks && t - frame.pose.t <= POSE_SEEN_MS;
  if (debug.enabled) showDebug();
}

function armText(a) {
  const name = a.side === 'left' ? 'Л' : 'П';
  if (a.up && !a.armed) return `${name} опусти`;
  if (a.up) return `${name} ↑${Math.round(a.progress * 100)}%${a.fired ? ' ✓' : ''}`;
  if (a.low) return `${name} низко ${(a.lowMs / 1000).toFixed(1)}с`;
  if (a.out) return `${name} вне кадра ${(a.outMs / 1000).toFixed(1)}с`;
  return `${name} ${a.visible ? '·' : '—'}`;
}

function showDebug() {
  const p = gestures.pending;
  debug.set('жест', `${gestures.current}${p ? ` → ${p.name} ${Math.round(p.progress * 100)}%` : ''}${gestures.latched ? ' (держат)' : ''}`);
  debug.set('рука', gestures.poseSeen ? `${armText(tracker.left)} | ${armText(tracker.right)}` : 'нет позы');
}
