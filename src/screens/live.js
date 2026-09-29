// LIVE: общий экран челленджа. Владелец: координатор.
// Упражнение подключается как контроллер из src/exercises/<type>.js (createController),
// экран даёт отсчёт 3-2-1, таймер, крупный счётчик, жизни, обрыв камеры → VOID, финиш → RESULT.
//
// Шлёт: live:start {challenge}, count {count, target, unit, type}, live:end {session, challenge}.

import { APP, CHALLENGES } from '../config.js';
import { esc, formatTime } from '../ui.js';

let run = null; // текущий проход экрана

export default {
  model: (ctx) => CHALLENGES[ctx.app.challenge.type].model,

  async enter(ctx) {
    const ch = ctx.app.challenge;
    const def = CHALLENGES[ch.type];
    const r = (run = { ch, def, controller: null, phase: 'loading', t0: 0, shown: -1, lives: null, lostSince: 0 });

    ctx.root.innerHTML = `
      <div class="hud">
        <div class="hud__top">
          <div class="chip chip--lg timer" data-timer>${def.limitSec ? formatTime(def.limitSec) : '00:00'}</div>
          <div class="chip">На кону ${ch.stake} кр.</div>
        </div>
        <div class="hud__counter">
          <div class="hud__label">${esc(def.emoji)} ${esc(def.label)}</div>
          <div class="counter"><span data-count>0</span><span class="counter__target">/${ch.target}</span></div>
          <div class="progress"><div class="progress__bar" data-progress></div></div>
          <div class="lives" data-lives hidden></div>
        </div>
        <div class="countdown" data-countdown hidden></div>
        <div class="lost" data-lost hidden>
          <div class="lost__title">Камера пропала</div>
          <div class="lost__count" data-lost-count></div>
          <div class="lost__text">Вернись в кадр, иначе челлендж отменится и всем вернут ставки</div>
        </div>
        <div class="finale" data-finale hidden></div>
      </div>`;
    const q = (sel) => ctx.root.querySelector(sel);
    r.els = {
      timer: q('[data-timer]'), count: q('[data-count]'), progress: q('[data-progress]'), lives: q('[data-lives]'),
      countdown: q('[data-countdown]'), lost: q('[data-lost]'), lostCount: q('[data-lost-count]'), finale: q('[data-finale]'),
    };

    ctx.on('camera:lost', ({ since }) => {
      r.lostSince = since ?? performance.now();
      r.els.lost.hidden = false;
    });
    ctx.on('camera:back', () => {
      r.lostSince = 0;
      r.els.lost.hidden = true;
    });
    ctx.on('debug:finish', ({ success }) => finish(ctx, r, success ? 'forced-success' : 'forced-fail'));
    ctx.on('debug:count', () => {
      if (r.controller) r.controller.count += 1;
    });
    ctx.interval(() => tick(ctx, r), 200);

    const mod = await import(`../exercises/${ch.type}.js`);
    if (run !== r) return; // ушли с экрана, пока грузили
    r.controller = mod.createController({ challenge: ch, bus: ctx.bus, feedback: ctx.feedback, debug: ctx.debug });
    ctx.vision.use(r.controller.model);
    render(ctx, r);

    r.phase = 'countdown';
    await countdown(ctx, r);
    if (run !== r || r.phase !== 'countdown') return;
    r.phase = 'live';
    r.t0 = performance.now();
    r.controller.start?.(r.t0);
    ctx.bus.emit('live:start', { challenge: ch });
  },

  frame(frame, ctx) {
    const r = run;
    if (!r?.controller || r.phase !== 'live' || frame.ran !== r.controller.model) return;
    r.controller.frame(frame, frame.t);
    render(ctx, r);
    if (r.controller.failed) finish(ctx, r, 'failed');
    else if (r.controller.done) finish(ctx, r, 'target');
  },

  exit() {
    run?.controller?.stop?.();
    run = null;
  },
};

function countdown(ctx, r) {
  return new Promise((resolve) => {
    let n = APP.countdownSec;
    const step = () => {
      if (run !== r) return resolve();
      if (n === 0) {
        r.els.countdown.hidden = true;
        ctx.feedback.say('Старт');
        return resolve();
      }
      r.els.countdown.hidden = false;
      r.els.countdown.innerHTML = `<span>${n}</span>`;
      ctx.feedback.say(String(n));
      n -= 1;
      ctx.timeout(step, 1000);
    };
    step();
  });
}

function render(ctx, r) {
  const c = r.controller;
  const count = Math.floor(c.count);
  if (count !== r.shown) {
    const up = r.shown >= 0 && count > r.shown;
    r.shown = count;
    r.els.count.textContent = count;
    r.els.progress.style.transform = `scaleX(${Math.min(1, count / r.ch.target)})`;
    if (up) {
      const el = r.els.count.parentElement;
      el.classList.remove('is-bump');
      void el.offsetWidth;
      el.classList.add('is-bump');
      ctx.bus.emit('count', { count, target: r.ch.target, unit: c.unit, type: r.ch.type });
    }
  }
  if (c.lives != null && c.lives !== r.lives) {
    r.lives = c.lives;
    const total = Math.max(c.maxLives ?? c.lives, c.lives);
    r.els.lives.hidden = false;
    r.els.lives.innerHTML = Array.from({ length: total }, (_, i) => `<span class="life${i < c.lives ? '' : ' is-lost'}">♥</span>`).join('');
  }
}

function tick(ctx, r) {
  const now = performance.now();
  if (r.lostSince && r.phase !== 'done') {
    const left = APP.voidAfterMs - (now - r.lostSince);
    r.els.lostCount.textContent = Math.max(0, Math.ceil(left / 1000));
    if (left <= 0) {
      r.phase = 'done';
      ctx.bus.emit('live:void', { challenge: r.ch, reason: 'camera' });
      ctx.app.go('VOID', { reason: 'camera' });
      return;
    }
  }
  if (r.phase !== 'live') return;
  const elapsed = (now - r.t0) / 1000;
  if (r.def.limitSec) {
    const left = r.def.limitSec - elapsed;
    r.els.timer.textContent = formatTime(left);
    r.els.timer.classList.toggle('is-low', left <= 10);
    if (left <= 0) finish(ctx, r, 'time');
  } else {
    r.els.timer.textContent = formatTime(elapsed);
  }
}

function finish(ctx, r, reason) {
  if (r.phase === 'done' || !r.controller) return;
  const wasLive = r.phase === 'live';
  r.phase = 'done';
  const c = r.controller;
  const success = reason === 'forced-success' || (reason === 'target' && !c.failed);
  const summary = c.summary?.() ?? {};
  const endedAt = performance.now();
  const session = {
    challengeId: r.ch.id,
    type: r.ch.type,
    target: r.ch.target,
    count: Math.floor(c.count),
    success,
    reason, // 'target' | 'time' | 'failed' | 'forced-success' | 'forced-fail'
    durationSec: wasLive ? Math.round((endedAt - r.t0) / 100) / 10 : 0,
    faults: summary.faults ?? [],
    rejected: summary.rejected ?? [],
    extra: summary.extra ?? null,
  };
  ctx.app.session = session;
  ctx.bus.emit('live:end', { session, challenge: r.ch });
  ctx.feedback.clearNow();
  ctx.feedback.say(success ? 'Есть! Цель выполнена' : 'Не получилось');
  r.els.countdown.hidden = true;
  r.els.finale.hidden = false;
  r.els.finale.dataset.success = success;
  r.els.finale.textContent = success ? 'Сделал!' : 'Не успел';
  ctx.timeout(() => ctx.app.go('RESULT'), APP.resultDelayMs);
}
