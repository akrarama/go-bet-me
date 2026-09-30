// Машина состояний: IDLE → SETUP → LOBBY → LIVENESS → LIVE → RESULT (или VOID).
// Экран: { model, enter(ctx, params), frame(frame, ctx), draw(frame, ctx), exit(ctx) }
//   model: 'gesture' | 'pose' | 'face' | ['gesture', 'pose'] | null (без моделей) | (ctx) => одно из этого
//   enter  рисует разметку в ctx.root и подписывается через ctx.on / ctx.timeout / ctx.interval
//   frame  каждый кадр распознавания (необязательно)
//   draw   своя отрисовка поверх видео вместо стандартной (необязательно)
//   exit   уборка (подписки ctx.on/timeout/interval снимаются сами)

import { bus } from './bus.js';
import { CHALLENGES, DEFAULT_TYPE, DEFAULT_STAKE, DEBUG_TYPE } from './config.js';

export const STATES = ['IDLE', 'SETUP', 'LOBBY', 'LIVENESS', 'LIVE', 'RESULT', 'VOID'];

/**
 * Челлендж, который настраивается в SETUP и играется в LIVE.
 * bets: ставки против [{ id, name, avatar, amount, bot }], сумма не больше stake.
 */
export function newChallenge(type = DEBUG_TYPE && CHALLENGES[DEBUG_TYPE] ? DEBUG_TYPE : DEFAULT_TYPE, overrides = {}) {
  const def = CHALLENGES[type];
  return {
    id: Math.random().toString(36).slice(2, 10),
    type,
    target: def.defaultTarget,
    limitSec: def.limitSec,
    stake: DEFAULT_STAKE,
    bets: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

const screens = new Map();
let ctx = null;
let busy = false;
let queued = null;

export const app = {
  state: null,
  params: {},
  challenge: newChallenge(),
  /** Итог последнего LIVE (формат: CLAUDE.md, раздел 12). */
  session: null,
  newChallenge,

  init(context) {
    ctx = context;
  },

  register(name, screen) {
    screens.set(name, screen);
  },

  screen(name = app.state) {
    return screens.get(name);
  },

  go(name, params = {}) {
    if (!screens.has(name)) throw new Error(`Нет экрана ${name}`);
    if (busy) {
      queued = [name, params];
      return;
    }
    busy = true;
    const from = app.state;
    try {
      screens.get(from)?.exit?.(ctx);
    } catch (err) {
      console.error(`[app] ${from}.exit`, err);
    }
    ctx.offScreen();
    ctx.feedback.clearNow();

    app.state = name;
    app.params = params;
    const next = screens.get(name);
    const model = typeof next.model === 'function' ? next.model(ctx) : next.model;
    ctx.vision.use(model === undefined ? 'gesture' : model); // null или 'none': без моделей (экран друга)
    document.body.dataset.state = name;
    ctx.root.innerHTML = '';
    ctx.root.className = `screen screen--${name.toLowerCase()}`;
    void ctx.root.offsetWidth; // перезапуск анимации появления
    ctx.root.classList.add('is-entering');
    ctx.debug.set('экран', name);

    try {
      const r = next.enter?.(ctx, params);
      if (r?.catch) r.catch((err) => console.error(`[app] ${name}.enter`, err));
    } catch (err) {
      console.error(`[app] ${name}.enter`, err);
    }
    bus.emit('state', { from, to: name, params });
    busy = false;
    if (queued) {
      const [n, p] = queued;
      queued = null;
      app.go(n, p);
    }
  },
};
