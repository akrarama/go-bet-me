// LOBBY: друзья ставят против (P0: боты), пул. Старт: рука над головой 1 с → LIVENESS. 👎 → SETUP.
// Запасной старт, если рука не ловится: dwell-кнопка «Старт» (палец-курсор, 1 с).
// P1: карточка приглашения друга (QR, ссылка, «Смотрят: N») по событию peer:ready, см. ui/invite.js.
// Нет peer:ready или пришёл peer:error → карточки нет, всё как в P0.
// Владелец: блок 2 (Жесты). Ставки даёт блок 3: bots.join(challenge) и peer.js → событие bet.
// Модели ['gesture', 'pose'] по очереди: палец-курсор и «рука вверх» одновременно.
// Прогресс удержания руки (gestures.bestArm) видно дважды: большое кольцо старта и кольцо у запястья.

import { CHALLENGES, GESTURES } from '../config.js';
import { bus } from '../bus.js';
import { debug } from '../debug.js';
import { COLORS } from '../draw.js';
import { bots } from '../friends/bots.js';
import { sound } from '../sound.js';
import { esc } from '../ui.js';
import { invite, qrCached, qrFor, shortLink, betRow } from '../ui/invite.js';
import { gestures, LIVENESS_TEXT } from '../vision/gestures.js';
import { mss, plural, targetLabel } from './setup.js';

const HINTS = {
  'hand-rearm': 'Опусти руку и подними снова',
  'hand-low': 'Подними руку выше головы',
  'hand-out': 'Рука вышла из кадра, отойди чуть дальше',
};
const OUT_HINT_MS = 1000; // рука за краем кадра столько = подсказка
const GO_DELAY_MS = 350; // «Старт!» успевает мелькнуть

let view = null;
let simCtx = null; // экран открыт: для debug-имитации друга

// ?debug=1, клавиша k: пока peer.js нет (или чтобы не искать второй телефон), имитация друга по ссылке. Шаги по кругу.
const SIM = [
  ['ссылка готова (peer:ready)', () => bus.emit('peer:ready', { id: 'demo1234', url: 'https://akrarama.github.io/go-bet-me/?join=demo1234' })],
  ['друг Тимур зашёл', () => bus.emit('friend:join', { id: 'demo-a', name: 'Тимур', avatar: '🧑' })],
  ['Тимур поставил 5', simBet],
  ['друг Аня зашла', () => bus.emit('friend:join', { id: 'demo-b', name: 'Аня', avatar: '👩' })],
  ['Тимур ушёл', () => bus.emit('friend:leave', { id: 'demo-a' })],
  ['облако упало (peer:error)', () => bus.emit('peer:error', { error: 'debug' })],
];
let simStep = 0;
function simBet() {
  const ch = simCtx?.app.challenge;
  if (!ch) return;
  import('../money.js').then(({ acceptBet }) => {
    const r = acceptBet(ch, { id: 'peer:demo-a', name: 'Тимур', avatar: '🧑', amount: 5, bot: false });
    if (r.bet) bus.emit('bet', { bet: r.bet, challenge: ch });
    else simCtx?.ui.toast(`Ставка друга не принята: ${r.status}`);
  });
}
debug.key('k', () => {
  const [label, run] = SIM[simStep % SIM.length];
  simStep++;
  debug.set('друг (k)', `${simStep}: ${label}`);
  run();
}, 'друг по ссылке: имитация, жми по шагам (LOBBY)');

/** Кольцо прогресса вокруг запястья (LOBBY и LIVENESS): дорожка + дуга акцентом от 12 часов. */
export function drawWristRing(draw, wrist, progress) {
  const { x, y } = draw.project(wrist);
  const c = draw.ctx;
  const p = Math.max(0, Math.min(1, progress || 0));
  c.save();
  c.lineCap = 'round';
  c.lineWidth = 5;
  c.shadowColor = COLORS.shadow;
  c.shadowBlur = 10;
  c.strokeStyle = COLORS.dim;
  c.beginPath();
  c.arc(x, y, 30, 0, Math.PI * 2);
  c.stroke();
  if (p > 0) {
    c.strokeStyle = COLORS.joint;
    c.beginPath();
    c.arc(x, y, 30, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
    c.stroke();
  }
  c.restore();
}

/** Подсказка-коучинг: показать code с текстом text или убрать прошлую (code = null). state.coach = текущий код. */
export function coach(ctx, state, code, text) {
  if (state.coach && state.coach !== code) ctx.feedback.clear(state.coach);
  state.coach = code;
  if (code) ctx.feedback.hint(text, { code, level: 'info', speak: false, priority: 1 });
}

export default {
  model: ['gesture', 'pose'],

  enter(ctx, params = {}) {
    const ch = ctx.app.challenge;
    const def = CHALLENGES[ch.type];
    const { num, unit } = targetLabel(ch.type, ch.target);
    const goal = `${num} ${unit}${def.limitSec ? ` за ${mss(def.limitSec)}` : ''}`;
    const failed = params.reason === 'liveness';
    const checkSec = GESTURES.livenessSec;
    const holdSec = GESTURES.handUpMs / 1000;
    const why = LIVENESS_TEXT[params.task]?.fail ?? 'время вышло';

    ctx.root.innerHTML = `
      <div class="lobby">
        <section class="panel lobby-card">
          ${failed ? `
          <div class="lobby-banner" role="alert">
            <span class="lobby-banner__icon" aria-hidden="true">!</span>
            <p class="lobby-banner__text"><b>Проверка не пройдена:</b> ${esc(why)} за ${checkSec} ${plural(checkSec, 'секунду', 'секунды', 'секунд')}. Подними руку, чтобы попробовать ещё раз.</p>
          </div>` : ''}
          <div class="lobby-chips">
            <span class="chip lobby-chip"><span class="lobby-chip__emoji" aria-hidden="true">${esc(def.emoji)}</span>${esc(def.label)}</span>
            <span class="chip lobby-chip">${esc(goal)}</span>
            <span class="chip lobby-chip lobby-chip--you">Твоя ставка <b>${ch.stake} кр.</b></span>
          </div>
          <div class="lobby-bets-wrap">
            <h3 class="lobby-title">Против тебя</h3>
            <ul class="lobby-bets" data-bets></ul>
            <div class="lobby-empty" data-empty>Ждём ставки друзей<span class="lobby-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>
          </div>
          <div class="lobby-pool">
            <div class="lobby-pool__row"><span class="lobby-pool__text" data-pool></span><span class="lobby-full" data-full hidden>Пул полон</span></div>
            <div class="lobby-meter"><div class="lobby-meter__fill" data-meter></div></div>
          </div>
        </section>
        <section class="lobby-start" data-start>
          <div class="lobby-gauge" data-gauge>
            <svg class="lobby-ring" viewBox="0 0 100 100" aria-hidden="true">
              <circle class="lobby-ring__track" cx="50" cy="50" r="46" pathLength="1"></circle>
              <circle class="lobby-ring__fill" cx="50" cy="50" r="46" pathLength="1"></circle>
            </svg>
            <span class="lobby-gauge__icon" aria-hidden="true">✋</span>
          </div>
          <div class="lobby-start__label" data-label>Подними руку над головой</div>
          <div class="lobby-start__sub">и подержи ${holdSec} ${plural(holdSec, 'секунду', 'секунды', 'секунд')}</div>
          <div class="lobby-back"><span aria-hidden="true">👎</span> Назад к настройкам</div>
          <button class="btn btn--primary lobby-go" data-dwell data-action="go">Старт</button>
          <div class="lobby-alt">Рука не ловится? Наведи палец на кнопку</div>
        </section>
        <section class="panel lobby-invite" data-invite hidden></section>
      </div>`;

    const q = (sel) => ctx.root.querySelector(sel);
    const v = (view = {
      going: false, p: -1, charging: false, coach: null, seen: new Set(), inviteUrl: null, offInvite: null,
      lobby: q('.lobby'), invite: q('[data-invite]'),
      bets: q('[data-bets]'), empty: q('[data-empty]'), pool: q('[data-pool]'), full: q('[data-full]'), meter: q('[data-meter]'),
      start: q('[data-start]'), gauge: q('[data-gauge]'), label: q('[data-label]'),
    });

    // Ставки: уже сделанные (вернулись после проверки) и новые по событию bet, без повторов.
    // Ставка друга по ссылке (bet.bot = false) в том же списке, что боты, с меткой «по ссылке».
    const addBet = (bet, i = 0) => {
      if (!bet || v.seen.has(bet.id)) return;
      v.seen.add(bet.id);
      const r = betRow(bet);
      v.bets.insertAdjacentHTML(
        'beforeend',
        `<li class="lobby-bet${r.link ? ' lobby-bet--link' : ''}" style="--i: ${i}">
          <span class="lobby-bet__avatar" aria-hidden="true">${esc(r.avatar)}</span>
          <span class="lobby-bet__who"><span class="lobby-bet__name">${esc(r.name)}</span>${r.link ? '<span class="lobby-bet__tag">по ссылке</span>' : ''}</span>
          <span class="lobby-bet__amount">${r.amount} кр.</span>
        </li>`,
      );
    };
    const renderPool = () => {
      const pool = ch.bets.reduce((s, b) => s + b.amount, 0);
      v.pool.innerHTML = `Против: <b>${pool}</b> из ${ch.stake} кр.`;
      v.meter.style.setProperty('--fill', ch.stake ? Math.min(1, pool / ch.stake) : 0);
      v.full.hidden = pool < ch.stake;
      v.empty.hidden = v.seen.size > 0;
    };
    ch.bets.forEach((b, i) => addBet(b, i));
    renderPool();
    ctx.on('bet', ({ bet, challenge }) => {
      if (challenge?.id !== ch.id) return;
      addBet(bet);
      renderPool();
    });
    bots.join(ch);

    // Приглашение друга (P1): карточка есть, пока есть ссылка (peer:ready), и пропадает по peer:error
    const setQr = (svg) => {
      const box = v.invite.querySelector('[data-qr]');
      if (!box) return;
      if (svg) {
        box.innerHTML = svg;
        box.classList.add('is-ready');
      } else v.invite.classList.add('is-noqr'); // библиотека не загрузилась: остаётся ссылка
    };
    const renderWatch = () => {
      const el = v.invite.querySelector('[data-watch]');
      if (!el) return;
      const n = invite.count;
      const faces = invite.friends
        .slice(0, GESTURES.invite.faces)
        .map((f) => `<span class="invite-face" title="${esc(f.name)}">${esc(f.avatar)}</span>`)
        .join('');
      el.innerHTML = `<span class="invite-dot${n ? ' is-live' : ''}" aria-hidden="true"></span><span>Смотрят: <b>${n}</b></span>${faces ? `<span class="invite-faces">${faces}</span>` : ''}`;
    };
    const renderInvite = () => {
      if (view !== v) return;
      if (!invite.on) {
        v.inviteUrl = null;
        v.invite.hidden = true;
        v.invite.innerHTML = '';
        v.invite.classList.remove('is-noqr');
        v.lobby.classList.remove('has-invite');
        return;
      }
      if (v.inviteUrl !== invite.url) {
        const url = (v.inviteUrl = invite.url);
        v.invite.classList.remove('is-noqr');
        v.invite.innerHTML = `
          <div class="invite-qr" data-qr></div>
          <div class="invite-body">
            <h3 class="lobby-title">Позови друга</h3>
            <p class="invite-text">Друг наводит камеру на QR и ставит против</p>
            <p class="invite-link">${esc(shortLink(url))}</p>
            <p class="invite-watch" data-watch aria-live="polite"></p>
          </div>`;
        const hit = qrCached(url);
        if (hit) setQr(hit);
        else qrFor(url).then((svg) => view === v && v.inviteUrl === url && setQr(svg));
      }
      renderWatch();
      v.invite.hidden = false;
      v.lobby.classList.add('has-invite');
    };
    v.offInvite = invite.subscribe(renderInvite);
    renderInvite();
    simCtx = ctx;

    // Старт: рука над головой или запасная dwell-кнопка «Старт» (если рука не ловится)
    const startNow = () => {
      if (v.going) return;
      v.going = true;
      coach(ctx, v, null);
      v.start.classList.remove('is-charging');
      v.start.classList.add('is-go');
      v.gauge.style.setProperty('--p', 1);
      v.label.textContent = 'Старт!';
      sound.play('go');
      ctx.timeout(() => ctx.app.go('LIVENESS'), GO_DELAY_MS);
    };
    ctx.on('handup', startNow);
    q('.lobby-go').addEventListener('click', startNow);
    ctx.on('gesture', ({ name }) => {
      if (name === 'Thumb_Down' && !v.going) ctx.app.go('SETUP');
    });

    if (failed) sound.play('error'); // голоса нет (APP.voice = false): только звук и баннер
  },

  /** Кольцо старта следует за удержанием руки; подсказки, если рука не там. */
  frame(frame, ctx) {
    const v = view;
    if (!v || v.going) return;
    const p = Math.round((gestures.bestArm?.progress ?? 0) * 100) / 100;
    if (p !== v.p) {
      v.p = p;
      v.gauge.style.setProperty('--p', p);
    }
    const charging = p > 0;
    if (charging !== v.charging) {
      v.charging = charging;
      v.start.classList.toggle('is-charging', charging);
      v.label.textContent = charging ? 'Держи!' : 'Подними руку над головой';
    }

    const arms = gestures.arms;
    const list = arms ? [arms.left, arms.right] : [];
    let code = null;
    if (list.some((a) => a.up && !a.armed)) code = 'hand-rearm';
    else if (list.some((a) => a.low && a.lowMs >= GESTURES.handLowHintMs)) code = 'hand-low';
    else if (list.some((a) => a.out && a.outMs >= OUT_HINT_MS)) code = 'hand-out';
    coach(ctx, v, code, HINTS[code]);
  },

  /** Скелет, затем кольцо у поднятого запястья. */
  draw(frame, ctx) {
    ctx.draw.auto(frame, { highlight: ctx.feedback.highlight });
    const arms = gestures.arms;
    if (!arms || gestures.poseSeen === false) return;
    const best = gestures.bestArm;
    for (const arm of [arms.left, arms.right]) {
      const charging = best?.side === arm.side && best.progress > 0;
      if (arm.wrist && ((arm.up && arm.armed) || charging)) drawWristRing(ctx.draw, arm.wrist, arm.progress);
    }
  },

  exit() {
    view?.offInvite?.();
    view = null;
    simCtx = null;
  },
};
