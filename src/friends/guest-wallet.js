// Кошелёк друга (P1): его баланс на его устройстве. Владелец: блок 3 (Деньги).
// Ядро без DOM: тесты в jsc подсовывают свою память вместо localStorage.
//
// Путь ставки друга (раунд):
//   bet:ok   ничего не списывает: ставка только записана у игрока
//   start    hold()    ставки закрыты, хост прислал снимок: ставка друга списана
//   end      settle()  игрок не сделал: ставка назад и столько же из ставки игрока минус комиссия,
//                      сделал: ставка потеряна. Сумму считает хост (you.delta), друг проверяет её сам
//   void     refund()  отмена: ставка вернулась
// Раунд, который не дошёл до конца (закрыл вкладку, пропала связь), при следующем запуске возвращается сам.
// Правило 1:1 и комиссия те же, что у игрока: money.js.

import { MONEY } from '../config.js';
import { toCents, fromCents, settleFriend } from '../money.js';

const VERSION = 1;
const uid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const isOpen = (h) => h.kind === 'round' && h.status === 'held';

/**
 * storage: как localStorage (getItem/setItem) или null (только память).
 * subscribe(fn): fn({ reason, delta, balance, round }) на каждое изменение,
 *   reason: 'hold' | 'settle' | 'refund' | 'topup' | 'reset' | 'sync'.
 */
export function createGuestWallet({ storage = null, key = MONEY.friend.storageKey, start = MONEY.startBalance, fee = MONEY.APP_FEE, keep = MONEY.historyMax, now = () => Date.now() } = {}) {
  const listeners = new Set();
  let state = load();

  function fresh() {
    return { v: VERSION, cents: toCents(start), history: [{ id: uid('p'), kind: 'profile', at: now(), balanceAfter: start }] };
  }

  function load() {
    try {
      const s = JSON.parse(storage?.getItem(key) ?? 'null');
      if (s?.v === VERSION && Number.isInteger(s.cents) && Array.isArray(s.history)) return s;
    } catch {
      /* битые данные: новый профиль */
    }
    return fresh();
  }

  function save() {
    // старое уходит, незакрытый раунд остаётся всегда
    while (state.history.length > keep) {
      const i = state.history.findIndex((h) => !isOpen(h));
      if (i < 0) break;
      state.history.splice(i, 1);
    }
    try {
      storage?.setItem(key, JSON.stringify(state));
    } catch {
      /* нет места или запрещено: кошелёк живёт в памяти до перезагрузки */
    }
  }

  function changed(reason, deltaCents, round = null) {
    save();
    const change = { reason, delta: fromCents(deltaCents), balance: fromCents(state.cents), round };
    for (const fn of [...listeners]) {
      try {
        fn(change);
      } catch (err) {
        globalThis.console?.error?.('[guest-wallet]', err);
      }
    }
  }

  /** Последний раунд этого челленджа. */
  function roundOf(challengeId) {
    for (let i = state.history.length - 1; i >= 0; i--) {
      const h = state.history[i];
      if (h.kind === 'round' && h.challengeId === challengeId) return h;
    }
    return null;
  }

  function giveBack(round, reason) {
    const back = toCents(round.amount);
    state.cents += back;
    Object.assign(round, { status: 'refunded', reason, payout: round.amount, delta: 0, closedAt: now(), balanceAfter: fromCents(state.cents) });
    changed('refund', back, round);
    return round;
  }

  return {
    get balance() {
      return fromCents(state.cents);
    },

    get history() {
      return state.history.slice();
    },

    /** Раунды, которые ещё не закрыты. */
    get open() {
      return state.history.filter(isOpen);
    },

    canAfford(amount) {
      return toCents(amount) <= state.cents;
    },

    /**
     * start: списать ставку друга. Один раз на челлендж: повторный start ничего не списывает.
     * Не хватает кредитов (потратил в другой вкладке): списываем сколько есть.
     */
    hold({ challengeId, amount }) {
      const want = toCents(amount);
      if (challengeId == null || want <= 0) return null;
      const known = roundOf(challengeId);
      if (known) return known.status === 'held' ? known : null;
      const put = Math.min(want, Math.max(0, state.cents));
      if (put <= 0) return null;
      const round = {
        id: uid('r'),
        kind: 'round',
        challengeId,
        amount: fromCents(put),
        ...(put < want ? { requested: fromCents(want) } : {}),
        status: 'held',
        startedAt: now(),
        balanceBefore: fromCents(state.cents),
      };
      state.cents -= put;
      round.balanceAfter = fromCents(state.cents);
      state.history.push(round);
      changed('hold', -put, round);
      return round;
    },

    /**
     * end: применить расчёт один раз. you: {amount, delta} от хоста. Верим ему, если сумма совпала
     * с нашей и итог не больше ставки (1:1), иначе считаем сами по правилу money.js.
     */
    settle({ challengeId, success, you }) {
      const r = roundOf(challengeId);
      if (!r || r.status !== 'held') return null;
      const held = toCents(r.amount);
      let delta = toCents(settleFriend({ amount: r.amount, success: !!success, fee }).delta);
      if (you && toCents(you.amount) === held && Number.isFinite(Number(you.delta))) {
        const theirs = toCents(you.delta);
        if (theirs >= -held && theirs <= held) delta = theirs;
      }
      const payout = held + delta;
      state.cents += payout;
      Object.assign(r, { status: 'settled', success: !!success, delta: fromCents(delta), payout: fromCents(payout), closedAt: now(), balanceAfter: fromCents(state.cents) });
      changed('settle', payout, r);
      return r;
    },

    /** void: вернуть ставку. Уже рассчитанный раунд не отменяется. */
    refund(challengeId, reason = 'void') {
      const r = roundOf(challengeId);
      return r && r.status === 'held' ? giveBack(r, reason) : null;
    },

    /** Закрыть всё недоигранное (перезагрузка посреди челленджа): ставка возвращается. */
    recover(reason = 'interrupted') {
      return state.history.filter(isOpen).map((r) => giveBack(r, reason));
    },

    /** Пополнить до стартового баланса (кредиты не настоящие). Возвращает, сколько добавили. */
    topUp(to = start) {
      const add = toCents(to) - state.cents;
      if (add <= 0) return 0;
      state.cents += add;
      state.history.push({ id: uid('t'), kind: 'topup', amount: fromCents(add), at: now(), balanceAfter: fromCents(state.cents) });
      changed('topup', add);
      return fromCents(add);
    },

    /** Кредитов меньше самой маленькой ставки: пополнить до старта, чтобы другу было чем играть. */
    topUpIfBroke(min = MONEY.friend.minBet) {
      return state.cents < toCents(min) ? this.topUp() : 0;
    },

    /** Новый профиль (отладка). */
    reset() {
      const before = state.cents;
      state = fresh();
      changed('reset', state.cents - before);
    },

    /** Перечитать хранилище (другая вкладка поменяла баланс). */
    reload() {
      const before = state.cents;
      state = load();
      changed('sync', state.cents - before);
    },

    round: roundOf,

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
