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

// ─── Кошелёк (src/wallet.js) ─────────────────────────────────────

import { createWallet } from '../src/wallet.js';

/** Память вместо localStorage. fail: запись бросает ошибку, как в приватном режиме. */
function memory({ fail = false } = {}) {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      if (fail) throw new Error('QuotaExceededError');
      m.set(k, String(v));
    },
    removeItem: (k) => m.delete(k),
  };
}
let seq = 0;
const challenge = (over = {}) => ({ id: `c${++seq}`, type: 'squat', target: 10, stake: 10, bets: two5(), ...over });
const finished = (ch, success) => ({ challengeId: ch.id, count: success ? ch.target : 3, success, reason: success ? 'target' : 'time', durationSec: 40 });
/** Раунд целиком: live:start → live:end → экран итогов. */
function play(w, ch, success) {
  w.hold(ch);
  w.end(finished(ch, success));
  return w.settle(ch.id);
}

function walletTests(t) {
  t.test('кошелёк: новый профиль, 100 кредитов', (a) => {
    const w = createWallet({ storage: memory() });
    a.eq(w.balance, 100);
    a.ok(w.canAfford(100));
    a.ok(!w.canAfford(100.01));
    a.eq(w.open, null);
  });

  t.test('кошелёк: ставка списывается на старте, выплата на итогах и только один раз', (a) => {
    const w = createWallet({ storage: memory() });
    const ch = challenge();
    w.hold(ch);
    a.eq(w.balance, 90, 'после live:start');
    w.end(finished(ch, true));
    a.eq(w.balance, 90, 'до экрана итогов выплаты нет');
    const res = w.settle(ch.id);
    a.eq(w.balance, 109, 'S назад + M × 0.9');
    a.eq(res.settlement.player.delta, 9);
    a.eq(res.round.balanceBefore, 100);
    a.eq(res.round.balanceAfter, 109);
    const again = w.settle(ch.id);
    a.eq(w.balance, 109, 'второй вход на экран итогов не платит');
    a.eq(again.round.id, res.round.id);
  });

  t.test('кошелёк: не сделал → ставка потеряна', (a) => {
    const w = createWallet({ storage: memory() });
    const res = play(w, challenge(), false);
    a.eq(w.balance, 90);
    a.eq(res.settlement.player.delta, -10);
    a.eq(res.round.status, 'settled');
  });

  t.test('кошелёк: соло, сделал → ставка вернулась, не сделал → ушла создателям', (a) => {
    const w = createWallet({ storage: memory() });
    play(w, challenge({ bets: [] }), true);
    a.eq(w.balance, 100);
    play(w, challenge({ bets: [] }), false);
    a.eq(w.balance, 90);
  });

  t.test('кошелёк: отмена возвращает ставку, итогов после неё нет', (a) => {
    const w = createWallet({ storage: memory() });
    const ch = challenge();
    w.hold(ch);
    const r = w.refund('camera', ch.id);
    a.eq(w.balance, 100);
    a.eq(r.status, 'refunded');
    a.eq(r.reason, 'camera');
    a.ok(r.settlement.voided);
    a.deep(r.settlement.friends.map((f) => f.payout), [5, 5], 'друзьям вернули их ставки');
    a.eq(w.refund('camera', ch.id), null, 'второй возврат не делается');
    a.ok(w.settle(ch.id).settlement.voided, 'по челленджу видно, что его отменили');
    a.eq(w.end(finished(ch, true)), null, 'финиш после отмены ничего не меняет');
    w.settle(ch.id);
    a.eq(w.balance, 100, 'после отмены выплат нет');
  });

  t.test('кошелёк: после финиша отмена уже не срабатывает', (a) => {
    const w = createWallet({ storage: memory() });
    const ch = challenge();
    w.hold(ch);
    w.end(finished(ch, true));
    a.eq(w.refund('camera', ch.id), null);
    w.settle(ch.id);
    a.eq(w.balance, 109);
  });

  t.test('кошелёк: финиш без старта (клавиша во время отсчёта) не показывает прошлый расчёт', (a) => {
    const w = createWallet({ storage: memory() });
    const ch = challenge();
    play(w, ch, true);
    a.eq(w.end(finished(ch, false)), null, 'ставку в этот раз не списывали');
    a.eq(w.settle(ch.id), null);
    a.eq(w.balance, 109);
    play(w, ch, false); // тот же челлендж ещё раз, уже по-настоящему
    a.eq(w.balance, 99);
  });

  t.test('кошелёк: отмена до старта ничего не возвращает, потому что ничего не списано', (a) => {
    const w = createWallet({ storage: memory() });
    const seen = [];
    w.subscribe((c) => seen.push(c.reason));
    a.eq(w.refund('camera', challenge().id), null);
    a.eq(w.balance, 100);
    a.eq(seen.length, 0, 'фишка баланса не дёргается');
  });

  t.test('кошелёк: ставки против после старта не меняют расчёт (снимок на live:start)', (a) => {
    const w = createWallet({ storage: memory() });
    const ch = challenge({ bets: [bet('dima', 5, { bot: true })] });
    w.hold(ch);
    ch.bets.push(bet('late', 5));
    w.end(finished(ch, true));
    a.eq(w.settle(ch.id).settlement.pool, 5);
    a.eq(w.balance, 104.5);
  });

  t.test('кошелёк: перезагрузка посреди челленджа → ставку вернули', (a) => {
    const storage = memory();
    createWallet({ storage }).hold(challenge());
    const w = createWallet({ storage });
    a.eq(w.balance, 90, 'списание сохранилось');
    const closed = w.recover();
    a.eq(closed.length, 1);
    a.eq(closed[0].status, 'refunded');
    a.eq(w.balance, 100);
    a.eq(createWallet({ storage }).balance, 100, 'возврат тоже сохранён');
  });

  t.test('кошелёк: перезагрузка между финишем и итогами → расчёт применяется', (a) => {
    const storage = memory();
    const ch = challenge();
    const w1 = createWallet({ storage });
    w1.hold(ch);
    w1.end(finished(ch, true));
    const w2 = createWallet({ storage });
    w2.recover();
    a.eq(w2.balance, 109);
    a.eq(w2.settle(ch.id).settlement.player.delta, 9, 'экран итогов покажет тот же расчёт');
    a.eq(w2.balance, 109);
  });

  t.test('кошелёк: новый старт закрывает брошенный раунд, списана одна ставка', (a) => {
    const w = createWallet({ storage: memory() });
    const ch = challenge();
    w.hold(ch);
    w.hold(ch); // тот же челлендж ещё раз (клавиша 5 в отладке)
    a.eq(w.balance, 90);
    a.eq(w.history.filter((h) => h.kind === 'round').map((h) => h.status).join(), 'refunded,held');
  });

  t.test('кошелёк: десять раундов подряд сходятся с историей', (a) => {
    const storage = memory();
    let w = createWallet({ storage });
    const plan = [
      [10, two5(), true], [10, two5(), false], [20, two5(), true], [20, two5(), false], [5, [bet('dima', 5)], true],
      [5, [], false], [5, [], true], [10, two5(), 'void'], [20, [bet('dima', 5)], false], [10, two5(), true],
    ];
    for (const [stake, bets, outcome] of plan) {
      const ch = challenge({ stake, bets });
      w.hold(ch);
      if (outcome === 'void') {
        w.refund('camera', ch.id);
        continue;
      }
      w.end(finished(ch, outcome));
      w = createWallet({ storage }); // перезагрузка между финишем и итогами не мешает
      w.settle(ch.id);
    }
    // 100 +9 −10 +9 −20 +4,5 −5 +0 (отмена) −20 +9
    a.eq(w.balance, 76.5);
    const rounds = w.history.filter((h) => h.kind === 'round');
    a.eq(rounds.length, 10);
    a.ok(rounds.every((r) => r.status === 'settled' || r.status === 'refunded'), 'все раунды закрыты');
    const sum = rounds.reduce((s, r) => s + toCents(r.settlement.player.delta), 0);
    a.eq(toCents(w.balance), 10000 + sum, 'баланс = 100 + сумма итогов');
  });

  t.test('кошелёк: пополнение до 100, только когда меньше', (a) => {
    const w = createWallet({ storage: memory() });
    for (const stake of [20, 20, 20, 20, 17]) play(w, challenge({ stake, bets: [] }), false);
    a.eq(w.balance, 3);
    a.ok(!w.canAfford(5));
    a.eq(w.topUp(), 97);
    a.eq(w.balance, 100);
    a.eq(w.topUp(), 0, 'полный кошелёк не пополняется');
    a.eq(w.history.filter((h) => h.kind === 'topup').length, 1);
  });

  t.test('кошелёк: подписчик узнаёт о каждом изменении баланса', (a) => {
    const w = createWallet({ storage: memory() });
    const seen = [];
    w.subscribe((c) => seen.push(`${c.reason}:${c.delta}:${c.balance}`));
    play(w, challenge(), true);
    w.settle(`c${seq}`);
    w.topUp();
    a.deep(seen, ['hold:-10:90', 'settle:19:109']);
  });

  t.test('кошелёк: битые данные → новый профиль, ошибка записи → живём в памяти', (a) => {
    const broken = memory();
    broken.setItem('protiv:v1', '{нет');
    a.eq(createWallet({ storage: broken }).balance, 100);
    const odd = memory();
    odd.setItem('protiv:v1', JSON.stringify({ v: 1, cents: 'много', history: [] }));
    a.eq(createWallet({ storage: odd }).balance, 100);
    const w = createWallet({ storage: memory({ fail: true }) });
    play(w, challenge(), true);
    a.eq(w.balance, 109);
    a.eq(createWallet({ storage: null }).balance, 100, 'без хранилища тоже работает');
  });

  t.test('кошелёк: история не растёт бесконечно, незакрытый раунд не теряется', (a) => {
    const w = createWallet({ storage: memory(), keep: 5 });
    for (let i = 0; i < 12; i++) play(w, challenge({ bets: [] }), true);
    const ch = challenge();
    w.hold(ch);
    a.eq(w.history.length, 5);
    a.eq(w.open?.challengeId, ch.id);
  });
}

// ─── Боты и лента (src/friends/bots.js) ──────────────────────────

import { MONEY } from '../src/config.js';
import { LINES, FAULT_LINES, fill, lineVars, pickLine, faultTheme, arrive } from '../src/friends/bots.js';

const [DIMA, ANYA] = MONEY.bots;
const templates = () => [...Object.values(LINES).flatMap((byType) => Object.values(byType).flat()), ...Object.values(FAULT_LINES).flat()];

function botsTests(t) {
  t.test('боты: реплики без тире и пустых подстановок, короткие', (a) => {
    let n = 0;
    for (const tpl of templates())
      for (const bot of [DIMA, ANYA]) {
        const s = fill(tpl, bot, lineVars(bot, { n: 5, left: 5, target: 10 }));
        a.ok(!/[–—]/.test(s), `тире: ${s}`);
        a.ok(!/[{}]|undefined|NaN/.test(s), `подстановка: ${s}`);
        a.ok(s.length <= 45, `длинно (${s.length}): ${s}`);
        n++;
      }
    a.ok(n > 150, 'реплик хватает');
  });

  t.test('боты: род бота в репликах и тостах', (a) => {
    a.eq(fill('Я же говорил{а}!', DIMA), 'Я же говорил!');
    a.eq(fill('Я же говорил{а}!', ANYA), 'Я же говорила!');
    a.eq(arrive({ stake: 10, bets: [] }, DIMA).toast.text, 'Дима поставил 5 против тебя');
    a.eq(arrive({ stake: 10, bets: [] }, ANYA).toast.text, 'Аня поставила 5 против тебя');
    a.eq(fill('Спасибо за {credits}', DIMA, lineVars(DIMA)), 'Спасибо за 5 кредитов');
  });

  t.test('боты: сумма против не больше ставки, кто раньше, остальным «пул полон»', (a) => {
    const small = { stake: 5, bets: [] };
    a.eq(arrive(small, DIMA).status, 'ok');
    const late = arrive(small, ANYA);
    a.eq(late.status, 'full');
    a.eq(late.toast.text, 'Аня хотела поставить 5, но пул уже полон');
    a.eq(small.bets.length, 1);
    const ten = { stake: 10, bets: [] };
    a.deep([arrive(ten, DIMA).status, arrive(ten, ANYA).status], ['ok', 'ok']);
    a.eq(arrive(ten, DIMA).status, 'repeat', 'второй раз тот же бот не ставит');
    a.eq(arrive(ten, DIMA).toast, null);
    const seven = { stake: 7, bets: [] };
    arrive(seven, DIMA);
    const trimmed = arrive(seven, ANYA);
    a.eq(trimmed.status, 'trimmed');
    a.eq(trimmed.bet.amount, 2);
    a.eq(trimmed.toast.text, 'Аня поставила 2 против тебя, больше в пул не влезло');
  });

  t.test('боты: одна и та же реплика не звучит два раза подряд', (a) => {
    const pool = ['раз', 'два', 'три'];
    const used = [];
    for (let i = 0; i < 30; i++) {
      const line = pickLine(pool, () => (i * 0.37) % 1, used);
      a.ok(line && line !== used[used.length - 1], `повтор: ${line}`);
      used.push(line);
    }
    a.eq(pickLine([], Math.random, []), null);
    a.eq(pickLine(['одна'], Math.random, ['одна']), null);
  });

  t.test('боты: подкол по теме ошибки (события блоков 1 и 4)', (a) => {
    const cases = [
      [{ code: 'knees_over_toes', text: 'Колени выходят за носки, сядь глубже назад', label: 'колени за носками' }, 'squat', 'knees'],
      [{ code: 'squat_shallow', text: 'Недостаточная глубина: бедро выше колена, присядь ниже', label: 'недостаточная глубина' }, 'squat', 'depth'],
      [{ code: 'pushup_half_down', text: 'Не до конца опускаешься: локоть 115°, нужно меньше 90°', label: 'недостаточная глубина' }, 'pushup', 'lower'],
      [{ code: 'pushup_half_up', text: 'Не выпрямил руки: локоть 140°, нужно больше 160°', label: 'не выпрямил руки' }, 'pushup', 'straighten'],
      [{ code: 'squat_half_up', text: 'Встань до конца, выпрями колени', label: 'не встал до конца' }, 'squat', 'straighten'],
      [{ code: 'hip_sag', text: 'Таз провисает, напряги живот, выровняй тело', label: 'таз провис' }, 'pushup', 'hips'],
      [{ code: 'torso_lean', text: 'Спина наклоняется вперёд, держи грудь, смотри перед собой', label: 'наклон спины вперёд' }, 'squat', 'back'],
      [{ code: 'pushup_tempo', text: 'Слишком быстро, контролируй опускание', label: 'слишком быстро' }, 'pushup', 'tempo'],
      [{ code: 'visibility', text: 'Не весь корпус в кадре, отойди', label: 'не весь корпус в кадре' }, 'squat', 'body'],
      [{ code: 'eyes_open', text: 'Глаза открыты, закрой глаза' }, 'meditation', 'eyes'],
      [{ code: 'head_moving', text: 'Голова двигается, замри' }, 'meditation', 'head'],
      [{ code: 'face_lost', text: 'Лицо вышло из кадра, вернись' }, 'meditation', 'face'],
      [{ code: 'two_faces', text: 'В кадре второй человек, ты должен быть один' }, 'meditation', 'second'],
      [{ code: 'new_rule', text: 'Что-то новое' }, 'squat', null],
    ];
    for (const [fault, type, theme] of cases) a.eq(faultTheme(fault, type), theme, fault.code);
  });
}

// ─── Экраны итогов (src/screens/result.js, src/screens/void.js) ──

import { TEXT as RESULT_TEXT, shortLabel, faultItems, rejectedSummary, reasonText, ledgerRows } from '../src/screens/result.js';
import { TEXT as VOID_TEXT, voidReason, refundRows } from '../src/screens/void.js';

function screensTests(t) {
  t.test('итоги: сводка незасчитанных, как в спеке', (a) => {
    const depth = { code: 'squat_shallow', text: 'Недостаточная глубина: бедро выше колена, присядь ниже' };
    a.eq(rejectedSummary([depth, depth, depth, { code: 'hip_sag', text: 'таз провис' }]), '4 незасчитанных: 3 × недостаточная глубина, 1 × таз провис');
    a.eq(rejectedSummary([{ code: 'hip_sag', text: 'таз провис' }]), '1 незасчитанный: 1 × таз провис');
    a.eq(rejectedSummary([]), '');
    a.eq(rejectedSummary(undefined), '');
  });

  t.test('итоги: короткая подпись ошибки', (a) => {
    a.eq(shortLabel('Колени выходят за носки, сядь глубже назад'), 'Колени выходят за носки');
    a.eq(shortLabel('Недостаточная глубина: бедро выше колена, присядь ниже', { lower: true }), 'недостаточная глубина');
    a.eq(shortLabel('Не выпрямил руки: локоть 140°, нужно больше 160°', { lower: true }), 'не выпрямил руки');
    a.eq(shortLabel('глаза открыты'), 'глаза открыты');
  });

  t.test('итоги: ошибки чаще выше, нулевые не показываем', (a) => {
    const items = faultItems([{ code: 'a', text: 'наклон спины вперёд', count: 1 }, { code: 'b', text: 'недостаточная глубина', count: 3 }, { code: 'c', text: 'x', count: 0 }]);
    a.deep(items.map((i) => i.text), ['3 × недостаточная глубина', '1 × наклон спины вперёд']);
  });

  t.test('итоги: строка под заголовком', (a) => {
    a.eq(reasonText({ success: true, reason: 'target' }), 'Цель выполнена');
    a.eq(reasonText({ success: true, reason: 'forced-success' }), 'Цель выполнена');
    a.eq(reasonText({ success: false, reason: 'time' }), 'Время вышло');
    a.eq(reasonText({ success: false, reason: 'failed', type: 'meditation' }), 'Жизни закончились');
    a.eq(reasonText({ success: false, reason: 'forced-fail' }), 'Челлендж провален');
  });

  t.test('итоги: расчёт по каждому участнику, сумма изменений 0', (a) => {
    const rows = ledgerRows(settle({ stake: 20, bets: two5(), success: false, fee: 0.1 }), { reaction: (id) => (id === 'dima' ? 'Я же говорил!' : null) });
    a.deep(rows.map((r) => r.kind), ['you', 'friend', 'friend', 'app']);
    a.deep(rows.map((r) => r.delta), [-20, 4.5, 4.5, 11]);
    a.eq(rows[1].quote, 'Я же говорил!');
    a.eq(rows[2].quote, null);
    a.eq(rows[3].detail, 'комиссия 10% и незакрытые 10 кр.');
    a.eq(rows.reduce((sum, r) => sum + toCents(r.delta), 0), 0);
    a.eq(ledgerRows(settle({ stake: 10, bets: [], success: true })).length, 1, 'соло: только игрок');
  });

  t.test('отмена: причина и кому что вернули', (a) => {
    a.eq(voidReason('camera'), 'Камера пропала дольше чем на 5 секунд');
    a.eq(voidReason('left'), 'Челлендж прервался');
    a.deep(refundRows(refundAll({ stake: 10, bets: two5() })).map((r) => [r.name, r.back]), [['Ты', 10], ['dima', 5], ['anya', 5]]);
  });

  t.test('итоги и отмена: в текстах нет тире', (a) => {
    const texts = [];
    const walk = (v) => {
      if (typeof v === 'string') texts.push(v);
      else if (typeof v === 'function') texts.push(String(v(5, 'x')));
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(RESULT_TEXT);
    walk(VOID_TEXT);
    a.ok(texts.length > 20);
    for (const s of texts) a.ok(!/[–—]/.test(s), `тире: ${s}`);
  });
}

export default (t) => {
  moneyTests(t);
  walletTests(t);
  botsTests(t);
  screensTests(t);
};
