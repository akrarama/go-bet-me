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
  voice: false, // озвучка подсказок выключена: тестерам мешал роботизированный голос, вместо неё звуки (sound.js)
  cameraLostAfterMs: 2000, // нет новых кадров столько (вкладка видна): camera:lost
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
  emaAlpha: 0.3, // на кадр при 30 fps; при другой частоте пересчитывается по времени кадра
  frameMs: 1000 / 30,
  minVisibility: 0.5,
  turnDeg: 12, // угол ушёл от крайней точки на столько: движение развернулось (полуповторы, глубина)
  armMs: 300, // счёт начинается, когда верхняя точка (стойка, руки прямые) держится столько
  gateResetFrames: 2, // поза не для счёта (стоит, прыгает) столько кадров подряд: начатый повтор сброшен
  fault: {
    minMs: 400, // правило по кадру срабатывает, если условие держится столько
    minFrames: 8, // ...или столько кадров подряд, что наступит раньше
    releaseMs: 300, // условие пропало на столько: правило отпускает
    hintMinMs: 1500, // подсказка на экране не короче
    hintTtlMs: 2600, // разовая подсказка (полуповтор, темп) уходит сама
  },
  pushup: {
    down: 90, up: 160, halfUpFrom: 120, halfDownFrom: 130, bodyLineMin: 160, minDownToUpMs: 400,
    plankMaxTilt: 35, // упор лёжа: линия плечо-щиколотка к горизонтали не круче, градусы
    wristAboveMax: 0.02, // запястье выше плеча не больше чем на столько (доля высоты кадра): кисти на полу
  },
  squat: {
    down: 100, up: 160, shallowFrom: 140, halfUpFrom: 120, kneeOverToeShin: 0.15, torsoLeanMax: 45,
    bottomZoneDeg: 15, // «нижняя точка» для наклона спины: угол колена до down + столько
    sideFootMin: 0.2, // правило про носки только сбоку: стопа вбок хотя бы на столько длин голени
    uprightMaxLean: 70, // стоя: плечи над тазом и корпус к вертикали не больше, градусы
    jumpRise: 0.05, // щиколотки выше своей линии пола на столько (доля высоты кадра): прыжок
    floorDriftMs: 1500, // линия пола плавно подстраивается (подошёл ближе или отошёл)
    floorResetMs: 1500, // ноги выше линии дольше этого: это не прыжок, линия пола переезжает
    missDelayMs: 450, // мелкий присед засчитываем как ошибку, если за это время не было прыжка
  },
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
  storageKey: 'protiv:v1', // wallet.js добавляет путь страницы: у каждой копии на localhost свой кошелёк
  historyMax: 30, // сколько записей истории хранить
  // female: глаголы в репликах и тостах в женском роде («поставила»)
  bots: [
    { id: 'bot-dima', name: 'Дима', avatar: '🧔', amount: 5 },
    { id: 'bot-anya', name: 'Аня', avatar: '👩‍🦰', amount: 5, female: true },
  ],
  botDelayMs: [1000, 2000], // бот приходит через 1-2 с после входа в LOBBY или после предыдущего бота
  feed: {
    max: 4, // реплик в ленте одновременно
    ttlMs: 9000, // реплика гаснет через столько
    gapMs: 1800, // между репликами не меньше
    repsEvery: 5, // реплика каждые 5 повторов
    secondsEvery: 15, // в медитации: каждые 15 с
    faultCooldownMs: 5000, // подкол на ошибку не чаще
  },
};

// ─── Блок 4: Медитация ──────────────────────────────────────────

export const MEDITATION = {
  eyesClosedMin: 0.5, // (eyeBlinkLeft + eyeBlinkRight) / 2
  eyesHysteresis: 0.08, // закрытые глаза считаем открытыми, только когда ниже eyesClosedMin − это (не мигает на пороге)
  eyesEma: 0.5, // сглаживание моргания
  headMoveMax: 0.04, // смещение носа за 1 с, доля ширины кадра
  headWindowMs: 1000,
  headMoveMs: 400, // голова двигается столько или headMoveFrames кадров подряд = нарушение
  headMoveFrames: 8,
  graceSec: 5, // первые секунды нарушения не считаются
  eyesOpenMs: 2000,
  faceLostMs: 2000,
  twoFacesMs: 1000,
  gapMs: 400, // короткий сбой (моргнул, кадр без лица) не сбрасывает накопленное время нарушения
  fixedMs: 1000, // нарушения нет столько = исправлено, дальше оно снова может списать жизнь
  cooldownMs: 3000, // после нарушения время исправиться: другое нарушение ждёт и спишет жизнь, если не исправлено
  maxFrameGapMs: 700, // кадров не было дольше (камера, вкладка): это время не считаем, окна начинаем заново
  introDelayMs: 1000, // «Закрой глаза и замри» после «Старт», чтобы не перебить его
  failDelayMs: 1500, // последняя жизнь: даём увидеть и услышать подсказку, потом провал
  lives: 3,
};
