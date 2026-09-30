// LIVE: общий экран челленджа. Владелец: координатор.
// Упражнение подключается как контроллер из src/exercises/<type>.js (createController),
// экран даёт «Встань в позицию» (если у контроллера есть ready), отсчёт 3-2-1, таймер, крупный счётчик,
// жизни, обрыв камеры → VOID, финиш → RESULT.
// Фазы: loading → position → countdown → live → done. Ставка списывается на live:start,
// поэтому до него обрыв камеры не отменяет челлендж, а возвращает в LOBBY.
//
// Шлёт: live:start {challenge}, count {count, target, unit, type}, live:end {session, challenge}.

import { APP, CHALLENGES } from '../config.js';
import { esc, formatTime } from '../ui.js';
import { sound } from '../sound.js';

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
          <ul class="rejects" data-rejects></ul>
        </div>
        <div class="position" data-position hidden style="--hold: ${APP.readyHoldMs}ms">
          <div class="position__title position__title--wait">Встань в позицию</div>
          <div class="position__title position__title--ready">Отлично, замри</div>
          <div class="position__place">${esc(def.placement ?? '')}</div>
          <ul class="position__checks" data-checks></ul>
          <div class="position__hold" aria-hidden="true"></div>
        </div>
        <div class="countdown" data-countdown hidden></div>
        <div class="lost" data-lost hidden>
          <div class="lost__title">Камера пропала</div>
          <div class="lost__count" data-lost-count></div>
          <div class="lost__text" data-lost-text></div>
        </div>
        <div class="finale" data-finale hidden></div>
      </div>`;
    const q = (sel) => ctx.root.querySelector(sel);
    r.els = {
      timer: q('[data-timer]'), count: q('[data-count]'), progress: q('[data-progress]'), lives: q('[data-lives]'),
      countdown: q('[data-countdown]'), lost: q('[data-lost]'), lostCount: q('[data-lost-count]'), finale: q('[data-finale]'),
      rejects: q('[data-rejects]'), position: q('[data-position]'), checks: q('[data-checks]'), lostText: q('[data-lost-text]'),
    };

    // Лог незасчитанных повторов: последние три
    ctx.on('rejected', ({ text }) => {
      const li = document.createElement('li');
      li.className = 'reject';
      li.textContent = `Не засчитан: ${text}`;
      r.els.rejects.prepend(li);
      while (r.els.rejects.children.length > 3) r.els.rejects.lastElementChild.remove();
    });

    ctx.on('camera:lost', ({ since }) => {
      r.lostSince = since ?? performance.now();
      r.els.lostText.textContent = r.phase === 'live'
        ? 'Вернись в кадр, иначе челлендж отменится и всем вернут ставки'
        : 'Челлендж ещё не начался, ставки не списаны. Ждём камеру';
      r.els.lostCount.hidden = r.phase !== 'live';
      r.els.lost.hidden = false;
    });
    ctx.on('camera:back', () => {
      r.lostSince = 0;
      r.els.lost.hidden = true;
    });
    ctx.on('debug:finish', ({ success }) => finish(ctx, r, success ? 'forced-success' : 'forced-fail'));
    // debug: +1 к счёту работает и без кадров (video=none, скрытая вкладка)
    ctx.on('debug:count', () => {
      if (!r.controller) return;
      r.controller.count += 1;
      render(ctx, r);
      if (r.phase === 'live' && Math.floor(r.controller.count) >= r.ch.target) finish(ctx, r, 'target');
    });
    ctx.interval(() => tick(ctx, r), 200);

    const mod = await import(`../exercises/${ch.type}.js`);
    if (run !== r) return; // ушли с экрана, пока грузили
    r.controller = mod.createController({ challenge: ch, bus: ctx.bus, feedback: ctx.feedback, debug: ctx.debug });
    ctx.vision.use(r.controller.model);
    render(ctx, r);

    if (typeof r.controller.ready === 'function' && APP.readyMaxMs > 0) {
      r.phase = 'position';
      await position(ctx, r);
      if (run !== r || r.phase !== 'position') return;
    }
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
    if (!r?.controller || frame.ran !== r.controller.model) return;
    if (r.phase === 'position') return checkPosition(r, frame);
    if (r.phase !== 'live') return;
    r.controller.frame(frame, frame.t);
    render(ctx, r);
    if (r.controller.failed) finish(ctx, r, 'failed');
    else if (r.controller.done) finish(ctx, r, 'target');
  },

  /** Упражнение может рисовать своё (controller.draw(frame, draw)), иначе стандартный скелет. */
  draw(frame, ctx) {
    const c = run?.controller;
    if (c?.draw) c.draw(frame, ctx.draw);
    else ctx.draw.auto(frame, { highlight: ctx.feedback.highlight });
  },

  exit() {
    run?.controller?.stop?.();
    run = null;
  },
};

/** «Встань в позицию»: галочки контроллера вживую, отсчёт после APP.readyHoldMs удержания или через APP.readyMaxMs. */
function position(ctx, r) {
  r.els.position.hidden = false;
  return new Promise((resolve) => {
    r.positionDone = () => {
      r.positionDone = null;
      r.els.position.hidden = true;
      resolve();
    };
    const giveUp = () => {
      if (run !== r || !r.positionDone) return;
      if (r.lostSince) return ctx.timeout(giveUp, 1000); // камеры нет: ждём её, денег ещё нет
      r.positionDone();
    };
    ctx.timeout(giveUp, APP.readyMaxMs);
  });
}

function checkPosition(r, frame) {
  let res = null;
  try {
    res = r.controller.ready(frame, frame.t);
  } catch (err) {
    console.error('[live] ready', err);
    return r.positionDone?.(); // сломанная проверка не держит игрока: сразу отсчёт
  }
  const checks = Array.isArray(res?.checks) ? res.checks : [];
  const key = checks.map((c) => `${c.id}:${c.ok ? 1 : 0}:${c.text}`).join('|');
  if (key !== r.checksKey) {
    r.checksKey = key;
    r.els.checks.innerHTML = checks
      .map((c) => `<li class="check${c.ok ? ' is-ok' : ''}"><span class="check__mark" aria-hidden="true"></span>${esc(c.text)}</li>`)
      .join('');
  }
  if (res?.ok) {
    if (!r.okSince) {
      r.okSince = frame.t;
      r.els.position.classList.add('is-ready');
    }
    if (frame.t - r.okSince >= APP.readyHoldMs) r.positionDone?.();
  } else if (r.okSince) {
    r.okSince = 0;
    r.els.position.classList.remove('is-ready');
  }
}

function countdown(ctx, r) {
  return new Promise((resolve) => {
    let n = APP.countdownSec;
    const step = () => {
      if (run !== r) return resolve();
      if (n === 0) {
        r.els.countdown.hidden = true;
        sound.play('go');
        return resolve();
      }
      r.els.countdown.hidden = false;
      r.els.countdown.innerHTML = `<span>${n}</span>`;
      sound.play('tick');
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
      if (c.unit !== 'секунды') sound.play('rep');
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
    if (r.phase === 'live') {
      r.els.lostCount.hidden = false;
      r.els.lostCount.textContent = Math.max(0, Math.ceil(left / 1000));
      r.els.lostText.textContent = 'Вернись в кадр, иначе челлендж отменится и всем вернут ставки';
      if (left <= 0) {
        r.phase = 'done';
        ctx.bus.emit('live:void', { challenge: r.ch, reason: 'camera' });
        ctx.app.go('VOID', { reason: 'camera' });
        return;
      }
    } else if (r.phase === 'position' && left <= 0) {
      // Ставка ещё не списана: отменять нечего, возвращаемся в лобби
      r.phase = 'done';
      ctx.ui.toast('Камера пропала, челлендж не начался');
      ctx.app.go('LOBBY');
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
  sound.play(success ? 'win' : 'lose');
  r.els.countdown.hidden = true;
  r.els.position.hidden = true;
  r.els.finale.hidden = false;
  r.els.finale.dataset.success = success;
  r.els.finale.textContent = success ? 'Сделал!' : 'Не успел';
  ctx.timeout(() => ctx.app.go('RESULT'), APP.resultDelayMs);
}
