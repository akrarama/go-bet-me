// Все пороги, тайминги и константы (разделы 5-7 спеки).
// Правило параллельной работы: каждый блок меняет только свою секцию.
// Файл без браузерных API на верхнем уровне, чтобы тесты шли и в jsc.

const search = typeof location !== 'undefined' ? location.search : '';
const param = (name) => {
  const m = new RegExp(`[?&]${name}=([^&]*)`).exec(search);
  return m ? decodeURIComponent(m[1]) : null;
};

/** ?debug=1: горячие клавиши, оверлей с цифрами, видео вместо камеры. */
export const DEBUG = param('debug') === '1';
/**
 * ?video=/fixtures/squat.mov: играть файл вместо камеры (только с ?debug=1).
 * Картинки через запятую (.jpg/.png): слайд-шоу, кадр меняется каждые 2.5 с.
 */
export const DEBUG_VIDEO = DEBUG ? param('video') : null;
/** ?video=none: вообще без камеры, только интерфейс (скрытые вкладки, проверка экранов клавишами). */
export const DEBUG_NO_CAMERA = DEBUG_VIDEO === 'none';
/** ?fast=1: без отсчёта 3-2-1 и пауз перед итогами (только с ?debug=1). */
export const DEBUG_FAST = DEBUG && param('fast') === '1';
/** ?state=LIVE: сразу открыть экран (только с ?debug=1). */
export const DEBUG_STATE = DEBUG ? param('state') : null;
/** ?type=pushup: тип челленджа по умолчанию (только с ?debug=1). */
export const DEBUG_TYPE = DEBUG ? param('type') : null;

// ─── Координатор ────────────────────────────────────────────────

export const APP = {
  cameraLostAfterMs: 1000, // нет новых кадров столько: camera:lost
  voidAfterMs: 5000, // камера пропала дольше: VOID, всем возврат
  countdownSec: DEBUG_FAST ? 0 : 3, // 3, 2, 1 перед стартом LIVE
  resultDelayMs: DEBUG_FAST ? 0 : 1600, // пауза между финишем и экраном итогов
};

const MP = '0.10.35';
export const VISION = {
  bundle: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP}/vision_bundle.mjs`,
  wasm: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP}/wasm`,
  models: {
    pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    gesture: 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task',
    face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  },
  delegate: 'GPU', // если не завёлся, откатываемся на CPU
  numHands: 1,
  numFaces: 2, // второй человек в кадре = нарушение медитации
  preload: ['gesture', 'pose', 'face'], // порядок фоновой загрузки
  staleMs: 400, // результат модели старше этого не рисуем
};

/** Типы челленджей. SETUP берёт варианты отсюда. limitSec: null = без лимита времени. */
export const CHALLENGES = {
  squat: { label: 'Приседания', unit: 'повторы', model: 'pose', emoji: '🏋️', targets: [10, 20, 30], defaultTarget: 10, limitSec: 90 },
  pushup: { label: 'Отжимания', unit: 'повторы', model: 'pose', emoji: '💪', targets: [10, 20, 30], defaultTarget: 20, limitSec: 120 },
  meditation: { label: 'Медитация', unit: 'секунды', model: 'face', emoji: '🧘', targets: [60, 1800], defaultTarget: 60, limitSec: null },
};
export const STAKES = [5, 10, 20];
export const DEFAULT_TYPE = 'squat';
export const DEFAULT_STAKE = 10;

// ─── Блок 1: Упражнения (повторы и режим «Ошибка») ──────────────

export const REPS = {
  emaAlpha: 0.3,
  minVisibility: 0.5,
  fault: { minMs: 400, minFrames: 8, hintMinMs: 1500 },
  pushup: { down: 90, up: 160, halfUpFrom: 120, halfDownFrom: 130, bodyLineMin: 160, minDownToUpMs: 400 },
  squat: { down: 100, up: 160, shallowFrom: 140, kneeOverToeShin: 0.15, torsoLeanMax: 45 },
};

// ─── Блок 2: Жесты и меню ───────────────────────────────────────

export const GESTURES = {
  minScore: 0.6,
  holdMs: 400, // жест держится столько, чтобы сработать
  cooldownMs: 1200, // пауза между срабатываниями
  dwellMs: 1000, // палец на кнопке столько = клик
  handUpMs: 1000, // рука выше головы столько = Старт
  livenessSec: 5,
  livenessTasks: ['left_hand_up', 'right_hand_up', 'Thumb_Up', 'Open_Palm'],
};

// ─── Блок 3: Деньги и друзья ────────────────────────────────────

export const MONEY = {
  APP_FEE: 0.1, // комиссия приложения, менять только здесь
  startBalance: 100,
  storageKey: 'protiv:v1',
  bots: [
    { id: 'bot-dima', name: 'Дима', avatar: '🧔', amount: 5 },
    { id: 'bot-anya', name: 'Аня', avatar: '👩‍🦰', amount: 5 },
  ],
};

// ─── Блок 4: Медитация ──────────────────────────────────────────

export const MEDITATION = {
  eyesClosedMin: 0.5, // (eyeBlinkLeft + eyeBlinkRight) / 2
  headMoveMax: 0.04, // смещение носа за 1 с, доля ширины кадра
  graceSec: 5, // первые секунды нарушения не считаются
  eyesOpenMs: 2000,
  faceLostMs: 2000,
  twoFacesMs: 1000,
  lives: 3,
};
