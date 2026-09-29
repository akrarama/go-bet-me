// Расчёт кредитов по разделу 7 спеки. Владелец: блок 3 (Деньги).
// Чистые функции без DOM, чтобы тесты шли в jsc (tests/money.test.js).
// Комиссия: MONEY.APP_FEE из config.js (менять только там).
//
// S: ставка игрока, a_i: ставки друзей против, M = сумма a_i (не больше S, кто раньше), f: комиссия.
//   Сделал:      игрок получает S назад + M × (1 − f). Друзья теряют свои a_i. Приложению M × f.
//   Не сделал:   каждый друг получает a_i назад + a_i × (1 − f). Игрок теряет S.
//                Приложению комиссия и незакрытая часть S − M.
//   Соло (M = 0): сделал → S остаётся игроку, не сделал → вся S приложению.
//   Отмена (VOID): refundAll(), всем возврат полностью.
//
// Округление. Внутри всё в целых сотых кредита (как центы): суммы складываются точно, без ошибок
// двоичных дробей, поэтому ничего не теряется и не появляется. Комиссия берётся с каждой ставки
// против отдельно и округляется вниз до сотой: приложение никогда не берёт больше f, остаток
// сотой достаётся человеку. С целыми ставками и f = 10% округлять вообще не приходится
// (10% от 5 = 0,5 кредита). На экран суммы выводит formatCredits: «9», «4,5», «−10».

import { MONEY } from './config.js';

/** Кредиты → целые сотые: 4.5 → 450. Не число → 0. */
export function toCents(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n * 100) || 0 : 0;
}

/** Целые сотые → кредиты: 450 → 4.5. */
export const fromCents = (c) => c / 100;

// 0.29 * 100 = 28.999999999999996: без поправки округление вниз потеряло бы сотую
const EPS = 1e-6;
const clampFee = (fee) => Math.min(1, Math.max(0, Number(fee) || 0));
/** Комиссия с одной ставки, в сотых: вниз до сотой, в пользу человека. */
const feeOf = (cents, fee) => Math.floor(cents * fee + EPS);

/**
 * Ставки против в пуле: по порядку, пока не закрыта ставка игрока (кто раньше, тот и в пуле).
 * put: сколько из ставки попало в пул, want: сколько друг хотел поставить (в сотых).
 */
function fill(stake, bets = []) {
  const S = Math.max(0, toCents(stake));
  let room = S;
  const rows = bets.map((bet) => {
    const want = Math.max(0, toCents(bet.amount));
    const put = Math.min(want, room);
    room -= put;
    return { bet, want, put };
  });
  return { S, M: S - room, rows };
}

const friendRow = ({ bet, want, put }, fee, payout) => ({
  id: bet.id,
  name: bet.name ?? '',
  avatar: bet.avatar ?? '',
  bot: !!bet.bot,
  female: !!bet.female,
  amount: fromCents(put), // сколько из ставки друга попало в пул
  ...(put < want ? { requested: fromCents(want) } : {}), // хотел больше, но пул закрылся
  ...(want > 0 && put === 0 ? { full: true } : {}), // пришёл, когда пул был полон
  fee: fromCents(fee), // комиссия, которую заплатил этот друг (только когда выиграл)
  payout: fromCents(payout), // сколько друг получает при расчёте
  delta: fromCents(payout - put), // итог для друга
});

/**
 * Расчёт по итогам челленджа.
 * @param {{ stake: number, bets: { id: string, name: string, avatar?: string, amount: number, bot?: boolean }[], success: boolean, fee?: number }} p
 * @returns {{
 *   success: boolean, voided: false, fee: number,
 *   stake: number,   // S
 *   pool: number,    // M: сколько против попало в пул
 *   open: number,    // S − M: сколько ставки никто не закрыл
 *   solo: boolean,   // M = 0
 *   player:   { stake, payout, delta, fee },
 *   friends:  { id, name, avatar, bot, amount, requested?, full?, fee, payout, delta }[],
 *   creators: { fee, uncovered, payout, delta },
 * }}
 * payout: сколько участник получает при расчёте (ставка игрока к этому моменту уже списана),
 * delta = payout − вложенное: итог для участника. Сумма delta всех участников всегда 0.
 */
export function settle({ stake, bets = [], success, fee = MONEY.APP_FEE }) {
  const f = clampFee(fee);
  const { S, M, rows } = fill(stake, bets);
  const win = !!success;
  const cuts = rows.map((r) => feeOf(r.put, f));
  const F = cuts.reduce((sum, c) => sum + c, 0);

  const playerPayout = win ? S + M - F : 0;
  const uncovered = win ? 0 : S - M;
  const creatorsPayout = F + uncovered;

  return {
    success: win,
    voided: false,
    fee: f,
    stake: fromCents(S),
    pool: fromCents(M),
    open: fromCents(S - M),
    solo: M === 0,
    player: { stake: fromCents(S), payout: fromCents(playerPayout), delta: fromCents(playerPayout - S), fee: fromCents(win ? F : 0) },
    friends: rows.map((r, i) => friendRow(r, win ? 0 : cuts[i], win ? 0 : 2 * r.put - cuts[i])),
    creators: { fee: fromCents(F), uncovered: fromCents(uncovered), payout: fromCents(creatorsPayout), delta: fromCents(creatorsPayout) },
  };
}

/** Отмена (VOID): всем возврат полностью. Та же форма, что у settle(), все delta = 0. */
export function refundAll({ stake, bets = [] }) {
  const { S, M, rows } = fill(stake, bets);
  return {
    success: null,
    voided: true,
    fee: 0,
    stake: fromCents(S),
    pool: fromCents(M),
    open: fromCents(S - M),
    solo: M === 0,
    player: { stake: fromCents(S), payout: fromCents(S), delta: 0, fee: 0 },
    friends: rows.map((r) => friendRow(r, 0, r.put)),
    creators: { fee: 0, uncovered: 0, payout: 0, delta: 0 },
  };
}

/** Сколько против уже в пуле (M), кредиты. */
export const poolTotal = ({ stake, bets = [] }) => fromCents(fill(stake, bets).M);

/** Сколько ещё можно поставить против (S − M), кредиты. */
export function poolLeft({ stake, bets = [] }) {
  const { S, M } = fill(stake, bets);
  return fromCents(S - M);
}

/**
 * Принять ставку против: сумма против не больше ставки игрока, кто раньше, тот и в пуле.
 * Принятая ставка добавляется в challenge.bets. Возвращает { status, bet, left }:
 *   'ok'       принята целиком
 *   'trimmed'  влезла только часть: bet.amount меньше, bet.requested = сколько хотел
 *   'full'     пул уже полон, bet = null
 *   'repeat'   этот друг уже ставил, bet = его прежняя ставка (вторая не добавляется)
 *   'invalid'  сумма не больше нуля, bet = null
 * left: сколько ещё можно поставить против после этой ставки.
 */
export function acceptBet(challenge, bet) {
  const bets = (challenge.bets ??= []);
  const prev = bets.find((b) => b.id === bet.id);
  if (prev) return { status: 'repeat', bet: prev, left: poolLeft(challenge) };
  const want = toCents(bet.amount);
  if (want <= 0) return { status: 'invalid', bet: null, left: poolLeft(challenge) };
  const room = toCents(poolLeft(challenge));
  if (room <= 0) return { status: 'full', bet: null, left: 0 };
  const put = Math.min(want, room);
  const accepted = { ...bet, amount: fromCents(put) };
  if (put < want) accepted.requested = fromCents(want);
  bets.push(accepted);
  return { status: put < want ? 'trimmed' : 'ok', bet: accepted, left: fromCents(room - put) };
}

const MINUS = '−'; // знак минуса «−», не тире

/**
 * Сумма для экрана: 9 → «9», 4.5 → «4,5», 0.05 → «0,05», −10 → «−10», 12500 → «12 500».
 * sign: true ставит «+» перед положительными (изменение баланса).
 */
export function formatCredits(x, { sign = false } = {}) {
  const c = toCents(x);
  const abs = Math.abs(c);
  let s = String(Math.floor(abs / 100));
  if (s.length > 4) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const frac = abs % 100;
  if (frac) s += `,${String(frac).padStart(2, '0').replace(/0$/, '')}`;
  return (c < 0 ? MINUS : sign && c > 0 ? '+' : '') + s;
}

/** Комиссия для текста: 0.1 → «10%». */
export const formatFee = (fee = MONEY.APP_FEE) => `${Math.round(clampFee(fee) * 1000) / 10}%`.replace('.', ',');

/**
 * Форма слова после числа: plural(5, 'кредит', 'кредита', 'кредитов') → 'кредитов'.
 * Дробные числа: форма «кредита» (4,5 кредита).
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
