// Цикл распознавания: на каждый новый кадр видео запускается ОДНА модель.
// vision.use('pose') или vision.use(['gesture', 'pose']) (по очереди через кадр).
// Экран сам говорит, что ему нужно (поле model у экрана), app.go() вызывает use().
//
// Каждый кадр подписчики получают frame:
// {
//   t,                 // performance.now() этого кадра, мс
//   ran,               // какая модель отработала на этом кадре: 'pose' | 'gesture' | 'face' | null
//   width, height,     // размер кадра видео, px (для углов: aspect = width / height)
//   pose:    { t, landmarks: [33 точки {x,y,z,visibility}] | null, world } | null,
//   gesture: { t, hands: [{ landmarks: [21 точка], handedness, gesture, score }] } | null,
//   face:    { t, faces: [[478 точек], ...], blendshapes: [{ eyeBlinkLeft: 0..1, ... }, ...] } | null,
// }
// pose/gesture/face: последний известный результат каждой модели (у каждого свой t).

import * as models from './models.js';
import { camera } from '../camera.js';
import { debug } from '../debug.js';

const listeners = new Set();
const latest = { pose: null, gesture: null, face: null };
const ms = { pose: 0, gesture: 0, face: 0 };
let active = [];
let turn = 0;
let running = false;
let lastVideoTime = -1;
let frames = 0;
let fpsFrom = 0;

const normalize = {
  pose: (r, t) => ({ t, landmarks: r.landmarks?.[0] ?? null, world: r.worldLandmarks?.[0] ?? null }),
  gesture: (r, t) => ({
    t,
    hands: (r.landmarks ?? []).map((landmarks, i) => ({
      landmarks,
      handedness: r.handedness?.[i]?.[0]?.categoryName ?? null,
      gesture: r.gestures?.[i]?.[0]?.categoryName ?? 'None',
      score: r.gestures?.[i]?.[0]?.score ?? 0,
    })),
  }),
  face: (r, t) => ({
    t,
    faces: r.faceLandmarks ?? [],
    blendshapes: (r.faceBlendshapes ?? []).map((b) => Object.fromEntries(b.categories.map((c) => [c.categoryName, c.score]))),
  }),
};

export const vision = {
  latest,

  get active() {
    return active;
  },

  use(which) {
    const next = Array.isArray(which) ? which : which && which !== 'none' ? [which] : [];
    if (next.join() === active.join()) return;
    active = next;
    turn = 0;
    for (const name of active) models.load(name).catch(() => {});
    debug.set('модели', active.join(' + ') || 'нет');
  },

  onFrame(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  ready: (name) => models.load(name),
  isReady: (name) => models.isReady(name),

  start() {
    if (running) return;
    running = true;
    fpsFrom = performance.now();
    requestAnimationFrame(tick);
  },

  stop() {
    running = false;
  },
};

/** Следующая загруженная модель из активных, по кругу. */
function pick() {
  for (let k = 0; k < active.length; k++) {
    const name = active[(turn + k) % active.length];
    if (models.isReady(name)) {
      turn = turn + k + 1;
      return name;
    }
  }
  return null;
}

function tick() {
  if (!running) return;
  requestAnimationFrame(tick);

  const video = camera.video;
  if (!video || video.readyState < 2 || camera.frozen) return;
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  const t = performance.now();
  const name = pick();
  let ran = null;
  if (name) {
    try {
      const task = models.get(name);
      const res = name === 'gesture' ? task.recognizeForVideo(video, t) : task.detectForVideo(video, t);
      latest[name] = normalize[name](res, t);
      ran = name;
      ms[name] = ms[name] ? ms[name] * 0.9 + (performance.now() - t) * 0.1 : performance.now() - t;
    } catch (err) {
      console.error(`[vision] ${name}`, err);
    }
  }

  const frame = { t, ran, width: video.videoWidth, height: video.videoHeight, ...latest };
  for (const fn of listeners) {
    try {
      fn(frame);
    } catch (err) {
      console.error('[vision] подписчик кадра', err);
    }
  }

  frames++;
  if (t - fpsFrom >= 1000) {
    debug.set('fps', Math.round((frames * 1000) / (t - fpsFrom)));
    debug.set('мс на кадр', active.map((n) => `${n} ${Math.round(ms[n])}`).join(', '));
    frames = 0;
    fpsFrom = t;
  }
}
