// Ядро хоста (P1): игрок принимает друзей по ссылке. Владелец: блок 3 (Деньги).
// Про PeerJS не знает: peer.js отдаёт каждое соединение как link { send(msg), call(stream), close() },
// поэтому тесты в jsc гоняют ядро с игрушечными link и своей шиной. Формат сообщений: protocol.js.
//
// Слушает шину: state, bet, stake:raised, live:start, count, fault, rejected, live:end, live:void.
//   stake:raised {challenge, from, to}: игрок поднял свою ставку (пул был полон), друзьям уходит lobby с новым остатком.
// Шлёт в шину: friend:join {id, name, avatar}, friend:leave {id}, bet {bet, challenge} (ставка друга,
//   bet.id = 'peer:<id>', bot = false), bet:cancel {bet, challenge} (друг ушёл из LOBBY, его ставка снята),
//   bet:withdrawn {bet, challenge, reason} (друг ушёл посреди LIVE: ставка выходит из расчёта, без выплаты и комиссии),
//   comment {from, text, avatar} (реакция друга в ленту).
// Пульс: tick() зовёт peer.js раз в MONEY.friend.pingMs: шлёт ping и отключает друга, если он молчит friendSilentMs.
//
// Деньги: ставка друга это обычная запись в challenge.bets, её берёт в расчёт тот же money.settle,
// что и для ботов. Друг платит на своём устройстве (guest-wallet.js), здесь только считаем и сообщаем итог.

import { MONEY, CHALLENGES } from '../config.js';
import { acceptBet, poolLeft, settle, formatCredits } from '../money.js';
import { betId, isPeerBet, peerIdOf, parseFriendMsg, parseWire, pubChallenge, pubBets, cleanText } from './protocol.js';

/**
 * bus, app: шина и состояние приложения. getStream(): MediaStream камеры игрока или null (видео тогда нет).
 * toast(text, {icon, tone}): всплывашка игроку. timers: подмена setTimeout для тестов.
 */
export function createHostCore({ bus, app, getStream = () => null, toast = null, fee = MONEY.APP_FEE, now = () => Date.now(), timers = globalThis } = {}) {
  const cfg = MONEY.friend;
  const friends = new Map(); // id друга (peer id) → { id, link, joined, name, avatar, lastReactAt, call }
  let round = null; // идёт LIVE: { id, challenge, stake, bets, last } (снимок на Старте)

  const joined = () => [...friends.values()].filter((f) => f.joined);
  const isLobby = () => app.state === 'LOBBY';

  function send(f, msg) {
    try {
      f.link.send(msg);
    } catch (err) {
      globalThis.console?.warn?.('[host] send', err);
    }
  }
  const sendAll = (msg) => joined().forEach((f) => send(f, msg));

  const betOf = (f, bets = app.challenge?.bets) => (bets ?? []).find((b) => b.id === betId(f.id)) ?? null;

  // ─── Что видит друг ───────────────────────────────────────────

  // когда друг видит экран ставок: сам LOBBY и краткие остановки рядом с ним
  const LOBBY_LIKE = new Set(['LOBBY', 'LIVENESS', 'SETUP']);
  const noteOf = () => (app.state === 'LIVENESS' ? 'starting' : app.state === 'SETUP' ? 'setup' : null);
  // до Старта ставку ушедшего друга ещё можно просто снять
  const beforeStart = () => !round && (app.state === 'LOBBY' || app.state === 'LIVENESS' || app.state === 'LIVE');

  function lobbyMsg(f) {
    const ch = app.challenge;
    return {
      t: 'lobby',
      challenge: pubChallenge(ch),
      left: poolLeft(ch),
      bets: pubBets(ch.bets),
      you: { amount: betOf(f)?.amount ?? 0 },
      open: isLobby(), // ставки идут только пока игрок в LOBBY
      note: noteOf(), // 'starting' | 'setup' | null
    };
  }

  function startMsg(f) {
    return { t: 'start', challenge: pubChallenge(round.challenge), bets: pubBets(round.bets), you: { amount: betOf(f, round.bets)?.amount ?? 0 } };
  }

  function broadcastLobby() {
    if (!LOBBY_LIKE.has(app.state) || !app.challenge) return;
    joined().forEach((f) => send(f, lobbyMsg(f)));
  }

  /** Друг заглянул: показать ему то, что происходит сейчас. */
  function syncTo(f) {
    if (round) return startFor(f);
    if (LOBBY_LIKE.has(app.state) && app.challenge) send(f, lobbyMsg(f));
  }

  // ─── Соединения ───────────────────────────────────────────────

  /** Соединение открылось. false: мест нет, соединение закрыто. */
  function attach(id, link) {
    const old = friends.get(id);
    if (!old && friends.size >= cfg.maxFriends) {
      try {
        link.close?.();
      } catch {
        /* уже закрыто */
      }
      return false;
    }
    if (old && old.link !== link) {
      closeCall(old);
      try {
        old.link.close?.();
      } catch {
        /* уже закрыто */
      }
    }
    friends.set(id, { id, link, joined: old?.joined ?? false, name: old?.name ?? '', avatar: old?.avatar ?? '', lastReactAt: -Infinity, lastHeard: now(), call: null });
    return true;
  }

  /** Соединение закрылось. Устаревшее закрытие (link уже заменён новым) игнорируем. */
  function detach(id, link) {
    const f = friends.get(id);
    if (!f || f.link !== link) return;
    friends.delete(id);
    closeCall(f);
    if (!f.joined) return;
    // ушёл до финиша: до Старта его ставка снимается, посреди LIVE выходит из расчёта (без выплаты и комиссии)
    const cancelled = beforeStart() ? cancelBet(f) : null;
    if (round) withdrawFromRound(f);
    bus.emit('friend:leave', { id });
    if (cancelled && isLobby()) broadcastLobby();
  }

  /** Друг ушёл посреди LIVE: ставка снимается со снимка расчёта, кошелёк игрока и экран итогов узнают из события. */
  function withdrawFromRound(f) {
    const i = round.bets.findIndex((b) => b.id === betId(f.id));
    if (i < 0) return null;
    const [bet] = round.bets.splice(i, 1);
    bus.emit('bet:withdrawn', { bet: { ...bet }, challenge: round.challenge, reason: 'left' });
    return bet;
  }

  /** Друг ушёл до Старта: его ставка снимается, место в пуле освобождается. */
  function cancelBet(f) {
    const ch = app.challenge;
    const i = (ch?.bets ?? []).findIndex((b) => b.id === betId(f.id));
    if (i < 0) return null;
    const [bet] = ch.bets.splice(i, 1);
    if (isLobby()) bus.emit('bet:cancel', { bet, challenge: ch });
    return bet;
  }

  /** Ставки закрываются: снимаем ставки тех, кого уже нет. Возвращает, сколько снято. */
  function prune() {
    const bets = app.challenge?.bets;
    let removed = 0;
    for (let i = (bets?.length ?? 0) - 1; i >= 0; i--) {
      if (isPeerBet(bets[i]) && !friends.get(peerIdOf(bets[i].id))?.joined) {
        bets.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  // ─── Сообщения друга ──────────────────────────────────────────

  /** Пришло от друга: строка JSON или уже объект. Проверяем всё, чужие данные ничему не доверяем. */
  function receive(id, data) {
    const f = friends.get(id);
    if (f) f.lastHeard = now(); // любое сообщение = друг жив
    const msg = f ? parseFriendMsg(parseWire(data)) : null;
    if (!f || !msg) return;
    if (msg.t === 'ping') return;
    if (msg.t === 'hello') return onHello(f, msg);
    if (!f.joined) return; // без hello ничего не принимаем
    if (msg.t === 'bet') return onBet(f, msg);
    if (msg.t === 'react') return onReact(f, msg);
  }

  function onHello(f, msg) {
    if (!f.joined) {
      f.joined = true;
      f.name = msg.name;
      f.avatar = msg.avatar;
      bus.emit('friend:join', { id: f.id, name: f.name, avatar: f.avatar });
    }
    syncTo(f);
  }

  function onBet(f, msg) {
    const ch = app.challenge;
    if (!isLobby() || !ch) return send(f, { t: 'bet:closed' }); // ставки закрыты (Старт, настройки), это не «пул полон»
    const prev = betOf(f);
    if (prev) return send(f, { t: 'bet:ok', amount: prev.amount }); // одна ставка на друга: ещё раз тот же ответ
    const left = poolLeft(ch);
    // только 5 / 10 / 20 и не больше остатка пула: лишнее не обрезаем, отвечаем, сколько места
    if (!cfg.bets.includes(msg.amount) || msg.amount > left) return send(f, { t: 'bet:full', left });
    const r = acceptBet(ch, { id: betId(f.id), name: f.name, avatar: f.avatar, amount: msg.amount, bot: false });
    if (!r.bet) return send(f, { t: 'bet:full', left: r.left });
    send(f, { t: 'bet:ok', amount: r.bet.amount });
    toast?.(`${f.name} ставит ${formatCredits(r.bet.amount)} кр. против тебя`, { icon: f.avatar, tone: 'danger' });
    bus.emit('bet', { bet: r.bet, challenge: ch }); // LOBBY рисует строку, а мы ниже разошлём новый пул всем
  }

  function onReact(f, msg) {
    const t = now();
    if (t - f.lastReactAt < cfg.reactGapMs) return;
    f.lastReactAt = t;
    bus.emit('comment', { from: f.name, text: msg.text, avatar: f.avatar, id: betId(f.id), bot: false });
  }

  // ─── LIVE: Старт, ход, финиш ──────────────────────────────────

  function callFriend(f) {
    const stream = getStream();
    if (!stream || f.call || !f.link.call) return;
    try {
      f.call = f.link.call(stream) ?? null;
    } catch (err) {
      globalThis.console?.warn?.('[host] call', err);
    }
  }

  function closeCall(f) {
    const call = f.call;
    f.call = null;
    try {
      call?.close?.();
    } catch {
      /* уже закрыт */
    }
  }

  /** Друг видит Старт: снимок челленджа и ставок, текущий счёт, видео игрока. */
  function startFor(f) {
    send(f, startMsg(f));
    if (round.last) send(f, { t: 'count', ...round.last });
    callFriend(f);
  }

  function onStart({ challenge } = {}) {
    if (!challenge) return;
    if (round) closeRound(0); // прошлый раунд не закончился (отладка): закрываем, у друзей он завершится новым start
    prune(); // ещё раз: друг мог уйти во время проверки
    round = {
      id: challenge.id,
      challenge: { ...challenge },
      stake: challenge.stake,
      bets: (challenge.bets ?? []).map(({ id, name, avatar, amount, bot }) => ({ id, name, avatar, amount, bot: !!bot })),
      last: { count: 0, target: challenge.target, unit: CHALLENGES[challenge.type]?.unit ?? 'повторы' },
    };
    joined().forEach(startFor);
  }

  function onCount({ count, target, unit } = {}) {
    if (!round) return;
    round.last = { count, target, unit };
    sendAll({ t: 'count', count, target, unit });
  }

  const forward = (t) => (payload = {}) => {
    if (!round) return;
    sendAll({ t, text: cleanText(payload.text, 200), ...(payload.code ? { code: String(payload.code) } : {}) });
  };

  function onEnd({ session, challenge } = {}) {
    if (!round || round.id !== (challenge?.id ?? session?.challengeId)) return;
    const success = !!session?.success;
    const st = settle({ stake: round.stake, bets: round.bets, success, fee });
    for (const f of joined()) {
      const row = st.friends.find((x) => x.id === betId(f.id));
      send(f, { t: 'end', success, count: session?.count ?? 0, target: round.challenge.target, you: { amount: row?.amount ?? 0, delta: row?.delta ?? 0 } });
    }
    closeRound(cfg.callCloseMs);
  }

  function onVoid({ challenge, reason } = {}) {
    if (!round || (challenge?.id && round.id !== challenge.id)) return;
    sendAll({ t: 'void', reason: String(reason ?? 'void') });
    closeRound(0);
  }

  /** Раунд закончен: видео гасим через delayMs (последние кадры успевают дойти). */
  function closeRound(delayMs) {
    const calls = [...friends.values()].map((f) => f.call).filter(Boolean);
    friends.forEach((f) => {
      f.call = null;
    });
    round = null;
    const close = () =>
      calls.forEach((c) => {
        try {
          c.close?.();
        } catch {
          /* уже закрыт */
        }
      });
    if (delayMs > 0) timers.setTimeout(close, delayMs);
    else close();
  }

  function onState({ from, to } = {}) {
    if (from === 'LOBBY' && to !== 'LOBBY') prune(); // Старт: ставки закрыты, остаются те, кто на связи
    if (LOBBY_LIKE.has(to)) broadcastLobby(); // друзья узнают: ставки идут / игрок стартует / игрок в настройках
    if (from === 'LIVE' && round && to !== 'VOID') onVoid({ reason: 'left' }); // ушли с LIVE, не доиграв (отладка)
  }

  /** Игрок поднял ставку (stake:raised): в пуле появилось место, друзья получают lobby с новым остатком и ставкой. */
  function onStakeRaised({ challenge } = {}) {
    if (challenge?.id && challenge.id === app.challenge?.id) broadcastLobby();
  }

  function onBusBet({ challenge } = {}) {
    if (challenge?.id && challenge.id === app.challenge?.id) broadcastLobby();
  }

  /** Пульс (раз в MONEY.friend.pingMs): ping живым друзьям, а кто молчит friendSilentMs, того отключаем. */
  function tick() {
    const t = now();
    for (const f of [...friends.values()]) {
      if (t - f.lastHeard > cfg.friendSilentMs) {
        const link = f.link;
        detach(f.id, link);
        try {
          link.close?.();
        } catch {
          /* уже закрыто */
        }
      } else if (f.joined) send(f, { t: 'ping' });
    }
  }

  const offs = [
    bus.on('state', onState),
    bus.on('bet', onBusBet),
    bus.on('stake:raised', onStakeRaised),
    bus.on('live:start', onStart),
    bus.on('count', onCount),
    bus.on('fault', forward('fault')),
    bus.on('rejected', forward('rejected')),
    bus.on('live:end', onEnd),
    bus.on('live:void', onVoid),
  ];

  return {
    attach,
    detach,
    receive,
    /** Сколько друзей смотрят (сказали hello). */
    get watching() {
      return joined().length;
    },
    get friends() {
      return joined().map(({ id, name, avatar }) => ({ id, name, avatar }));
    },
    get round() {
      return round;
    },
    /** Разослать друзьям состояние LOBBY (после смены челленджа). */
    broadcastLobby,
    tick,
    dispose() {
      offs.forEach((off) => off());
      friends.forEach((f) => {
        closeCall(f);
        try {
          f.link.close?.();
        } catch {
          /* уже закрыто */
        }
      });
      friends.clear();
      round = null;
    },
  };
}
