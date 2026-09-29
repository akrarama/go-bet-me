// Приседания. Владелец: блок 1 (Упражнения).
// Счёт по углу колена таз-колено-щиколотка: UP и угол < 100 → DOWN, DOWN и угол > 160 → повтор.
// Считаем только стоя на полу: плечи над тазом, щиколотки не выше своей линии пола.
// Прыжок сразу сбрасывает начатый повтор, новый начинается только из стойки:
// прыжки и приземление в присед не считаются.
// Режим «Ошибка» (раздел 6 спеки, пороги в config.REPS.squat), камера сбоку:
//   форма (повтор не засчитывается): колени за носки, наклон спины в нижней точке;
//   глубина (в лог незасчитанных): присел только до 100..140°, не встал до конца.
// Движок повторов, видимость и подсказки: reps.js.
//
// Контракт контроллера (его читает screens/live.js):
//   model: 'pose'            какая модель нужна
//   unit: 'повторы'          подпись счётчика
//   count                    число на большом счётчике (для медитации секунды, можно дробные)
//   done / failed            цель выполнена / провал раньше времени
//   lives, maxLives          жизни (null, если не нужны)
//   start(t)                 старт после отсчёта
//   frame(frame, t)          кадр, где frame.ran === model
//   stop()                   уход с экрана (необязательно)
//   summary() → { faults: [{ code, text, count }], rejected: [{ code, text, at }], extra }
//   draw(frame, draw)        своя отрисовка поверх видео (необязательно)

import { REPS } from '../config.js';
import { POSE, angle, dist, tiltFromVertical } from '../vision/geometry.js';
import { createRepController } from './reps.js';

export const RULES = {
  // Пример жюри. Направление лица = знак(носок.x − щиколотка.x);
  // колено дальше носка в эту сторону больше чем на 0.15 длины голени.
  kneesOverToes: {
    code: 'knees_over_toes',
    kind: 'form',
    label: 'колени за носками',
    hint: 'Колени выходят за носки, сядь глубже назад',
    joints: ['knee', 'ankle', 'toe'],
    test: (m, cfg) => m.kneeOver != null && m.kneeOver > cfg.kneeOverToeShin,
  },
  // Угол вектора плечо-таз к вертикали больше 45° в нижней точке
  lean: {
    code: 'torso_lean',
    kind: 'form',
    label: 'наклон спины вперёд',
    hint: 'Спина наклоняется вперёд, держи грудь, смотри перед собой',
    joints: ['shoulder', 'hip'],
    when: (m, cfg, counter) => counter.angle != null && counter.angle <= cfg.down + cfg.bottomZoneDeg,
    test: (m, cfg) => m.lean != null && m.lean > cfg.torsoLeanMax,
  },
  // Минимальный угол колена за повтор 100..140
  shallow: {
    code: 'squat_shallow',
    kind: 'depth',
    label: 'недостаточная глубина',
    hint: 'Недостаточная глубина: бедро выше колена, присядь ниже',
    joints: ['knee'],
  },
  // Из DOWN не дошёл до 160 и снова пошёл вниз
  halfUp: {
    code: 'squat_half_up',
    kind: 'depth',
    label: 'не встал до конца',
    hint: 'Встань до конца, выпрями колени',
    joints: ['knee'],
  },
};

/** Поза не для счёта. */
export const GATES = {
  jump: { hint: 'Прыжки не в счёт, приседай, не отрывая стопы от пола' },
  stand: { hint: 'Встань прямо, боком к камере' },
};

/**
 * Линия пола по щиколоткам (y растёт вниз, пол = самое низкое положение стоп).
 * update(y, t) → на сколько стопы выше пола (доля высоты кадра, 0 = на полу).
 * Ниже пола: линия сразу переезжает. Чуть выше (меньше jumpRise): плавно подстраивается.
 * Выше дольше floorResetMs: это не прыжок (отошёл от камеры), линия переезжает.
 */
export function createFloor(cfg = REPS.squat) {
  let base = null;
  let upSince = null;
  let lastT = null;
  return {
    update(y, t) {
      const dt = lastT == null ? 0 : t - lastT;
      lastT = t;
      if (base == null || y >= base) {
        base = y;
        upSince = null;
        return 0;
      }
      const rise = base - y;
      if (rise <= cfg.jumpRise) {
        base -= rise * Math.min(1, dt / cfg.floorDriftMs);
        upSince = null;
        return rise;
      }
      upSince ??= t;
      if (t - upSince > cfg.floorResetMs) {
        base = y;
        upSince = null;
        return 0;
      }
      return rise;
    },
    get base() {
      return base;
    },
  };
}

/** Самая низкая из видимых щиколоток (обе ноги в воздухе = прыжок). */
function feetY(lm, idx) {
  const ys = [POSE.leftAnkle, POSE.rightAnkle].filter((i) => (lm[i]?.visibility ?? 0) >= 0.3).map((i) => lm[i].y);
  return ys.length ? Math.max(...ys) : lm[idx.ankle].y;
}

/** Метрики кадра (сторона idx уже выбрана и видна). */
export function measure({ lm, idx, aspect, sm, cfg = REPS.squat }) {
  const shoulder = lm[idx.shoulder];
  const hip = lm[idx.hip];
  const knee = lm[idx.knee];
  const ankle = lm[idx.ankle];
  const toe = lm[idx.toe];
  const shin = dist(knee, ankle, aspect);
  const foot = (toe.x - ankle.x) * aspect;
  // правило про носки имеет смысл только сбоку: стопа видна и заметно смотрит вбок
  const sideOn = (toe.visibility ?? 0) >= REPS.minVisibility && shin > 0 && Math.abs(foot) >= cfg.sideFootMin * shin;
  const lean = sm('lean', tiltFromVertical(hip, shoulder, aspect));
  return {
    angle: angle(hip, knee, ankle, aspect),
    kneeOver: sm('kneeOver', sideOn ? ((knee.x - toe.x) * aspect * Math.sign(foot)) / shin : null),
    lean,
    upright: shoulder.y < hip.y && lean < cfg.uprightMaxLean,
  };
}

export function createController(deps) {
  const cfg = REPS.squat;
  const floor = createFloor(cfg);
  return createRepController(deps, {
    cfg,
    sideKeys: ['shoulder', 'hip', 'knee', 'ankle'],
    visible: ['shoulder', 'hip', 'knee', 'ankle'],
    angle: ['hip', 'knee', 'ankle'],
    measure: (a) => ({ ...measure(a), rise: floor.update(feetY(a.lm, a.idx), a.t) }),
    gate: (m) => (m.rise > cfg.jumpRise ? GATES.jump : m.upright ? null : GATES.stand),
    rules: [RULES.kneesOverToes, RULES.lean],
    missDelayMs: cfg.missDelayMs,
    turn(ev) {
      if (ev.type === 'valley' && ev.phase === 'UP' && ev.angle >= cfg.down && ev.angle <= cfg.shallowFrom) return { rule: RULES.shallow, value: ev.angle };
      if (ev.type === 'peak' && ev.phase === 'DOWN' && ev.angle >= cfg.halfUpFrom && ev.angle < cfg.up) return { rule: RULES.halfUp, value: ev.angle };
      return null;
    },
  });
}
