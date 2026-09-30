// Кошелёк: баланс и история в localStorage, фишка баланса в шапке (#balance).
// Владелец: блок 3 (Деньги). Суммы считает money.js.
//
// Путь ставки (раунд):
//   live:start  hold()    ставка игрока списана (не больше баланса), ставки против закрыты (снимок bets)
//   live:end    end()     результат запомнен
//   RESULT      settle()  расчёт применяется один раз, игроку выплата
//   live:void   refund()  ставка вернулась
//   bet:withdrawn withdraw()  друг по ссылке ушёл посреди раунда: его ставка выходит из расчёта
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
 * Сохранённое → состояние кошелька, или null, если это не кошелёк. Терпимо к старому: баланс не должен пропадать
 * из-за лишней строгости. Понимаем v1 ({ v, cents, history }; поля раундов requested, left, tab добавлялись со временем
 * и необязательны) и заготовку 29.09 ({ balance, history }, кредиты числом). Кредиты строкой или дробью округляем.
 * В истории остаются записи-объекты с видом (kind), у раундов гарантированы ставка числом и список ставок.
 */
export function readState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const num = (x) => (typeof x === 'number' || (typeof x === 'string' && x.trim() !== '') ? Number(x) : NaN);
  let cents;
  if (raw.v === VERSION || (raw.v == null && 'cents' in raw)) cents = num(raw.cents);
  else if (raw.v == null && typeof raw.balance === 'number') cents = toCents(raw.balance);
  else return null;
  if (!Number.isFinite(cents)) return null;
  const history = (Array.isArray(raw.history) ? raw.history : [])
    .filter((h) => h && typeof h === 'object' && typeof h.kind === 'string')
    .map((h) => (h.kind === 'round' ? { ...h, stake: Number.isFinite(num(h.stake)) ? num(h.stake) : 0, bets: Array.isArray(h.bets) ? h.bets : [] } : h));
  return { v: VERSION, cents: Math.round(cents), history };
}

/**
 * Что показать бейджем у фишки баланса. Списание и возврат: сколько ушло или пришло.
 * Расчёт: чистый итог раунда (+9 / −10), как на карточке итогов, а не выплата вместе с вернувшейся ставкой (+19).
 */
export function badgeOf({ reason, delta, round }) {
  return reason === 'settle' && round?.settlement ? round.settlement.player.delta : delta;
}

/**
 * Кошелёк без DOM.
 * storage: как localStorage (getItem/setItem) или null (только память).
 * subscribe(fn): fn({ reason, delta, balance, round }) на каждое изменение,
 *   reason: 'hold' | 'settle' | 'refund' | 'topup' | 'reset' | 'sync'.
 */
export function createWallet({ storage = null, key = MONEY.storageKey, start = MONEY.startBalance, fee = MONEY.APP_FEE, keep = MONEY.historyMax, now = () => Date.now(), tab = null } = {}) {
  const listeners = new Set();
  // раунд другой вкладки (у него другая метка tab): пока та вкладка жива, его нельзя считать брошенным
  const foreign = (r) => tab != null && r.tab != null && r.tab !== tab;
  let state = load();
  let orphan = null; // live:end без live:start (финиш клавишей во время отсчёта): денег не было

  function fresh() {
    return { v: VERSION, cents: toCents(start), history: [{ id: uid('p'), kind: 'profile', at: now(), balanceAfter: start }] };
  }

  function load() {
    try {
      const s = readState(JSON.parse(storage?.getItem(key) ?? 'null'));
      if (s) return s;
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
  // открытый раунд этого челленджа (без id: последний открытый); при двух вкладках последний открытый может быть чужим
  const openOf = (challengeId) => last((h) => isOpen(h) && (challengeId == null || h.challengeId === challengeId));

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

    /** Открытый раунд этой вкладки (чужие раунды другой вкладки не в счёт). */
    get ownOpen() {
      return last((h) => isOpen(h) && !foreign(h));
    },

    canAfford(amount) {
      return toCents(amount) <= state.cents;
    },

    /** live:start: списать ставку игрока. Ставки против в этот момент закрыты: берём снимок. */
    hold(challenge) {
      this.recover('replaced', { skip: foreign }); // брошенное нами закрываем, чужой живой раунд не трогаем
      orphan = null;
      const want = Math.max(0, toCents(challenge.stake));
      // не больше, чем есть на счёте: вторая вкладка или прыжок клавишей отладки не уводят баланс в минус
      const S = Math.min(want, Math.max(0, state.cents));
      const round = {
        id: uid('r'),
        kind: 'round',
        challengeId: challenge.id,
        type: challenge.type,
        target: challenge.target,
        stake: fromCents(S),
        ...(S < want ? { requested: fromCents(want) } : {}), // хотел поставить больше, чем было
        bets: (challenge.bets ?? []).map(({ id, name, avatar, amount, bot, female }) => ({ id, name, avatar, amount, bot: !!bot, female: !!female })),
        status: 'held',
        success: null,
        reason: null,
        startedAt: now(),
        ...(tab != null ? { tab } : {}),
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
      const r = openOf(session?.challengeId);
      if (!r || r.status !== 'held') {
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

    /**
     * bet:withdrawn: друг ушёл посреди раунда. Его ставка выходит из расчёта (ни выплаты, ни комиссии), а запись
     * остаётся в round.left: на итогах видно «ушёл, ставка возвращена». Уже рассчитанный раунд не трогаем.
     */
    withdraw(challengeId, betId) {
      const r = latest(challengeId);
      if (!r || (r.status !== 'held' && r.status !== 'ended')) return null;
      const i = r.bets.findIndex((b) => b.id === betId);
      if (i < 0) return null;
      const [bet] = r.bets.splice(i, 1);
      (r.left ??= []).push({ id: bet.id, name: bet.name, avatar: bet.avatar, amount: bet.amount });
      save();
      return bet;
    },

    /** live:void: вернуть ставку. Доигранный раунд не отменяется: его результат уже есть. */
    refund(reason = 'void', challengeId = null) {
      const r = openOf(challengeId);
      if (!r || r.status !== 'held') return null;
      return giveBack(r, reason);
    },

    /** Закрыть всё недоигранное: не доиграли → возврат, доиграли → расчёт. skip(round): раунды, которые не трогать. Возвращает закрытые. */
    recover(reason = 'interrupted', { skip = null } = {}) {
      return state.history.filter((r) => isOpen(r) && !skip?.(r)).map((r) => (r.status === 'ended' ? pay(r) : giveBack(r, reason)));
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

// Эта загрузка страницы. У раундов метка вкладки, чтобы вторая вкладка не приняла живой раунд первой за брошенный.
const TAB = uid('t');

let core = null;
const get = () => (core ??= createWallet({ storage: browserStorage(), key: storageKey(), tab: TAB }));

/** Раунд этой вкладки держит замок Web Locks, пока страница жива (закрыли или перезагрузили: замок снимается сам). */
function keepRound(id) {
  try {
    Promise.resolve(globalThis.navigator?.locks?.request(`protiv-round:${id}`, () => new Promise(() => {}))).catch(() => {});
  } catch {
    /* без Web Locks другие вкладки просто не узнают, что раунд живой */
  }
}

/** id раундов, которые сейчас держит какая-то живая вкладка. */
async function liveRoundIds() {
  try {
    const { held } = await globalThis.navigator.locks.query();
    return new Set(held.filter((l) => l.name.startsWith('protiv-round:')).map((l) => l.name.slice('protiv-round:'.length)));
  } catch {
    return new Set();
  }
}

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

  /** balance: новое значение; delta: на сколько оно изменилось (число докручивается); badge: что написать в бейдже. */
  to(balance, delta, badge = delta) {
    if (!this.el) return;
    this.el.setAttribute('aria-label', `Баланс ${formatCredits(balance)} кр.`);
    if (badge) this.pop(badge);
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!delta || reduce || document.hidden) return this.jump(balance);
    cancelAnimationFrame(this.raf);
    const from = this.shown;
    const t0 = performance.now();
    const ms = 900;
    const step = () => {
      // от performance.now(), а не от метки кадра: та бывает раньше t0 или отстаёт (виртуальное время)
      const k = Math.min(1, Math.max(0, (performance.now() - t0) / ms));
      const e = 1 - (1 - k) ** 3;
      this.shown = k < 1 ? from + (balance - from) * e : balance;
      this.value.textContent = formatCredits(k < 1 ? Math.round(this.shown) : balance); // по пути целые, без мелькания дробей
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
    // Раунд остался открытым (перезагрузка посреди челленджа, вкладку закрыли): вернуть ставку или рассчитать.
    // Если открыт чужой раунд, а Web Locks есть, сначала узнаём, жива ли та вкладка (recoverOrphans ниже).
    const checkLocks = Boolean(w.open) && typeof globalThis.navigator?.locks?.query === 'function';
    const lost = w.open && !checkLocks ? w.recover() : [];
    let quiet = false; // возврат при запуске: число баланса просто встаёт на место, без бейджа
    chip.mount(document.querySelector('#balance'), w.balance);
    ctx.debug.set('баланс', w.balance);

    w.subscribe((change) => {
      const { reason, delta, balance, round } = change;
      if (quiet) chip.jump(balance);
      else chip.to(balance, delta, badgeOf(change));
      ctx.debug.set('баланс', balance);
      if (reason === 'topup') ctx.ui.toast(`Пополнили до ${formatCredits(balance)} кр.`, { icon: '🪙', tone: 'ok' });
      if (reason === 'hold' && round?.requested != null)
        ctx.ui.toast(round.stake ? `Не хватало кредитов, ставка уменьшена до ${formatCredits(round.stake)} кр.` : 'Кредитов нет, играем без ставки', { icon: '🪙' });
    });

    ctx.bus.on('live:start', ({ challenge }) => {
      const round = w.hold(challenge);
      if (round) keepRound(round.id);
    });
    ctx.bus.on('live:end', ({ session }) => w.end(session));
    ctx.bus.on('live:void', ({ challenge, reason }) => w.refund(reason ?? 'void', challenge?.id ?? null));
    ctx.bus.on('bet:withdrawn', ({ bet, challenge }) => w.withdraw(challenge?.id, bet?.id)); // друг по ссылке ушёл посреди раунда
    // Ушли с LIVE: доиграли → расчёт (RESULT обычно уже сделал его сам в enter),
    // не доиграли и не отмена (так бывает только с клавишами отладки) → возврат
    ctx.bus.on('state', ({ from, to }) => {
      const r = w.ownOpen; // раунд другой вкладки не наш
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
    const say = (done) => {
      const back = done.find((r) => r.status === 'refunded');
      if (back) ctx.ui.toast('Прошлый челлендж прервался, ставку вернули', { icon: '↩️' });
      else if (done.length) ctx.ui.toast('Прошлый челлендж рассчитан, баланс обновлён', { icon: '🪙' });
    };
    say(lost);

    // Открытый раунд мог остаться от другой ЖИВОЙ вкладки: её не трогаем. Замок ещё держится у страницы, которая
    // только что перезагрузилась: проверяем несколько раз, пока он не снимется.
    if (checkLocks) {
      (async () => {
        for (const wait of [0, 1500, 3500, 8000]) {
          if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
          const live = await liveRoundIds();
          quiet = true;
          const done = w.recover('interrupted', { skip: (r) => r.tab === TAB || live.has(r.id) });
          quiet = false;
          say(done);
          if (!w.open || w.open.tab === TAB) break;
        }
      })();
    }
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
