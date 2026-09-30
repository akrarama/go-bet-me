// Тесты «друг по ссылке» (P1): протокол, кошелёк друга, ядра хоста и гостя, обвязка PeerJS на игрушечном облаке.
// Владелец: блок 3 (Деньги). Подключается из tests/money.test.js (реестр tests/run.js правит координатор).
// Без DOM, сети и настоящего PeerJS: всё идёт в jsc (sh tools/check.sh).

import { MONEY } from '../src/config.js';
import { settle, settleFriend, poolLeft } from '../src/money.js';
import { createHostCore } from '../src/friends/host.js';
import { createGuestCore } from '../src/friends/guest.js';
import { createGuestWallet } from '../src/friends/guest-wallet.js';
import { installHost, createGuest, makeId, joinUrl } from '../src/friends/peer.js';
import { friendWait } from '../src/friends/bots.js';
import { cleanText, cleanName, cleanAvatar, parseWire, parseFriendMsg, parseHostMsg, pubBets, pubChallenge, betId, isPeerBet } from '../src/friends/protocol.js';

// ─── Помощники ──────────────────────────────────────────────────

function miniBus() {
  const map = new Map();
  const seen = [];
  return {
    seen,
    on(type, fn) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
      return () => map.get(type)?.delete(fn);
    },
    emit(type, payload = {}) {
      seen.push([type, payload]);
      for (const fn of [...(map.get(type) ?? [])]) fn(payload);
    },
    of: (type) => seen.filter(([t]) => t === type).map(([, p]) => p),
  };
}

const memoryStorage = (init = null) => {
  let v = init;
  return { getItem: () => v, setItem: (k, s) => (v = s), get raw() { return v; } };
};

/** Соединение-пустышка для ядра хоста: всё, что хост отправил, лежит в sent. */
function fakeLink() {
  const link = {
    sent: [],
    calls: [],
    closedCalls: 0,
    closed: 0,
    send: (m) => link.sent.push(JSON.parse(JSON.stringify(m))),
    call: (stream) => {
      link.calls.push(stream);
      return { close: () => (link.closedCalls += 1) };
    },
    close: () => (link.closed += 1),
  };
  link.of = (t) => link.sent.filter((m) => m.t === t);
  link.last = (t) => link.of(t).at(-1);
  return link;
}

const challengeOf = (over = {}) => ({ id: 'c1', type: 'squat', target: 10, limitSec: 90, stake: 10, bets: [], ...over });
const BOT = (id, amount = 5) => ({ id: `bot-${id}`, name: id, avatar: '🧔', amount, bot: true });

/** Хост с шиной, приложением и подменными таймерами. */
function hostRig({ state = 'LOBBY', stake = 10, bets = [] } = {}) {
  const bus = miniBus();
  const app = { state, challenge: challengeOf({ stake, bets: [...bets] }) };
  const timers = { queue: [], setTimeout: (fn, ms) => timers.queue.push({ fn, ms }), run: () => timers.queue.splice(0).forEach((t) => t.fn()) };
  const toasts = [];
  const rig = { bus, app, timers, toasts, t: 0, stream: null };
  rig.core = createHostCore({ bus, app, getStream: () => rig.stream, toast: (text, opts) => toasts.push([text, opts]), timers, now: () => rig.t });
  rig.go = (to, params = {}) => {
    const from = app.state;
    app.state = to;
    bus.emit('state', { from, to, params });
  };
  rig.friend = (id, name = 'Лиса', avatar = '🦊') => {
    const link = fakeLink();
    rig.core.attach(id, link);
    rig.core.receive(id, JSON.stringify({ t: 'hello', name, avatar }));
    return link;
  };
  rig.say = (id, msg) => rig.core.receive(id, typeof msg === 'string' ? msg : JSON.stringify(msg));
  rig.start = () => {
    rig.go('LIVE');
    bus.emit('live:start', { challenge: app.challenge });
  };
  rig.end = (success, count = 10) => bus.emit('live:end', { session: { challengeId: app.challenge.id, success, count, target: app.challenge.target }, challenge: app.challenge });
  return rig;
}

/** Гость: своё ядро, шина и кошелёк в памяти. sent: то, что он отправил хосту. */
function guestRig({ balance = 100, name, avatar, storage = memoryStorage() } = {}) {
  const bus = miniBus();
  const wallet = createGuestWallet({ storage, start: balance });
  const { api, io } = createGuestCore({ bus, wallet, name, avatar, rng: () => 0 });
  const sent = [];
  io.setPeerId('me1');
  io.open({ send: (m) => sent.push(m) });
  return { bus, wallet, api, io, sent, storage, msg: (m) => io.message(m) };
}

const flush = async (n = 30) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/** Игрушечное облако PeerJS: Peer, DataConnection и звонок в памяти. Вызовы и события как у PeerJS 1.5. */
function fakeCloud() {
  const peers = new Map();
  const later = (fn) => Promise.resolve().then(fn);
  let counter = 0;
  const cloud = { peers, taken: new Set(), created: [], failLib: false };

  class Emitter {
    constructor() {
      this.h = {};
    }
    on(ev, fn) {
      (this.h[ev] ??= []).push(fn);
      return this;
    }
    emit(ev, ...a) {
      (this.h[ev] ?? []).slice().forEach((fn) => fn(...a));
    }
  }

  class Conn extends Emitter {
    constructor(remote, opts) {
      super();
      this.peer = remote;
      this.serialization = opts?.serialization ?? 'binary';
      this.open = false;
      this.closed = false;
      this.other = null;
      this.sent = [];
    }
    send(data) {
      if (!this.open) throw new Error('канал не открыт');
      this.sent.push(data);
      const other = this.other;
      later(() => other.emit('data', data));
    }
    close() {
      if (this.closed) return;
      const other = this.other;
      this.closed = true;
      this.open = false;
      later(() => {
        this.emit('close');
        if (other && !other.closed) {
          other.closed = true;
          other.open = false;
          other.emit('close');
        }
      });
    }
  }

  class FakePeer extends Emitter {
    constructor(id, opts) {
      super();
      if (id && typeof id === 'object') id = undefined;
      this.id = id ?? `anon${++counter}`;
      this.destroyed = false;
      this.disconnected = false;
      this.conns = [];
      cloud.created.push(this);
      if (cloud.taken.has(this.id)) {
        cloud.taken.delete(this.id); // в следующий раз id свободен
        later(() => this.emit('error', { type: 'unavailable-id' }));
        return;
      }
      peers.set(this.id, this);
      later(() => this.emit('open', this.id));
    }
    connect(remote, opts) {
      const mine = new Conn(remote, opts);
      const other = peers.get(remote);
      this.conns.push(mine);
      if (!other || other.destroyed) {
        later(() => this.emit('error', { type: 'peer-unavailable' }));
        return mine;
      }
      const theirs = new Conn(this.id, opts);
      mine.other = theirs;
      theirs.other = mine;
      other.conns.push(theirs);
      later(() => {
        other.emit('connection', theirs);
        later(() => {
          mine.open = true;
          theirs.open = true;
          theirs.emit('open');
          mine.emit('open');
        });
      });
      return mine;
    }
    call(remote, stream) {
      const other = peers.get(remote);
      const mc = new Emitter();
      mc.close = () => {
        mc.closed = true;
        mc.peerClosed?.();
      };
      mc.remote = remote;
      mc.stream = stream;
      later(() => {
        if (!other) return;
        const incoming = new Emitter();
        incoming.answer = () => later(() => incoming.emit('stream', stream));
        incoming.close = () => later(() => incoming.emit('close'));
        mc.peerClosed = () => incoming.close();
        other.emit('call', incoming);
      });
      return mc;
    }
    destroy() {
      this.destroyed = true;
      peers.delete(this.id);
      this.conns.forEach((c) => c.close());
    }
    reconnect() {
      this.disconnected = false;
    }
  }
  cloud.Peer = FakePeer;
  return cloud;
}

/** Подменные таймеры на время теста: в jsc нет clearTimeout, а настоящие таймеры тянут процесс. */
async function withFakeTimers(fn) {
  const saved = [globalThis.setTimeout, globalThis.clearTimeout];
  const queue = [];
  globalThis.setTimeout = (f, ms) => queue.push({ f, ms, live: true });
  globalThis.clearTimeout = (id) => {
    if (queue[id - 1]) queue[id - 1].live = false;
  };
  try {
    await fn({ fire: () => queue.filter((q) => q.live).forEach((q) => ((q.live = false), q.f())), queue });
  } finally {
    [globalThis.setTimeout, globalThis.clearTimeout] = saved;
  }
}

const LOC = { origin: 'https://demo.test', pathname: '/protiv/' };

// ─── Тесты ──────────────────────────────────────────────────────

export default function friendsTests(t) {
  // ── Протокол ──
  t.test('друг: cleanText режет длину по символам, эмодзи не рвёт, мусор убирает', (a) => {
    a.eq(cleanText('  привет \n\t мир  ', 20), 'привет мир');
    a.eq(cleanText('<b>жирно</b>', 20), 'b жирно /b');
    a.eq(cleanText('🔥🔥🔥🔥', 2), '🔥🔥');
    a.eq(cleanText('x'.repeat(100), 5), 'xxxxx');
    a.eq(cleanText(null, 5), '');
    a.eq(cleanText('a\u0000b\u007fc', 9), 'a b c');
  });

  t.test('друг: имя до 20 символов, пустое заменяется, аватар только из списка', (a) => {
    a.eq(cleanName('А'.repeat(50)).length, MONEY.friend.nameMax);
    a.eq(cleanName('   '), MONEY.friend.defaultName);
    a.eq(cleanName(undefined), MONEY.friend.defaultName);
    a.eq(cleanAvatar('🦊'), '🦊');
    a.eq(cleanAvatar('💩'), MONEY.friend.defaultAvatar);
    a.eq(cleanAvatar('<script>'), MONEY.friend.defaultAvatar);
    a.eq(cleanAvatar(5), MONEY.friend.defaultAvatar);
    for (const g of MONEY.friend.guests) a.ok(MONEY.friend.avatars.includes(g.avatar), `аватар ${g.name} не из списка`);
    a.ok(MONEY.friend.avatars.includes(MONEY.friend.defaultAvatar));
  });

  t.test('друг: parseWire принимает JSON-строку, режет длинное и битое', (a) => {
    a.deep(parseWire('{"t":"bet","amount":5}'), { t: 'bet', amount: 5 });
    a.deep(parseWire({ t: 'react', text: 'ура' }), { t: 'react', text: 'ура' });
    a.eq(parseWire('{"t":'), null);
    a.eq(parseWire('123'), null);
    a.eq(parseWire('null'), null);
    a.eq(parseWire('"строка"'), null);
    a.eq(parseWire(`{"t":"react","text":"${'я'.repeat(MONEY.friend.maxWireChars)}"}`), null);
    a.eq(parseWire(new ArrayBuffer(8)), null);
    a.eq(parseWire(new Uint8Array(4)), null);
    a.eq(parseWire(undefined), null);
    a.eq(parseWire(42), null);
  });

  t.test('друг: parseFriendMsg пропускает только hello, bet, react и чистит поля', (a) => {
    a.deep(parseFriendMsg({ t: 'hello', name: ' Лиса ', avatar: '🦊', extra: 1 }), { t: 'hello', name: 'Лиса', avatar: '🦊' });
    a.deep(parseFriendMsg({ t: 'hello' }), { t: 'hello', name: MONEY.friend.defaultName, avatar: MONEY.friend.defaultAvatar });
    a.deep(parseFriendMsg({ t: 'bet', amount: 5 }), { t: 'bet', amount: 5 });
    a.eq(parseFriendMsg({ t: 'bet', amount: '5' }), null);
    a.eq(parseFriendMsg({ t: 'bet', amount: 0 }), null);
    a.eq(parseFriendMsg({ t: 'bet', amount: -5 }), null);
    a.eq(parseFriendMsg({ t: 'bet', amount: NaN }), null);
    a.eq(parseFriendMsg({ t: 'bet', amount: Infinity }), null);
    a.eq(parseFriendMsg({ t: 'bet' }), null);
    a.deep(parseFriendMsg({ t: 'react', text: '🔥 Давай!' }), { t: 'react', text: '🔥 Давай!' });
    a.eq(parseFriendMsg({ t: 'react', text: '   ' }), null);
    a.eq(parseFriendMsg({ t: 'start' }), null);
    a.eq(parseFriendMsg({ t: '__proto__' }), null);
    a.eq(parseFriendMsg({}), null);
    a.eq(parseFriendMsg(null), null);
    a.eq(parseFriendMsg([]), null);
  });

  t.test('друг: ping и bet:closed входят в протокол в обе стороны', (a) => {
    a.deep(parseFriendMsg({ t: 'ping', extra: 1 }), { t: 'ping' });
    a.ok(parseHostMsg({ t: 'ping' }));
    a.ok(parseHostMsg({ t: 'bet:closed' }));
    a.deep(parseWire('{"t":"ping"}'), { t: 'ping' });
  });

  t.test('друг: parseHostMsg знает только сообщения хоста', (a) => {
    for (const m of ['lobby', 'bet:ok', 'bet:full', 'start', 'count', 'fault', 'rejected', 'end', 'void']) a.ok(parseHostMsg({ t: m }), m);
    a.eq(parseHostMsg({ t: 'hello' }), null);
    a.eq(parseHostMsg({ t: 'bet' }), null);
    a.eq(parseHostMsg(null), null);
    a.eq(parseHostMsg('lobby'), null);
  });

  t.test('друг: пул и челлендж для друга без служебных полей', (a) => {
    a.deep(pubChallenge({ id: 'c', type: 'squat', target: 10, limitSec: 90, stake: 10, bets: [1], secret: 1 }), { id: 'c', type: 'squat', target: 10, limitSec: 90, stake: 10 });
    a.deep(pubChallenge({ id: 'c', type: 'meditation', target: 60, limitSec: null, stake: 5 }).limitSec, null);
    a.deep(pubBets([{ id: 'b', name: 'Дима', avatar: '🧔', amount: 5, bot: true, female: true, x: 1 }]), [{ id: 'b', name: 'Дима', avatar: '🧔', amount: 5, bot: true }]);
    a.ok(isPeerBet({ id: betId('abc') }));
    a.ok(!isPeerBet({ id: 'bot-dima' }));
  });

  t.test('друг: короткий id для ссылки и сама ссылка', (a) => {
    const id = makeId(() => 0);
    a.ok(id.startsWith(MONEY.peer.idPrefix) && id.length === MONEY.peer.idPrefix.length + MONEY.peer.idLength, id);
    a.ok(/^[a-zA-Z0-9]+(?:[-_][a-zA-Z0-9]+)*$/.test(makeId()), 'id допустим для PeerJS');
    a.eq(joinUrl('pr-abc234', LOC), 'https://demo.test/protiv/?join=pr-abc234');
  });

  // ── Расчёт друга ──
  t.test('друг: settleFriend совпадает с общим settle для любых ставок', (a) => {
    for (const fee of [0, 0.1, 0.25]) {
      for (const amount of [5, 10, 20, 7.5, 0.05]) {
        for (const success of [true, false]) {
          const full = settle({ stake: 40, bets: [{ id: 'x', amount: 3 }, { id: 'me', amount }], success, fee }).friends[1];
          const mine = settleFriend({ amount, success, fee });
          a.eq(mine.delta, full.delta, `delta ${amount}/${fee}/${success}`);
          a.eq(mine.payout, full.payout, `payout ${amount}/${fee}/${success}`);
        }
      }
    }
    a.deep(settleFriend({ amount: 5, success: false }), { amount: 5, payout: 9.5, delta: 4.5, fee: 0.5 });
    a.deep(settleFriend({ amount: 5, success: true }), { amount: 5, payout: 0, delta: -5, fee: 0 });
    a.eq(settleFriend({ amount: 0, success: false }).delta, 0);
  });

  // ── Кошелёк друга ──
  t.test('кошелёк друга: 100 кредитов, ставка списывается на старте, рассчитывается на итоге', (a) => {
    const w = createGuestWallet({ storage: memoryStorage() });
    a.eq(w.balance, 100);
    w.hold({ challengeId: 'c1', amount: 5 });
    a.eq(w.balance, 95);
    const r = w.settle({ challengeId: 'c1', success: false, you: { amount: 5, delta: 4.5 } });
    a.eq(w.balance, 104.5);
    a.eq(r.status, 'settled');
    a.eq(w.settle({ challengeId: 'c1', success: false }), null);
    a.eq(w.balance, 104.5, 'второй расчёт не платит');
  });

  t.test('кошелёк друга: игрок сделал, ставка потеряна; отмена возвращает', (a) => {
    const w = createGuestWallet({ storage: memoryStorage() });
    w.hold({ challengeId: 'c1', amount: 10 });
    w.settle({ challengeId: 'c1', success: true, you: { amount: 10, delta: -10 } });
    a.eq(w.balance, 90);
    w.hold({ challengeId: 'c2', amount: 10 });
    a.eq(w.balance, 80);
    w.refund('c2');
    a.eq(w.balance, 90);
    a.eq(w.refund('c2'), null, 'вернуть можно один раз');
    a.eq(w.settle({ challengeId: 'c2', success: false }), null, 'возвращённое не рассчитывается');
  });

  t.test('кошелёк друга: start пришёл дважды, второй раз ничего не списывает', (a) => {
    const w = createGuestWallet({ storage: memoryStorage() });
    a.ok(w.hold({ challengeId: 'c1', amount: 5 }));
    a.ok(w.hold({ challengeId: 'c1', amount: 5 }), 'тот же раунд');
    a.eq(w.balance, 95);
    w.settle({ challengeId: 'c1', success: true, you: { amount: 5, delta: -5 } });
    a.eq(w.hold({ challengeId: 'c1', amount: 5 }), null, 'закрытый раунд заново не открывается');
    a.eq(w.balance, 95);
  });

  t.test('кошелёк друга: не верит лишнему от хоста и считает по правилу сам', (a) => {
    const w = createGuestWallet({ storage: memoryStorage() });
    w.hold({ challengeId: 'c1', amount: 10 });
    w.settle({ challengeId: 'c1', success: false, you: { amount: 10, delta: 9999 } }); // больше ставки: так не бывает
    a.eq(w.balance, 90 + 19, 'посчитано самим: 10 назад и 9 сверху');
    w.hold({ challengeId: 'c2', amount: 10 });
    w.settle({ challengeId: 'c2', success: true, you: { amount: 5, delta: 5 } }); // сумма не наша
    a.eq(w.balance, 109 - 10, 'проигрыш 10, а не чужие +5');
    w.hold({ challengeId: 'c3', amount: 5 });
    w.settle({ challengeId: 'c3', success: true, you: null });
    a.eq(w.balance, 99 - 5);
  });

  t.test('кошелёк друга: не хватает кредитов, списываем сколько есть, не уходим в минус', (a) => {
    const w = createGuestWallet({ storage: memoryStorage(), start: 3 });
    const r = w.hold({ challengeId: 'c1', amount: 5 });
    a.eq(r.amount, 3);
    a.eq(r.requested, 5);
    a.eq(w.balance, 0);
    a.eq(w.hold({ challengeId: 'c2', amount: 5 }), null, 'с нуля ставку не списать');
    a.eq(w.balance, 0);
    a.eq(w.hold({ challengeId: 'c3', amount: 0 }), null);
  });

  t.test('кошелёк друга: сохраняется, брошенный раунд возвращается, битые данные не страшны', (a) => {
    const storage = memoryStorage();
    const w = createGuestWallet({ storage });
    w.hold({ challengeId: 'c1', amount: 10 });
    a.eq(w.balance, 90);
    const again = createGuestWallet({ storage }); // вкладку закрыли посреди челленджа
    a.eq(again.balance, 90, 'баланс сохранился');
    a.eq(again.open.length, 1);
    a.eq(again.recover().length, 1);
    a.eq(again.balance, 100, 'ставка вернулась');
    a.eq(createGuestWallet({ storage: memoryStorage('{битый json') }).balance, 100);
    a.eq(createGuestWallet({ storage: memoryStorage('{"v":9}') }).balance, 100);
    a.eq(createGuestWallet({ storage: { getItem: () => { throw new Error('нет доступа'); }, setItem: () => { throw new Error('нет места'); } } }).balance, 100);
  });

  t.test('кошелёк друга: пополнение только когда меньше самой маленькой ставки', (a) => {
    const w = createGuestWallet({ storage: memoryStorage(), start: 100 });
    a.eq(w.topUpIfBroke(), 0);
    w.hold({ challengeId: 'c1', amount: 100 });
    w.settle({ challengeId: 'c1', success: true, you: { amount: 100, delta: -100 } });
    a.eq(w.balance, 0);
    a.eq(w.topUpIfBroke(), 100);
    a.eq(w.balance, 100);
    a.eq(w.topUp(), 0);
    a.ok(!createGuestWallet({ storage: memoryStorage(), start: 4 }).canAfford(5));
    a.ok(createGuestWallet({ storage: memoryStorage(), start: 5 }).canAfford(5));
  });

  t.test('кошелёк друга: подписчик узнаёт о каждом изменении, история не пухнет', (a) => {
    const w = createGuestWallet({ storage: memoryStorage(), keep: 4 });
    const seen = [];
    w.subscribe((c) => seen.push([c.reason, c.delta, c.balance]));
    w.hold({ challengeId: 'c1', amount: 5 });
    w.settle({ challengeId: 'c1', success: false, you: { amount: 5, delta: 4.5 } });
    w.hold({ challengeId: 'c2', amount: 5 });
    w.refund('c2');
    a.deep(seen, [['hold', -5, 95], ['settle', 9.5, 104.5], ['hold', -5, 99.5], ['refund', 5, 104.5]]);
    for (let i = 0; i < 12; i++) {
      w.hold({ challengeId: `x${i}`, amount: 5 });
      w.refund(`x${i}`);
    }
    w.hold({ challengeId: 'open', amount: 5 });
    for (let i = 0; i < 12; i++) w.topUp(200 + i);
    a.ok(w.history.length <= 5, `история ${w.history.length}`);
    a.eq(w.open.length, 1, 'незакрытый раунд не потерялся');
  });

  // ── Хост: LOBBY и ставки ──
  t.test('хост: friend:join и lobby при hello, без hello ничего не принимает', (a) => {
    const r = hostRig({ bets: [BOT('Дима')] });
    const link = fakeLink();
    r.core.attach('f1', link);
    r.say('f1', { t: 'bet', amount: 5 });
    a.eq(link.sent.length, 0, 'до hello тишина');
    a.eq(r.app.challenge.bets.length, 1);
    r.say('f1', { t: 'hello', name: 'Лиса', avatar: '🦊' });
    a.deep(r.bus.of('friend:join'), [{ id: 'f1', name: 'Лиса', avatar: '🦊' }]);
    const lobby = link.last('lobby');
    a.deep(lobby.challenge, { id: 'c1', type: 'squat', target: 10, limitSec: 90, stake: 10 });
    a.eq(lobby.left, 5);
    a.deep(lobby.bets, [{ id: 'bot-Дима', name: 'Дима', avatar: '🧔', amount: 5, bot: true }]);
    a.deep(lobby.you, { amount: 0 });
    a.eq(r.core.watching, 1);
    r.say('f1', { t: 'hello', name: 'Другое', avatar: '🐯' });
    a.eq(r.bus.of('friend:join').length, 1, 'второй hello не считается новым другом');
    a.eq(r.core.friends[0].name, 'Лиса');
  });

  t.test('хост: ставка друга попадает в пул, все получают новый остаток', (a) => {
    const r = hostRig();
    const f1 = r.friend('f1', 'Лиса', '🦊');
    const f2 = r.friend('f2', 'Тигр', '🐯');
    r.say('f1', { t: 'bet', amount: 5 });
    a.deep(f1.last('bet:ok'), { t: 'bet:ok', amount: 5 });
    const [bet] = r.app.challenge.bets;
    a.eq(bet.id, 'peer:f1');
    a.eq(bet.bot, false);
    a.eq(bet.name, 'Лиса');
    a.eq(bet.amount, 5);
    const events = r.bus.of('bet');
    a.eq(events.length, 1);
    a.eq(events[0].challenge, r.app.challenge);
    a.eq(f1.last('lobby').left, 5);
    a.deep(f1.last('lobby').you, { amount: 5 });
    a.eq(f2.last('lobby').left, 5);
    a.deep(f2.last('lobby').you, { amount: 0 });
    a.eq(f2.last('lobby').bets.length, 1);
    a.eq(r.toasts.length, 1);
    a.ok(!/[—–]/.test(r.toasts[0][0]), r.toasts[0][0]);
    a.eq(poolLeft(r.app.challenge), 5);
  });

  t.test('хост: одна ставка на друга, только 5 / 10 / 20 и не больше остатка', (a) => {
    const r = hostRig({ stake: 10, bets: [BOT('Дима')] }); // остаток 5
    const f = r.friend('f1');
    r.say('f1', { t: 'bet', amount: 7 });
    a.deep(f.last('bet:full'), { t: 'bet:full', left: 5 }, 'не из списка');
    r.say('f1', { t: 'bet', amount: 10 });
    a.deep(f.of('bet:full').at(-1), { t: 'bet:full', left: 5 }, 'больше остатка не обрезаем');
    a.eq(r.app.challenge.bets.length, 1);
    r.say('f1', { t: 'bet', amount: 5 });
    a.deep(f.last('bet:ok'), { t: 'bet:ok', amount: 5 });
    r.say('f1', { t: 'bet', amount: 5 });
    r.say('f1', { t: 'bet', amount: 10 });
    a.eq(r.app.challenge.bets.length, 2, 'вторую ставку не берём');
    a.deep(f.last('bet:ok'), { t: 'bet:ok', amount: 5 }, 'повтор получает прежний ответ');
    const late = r.friend('f2');
    r.say('f2', { t: 'bet', amount: 5 });
    a.deep(late.last('bet:full'), { t: 'bet:full', left: 0 }, 'пул полон');
    a.eq(r.bus.of('bet').length, 1);
  });

  t.test('хост: после Старта ставки не принимаются', (a) => {
    for (const state of ['LIVENESS', 'LIVE', 'SETUP', 'RESULT']) {
      const r = hostRig({ state: 'LOBBY' });
      const f = r.friend('f1');
      r.go(state);
      r.say('f1', { t: 'bet', amount: 5 });
      a.deep(f.last('bet:closed'), { t: 'bet:closed' }, state);
      a.eq(r.app.challenge.bets.length, 0, state);
    }
  });

  t.test('хост: мусор от друга не ломает и не меняет пул', (a) => {
    const r = hostRig();
    const f = r.friend('f1');
    const before = f.sent.length;
    for (const junk of ['', '{', 'null', '[]', '"bet"', '{"t":"bet"}', '{"t":"bet","amount":"5"}', '{"t":"bet","amount":-5}', '{"t":"__proto__","amount":5}', '{"t":"start"}', '{"t":"end","success":true}', 'x'.repeat(5000), undefined, null, 42, [], {}, new Uint8Array(3)]) {
      r.say('f1', junk);
    }
    a.eq(r.app.challenge.bets.length, 0);
    a.eq(f.sent.length, before, 'на мусор не отвечаем');
    r.core.receive('нет-такого', '{"t":"bet","amount":5}');
    r.core.receive('f1', { t: 'bet', amount: 5, extra: { x: 1 } });
    a.eq(r.app.challenge.bets.length, 1, 'объект вместо строки тоже принимается');
  });

  t.test('хост: реакции в ленту, редко, коротко и без разметки', (a) => {
    const r = hostRig({ state: 'LIVE' });
    r.friend('f1', 'Лиса', '🦊');
    r.say('f1', { t: 'react', text: '🔥 Давай!' });
    a.deep(r.bus.of('comment'), [{ from: 'Лиса', text: '🔥 Давай!', avatar: '🦊', id: 'peer:f1', bot: false }]);
    r.t += 100;
    r.say('f1', { t: 'react', text: 'ещё раз' });
    a.eq(r.bus.of('comment').length, 1, 'слишком часто');
    r.t += MONEY.friend.reactGapMs;
    r.say('f1', { t: 'react', text: `<img src=x onerror=alert(1)>${'я'.repeat(200)}` });
    const text = r.bus.of('comment')[1].text;
    a.ok(!/[<>]/.test(text) && Array.from(text).length <= MONEY.friend.reactMax, text);
  });

  t.test('хост: больше 8 друзей не пускает', (a) => {
    const r = hostRig();
    const links = [];
    for (let i = 0; i < MONEY.friend.maxFriends; i++) links.push(r.friend(`f${i}`));
    const extra = fakeLink();
    a.eq(r.core.attach('лишний', extra), false);
    a.eq(extra.closed, 1);
    a.eq(r.core.watching, MONEY.friend.maxFriends);
    a.eq(r.core.attach('f0', fakeLink()), true, 'уже знакомый переподключается');
  });

  t.test('хост: друг ушёл из LOBBY, его ставка снята и место свободно', (a) => {
    const r = hostRig();
    const f1 = r.friend('f1');
    const f2 = r.friend('f2');
    r.say('f1', { t: 'bet', amount: 10 });
    a.eq(poolLeft(r.app.challenge), 0);
    r.core.detach('f1', f1);
    a.eq(r.app.challenge.bets.length, 0);
    a.eq(r.bus.of('bet:cancel').length, 1);
    a.eq(r.bus.of('bet:cancel')[0].bet.id, 'peer:f1');
    a.deep(r.bus.of('friend:leave'), [{ id: 'f1' }]);
    a.eq(f2.last('lobby').left, 10, 'остальные видят освободившееся место');
    a.eq(r.core.watching, 1);
  });

  t.test('хост: на Старте остаются только ставки тех, кто на связи', (a) => {
    const r = hostRig({ bets: [BOT('Дима')] });
    r.app.challenge.bets.push({ id: 'peer:призрак', name: 'Призрак', avatar: '🦊', amount: 5, bot: false });
    r.friend('f1');
    r.say('f1', { t: 'hello' });
    r.go('LIVENESS');
    a.deep(r.app.challenge.bets.map((b) => b.id), ['bot-Дима'], 'ставка без живого друга снята');
    r.app.challenge.bets.push({ id: 'peer:f1', name: 'Лиса', avatar: '🦊', amount: 5, bot: false });
    r.core.detach('f1', fakeLink()); // закрытие устаревшей связи (link уже другой) ничего не снимает
    a.eq(r.app.challenge.bets.length, 2);
    a.eq(r.core.watching, 1);
  });

  t.test('хост: друг вышел во время проверки живости, ставка снимается тихо', (a) => {
    const r = hostRig();
    const f = r.friend('f1');
    r.say('f1', { t: 'bet', amount: 5 });
    r.go('LIVENESS');
    r.core.detach('f1', f);
    a.eq(r.app.challenge.bets.length, 0);
    a.eq(r.bus.of('bet:cancel').length, 0, 'экран LOBBY закрыт, событие не нужно');
  });

  t.test('хост: тот же друг переподключился, новый hello не считается новым и старая связь закрыта', (a) => {
    const r = hostRig();
    const old = r.friend('f1');
    const fresh = fakeLink();
    r.core.attach('f1', fresh);
    a.eq(old.closed, 1);
    r.core.detach('f1', old); // закрытие старой связи приходит позже
    a.eq(r.core.watching, 1, 'друг не пропал');
    r.say('f1', { t: 'hello' });
    a.eq(r.bus.of('friend:join').length, 1);
    a.eq(fresh.of('lobby').length, 1);
    r.core.detach('f1', fresh);
    a.eq(r.core.watching, 0);
  });

  t.test('хост: lobby знает, идут ли ставки: LOBBY открыт, LIVENESS «стартует», SETUP «в настройках»', (a) => {
    const r = hostRig({ state: 'LOBBY' });
    const f = r.friend('f1');
    const lob = f.last('lobby');
    a.deep([lob.open, lob.note], [true, null], 'в LOBBY ставки идут');
    r.go('LIVENESS');
    a.deep([f.last('lobby').open, f.last('lobby').note], [false, 'starting'], 'игрок стартует: ставки закрыты на секунды');
    a.eq(f.of('lobby').length, 2);
    r.go('LOBBY'); // проверка живости не прошла, вернулись
    a.deep([f.last('lobby').open, f.last('lobby').note], [true, null]);
    r.app.challenge = challengeOf({ id: 'c2' });
    r.go('SETUP');
    a.deep([f.last('lobby').open, f.last('lobby').note], [false, 'setup'], 'игрок вернулся в настройки');
    a.eq(f.last('lobby').challenge.id, 'c2');
    const n = f.sent.length;
    r.go('RESULT');
    r.go('IDLE');
    a.eq(f.sent.length, n, 'на итогах и в начале друга лобби не дёргаем');
    const late = r.friend('f2');
    a.eq(late.of('lobby').length, 0, 'пришёл, когда игрок в IDLE: ждёт');
    r.go('SETUP');
    a.deep([late.last('lobby').open, late.last('lobby').note], [false, 'setup']);
  });

  t.test('хост: пульс шлёт ping тем, кто представился, а любое сообщение друга = жив', (a) => {
    const r = hostRig();
    const f1 = r.friend('f1');
    const quiet = fakeLink();
    r.core.attach('f2', quiet); // подключился, но hello не сказал
    r.t = 5000;
    r.core.tick();
    a.deep(f1.last('ping'), { t: 'ping' });
    a.eq(quiet.of('ping').length, 0, 'без hello пульс не шлём');
    r.t = 10000;
    r.say('f1', { t: 'ping' });
    r.t = 20000; // f1 слышали 10 с назад, f2 молчит 20 с
    r.core.tick();
    a.eq(r.core.watching, 1, 'f1 жив');
    a.eq(quiet.closed, 1, 'молчун без hello отключён');
    a.eq(MONEY.friend.friendSilentMs, 15000);
    r.say('f1', 'мусор, но это тоже сообщение');
    r.t = 34000;
    r.core.tick();
    a.eq(r.core.watching, 1, 'мусор тоже считается признаком жизни (14 с)');
    r.t = 35001;
    r.core.tick();
    a.eq(r.core.watching, 0, 'через 15 с тишины друг отключён');
    a.deep(r.bus.of('friend:leave'), [{ id: 'f1' }]);
    a.eq(f1.closed, 1);
  });

  t.test('хост: друг-призрак в LOBBY, его ставка снята; во время проверки и до Старта тоже', (a) => {
    for (const state of ['LOBBY', 'LIVENESS', 'LIVE']) {
      const r = hostRig({ bets: [BOT('Дима')] });
      const f = r.friend('f1');
      r.say('f1', { t: 'bet', amount: 5 });
      a.eq(r.app.challenge.bets.length, 2, state);
      if (state !== 'LOBBY') r.go(state);
      r.t = MONEY.friend.friendSilentMs + 1;
      r.core.tick();
      a.deep(r.app.challenge.bets.map((b) => b.id), ['bot-Дима'], `${state}: ставка призрака снята`);
      a.eq(r.bus.of('bet:cancel').length, state === 'LOBBY' ? 1 : 0, `${state}: экран LOBBY уведомлён только когда он открыт`);
      a.eq(r.bus.of('bet:withdrawn').length, 0, `${state}: раунда ещё нет, выходить не откуда`);
      a.eq(f.closed, 1);
    }
  });

  t.test('хост: друг ушёл посреди LIVE, его ставка выходит из расчёта, а кошелёк игрока и итоги узнают из события', (a) => {
    for (const how of ['close', 'silence']) {
      const r = hostRig({ stake: 20, bets: [BOT('Дима')] });
      const f1 = r.friend('f1', 'Лиса', '🦊');
      const f2 = r.friend('f2', 'Тигр', '🐯');
      r.say('f1', { t: 'bet', amount: 5 });
      r.say('f2', { t: 'bet', amount: 5 });
      r.start();
      a.eq(r.core.round.bets.length, 3);
      r.t = 3000;
      r.say('f2', { t: 'ping' });
      if (how === 'close') r.core.detach('f1', f1);
      else {
        r.t = MONEY.friend.friendSilentMs + 1;
        r.say('f2', { t: 'ping' });
        r.core.tick();
      }
      a.deep(r.core.round.bets.map((b) => b.id), ['bot-Дима', 'peer:f2'], `${how}: из расчёта выпал только ушедший`);
      const ev = r.bus.of('bet:withdrawn');
      a.eq(ev.length, 1, how);
      a.eq(ev[0].bet.id, 'peer:f1');
      a.eq(ev[0].bet.amount, 5);
      a.eq(ev[0].challenge.id, 'c1');
      a.eq(ev[0].reason, 'left');
      a.deep(r.bus.of('friend:leave'), [{ id: 'f1' }]);
      a.eq(r.app.challenge.bets.length, 3, 'сам челлендж не трогаем: экран LIVE уже идёт');
      r.end(false);
      a.eq(f2.last('end').you.delta, 4.5, `${how}: оставшемуся другу расчёт как обычно`);
      a.eq(f1.of('end').length, 0, 'ушедшему итог не шлём');
    }
  });

  t.test('хост: друг без ставки ушёл посреди LIVE, расчёт не меняется', (a) => {
    const r = hostRig({ bets: [BOT('Дима')] });
    const spec = r.friend('spec');
    r.start();
    r.core.detach('spec', spec);
    a.eq(r.bus.of('bet:withdrawn').length, 0);
    a.deep(r.bus.of('friend:leave'), [{ id: 'spec' }]);
    a.eq(r.core.round.bets.length, 1);
  });

  // ── Хост: LIVE ──
  t.test('хост: Старт, ход и ошибки идут друзьям, видео звонит каждому один раз', (a) => {
    const r = hostRig({ bets: [BOT('Дима')] });
    r.stream = { id: 'кадры' };
    const f1 = r.friend('f1');
    const f2 = r.friend('f2');
    r.say('f1', { t: 'bet', amount: 5 });
    r.start();
    const start = f1.last('start');
    a.deep(start.challenge, { id: 'c1', type: 'squat', target: 10, limitSec: 90, stake: 10 });
    a.eq(start.bets.length, 2);
    a.deep(start.you, { amount: 5 });
    a.deep(f2.last('start').you, { amount: 0 });
    a.deep(f1.last('count'), { t: 'count', count: 0, target: 10, unit: 'повторы' });
    a.eq(f1.calls.length, 1);
    a.deep(f1.calls[0], { id: 'кадры' });
    a.eq(f2.calls.length, 1);
    r.bus.emit('count', { count: 3, target: 10, unit: 'повторы', type: 'squat' });
    a.deep(f2.last('count'), { t: 'count', count: 3, target: 10, unit: 'повторы' });
    r.bus.emit('fault', { code: 'knees', text: 'Колени выходят за носки, сядь глубже назад', joints: [25, 26] });
    a.deep(f1.last('fault'), { t: 'fault', text: 'Колени выходят за носки, сядь глубже назад', code: 'knees' });
    r.bus.emit('rejected', { code: 'depth', text: 'Недостаточная глубина' });
    a.deep(f2.last('rejected'), { t: 'rejected', text: 'Недостаточная глубина', code: 'depth' });
    r.bus.emit('rejected', {});
    a.eq(f2.last('rejected').text, '');
  });

  t.test('хост: без потока камеры звонка нет, а остальное работает', (a) => {
    const r = hostRig();
    const f = r.friend('f1');
    r.stream = null;
    r.start();
    a.eq(f.calls.length, 0);
    a.ok(f.last('start'));
  });

  t.test('хост: друг пришёл посреди LIVE, сразу видит Старт, счёт и звонок', (a) => {
    const r = hostRig({ bets: [BOT('Дима')] });
    r.stream = { id: 'кадры' };
    r.start();
    r.bus.emit('count', { count: 4, target: 10, unit: 'повторы' });
    const late = r.friend('late');
    a.ok(late.last('start'));
    a.deep(late.last('start').you, { amount: 0 });
    a.eq(late.last('count').count, 4);
    a.eq(late.calls.length, 1);
    r.say('late', { t: 'hello' });
    a.eq(late.calls.length, 1, 'повторный hello не звонит второй раз');
    r.say('late', { t: 'bet', amount: 5 });
    a.deep(late.last('bet:closed'), { t: 'bet:closed' });
  });

  t.test('хост: до Старта и после финиша счёт и ошибки друзьям не шлются', (a) => {
    const r = hostRig();
    const f = r.friend('f1');
    r.bus.emit('count', { count: 1, target: 10, unit: 'повторы' });
    r.bus.emit('fault', { text: 'до старта' });
    a.eq(f.of('count').length + f.of('fault').length, 0);
    r.start();
    r.end(true);
    const n = f.sent.length;
    r.bus.emit('count', { count: 2, target: 10, unit: 'повторы' });
    r.bus.emit('rejected', { text: 'после финиша' });
    a.eq(f.sent.length, n);
  });

  // ── Хост: итог и отмена ──
  t.test('хост: итог «сделал» и «не сделал» совпадает с общим расчётом money.settle', (a) => {
    for (const success of [true, false]) {
      const r = hostRig({ bets: [BOT('Дима'), BOT('Аня')] });
      r.app.challenge.stake = 30;
      const f1 = r.friend('f1');
      const f2 = r.friend('f2');
      const spec = r.friend('spec');
      r.say('f1', { t: 'bet', amount: 10 });
      r.say('f2', { t: 'bet', amount: 5 });
      r.start();
      const bets = r.app.challenge.bets.map(({ id, name, avatar, amount, bot }) => ({ id, name, avatar, amount, bot }));
      const st = settle({ stake: 30, bets, success });
      r.end(success, 10);
      const e1 = f1.last('end');
      a.eq(e1.success, success);
      a.eq(e1.count, 10);
      a.eq(e1.target, 10);
      a.deep(e1.you, { amount: 10, delta: st.friends.find((x) => x.id === 'peer:f1').delta }, `f1 ${success}`);
      a.deep(f2.last('end').you, { amount: 5, delta: st.friends.find((x) => x.id === 'peer:f2').delta });
      a.deep(spec.last('end').you, { amount: 0, delta: 0 }, 'зритель без ставки');
      a.eq(e1.you.delta, success ? -10 : 9);
      a.eq(r.core.round, null);
    }
  });

  t.test('хост: ставки после Старта не меняют расчёт (снимок на Старте)', (a) => {
    const r = hostRig();
    const f = r.friend('f1');
    r.say('f1', { t: 'bet', amount: 5 });
    r.start();
    r.app.challenge.bets.push({ id: 'bot-опоздал', name: 'Опоздал', amount: 5, bot: true });
    r.app.challenge.stake = 999;
    r.end(false);
    a.deep(f.last('end').you, { amount: 5, delta: 4.5 });
  });

  t.test('хост: видео гаснет после финиша с задержкой, при отмене сразу', (a) => {
    const r = hostRig();
    r.stream = { id: 's' };
    const f = r.friend('f1');
    r.start();
    r.end(true);
    a.eq(f.closedCalls, 0, 'последние кадры успевают дойти');
    a.eq(r.timers.queue[0].ms, MONEY.friend.callCloseMs);
    r.timers.run();
    a.eq(f.closedCalls, 1);
    r.start();
    a.eq(f.calls.length, 2, 'следующий раунд звонит заново');
    r.bus.emit('live:void', { challenge: r.app.challenge, reason: 'camera' });
    a.deep(f.last('void'), { t: 'void', reason: 'camera' });
    a.eq(f.closedCalls, 2);
    a.eq(r.core.round, null);
  });

  t.test('хост: ушли с LIVE, не доиграв, друзьям возврат (как у кошелька игрока)', (a) => {
    const r = hostRig();
    const f = r.friend('f1');
    r.start();
    r.go('SETUP');
    a.deep(f.last('void'), { t: 'void', reason: 'left' });
    r.start();
    r.end(false);
    r.go('RESULT');
    a.eq(f.of('void').length, 1, 'после финиша уход с LIVE не отменяет');
    r.start();
    r.bus.emit('live:void', { challenge: r.app.challenge, reason: 'camera' });
    r.go('VOID');
    a.eq(f.of('void').length, 2, 'отмена одна, а не две');
  });

  t.test('хост: новый LOBBY рассылает друзьям свежий пул, dispose всё закрывает', (a) => {
    const r = hostRig({ state: 'SETUP' });
    const f = r.friend('f1');
    a.eq(f.of('lobby').length, 1, 'в настройках друг тоже видит, что происходит');
    a.deep([f.last('lobby').open, f.last('lobby').note], [false, 'setup']);
    r.app.challenge = challengeOf({ id: 'c2', stake: 20 });
    r.go('LOBBY');
    a.eq(f.last('lobby').challenge.id, 'c2');
    a.eq(f.last('lobby').left, 20);
    a.deep([f.last('lobby').open, f.last('lobby').note], [true, null]);
    r.core.dispose();
    a.eq(f.closed, 1);
    const n = f.sent.length;
    r.bus.emit('count', { count: 1 });
    r.go('LOBBY');
    a.eq(f.sent.length, n, 'после dispose тишина');
  });

  // ── Гость ──
  t.test('гость: имя и аватар из списка, свои очищаются', (a) => {
    const def = guestRig();
    a.eq(def.api.name, MONEY.friend.guests[0].name);
    a.eq(def.api.avatar, MONEY.friend.guests[0].avatar);
    const own = guestRig({ name: '  Маша  ', avatar: '🐼' });
    a.eq(own.api.name, 'Маша');
    a.eq(own.api.avatar, '🐼');
    a.eq(guestRig({ name: 'x'.repeat(99), avatar: '💩' }).api.avatar, MONEY.friend.defaultAvatar);
    a.deep(def.sent[0], { t: 'hello', name: def.api.name, avatar: def.api.avatar });
    a.eq(def.api.status, 'open');
    a.eq(def.api.id, 'me1');
  });

  t.test('гость: пусто на счёте, при подключении пополняется до 100', (a) => {
    const storage = memoryStorage();
    const w = createGuestWallet({ storage });
    w.hold({ challengeId: 'старый', amount: 98 });
    w.settle({ challengeId: 'старый', success: true, you: { amount: 98, delta: -98 } });
    a.eq(w.balance, 2, 'прошлый раз проиграл почти всё');
    a.eq(guestRig({ storage }).api.balance(), 100);
    a.eq(guestRig({ balance: 60 }).api.balance(), 60, 'хватает на ставку: не трогаем');
  });

  t.test('гость: ставка отправляется только когда можно, и по разным причинам отказывает', (a) => {
    const r = guestRig({ balance: 50 });
    a.eq(r.api.bet(5), 'closed', 'lobby ещё нет');
    r.msg({ t: 'lobby', challenge: { id: 'c1' }, left: 10, bets: [], you: { amount: 0 } });
    a.eq(r.api.lobby.left, 10);
    a.eq(r.api.bet(0), 'invalid');
    a.eq(r.api.bet(-5), 'invalid');
    a.eq(r.api.bet('x'), 'invalid');
    a.eq(r.api.bet(80), 'poor');
    a.eq(r.api.bet(5), 'sent');
    a.deep(r.sent.at(-1), { t: 'bet', amount: 5 });
    r.msg({ t: 'bet:ok', amount: 5 });
    a.eq(r.api.myBet, 5);
    a.eq(r.api.bet(5), 'repeat');
    r.msg({ t: 'lobby', challenge: { id: 'c1' }, left: 0, bets: [{ id: 'peer:me1', amount: 5 }], you: { amount: 5 } });
    a.eq(r.api.myBet, 5, 'ставку видно и в списке ставок');
    r.io.closed();
    a.eq(r.api.bet(5), 'offline');
  });

  t.test('гость: пул полон, ставки нет', (a) => {
    const r = guestRig();
    r.msg({ t: 'lobby', challenge: { id: 'c1' }, left: 5, bets: [], you: { amount: 0 } });
    r.msg({ t: 'bet:full', left: 0 });
    a.eq(r.api.lobby.left, 0);
    a.eq(r.api.bet(5), 'full', 'пул полон это не «ставки закрыты»');
    a.eq(r.api.myBet, 0);
  });

  t.test('гость: кошелёк списывается на start, кошелёк раньше экрана', (a) => {
    const r = guestRig();
    r.msg({ t: 'lobby', challenge: { id: 'c1' }, left: 10, bets: [], you: { amount: 0 } });
    r.api.bet(5);
    r.msg({ t: 'bet:ok', amount: 5 });
    a.eq(r.api.balance(), 100, 'bet:ok ничего не списывает');
    r.msg({ t: 'start', challenge: { id: 'c1' }, bets: [{ id: 'peer:me1', amount: 5 }, { id: 'bot-x', amount: 5 }], you: { amount: 5 } });
    a.eq(r.api.balance(), 95);
    a.eq(r.api.lobby, null, 'ставки закрыты');
    const order = r.bus.seen.map(([type]) => type).filter((x) => x === 'guest:wallet' || x === 'guest:msg');
    a.deep(order.slice(-2), ['guest:wallet', 'guest:msg'], 'экран видит уже списанный баланс');
    a.deep(r.bus.of('guest:wallet').at(-1), { balance: 95, delta: -5, reason: 'hold' });
    r.msg({ t: 'start', challenge: { id: 'c1' }, bets: [{ id: 'peer:me1', amount: 5 }], you: { amount: 5 } });
    a.eq(r.api.balance(), 95, 'повторный start не списывает');
  });

  t.test('гость: игрок не сделал, друг выигрывает; сделал, друг теряет ставку', (a) => {
    for (const [success, delta, balance] of [[false, 4.5, 104.5], [true, -5, 95]]) {
      const r = guestRig();
      r.msg({ t: 'lobby', challenge: { id: 'c1' }, left: 10, bets: [], you: { amount: 0 } });
      r.msg({ t: 'bet:ok', amount: 5 });
      r.msg({ t: 'start', challenge: { id: 'c1' }, bets: [{ id: 'peer:me1', amount: 5 }], you: { amount: 5 } });
      r.msg({ t: 'end', success, count: 10, target: 10, you: { amount: 5, delta } });
      a.eq(r.api.balance(), balance, `success=${success}`);
      const settled = r.bus.of('guest:wallet').at(-1);
      a.eq(settled.reason, 'settle');
      a.eq(settled.balance, balance);
      r.msg({ t: 'end', success, you: { amount: 5, delta } });
      a.eq(r.api.balance(), balance, 'повторный end не платит');
    }
  });

  t.test('гость: отмена возвращает ставку, зритель без ставки ничего не теряет', (a) => {
    const r = guestRig();
    r.msg({ t: 'start', challenge: { id: 'c1' }, bets: [{ id: 'peer:me1', amount: 10 }], you: { amount: 10 } });
    a.eq(r.api.balance(), 90);
    r.msg({ t: 'void', reason: 'camera' });
    a.eq(r.api.balance(), 100);
    const s = guestRig();
    s.msg({ t: 'start', challenge: { id: 'c9' }, bets: [{ id: 'bot-x', amount: 5 }], you: { amount: 0 } });
    s.msg({ t: 'end', success: false, you: { amount: 0, delta: 0 } });
    a.eq(s.api.balance(), 100);
    s.msg({ t: 'end', success: false, you: { amount: 5, delta: 5 } });
    s.msg({ t: 'void' });
    a.eq(s.api.balance(), 100, 'end и void без своего раунда ничего не делают');
  });

  t.test('гость: страницу закрыли посреди челленджа, при следующем заходе ставка вернулась', (a) => {
    const first = guestRig();
    first.msg({ t: 'start', challenge: { id: 'c1' }, bets: [{ id: 'peer:me1', amount: 20 }], you: { amount: 20 } });
    a.eq(first.api.balance(), 80);
    const second = guestRig({ storage: first.storage });
    a.eq(second.api.balance(), 100);
  });

  t.test('гость: кредиты кончились, на каждом lobby пополнение до 100 и событие topup', (a) => {
    const r = guestRig();
    r.msg({ t: 'start', challenge: { id: 'x' }, bets: [{ id: 'peer:me1', amount: 100 }], you: { amount: 100 } });
    r.msg({ t: 'end', success: true, you: { amount: 100, delta: -100 } });
    a.eq(r.api.balance(), 0, 'проиграл всё');
    r.msg({ t: 'lobby', challenge: { id: 'c2' }, left: 10, bets: [], you: { amount: 0 }, open: true, note: null });
    a.eq(r.api.balance(), 100, 'новый lobby: пополнили');
    a.deep(r.bus.of('guest:wallet').at(-1), { balance: 100, delta: 100, reason: 'topup' });
    const before = r.bus.of('guest:wallet').length;
    r.msg({ t: 'lobby', challenge: { id: 'c2' }, left: 5, bets: [], you: { amount: 0 }, open: true, note: null });
    a.eq(r.bus.of('guest:wallet').length, before, 'хватает кредитов: молчим');
  });

  t.test('гость: ставки закрыты (bet:closed или open=false) это не «пул полон»', (a) => {
    const r = guestRig();
    r.msg({ t: 'lobby', challenge: { id: 'c1' }, left: 10, bets: [], you: { amount: 0 }, open: false, note: 'starting' });
    a.eq(r.api.lobby.note, 'starting');
    a.eq(r.api.bet(5), 'closed', 'игрок стартует');
    r.msg({ t: 'lobby', challenge: { id: 'c1' }, left: 10, bets: [], you: { amount: 0 }, open: true, note: null });
    a.eq(r.api.bet(5), 'sent');
    r.msg({ t: 'bet:closed' });
    a.eq(r.api.lobby.open, false);
    a.eq(r.api.bet(5), 'closed');
    a.deep(r.bus.of('guest:msg').at(-1), { msg: { t: 'bet:closed' } });
    r.msg({ t: 'lobby', challenge: { id: 'c1' }, left: 0, bets: [], you: { amount: 0 }, open: true, note: null });
    a.eq(r.api.bet(5), 'full', 'ставки идут, но места нет');
  });

  t.test('гость: реакции не чаще и не пустые, мусор от хоста не роняет', (a) => {
    let time = 0;
    const bus = miniBus();
    const wallet = createGuestWallet({ storage: memoryStorage() });
    const { api, io } = createGuestCore({ bus, wallet, now: () => time });
    a.eq(api.react('🔥'), false, 'связи ещё нет');
    const sent = [];
    io.open({ send: (m) => sent.push(m) });
    a.eq(api.react('🔥 Давай!'), true);
    a.eq(api.react('ещё'), false, 'слишком часто');
    time += MONEY.friend.reactGapMs;
    a.eq(api.react('   '), false);
    a.eq(api.react('ещё'), true);
    a.deep(sent.filter((m) => m.t === 'react').map((m) => m.text), ['🔥 Давай!', 'ещё']);
    for (const junk of [null, undefined, 5, 'x', {}, { t: 'hello' }, { t: 'lobby' }, [], { t: 'start' }, { t: 'end', you: 'ерунда' }]) io.message(junk);
    a.ok(api.status === 'open');
  });

  t.test('гость: связь закрылась, статус и ставки сброшены; ошибка остаётся ошибкой', (a) => {
    const r = guestRig();
    r.msg({ t: 'lobby', challenge: { id: 'c1' }, left: 10, bets: [], you: { amount: 0 } });
    r.io.closed();
    a.eq(r.api.status, 'closed');
    a.eq(r.api.lobby, null);
    a.deep(r.bus.of('guest:status').at(-1), { status: 'closed' });
    const e = guestRig();
    e.io.setStatus('error', 'peer-unavailable');
    e.io.closed();
    a.eq(e.api.status, 'error');
    a.deep(e.bus.of('guest:status').at(-1), { status: 'error', error: 'peer-unavailable' });
  });

  t.test('гость: хост молчит 20 с посреди раунда, ставка возвращается и экран получает void', (a) => {
    let time = 0;
    const bus = miniBus();
    const wallet = createGuestWallet({ storage: memoryStorage() });
    const { api, io } = createGuestCore({ bus, wallet, now: () => time });
    const sent = [];
    let closed = 0;
    io.setPeerId('me1');
    io.open({ send: (m) => sent.push(m), close: () => (closed += 1) });
    io.message({ t: 'start', challenge: { id: 'c1' }, bets: [{ id: 'peer:me1', amount: 10 }], you: { amount: 10 } });
    a.eq(api.balance(), 90);
    time = 5000;
    a.eq(io.tick(), true);
    a.deep(sent.at(-1), { t: 'ping' }, 'каждые 5 с ping хосту');
    time = MONEY.friend.hostSilentMs; // ровно столько: ещё терпим
    io.tick();
    a.eq(api.balance(), 90);
    a.eq(MONEY.friend.hostSilentMs, 20000);
    time = MONEY.friend.hostSilentMs + 1;
    a.eq(io.tick(), false, 'следить больше не за чем');
    a.eq(api.balance(), 100, 'ставка вернулась');
    a.deep(bus.of('guest:msg').at(-1), { msg: { t: 'void', reason: 'left' } });
    a.deep(bus.of('guest:wallet').at(-1), { balance: 100, delta: 10, reason: 'refund' });
    a.deep(bus.of('guest:status').at(-1), { status: 'closed', error: 'silent' });
    a.eq(closed, 1, 'мёртвую связь закрываем');
    a.eq(api.status, 'closed');
    io.closed(); // и настоящее закрытие приходит следом
    a.eq(bus.of('guest:status').filter((x) => x.status === 'closed').length, 1, 'событие closed одно');
    io.message({ t: 'end', success: false, you: { amount: 10, delta: 9 } });
    a.eq(api.balance(), 100, 'запоздавший итог возвращённое не рассчитывает');
  });

  t.test('гость: любое сообщение хоста = он жив; ping экрану не показываем; без раунда просто связь потеряна', (a) => {
    let time = 0;
    const bus = miniBus();
    const wallet = createGuestWallet({ storage: memoryStorage() });
    const { api, io } = createGuestCore({ bus, wallet, now: () => time });
    io.setPeerId('me1');
    io.open({ send() {}, close() {} });
    io.message({ t: 'start', challenge: { id: 'c1' }, bets: [{ id: 'peer:me1', amount: 5 }], you: { amount: 5 } });
    for (let i = 1; i <= 6; i++) {
      time = i * 10000;
      io.message({ t: 'ping' }); // хост молчит по делу, но пульс идёт
      a.eq(io.tick(), true, `тик ${i}`);
    }
    a.eq(api.balance(), 95, 'пока пульс есть, ставка держится');
    a.eq(bus.of('guest:msg').filter((m) => m.msg.t === 'ping').length, 0, 'ping экрану не нужен');
    // раунд закончился: тишина уже ничего не возвращает, но связь потеряна
    io.message({ t: 'end', success: true, you: { amount: 5, delta: -5 } });
    time += MONEY.friend.hostSilentMs + 1;
    io.tick();
    a.eq(api.balance(), 95, 'после итога возвращать нечего');
    a.eq(bus.of('guest:msg').filter((m) => m.msg.t === 'void').length, 0);
    a.deep(bus.of('guest:status').at(-1), { status: 'closed', error: 'silent' });
    // тишина после закрытия связи: следить надо, пока в раунде ставка
    const wl = createGuestWallet({ storage: memoryStorage() });
    const g = createGuestCore({ bus: miniBus(), wallet: wl, now: () => time });
    g.io.setPeerId('me1');
    g.io.open({ send() {}, close() {} });
    g.io.message({ t: 'start', challenge: { id: 'c9' }, bets: [{ id: 'peer:me1', amount: 20 }], you: { amount: 20 } });
    g.io.closed();
    a.eq(g.io.tick(), true, 'связь закрылась, но ставка ещё держится: ждём срок');
    time += MONEY.friend.hostSilentMs + 1;
    g.io.tick();
    a.eq(g.api.balance(), 100, 'срок вышел: ставка вернулась и после закрытия связи');
  });

  // ── Боты и друзья ──
  t.test('боты: ссылки нет и друзей нет, ждать нечего', (a) => {
    a.eq(friendWait({ link: 'none', watching: 0, room: 10, amount: 5, waited: 0 }), 0);
    a.eq(friendWait({ link: 'none', watching: 0, room: 5, amount: 5, waited: 0 }), 0, 'последнее место, но друзей не ждём');
  });

  t.test('боты: ссылка есть, последнее место бот не берёт, пока друг может прийти', (a) => {
    const cfg = MONEY.botsWithFriend;
    a.eq(friendWait({ link: 'up', room: 10, amount: 5, waited: 0 }), 0, 'первый бот оставляет место');
    a.eq(friendWait({ link: 'pending', room: 10, amount: 5, waited: 0 }), 0);
    a.eq(friendWait({ link: 'up', room: 5, amount: 5, waited: 0 }), cfg.recheckMs, 'второй ждёт');
    a.eq(friendWait({ link: 'up', room: 5, amount: 5, waited: cfg.graceMs - 300 }), 300, 'ждёт ровно до конца срока');
    a.eq(friendWait({ link: 'up', room: 5, amount: 5, waited: cfg.graceMs }), 0, 'никто не пришёл: берёт');
    a.eq(friendWait({ link: 'up', room: 20, amount: 5, waited: 0 }), 0, 'большой пул: места хватит всем');
  });

  t.test('боты: друг на связи, ждут дольше; друг поставил, берут остаток', (a) => {
    const cfg = MONEY.botsWithFriend;
    a.eq(friendWait({ link: 'up', watching: 1, room: 5, amount: 5, waited: cfg.graceMs }), cfg.recheckMs, 'друг подключился: ждём дольше');
    a.eq(friendWait({ link: 'up', watching: 1, room: 5, amount: 5, waited: cfg.waitMs }), 0);
    a.eq(friendWait({ link: 'up', watching: 1, realBet: true, room: 5, amount: 5, waited: 0 }), 0);
    a.eq(friendWait({ link: 'none', watching: 1, room: 5, amount: 5, waited: 0 }), cfg.recheckMs, 'ссылка пропала, но друг ещё здесь');
  });

  // ── Обвязка PeerJS на игрушечном облаке ──
  t.test('сеть: игрок получает ссылку на первом LOBBY и повторяет её на следующих', async (a) => {
    await withFakeTimers(async () => {
      const cloud = fakeCloud();
      const bus = miniBus();
      const app = { state: 'IDLE', challenge: challengeOf() };
      const host = installHost({ bus, app, camera: null, ui: null, Peer: cloud.Peer, location: LOC });
      a.eq(host.status, 'idle');
      bus.emit('state', { from: 'IDLE', to: 'SETUP' });
      a.eq(bus.of('peer:pending').length, 0, 'до LOBBY облако не трогаем');
      app.state = 'LOBBY';
      bus.emit('state', { from: 'SETUP', to: 'LOBBY' });
      a.eq(bus.of('peer:pending').length, 1);
      await flush();
      const [ready] = bus.of('peer:ready');
      a.ok(ready.id.startsWith('pr-'), ready.id);
      a.eq(ready.url, `https://demo.test/protiv/?join=${ready.id}`);
      a.eq(ready.friends, 0);
      a.eq(host.status, 'up');
      bus.emit('state', { from: 'LOBBY', to: 'LIVENESS' });
      bus.emit('state', { from: 'LIVENESS', to: 'LOBBY' });
      a.eq(bus.of('peer:ready').length, 2, 'LOBBY открыт заново: ссылку показываем снова');
      a.eq(cloud.created.length, 1, 'Peer один на всё время');
      a.eq(bus.of('peer:pending').length, 1);
      host.stop();
    });
  });

  t.test('сеть: id занят, пробуем другой; облако недоступно, peer:error и потом ещё попытка', async (a) => {
    await withFakeTimers(async () => {
      const cloud = fakeCloud();
      const bus = miniBus();
      const app = { state: 'LOBBY', challenge: challengeOf() };
      const first = makeId();
      const host = installHost({ bus, app, ui: null, Peer: cloud.Peer, location: LOC });
      await flush();
      a.eq(bus.of('peer:ready').length, 1, 'включили уже в LOBBY: сразу стартуем');
      host.stop();

      const busy = fakeCloud();
      const b2 = miniBus();
      const original = busy.Peer;
      let n = 0;
      busy.Peer = class extends original {
        constructor(id, o) {
          if (n++ === 0) busy.taken.add(id);
          super(id, o);
        }
      };
      const h2 = installHost({ bus: b2, app: { state: 'LOBBY', challenge: challengeOf() }, ui: null, Peer: busy.Peer, location: LOC });
      await flush();
      a.eq(b2.of('peer:ready').length, 1, 'второй id подошёл');
      a.eq(b2.of('peer:error').length, 0);
      a.ok(n >= 2);
      h2.stop();
      a.ok(first);

      const b3 = miniBus();
      const app3 = { state: 'IDLE', challenge: challengeOf() };
      let attempts = 0;
      const h3 = installHost({
        bus: b3,
        app: app3,
        ui: null,
        loader: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error('CDN недоступен');
          return cloud.Peer;
        },
        location: LOC,
      });
      for (let i = 0; i < 3; i++) {
        app3.state = 'LOBBY';
        b3.emit('state', { from: 'SETUP', to: 'LOBBY' });
        await flush();
        app3.state = 'SETUP';
      }
      a.eq(b3.of('peer:error').length, 2, 'дважды не вышло: карточки нет');
      a.deep(b3.of('peer:error')[0], { error: 'lib' });
      a.eq(b3.of('peer:ready').length, 1, 'с третьего раза ссылка появилась');
      h3.stop();
    });
  });

  t.test('сеть: после трёх неудач больше не мучаем облако', async (a) => {
    await withFakeTimers(async () => {
      const bus = miniBus();
      const app = { state: 'IDLE', challenge: challengeOf() };
      let attempts = 0;
      const host = installHost({ bus, app, ui: null, loader: async () => { attempts += 1; throw new Error('нет сети'); }, location: LOC });
      for (let i = 0; i < 6; i++) {
        bus.emit('state', { from: 'SETUP', to: 'LOBBY' });
        await flush();
      }
      a.eq(attempts, MONEY.peer.libTries);
      a.eq(bus.of('peer:error').length, MONEY.peer.libTries);
      a.eq(bus.of('peer:ready').length, 0);
      host.stop();
    });
  });

  t.test('сеть: друг по ссылке проходит весь путь: hello, ставка, Старт, видео, итог', async (a) => {
    await withFakeTimers(async ({ fire }) => {
      const cloud = fakeCloud();
      const hostBus = miniBus();
      const app = { state: 'SETUP', challenge: challengeOf({ stake: 10 }) };
      const camera = { stream: { id: 'кадры игрока' } };
      const host = installHost({ bus: hostBus, app, camera, ui: null, Peer: cloud.Peer, location: LOC });
      app.state = 'LOBBY';
      hostBus.emit('state', { from: 'SETUP', to: 'LOBBY' });
      await flush();
      const { id } = hostBus.of('peer:ready')[0];

      const friendBus = miniBus();
      const guest = createGuest({ hostId: id, bus: friendBus, name: 'Лиса', avatar: '🦊', Peer: cloud.Peer, storage: memoryStorage() });
      a.eq(guest.status, 'connecting');
      guest.connect();
      await flush();
      a.deep(friendBus.of('guest:status').map((s) => s.status), ['connecting', 'open']);
      a.deep(hostBus.of('friend:join').map((j) => j.name), ['Лиса']);
      a.eq(host.watching, 1);
      a.eq(friendBus.of('guest:msg')[0].msg.t, 'lobby');
      a.eq(guest.lobby.left, 10);

      const conn = cloud.created.find((p) => p.id === guest.id).conns[0];
      a.ok(typeof conn.sent[0] === 'string', 'по каналу идёт строка JSON');
      a.eq(JSON.parse(conn.sent[0]).t, 'hello');

      a.eq(guest.bet(5), 'sent');
      await flush();
      a.eq(guest.myBet, 5);
      a.deep(hostBus.of('bet').map((b) => [b.bet.id, b.bet.amount, b.bet.bot]), [[`peer:${guest.id}`, 5, false]]);
      a.eq(guest.lobby.left, 5, 'пул пересчитан и разослан');

      app.state = 'LIVE';
      hostBus.emit('state', { from: 'LOBBY', to: 'LIVE' });
      hostBus.emit('live:start', { challenge: app.challenge });
      await flush();
      a.eq(guest.balance(), 95, 'на Старте ставка списана');
      const streams = friendBus.of('guest:stream');
      a.eq(streams.length, 1);
      a.deep(streams[0].stream, { id: 'кадры игрока' }, 'друг получил видео игрока');

      hostBus.emit('count', { count: 7, target: 10, unit: 'повторы' });
      hostBus.emit('fault', { code: 'knees', text: 'Колени за носки' });
      await flush();
      const kinds = friendBus.of('guest:msg').map((m) => m.msg.t);
      a.ok(kinds.includes('count') && kinds.includes('fault'), kinds.join(','));

      hostBus.emit('live:end', { session: { challengeId: 'c1', success: false, count: 7, target: 10 }, challenge: app.challenge });
      await flush();
      a.eq(guest.balance(), 95 + 9.5, 'игрок не справился: ставка назад и 4,5 сверху');
      a.deep(friendBus.of('guest:msg').at(-1).msg.you, { amount: 5, delta: 4.5 });
      fire(); // видео гаснет после финиша
      await flush();
      a.eq(friendBus.of('guest:stream').at(-1).stream, null, 'звонок закончился');

      guest.stop();
      await flush();
      a.eq(guest.status, 'closed');
      a.deep(hostBus.of('friend:leave'), [{ id: guest.id }]);
      a.eq(host.watching, 0);
      host.stop();
    });
  });

  t.test('сеть: пульс идёт в обе стороны, пока друг на связи', async (a) => {
    await withFakeTimers(async ({ fire, queue }) => {
      const cloud = fakeCloud();
      const hostBus = miniBus();
      const app = { state: 'LOBBY', challenge: challengeOf() };
      const host = installHost({ bus: hostBus, app, ui: null, Peer: cloud.Peer, location: LOC });
      await flush();
      a.eq(queue.filter((q) => q.live && q.ms === MONEY.friend.pingMs).length, 0, 'пока друзей нет, пульс не тикает');
      const guest = createGuest({ hostId: hostBus.of('peer:ready')[0].id, bus: miniBus(), Peer: cloud.Peer, storage: memoryStorage() });
      guest.connect();
      await flush();
      const beats = queue.filter((q) => q.live && q.ms === MONEY.friend.pingMs).length;
      a.eq(beats, 2, 'после подключения тикают оба пульса (хоста и гостя)');
      const conn = cloud.created.find((p) => p.id === guest.id).conns[0];
      const hostConn = [...cloud.peers.values()].find((p) => p.conns.length && p.id !== guest.id).conns[0];
      fire();
      await flush();
      a.ok(hostConn.sent.some((m) => JSON.parse(m).t === 'ping'), 'хост прислал ping');
      a.ok(conn.sent.some((m) => JSON.parse(m).t === 'ping'), 'друг прислал ping');
      a.eq(queue.filter((q) => q.live && q.ms === MONEY.friend.pingMs).length, 2, 'пульс продолжается');
      guest.stop();
      await flush();
      host.stop();
      a.eq(queue.filter((q) => q.live && q.ms === MONEY.friend.pingMs).length, 0, 'после stop пульса нет');
    });
  });

  t.test('сеть: ссылка не существует или игрок ушёл, друг получает понятную ошибку', async (a) => {
    await withFakeTimers(async () => {
      const cloud = fakeCloud();
      const bus = miniBus();
      const guest = createGuest({ hostId: 'pr-нету', bus, Peer: cloud.Peer, storage: memoryStorage() });
      guest.connect();
      await flush();
      a.deep(bus.of('guest:status').map((s) => s.status), ['connecting', 'error']);
      a.eq(bus.of('guest:status').at(-1).error, 'peer-unavailable');
      a.eq(guest.status, 'error');
    });
  });

  t.test('сеть: игрок закрыл страницу во время LIVE, друг видит закрытие и ставка вернётся при следующем заходе', async (a) => {
    await withFakeTimers(async () => {
      const cloud = fakeCloud();
      const hostBus = miniBus();
      const app = { state: 'LOBBY', challenge: challengeOf() };
      const host = installHost({ bus: hostBus, app, ui: null, Peer: cloud.Peer, location: LOC });
      await flush();
      const storage = memoryStorage();
      const bus = miniBus();
      const guest = createGuest({ hostId: hostBus.of('peer:ready')[0].id, bus, Peer: cloud.Peer, storage });
      guest.connect();
      await flush();
      guest.bet(10);
      await flush();
      app.state = 'LIVE';
      hostBus.emit('live:start', { challenge: app.challenge });
      await flush();
      a.eq(guest.balance(), 90);
      cloud.peers.get(hostBus.of('peer:ready')[0].id).destroy(); // игрок закрыл вкладку
      await flush();
      a.eq(guest.status, 'closed');
      const back = createGuest({ hostId: 'x', bus: miniBus(), Peer: cloud.Peer, storage });
      a.eq(back.balance(), 100, 'при следующем заходе ставка вернулась');
      host.stop();
    });
  });

  t.test('сеть: два друга и бот, кто раньше, тому место; лишним пул полон', async (a) => {
    await withFakeTimers(async () => {
      const cloud = fakeCloud();
      const hostBus = miniBus();
      const app = { state: 'LOBBY', challenge: challengeOf({ stake: 10 }) };
      const host = installHost({ bus: hostBus, app, ui: null, Peer: cloud.Peer, location: LOC });
      await flush();
      const hostId = hostBus.of('peer:ready')[0].id;
      const guests = [];
      for (const name of ['Лиса', 'Тигр']) {
        const bus = miniBus();
        const g = createGuest({ hostId, bus, name, storage: memoryStorage(), Peer: cloud.Peer });
        g.connect();
        guests.push({ g, bus });
      }
      await flush();
      a.eq(guests[0].g.bet(10), 'sent');
      a.eq(guests[1].g.bet(5), 'sent'); // оба нажали, пока никто не знал о ставке другого
      await flush();
      a.eq(guests[0].g.myBet, 10, 'кто раньше, тот и в пуле');
      a.eq(guests[1].g.myBet, 0);
      a.deep(guests[1].bus.of('guest:msg').filter((m) => m.msg.t === 'bet:full').map((m) => m.msg.left), [0]);
      a.eq(guests[1].g.bet(5), 'full', 'теперь друг и сам знает, что места нет');
      a.eq(app.challenge.bets.length, 1);
      a.eq(host.watching, 2);
      host.stop();
    });
  });
}
