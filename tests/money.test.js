// Тесты блока 3 (Деньги): расчёт по разделу 7 спеки (пример S = 10, два друга по 5),
// ставки против в пул, суммы для экрана. Всё на синтетике, без DOM, идёт в jsc.

import { settle, refundAll, acceptBet, poolLeft, poolTotal, toCents, formatCredits, formatFee, plural } from '../src/money.js';

const bet = (id, amount, extra = {}) => ({ id, name: id, avatar: '', amount, ...extra });
const two5 = () => [bet('dima', 5, { bot: true }), bet('anya', 5, { bot: true })];

/** Сумма всех изменений в сотых: деньги не теряются и не появляются, значит 0. */
const net = (s) => toCents(s.player.delta) + s.friends.reduce((sum, f) => sum + toCents(f.delta), 0) + toCents(s.creators.delta);
/** Вложили (игрок S + друзья M) и выплатили (всем): должно совпасть. */
const paidIn = (s) => toCents(s.player.stake) + s.friends.reduce((sum, f) => sum + toCents(f.amount), 0);
const paidOut = (s) => toCents(s.player.payout) + s.friends.reduce((sum, f) => sum + toCents(f.payout), 0) + toCents(s.creators.payout);
const deltas = (s) => s.friends.map((f) => f.delta);

function moneyTests(t) {
  t.test('пример из спеки, f = 0: сделал → игроку +10, друзья теряют по 5', (a) => {
    const s = settle({ stake: 10, bets: two5(), success: true, fee: 0 });
    a.eq(s.player.delta, 10, 'итог игрока');
    a.eq(s.player.payout, 20, 'игрок получает S назад + M');
    a.deep(deltas(s), [-5, -5], 'друзья');
    a.eq(s.creators.delta, 0, 'приложению');
    a.eq(s.pool, 10);
    a.eq(s.open, 0);
    a.eq(net(s), 0);
  });

  t.test('пример из спеки, f = 0: не сделал → друзьям по +5, игрок теряет 10', (a) => {
    const s = settle({ stake: 10, bets: two5(), success: false, fee: 0 });
    a.eq(s.player.delta, -10);
    a.eq(s.player.payout, 0);
    a.deep(deltas(s), [5, 5]);
    a.deep(s.friends.map((f) => f.payout), [10, 10], 'каждый получает свою ставку назад + столько же');
    a.eq(s.creators.delta, 0, 'пул закрыт полностью, незакрытой части нет');
    a.eq(net(s), 0);
  });

  t.test('f = 0.1, сделал: игроку S назад + M × 0.9, приложению M × 0.1', (a) => {
    const s = settle({ stake: 10, bets: two5(), success: true, fee: 0.1 });
    a.eq(s.player.payout, 19);
    a.eq(s.player.delta, 9);
    a.eq(s.player.fee, 1);
    a.deep(deltas(s), [-5, -5]);
    a.eq(s.creators.fee, 1);
    a.eq(s.creators.uncovered, 0);
    a.eq(s.creators.delta, 1);
    a.eq(net(s), 0);
  });

  t.test('f = 0.1, не сделал: каждому другу a_i назад + a_i × 0.9', (a) => {
    const s = settle({ stake: 10, bets: two5(), success: false, fee: 0.1 });
    a.deep(s.friends.map((f) => f.payout), [9.5, 9.5]);
    a.deep(deltas(s), [4.5, 4.5]);
    a.deep(s.friends.map((f) => f.fee), [0.5, 0.5]);
    a.eq(s.player.delta, -10);
    a.eq(s.creators.fee, 1);
    a.eq(s.creators.delta, 1);
    a.eq(net(s), 0);
  });

  t.test('комиссия по умолчанию берётся из MONEY.APP_FEE (10%)', (a) => {
    const s = settle({ stake: 10, bets: two5(), success: true });
    a.eq(s.fee, 0.1);
    a.eq(s.player.delta, 9);
  });

  t.test('соло, сделал: ставка остаётся игроку, приложению ничего', (a) => {
    const s = settle({ stake: 10, bets: [], success: true, fee: 0.1 });
    a.ok(s.solo);
    a.eq(s.player.payout, 10);
    a.eq(s.player.delta, 0);
    a.eq(s.creators.delta, 0);
    a.eq(net(s), 0);
  });

  t.test('соло, не сделал: вся ставка создателям', (a) => {
    const s = settle({ stake: 10, bets: [], success: false, fee: 0.1 });
    a.eq(s.player.delta, -10);
    a.eq(s.creators.uncovered, 10);
    a.eq(s.creators.fee, 0);
    a.eq(s.creators.delta, 10);
    a.eq(net(s), 0);
  });

  t.test('частично закрытый пул S = 20, против 10: сделал → +9, незакрытое остаётся игроку', (a) => {
    const s = settle({ stake: 20, bets: two5(), success: true, fee: 0.1 });
    a.eq(s.pool, 10);
    a.eq(s.open, 10);
    a.eq(s.player.payout, 29);
    a.eq(s.player.delta, 9);
    a.eq(s.creators.uncovered, 0);
    a.eq(s.creators.delta, 1);
    a.eq(net(s), 0);
  });

  t.test('частично закрытый пул S = 20, против 10: не сделал → незакрытые 10 создателям', (a) => {
    const s = settle({ stake: 20, bets: two5(), success: false, fee: 0.1 });
    a.eq(s.player.delta, -20);
    a.deep(deltas(s), [4.5, 4.5]);
    a.eq(s.creators.fee, 1);
    a.eq(s.creators.uncovered, 10);
    a.eq(s.creators.delta, 11);
    a.eq(net(s), 0);
  });

  t.test('сумма против не больше ставки: кто раньше, лишнее обрезается, опоздавшим пул полон', (a) => {
    const s = settle({ stake: 7, bets: [bet('a', 5), bet('b', 5), bet('c', 5)], success: false, fee: 0 });
    a.deep(s.friends.map((f) => f.amount), [5, 2, 0]);
    a.eq(s.friends[1].requested, 5);
    a.ok(s.friends[2].full, 'третий пришёл в полный пул');
    a.deep(deltas(s), [5, 2, 0], 'опоздавший ничего не теряет и не получает');
    a.eq(s.pool, 7);
    a.eq(net(s), 0);
    a.eq(paidIn(s), paidOut(s));
  });

  t.test('округление: комиссия вниз до сотой, в пользу человека', (a) => {
    const s = settle({ stake: 3.33, bets: [bet('a', 3.33)], success: false, fee: 0.1 });
    a.eq(s.friends[0].fee, 0.33, '10% от 3,33 = 0,333 → 0,33');
    a.eq(s.friends[0].payout, 6.33);
    a.eq(s.creators.delta, 0.33);
    a.eq(net(s), 0);
    const odd = settle({ stake: 2.9, bets: [bet('a', 2.9)], success: true, fee: 0.1 });
    a.eq(odd.player.fee, 0.29, '0,29 не превращается в 0,28 из-за двоичных дробей');
  });

  t.test('деньги сходятся на любых суммах: ничего не теряется и не появляется', (a) => {
    const stakes = [0, 1, 5, 7, 10, 20, 33.33, 0.01];
    const pools = [[], [5], [5, 5], [3, 3, 3], [0.33, 0.33, 0.34], [100], [1.11, 2.22, 5]];
    const fees = [0, 0.1, 0.15, 1 / 3, 0.5, 1];
    let checked = 0;
    for (const stake of stakes)
      for (const amounts of pools)
        for (const fee of fees)
          for (const success of [true, false]) {
            const s = settle({ stake, bets: amounts.map((x, i) => bet(`f${i}`, x)), success, fee });
            const tag = `S=${stake} bets=${amounts} f=${fee} ${success ? 'сделал' : 'не сделал'}:`;
            a.eq(net(s), 0, `${tag} сумма изменений`);
            a.eq(paidIn(s), paidOut(s), `${tag} вложили = выплатили`);
            a.ok(toCents(s.pool) <= toCents(s.stake), `${tag} M ≤ S`);
            a.ok(s.friends.every((f) => f.payout >= 0) && s.player.payout >= 0 && s.creators.payout >= 0, `${tag} выплаты не отрицательные`);
            a.ok(toCents(s.creators.fee) <= Math.round(toCents(s.pool) * fee + 1e-6), `${tag} комиссия не больше f`);
            checked++;
          }
    a.eq(checked, stakes.length * pools.length * fees.length * 2);
  });

  t.test('отмена: всем возврат полностью', (a) => {
    const s = refundAll({ stake: 10, bets: two5() });
    a.ok(s.voided);
    a.eq(s.player.payout, 10);
    a.eq(s.player.delta, 0);
    a.deep(s.friends.map((f) => f.payout), [5, 5]);
    a.deep(deltas(s), [0, 0]);
    a.eq(s.creators.delta, 0);
    a.eq(paidIn(s), paidOut(s));
  });

  t.test('acceptBet: кто раньше, тот и в пуле, остальным «пул полон»', (a) => {
    const ch = { stake: 10, bets: [] };
    a.eq(acceptBet(ch, bet('dima', 5)).status, 'ok');
    a.eq(poolLeft(ch), 5);
    const second = acceptBet(ch, bet('anya', 5));
    a.eq(second.status, 'ok');
    a.eq(second.left, 0);
    const late = acceptBet(ch, bet('vasya', 5));
    a.eq(late.status, 'full');
    a.eq(late.bet, null);
    a.eq(acceptBet(ch, bet('dima', 5)).status, 'repeat', 'второй раз тот же друг не ставит');
    a.eq(ch.bets.length, 2);
    a.eq(poolTotal(ch), 10);
  });

  t.test('acceptBet: ставка больше остатка обрезается до остатка', (a) => {
    const ch = { stake: 7, bets: [] };
    acceptBet(ch, bet('dima', 5));
    const r = acceptBet(ch, bet('anya', 5));
    a.eq(r.status, 'trimmed');
    a.eq(r.bet.amount, 2);
    a.eq(r.bet.requested, 5);
    a.eq(poolLeft(ch), 0);
    a.eq(acceptBet({ stake: 5, bets: [] }, bet('x', 0)).status, 'invalid');
    const small = { stake: 5, bets: [] };
    acceptBet(small, bet('dima', 5));
    a.eq(acceptBet(small, bet('anya', 5)).status, 'full', 'ставка 5: второй бот уже не влезает');
  });

  t.test('суммы для экрана: без длинного тире, минус настоящий', (a) => {
    a.eq(formatCredits(9), '9');
    a.eq(formatCredits(4.5), '4,5');
    a.eq(formatCredits(0.05), '0,05');
    a.eq(formatCredits(-10), '−10');
    a.eq(formatCredits(9, { sign: true }), '+9');
    a.eq(formatCredits(0, { sign: true }), '0');
    a.eq(formatCredits(-0.001, { sign: true }), '0', 'меньше сотой = 0, без «−0»');
    a.eq(formatCredits(12500), '12 500');
    a.eq(formatCredits(1000), '1000');
    a.eq(formatFee(0.1), '10%');
    a.eq(formatFee(0.125), '12,5%');
    for (const x of [-10, -4.5, 0, 4.5, 9, 12500]) a.ok(!/[–—]/.test(formatCredits(x, { sign: true })), `нет тире в ${x}`);
  });

  t.test('plural: 1 кредит, 2 кредита, 5 кредитов, 4,5 кредита', (a) => {
    const w = (n) => plural(n, 'кредит', 'кредита', 'кредитов');
    a.deep([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 100, 101].map(w), ['кредит', 'кредита', 'кредита', 'кредитов', 'кредитов', 'кредитов', 'кредитов', 'кредит', 'кредита', 'кредитов', 'кредитов', 'кредит']);
    a.eq(w(4.5), 'кредита');
    a.eq(w(0), 'кредитов');
  });
}

export default (t) => {
  moneyTests(t);
};
