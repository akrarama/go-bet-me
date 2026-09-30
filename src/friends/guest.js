// Ядро гостя (P1): друг у себя на устройстве. Владелец: блок 3 (Деньги).
// Про PeerJS не знает: peer.js даёт link { send(msg) } и зовёт io.open / io.message / io.closed,
// поэтому тесты в jsc гоняют ядро с игрушечным link. Формат сообщений: protocol.js.
//
// Шлёт в шину:
//   guest:status {status, error}   'connecting' | 'open' | 'closed' | 'error'
//   guest:msg {msg}                каждое сообщение хоста как есть, уже после того, как кошелёк его применил
//   guest:stream {stream}          видео игрока (MediaStream) или null, когда звонок кончился
//   guest:wallet {balance, delta, reason}   баланс друга изменился: hold | settle | refund | topup | sync | reset
//
// Кошелёк друга (guest-wallet.js): на start списывает его ставку, на end рассчитывает, на void возвращает.

import { MONEY } from '../config.js';
import { betId, cleanText, cleanName, cleanAvatar, parseHostMsg } from './protocol.js';

/**
 * bus: шина. wallet: createGuestWallet(). name, avatar: если экран не передал, случайные из MONEY.friend.guests.
 * Возвращает { api, io }: api отдаётся экрану, io для peer.js (связь с сетью).
 */
export function createGuestCore({ bus, wallet, name, avatar, rng = Math.random, now = () => Date.now(), timers = globalThis }) {
  const cfg = MONEY.friend;
  const pick = cfg.guests[Math.floor(rng() * cfg.guests.length)] ?? {};
  const me = { name: cleanName(name || pick.name), avatar: cleanAvatar(avatar || pick.avatar) };

  let link = null; // { send(msg) }, пока соединение открыто
  let status = 'connecting';
  let peerId = null;
  let lobby = null; // последнее lobby от хоста, null когда ставки закрыты
  let myBet = 0; // ставка друга в этом челлендже (принята хостом)
  let challengeId = null;
  let lastReactAt = -Infinity;
  let lostTimer = null; // связь с игроком пропала посреди раунда: ждём MONEY.friend.hostLostMs, потом возвращаем ставку

  wallet.recover('interrupted'); // прошлый раз закрыли вкладку посреди челленджа: ставка возвращается
  wallet.subscribe(({ reason, delta, balance }) => bus.emit('guest:wallet', { balance, delta, reason }));

  const setStatus = (next, error) => {
    status = next;
    bus.emit('guest:status', { status: next, ...(error ? { error: String(error) } : {}) });
  };

  /** Сколько друг поставил: по списку ставок (id = peer:<мой id>), запасной путь поле you. */
  function ownAmount(msg) {
    const own = peerId ? (msg.bets ?? []).find((b) => b.id === betId(peerId)) : null;
    return Number(own?.amount ?? msg.you?.amount) || 0;
  }

  function onMessage(data) {
    const msg = parseHostMsg(data);
    if (!msg) return;
    switch (msg.t) {
      case 'lobby':
        challengeId = msg.challenge?.id ?? challengeId;
        lobby = msg;
        myBet = ownAmount(msg);
        break;
      case 'bet:ok':
        myBet = Number(msg.amount) || 0;
        break;
      case 'bet:full':
        if (lobby) lobby = { ...lobby, left: Number(msg.left) || 0 };
        break;
      case 'start': {
        challengeId = msg.challenge?.id ?? challengeId;
        myBet = ownAmount(msg);
        lobby = null; // ставки закрыты
        if (myBet > 0) wallet.hold({ challengeId, amount: myBet });
        break;
      }
      case 'end':
        wallet.settle({ challengeId, success: !!msg.success, you: msg.you });
        break;
      case 'void':
        wallet.refund(challengeId, 'void');
        break;
      default:
        break;
    }
    bus.emit('guest:msg', { msg });
  }

  const api = {
    get name() {
      return me.name;
    },
    get avatar() {
      return me.avatar;
    },
    /** Мой peer id (появляется, когда облако выдало его). */
    get id() {
      return peerId;
    },
    get status() {
      return status;
    },
    /** Последнее lobby от хоста или null (ставки закрыты). */
    get lobby() {
      return lobby;
    },
    /** Моя принятая ставка в текущем челлендже, 0 если не ставил. */
    get myBet() {
      return myBet;
    },

    balance: () => wallet.balance,

    /**
     * Поставить против игрока. Возвращает: 'sent' | 'offline' | 'closed' | 'repeat' | 'invalid' | 'poor'.
     * Ответ хоста придёт как guest:msg bet:ok {amount} или bet:full {left}.
     */
    bet(amount) {
      if (status !== 'open' || !link) return 'offline';
      if (!lobby || !(Number(lobby.left) > 0)) return 'closed';
      if (myBet > 0) return 'repeat';
      const a = Number(amount);
      if (!(a > 0)) return 'invalid';
      if (!wallet.canAfford(a)) return 'poor';
      link.send({ t: 'bet', amount: a });
      return 'sent';
    },

    /** Реакция в ленту игрока. false: нет связи, пусто или слишком часто. */
    react(text) {
      if (status !== 'open' || !link) return false;
      const t = now();
      const clean = cleanText(text, cfg.reactMax);
      if (!clean || t - lastReactAt < cfg.reactGapMs) return false;
      lastReactAt = t;
      link.send({ t: 'react', text: clean });
      return true;
    },
  };

  const clearLost = () => {
    if (lostTimer != null) timers.clearTimeout?.(lostTimer);
    lostTimer = null;
  };

  /** Игрок не вернулся: ставка возвращается, экран получает обычный void (причина left). */
  function hostGone() {
    lostTimer = null;
    if (!wallet.refund(challengeId, 'left')) return;
    bus.emit('guest:msg', { msg: { t: 'void', reason: 'left' } });
  }

  const io = {
    setPeerId(id) {
      peerId = id;
    },
    setStatus,
    /** Соединение с игроком открылось: пополнить, если пусто, и представиться. */
    open(l) {
      clearLost(); // игрок вернулся
      link = l;
      wallet.topUpIfBroke();
      l.send({ t: 'hello', name: me.name, avatar: me.avatar });
      setStatus('open');
    },
    message: onMessage,
    /** Связь закрылась. left: друг сам ушёл (stop), тогда ничего не ждём. */
    closed({ left = false } = {}) {
      link = null;
      lobby = null;
      if (status !== 'error') setStatus('closed');
      if (left) return clearLost();
      // короткий обрыв сети раунд не отменяет: возвращаем ставку, только если игрока нет уже MONEY.friend.hostLostMs
      if (wallet.open.length && lostTimer == null) lostTimer = timers.setTimeout(hostGone, cfg.hostLostMs);
    },
    stream: (stream) => bus.emit('guest:stream', { stream }),
  };

  return { api, io };
}
