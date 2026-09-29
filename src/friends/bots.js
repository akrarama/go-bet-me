// Симулированные друзья (P0). Владелец: блок 3 (Деньги).
// join(challenge): боты ставят против (сумма ставок не больше ставки игрока, кто раньше),
//   каждая ставка: challenge.bets.push(bet) и событие bet {bet, challenge}.
// init(ctx): подписка на count / fault / live:end → реплики в ленту (событие comment {from, text}).
// Сейчас заглушка: ставки сразу, без реплик.

import { MONEY } from '../config.js';
import { bus } from '../bus.js';

export const bots = {
  init() {},

  join(challenge) {
    if (challenge.bets.length) return;
    let left = challenge.stake;
    for (const b of MONEY.bots) {
      const amount = Math.min(b.amount, left);
      if (amount <= 0) break;
      left -= amount;
      const bet = { ...b, amount, bot: true };
      challenge.bets.push(bet);
      bus.emit('bet', { bet, challenge });
    }
  },
};
