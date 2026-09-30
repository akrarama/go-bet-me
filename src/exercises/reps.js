// Общий движок повторов для приседаний и отжиманий. Владелец: блок 1 (Упражнения).
//
// Кадр → поза → видимость → поза для счёта (упор лёжа, стоя на полу) → угол сустава → EMA
// → гистерезис UP/DOWN → повтор. Считать начинаем только из верхней точки (угол > up).
// Режим «Ошибка»: у правила условие, порог, приоритет и текст «что не так + что сделать + число».
//   Правило по кадру (видимость, форма) срабатывает, когда условие держится
//   REPS.fault.minMs или minFrames кадров подряд (что наступит раньше), и отпускает через releaseMs.
//   Правило по движению (полуповтор, глубина) срабатывает в точке разворота угла:
//   угол ушёл от крайней точки на REPS.turnDeg. Темп проверяется в конце повтора.
// Перед отсчётом LIVE: ready(frame, t) → { ok, checks } проверяет положение теми же условиями (без счёта и подсказок).
// Подсказка одна, старшая по приоритету: видимость > форма > глубина > темп (очередь в feedback.js).
// Повтор, во время которого было активно правило формы, не засчитывается: событие
// rejected {code, text} и запись в summary().rejected. Полуповтор и мелкий присед тоже идут в этот лог.
//
// Чистая логика без DOM (тесты в jsc): feedback, bus и debug приходят снаружи.
// draw() рисует на переданном canvas-контексте и вызывается только в браузере.

import { REPS, VISION } from '../config.js';
import { pickSide } from '../vision/geometry.js';

/** Приоритет подсказок и причин незасчёта. */
export const PRIORITY = { visibility: 4, form: 3, depth: 2, tempo: 1 };

/** Правило видимости, общее для упражнений на повторы: счёт на паузе, пока тело не видно. */
export const VISIBILITY = {
  code: 'visibility',
  kind: 'visibility',
  label: 'не весь корпус в кадре',
  hint: 'Не весь корпус в кадре, отойди',
  joints: [],
};
export const NOBODY_HINT = 'Не вижу тебя, встань в кадр целиком';
const GATE = 'pose_gate'; // код подсказки «поза не для счёта»

/**
 * Почему тело не видно: подсказка называет то, чего не видно, а не «что-то не так».
 * У причины свой код для итогов (лог считает их отдельно); все коды visibility* боты читают как тему «корпус».
 * dark: ни одна нужная точка не видна уверенно (темно или свет в спину); окно за спиной делает из человека силуэт.
 */
export const SEEN_WHY = {
  nobody: { code: 'visibility_nobody', kind: 'visibility', label: 'никого в кадре', hint: NOBODY_HINT, joints: [] },
  legs: { code: 'visibility_legs', kind: 'visibility', label: 'не видно ног', hint: 'Не видно ног: отойди дальше или поставь камеру ниже', joints: [] },
  shoulders: { code: 'visibility_shoulders', kind: 'visibility', label: 'не видно плеч', hint: 'Не видно плеч: отойди или подними камеру', joints: [] },
  arms: { code: 'visibility_arms', kind: 'visibility', label: 'не видно рук', hint: 'Не видно рук: поставь камеру сбоку', joints: [] },
  dark: { code: 'visibility_dark', kind: 'visibility', label: 'плохо видно', hint: 'Плохо видно: добавь света или не стой спиной к окну', joints: [] },
  other: VISIBILITY,
};

/**
 * Что мешает видеть тело: ключ SEEN_WHY или null, если нужные суставы стороны idx видны (то же условие, что ставит счёт на паузу).
 * keys: нужные суставы (SIDE), например ['shoulder', 'hip', 'knee', 'ankle'].
 */
export function hiddenReason(lm, idx, keys) {
  const seen = keys.map((key) => [key, lm[idx[key]]?.visibility ?? 0]);
  const bad = seen.filter(([, v]) => v < REPS.minVisibility).map(([key]) => key);
  if (!bad.length) return null;
  if (Math.max(...seen.map(([, v]) => v)) < REPS.darkMaxVisibility) return 'dark';
  if (bad.includes('ankle') || bad.includes('knee')) return 'legs';
  if (bad.includes('shoulder')) return 'shoulders';
  if (bad.includes('wrist') || bad.includes('elbow')) return 'arms';
  return 'other';
}

/**
 * Коэффициент EMA для кадра длиной dt мс: alpha на кадр REPS.frameMs, при другой частоте
 * сглаживание по времени то же (на 15 fps кадр весит больше, на 60 fps меньше).
 */
export const alphaFor = (dt, alpha = REPS.emaAlpha) => (Number.isFinite(dt) ? 1 - (1 - alpha) ** (Math.max(0, dt) / REPS.frameMs) : 1);

/**
 * Угол → повторы: EMA, гистерезис UP/DOWN, темп, крайние углы, точки разворота.
 * Считать начинает, только когда верхняя точка (угол ≥ up) держится armMs: armed.
 * Так приземление после прыжка (ноги на миг прямые) или подъём с пола не становятся повтором.
 * update(raw, t) → события этого кадра (чаще пустой массив):
 *   start   ушёл из верхней зоны (угол < up): начался повтор
 *   down    UP → DOWN (угол < down)
 *   rep     DOWN → UP (угол > up): { min, max, downMs }, downMs = время от DOWN до UP
 *   top     вернулся наверх, не дойдя до DOWN: { min }
 *   valley  разворот снизу вверх: { angle, phase } angle = минимум, phase = фаза в этой точке
 *   peak    разворот сверху вниз: { angle, phase }
 */
export function createCounter({ down, up, alpha = REPS.emaAlpha, turn = REPS.turnDeg, armMs = REPS.armMs }) {
  const c = {
    angle: null,
    phase: 'UP',
    armed: false,
    armSince: null,
    moving: false, // вышли из верхней зоны: повтор идёт
    min: null,
    max: null,
    downAt: 0,
    trend: 1, // 1: угол растёт или стоит, -1: падает
    ext: null, // крайний угол с последнего разворота
    extPhase: 'UP',
    lastT: null,

    update(raw, t) {
      const ev = [];
      if (!Number.isFinite(raw)) return ev;
      const k = alphaFor(c.lastT == null ? Infinity : t - c.lastT, alpha);
      c.lastT = t;
      const a = (c.angle = c.angle == null ? raw : c.angle + k * (raw - c.angle));

      if (!c.armed) {
        if (a < up) {
          c.armSince = null;
          return ev;
        }
        c.armSince ??= t;
        if (t - c.armSince < armMs) return ev;
        c.armed = true;
        c.trend = 1;
        c.ext = a;
        c.extPhase = 'UP';
        return ev;
      }

      if (c.phase === 'UP' && !c.moving && a < up) {
        c.moving = true;
        c.min = c.max = a;
        ev.push({ type: 'start', t, angle: a });
      }
      if (c.moving) {
        c.min = Math.min(c.min, a);
        c.max = Math.max(c.max, a);
      }
      if (c.phase === 'UP' && a < down) {
        c.phase = 'DOWN';
        c.downAt = t;
        ev.push({ type: 'down', t, angle: a });
      } else if (c.phase === 'DOWN' && a > up) {
        c.phase = 'UP';
        c.moving = false;
        ev.push({ type: 'rep', t, min: c.min, max: c.max, downMs: t - c.downAt });
      } else if (c.phase === 'UP' && c.moving && a >= up) {
        c.moving = false;
        ev.push({ type: 'top', t, min: c.min });
      }

      if (c.trend > 0 ? a >= c.ext : a <= c.ext) {
        c.ext = a;
        c.extPhase = c.phase;
      } else if (Math.abs(a - c.ext) >= turn) {
        ev.push({ type: c.trend > 0 ? 'peak' : 'valley', t, angle: c.ext, phase: c.extPhase });
        c.trend = -c.trend;
        c.ext = a;
        c.extPhase = c.phase;
      }
      return ev;
    },

    /** Начать заново: без сглаживания и фазы, снова ждать верхнюю точку. */
    reset() {
      Object.assign(c, { angle: null, phase: 'UP', armed: false, armSince: null, moving: false, min: null, max: null, trend: 1, ext: null, extPhase: 'UP', lastT: null });
    },
  };
  return c;
}

/**
 * Условия по кадру с минимальной длительностью.
 * update(code, cond, t) → 'on' (сработало) | 'off' (отпустило) | null.
 * Срабатывает, когда условие держится minMs или minFrames кадров подряд (что раньше).
 * Отпускает, когда условия нет releaseMs (короткий провал не дробит одну ошибку на две).
 */
export function createHolds({ minMs = REPS.fault.minMs, minFrames = REPS.fault.minFrames, releaseMs = REPS.fault.releaseMs } = {}) {
  const map = new Map();
  const get = (code) => {
    let s = map.get(code);
    if (!s) map.set(code, (s = { frames: 0, since: 0, lastTrue: -Infinity, active: false, hot: false }));
    return s;
  };
  return {
    update(code, cond, t) {
      const s = get(code);
      let edge = null;
      if (cond) {
        if (s.frames === 0) s.since = t;
        s.frames += 1;
        s.lastTrue = t;
        if (!s.active && (s.frames >= minFrames || t - s.since >= minMs)) {
          s.active = true;
          edge = 'on';
        }
      } else {
        s.frames = 0;
        if (s.active && t - s.lastTrue >= releaseMs) {
          s.active = false;
          edge = 'off';
        }
      }
      s.hot = s.active && Boolean(cond);
      return edge;
    },
    /** Правило сработало и ещё не отпустило. */
    active: (code) => map.get(code)?.active ?? false,
    /** Сработало и условие выполнено на этом кадре. */
    hot: (code) => map.get(code)?.hot ?? false,
  };
}

const byCount = (list) => list.sort((a, b) => b.count - a.count);

/** «4 незасчитанных: 3 × недостаточная глубина, 1 × таз провис» из [{ text, count }]. */
export function describeRejected(reasons) {
  const total = reasons.reduce((s, r) => s + r.count, 0);
  if (!total) return '';
  const word = total % 10 === 1 && total % 100 !== 11 ? 'незасчитанный' : 'незасчитанных';
  return `${total} ${word}: ${reasons.map((r) => `${r.count} × ${r.text}`).join(', ')}`;
}

/**
 * Контроллер упражнения на повторы (контракт: CLAUDE.md, раздел 12; поля: squat.js).
 * def: {
 *   cfg                    пороги REPS.<тип>: down, up и пороги правил
 *   sideKeys, visible      суставы для выбора стороны и те, что обязаны быть видны
 *   angle: [a, b, c]       угол для счёта (в среднем суставе), по нему же дуга на экране
 *   measure({ lm, idx, aspect, sm, cfg, t }) → { angle, ...метрики }  sm(key, v): EMA метрики
 *   gate?(m, cfg) → null | { hint }  поза не для счёта (стоит вместо упора, прыгает): кадр не считается,
 *                          через REPS.gateResetFrames кадров начатый повтор сброшен, подсказка по удержанию
 *   rules: [{ code, kind: 'form', label, hint, joints, when?(m, cfg, counter), test(m, cfg, counter) }]
 *   turn?(ev, cfg) → { rule, value } | null   разворот угла: полуповтор или мало глубины
 *   missDelayMs?           разворот засчитывается ошибкой через столько мс, если поза не сломалась (прыжок)
 *   tempo?(ev, cfg) → { rule, value } | null  конец повтора: темп
 *   checks?: [{ id, text, hint, test(m, cfg) }]  положение до старта («Встань в позицию»): те же условия, что gate
 *                          отбрасывает кадр; text до 22 символов, hint: что сделать; «Всё тело в кадре» (body) добавляет ready сам
 * }
 * Правило: { code, kind, label (коротко, для итогов), hint (текст или (value, cfg) → текст), joints: ключи SIDE }.
 */
export function createRepController({ challenge, bus, feedback, debug }, def) {
  const { cfg } = def;
  const counter = createCounter({ down: cfg.down, up: cfg.up, armMs: cfg.armMs ?? REPS.armMs });
  const holds = createHolds();
  const faults = new Map(); // code → { code, text, count }
  const rejected = []; // { code, text, at, value? }
  const reps = []; // засчитанные: { min, downMs }
  const smooth = {};
  let k = 1; // EMA этого кадра
  const sm = (key, v) => (smooth[key] = v == null || !Number.isFinite(v) ? null : smooth[key] == null ? v : smooth[key] + k * (v - smooth[key]));
  let attempt = []; // правила формы, сработавшие в текущем повторе, по порядку
  let pending = []; // развороты-ошибки, ждут missDelayMs: { rule, value, reason, t, due }
  let why = 'other'; // причина, по которой тело не видно: ключ SEEN_WHY, по ней текст подсказки
  let whyNext = null; // новая причина ждёт, пока продержится REPS.fault.minMs (текст не мигает)
  let whySince = 0;
  let gateHint = null;
  let gateFrames = 0;
  let last = null; // последний кадр с видимым телом: { lm, idx, side, m }
  let lastT = null;
  let t0 = null;
  let stopped = false;
  let flash = null; // { t, ok }: вспышка у сустава, повтор засчитан или нет
  let seenTop = false; // человек хоть раз встал в верхнюю точку: до этого «не видно» не ошибка, а подготовка

  const jointsOf = (rule) => (last ? (rule.joints ?? []).map((key) => last.idx[key]).filter((i) => i != null) : []);
  const textOf = (rule, value) => (typeof rule.hint === 'function' ? rule.hint(value, cfg) : rule.hint);
  const hotForm = () => def.rules.filter((r) => r.kind === 'form' && holds.hot(r.code));

  /** Правило сработало: счёт в итогах и событие fault для ленты друзей. */
  function fire(rule, value) {
    const hint = textOf(rule, value);
    const joints = jointsOf(rule);
    const f = faults.get(rule.code) ?? { code: rule.code, text: rule.label, count: 0 };
    f.count += 1;
    faults.set(rule.code, f);
    const payload = { code: rule.code, text: hint, joints, label: rule.label };
    if (value != null) payload.value = Math.round(value);
    bus?.emit('fault', payload);
    return { hint, joints };
  }

  /** Разовая подсказка по движению (полуповтор, глубина, темп): уходит сама. */
  function once(rule, value) {
    const { hint, joints } = fire(rule, value);
    feedback?.hint(hint, { code: rule.code, priority: PRIORITY[rule.kind], joints, level: rule.level ?? 'warn', speak: true, ttl: REPS.fault.hintTtlMs });
  }

  function reject(rule, t, value) {
    const r = { code: rule.code, text: rule.label, at: Math.round((t - (t0 ?? t)) / 100) / 10 };
    if (value != null) r.value = Math.round(value);
    rejected.push(r);
    flash = { t, ok: false };
    bus?.emit('rejected', { ...r });
  }

  function track(rule, cond, t) {
    const edge = holds.update(rule.code, cond, t);
    if (edge === 'on') fire(rule);
    else if (edge === 'off') feedback?.clear(rule.code);
  }

  /**
   * Тело не видно: счёт на паузе, подсказка называет причину (SEEN_WHY). Пока подсказки нет, причина берётся сразу;
   * пока висит, новая причина заменяет текст, только когда держится minMs, и тогда считается ещё одной ошибкой.
   * «Не видно» до первой стойки (человек ещё занимает позицию) в ошибки не пишется.
   */
  function watchSeen(seen, reason, t) {
    const hanging = holds.active(VISIBILITY.code);
    let switched = false;
    if (reason != null) {
      if (!hanging || reason === why) {
        why = reason;
        whyNext = null;
      } else if (reason !== whyNext) {
        whyNext = reason;
        whySince = t;
      } else if (t - whySince >= REPS.fault.minMs) {
        why = reason;
        whyNext = null;
        switched = true;
      }
    }
    const edge = holds.update(VISIBILITY.code, !seen, t);
    if ((edge === 'on' || switched) && seenTop) fire(SEEN_WHY[why]);
    else if (edge === 'off') feedback?.clear(VISIBILITY.code);
  }

  /** Полуповтор или мелкий присед: ошибка, если за missDelayMs поза не сломалась (не было прыжка). */
  function commit(t) {
    while (pending.length && pending[0].due <= t) {
      const p = pending.shift();
      once(p.rule, p.value);
      if (p.reason) reject(p.reason, p.t);
      else reject(p.rule, p.t, p.value);
    }
  }

  function handle(ev, t) {
    if (ev.type === 'rep') {
      if (attempt.length) reject(attempt[0], t);
      else {
        c.count += 1;
        reps.push({ min: ev.min, downMs: ev.downMs });
        flash = { t, ok: true };
      }
      const slow = def.tempo?.(ev, cfg);
      if (slow) once(slow.rule, slow.value);
      attempt = [];
    } else if (ev.type === 'valley' || ev.type === 'peak') {
      const miss = def.turn?.(ev, cfg);
      if (!miss) return;
      pending.push({ rule: miss.rule, value: miss.value, reason: attempt[0] ?? null, t, due: t + (def.missDelayMs ?? 0) });
      attempt = hotForm();
    }
  }

  /**
   * Сторона тела и «видно ли всё нужное»: одно условие для счёта (пауза) и для ready (галочка «тело в кадре»).
   * reason: null, если видно, иначе ключ SEEN_WHY (нет позы вообще: nobody).
   */
  function look(lm) {
    const pick = lm ? pickSide(lm, def.sideKeys) : null;
    const reason = pick ? hiddenReason(lm, pick.idx, def.visible) : 'nobody';
    return { pick, seen: reason == null, reason };
  }

  const aspectOf = (frame) => (frame.width > 0 && frame.height > 0 ? frame.width / frame.height : 1);

  function step(frame, t) {
    k = alphaFor(lastT == null ? Infinity : t - lastT);
    lastT = t;
    const lm = frame.pose?.landmarks ?? null;
    const aspect = aspectOf(frame);
    const { pick, seen, reason } = look(lm);
    watchSeen(seen, reason, t);
    if (!seen) return; // счёт на паузе

    const m = def.measure({ lm, idx: pick.idx, aspect, sm, cfg, t });
    last = { lm, idx: pick.idx, side: pick.side, m };

    // Поза не для счёта: кадр пропускаем сразу, начатый повтор сбрасываем через пару кадров
    // (прыжок длится меньше, чем держится подсказка), подсказку показываем по удержанию.
    const bad = def.gate?.(m, cfg) ?? null;
    if (bad) gateHint = bad;
    if (holds.update(GATE, Boolean(bad), t) === 'off') feedback?.clear(GATE);
    if (bad) {
      gateFrames += 1;
      if (gateFrames === REPS.gateResetFrames) {
        counter.reset();
        attempt = [];
        pending = [];
      }
      return;
    }
    gateFrames = 0;

    const events = counter.update(m.angle, t);
    seenTop ||= counter.armed;
    if (events.some((e) => e.type === 'start')) attempt = [];
    for (const rule of def.rules) {
      const on = !rule.when || rule.when(m, cfg, counter);
      track(rule, on && rule.test(m, cfg, counter), t);
      if (rule.kind === 'form' && counter.moving && holds.hot(rule.code) && !attempt.includes(rule)) attempt.push(rule);
    }
    for (const ev of events) handle(ev, t);
    commit(t);
  }

  /** Подсказка по кадру: старшая из активных правил (разовые разводит feedback по приоритету). */
  function present() {
    if (holds.active(VISIBILITY.code)) {
      feedback?.hint(SEEN_WHY[why].hint, { code: VISIBILITY.code, priority: PRIORITY.visibility, level: 'warn', speak: true });
      return;
    }
    if (holds.active(GATE) && gateHint) {
      feedback?.hint(gateHint.hint, { code: GATE, priority: PRIORITY.visibility, level: 'info', speak: true });
      return;
    }
    let top = null;
    for (const rule of def.rules) if (holds.active(rule.code) && (!top || PRIORITY[rule.kind] > PRIORITY[top.kind])) top = rule;
    if (top) feedback?.hint(textOf(top), { code: top.code, priority: PRIORITY[top.kind], joints: jointsOf(top), level: 'warn', speak: true });
  }

  function report() {
    const m = last?.m ?? {};
    const num = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v ?? '·');
    const state = !counter.armed ? 'ждёт верх' : `${counter.phase}${counter.moving ? ' ↕' : ''}`;
    debug.set('угол', counter.angle == null ? '·' : `${Math.round(counter.angle)}° ${state}`);
    debug.set('сторона', last?.side ?? '·');
    debug.set('поза', gateFrames ? `не для счёта: ${gateHint?.hint}` : 'ок');
    debug.set('видимость', holds.active(VISIBILITY.code) ? SEEN_WHY[why].label : 'ок');
    debug.set('метрики', Object.entries(m).filter(([key]) => key !== 'angle').map(([key, v]) => `${key} ${num(v)}`).join(', '));
    debug.set('повтор', attempt.length ? `ошибка: ${attempt.map((r) => r.code).join(', ')}` : 'чисто');
  }

  const c = {
    model: 'pose',
    unit: 'повторы',
    count: 0,
    done: false,
    failed: false,
    lives: null,
    maxLives: null,
    counter,

    start(t) {
      t0 = t;
    },

    frame(frame, t = frame.t) {
      if (stopped) return;
      if (t0 == null) t0 = t;
      step(frame, t);
      present();
      c.done = c.count >= challenge.target;
      if (debug?.enabled) report();
    },

    /**
     * «Встань в позицию» до отсчёта (раздел 14.1): те же условия, что в счёте. «Всё тело в кадре»
     * (иначе счёт на паузе) и def.checks (кадр, который gate отбросил бы). Все ✓ = счёт пойдёт.
     * Чистая проверка: без событий, подсказок и счёта. Прогревается только сглаживание метрик,
     * линия пола и выбор «боком / лицом», чтобы первый кадр счёта не начинал с нуля.
     * Удержание галочек и отсчёт считает LIVE.
     * У непройденной галочки есть hint: что сделать («Не видно ног: отойди дальше или поставь камеру ниже»);
     * верхний hint = подсказка первой непройденной галочки, null, если все ✓.
     */
    ready(frame, t = frame.t) {
      k = alphaFor(lastT == null ? Infinity : t - lastT);
      lastT = t;
      const lm = frame.pose?.landmarks ?? null;
      const { pick, seen, reason } = look(lm);
      const m = seen ? def.measure({ lm, idx: pick.idx, aspect: aspectOf(frame), sm, cfg, t }) : null;
      const checks = [
        { id: 'body', text: 'Всё тело в кадре', ok: seen, ...(seen ? {} : { hint: SEEN_WHY[reason].hint }) },
        ...(def.checks ?? []).map(({ id, text, hint, test }) => {
          const ok = m != null && Boolean(test(m, cfg));
          return m != null && !ok && hint ? { id, text, ok, hint } : { id, text, ok };
        }),
      ];
      return { ok: checks.every((chk) => chk.ok), checks, hint: checks.find((chk) => !chk.ok)?.hint ?? null };
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
      const byReason = byCount([...reasons.values()]);
      const mins = reps.map((r) => r.min);
      return {
        faults: byCount([...faults.values()].map((f) => ({ ...f }))),
        rejected: rejected.map((r) => ({ ...r })),
        extra: {
          rejectedCount: rejected.length,
          rejectedByReason: byReason,
          rejectedText: describeRejected(byReason),
          deepestAngle: mins.length ? Math.round(Math.min(...mins)) : null,
          avgAngle: mins.length ? Math.round(mins.reduce((s, v) => s + v, 0) / mins.length) : null,
        },
      };
    },

    /** Скелет с красными суставами правила + дуга угла с числом градусов у рабочего сустава. */
    draw(frame, draw) {
      const pose = frame.pose;
      if (!pose?.landmarks || frame.t - pose.t > VISION.staleMs) return;
      const highlight = feedback?.highlight ?? new Set();
      draw.pose(pose.landmarks, { highlight });
      if (!last || last.lm !== pose.landmarks || counter.angle == null || gateFrames) return;
      const [a, b, cc] = def.angle.map((key) => last.idx[key]);
      const tone = highlight.has(b) ? 'bad' : counter.armed && counter.phase === 'DOWN' ? 'deep' : 'idle';
      drawAngle(draw, pose.landmarks[a], pose.landmarks[b], pose.landmarks[cc], counter.angle, tone, flash, frame.t);
    },
  };
  return c;
}

// ─── Дуга угла ──────────────────────────────────────────────────

const TONE = {
  idle: [255, 255, 255], // ещё не дошёл до низа
  deep: [212, 255, 58], // --accent: глубина есть
  bad: [255, 77, 79], // --danger: правило этого сустава
};
const rgba = ([r, g, b], a) => `rgba(${r}, ${g}, ${b}, ${a})`;
const FLASH_MS = 650;

function drawAngle(draw, pa, pb, pc, value, tone, flash, now) {
  const g = draw.ctx;
  const A = draw.project(pa);
  const B = draw.project(pb);
  const C = draw.project(pc);
  const a1 = Math.atan2(A.y - B.y, A.x - B.x);
  let sweep = Math.atan2(C.y - B.y, C.x - B.x) - a1;
  if (sweep > Math.PI) sweep -= 2 * Math.PI;
  if (sweep < -Math.PI) sweep += 2 * Math.PI;
  const limb = Math.min(Math.hypot(A.x - B.x, A.y - B.y), Math.hypot(C.x - B.x, C.y - B.y));
  const r = Math.max(20, Math.min(56, limb * 0.34));
  const col = TONE[tone] ?? TONE.idle;

  g.save();
  g.beginPath();
  g.moveTo(B.x, B.y);
  g.arc(B.x, B.y, r, a1, a1 + sweep, sweep < 0);
  g.closePath();
  g.fillStyle = rgba(col, tone === 'idle' ? 0.12 : 0.22);
  g.fill();

  g.beginPath();
  g.arc(B.x, B.y, r, a1, a1 + sweep, sweep < 0);
  g.lineCap = 'round';
  g.lineWidth = 3;
  g.strokeStyle = rgba(col, 0.95);
  g.shadowColor = 'rgba(0, 0, 0, 0.45)';
  g.shadowBlur = 6;
  g.stroke();

  if (flash && now - flash.t < FLASH_MS) {
    const p = (now - flash.t) / FLASH_MS;
    g.beginPath();
    g.arc(B.x, B.y, r + 6 + 34 * (1 - (1 - p) ** 3), 0, Math.PI * 2);
    g.lineWidth = 4 * (1 - p) + 1;
    g.strokeStyle = rgba(flash.ok ? TONE.deep : TONE.bad, 0.85 * (1 - p));
    g.shadowBlur = 0;
    g.stroke();
  }

  // число снаружи угла, по биссектрисе в обратную сторону: не закрывает руку или ногу
  const mid = a1 + sweep / 2;
  const label = `${Math.round(value)}°`;
  g.font = '800 17px Manrope, system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const w = g.measureText(label).width + 18;
  const h = 28;
  const x = B.x - Math.cos(mid) * (r + 24);
  const y = B.y - Math.sin(mid) * (r + 24);
  g.shadowColor = 'rgba(0, 0, 0, 0.35)';
  g.shadowBlur = 10;
  g.fillStyle = 'rgba(10, 10, 12, 0.72)';
  g.beginPath();
  if (g.roundRect) g.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
  else g.rect(x - w / 2, y - h / 2, w, h);
  g.fill();
  g.shadowBlur = 0;
  g.fillStyle = tone === 'idle' ? '#f5f5f7' : rgba(col, 1);
  g.fillText(label, x, y + 1);
  g.restore();
}
