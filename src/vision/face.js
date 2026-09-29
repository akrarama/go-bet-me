// Помощники для лица: глаза закрыты, нос, смещение носа за 1 с, число лиц, главное лицо.
// Владелец: блок 4 (Медитация). Чистые функции без DOM (тесты идут в jsc).
// Данные: frame.face = { t, faces: [[478 точек {x, y, z}]], blendshapes: [{ eyeBlinkLeft, eyeBlinkRight, ... }] }.
// Координаты нормализованы 0..1: x в долях ширины кадра, y в долях высоты, y растёт вниз.

import { MEDITATION } from '../config.js';

/** Индексы face mesh MediaPipe (478 точек). Веки идут от внешнего уголка глаза к внутреннему. */
export const FACE = {
  nose: 1, // кончик носа
  oval: [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
    152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
  ],
  leftEye: {
    upper: [263, 466, 388, 387, 386, 385, 384, 398, 362],
    lower: [263, 249, 390, 373, 374, 380, 381, 382, 362],
  },
  rightEye: {
    upper: [33, 246, 161, 160, 159, 158, 157, 173, 133],
    lower: [33, 7, 163, 144, 145, 153, 154, 155, 133],
  },
};

/** Насколько закрыты глаза, 0..1: (eyeBlinkLeft + eyeBlinkRight) / 2. Нет данных: null. */
export function blink(bs) {
  if (!bs) return null;
  return ((bs.eyeBlinkLeft ?? 0) + (bs.eyeBlinkRight ?? 0)) / 2;
}

/** Глаза закрыты: среднее больше порога (спека, раздел 5). */
export function eyesClosed(bs, min = MEDITATION.eyesClosedMin) {
  const b = blink(bs);
  return b != null && b > min;
}

/** Кончик носа (точка 1) или null. */
export const nose = (face) => face?.[FACE.nose] ?? null;

/** Сколько лиц в кадре: frame.face → число. */
export const faceCount = (res) => res?.faces?.length ?? 0;

/** Расстояние между точками в долях ширины кадра: y переводим в ширину через aspect = width / height. */
export const shiftW = (a, b, aspect = 1) => Math.hypot(a.x - b.x, (a.y - b.y) / aspect);

/** Рамка лица по всем точкам, в нормализованных координатах. */
export function faceBox(face) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of face) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

/**
 * Какое лицо главное. Порядок лиц у модели может меняться от кадра к кадру,
 * поэтому берём ближайшее к прошлому положению носа, а без истории самое крупное.
 */
export function primaryIndex(faces, prevNose = null, aspect = 1) {
  if (!faces?.length) return -1;
  let best = 0;
  let bestScore = Infinity;
  faces.forEach((f, i) => {
    const n = nose(f);
    const score = prevNose && n ? shiftW(n, prevNose, aspect) : -faceBox(f).w;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

/**
 * Смещение носа за последние windowMs (по умолчанию 1 с) в долях ширины кадра:
 * где нос сейчас против того, где он был windowMs назад.
 *   const track = noseTracker(); track.push(t, nose(face)); track.shift(aspect) → 0.012
 */
export function noseTracker(windowMs = 1000) {
  let pts = [];
  return {
    push(t, p) {
      pts.push({ t, x: p.x, y: p.y });
      // опора: самая свежая точка не новее t − windowMs, всё что старше неё уже не нужно
      while (pts.length > 1 && pts[1].t <= t - windowMs) pts.shift();
    },
    shift(aspect = 1) {
      return pts.length < 2 ? 0 : shiftW(pts[pts.length - 1], pts[0], aspect);
    },
    /** За сколько мс есть история. */
    get span() {
      return pts.length < 2 ? 0 : pts[pts.length - 1].t - pts[0].t;
    },
    reset() {
      pts = [];
    },
  };
}
