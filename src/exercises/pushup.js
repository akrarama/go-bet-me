// Отжимания. Владелец: блок 1 (Упражнения). Контракт контроллера: см. squat.js.
// Счёт по углу локтя плечо-локоть-запястье: UP и угол < down → DOWN, DOWN и угол > up → повтор.
// Спека: 90 / 160, пороги откалиброваны по реальному ролику (config.REPS.pushup).
// Считаем только в упоре лёжа: линия плечо-щиколотка почти горизонтальна и кисти на полу
// (запястье не выше плеча). Стоит, прыгает, машет руками: счёт на паузе, начатый повтор сброшен.
// Режим «Ошибка» (раздел 6 спеки, пороги в config.REPS.pushup), камера сбоку на полу:
//   форма (повтор не засчитывается): таз провис, таз задран (угол плечо-таз-щиколотка < 160);
//   глубина (в лог незасчитанных): не выпрямил руки, не опустился до конца, с настоящим углом в тексте;
//   темп: от DOWN до UP быстрее 400 мс (повтор засчитан, но подсказка).
// Движок повторов, видимость и подсказки: reps.js.

import { REPS } from '../config.js';
import { angle, belowLine, tiltFromVertical } from '../vision/geometry.js';
import { createRepController } from './reps.js';

const deg = (v) => `${Math.round(v)}°`;

export const RULES = {
  sag: {
    code: 'hip_sag',
    kind: 'form',
    label: 'таз провис',
    hint: 'Таз провисает, напряги живот, выровняй тело',
    joints: ['hip'],
    test: (m, cfg) => m.body != null && m.body < cfg.bodyLineMin && m.hipBelow > 0,
  },
  pike: {
    code: 'hip_pike',
    kind: 'form',
    label: 'таз задран',
    hint: 'Таз задран вверх, опусти таз в линию с плечами',
    joints: ['hip'],
    test: (m, cfg) => m.body != null && m.body < cfg.bodyLineMin && m.hipBelow < 0,
  },
  // Из DOWN угол поднялся до halfUpFrom..up и пошёл вниз, не достигнув up
  halfUp: {
    code: 'pushup_half_up',
    kind: 'depth',
    label: 'не выпрямил руки',
    hint: (v, cfg) => `Не выпрямил руки: локоть ${deg(v)}, нужно больше ${deg(cfg.up)}`,
    joints: ['elbow'],
  },
  // Из UP угол упал до down..halfDownFrom и пошёл вверх
  halfDown: {
    code: 'pushup_half_down',
    kind: 'depth',
    label: 'недостаточная глубина',
    hint: (v, cfg) => `Не до конца опускаешься: локоть ${deg(v)}, нужно меньше ${deg(cfg.down)}`,
    joints: ['elbow'],
  },
  tempo: {
    code: 'pushup_tempo',
    kind: 'tempo',
    level: 'info',
    label: 'слишком быстро',
    hint: 'Слишком быстро, контролируй опускание',
    joints: [],
  },
};

/** Поза не для счёта. */
export const GATES = {
  plank: { hint: 'Прими упор лёжа, боком к камере' },
};

/**
 * Положение до старта («Встань в позицию»): то же условие, что пропускает кадр в счёт (gate ниже).
 * Тело в кадре добавляет сам движок (reps.js ready).
 */
const isPlank = (m, cfg) => m.tilt != null && m.tilt < cfg.plankMaxTilt && m.handsDown;
export const CHECKS = [{ id: 'plank', text: 'Упор лёжа', hint: GATES.plank.hint, test: isPlank }];

/** Метрики кадра (сторона idx уже выбрана и видна). */
export function measure({ lm, idx, aspect, sm, cfg = REPS.pushup }) {
  const shoulder = lm[idx.shoulder];
  const hip = lm[idx.hip];
  const ankle = lm[idx.ankle];
  const wrist = lm[idx.wrist];
  return {
    angle: angle(shoulder, lm[idx.elbow], wrist, aspect),
    body: sm('body', angle(shoulder, hip, ankle, aspect)),
    hipBelow: sm('hipBelow', belowLine(hip, shoulder, ankle)),
    // наклон линии плечо-щиколотка к горизонтали: 0 = лежит, 90 = стоит
    tilt: sm('tilt', 90 - tiltFromVertical(shoulder, ankle, aspect)),
    // кисти на полу: запястье ниже плеча (или выше, но совсем чуть-чуть)
    handsDown: wrist.y - shoulder.y >= -cfg.wristAboveMax,
  };
}

export function createController(deps) {
  const cfg = REPS.pushup;
  return createRepController(deps, {
    cfg,
    sideKeys: ['shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle'],
    visible: ['shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle'],
    angle: ['shoulder', 'elbow', 'wrist'],
    measure,
    gate: (m) => (isPlank(m, cfg) ? null : GATES.plank),
    checks: CHECKS,
    rules: [RULES.sag, RULES.pike],
    turn(ev) {
      if (ev.type === 'valley' && ev.phase === 'UP' && ev.angle > cfg.down && ev.angle <= cfg.halfDownFrom) return { rule: RULES.halfDown, value: ev.angle };
      if (ev.type === 'peak' && ev.phase === 'DOWN' && ev.angle >= cfg.halfUpFrom && ev.angle < cfg.up) return { rule: RULES.halfUp, value: ev.angle };
      return null;
    },
    tempo: (ev) => (ev.downMs < cfg.minDownToUpMs ? { rule: RULES.tempo, value: ev.downMs } : null),
  });
}
