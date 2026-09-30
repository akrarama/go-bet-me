// Отжимания на брусьях. Контракт контроллера: см. squat.js, движок повторов: reps.js.
// Камера сбоку. Ноги не нужны: на брусьях их поджимают и они часто за кадром.
// Счёт по углу локтя плечо-локоть-запястье: упор на прямых руках (угол > up) → вниз (угол < down) → вверх = повтор.
// Считаем только в упоре: кисти ниже плеч и корпус ближе к вертикали, чем к горизонтали (не упор лёжа на полу).
// Режим «Ошибка» (пороги в config.REPS.dips, калибровка по ролику fixtures/dips-side: внизу 92..110°, вверху 146..166°,
// наклон корпуса 15..27°, максимум 43°):
//   форма (повтор не засчитывается): корпус сильно завален вперёд;
//   глубина: не опустился (разворот на 110..130°), не выжал до прямых рук (разворот вверху 125..145°);
//   темп: вниз-вверх быстрее 400 мс.

import { REPS } from '../config.js';
import { angle, tiltFromVertical } from '../vision/geometry.js';
import { createRepController, PRAISE, SIDE_CHECK } from './reps.js';

const deg = (v) => `${Math.round(v)}°`;

export const RULES = {
  lean: {
    code: 'dips_lean',
    kind: 'form',
    label: 'корпус завален вперёд',
    hint: 'Корпус сильно завален вперёд, держи грудь выше',
    joints: ['shoulder', 'hip'],
    test: (m, cfg) => m.lean != null && m.lean > cfg.leanMax,
  },
  halfDown: {
    code: 'dips_half_down',
    kind: 'depth',
    label: 'недостаточная глубина',
    hint: (v, cfg) => `Опускайся ниже: локоть ${deg(v)}, нужно меньше ${deg(cfg.down)}`,
    joints: ['elbow'],
  },
  halfUp: {
    code: 'dips_half_up',
    kind: 'depth',
    label: 'не выпрямил руки',
    hint: (v, cfg) => `Выжимай до прямых рук: локоть ${deg(v)}, нужно больше ${deg(cfg.up)}`,
    joints: ['elbow'],
  },
  tempo: {
    code: 'dips_tempo',
    kind: 'tempo',
    level: 'info',
    label: 'слишком быстро',
    hint: 'Слишком быстро, опускайся подконтрольно',
    joints: [],
  },
};

export const GATES = {
  support: { hint: 'Встань в упор на брусьях: руки прямые, корпус вертикально, боком к камере' },
};

/** Упор на брусьях: кисти ниже плеч, корпус не лежит (иначе это упор лёжа). */
export const isSupport = (m, cfg) => m.handsBelow && m.lean != null && m.lean < cfg.supportMaxLean;
export const CHECKS = [{ id: 'support', text: 'Упор на брусьях', hint: GATES.support.hint, test: isSupport }, SIDE_CHECK];

/** Метрики кадра (сторона idx уже выбрана и видна). lean: наклон таз→плечо к вертикали, градусы. */
export function measure({ lm, idx, aspect, sm, cfg = REPS.dips }) {
  const shoulder = lm[idx.shoulder];
  const wrist = lm[idx.wrist];
  return {
    angle: angle(shoulder, lm[idx.elbow], wrist, aspect),
    lean: sm('lean', tiltFromVertical(lm[idx.hip], shoulder, aspect)),
    handsBelow: wrist.y - shoulder.y >= cfg.wristBelowShoulder,
  };
}

export function createController(deps) {
  const cfg = REPS.dips;
  return createRepController(deps, {
    cfg,
    sideKeys: ['shoulder', 'elbow', 'wrist', 'hip'],
    visible: ['shoulder', 'elbow', 'wrist', 'hip'],
    angle: ['shoulder', 'elbow', 'wrist'],
    measure: (args) => measure({ ...args, cfg }),
    gate: (m) => (isSupport(m, cfg) ? null : GATES.support),
    checks: CHECKS,
    rules: [RULES.lean],
    praise: [PRAISE[0], 'Глубоко и ровно, так держать', PRAISE[2]],
    turn(ev) {
      if (ev.type === 'valley' && ev.phase === 'UP' && ev.angle > cfg.down && ev.angle <= cfg.halfDownFrom) return { rule: RULES.halfDown, value: ev.angle };
      if (ev.type === 'peak' && ev.phase === 'DOWN' && ev.angle >= cfg.halfUpFrom && ev.angle < cfg.up) return { rule: RULES.halfUp, value: ev.angle };
      return null;
    },
    tempo: (ev) => (ev.downMs < cfg.minDownToUpMs ? { rule: RULES.tempo, value: ev.downMs } : null),
  });
}
