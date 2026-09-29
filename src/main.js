// Точка входа: камера, модели, экраны, отрисовка каждого кадра. Владелец: координатор.

import * as config from './config.js';
import { DEBUG, DEBUG_STATE, VISION, CHALLENGES } from './config.js';
import { app, STATES } from './app.js';
import { bus } from './bus.js';
import { camera } from './camera.js';
import { vision } from './vision/runner.js';
import * as models from './vision/models.js';
import { gestures } from './vision/gestures.js';
import { draw } from './draw.js';
import { feedback } from './feedback.js';
import { debug } from './debug.js';
import { ui, $ } from './ui.js';
import { dwell } from './ui/dwell.js';
import { wallet } from './wallet.js';
import { bots } from './friends/bots.js';

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
  debug.key('t', () => {
    const types = Object.keys(CHALLENGES);
    const next = types[(types.indexOf(app.challenge.type) + 1) % types.length];
    app.challenge = app.newChallenge(next);
    ui.toast(`Тип: ${CHALLENGES[next].label}`);
  }, 'сменить тип челленджа');
}

function onFrame(ctx, frame) {
  const screen = app.screen();
  screen?.frame?.(frame, ctx);
  draw.clear();
  if (screen?.draw) screen.draw(frame, ctx);
  else draw.auto(frame, { highlight: feedback.highlight });
}

async function boot() {
  const ctx = makeContext();
  app.init(ctx);
  for (const [name, screen] of Object.entries(SCREENS)) app.register(name, screen);
  draw.init($('#overlay'));
  feedback.mount($('#hint'));
  debug.mount($('#debug'));
  guardInput();

  ui.loader.show('Включаю камеру');
  try {
    await camera.start($('#video'));
  } catch (err) {
    console.error(err);
    return ui.fatal(...cameraError(err));
  }
  $('#stage').classList.toggle('is-mirrored', camera.mirror);
  draw.resize();

  ui.loader.show('Загружаю распознавание');
  vision.onFrame((frame) => onFrame(ctx, frame));
  vision.start();
  vision.use('gesture');
  try {
    await vision.ready('gesture');
  } catch (err) {
    console.error(err);
    return ui.fatal('Распознавание не загрузилось', 'Проверь интернет и обнови страницу.');
  }
  models.preload(VISION.preload); // остальные модели в фоне

  gestures.start(ctx);
  dwell.start(ctx);
  wallet.init(ctx);
  bots.init(ctx);
  debugKeys();

  ui.loader.hide();
  app.go(DEBUG_STATE && SCREENS[DEBUG_STATE] ? DEBUG_STATE : 'IDLE');
}

boot();
