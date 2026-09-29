// Загрузка моделей MediaPipe (tasks-vision с jsdelivr, модели с storage.googleapis.com).
// Модель грузится один раз и дальше лежит в памяти. Запускает их runner.js.

import { VISION } from '../config.js';
import { bus } from '../bus.js';

let lib = null;
let fileset = null;
const tasks = {};
const pending = {};

const conf = { minTrackingConfidence: 0.5 };
const OPTIONS = {
  pose: (L) => [L.PoseLandmarker, { ...conf, numPoses: 1, minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5 }],
  gesture: (L) => [L.GestureRecognizer, { ...conf, numHands: VISION.numHands, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5 }],
  face: (L) => [L.FaceLandmarker, { ...conf, numFaces: VISION.numFaces, outputFaceBlendshapes: true, minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5 }],
};

async function base() {
  if (!lib) lib = await import(VISION.bundle);
  if (!fileset) fileset = await lib.FilesetResolver.forVisionTasks(VISION.wasm);
  return lib;
}

async function create(name) {
  const L = await base();
  const [Task, opts] = OPTIONS[name](L);
  const make = (delegate) =>
    Task.createFromOptions(fileset, { ...opts, runningMode: 'VIDEO', baseOptions: { modelAssetPath: VISION.models[name], delegate } });
  try {
    return await make(VISION.delegate);
  } catch (err) {
    console.warn(`[vision] ${name}: ${VISION.delegate} не завёлся, пробую CPU`, err);
    return make('CPU');
  }
}

/** Загрузить модель ('pose' | 'gesture' | 'face'). Повторный вызов отдаёт ту же. */
export function load(name) {
  if (tasks[name]) return Promise.resolve(tasks[name]);
  pending[name] ??= create(name)
    .then((task) => {
      tasks[name] = task;
      bus.emit('vision:ready', { model: name });
      return task;
    })
    .catch((err) => {
      delete pending[name];
      bus.emit('vision:error', { model: name, error: err });
      throw err;
    });
  return pending[name];
}

export const get = (name) => tasks[name] || null;
export const isReady = (name) => Boolean(tasks[name]);

/** Фоновая загрузка по очереди, чтобы переключение экранов было мгновенным. */
export async function preload(names) {
  for (const name of names) {
    try {
      await load(name);
    } catch {
      /* ошибку уже отправили в шину */
    }
  }
}
