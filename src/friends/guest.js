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
// Пульс: io.tick() зовёт peer.js раз в MONEY.friend.pingMs: шлёт ping хосту и следит, слышно ли хоста. Молчит
// hostSilentMs: в раунде ставка возвращается (кошелёк друга) и экран получает msg void с причиной left, связь потеряна.

import { MONEY } from '../config.js';
import { betId, cleanText, cleanName, cleanAvatar, parseHostMsg } from './protocol.js';

/**
 * bus: шина. wallet: createGuestWallet(). name, avatar: если экран не передал, случайные из MONEY.friend.guests.
 * Возвращает { api, io }: api отдаётся экрану, io для peer.js (связь с сетью).
 */
export function createGuestCore({ bus, wallet, name, avatar, rng = Math.random, now = () => Date.now() }) {
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
  let lastHeard = null; // когда в последний раз слышали хоста (любое сообщение); null пока не подключились
  let silentDone = false; // тишина уже обработана, пока хост не заговорил снова

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
    lastHeard = now(); // любое сообщение хоста = он жив
    silentDone = false;
    const msg = parseHostMsg(data);
    if (!msg || msg.t === 'ping') return; // ping экрану не нужен
    switch (msg.t) {
      case 'lobby':
        challengeId = msg.challenge?.id ?? challengeId;
        wallet.topUpIfBroke(); // на каждом lobby: кончились кредиты, пополняем до старта, экран увидит guest:wallet reason topup
        lobby = msg;
        myBet = ownAmount(msg);
        break;
      case 'bet:ok':
        myBet = Number(msg.amount) || 0;
        break;
      case 'bet:full':
        if (lobby) lobby = { ...lobby, left: Number(msg.left) || 0 };
        break;
      case 'bet:closed':
        if (lobby) lobby = { ...lobby, open: false };
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
     * Поставить против игрока. Возвращает: 'sent' | 'offline' | 'closed' (ставки закрыты) | 'full' (места нет) |
     * 'repeat' | 'invalid' | 'poor'. Ответ хоста придёт как guest:msg bet:ok {amount}, bet:full {left} или bet:closed.
     */
    bet(amount) {
      if (status !== 'open' || !link) return 'offline';
      if (!lobby || lobby.open === false) return 'closed';
      if (!(Number(lobby.left) > 0)) return 'full';
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

  /** Хост молчит слишком долго: в раунде возвращаем ставку и говорим экрану, что игрок пропал. */
  function hostSilent() {
    if (silentDone) return;
    silentDone = true;
    if (wallet.refund(challengeId, 'left')) bus.emit('guest:msg', { msg: { t: 'void', reason: 'left' } });
    const l = link;
    link = null;
    lobby = null;
    if (status === 'open') setStatus('closed', 'silent');
    try {
      l?.close?.(); // связь мертва, освобождаем её
    } catch {
      /* уже закрыто */
    }
  }

  const io = {
    setPeerId(id) {
      peerId = id;
    },
    setStatus,
    /** Соединение с игроком открылось: пополнить, если пусто, и представиться. */
    open(l) {
      link = l;
      lastHeard = now();
      silentDone = false;
      wallet.topUpIfBroke();
      l.send({ t: 'hello', name: me.name, avatar: me.avatar });
      setStatus('open');
    },
    message: onMessage,
    /** Связь закрылась (игрок закрыл страницу, пропала сеть или друг сам ушёл). Ставку вернёт тишина или следующий заход. */
    closed() {
      link = null;
      lobby = null;
      if (status !== 'error' && status !== 'closed') setStatus('closed');
    },
    /**
     * Пульс (раз в MONEY.friend.pingMs): ping хосту и проверка, слышно ли его. Возвращает false, когда следить больше
     * не за чем (связи нет и раунда нет), тогда peer.js останавливает пульс.
     */
    tick() {
      if (link) {
        try {
          link.send({ t: 'ping' });
        } catch {
          /* канал закрывается, close придёт сам */
        }
      }
      if (lastHeard != null && !silentDone && now() - lastHeard > cfg.hostSilentMs) hostSilent();
      return Boolean(link) || (wallet.open.length > 0 && !silentDone);
    },
    stream: (stream) => bus.emit('guest:stream', { stream }),
  };

  return { api, io };
}
