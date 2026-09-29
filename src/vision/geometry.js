// Геометрия по landmarks. Чистые функции, без DOM (тесты идут в jsc).
// Координаты нормализованы 0..1, y растёт вниз. Кадр не квадратный, поэтому
// для углов и расстояний передавай aspect = frame.width / frame.height.

export const POSE = {
  nose: 0,
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
  leftHeel: 29, rightHeel: 30,
  leftToe: 31, rightToe: 32,
};

/** Индексы суставов одной стороны тела. */
export const SIDE = {
  left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27, heel: 29, toe: 31 },
  right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28, heel: 30, toe: 32 },
};

/** Угол в точке b между векторами ba и bc, градусы 0..180. */
export function angle(a, b, c, aspect = 1) {
  const abx = (a.x - b.x) * aspect;
  const aby = a.y - b.y;
  const cbx = (c.x - b.x) * aspect;
  const cby = c.y - b.y;
  // atan2 точнее acos рядом с 0° и 180°
  return (Math.abs(Math.atan2(abx * cby - aby * cbx, abx * cbx + aby * cby)) * 180) / Math.PI;
}

/** Расстояние в единицах высоты кадра. */
export const dist = (a, b, aspect = 1) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);

/** Угол вектора a→b к вертикали, градусы 0..90 (0 = строго вертикально). */
export function tiltFromVertical(a, b, aspect = 1) {
  const dx = Math.abs((b.x - a.x) * aspect);
  const dy = Math.abs(b.y - a.y);
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

/**
 * На сколько точка p ниже прямой a-b (по y, в долях высоты кадра).
 * Больше 0: ниже линии (например, таз провис), меньше 0: выше.
 */
export function belowLine(p, a, b) {
  const dx = b.x - a.x;
  if (Math.abs(dx) < 1e-6) return 0;
  const yOnLine = a.y + ((b.y - a.y) * (p.x - a.x)) / dx;
  return p.y - yOnLine;
}

/** Сглаживание EMA: первое значение берётся как есть. */
export const ema = (prev, next, alpha = 0.3) => (prev == null ? next : prev + alpha * (next - prev));

/** Все ли точки видны не хуже min. */
export const visible = (lm, indices, min = 0.5) => indices.every((i) => (lm[i]?.visibility ?? 0) >= min);

/**
 * Сторона тела, которая лучше видна камере (по средней visibility нужных суставов).
 * @returns {{ side: 'left'|'right', idx: typeof SIDE.left, vis: number }}
 */
export function pickSide(lm, keys = ['shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle']) {
  const score = (side) => keys.reduce((s, k) => s + (lm[SIDE[side][k]]?.visibility ?? 0), 0) / keys.length;
  const l = score('left');
  const r = score('right');
  const side = l >= r ? 'left' : 'right';
  return { side, idx: SIDE[side], vis: Math.max(l, r) };
}
