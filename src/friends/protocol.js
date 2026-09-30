// Протокол «друг по ссылке» (P1): что летит по data channel между игроком (хост) и другом (гость).
// Владелец: блок 3 (Деньги). Чистые функции без DOM и PeerJS, тесты в jsc (tests/friends.test.js).
//
// Каждое сообщение это JSON-объект с полем t.
//   друг → хост:  hello {name, avatar} | bet {amount} | react {text}
//   хост → друг:  lobby {challenge, left, bets, you}   при подключении и при каждом изменении пула
//                 bet:ok {amount, requested?}          ставка принята (requested: хотел больше, влезло меньше)
//                 bet:full {left}                      места в пуле нет или ставки закрыты
//                 start {challenge, bets, you}         Старт: ставки закрыты, у друга списывается ставка
//                 count {count, target, unit} | fault {text, code} | rejected {text, code}
//                 end {success, count, target, you}    итог, you: {amount, delta} расчёт этого друга
//                 void {reason}                        отмена, всем возврат
// challenge: {id, type, target, limitSec, stake}. bets: [{id, name, avatar, amount, bot}].
// you: в lobby и start {amount} (ставка этого друга, 0 если не ставил), в end {amount, delta}.
// Ставка друга в challenge.bets: id = 'peer:<peerId>', bot = false.

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
    default:
      return null;
  }
}

const HOST_TYPES = new Set(['lobby', 'bet:ok', 'bet:full', 'start', 'count', 'fault', 'rejected', 'end', 'void']);

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
