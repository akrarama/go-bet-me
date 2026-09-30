// Медитация, вид «Аура». Владелец: блок 4 (Медитация).
//
// Для кого картинка: медитирующий сидит с закрытыми глазами и экрана не видит. Смотрят друзья
// в стриме и жюри: с одного взгляда должно быть ясно, идёт таймер или стоит и почему.
//   Идёт:   вокруг головы мягкий ореол, он дышит (вдох 4 с, выдох 4 с), веки лаймовыми дугами.
//   Пауза:  ореол замирает и желтеет, пока нарушение копится, и краснеет, когда списана жизнь;
//           открытые глаза видны зрачками, движение головы шлейфом контуров, пропавшее лицо
//           пунктиром там, где оно было, второй человек красным пунктиром с подписью.
//   Статус: стеклянные чипы под таймером: «Глаза …» и «Голова …»
//           (или один чип: «Настройся» с кольцом первых 5 с, «Лица не видно», «В кадре двое»).
//
// Подключение: контроллер (meditation.js) в draw(frame, draw) зовёт view.draw(frame, draw, c),
// в stop() зовёт view.destroy(). Контроллер отдаёт c.started, c.target, c.faceData (лица после
// подмены клавишами отладки), c.view (состояние правил). Стили: styles/meditation.css.
// Модуль без DOM на верхнем уровне: грузится и в jsc (тесты).

import { VISION, MEDITATION as M } from '../config.js';
import { FACE, blink, primaryIndex } from '../vision/face.js';

const TAU = Math.PI * 2;
const BREATH_MS = 8000; // один вдох и выдох
const HOLD_MS = 220; // статус держится столько, прежде чем сменить чипы и цвет (не мигают на пороге)
const FC_MIN = 1.1; // Гц: срез фильтра точек, когда голова стоит (гладко, без дрожи)
const FC_EYE = 2.6; // Гц: веки и зрачки чуть живее, чтобы глаз открывался без задержки
const FC_BETA = 0.012; // Гц на px/с: чем быстрее голова, тем слабее сглаживание (контур не отстаёт)
const TOP_SAFE = 184; // px: выше не ставим подпись на холсте (шапка, таймер, чипы)
const VIGNETTE = 0.3; // затемнение краёв кадра после старта, 0 = выключить

// Точки лица, которые рисуем, одним списком (индексы face mesh MediaPipe, 478 точек):
// овал от подбородка по кругу (след «Настройся» растёт от подбородка к макушке),
// веки (левый глаз: верх, низ; правый: верх, низ), радужки (центр, край), кончик носа.
const CHIN = Math.max(0, FACE.oval.indexOf(152));
const OVAL = [...FACE.oval.slice(CHIN), ...FACE.oval.slice(0, CHIN)];
const N_OVAL = OVAL.length;
const LID = FACE.leftEye.upper.length;
const O_EYES = N_OVAL;
const O_IRIS = O_EYES + 4 * LID;
const O_NOSE = O_IRIS + 4;
const PTS = [
  ...OVAL,
  ...FACE.leftEye.upper, ...FACE.leftEye.lower,
  ...FACE.rightEye.upper, ...FACE.rightEye.lower,
  473, 474, 468, 469, // радужка левого глаза (центр, край), правого (центр, край)
  FACE.nose,
];
const N_PTS = PTS.length;
const IRIS_FROM = 478; // радужки есть только в модели на 478 точек

const TONES = { ok: 'accent', warn: 'warn', danger: 'danger', neutral: 'text' };
const RANK = { ok: 0, neutral: 1, warn: 2, danger: 3 };
const STEADY = new Set(['main', 'lost', 'two']); // между ними переход через HOLD_MS
const EYES_TEXT = { ok: 'Глаза закрыты', warn: 'Глаза открыты', danger: 'Глаза открыты', neutral: 'Ищу глаза' };
const HEAD_TEXT = { ok: 'Голова неподвижна', warn: 'Голова двигается', danger: 'Голова двигается', neutral: 'Голова неподвижна' };
const STRANGER = 'Второй человек';
const FALLBACK = { accent: '#d4ff3a', warn: '#ffb020', danger: '#ff4d4f', text: '#f5f5f7', bg: '#0a0a0c' };
const ZERO = { x: 0, y: 0 };
const ONE = { x: 1, y: 1 };
const NO_DASH = [];

// Рабочие буферы (одни на все виды: рисуем по очереди, кадр за кадром)
const RX = new Float32Array(N_PTS);
const RY = new Float32Array(N_PTS);
const TX = new Float32Array(N_OVAL);
const TY = new Float32Array(N_OVAL);
const UX = new Float32Array(LID);
const UY = new Float32Array(LID);
const LX = new Float32Array(LID);
const LY = new Float32Array(LID);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
/** Доля пути к цели за dt при постоянной времени tau (мс): плавно и не зависит от fps. */
const ease = (dt, tau) => 1 - Math.exp(-dt / tau);
const rgba = (c, a) => `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${Math.round(clamp(a, 0, 1) * 1000) / 1000})`;
const mixTo = (cur, to, k) => {
  cur[0] += (to[0] - cur[0]) * k;
  cur[1] += (to[1] - cur[1]) * k;
  cur[2] += (to[2] - cur[2]) * k;
};

function parseColor(s) {
  const str = String(s ?? '').trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(str);
  if (m) {
    const h = m[1].length === 3 ? m[1].replace(/./g, (x) => x + x) : m[1];
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(str);
  return m ? [+m[1], +m[2], +m[3]] : null;
}

/** Цвета и шрифт из токенов base.css (один раз), без DOM: запасные значения. */
function readTokens() {
  let cs = null;
  try {
    if (typeof document !== 'undefined' && typeof getComputedStyle === 'function') cs = getComputedStyle(document.documentElement);
  } catch {
    cs = null;
  }
  const pal = {};
  for (const k of Object.keys(FALLBACK)) pal[k] = parseColor(cs?.getPropertyValue(`--${k}`)) ?? parseColor(FALLBACK[k]);
  pal.font = cs?.getPropertyValue('--font-ui').trim() || 'Manrope, system-ui, sans-serif';
  pal.spring = cs?.getPropertyValue('--ease-spring').trim() || 'cubic-bezier(0.34, 1.56, 0.64, 1)';
  return pal;
}

// ─── Лицо: сглаженные точки в px экрана ─────────────────────────

function makeFace() {
  return {
    x: new Float32Array(N_PTS),
    y: new Float32Array(N_PTS),
    ok: false, // точки есть (хотя бы раз)
    alpha: 0, // видимость, плавно
    speed: 0, // px/с, скорость центра
    mx: 0,
    my: 0,
    cx: 0, // центр, полуоси и наклон головы (по сглаженным точкам)
    cy: 0,
    rw: 0,
    rh: 0,
    roll: 0,
    cos: 1,
    sin: 0,
    iris: false,
    nose: { x: 0, y: 0 }, // нормализованный нос: для выбора главного лица
  };
}

/**
 * Новые точки лица → сглаженные. Фильтр как One Euro: пока голова стоит, срез низкий (дрожь уходит),
 * когда движется, срез растёт со скоростью (контур не отстаёт). P: аффинная проекция в px.
 */
function feed(s, face, P, dt) {
  const spare = face[FACE.nose] ?? face[0];
  for (let i = 0; i < N_PTS; i++) {
    const p = face[PTS[i]] ?? spare;
    RX[i] = P.bx + P.ax * p.x;
    RY[i] = P.by + P.ay * p.y;
  }
  let mx = 0;
  let my = 0;
  for (let i = 0; i < N_OVAL; i++) {
    mx += RX[i];
    my += RY[i];
  }
  mx /= N_OVAL;
  my /= N_OVAL;
  if (!s.ok || s.alpha < 0.03) {
    // лицо появилось (или вернулось): сразу на место, без проезда через экран
    s.x.set(RX);
    s.y.set(RY);
    s.speed = 0;
  } else {
    const v = (Math.hypot(mx - s.mx, my - s.my) * 1000) / Math.max(dt, 1);
    s.speed += (v - s.speed) * ease(dt, 60);
    const fc = FC_MIN + FC_BETA * s.speed;
    const a = 1 - Math.exp((-TAU * fc * dt) / 1000);
    const ae = 1 - Math.exp((-TAU * Math.max(fc, FC_EYE) * dt) / 1000);
    for (let i = 0; i < N_PTS; i++) {
      const k = i >= O_EYES && i < O_NOSE ? ae : a;
      s.x[i] += (RX[i] - s.x[i]) * k;
      s.y[i] += (RY[i] - s.y[i]) * k;
    }
  }
  s.mx = mx;
  s.my = my;
  s.ok = true;
  s.iris = face.length >= IRIS_FROM;
  const n = face[FACE.nose];
  if (n) {
    s.nose.x = n.x;
    s.nose.y = n.y;
  }
  shape(s);
}

/** Центр, полуоси (вдоль и поперёк линии глаз) и наклон головы. */
function shape(s) {
  let dx = s.x[O_EYES] - s.x[O_EYES + 2 * LID]; // внешние уголки глаз: 263 и 33
  let dy = s.y[O_EYES] - s.y[O_EYES + 2 * LID];
  if (dx < 0) {
    dx = -dx;
    dy = -dy;
  }
  const roll = dx || dy ? Math.atan2(dy, dx) : 0;
  const cos = Math.cos(roll);
  const sin = Math.sin(roll);
  let mx = 0;
  let my = 0;
  for (let i = 0; i < N_OVAL; i++) {
    mx += s.x[i];
    my += s.y[i];
  }
  mx /= N_OVAL;
  my /= N_OVAL;
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (let i = 0; i < N_OVAL; i++) {
    const px = s.x[i] - mx;
    const py = s.y[i] - my;
    const u = px * cos + py * sin;
    const v = py * cos - px * sin;
    if (u < u0) u0 = u;
    if (u > u1) u1 = u;
    if (v < v0) v0 = v;
    if (v > v1) v1 = v;
  }
  const uc = (u0 + u1) / 2;
  const vc = (v0 + v1) / 2;
  s.cx = mx + uc * cos - vc * sin;
  s.cy = my + uc * sin + vc * cos;
  s.rw = Math.max(8, (u1 - u0) / 2);
  s.rh = Math.max(8, (v1 - v0) / 2);
  s.roll = roll;
  s.cos = cos;
  s.sin = sin;
}

// ─── Пути ───────────────────────────────────────────────────────

/**
 * Овал лица гладкой кривой (Catmull-Rom → Безье) в текущий путь g.
 * k: масштаб от центра, dx/dy: сдвиг. Возвращает длину пути (для следа «Настройся»).
 */
function oval(g, s, k = 1, dx = 0, dy = 0) {
  const n = N_OVAL;
  for (let i = 0; i < n; i++) {
    TX[i] = s.cx + (s.x[i] - s.cx) * k + dx;
    TY[i] = s.cy + (s.y[i] - s.cy) * k + dy;
  }
  let len = 0;
  g.moveTo(TX[0], TY[0]);
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n;
    const b = (i + 1) % n;
    const c = (i + 2) % n;
    const x1 = TX[i] + (TX[b] - TX[a]) / 6;
    const y1 = TY[i] + (TY[b] - TY[a]) / 6;
    const x2 = TX[b] - (TX[c] - TX[i]) / 6;
    const y2 = TY[b] - (TY[c] - TY[i]) / 6;
    g.bezierCurveTo(x1, y1, x2, y2, TX[b], TY[b]);
    // длина кривой Безье: среднее хорды и ломаной через опорные точки
    const chord = Math.hypot(TX[b] - TX[i], TY[b] - TY[i]);
    const poly = Math.hypot(x1 - TX[i], y1 - TY[i]) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(TX[b] - x2, TY[b] - y2);
    len += (chord + poly) / 2;
  }
  g.closePath();
  return len;
}

/** Открытая гладкая кривая через n точек. rev: в обратном порядке, move: начать новый подпуть. */
function spline(g, X, Y, n, move, rev = false) {
  const at = (i) => (rev ? n - 1 - i : i);
  if (move) g.moveTo(X[at(0)], Y[at(0)]);
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i > 0 ? i - 1 : 0);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2 < n ? i + 2 : n - 1);
    g.bezierCurveTo(
      X[p1] + (X[p2] - X[p0]) / 6, Y[p1] + (Y[p2] - Y[p0]) / 6,
      X[p2] - (X[p3] - X[p1]) / 6, Y[p2] - (Y[p3] - Y[p1]) / 6,
      X[p2], Y[p2],
    );
  }
}

function pill(g, x, y, w, h) {
  const r = h / 2;
  if (g.roundRect) return g.roundRect(x, y, w, h, r);
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// ─── Вид ────────────────────────────────────────────────────────

export function createView() {
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const P = { ax: 1, bx: 0, ay: 1, by: 0 };
  const me = makeFace(); // главное лицо
  const other = makeFace(); // второй человек
  const col = { tone: parseColor(FALLBACK.text), eye: parseColor(FALLBACK.text) };
  // плавные уровни 0..1 (энергия ореола может быть чуть больше 1 на финише)
  const lv = { energy: 0, breath: 0, vignette: 0, contour: 0, trace: 0, open: 1, lost: 0, move: 0 };
  const raw = { mode: 'idle', tone: 'neutral', eyes: 'neutral', head: 'ok' };
  let st = { mode: 'none', tone: 'neutral', eyes: 'neutral', head: 'ok', key: '' };
  let pendKey = '';
  let pendSince = 0;
  let pal = null;
  let dom = null;
  let ui = {};
  let lastT = 0;
  let origin = -1; // когда начали дышать
  let traceP = 0;
  let lives = null;
  let wasGrace = false;
  let bloomed = false;
  const ripples = []; // кольца-события: жизнь списана, настроились, финиш
  const HIST = 32;
  const hist = new Float64Array(HIST * 3); // центр головы за последние кадры: шлейф движения
  let histN = 0;
  let histI = 0;
  let vx = -1; // центр виньетки
  let vy = -1;

  function readState(c, v) {
    const started = c?.started ?? false;
    raw.head = 'ok';
    if (!started) return set('idle', 'neutral', 'neutral');
    if (c.failed || c.done) return set('end', c.failed ? 'danger' : 'ok', c.failed ? 'danger' : 'ok');
    const n = v.faces ?? 0;
    const bad = (code) => (v.active === code || (Array.isArray(v.fired) && v.fired.includes(code)) ? 'danger' : 'warn');
    // первые кадры после старта контроллер ещё не посчитал: тоже «настройся»
    if (v.grace > 0 || (n === 0 && !v.pending && !v.active)) return set('grace', 'ok', v.closed === true ? 'ok' : 'neutral');
    if (n === 0) return set('lost', bad('face_lost'), 'neutral');
    const eyes = v.closed === true ? 'ok' : v.closed === false ? bad('eyes_open') : 'neutral';
    raw.head = v.moving ? bad('head_moving') : 'ok';
    if (n > 1) return set('two', bad('two_faces'), eyes);
    const worst = RANK[eyes] >= RANK[raw.head] ? eyes : raw.head;
    return set('main', v.calm ? 'ok' : worst === 'ok' ? 'neutral' : worst, eyes);
  }

  function set(mode, tone, eyes) {
    raw.mode = mode;
    raw.tone = tone;
    raw.eyes = eyes;
    return raw;
  }

  const peak = (s) => Math.max(RANK[s.tone], RANK[s.eyes], RANK[s.head]);

  /** Статус меняем, только когда он продержался HOLD_MS. Сразу: смена фазы и списанная жизнь. */
  function commit(t) {
    const key = `${raw.mode}|${raw.tone}|${raw.eyes}|${raw.head}`;
    if (key === st.key) {
      pendKey = '';
      return false;
    }
    if (key !== pendKey) {
      pendKey = key;
      pendSince = t;
    }
    const phase = raw.mode !== st.mode && !(STEADY.has(raw.mode) && STEADY.has(st.mode));
    const alarm = peak(raw) === RANK.danger && peak(raw) > peak(st);
    if (!phase && !alarm && t - pendSince < HOLD_MS) return false;
    st = { mode: raw.mode, tone: raw.tone, eyes: raw.eyes, head: raw.head, key };
    pendKey = '';
    return true;
  }

  function ripple(t, color, dur, k, a) {
    if (reduced) return;
    ripples.push({ t, color, dur, k, a });
    if (ripples.length > 4) ripples.shift();
  }

  function pushHist(t, x, y) {
    hist[histI * 3] = t;
    hist[histI * 3 + 1] = x;
    hist[histI * 3 + 2] = y;
    histI = (histI + 1) % HIST;
    histN = Math.min(HIST, histN + 1);
  }

  /** Где был центр головы lag мс назад (или -1, если истории нет). */
  function histAt(t, lag) {
    for (let k = 1; k <= histN; k++) {
      const i = (histI - k + HIST) % HIST;
      if (hist[i * 3] <= t - lag) return i;
    }
    return -1;
  }

  // ─── Рисование ──────────────────────────────────────────────

  function vignette(g, W, H, b) {
    const a = VIGNETTE * lv.vignette;
    if (a < 0.005) return;
    const r = me.ok ? Math.max(me.rw, me.rh) * (1.5 + 0.12 * b) : Math.min(W, H) * 0.3;
    const R = Math.max(r + 1, Math.hypot(Math.max(vx, W - vx), Math.max(vy, H - vy)));
    const grad = g.createRadialGradient(vx, vy, r, vx, vy, R);
    grad.addColorStop(0, rgba(pal.bg, 0));
    grad.addColorStop(0.45, rgba(pal.bg, a * 0.45));
    grad.addColorStop(1, rgba(pal.bg, a));
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
  }

  /** Ореол за головой: свет только снаружи контура (клип evenodd), лицо не заливаем. */
  function aura(g, W, H, e, b) {
    if (e < 0.01) return;
    const s = me;
    const c = col.tone;
    const a = e * (0.68 + 0.32 * b);
    g.save();
    g.beginPath();
    g.rect(0, 0, W, H);
    oval(g, s);
    g.clip('evenodd');
    // мягкий эллипс чуть выше центра: свет из-за головы
    const q = 1 + (s.rh / s.rw - 1) * 0.7;
    const R = s.rw * (1.7 + 0.42 * b);
    g.save();
    g.translate(s.cx + s.sin * s.rh * 0.1, s.cy - s.cos * s.rh * 0.1);
    g.rotate(s.roll);
    g.scale(1, q);
    const grad = g.createRadialGradient(0, 0, s.rw * 0.82, 0, 0, R);
    grad.addColorStop(0, rgba(c, 0.32 * a));
    grad.addColorStop(0.28, rgba(c, 0.14 * a));
    grad.addColorStop(0.62, rgba(c, 0.045 * a));
    grad.addColorStop(1, rgba(c, 0));
    g.fillStyle = grad;
    g.fillRect(-R, -R, 2 * R, 2 * R);
    g.restore();
    // сияние вдоль контура: видна только внешняя половина широких мягких линий
    g.beginPath();
    oval(g, s);
    g.lineWidth = s.rw * (0.34 + 0.06 * b);
    g.strokeStyle = rgba(c, 0.07 * a);
    g.stroke();
    g.lineWidth = s.rw * 0.17;
    g.strokeStyle = rgba(c, 0.1 * a);
    g.stroke();
    g.lineWidth = s.rw * 0.07;
    g.strokeStyle = rgba(c, 0.16 * a);
    g.stroke();
    g.restore();
  }

  /** Контур лица: тонкая светящаяся линия, у макушки ярче, к подбородку мягче. */
  function contour(g, a, lw, glow) {
    if (a < 0.01) return;
    const s = me;
    const c = col.tone;
    g.beginPath();
    oval(g, s);
    g.lineWidth = lw + 2.5;
    g.strokeStyle = `rgba(0, 0, 0, ${Math.round(0.22 * a * 1000) / 1000})`;
    g.stroke();
    const ux = s.sin * s.rh;
    const uy = -s.cos * s.rh;
    const grad = g.createLinearGradient(s.cx + ux, s.cy + uy, s.cx - ux, s.cy - uy);
    grad.addColorStop(0, rgba(c, a));
    grad.addColorStop(1, rgba(c, a * 0.5));
    g.strokeStyle = grad;
    g.lineWidth = lw;
    if (glow > 0.5) {
      g.shadowColor = rgba(c, 0.75 * a);
      g.shadowBlur = glow;
    }
    g.stroke();
    g.shadowBlur = 0;
  }

  /** «Настройся»: контур дорисовывается от подбородка к макушке за 5 с. */
  function trace(g, a, lw) {
    if (a < 0.01 || traceP < 0.004) return;
    g.beginPath();
    const L = oval(g, me);
    if (traceP < 0.999) {
      const h = (traceP * L) / 2;
      g.setLineDash([h, Math.max(0, L - 2 * h), h, L]);
    }
    g.lineWidth = lw * 3.4;
    g.strokeStyle = rgba(pal.accent, 0.16 * a);
    g.stroke();
    g.lineWidth = lw * 1.2;
    g.strokeStyle = rgba(pal.accent, 0.95 * a);
    g.stroke();
    g.setLineDash(NO_DASH);
  }

  /** Глаз: верхнее веко при закрытых глазах ложится на нижнее и становится спокойной дугой. */
  function eye(g, e, a, lw, glow) {
    const s = me;
    const c = col.eye;
    const o = lv.open;
    const up = O_EYES + e * 2 * LID;
    const lo = up + LID;
    for (let j = 0; j < LID; j++) {
      const lx = s.x[lo + j];
      const ly = s.y[lo + j];
      UX[j] = lx + (s.x[up + j] - lx) * o;
      UY[j] = ly + (s.y[up + j] - ly) * o;
      LX[j] = lx;
      LY[j] = ly;
    }
    if (o > 0.04) {
      // открытый глаз: разрез и радужка внутри него
      g.save();
      g.beginPath();
      spline(g, UX, UY, LID, true);
      spline(g, LX, LY, LID, false, true);
      g.closePath();
      g.fillStyle = rgba(c, 0.1 * o * a);
      g.fill();
      if (s.iris) {
        g.clip();
        const ic = O_IRIS + e * 2;
        const ix = s.x[ic];
        const iy = s.y[ic];
        const wEye = Math.hypot(s.x[up] - s.x[up + LID - 1], s.y[up] - s.y[up + LID - 1]);
        const r = clamp(Math.hypot(s.x[ic + 1] - ix, s.y[ic + 1] - iy), 1.5, wEye * 0.3);
        g.beginPath();
        g.arc(ix, iy, r, 0, TAU);
        g.fillStyle = rgba(c, 0.5 * o * a);
        g.fill();
        g.lineWidth = Math.max(1, lw * 0.5);
        g.strokeStyle = rgba(c, o * a);
        g.stroke();
      }
      g.restore();
      g.beginPath();
      spline(g, LX, LY, LID, true);
      g.lineWidth = lw * 0.75;
      g.strokeStyle = rgba(c, 0.85 * o * a);
      g.stroke();
    }
    g.beginPath();
    spline(g, UX, UY, LID, true);
    g.lineWidth = lw + 2;
    g.strokeStyle = `rgba(0, 0, 0, ${Math.round(0.2 * a * 1000) / 1000})`;
    g.stroke();
    if (glow > 0.5) {
      g.shadowColor = rgba(c, 0.85 * a);
      g.shadowBlur = glow;
    }
    g.lineWidth = lw;
    g.strokeStyle = rgba(c, a);
    g.stroke();
    g.shadowBlur = 0;
  }

  /** Голова двигается: шлейф из контуров там, где голова была 0.1-0.3 с назад. */
  function ghosts(g, t, a, lw) {
    if (reduced || lv.move < 0.02 || a < 0.01) return;
    for (let k = 1; k <= 3; k++) {
      const i = histAt(t, k * 100);
      if (i < 0) break;
      const dx = hist[i * 3 + 1] - me.cx;
      const dy = hist[i * 3 + 2] - me.cy;
      if (dx * dx + dy * dy < 4) continue;
      g.beginPath();
      oval(g, me, 1, dx, dy);
      g.lineWidth = lw;
      g.strokeStyle = rgba(col.tone, a * lv.move * (0.46 - k * 0.12));
      g.stroke();
    }
  }

  /** Лица нет: пунктир там, где лицо было, мягко пульсирует. */
  function lostGhost(g, t, lw) {
    if (lv.lost < 0.01 || !me.ok) return;
    const pulse = reduced ? 0.5 : 0.5 - 0.5 * Math.cos((TAU * t) / 2400);
    g.beginPath();
    oval(g, me);
    g.setLineDash([lw * 1.2, lw * 3.2]);
    g.lineWidth = lw;
    g.strokeStyle = rgba(col.tone, lv.lost * (0.38 + 0.32 * pulse));
    g.stroke();
    g.setLineDash(NO_DASH);
    g.fillStyle = rgba(col.tone, lv.lost * 0.05);
    g.fill();
  }

  /** Второй человек: красный пунктир, лёгкая заливка и подпись над головой. */
  function stranger(g, W, lw) {
    const s = other;
    const a = s.alpha;
    if (a < 0.01 || !s.ok) return;
    const c = pal.danger;
    g.beginPath();
    oval(g, s);
    g.fillStyle = rgba(c, 0.1 * a);
    g.fill();
    g.lineWidth = lw + 2.5;
    g.strokeStyle = `rgba(0, 0, 0, ${Math.round(0.22 * a * 1000) / 1000})`;
    g.stroke();
    g.setLineDash([lw * 2.6, lw * 2]);
    g.shadowColor = rgba(c, 0.8 * a);
    g.shadowBlur = 12;
    g.lineWidth = lw * 1.2;
    g.strokeStyle = rgba(c, a);
    g.stroke();
    g.shadowBlur = 0;
    g.setLineDash(NO_DASH);
    // подпись: над головой, а если там шапка и таймер, то под подбородком
    g.font = `700 13px ${pal.font}`;
    const h = 26;
    const w = g.measureText(STRANGER).width + 24;
    let y = s.cy - s.rh - 12 - h;
    if (y < TOP_SAFE) y = s.cy + s.rh + 12;
    const x = clamp(s.cx - w / 2, 12, Math.max(12, W - 12 - w));
    g.beginPath();
    pill(g, x, y, w, h);
    g.fillStyle = rgba(c, 0.9 * a);
    g.fill();
    g.fillStyle = rgba(pal.text, a);
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(STRANGER, x + 12, y + h / 2 + 0.5);
  }

  function rings(g, t, lw) {
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      const p = (t - r.t) / r.dur;
      if (p >= 1 || p < 0) {
        if (p >= 1) ripples.splice(i, 1);
        continue;
      }
      if (!me.ok) continue;
      const k = 1 + (r.k - 1) * (1 - (1 - p) ** 3);
      g.beginPath();
      oval(g, me, k);
      g.lineWidth = lw * (1.5 - 0.9 * p);
      g.strokeStyle = rgba(pal[r.color], r.a * (1 - p) ** 1.6);
      g.stroke();
    }
  }

  // ─── Чипы (DOM): создаём один раз, дальше только меняем атрибуты, когда меняется статус ──

  function mount(parent) {
    const root = document.createElement('div');
    root.className = 'med';
    root.setAttribute('aria-hidden', 'true');
    root.dataset.mode = 'idle';
    root.innerHTML = `
      <div class="med__group med__group--grace">
        <div class="chip med__chip" data-tone="ok">
          <svg class="med__icon med__ring" viewBox="0 0 20 20"><circle class="med__ring-track" cx="10" cy="10" r="7.5"/><circle class="med__ring-fill" cx="10" cy="10" r="7.5" pathLength="100"/></svg>
          <span>Настройся</span>
        </div>
      </div>
      <div class="med__group med__group--main">
        <div class="chip med__chip" data-chip="eyes" data-tone="neutral" data-state="closed">
          <svg class="med__icon" viewBox="0 0 20 20">
            <g class="med__i med__i--closed"><path d="M3.2 9.2c3.8 4.2 9.8 4.2 13.6 0"/><path d="M5.9 12.3l-1.1 1.8M10 13.6v2.1M14.1 12.3l1.1 1.8"/></g>
            <g class="med__i med__i--open"><path d="M2.4 10c4.2-5.9 11-5.9 15.2 0-4.2 5.9-11 5.9-15.2 0z"/><circle cx="10" cy="10" r="2.5"/></g>
          </svg>
          <span data-label>${EYES_TEXT.neutral}</span>
        </div>
        <div class="chip med__chip" data-chip="head" data-tone="ok" data-state="still">
          <svg class="med__icon" viewBox="0 0 20 20">
            <g class="med__i med__i--still"><circle cx="10" cy="10" r="5.6"/><circle cx="10" cy="10" r="1.2"/></g>
            <g class="med__i med__i--move"><circle cx="10" cy="10" r="5.6"/><path d="M2.6 6.8c-1.2 2-1.2 4.4 0 6.4M17.4 6.8c1.2 2 1.2 4.4 0 6.4"/></g>
          </svg>
          <span data-label>${HEAD_TEXT.ok}</span>
        </div>
      </div>
      <div class="med__group med__group--lost">
        <div class="chip med__chip" data-chip="lost" data-tone="warn">
          <svg class="med__icon" viewBox="0 0 20 20"><circle cx="10" cy="10" r="6.6" stroke-dasharray="2.4 2.8"/></svg>
          <span>Лица не видно</span>
        </div>
      </div>
      <div class="med__group med__group--two">
        <div class="chip med__chip" data-chip="two" data-tone="warn">
          <svg class="med__icon" viewBox="0 0 20 20"><circle cx="7.4" cy="10" r="4.6"/><circle cx="13.2" cy="10" r="4.6" stroke-dasharray="2.2 2"/></svg>
          <span>В кадре двое</span>
        </div>
      </div>`;
    parent.append(root);
    const q = (sel) => root.querySelector(sel);
    const els = {
      root,
      ring: q('.med__ring-fill'),
      eyes: q('[data-chip="eyes"]'),
      head: q('[data-chip="head"]'),
      lost: q('[data-chip="lost"]'),
      two: q('[data-chip="two"]'),
    };
    els.eyesLabel = els.eyes.querySelector('[data-label]');
    els.headLabel = els.head.querySelector('[data-label]');
    void root.offsetWidth; // стартовые значения посчитаны: кольцо дальше идёт переходом
    return els;
  }

  function put(key, el, name, value) {
    if (ui[key] === value) return false;
    const was = ui[key];
    ui[key] = value;
    el.setAttribute(name, value);
    return was !== undefined;
  }

  function write(key, el, value) {
    if (ui[key] === value) return;
    ui[key] = value;
    el.textContent = value;
  }

  function pop(el) {
    if (reduced || !el.animate) return;
    el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.08)', offset: 0.35 }, { transform: 'scale(1)' }], { duration: 560, easing: pal.spring });
  }

  function sync(v) {
    const d = dom;
    put('mode', d.root, 'data-mode', st.mode === 'none' ? 'idle' : st.mode);
    if (st.mode === 'grace') {
      // кольцо: шаг раз в секунду, между шагами переход 1 с (без записей в DOM каждый кадр)
      const left = v.grace > 0 ? Math.ceil(v.grace) : M.graceSec + 1;
      const frac = clamp((M.graceSec - left + 1) / M.graceSec, 0, 1);
      if (ui.ring !== frac) {
        ui.ring = frac;
        d.ring.style.strokeDashoffset = String(Math.round(100 * (1 - frac)));
      }
    }
    if (st.mode === 'main') {
      const eyesTo = st.eyes;
      if (put('eyesTone', d.eyes, 'data-tone', eyesTo) && eyesTo === 'danger') pop(d.eyes);
      put('eyesState', d.eyes, 'data-state', eyesTo === 'warn' || eyesTo === 'danger' ? 'open' : 'closed');
      write('eyesText', d.eyesLabel, EYES_TEXT[eyesTo]);
      if (put('headTone', d.head, 'data-tone', st.head) && st.head === 'danger') pop(d.head);
      put('headState', d.head, 'data-state', st.head === 'ok' ? 'still' : 'move');
      write('headText', d.headLabel, HEAD_TEXT[st.head]);
    }
    if (st.mode === 'lost' && put('lostTone', d.lost, 'data-tone', st.tone) && st.tone === 'danger') pop(d.lost);
    if (st.mode === 'two' && put('twoTone', d.two, 'data-tone', st.tone) && st.tone === 'danger') pop(d.two);
  }

  // ─── Кадр ───────────────────────────────────────────────────

  return {
    /** Каждый кадр распознавания, пока на экране LIVE (и в отсчёте, и после финиша). */
    draw(frame, d, c) {
      const g = d?.ctx;
      if (!g || !frame) return;
      pal ??= readTokens();
      const t = frame.t ?? 0;
      const dt = lastT ? clamp(t - lastT, 0, 500) : 33;
      lastT = t;
      const W = d.w;
      const H = d.h;

      // project() аффинная (cover + зеркало): берём коэффициенты по двум точкам, дальше без объектов
      const p0 = d.project(ZERO);
      const p1 = d.project(ONE);
      P.ax = p1.x - p0.x;
      P.bx = p0.x;
      P.ay = p1.y - p0.y;
      P.by = p0.y;

      // Лица: у контроллера уже с подменой из клавиш отладки; старше staleMs не верим
      const fresh = (r) => r && frame.t - (r.t ?? frame.t) <= VISION.staleMs;
      const res = fresh(c?.faceData) ? c.faceData : fresh(frame.face) ? frame.face : null;
      const faces = res?.faces ?? [];
      const v = c?.view ?? {};
      const aspect = frame.width && frame.height ? frame.width / frame.height : 16 / 9;
      let pi = -1;
      if (faces.length) {
        const ok = Number.isInteger(v.primary) && v.primary >= 0 && v.primary < faces.length && res === c?.faceData;
        pi = ok ? v.primary : primaryIndex(faces, me.ok && me.alpha > 0.1 ? me.nose : null, aspect);
      }
      const oi = faces.length > 1 ? (pi === 0 ? 1 : 0) : -1;
      if (pi >= 0) feed(me, faces[pi], P, dt);
      if (oi >= 0) feed(other, faces[oi], P, dt);
      me.alpha += ((pi >= 0 ? 1 : 0) - me.alpha) * ease(dt, pi >= 0 ? 160 : 280);
      other.alpha += ((oi >= 0 ? 1 : 0) - other.alpha) * ease(dt, 200);

      // Статус: сырой из контроллера → устоявшийся (HOLD_MS)
      readState(c, v);
      commit(t);
      const mode = st.mode;
      const started = mode !== 'idle' && mode !== 'none';

      // События: списана жизнь, настроились, финиш
      if (typeof c?.lives === 'number') {
        if (lives != null && c.lives < lives && started) ripple(t, 'danger', 1300, 1.5, 0.85);
        lives = c.lives;
      }
      // настроились и таймер сразу пошёл: лаймовое кольцо («поехали»)
      if (wasGrace && mode === 'main' && st.tone === 'ok') ripple(t, 'accent', 1000, 1.2, 0.7);
      wasGrace = mode === 'grace';
      if (mode === 'end' && st.tone === 'ok' && !bloomed) {
        bloomed = true;
        ripple(t, 'accent', 1700, 1.75, 0.9);
      }

      // Глаза: открытость 0..1 (закрыты: веко ложится на нижнее)
      let openTo = 1;
      if (started && v.closed != null) openTo = v.closed ? 0 : 1;
      else if (pi >= 0) {
        const b = blink(res.blendshapes?.[pi]);
        openTo = b == null ? 1 : clamp((0.55 - b) / 0.3, 0, 1);
      }
      lv.open += (openTo - lv.open) * ease(dt, 110);

      // Цели для плавных уровней
      const calm = mode === 'main' && st.tone === 'ok';
      const win = st.tone === 'ok';
      let eT = 0; // ореол
      let cT = 0; // контур
      let vT = 0; // виньетка
      switch (mode) {
        case 'idle': cT = 0.5; break;
        case 'grace': eT = 0.45; cT = 0.26; vT = 0.75; break;
        case 'main': eT = calm ? 1 : st.tone === 'danger' ? 0.78 : 0.6; cT = 0.92; vT = calm ? 1 : 0.85; break;
        case 'lost': vT = 0.7; break;
        case 'two': eT = 0.6; cT = 0.92; vT = 0.85; break;
        case 'end': eT = win ? 1.1 : 0.35; cT = win ? 0.9 : 0.55; vT = 0.6; break;
        default: break;
      }
      lv.energy += (eT - lv.energy) * ease(dt, mode === 'end' ? 500 : 380);
      lv.contour += (cT - lv.contour) * ease(dt, 300);
      lv.vignette += (vT - lv.vignette) * ease(dt, 900);
      lv.breath += ((mode === 'grace' ? 0.7 : calm ? 1 : 0) - lv.breath) * ease(dt, 900);
      lv.trace += ((mode === 'grace' ? 1 : 0) - lv.trace) * ease(dt, mode === 'grace' ? 200 : 450);
      lv.lost += ((mode === 'lost' ? 1 : 0) - lv.lost) * ease(dt, 300);
      const moving = (mode === 'main' || mode === 'two') && st.head !== 'ok';
      lv.move += ((moving ? 1 : 0) - lv.move) * ease(dt, 150);
      if (mode === 'grace') traceP = v.grace > 0 ? clamp(1 - v.grace / M.graceSec, 0, 1) : 0;
      else if (lv.trace > 0.01) traceP = 1; // след растворяется целым контуром

      // Цвета: общий тон и тон глаз
      const eyeTone = mode === 'idle' || mode === 'none' ? 'neutral' : mode === 'end' ? st.tone : st.eyes;
      const k = ease(dt, 320);
      mixTo(col.tone, pal[TONES[mode === 'grace' ? 'ok' : st.tone]], k);
      mixTo(col.eye, pal[TONES[eyeTone]], k);

      // Дыхание: 0 выдох .. 1 вдох; без анимаций (reduced motion) стоит на месте
      if (origin < 0 && started) origin = t;
      const wave = reduced || origin < 0 ? 0.5 : 0.5 - 0.5 * Math.cos((TAU * (t - origin)) / BREATH_MS);
      const b = 0.35 + (wave - 0.35) * (reduced ? 0 : lv.breath);

      if (pi >= 0) pushHist(t, me.cx, me.cy);
      else histN = 0; // лицо пропало: шлейф начнём заново, когда вернётся
      const cxTo = me.ok ? me.cx : W / 2;
      const cyTo = me.ok ? me.cy : H / 2;
      if (vx < 0) {
        vx = cxTo;
        vy = cyTo;
      } else {
        const kv = ease(dt, 400);
        vx += (cxTo - vx) * kv;
        vy += (cyTo - vy) * kv;
      }

      const lw = clamp(me.rw * 0.016, 1.6, 3.2);
      const A = me.alpha;
      g.save();
      g.lineCap = 'round';
      g.lineJoin = 'round';
      vignette(g, W, H, b);
      if (me.ok) {
        if (A > 0.01) aura(g, W, H, lv.energy * A, b);
        ghosts(g, t, A * lv.contour, lw);
        lostGhost(g, t, lw);
        if (A > 0.01) {
          contour(g, A * lv.contour, lw, lv.energy * (5 + 7 * b));
          trace(g, A * lv.trace, lw);
          const eyeA = A * (mode === 'idle' ? 0.7 : 0.95);
          const eyeGlow = (1 - lv.open) * lv.energy * (7 + 5 * b);
          const lwe = clamp(me.rw * 0.02, 1.8, 3.6);
          eye(g, 0, eyeA, lwe, eyeGlow);
          eye(g, 1, eyeA, lwe, eyeGlow);
        }
      }
      stranger(g, W, clamp(other.rw * 0.016, 1.6, 3.2));
      rings(g, t, lw);
      g.restore();

      if (!dom && typeof document !== 'undefined' && d.canvas?.parentElement) dom = mount(d.canvas.parentElement);
      if (dom) sync(v);
    },

    /** Устоявшийся статус (для тестов и отладки): { mode, tone, eyes, head }. */
    get status() {
      return { mode: st.mode, tone: st.tone, eyes: st.eyes, head: st.head };
    },

    /** Убрать чипы (LIVE закрылся: контроллер вызывает в stop()). */
    destroy() {
      dom?.root.remove();
      dom = null;
      ui = {};
      ripples.length = 0;
    },
  };
}
