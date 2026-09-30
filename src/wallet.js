// Кошелёк: баланс и история в localStorage, фишка баланса в шапке (#balance).
// Владелец: блок 3 (Деньги). Суммы считает money.js.
//
// Путь ставки (раунд):
//   live:start  hold()    ставка игрока списана, ставки против закрыты (снимок bets)
//   live:end    end()     результат запомнен
//   RESULT      settle()  расчёт применяется один раз, игроку выплата
//   live:void   refund()  ставка вернулась
// Раунд, который не дошёл до конца (перезагрузка страницы, уход с LIVE клавишами отладки),
// закрывается сам: не доиграли → возврат, доиграли → расчёт. Так баланс всегда сходится.
//
// Для других блоков:
//   wallet.balance          кредиты сейчас (в SETUP это баланс до ставки)
//   wallet.canAfford(n)     хватает ли на ставку n
//   wallet.topUp()          пополнить до MONEY.startBalance → сколько добавили (кнопка в SETUP)
//   wallet.settle(id)       RESULT: { round, settlement } | null, выплата только один раз
//   wallet.round(id)        последний раунд челленджа (VOID берёт отсюда, кому что вернули)
//
// Ядро без DOM: createWallet({ storage }), тесты в jsc подсовывают свою память.
// Ключ хранилища: MONEY.storageKey + путь страницы, чтобы копии на одном localhost не делили кошелёк.

import { MONEY } from './config.js';
import { settle as settleMoney, refundAll, toCents, fromCents, formatCredits } from './money.js';

const VERSION = 1;
const uid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const isOpen = (h) => h.kind === 'round' && (h.status === 'held' || h.status === 'ended');

/**
 * Кошелёк без DOM.
 * storage: как localStorage (getItem/setItem) или null (только память).
 * subscribe(fn): fn({ reason, delta, balance, round }) на каждое изменение,
 *   reason: 'hold' | 'settle' | 'refund' | 'topup' | 'reset' | 'sync'.
 */
export function createWallet({ storage = null, key = MONEY.storageKey, start = MONEY.startBalance, fee = MONEY.APP_FEE, keep = MONEY.historyMax, now = () => Date.now() } = {}) {
  const listeners = new Set();
  let state = load();
  let orphan = null; // live:end без live:start (финиш клавишей во время отсчёта): денег не было

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

  function notify(reason, deltaCents, round = null) {
    const change = { reason, delta: fromCents(deltaCents), balance: fromCents(state.cents), round };
    for (const fn of [...listeners]) {
      try {
        fn(change);
      } catch (err) {
        globalThis.console?.error?.('[wallet]', err);
      }
    }
  }

  function changed(reason, deltaCents, round = null) {
    save();
    notify(reason, deltaCents, round);
  }

  /** Последняя запись истории, для которой match(h) = true. */
  function last(match) {
    for (let i = state.history.length - 1; i >= 0; i--) if (match(state.history[i])) return state.history[i];
    return null;
  }

  const latest = (challengeId) => last((h) => h.kind === 'round' && (challengeId == null || h.challengeId === challengeId));

  function close(round, status, settlement, reason) {
    const pay = toCents(settlement.player.payout);
    state.cents += pay;
    Object.assign(round, { status, settlement, closedAt: now(), balanceAfter: fromCents(state.cents) });
    if (reason) round.reason = reason;
    changed(status === 'settled' ? 'settle' : 'refund', pay, round);
    return round;
  }

  const pay = (r) => close(r, 'settled', settleMoney({ stake: r.stake, bets: r.bets, success: r.success, fee }));
  const giveBack = (r, reason) => close(r, 'refunded', refundAll({ stake: r.stake, bets: r.bets }), reason);

  return {
    get balance() {
      return fromCents(state.cents);
    },

    get history() {
      return state.history.slice();
    },

    /** Раунд, который ещё не закрыт (идёт или ждёт экрана итогов). */
    get open() {
      return last(isOpen);
    },

    canAfford(amount) {
      return toCents(amount) <= state.cents;
    },

    /** live:start: списать ставку игрока. Ставки против в этот момент закрыты: берём снимок. */
    hold(challenge) {
      this.recover('replaced');
      orphan = null;
      const S = Math.max(0, toCents(challenge.stake));
      const round = {
        id: uid('r'),
        kind: 'round',
        challengeId: challenge.id,
        type: challenge.type,
        target: challenge.target,
        stake: fromCents(S),
        bets: (challenge.bets ?? []).map(({ id, name, avatar, amount, bot, female }) => ({ id, name, avatar, amount, bot: !!bot, female: !!female })),
        status: 'held',
        success: null,
        reason: null,
        startedAt: now(),
        balanceBefore: fromCents(state.cents),
      };
      state.cents -= S;
      round.balanceAfter = fromCents(state.cents);
      state.history.push(round);
      changed('hold', -S, round);
      return round;
    },

    /** live:end: запомнить результат. Выплата позже, на экране итогов. */
    end(session) {
      const r = this.open;
      if (!r || r.status !== 'held' || (session?.challengeId != null && r.challengeId !== session.challengeId)) {
        orphan = session?.challengeId ?? null;
        return null;
      }
      orphan = null;
      Object.assign(r, {
        status: 'ended',
        success: !!session.success,
        reason: session.reason ?? null,
        count: session.count ?? null,
        durationSec: session.durationSec ?? null,
        endedAt: now(),
      });
      save();
      return r;
    },

    /** RESULT: применить расчёт один раз. Повторный вызов возвращает ту же запись и ничего не платит. */
    settle(challengeId) {
      const r = challengeId != null && challengeId === orphan ? null : latest(challengeId);
      if (!r) return null;
      if (r.status === 'ended') pay(r);
      return r.settlement ? { round: r, settlement: r.settlement } : null;
    },

    /** live:void: вернуть ставку. Доигранный раунд не отменяется: его результат уже есть. */
    refund(reason = 'void', challengeId = null) {
      const r = this.open;
      if (!r || r.status !== 'held' || (challengeId != null && r.challengeId !== challengeId)) return null;
      return giveBack(r, reason);
    },

    /** Закрыть всё недоигранное: не доиграли → возврат, доиграли → расчёт. Возвращает закрытые раунды. */
    recover(reason = 'interrupted') {
      return state.history.filter(isOpen).map((r) => (r.status === 'ended' ? pay(r) : giveBack(r, reason)));
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
      notify('sync', state.cents - before);
    },

    round(challengeId) {
      return latest(challengeId);
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// ─── Браузер: localStorage, события, фишка в шапке ──────────────

function storageKey() {
  const dir = globalThis.location?.pathname?.replace(/[^/]*$/, '') ?? '';
  return dir ? `${MONEY.storageKey}@${dir}` : MONEY.storageKey;
}

function browserStorage() {
  try {
    const s = globalThis.localStorage;
    s.setItem('protiv:probe', '1');
    s.removeItem('protiv:probe');
    return s;
  } catch {
    return null; // приватный режим или запрет: кошелёк в памяти
  }
}

let core = null;
const get = () => (core ??= createWallet({ storage: browserStorage(), key: storageKey() }));

/** Фишка баланса: число докручивается до нового, рядом всплывает изменение (+19 / −10). */
const chip = {
  el: null,
  value: null,
  shown: 0,
  raf: 0,
  flashTimer: 0,

  mount(el, balance) {
    if (!el) return;
    this.el = el;
    el.classList.add('balance');
    el.innerHTML = '<span class="balance__label">Баланс</span><span class="balance__value"></span><span class="balance__unit">кр.</span>';
    this.value = el.querySelector('.balance__value');
    this.jump(balance);
  },

  jump(balance) {
    cancelAnimationFrame(this.raf);
    this.shown = balance;
    if (this.value) this.value.textContent = formatCredits(balance);
    this.el?.setAttribute('aria-label', `Баланс ${formatCredits(balance)} кр.`);
  },

  to(balance, delta) {
    if (!this.el) return;
    this.el.setAttribute('aria-label', `Баланс ${formatCredits(balance)} кр.`);
    if (delta) this.pop(delta);
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!delta || reduce || document.hidden) return this.jump(balance);
    cancelAnimationFrame(this.raf);
    const from = this.shown;
    const t0 = performance.now();
    const ms = 900;
    const step = (t) => {
      const k = Math.min(1, Math.max(0, (t - t0) / ms)); // метка кадра бывает раньше t0
      const e = 1 - (1 - k) ** 3;
      this.shown = k < 1 ? from + (balance - from) * e : balance;
      this.value.textContent = formatCredits(this.shown);
      if (k < 1) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  },

  pop(delta) {
    const up = delta > 0;
    this.el.classList.remove('is-up', 'is-down');
    void this.el.offsetWidth; // перезапуск вспышки
    this.el.classList.add(up ? 'is-up' : 'is-down');
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.el.classList.remove('is-up', 'is-down'), 1200);
    const d = document.createElement('span');
    d.className = `balance__delta ${up ? 'is-up' : 'is-down'}`;
    d.textContent = formatCredits(delta, { sign: true });
    d.setAttribute('aria-hidden', 'true');
    this.el.append(d);
    d.addEventListener('animationend', () => d.remove(), { once: true });
    setTimeout(() => d.remove(), 2500); // если анимаций нет (скрытая вкладка)
  },
};

export const wallet = {
  init(ctx) {
    const w = get();
    const lost = w.recover(); // перезагрузка посреди челленджа: вернуть ставку или рассчитать
    chip.mount(document.querySelector('#balance'), w.balance);
    ctx.debug.set('баланс', w.balance);

    w.subscribe(({ reason, delta, balance }) => {
      chip.to(balance, delta);
      ctx.debug.set('баланс', balance);
      if (reason === 'topup') ctx.ui.toast(`Пополнили до ${formatCredits(balance)} кр.`, { icon: '🪙', tone: 'ok' });
    });

    ctx.bus.on('live:start', ({ challenge }) => w.hold(challenge));
    ctx.bus.on('live:end', ({ session }) => w.end(session));
    ctx.bus.on('live:void', ({ challenge, reason }) => w.refund(reason ?? 'void', challenge?.id ?? null));
    // Ушли с LIVE: доиграли → расчёт (RESULT обычно уже сделал его сам в enter),
    // не доиграли и не отмена (так бывает только с клавишами отладки) → возврат
    ctx.bus.on('state', ({ from, to }) => {
      const r = w.open;
      if (from !== 'LIVE' || to === 'VOID' || !r) return;
      if (r.status === 'held') w.refund('left');
      else w.settle(r.challengeId);
    });

    addEventListener('storage', (e) => {
      if (e.key === storageKey()) w.reload();
    });

    ctx.debug.key('w', () => {
      w.reset();
      ctx.ui.toast(`Новый профиль: ${formatCredits(w.balance)} кр.`, { icon: '🪙' });
    }, 'кошелёк: новый профиль, 100 кр.');

    // Прошлый раз челлендж оборвался на середине: сказать, что стало со ставкой
    const back = lost.find((r) => r.status === 'refunded');
    if (back) ctx.ui.toast('Прошлый челлендж прервался, ставку вернули', { icon: '↩️' });
    else if (lost.length) ctx.ui.toast('Прошлый челлендж рассчитан, баланс обновлён', { icon: '🪙' });
  },

  /** Кредиты сейчас. В SETUP это баланс до ставки (списание на live:start). */
  get balance() {
    return get().balance;
  },

  canAfford(amount) {
    return get().canAfford(amount);
  },

  /** Пополнить до MONEY.startBalance. Тост и анимация фишки сами. Возвращает, сколько добавили. */
  topUp() {
    return get().topUp();
  },

  settle(challengeId) {
    return get().settle(challengeId);
  },

  round(challengeId) {
    return get().round(challengeId);
  },

  get history() {
    return get().history;
  },

  render() {
    chip.jump(get().balance);
  },
};
