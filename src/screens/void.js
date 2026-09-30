// VOID: челлендж отменён, всем вернули ставки. Владелец: блок 3 (Деньги).
// Сюда ведёт LIVE, когда камера пропала дольше APP.voidAfterMs (params.reason = 'camera').
// Возврат делает wallet на live:void, ещё до входа на экран; здесь видно, кому что вернули:
// wallet.round(id).settlement (форма money.refundAll). Раунда нет (прыжок клавишами отладки): refundAll по челленджу.
// Слушает: gesture (Thumb_Up → IDLE). Ничего не шлёт.

import { APP, CHALLENGES } from '../config.js';
import { esc } from '../ui.js';
import { refundAll, formatCredits, plural } from '../money.js';
import { wallet } from '../wallet.js';
import { TEXT as RESULT_TEXT, ledgerRow, amount, balanceLine, ctaButton, armCta, sayLater } from './result.js';

/** Тексты экрана. Тест проверяет, что в них нет длинного и среднего тире. */
export const TEXT = {
  title: 'Челлендж отменён',
  camera: (sec) => `Камера пропала дольше чем на ${sec} ${plural(sec, 'секунду', 'секунды', 'секунд')}`,
  other: 'Челлендж прервался',
  refunded: 'Ставки вернули всем, никто ничего не потерял',
  back: '↩',
  home: 'В начало',
  voice: 'Челлендж отменён, ставки вернули',
};

/** Почему отменили: камера (секунды из APP.voidAfterMs) или что-то другое. */
export function voidReason(reason) {
  return reason === 'camera' ? TEXT.camera(Math.round(APP.voidAfterMs / 1000)) : TEXT.other;
}

/** Кому что вернули (settlement формы money.refundAll): ты и друзья, чьи ставки были в пуле. */
export function refundRows(st, { avatar = '' } = {}) {
  return [
    { kind: 'you', avatar, name: RESULT_TEXT.you, back: st.player.payout },
    ...st.friends.filter((f) => f.amount > 0).map((f) => ({ kind: 'friend', avatar: f.avatar, name: f.name, back: f.payout })),
  ];
}

export default {
  model: 'gesture',

  enter(ctx, params = {}) {
    const ch = ctx.app.challenge;
    const def = CHALLENGES[ch.type];
    const round = wallet.round(ch.id);
    const st = round?.status === 'refunded' ? round.settlement : refundAll({ stake: ch.stake, bets: ch.bets });
    const rows = refundRows(st, { avatar: def.emoji });
    const back = (x) => amount(esc(`${TEXT.back} ${formatCredits(x)}`), 'is-back');

    ctx.root.innerHTML = `
      <div class="panel void">
        <div class="void__icon" aria-hidden="true">${params.reason === 'camera' ? '📷' : '⏸️'}</div>
        <h2 class="void__title">${esc(TEXT.title)}</h2>
        <p class="void__reason">${esc(voidReason(params.reason))}</p>
        <p class="void__text">${esc(TEXT.refunded)}</p>
        <ul class="ledger">${rows.map((r, i) => ledgerRow(r, i, back(r.back))).join('')}</ul>
        <div class="void__foot">
          ${balanceLine(wallet.balance)}
          ${ctaButton(TEXT.home)}
        </div>
      </div>`;

    armCta(ctx, () => ctx.app.go('IDLE'));
    sayLater(ctx, TEXT.voice);
  },
};
