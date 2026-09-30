// Точка входа: камера, модели, экраны, отрисовка каждого кадра. Владелец: координатор.

import * as config from './config.js';
import { DEBUG, DEBUG_STATE, CHALLENGES, JOIN_ID } from './config.js';
import { app, STATES } from './app.js';
import { bus } from './bus.js';
import { camera } from './camera.js';
import { vision } from './vision/runner.js';
import { gestures } from './vision/gestures.js';
import { draw } from './draw.js';
import { feedback } from './feedback.js';
import { sound } from './sound.js';
import { debug } from './debug.js';
import { ui, $ } from './ui.js';
import { dwell } from './ui/dwell.js';
import { wallet } from './wallet.js';
import { bots } from './friends/bots.js';
import { installHost } from './friends/peer.js';
import { requireAccount } from './account.js';

import idle from './screens/idle.js';
import setup from './screens/setup.js';
import lobby from './screens/lobby.js';
import liveness from './screens/liveness.js';
import live from './screens/live.js';
import result from './screens/result.js';
import voidScreen from './screens/void.js';

const SCREENS = { IDLE: idle, SETUP: setup, LOBBY: lobby, LIVENESS: liveness, LIVE: live, RESULT: result, VOID: voidScreen };

/** Общий контекст, который получает каждый экран. */
function makeContext() {
  const scoped = [];
  return {
    app, bus, vision, feedback, draw, ui, debug, camera, config,
    root: $('#screen'),
    /** Подписка на шину, снимется сама при смене экрана. */
    on(type, fn) {
      const off = bus.on(type, fn);
      scoped.push(off);
      return off;
    },
    timeout(fn, ms) {
      const id = setTimeout(fn, ms);
      scoped.push(() => clearTimeout(id));
      return id;
    },
    interval(fn, ms) {
      const id = setInterval(fn, ms);
      scoped.push(() => clearInterval(id));
      return id;
    },
    offScreen() {
      while (scoped.length) scoped.pop()();
    },
  };
}

function cameraError(err) {
  const name = err?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return ['Нужен доступ к камере', 'Разреши камеру в адресной строке браузера и обнови страницу. Видео не уходит с устройства, всё считается в браузере.'];
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return ['Камера не найдена', 'Подключи веб-камеру и обнови страницу.'];
  if (name === 'NotReadableError') return ['Камера занята', 'Закрой приложения, которые сейчас используют камеру, и обнови страницу.'];
  return ['Камера не включилась', String(err?.message || err)];
}

/** Звук включается после первого касания. Настоящие клики мышью работают только в ?debug=1. */
function guardInput() {
  const unlock = () => {
    sound.unlock();
    feedback.unlockAudio();
    document.body.classList.add('is-audio-on');
  };
  addEventListener('pointerdown', unlock, { capture: true });
  addEventListener('keydown', unlock, { capture: true });
  if (!DEBUG) {
    addEventListener('click', (e) => {
      if (e.isTrusted && e.target.closest?.('[data-dwell]')) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  }
}

function debugKeys() {
  STATES.forEach((s, i) => debug.key(String(i + 1), () => app.go(s), `экран ${s}`));
  const g = (name) => () => bus.emit('gesture', { name, source: 'debug' });
  debug.key('u', g('Thumb_Up'), '👍 Thumb_Up');
  debug.key('d', g('Thumb_Down'), '👎 Thumb_Down');
  debug.key('o', g('Open_Palm'), '🖐 Open_Palm');
  debug.key('i', g('Pointing_Up'), '☝️ Pointing_Up');
  debug.key('h', () => bus.emit('handup', { side: 'right', source: 'debug' }), 'рука над головой');
  debug.key('s', () => bus.emit('debug:finish', { success: true }), 'LIVE: финиш, сделал');
  debug.key('x', () => bus.emit('debug:finish', { success: false }), 'LIVE: финиш, не сделал');
  debug.key('r', () => bus.emit('debug:count'), 'LIVE: +1 к счёту');
  debug.key('v', () => camera.freeze(), 'обрыв камеры вкл/выкл');
  debug.key(' ', () => (camera.video.paused ? camera.video.play() : camera.video.pause()), 'пауза видео');
  debug.key('g', saveRecording, 'записать позу за 20 с в fixtures/traces');
  debug.key('t', () => {
    const types = Object.keys(CHALLENGES);
    const next = types[(types.indexOf(app.challenge.type) + 1) % types.length];
    app.challenge = app.newChallenge(next);
    ui.toast(`Тип: ${CHALLENGES[next].label}`);
  }, 'сменить тип челленджа');
}

// Запись позы для разбора (только ?debug=1): последние 20 с точек скелета, клавиша g сохраняет в
// fixtures/traces/live-<время>.json (через tools/serve.py). Формат как у трасс роликов, t у каждого кадра.
const REC_MS = 20000;
const rec = [];
let recLast = null;
function record(frame) {
  const pose = frame.pose;
  if (!pose?.landmarks || pose.landmarks === recLast) return;
  recLast = pose.landmarks;
  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  rec.push({ t: Math.round(pose.t), w: frame.width, h: frame.height, lm: pose.landmarks.map((p) => [r4(p.x), r4(p.y), r4(p.z ?? 0), r4(p.visibility ?? 0)]) });
  while (rec.length && rec[rec.length - 1].t - rec[0].t > REC_MS) rec.shift();
}
async function saveRecording() {
  if (rec.length < 2) return ui.toast('Поза ещё не записана');
  const span = (rec[rec.length - 1].t - rec[0].t) / 1000;
  const name = `live-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;
  const data = {
    input: { source: 'camera', type: app.challenge?.type, fps: Math.round(((rec.length - 1) / span) * 10) / 10, count: rec.length, width: rec[0].w, height: rec[0].h, seconds: span },
    frames: rec.map((f) => ({ t: f.t, lm: f.lm })),
  };
  const res = await fetch(`/__save?path=fixtures/traces/${name}.json`, { method: 'POST', body: JSON.stringify(data) }).catch(() => null);
  ui.toast(res?.ok ? `Записано: ${name} (${Math.round(span)} с)` : 'Не сохранилось: нужен tools/serve.py');
}

function onFrame(ctx, frame) {
  if (DEBUG) record(frame);
  const screen = app.screen();
  screen?.frame?.(frame, ctx);
  draw.clear();
  if (screen?.draw) screen.draw(frame, ctx);
  else draw.auto(frame, { highlight: feedback.highlight });
}

async function boot() {
  ui.loader.show('Проверяю аккаунт');
  // Модель жестов (несколько МБ + wasm) не зависит от входа: качаем её, пока человек вводит логин и пароль.
  // Тогда после регистрации остаётся только включить камеру.
  if (!JOIN_ID) {
    vision.start();
    vision.use('gesture');
  }
  if (!JOIN_ID && await requireAccount()) return;
  const ctx = makeContext();
  app.init(ctx);
  for (const [name, screen] of Object.entries(SCREENS)) app.register(name, screen);
  draw.init($('#overlay'));
  feedback.mount($('#hint'));
  debug.mount($('#debug'));
  guardInput();

  // Camera permission/startup and the first hand model are independent. Fetch them together
  // so cold start takes the slower of the two instead of adding both delays.
  ui.loader.show('Подключаю камеру и запускаю распознавание');
  const offProgress = bus.on('vision:progress', ({ model, loaded, total }) => {
    if (model !== 'gesture') return;
    if (total && loaded >= total) return ui.loader.show('Запускаю распознавание');
    ui.loader.show(total ? `Загружаю распознавание · ${Math.min(99, Math.floor((loaded / total) * 100))}%` : 'Загружаю распознавание');
  });
  vision.onFrame((frame) => onFrame(ctx, frame));
  vision.start();
  vision.use('gesture');
  const cameraReady = camera.start($('#video'));
  const gestureReady = vision.ready('gesture');
  gestureReady.catch(() => {}); // camera failure may return before the model promise is awaited
  try {
    await cameraReady;
  } catch (err) {
    console.error(err);
    offProgress();
    return ui.fatal(...cameraError(err));
  }
  $('#stage').classList.toggle('is-mirrored', camera.mirror);
  draw.resize();
  try {
    await gestureReady;
  } catch (err) {
    console.error(err);
    return ui.fatal('Распознавание не загрузилось', 'Проверь интернет и обнови страницу.');
  } finally {
    offProgress();
  }

  gestures.start(ctx);
  dwell.start(ctx);
  wallet.init(ctx);
  bots.init(ctx);
  installHost({ bus, app, camera }); // друг по ссылке (P1): Peer создаётся при первом входе в LOBBY
  debugKeys();

  ui.loader.hide();
  app.go(DEBUG_STATE && SCREENS[DEBUG_STATE] ? DEBUG_STATE : 'IDLE');
}

/** Страница друга по ссылке ?join=<id> (P1): без камеры и моделей, только экран FRIEND (раздел 14.2). */
async function bootFriend(hostId) {
  const ctx = makeContext();
  app.init(ctx);
  debug.mount($('#debug'));
  guardInput();
  document.body.classList.add('is-friend');
  ui.loader.show('Открываю челлендж друга');
  try {
    const { default: friend } = await import('./screens/friend.js');
    app.register('FRIEND', friend);
  } catch (err) {
    console.error(err);
    return ui.fatal('Ссылка не открылась', 'Обнови страницу или попроси у друга новую ссылку.');
  }
  ui.loader.hide();
  app.go('FRIEND', { hostId });
}

if (JOIN_ID) bootFriend(JOIN_ID);
else boot();
