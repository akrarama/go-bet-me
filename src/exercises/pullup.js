// Подтягивания на турнике. Контракт контроллера: см. squat.js, движок повторов: reps.js.
// Камера спереди или сзади (руки движутся в плоскости кадра, угол локтя виден честно; сбоку руки закрывают
// друг друга). Ноги и таз не нужны: у турника они часто за нижним краем кадра.
// Счёт по углу локтя плечо-локоть-запястье: вис (угол > up) → вверх (угол < down) → снова вис = повтор.
// Считаем только в висе: запястья выше локтей (руки на перекладине). Стоит под турником руки вниз: счёт на паузе.
// Режим «Ошибка» (пороги в config.REPS.pullup, калибровка по ролику fixtures/pullup: вверху 40..60°, в висе 140..176°):
//   главное: подбородок над перекладиной (нос не ниже линии кистей) хотя бы раз за повтор, иначе не засчитан;
//   глубина: не подтянулся (разворот на 90..120°), не опустился до прямых рук (разворот вверху 115..140°).

import { REPS } from '../config.js';
import { angle } from '../vision/geometry.js';
import { createRepController, PRAISE, SEEN_WHY } from './reps.js';

const deg = (v) => `${Math.round(v)}°`;

export const RULES = {
  chin: {
    code: 'pullup_chin',
    kind: 'depth',
    label: 'подбородок ниже перекладины',
    hint: 'Подбородок не дошёл до перекладины, тянись выше',
    joints: ['wrist'],
  },
  // Из виса угол упал до down..halfDownFrom и пошёл назад: не подтянулся
  halfDown: {
    code: 'pullup_half_down',
    kind: 'depth',
    label: 'не подтянулся',
    hint: (v, cfg) => `Не подтянулся: локоть ${deg(v)}, нужно меньше ${deg(cfg.down)}`,
    joints: ['elbow'],
  },
  // Сверху угол поднялся до halfUpFrom..up и снова вниз: не опустился в вис
  halfUp: {
    code: 'pullup_half_up',
    kind: 'depth',
    label: 'не опустился до прямых рук',
    hint: (v, cfg) => `Опускайся до прямых рук: локоть ${deg(v)}, нужно больше ${deg(cfg.up)}`,
    joints: ['elbow'],
  },
  tempo: {
    code: 'pullup_tempo',
    kind: 'tempo',
    level: 'info',
    label: 'слишком быстро',
    hint: 'Слишком быстро, опускайся подконтрольно',
    joints: [],
  },
};

export const GATES = {
  hang: { hint: 'Повисни на турнике: руки на перекладине над головой' },
};

/** Вис: запястья выше локтей (кисти на перекладине). Стоя с опущенными руками запястья ниже локтей. */
export const isHang = (m) => m.wristUp;
export const CHECKS = [{ id: 'hang', text: 'Вис на турнике', hint: GATES.hang.hint, test: isHang }];

/** Метрики кадра. chin: нос относительно линии кистей (доля высоты кадра), меньше 0: нос выше кистей. */
export function measure({ lm, idx, aspect, cfg = REPS.pullup }) {
  const wrist = lm[idx.wrist];
  const elbow = lm[idx.elbow];
  return {
    angle: angle(lm[idx.shoulder], elbow, wrist, aspect),
    chin: lm[0].y - wrist.y,
    wristUp: wrist.y < elbow.y - cfg.wristAboveElbow,
  };
}

export function createController(deps) {
  const cfg = REPS.pullup;
  let bestChin = Infinity; // самый высокий нос за повтор (минимум chin), сбрасывается в конце повтора
  return createRepController(deps, {
    cfg,
    sideKeys: ['shoulder', 'elbow', 'wrist'],
    visible: ['shoulder', 'elbow', 'wrist'],
    angle: ['shoulder', 'elbow', 'wrist'],
    measure(args) {
      const m = measure({ ...args, cfg });
      if (m.wristUp) bestChin = Math.min(bestChin, m.chin);
      return m;
    },
    gate: (m) => (isHang(m) ? null : GATES.hang),
    checks: CHECKS,
    rules: [],
    seenWhy: {
      arms: { ...SEEN_WHY.arms, hint: 'Не видно рук: камера спереди, в кадре турник и руки' },
      shoulders: { ...SEEN_WHY.shoulders, hint: 'Не видно плеч: отойди дальше от камеры' },
    },
    praise: [PRAISE[0], 'Подбородок над перекладиной, отлично', PRAISE[2]],
    turn(ev) {
      if (ev.type === 'valley' && ev.phase === 'UP' && ev.angle > cfg.down && ev.angle <= cfg.halfDownFrom) return { rule: RULES.halfDown, value: ev.angle };
      if (ev.type === 'peak' && ev.phase === 'DOWN' && ev.angle >= cfg.halfUpFrom && ev.angle < cfg.up) return { rule: RULES.halfUp, value: ev.angle };
      return null;
    },
    verify() {
      const chin = bestChin;
      bestChin = Infinity;
      return chin > cfg.chinMax ? { rule: RULES.chin, value: null } : null;
    },
    tempo: (ev) => (ev.downMs < cfg.minDownToUpMs ? { rule: RULES.tempo, value: ev.downMs } : null),
  });
}
