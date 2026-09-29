// Расчёт кредитов по разделу 7 спеки. Владелец: блок 3 (Деньги). Сейчас заглушка.
// Чистая функция без DOM, чтобы тесты шли в jsc (tests/money.test.js).
// Комиссия: MONEY.APP_FEE из config.js (менять только там).

import { MONEY } from './config.js';

/**
 * @param {{ stake: number, bets: { id: string, name: string, amount: number }[], success: boolean, fee?: number }} p
 */
export function settle({ stake, bets, success, fee = MONEY.APP_FEE }) {
  return { stake, success, fee, player: { delta: 0 }, friends: bets.map((b) => ({ ...b, delta: 0 })), creators: 0 };
}
