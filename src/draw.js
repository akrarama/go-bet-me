// Слой поверх видео: скелет, руки, лицо, красные проблемные суставы.
// draw.project(p) переводит нормализованную точку кадра в CSS px экрана
// (учитывает object-fit: cover и зеркало). Им же пользуется палец-курсор.

import { camera } from './camera.js';
import { VISION } from './config.js';

const POSE_BONES = [
  [11, 12], [11, 13], [13, 15], [15, 19], [12, 14], [14, 16], [16, 20],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
];
const POSE_JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32];
const HAND_BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

export const COLORS = {
  bone: 'rgba(255, 255, 255, 0.92)',
  joint: '#d4ff3a',
  bad: '#ff4d4f',
  dim: 'rgba(255, 255, 255, 0.28)',
  shadow: 'rgba(0, 0, 0, 0.5)',
};

export const draw = {
  canvas: null,
  ctx: null,
  w: 0,
  h: 0,

  init(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    addEventListener('resize', () => this.resize());
    this.resize();
  },

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  },

  /** Нормализованная точка кадра → {x, y} в CSS px экрана. */
  project(p) {
    const v = camera.video;
    const vw = v?.videoWidth || 16;
    const vh = v?.videoHeight || 9;
    const s = Math.max(this.w / vw, this.h / vh);
    const x = (this.w - vw * s) / 2 + p.x * vw * s;
    const y = (this.h - vh * s) / 2 + p.y * vh * s;
    return { x: camera.mirror ? this.w - x : x, y };
  },

  clear() {
    this.ctx.clearRect(0, 0, this.w, this.h);
  },

  /** Рисует всё свежее из кадра: скелет, руки, лицо. highlight: Set индексов позы (красные). */
  auto(frame, { highlight } = {}) {
    const fresh = (r) => r && frame.t - r.t <= VISION.staleMs;
    if (fresh(frame.face)) this.face(frame.face.faces);
    if (fresh(frame.pose) && frame.pose.landmarks) this.pose(frame.pose.landmarks, { highlight });
    if (fresh(frame.gesture)) this.hands(frame.gesture.hands);
  },

  pose(lm, { highlight = new Set(), minVisibility = 0.5 } = {}) {
    const c = this.ctx;
    const P = lm.map((p) => this.project(p));
    const vis = (i) => lm[i].visibility ?? 1;
    const pulse = (Math.sin(performance.now() / 140) + 1) / 2;
    c.save();
    c.lineCap = 'round';
    c.shadowColor = COLORS.shadow;
    c.shadowBlur = 8;
    for (const [a, b] of POSE_BONES) {
      const bad = highlight.has(a) || highlight.has(b);
      c.strokeStyle = bad ? COLORS.bad : Math.min(vis(a), vis(b)) < minVisibility ? COLORS.dim : COLORS.bone;
      c.lineWidth = bad ? 7 : 5;
      c.beginPath();
      c.moveTo(P[a].x, P[a].y);
      c.lineTo(P[b].x, P[b].y);
      c.stroke();
    }
    for (const i of POSE_JOINTS) {
      const bad = highlight.has(i);
      const { x, y } = P[i];
      if (bad) {
        c.fillStyle = `rgba(255, 77, 79, ${0.35 * (1 - pulse)})`;
        c.beginPath();
        c.arc(x, y, 10 + 12 * pulse, 0, Math.PI * 2);
        c.fill();
      }
      c.fillStyle = bad ? COLORS.bad : vis(i) < minVisibility ? COLORS.dim : COLORS.joint;
      c.beginPath();
      c.arc(x, y, bad ? 9 : i === 0 ? 5 : 6, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  },

  hands(hands = []) {
    const c = this.ctx;
    c.save();
    c.lineCap = 'round';
    c.shadowColor = COLORS.shadow;
    c.shadowBlur = 6;
    for (const hand of hands) {
      const P = hand.landmarks.map((p) => this.project(p));
      c.strokeStyle = COLORS.bone;
      c.lineWidth = 3;
      for (const [a, b] of HAND_BONES) {
        c.beginPath();
        c.moveTo(P[a].x, P[a].y);
        c.lineTo(P[b].x, P[b].y);
        c.stroke();
      }
      c.fillStyle = COLORS.joint;
      for (const { x, y } of P) {
        c.beginPath();
        c.arc(x, y, 3.5, 0, Math.PI * 2);
        c.fill();
      }
    }
    c.restore();
  },

  /** Лицо точками. Второе лицо красным (в медитации это нарушение). */
  face(faces = []) {
    const c = this.ctx;
    c.save();
    faces.forEach((f, k) => {
      c.fillStyle = k === 0 ? 'rgba(255, 255, 255, 0.55)' : 'rgba(255, 77, 79, 0.85)';
      for (let i = 0; i < f.length; i += 3) {
        const { x, y } = this.project(f[i]);
        c.fillRect(x - 1, y - 1, 2, 2);
      }
    });
    c.restore();
  },
};
