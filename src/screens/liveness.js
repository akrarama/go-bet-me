// LIVENESS: случайное задание из {левая рука вверх, правая рука вверх, 👍, 🖐} за GESTURES.livenessSec.
// Выполнил → LIVE. Не успел → LOBBY { reason: 'liveness', task }. Решает createLivenessJudge (vision/gestures.js).
// Владелец: блок 2 (Жесты). Модели ['gesture', 'pose'] по очереди: и жесты, и руки над головой.

import { GESTURES } from '../config.js';
import { camera } from '../camera.js';
import { sound } from '../sound.js';
import { esc } from '../ui.js';
import { gestures, LIVENESS_TEXT, createLivenessJudge, pickLivenessTask } from '../vision/gestures.js';
import { setHold } from './idle.js';
import { coach, drawWristRing } from './lobby.js';

const LOW_SEC = 2; // последние секунды: кольцо и цифра жёлтые
const PASS_DELAY_MS = 700; // «Есть!» видно перед LIVE

let lastTask = null; // следующее задание не повторяет прошлое
let run = null;

export default {
  model: ['gesture', 'pose'],

  enter(ctx) {
    const task = (lastTask = pickLivenessTask(GESTURES.livenessTasks, lastTask));
    const text = LIVENESS_TEXT[task];
    const sec = GESTURES.livenessSec;
    const judge = createLivenessJudge(task, { t0: performance.now(), sec });
    const side = text.side ?? null;
    // Где на экране эта рука: веб-камера зеркальная (левая рука слева), видеофайл нет
    const onLeft = (side === 'left') === camera.mirror;

    ctx.root.innerHTML = `
      <div class="check" data-check>
        <p class="check-caption">Проверка, что ты в кадре вживую</p>
        <div class="check-dial" data-dial>
          <svg class="check-ring" viewBox="0 0 100 100" aria-hidden="true">
            <circle class="check-ring__track" cx="50" cy="50" r="46" pathLength="1"></circle>
            <circle class="check-ring__fill" cx="50" cy="50" r="46" pathLength="1"></circle>
          </svg>
          <div class="check-dial__center">
            <span class="check-icon" aria-hidden="true">${esc(text.icon)}</span>
            <span class="check-sec" data-sec>${sec}</span>
          </div>
          <svg class="check-done" viewBox="0 0 48 48" aria-hidden="true"><path d="M13 25l7.5 7.5L35 17" pathLength="1"></path></svg>
        </div>
        <h2 class="check-title" data-title>${esc(text.title)}</h2>
      </div>
      ${side ? `
      <div class="check-side check-side--${onLeft ? 'left' : 'right'}" aria-hidden="true">
        <svg class="check-side__arrow" viewBox="0 0 48 72"><path d="M24 64V10M8 26 24 10l16 16"></path></svg>
        <span class="check-side__label">${side === 'left' ? 'Левая' : 'Правая'} рука</span>
      </div>` : ''}`;

    const q = (sel) => ctx.root.querySelector(sel);
    const r = (run = {
      task, text, judge, done: false, coach: null, shownSec: sec, low: false,
      root: q('[data-check]'), dial: q('[data-dial]'), sec: q('[data-sec]'), title: q('[data-title]'), fill: q('.check-ring__fill'),
      anim: null,
    });
    // Кольцо убывает ровно за sec секунд (WAAPI: плавно, без перерисовки из JS)
    r.anim = r.fill.animate?.([{ strokeDashoffset: 0 }, { strokeDashoffset: 1 }], { duration: sec * 1000, easing: 'linear', fill: 'both' }) ?? null;

    const pass = () => {
      r.done = true;
      coach(ctx, r, null);
      ctx.feedback.clearNow();
      r.dial.classList.remove('is-low');
      r.root.classList.add('is-pass');
      r.title.textContent = 'Есть!';
      refill(r);
      sound.play('go');
      ctx.timeout(() => ctx.app.go('LIVE'), PASS_DELAY_MS);
    };

    const handle = (v) => {
      if (r.done || !v) return;
      if (v.result === 'pass') pass();
      else if (v.result === 'fail') {
        r.done = true;
        ctx.app.go('LOBBY', { reason: 'liveness', task });
      } else if (v.hint) {
        // код с текстом: у руки два разных совета, и каждый должен смениться сразу
        ctx.feedback.hint(v.hint, { code: `liveness:${v.hint}`, level: 'warn', speak: false, priority: 2 });
        sound.play('error');
      }
    };

    ctx.interval(() => {
      if (r.done) return;
      const now = performance.now();
      const v = judge.tick(now);
      if (v?.result) return handle(v);
      const left = judge.left(now);
      const s = Math.ceil(left);
      if (s !== r.shownSec) {
        r.shownSec = s;
        r.sec.textContent = s;
        r.sec.classList.remove('is-tick');
        void r.sec.offsetWidth; // перезапуск анимации цифры
        r.sec.classList.add('is-tick');
        if (s > 0) sound.play('tick'); // тик на каждую секунду отсчёта
      }
      const low = left <= LOW_SEC;
      if (low !== r.low) {
        r.low = low;
        r.dial.classList.toggle('is-low', low);
      }
    }, 100);

    ctx.on('gesture', ({ name }) => handle(judge.onGesture(name, performance.now())));
    ctx.on('handup', ({ side: s }) => {
      const other = gestures.arms?.[s === 'left' ? 'right' : 'left'];
      handle(judge.onHandUp(s, performance.now(), { otherUp: Boolean(other?.up) }));
    });

  },

  /** Иконка растёт, пока задание держится; для рук подсказки «опусти и подними» и «выше головы». */
  frame(frame, ctx) {
    const r = run;
    if (!r || r.done) return;
    const side = r.text.side;
    if (!side) {
      const p = gestures.pending;
      setHold(r.dial, p?.name === r.task ? p.progress : 0);
      return;
    }
    const arm = gestures.arms?.[side];
    setHold(r.dial, arm?.progress ?? 0);
    let code = null;
    if (arm?.up && !arm.armed) code = 'hand-rearm';
    else if (arm?.low && arm.lowMs >= GESTURES.handLowHintMs) code = 'hand-low';
    const text = code === 'hand-rearm' ? 'Опусти руку и подними снова' : `Подними ${side === 'left' ? 'левую' : 'правую'} руку выше головы`;
    coach(ctx, r, code, text);
  },

  /** Скелет, затем кольцо у нужного запястья, пока рука поднята. */
  draw(frame, ctx) {
    ctx.draw.auto(frame, { highlight: ctx.feedback.highlight });
    const r = run;
    if (!r?.text.side || gestures.poseSeen === false) return;
    const arm = gestures.arms?.[r.text.side];
    if (arm?.wrist && arm.up && arm.armed) drawWristRing(ctx.draw, arm.wrist, arm.progress);
  },

  exit() {
    run = null;
  },
};

/** Успех: кольцо быстро дозаполняется от текущего места до полного. */
function refill(r) {
  if (!r.anim) return;
  const from = getComputedStyle(r.fill).strokeDashoffset;
  r.anim.cancel();
  const ease = getComputedStyle(document.documentElement).getPropertyValue('--ease-out').trim() || 'ease-out';
  r.anim = r.fill.animate([{ strokeDashoffset: from }, { strokeDashoffset: 0 }], { duration: 450, easing: ease, fill: 'both' });
}
