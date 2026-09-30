// SETUP: dwell-кнопки: упражнение, цель, ставка. 👍 или «Дальше» → LOBBY, 👎 или «Назад» → IDLE.
// Владелец: блок 2 (Жесты). Варианты из config: CHALLENGES[type].targets, STAKES.
// Каждый заход: новый челлендж (новый id, без ставок), прошлый выбор сохраняется.
// Чистые помощники (plural, mss, targetLabel, stakeOptions, pickStake) без DOM: для тестов и других экранов.

import { CHALLENGES, STAKES, MEDITATION, MONEY, GESTURES } from '../config.js';
import { formatCredits } from '../money.js';
import { esc } from '../ui.js';
import { wallet } from '../wallet.js';
import { gestures } from '../vision/gestures.js';
import { setHold, secText } from './idle.js';

/**
 * Русское множественное число: plural(5, 'повтор', 'повтора', 'повторов') → 'повторов'.
 * Дробным числам нужна форма единственного числа в родительном падеже: «4,5 кредита», «0,5 секунды».
 */
export function plural(n, one, few, many) {
  if (!Number.isInteger(n)) return few;
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

/** 90 → "1:30" */
export function mss(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Цель для кнопки и сводки: (squat, 10) → { num: '10', unit: 'повторов' }, (meditation, 600) → { num: '10', unit: 'минут' },
 * (plank, 30) → { num: '30', unit: 'секунд' }. def по умолчанию из config, тесты подсовывают свой.
 */
export function targetLabel(type, target, def = CHALLENGES[type]) {
  if (def?.unit === 'секунды') {
    if (target >= 60 && target % 60 === 0) {
      const m = target / 60;
      return { num: String(m), unit: plural(m, 'минута', 'минуты', 'минут') };
    }
    return { num: String(target), unit: plural(target, 'секунда', 'секунды', 'секунд') };
  }
  return { num: String(target), unit: plural(target, 'повтор', 'повтора', 'повторов') };
}

/** Цель для чипа в LOBBY: «10 повторов за 1:30» (лимит на повторы), «1 минута, лимит 3:00» (удержание). */
export function goalChip(type, target, def = CHALLENGES[type]) {
  const { num, unit } = targetLabel(type, target, def);
  if (!def?.limitSec) return `${num} ${unit}`;
  return def.unit === 'секунды' ? `${num} ${unit}, лимит ${mss(def.limitSec)}` : `${num} ${unit} за ${mss(def.limitSec)}`;
}

/** Подпись у цели: правило или время. Неразрывные пробелы: «3 нарушения = провал» и «Время: 3:00» не рвутся. */
export function goalNote(type, def = CHALLENGES[type], lives = MEDITATION.lives) {
  if (type === 'meditation') return `Замри с закрытыми глазами. ${lives}\u00A0${plural(lives, 'нарушение', 'нарушения', 'нарушений')}\u00A0=\u00A0провал`;
  if (type === 'plank') return `Считаются секунды ровной планки. Время:\u00A0${mss(def?.limitSec ?? 0)}`;
  return def?.limitSec ? `Время: ${mss(def.limitSec)}` : '';
}

/** Варианты ставки: на какие не хватает кредитов, те выключены. */
export function stakeOptions(stakes, balance, canAfford = (n) => n <= balance) {
  return stakes.map((amount) => ({ amount, disabled: !canAfford(amount) }));
}

/** Ставка, если на неё хватает; иначе самая большая доступная; иначе та же. */
export function pickStake(stake, stakes, balance, canAfford = (n) => n <= balance) {
  if (canAfford(stake)) return stake;
  const ok = stakes.filter((n) => canAfford(n));
  return ok.length ? Math.max(...ok) : stake;
}

// wallet от блока 3: canAfford / topUp могут быть ещё не влиты
const canAfford = (n) => (typeof wallet.canAfford === 'function' ? wallet.canAfford(n) : n <= wallet.balance);

let view = null;

export default {
  model: 'gesture',

  enter(ctx) {
    const prev = ctx.app.challenge;
    const prevDef = CHALLENGES[prev.type];
    ctx.app.challenge = ctx.app.newChallenge(prev.type, {
      target: prevDef.targets.includes(prev.target) ? prev.target : prevDef.defaultTarget,
      stake: pickStake(prev.stake, STAKES, wallet.balance, canAfford),
    });
    const ch = () => ctx.app.challenge;

    ctx.root.innerHTML = `
      <section class="panel setup">
        <header class="setup-head">
          <h2 class="h2">Новый челлендж</h2>
          <div class="chip setup-balance" data-balance></div>
        </header>
        <div class="setup-rows">
          <div class="setup-row">
            <div class="setup-label">Упражнение</div>
            <div class="setup-options" data-types data-count="${Object.keys(CHALLENGES).length}">${Object.entries(CHALLENGES)
              .map(([type, def]) => `
              <button class="btn setup-opt setup-opt--type" data-dwell data-type="${type}" aria-pressed="false">
                <span class="setup-emoji" aria-hidden="true">${esc(def.emoji)}</span><span>${esc(def.label)}</span>
              </button>`)
              .join('')}
            </div>
            <p class="setup-desc" data-desc></p>
          </div>
          <div class="setup-row">
            <div class="setup-label">Цель<span class="setup-note" data-target-note></span></div>
            <div class="setup-options" data-targets></div>
          </div>
          <div class="setup-row">
            <div class="setup-label">Ставка<span class="setup-note setup-note--danger" data-stake-note></span></div>
            <div class="setup-options" data-stakes></div>
          </div>
        </div>
        <footer class="setup-foot">
          <button class="btn setup-back" data-dwell data-action="back"><span aria-hidden="true">👎</span> Назад</button>
          <p class="setup-help">Наведи палец на кнопку и подержи ${secText(GESTURES.dwellMs)}</p>
          <button class="btn btn--primary setup-next" data-dwell data-action="next">Дальше <span aria-hidden="true">👍</span></button>
        </footer>
      </section>`;

    const q = (sel) => ctx.root.querySelector(sel);
    const els = (view = {
      panel: q('.setup'),
      balance: q('[data-balance]'),
      types: q('[data-types]'),
      targets: q('[data-targets]'),
      targetNote: q('[data-target-note]'),
      stakes: q('[data-stakes]'),
      stakeNote: q('[data-stake-note]'),
      desc: q('[data-desc]'),
      back: q('.setup-back'),
      next: q('.setup-next'),
    });

    const renderTargets = (fresh = false) => {
      const c = ch();
      const def = CHALLENGES[c.type];
      els.targets.innerHTML = def.targets
        .map((n) => {
          const { num, unit } = targetLabel(c.type, n);
          return `<button class="btn setup-opt" data-dwell data-target="${n}" aria-pressed="false"><span class="setup-val"><span class="setup-num">${num}</span> <span class="setup-unit">${esc(unit)}</span></span></button>`;
        })
        .join('');
      els.targets.dataset.count = def.targets.length; // два варианта делят ряд пополам, три: на трети
      els.targets.classList.toggle('is-fresh', fresh);
      mark(els.targets, 'target', c.target);
      els.targetNote.textContent = goalNote(c.type, def);
      els.desc.textContent = def.howto ?? ''; // как выполнять: для отжиманий и планки «боком к камере»
    };

    const renderStakes = () => {
      const c = ch();
      const opts = stakeOptions(STAKES, wallet.balance, canAfford);
      const none = opts.every((o) => o.disabled);
      if (none) {
        const topUp = typeof wallet.topUp === 'function'
          ? `<button class="btn setup-topup" data-dwell data-action="topup">Пополнить до ${MONEY.startBalance}</button>`
          : '';
        els.stakes.innerHTML = `<div class="setup-empty"><span class="setup-empty__text">Кредиты закончились</span>${topUp}</div>`;
        els.stakeNote.textContent = '';
      } else {
        els.stakes.innerHTML = opts
          .map(({ amount, disabled }) => `<button class="btn setup-opt" data-dwell data-stake="${amount}" aria-pressed="false"${disabled ? ' disabled' : ''}><span class="setup-val"><span class="setup-num">${amount}</span> <span class="setup-unit">кр.</span></span></button>`)
          .join('');
        mark(els.stakes, 'stake', c.stake);
        els.stakeNote.textContent = opts.some((o) => o.disabled) ? 'Не хватает кредитов' : '';
      }
      els.next.disabled = none;
      els.balance.innerHTML = `Баланс <b>${formatCredits(wallet.balance)}</b> кр.`; // как в шапке: без двоеточия, дроби через запятую
    };

    const setType = (type) => {
      if (type === ch().type || !CHALLENGES[type]) return;
      ctx.app.challenge = ctx.app.newChallenge(type, { stake: ch().stake }); // цель и лимит времени этого типа
      mark(els.types, 'type', type);
      renderTargets(true);
    };

    const next = () => {
      if (!canAfford(ch().stake)) {
        ctx.ui.toast('Не хватает кредитов на ставку', { tone: 'danger' });
        return;
      }
      ctx.app.go('LOBBY');
    };

    const topUp = () => {
      if (typeof wallet.topUp !== 'function') return;
      wallet.topUp();
      ch().stake = pickStake(ch().stake, STAKES, wallet.balance, canAfford);
      renderStakes();
    };

    // Клик: dwell (el.click()) или мышь в ?debug=1
    els.panel.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-dwell]');
      if (!btn || btn.disabled) return;
      const d = btn.dataset;
      if (d.type) setType(d.type);
      else if (d.target) {
        ch().target = Number(d.target);
        mark(els.targets, 'target', ch().target);
      } else if (d.stake) {
        ch().stake = Number(d.stake);
        mark(els.stakes, 'stake', ch().stake);
      } else if (d.action === 'next') next();
      else if (d.action === 'back') ctx.app.go('IDLE');
      else if (d.action === 'topup') topUp();
    });

    mark(els.types, 'type', ch().type);
    renderTargets();
    renderStakes();

    ctx.on('gesture', ({ name }) => {
      if (name === 'Thumb_Up') next();
      else if (name === 'Thumb_Down') ctx.app.go('IDLE');
    });
  },

  /** Пока 👍 или 👎 держится, кнопка «Дальше» или «Назад» заполняется. */
  frame() {
    if (!view) return;
    const p = gestures.pending;
    setHold(view.next, p?.name === 'Thumb_Up' ? p.progress : 0);
    setHold(view.back, p?.name === 'Thumb_Down' ? p.progress : 0);
  },

  exit() {
    view = null;
  },
};

/** Выбранная кнопка в ряду: .is-selected + aria-pressed. */
function mark(box, key, value) {
  for (const b of box.querySelectorAll(`[data-${key}]`)) {
    const on = b.dataset[key] === String(value);
    b.classList.toggle('is-selected', on);
    b.setAttribute('aria-pressed', String(on));
  }
}
