// Протокол «друг по ссылке» (P1): что летит по data channel между игроком (хост) и другом (гость).
// Владелец: блок 3 (Деньги). Чистые функции без DOM и PeerJS, тесты в jsc (tests/friends.test.js).
//
// Каждое сообщение это JSON-объект с полем t (по каналу идёт строка JSON, serialization 'raw').
//   друг → хост:  hello {name, avatar} | bet {amount} | react {text} | ping {}
//   хост → друг:  lobby {challenge, left, bets, you, open, note}
//                   при подключении, при каждом изменении пула и когда хост входит в LOBBY, LIVENESS или SETUP
//                   open: true, пока идут ставки (хост в LOBBY); note: 'starting' (игрок в LIVENESS, ставки закрыты
//                   на секунды) | 'setup' (игрок вернулся в настройки) | null
//                 bet:ok {amount}         ставка принята (в пуле именно столько)
//                 bet:full {left}         ставки идут, но места нет (пул полон или ставка больше остатка)
//                 bet:closed {}           ставки сейчас закрыты (хост не в LOBBY)
//                 start {challenge, bets, you}   Старт: ставки закрыты, у друга списывается ставка
//                 count {count, target, unit} | fault {text, code} | rejected {text, code}
//                 end {success, count, target, you}   итог, you: {amount, delta} расчёт этого друга
//                 void {reason}           отмена, всем возврат; reason 'left' у друга, если игрок пропал
//                 ping {}                 «я здесь»
// challenge: {id, type, target, limitSec, stake}. bets: [{id, name, avatar, amount, bot}].
// you: в lobby и start {amount} (ставка этого друга, 0 если не ставил), в end {amount, delta}.
// Ставка друга в challenge.bets: id = 'peer:<peerId>', bot = false.
//
// Пульс. Обе стороны шлют ping раз в MONEY.friend.pingMs (5 с); любое сообщение считается «жив».
//   Хост не слышал друга MONEY.friend.friendSilentMs (15 с): друг отключён (friend:leave). Друг, ушедший до финиша
//   (закрыл вкладку, телефон погас, пропала связь), выходит из раунда: в LOBBY его ставка снимается (bet:cancel),
//   в LIVE снимается из расчёта хоста без выплаты и комиссии (bet:withdrawn), на RESULT хоста строка «ушёл,
//   ставка возвращена», а на его устройстве ставка вернётся сама (при следующем заходе).
//   Друг не слышал хоста MONEY.friend.hostSilentMs (20 с): если в раунде, ставка возвращается в его кошельке,
//   экран получает msg {t: 'void', reason: 'left'}, а связь считается потерянной (guest:status closed, error 'silent').

import { MONEY } from '../config.js';
import { toCents, fromCents } from '../money.js';

export const BET_PREFIX = 'peer:';
export const betId = (peerId) => `${BET_PREFIX}${peerId}`;
export const isPeerBet = (bet) => String(bet?.id ?? '').startsWith(BET_PREFIX);
export const peerIdOf = (id) => String(id).slice(BET_PREFIX.length);

// управляющие символы и угловые скобки: экран всё равно экранирует, но в ленту незачем пускать мусор
const JUNK = /[\u0000-\u001f\u007f<>]/g;

/** Строка от чужого устройства: без управляющих символов, в одну строку, не длиннее max символов (эмодзи не рвём). */
export function cleanText(value, max) {
  const s = String(value ?? '').replace(JUNK, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('').trim() : s;
}

export const cleanName = (v) => cleanText(v, MONEY.friend.nameMax) || MONEY.friend.defaultName;
/** Аватар только из MONEY.friend.avatars: чужой текст и эмодзи вне списка заменяются на аватар по умолчанию. */
export const cleanAvatar = (v) => (MONEY.friend.avatars.includes(v) ? v : MONEY.friend.defaultAvatar);

/**
 * То, что пришло по каналу → объект. По каналу идёт строка JSON (serialization 'raw'), а сюда её
 * приводим сами и в try: чужие данные не должны ронять страницу. Длинное, битое и не объект: null.
 */
export function parseWire(data) {
  try {
    if (typeof data === 'string') {
      if (data.length > MONEY.friend.maxWireChars) return null;
      const obj = JSON.parse(data);
      return obj && typeof obj === 'object' ? obj : null;
    }
    return data && typeof data === 'object' && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer) ? data : null;
  } catch {
    return null;
  }
}

/** Сообщение друга → хосту, проверенное и очищенное (data уже объект, см. parseWire). Чужое, битое или лишнее: null. */
export function parseFriendMsg(data) {
  if (!data || typeof data !== 'object') return null;
  switch (data.t) {
    case 'hello':
      return { t: 'hello', name: cleanName(data.name), avatar: cleanAvatar(data.avatar) };
    case 'bet': {
      if (typeof data.amount !== 'number') return null;
      const cents = toCents(data.amount);
      return cents > 0 ? { t: 'bet', amount: fromCents(cents) } : null;
    }
    case 'react': {
      const text = cleanText(data.text, MONEY.friend.reactMax);
      return text ? { t: 'react', text } : null;
    }
    case 'ping':
      return { t: 'ping' };
    default:
      return null;
  }
}

const HOST_TYPES = new Set(['lobby', 'bet:ok', 'bet:full', 'bet:closed', 'start', 'count', 'fault', 'rejected', 'end', 'void', 'ping']);

/** Сообщение хоста → другу. Экран читает поля сам, здесь только проверка, что это наше сообщение. */
export function parseHostMsg(data) {
  if (!data || typeof data !== 'object' || !HOST_TYPES.has(data.t)) return null;
  return data;
}

/** Челлендж для друга: только то, что нужно показать. */
export const pubChallenge = (ch) => ({
  id: ch.id,
  type: ch.type,
  target: ch.target,
  limitSec: ch.limitSec ?? null,
  stake: ch.stake,
});

/** Ставки против для друга: без чужих служебных полей. */
export const pubBets = (bets = []) =>
  bets.map((b) => ({ id: b.id, name: b.name ?? '', avatar: b.avatar ?? '', amount: b.amount, bot: !!b.bot }));
