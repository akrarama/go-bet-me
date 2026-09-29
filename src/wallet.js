// Баланс и история в localStorage, фишка баланса в шапке (#balance).
// Владелец: блок 3 (Деньги). Сейчас заглушка: только показывает баланс.

import { MONEY } from './config.js';

function read() {
  try {
    return JSON.parse(localStorage.getItem(MONEY.storageKey));
  } catch {
    return null;
  }
}

export const wallet = {
  state: null,

  init() {
    this.state = read() ?? { balance: MONEY.startBalance, history: [] };
    this.render();
  },

  get balance() {
    return this.state?.balance ?? MONEY.startBalance;
  },

  render() {
    const el = document.querySelector('#balance');
    if (el) el.textContent = `${this.balance} кр.`;
  },
};
