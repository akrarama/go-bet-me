// FRIEND: экран друга по ссылке (?join=<id>). Владелец: блок 4 (Медитация).
// Друг зритель и управляет касанием: ставит против, смотрит живое видео игрока со счётом и ошибками, видит свой итог.
//   connecting → lobby → live → result → (ждёт следующий раунд: снова lobby); void: раунд отменён, ставка вернулась.
// Данные даёт createGuest({ hostId, bus }) из friends/peer.js (блок 3): события шины guest:status, guest:msg, guest:stream
// (MediaStream или null, когда звонок кончился), guest:wallet; у гостя name, avatar, myBet, lobby, balance(), bet(), react().
// Сообщения хоста (CLAUDE.md, раздел 14.2): поле t = вид: lobby, bet:ok, bet:full, start, count, fault, rejected, end, void.
// Камеры и моделей экран не трогает (model: 'none': с null app.go взял бы модель жестов). Стили: styles/friend.css.
// Состояние чистое (reduce, betOptions, lobbyView, resultView ...): тесты идут в jsc, DOM только в enter и ниже.
// Заглушка вместо игрока: ?debug=1&join=demo (или нет peer.js в ?debug=1); клавиша f следующий шаг раунда, g ошибка игрока.

import { CHALLENGES, MONEY, STAKES } from '../config.js';
import { esc, formatTime } from '../ui.js';
import { sound } from '../sound.js';

const FEED_MAX = 3; // ошибок игрока на экране
const FEED_TTL_MS = 8000; // ошибка гаснет через столько
const SLOW_MS = 10000; // подключение тянется: подсказка
const GIVEUP_MS = 30000; // не подключились: ошибка и кнопка «Повторить»
const BET_WAIT_MS = 6000; // на ставку нет ответа: можно ставить снова
const REACT_GAP_MS = 1200; // реакция не чаще
const VIDEO_LATE_MS = 10000; // видео не пришло за это время после старта: объясняем, счёт идёт и без него
const LOST_SHOW_MS = 4000; // связь с игроком пропала посреди эфира: столько только плашка, потом карточка
const LOST_GIVEUP_MS = 30000; // игрок так и не вернулся: предлагаем обновить страницу (ставка вернётся)
const FEE = 0.1; // комиссия для заглушки: как APP_FEE в money.js
const BETS = MONEY?.friend?.bets ?? STAKES; // те же суммы принимает хост
// Что ответил guest.bet(): 'sent' ждём ответа хоста, остальное сразу объясняем словами
const BET_ANSWERS = {
  closed: 'Ставки уже закрыты',
  repeat: 'Ты уже поставил на этот раунд',
  poor: 'Не хватает кредитов',
  invalid: 'Такую ставку сделать нельзя',
  offline: 'Нет связи с игроком, попробуй ещё раз',
};

export const REACTIONS = [
  { emoji: '😏', label: 'Слабо', text: 'Слабо! 😏' },
  { emoji: '🔥', label: 'Давай', text: 'Давай! 🔥' },
  { emoji: '😱', label: 'Ого', text: 'Ого! 😱' },
];

// ─── Чистая логика ────────────────────────────────────────────

/** Число из сообщения хоста: только конечное, в разумных пределах; иначе запасное значение. */
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-1e9, Math.min(1e9, v)) : d);
/** Строка из сообщения хоста, обрезанная по числу символов (не режет эмодзи пополам). */
const clip = (v, n) => Array.from(String(v ?? '')).slice(0, n).join('');
/** Ключ из сообщения хоста ищем только среди своих полей словаря (не «constructor» и не «__proto__»). */
const own = (obj, key) => (typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : null);
const defOf = (type) => own(CHALLENGES, type);

/** 4.5 → «4,5 кр.», 5 → «5 кр.» */
export const kr = (n) => `${String(Math.round(num(n) * 10) / 10).replace('.', ',')} кр.`;

/** Русское склонение: plural(3, 'повтор', 'повтора', 'повторов') → 'повтора' */
export function plural(n, one, few, many) {
  const m = Math.abs(n) % 100;
  const d = m % 10;
  if (m > 10 && m < 20) return many;
  if (d === 1) return one;
  if (d >= 2 && d <= 4) return few;
  return many;
}

/** Цель словами: повторы или время (от двух минут считаем минутами). */
export function goalText(unit, n) {
  if (unit !== 'секунды') return `${n} ${plural(n, 'повтор', 'повтора', 'повторов')}`;
  if (n < 120) return `${n} ${plural(n, 'секунда', 'секунды', 'секунд')}`;
  const min = Math.round(n / 60);
  return `${min} ${plural(min, 'минута', 'минуты', 'минут')}`;
}

/** Как называть челлендж на экране: emoji, название, цель, лимит времени, ставка игрока. */
export function describeChallenge(ch) {
  const def = defOf(ch?.type) ?? { label: 'Челлендж', unit: '', emoji: '🎯' };
  return {
    emoji: def.emoji,
    label: def.label,
    unit: def.unit,
    goal: goalText(def.unit, num(ch?.target)),
    time: typeof ch?.limitSec === 'number' && ch.limitSec > 0 && Number.isFinite(ch.limitSec) ? formatTime(ch.limitSec) : null,
    stake: num(ch?.stake),
  };
}

function challengeOf(ch, prev = null) {
  const c = ch && typeof ch === 'object' ? ch : prev;
  if (!c) return null;
  const def = defOf(c.type);
  const lim = c.limitSec === undefined ? (def?.limitSec ?? null) : c.limitSec;
  return {
    id: clip(c.id ?? prev?.id, 40),
    type: typeof c.type === 'string' ? c.type : '',
    target: Math.max(0, num(c.target, def?.defaultTarget ?? 0)),
    limitSec: typeof lim === 'number' && Number.isFinite(lim) && lim > 0 ? lim : null,
    stake: Math.max(0, num(c.stake)),
  };
}

/** Ставки друзей из сообщения: только объекты, строки короткие, сумма числом. */
function cleanBets(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((b) => b && typeof b === 'object')
    .slice(0, 30)
    .map((b) => ({ id: clip(b.id, 40), name: clip(b.name ?? 'Друг', 24), avatar: clip(b.avatar ?? '🙂', 6), amount: Math.max(0, num(b.amount)), bot: Boolean(b.bot) }));
}

export function initialState(hostId = '') {
  return {
    hostId,
    phase: 'connecting', // connecting | error | lobby | live | result | void
    link: 'connecting', // connecting | open | lost: связь с игроком
    slow: false, // подключение тянется
    errorKind: null, // error | closed: почему не подключились
    challenge: null, // { id, type, target, limitSec, stake }
    left: 0, // сколько ещё можно поставить против (остаток пула)
    bets: [], // ставки друзей: [{ id, name, avatar, amount, bot }]
    myBet: null, // моя ставка против на этот челлендж
    pending: null, // ставка отправлена, ответа ещё нет
    notice: null, // { tone: 'ok' | 'warn', text }: ответ хоста на ставку
    balance: null, // мой баланс, кр.
    walletDelta: null,
    count: 0,
    target: 0,
    unit: '',
    startedAt: 0, // время экрана в момент start, мс
    feed: [], // ошибки игрока: [{ id, kind: 'fault' | 'rejected', text }]
    seq: 0,
    result: null, // { success, count, target, amount, delta }
    voidReason: null,
    hasVideo: false,
    videoLate: false, // видео не пришло за VIDEO_LATE_MS
    videoEnded: false, // видео шло и прервалось посреди эфира
    lostAt: null, // связь пропала посреди эфира: когда (мс экрана), пока не вернулась
    errorCode: null, // почему не подключились: timeout, peer-unavailable, lib ...
  };
}

/** Статус связи от peer.js → connecting | open | error | closed (слова у статусов могут быть разные). */
export function linkOf(status) {
  const s = String(status ?? '').toLowerCase();
  if (['open', 'connected', 'ready', 'ok'].includes(s)) return 'open';
  if (['error', 'failed', 'unavailable', 'peer-unavailable'].includes(s)) return 'error';
  if (['closed', 'close', 'disconnected', 'lost'].includes(s)) return 'closed';
  return 'connecting';
}

function onStatus(S, status, now, error) {
  const link = linkOf(status);
  if (link === 'open') return { ...S, link: 'open', slow: false, lostAt: null };
  // связь пропала посреди эфира: запоминаем когда, чтобы остановить таймер и позже показать карточку
  const lostAt = S.phase === 'live' ? (S.lostAt ?? now) : S.lostAt;
  if (link === 'connecting') return { ...S, link: 'connecting', phase: S.phase === 'error' ? 'connecting' : S.phase, lostAt };
  // связь оборвалась: пока не было условий челленджа это ошибка, потом только плашка поверх экрана
  const early = S.phase === 'connecting' || S.phase === 'error';
  return { ...S, link: 'lost', phase: early ? 'error' : S.phase, errorKind: link, errorCode: typeof error === 'string' ? clip(error, 40) : S.errorCode, lostAt };
}

/** Игрок уже в раунде, а мы только подключились: первый счёт или ошибка открывают live. */
function goLive(S, now) {
  if (S.phase !== 'connecting' && S.phase !== 'lobby') return S;
  return { ...S, phase: 'live', link: 'open', startedAt: S.startedAt || now };
}

/** Моя ставка из you.amount в lobby и start: есть, значит ставлю; you.amount 0, значит без ставки; you нет, значит не знаем. */
function myBetOf(msg, prev) {
  if (!msg.you || typeof msg.you !== 'object') return prev;
  const amount = num(msg.you.amount);
  return amount > 0 ? amount : null;
}

/** Вид сообщения хоста: строка в поле t (запасной путь type). */
const kindOf = (msg) => (typeof msg?.t === 'string' ? msg.t : typeof msg?.type === 'string' ? msg.type : null);

function onMsg(S, msg, now) {
  switch (kindOf(msg)) {
    case 'lobby': {
      const challenge = challengeOf(msg.challenge, S.challenge);
      const fresh = challenge?.id !== S.challenge?.id;
      const base = fresh ? { ...S, myBet: null, pending: null, feed: [], result: null, voidReason: null, count: 0, startedAt: 0 } : S;
      // итог или раунд не сбрасываем тем же лобби: следующий раунд приходит с новым челленджем
      const stay = !fresh && (S.phase === 'live' || S.phase === 'result' || S.phase === 'void');
      return {
        ...base,
        myBet: myBetOf(msg, base.myBet),
        challenge,
        left: Math.max(0, num(msg.left)),
        bets: cleanBets(msg.bets),
        notice: base.notice?.tone === 'ok' ? base.notice : null,
        phase: stay ? S.phase : 'lobby',
        link: 'open',
        slow: false,
      };
    }
    case 'bet:ok':
      return { ...S, myBet: Math.max(0, num(msg.amount)), pending: null, notice: { tone: 'ok', text: 'Ставка принята' } };
    case 'bet:full': {
      const left = Math.max(0, num(msg.left));
      const text = left > 0 ? `Осталось только ${kr(left)}, выбери меньше` : 'Пул уже полон, можно только смотреть';
      return { ...S, left, pending: null, notice: { tone: 'warn', text } };
    }
    case 'start': {
      const challenge = challengeOf(msg.challenge, S.challenge);
      return {
        ...S,
        myBet: myBetOf(msg, S.myBet),
        challenge,
        bets: Array.isArray(msg.bets) ? cleanBets(msg.bets) : S.bets,
        phase: 'live',
        link: 'open',
        count: 0,
        target: challenge?.target ?? S.target,
        unit: defOf(challenge?.type)?.unit ?? S.unit,
        startedAt: now,
        feed: [],
        result: null,
        voidReason: null,
        pending: null,
        notice: null,
        videoLate: false,
        videoEnded: false,
        lostAt: null,
      };
    }
    case 'count': {
      const live = goLive(S, now);
      return { ...live, count: Math.max(0, num(msg.count, live.count)), target: Math.max(0, num(msg.target, live.target)), unit: typeof msg.unit === 'string' ? clip(msg.unit, 20) : live.unit };
    }
    case 'fault':
    case 'rejected': {
      const live = goLive(S, now);
      const text = clip(msg.text, 140);
      if (!text) return live;
      const item = { id: live.seq + 1, kind: kindOf(msg), text };
      return { ...live, seq: item.id, feed: [...live.feed, item].slice(-FEED_MAX) };
    }
    case 'end': {
      const you = msg.you && typeof msg.you === 'object' ? msg.you : {};
      const result = {
        success: Boolean(msg.success),
        count: Math.max(0, num(msg.count, S.count)),
        target: Math.max(0, num(msg.target, S.target)),
        amount: Math.max(0, num(you.amount, S.myBet ?? 0)),
        delta: num(you.delta),
      };
      return { ...S, phase: 'result', pending: null, result };
    }
    case 'void':
      return { ...S, phase: 'void', pending: null, voidReason: clip(msg.reason ?? 'cancel', 30) };
    default:
      return S;
  }
}

/** Новое состояние по событию: { type: 'status' | 'msg' | 'stream' | 'wallet' | 'bet:sent' | ... }. */
export function reduce(S, ev) {
  switch (ev.type) {
    case 'status':
      return onStatus(S, ev.status, ev.now ?? 0, ev.error);
    case 'msg': {
      const next = onMsg(S, ev.msg, ev.now ?? 0);
      // гость сам считает мою принятую ставку (по списку ставок и you): ему верим больше, чем одному полю сообщения
      const known = ['lobby', 'start'].includes(kindOf(ev.msg)) && typeof ev.myBet === 'number';
      return known ? { ...next, myBet: ev.myBet > 0 ? num(ev.myBet) : null } : next;
    }
    case 'stream':
      return S.hasVideo && !S.videoLate && !S.videoEnded ? S : { ...S, hasVideo: true, videoLate: false, videoEnded: false };
    case 'stream:end': {
      const ended = S.phase === 'live';
      return !S.hasVideo && S.videoEnded === ended ? S : { ...S, hasVideo: false, videoEnded: ended };
    }
    case 'video:late':
      return S.phase === 'live' && !S.hasVideo && !S.videoEnded ? { ...S, videoLate: true } : S;
    case 'wallet':
      return { ...S, balance: typeof ev.balance === 'number' && Number.isFinite(ev.balance) ? ev.balance : S.balance, walletDelta: num(ev.delta, S.walletDelta) };
    case 'bet:sent':
      return { ...S, pending: ev.amount, notice: null };
    case 'bet:result': {
      if (ev.result === 'sent') return S;
      const text = own(BET_ANSWERS, ev.result) ?? BET_ANSWERS.offline;
      // «repeat»: ставка уже есть у хоста, показываем её, даже если ответ bet:ok потерялся
      const known = ev.result === 'repeat' && S.myBet == null && num(ev.myBet) > 0 ? num(ev.myBet) : S.myBet;
      return { ...S, pending: null, myBet: known, notice: { tone: 'warn', text } };
    }
    case 'bet:timeout':
      return S.pending == null ? S : { ...S, pending: null, notice: { tone: 'warn', text: 'Ответа нет, попробуй ещё раз' } };
    case 'retry':
      return { ...S, phase: 'connecting', link: 'connecting', slow: false };
    case 'slow':
      return S.phase === 'connecting' && S.link !== 'open' ? { ...S, slow: true } : S;
    case 'giveup':
      return S.phase === 'connecting' && S.link !== 'open' ? { ...S, phase: 'error', errorKind: 'error' } : S;
    case 'feed:drop':
      return { ...S, feed: S.feed.filter((f) => f.id !== ev.id) };
    default:
      return S;
  }
}

/** Кнопки ставки: что можно нажать с учётом остатка пула, моего баланса и уже сделанной ставки. */
export function betOptions(S, amounts = BETS) {
  return amounts.map((amount) => {
    const selected = S.myBet === amount;
    let reason = null;
    if (S.myBet != null) reason = 'placed';
    else if (S.pending != null) reason = 'pending';
    else if (amount > S.left) reason = S.left <= 0 ? 'full' : 'left';
    else if (S.balance != null && amount > S.balance) reason = 'balance';
    return { amount, selected, reason, disabled: reason != null };
  });
}

/** Подсказка под кнопками: ответ хоста, иначе почему нельзя поставить. */
export function lobbyNotice(S) {
  if (S.notice) return S.notice;
  if (S.myBet != null) return { tone: 'ok', text: 'Ставка принята' };
  if (S.challenge) {
    if (S.left <= 0) return { tone: 'warn', text: 'Пул уже полон, можно только смотреть' };
    if (S.balance != null && S.balance < Math.min(...BETS)) return { tone: 'warn', text: 'Не хватает кредитов для ставки' };
  }
  return null;
}

/** Всё, что рисует лобби. */
export function lobbyView(S) {
  const d = describeChallenge(S.challenge);
  const taken = Math.min(d.stake, Math.max(0, d.stake - S.left));
  return {
    title: `${d.emoji} ${d.label}: ${d.goal}`,
    facts: [d.time && `⏱ ${d.time}`, d.stake && `Ставка игрока ${kr(d.stake)}`].filter(Boolean),
    pool: { taken, total: d.stake, text: `${kr(taken)} из ${kr(d.stake)}`, ratio: d.stake ? taken / d.stake : 0 },
    options: betOptions(S),
    notice: lobbyNotice(S),
    foot: S.myBet != null ? `Ты поставил ${kr(S.myBet)} против. Ждём старт` : 'Игрок нажмёт старт, и ставки закроются',
  };
}

/** Таймер live: с лимитом считает назад, без лимита (медитация) вперёд. now и startedAt в мс. */
export function timerView(S, now) {
  const end = S.lostAt != null ? S.lostAt : now; // связи нет: таймер стоит, чтобы не показывать время, которого не видим
  const el = S.startedAt ? Math.max(0, (end - S.startedAt) / 1000) : 0;
  const limit = S.challenge?.limitSec;
  if (!limit) return { text: formatTime(el), low: false };
  const left = limit - el;
  return { text: formatTime(left), low: left <= 10 };
}

/** Итог раунда глазами друга. */
export function resultView(S) {
  const r = S.result;
  if (!r) return null;
  const unit = defOf(S.challenge?.type)?.unit;
  const delta = r.delta;
  const line =
    r.amount <= 0 ? 'Ты смотрел без ставки'
      : delta > 0 ? 'Ты выиграл: игрок не справился'
        : delta < 0 ? 'Ты проиграл: игрок справился'
          : 'Ставка вернулась';
  return {
    success: r.success,
    title: r.success ? 'Сделал' : 'Не сделал',
    detail: `${Math.floor(r.count)} из ${goalText(unit, r.target)}`,
    line,
    showDelta: r.amount > 0,
    deltaTone: delta > 0 ? 'up' : delta < 0 ? 'down' : 'zero',
    deltaText: `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${kr(Math.abs(delta))}`,
  };
}

const VOID_REASONS = { camera: 'У игрока пропала камера' };

/** Раунд отменён: причина и что с моей ставкой. */
export function voidView(S) {
  return {
    title: 'Раунд отменён',
    detail: own(VOID_REASONS, S.voidReason) ?? 'Игрок прервал челлендж',
    line: S.myBet != null ? 'Ставка вернулась' : 'Ты смотрел без ставки',
  };
}

/** Что показывать вместо видео игрока: ждём, не пришло, прервалось. show: false, когда видео идёт. */
export function videoView(S) {
  if (S.hasVideo) return { show: false };
  if (S.videoEnded) return { show: true, busy: false, title: 'Видео прервалось', text: 'Счёт и ошибки идут дальше' };
  if (S.videoLate) return { show: true, busy: false, title: 'Видео не приходит', text: 'Слабая связь у тебя или у игрока. Счёт и ошибки идут и без видео' };
  return { show: true, busy: true, title: 'Ждём видео игрока', text: '' };
}

/** Игрок пропал посреди эфира: сначала только плашка, потом карточка, потом предложение обновить страницу. */
export function lostView(S, now) {
  if (S.phase !== 'live' || S.lostAt == null) return null;
  const gone = now - S.lostAt;
  if (gone < LOST_SHOW_MS) return null;
  if (gone < LOST_GIVEUP_MS) {
    return { title: 'Связь с игроком пропала', text: 'Ждём игрока. Если он закрыл страницу, раунд не продолжится', reload: false };
  }
  return { title: 'Игрок не вернулся', text: 'Обнови страницу: ставка вернётся, и можно зайти снова', reload: true };
}

// Причина от peer.js (guest:status error) → что сказать другу. Типы PeerJS: peer-unavailable, network, socket-error ...
const ERROR_TEXTS = {
  'peer-unavailable': 'Игрок не нашёлся. Проверь ссылку или попроси прислать новую',
  timeout: 'Игрок не отвечает. Проверь интернет и ссылку, потом попробуй ещё раз',
  lib: 'Не загрузилась связь с игроком. Проверь интернет и попробуй ещё раз',
  network: 'Нет связи с сервером. Проверь интернет и попробуй ещё раз',
  'socket-error': 'Нет связи с сервером. Проверь интернет и попробуй ещё раз',
  'socket-closed': 'Нет связи с сервером. Проверь интернет и попробуй ещё раз',
  'server-error': 'Сервер связи сейчас не отвечает. Попробуй ещё раз чуть позже',
  'browser-incompatible': 'Этот браузер не умеет видео по ссылке. Открой ссылку в Chrome или Safari',
};

function errorText(S) {
  const byCode = own(ERROR_TEXTS, S.errorCode);
  if (byCode) return byCode;
  return S.errorKind === 'closed' ? 'Связь оборвалась. Проверь интернет и попробуй ещё раз' : 'Игрок не отвечает. Проверь ссылку или попроси прислать новую';
}

/** Текст экрана подключения по состоянию. */
export function connectView(S) {
  if (S.phase === 'error') {
    return { title: 'Не получилось подключиться', text: errorText(S), busy: false, retry: true };
  }
  return {
    title: 'Подключаюсь к игроку',
    text: S.link === 'open' ? 'Жду условия челленджа' : S.slow ? 'Долго? Проверь, что игрок не закрыл страницу' : 'Это займёт пару секунд',
    busy: true,
    retry: S.slow && S.link !== 'open',
  };
}

// ─── Экран ────────────────────────────────────────────────────

let run = null; // текущий проход экрана

const who = (guest) => ({ name: guest?.name || 'Ты', avatar: guest?.avatar || '🙂' });

const skeleton = () => `
  <div class="friend" data-phase="connecting" data-link="connecting">
    <div class="friend__link" data-link-banner hidden>Связь с игроком пропала. Обнови страницу, чтобы зайти снова</div>

    <section class="friend__view friend__view--connect">
      <div class="panel panel--narrow friend__card friend__card--center">
        <div class="spinner" data-busy></div>
        <h2 class="h2" data-connect-title></h2>
        <p class="muted" data-connect-text></p>
        <button class="friend__btn" type="button" data-retry hidden>Повторить</button>
      </div>
    </section>

    <section class="friend__view friend__view--lobby">
      <div class="panel panel--narrow friend__card">
        <div class="friend__me">
          <span class="friend__avatar" data-me-avatar></span>
          <span class="friend__me-name" data-me-name></span>
          <span class="friend__me-balance" data-me-balance></span>
        </div>
        <div class="friend__eyebrow">Игрок ставит на себя</div>
        <h2 class="friend__headline" data-ch-title></h2>
        <div class="friend__facts" data-facts></div>
        <div class="friend__pool">
          <div class="friend__pool-head"><span>Против уже</span><b data-pool-text></b></div>
          <div class="friend__pool-bar"><div class="friend__pool-fill" data-pool-fill></div></div>
          <ul class="friend__bets" data-bets></ul>
        </div>
        <div class="friend__eyebrow">Твоя ставка против</div>
        <div class="friend__bet-row" data-bet-row>
          ${BETS.map((a) => `<button class="friend__bet" type="button" data-bet="${a}"><span class="friend__bet-amount">${a}</span><span class="friend__bet-unit">кр.</span></button>`).join('')}
        </div>
        <p class="friend__notice" data-notice aria-live="polite" hidden></p>
        <p class="friend__foot" data-foot></p>
      </div>
    </section>

    <section class="friend__view friend__view--live">
      <div class="friend__video-wrap">
        <video class="friend__video" data-video autoplay playsinline muted></video>
        <div class="friend__novideo" data-novideo>
          <div class="spinner" data-nv-busy></div>
          <div class="friend__nv-icon" data-nv-icon hidden>📡</div>
          <b class="friend__nv-title" data-nv-title></b>
          <span class="friend__nv-text" data-nv-text></span>
        </div>
      </div>
      <div class="friend__hud">
        <div class="friend__top">
          <div class="chip chip--lg friend__timer" data-timer><i class="friend__dot"></i><span data-timer-text>00:00</span></div>
          <div class="chip friend__stake" data-stake></div>
        </div>
        <ul class="friend__feed" data-feed aria-live="polite"></ul>
        <div class="friend__counter">
          <div class="hud__label" data-live-label></div>
          <div class="counter" data-counter><span data-count>0</span><span class="counter__target" data-target></span></div>
          <div class="progress"><div class="progress__bar" data-progress></div></div>
        </div>
        <div class="friend__lost" data-lost hidden>
          <div class="panel friend__card friend__card--center friend__lost-card">
            <div class="friend__nv-icon">📡</div>
            <h2 class="h2" data-lost-title></h2>
            <p class="muted" data-lost-text></p>
            <button class="friend__btn" type="button" data-reload hidden>Обновить страницу</button>
          </div>
        </div>
        <div class="friend__reactions" data-reactions>
          ${REACTIONS.map((x, i) => `<button class="friend__react" type="button" data-react="${i}"><span class="friend__react-emoji">${x.emoji}</span><span class="friend__react-label">${esc(x.label)}</span></button>`).join('')}
        </div>
      </div>
    </section>

    <section class="friend__view friend__view--result">
      <div class="panel panel--narrow friend__card friend__card--center">
        <div class="friend__eyebrow" data-res-eyebrow></div>
        <h2 class="friend__verdict" data-res-title></h2>
        <p class="friend__detail" data-res-detail></p>
        <div class="friend__delta" data-res-delta hidden></div>
        <p class="friend__line" data-res-line></p>
        <div class="friend__wallet" data-res-wallet hidden><span>Твой баланс</span><b data-res-balance></b></div>
        <p class="friend__wait">Ждём следующий раунд<span class="friend__dots"><i></i><i></i><i></i></span></p>
      </div>
    </section>
  </div>`;

/** Стили экрана подключаем сами, если index.html их не подключил: экран работает и без правки страницы. */
function ensureStyles() {
  if ([...document.styleSheets].some((s) => (s.href ?? '').endsWith('/friend.css')) || document.querySelector('link[data-friend-css]')) return Promise.resolve();
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../../styles/friend.css', import.meta.url).href;
  link.dataset.friendCss = '';
  return new Promise((resolve) => {
    link.onload = link.onerror = resolve;
    setTimeout(resolve, 1500); // не дождались: рисуем как есть
    document.head.append(link);
  });
}

function collect(root) {
  const q = (s) => root.querySelector(s);
  const els = {
    friend: q('.friend'),
    banner: q('[data-link-banner]'),
    busy: q('[data-busy]'), connectTitle: q('[data-connect-title]'), connectText: q('[data-connect-text]'), retry: q('[data-retry]'),
    meAvatar: q('[data-me-avatar]'), meName: q('[data-me-name]'), meBalance: q('[data-me-balance]'),
    chTitle: q('[data-ch-title]'), facts: q('[data-facts]'), poolText: q('[data-pool-text]'), poolFill: q('[data-pool-fill]'), bets: q('[data-bets]'),
    betRow: q('[data-bet-row]'), notice: q('[data-notice]'), foot: q('[data-foot]'),
    video: q('[data-video]'), novideo: q('[data-novideo]'), nvBusy: q('[data-nv-busy]'), nvIcon: q('[data-nv-icon]'), nvTitle: q('[data-nv-title]'), nvText: q('[data-nv-text]'),
    lost: q('[data-lost]'), lostTitle: q('[data-lost-title]'), lostText: q('[data-lost-text]'), reload: q('[data-reload]'),
    timer: q('[data-timer]'), timerText: q('[data-timer-text]'), stake: q('[data-stake]'), feed: q('[data-feed]'),
    liveLabel: q('[data-live-label]'), counter: q('[data-counter]'), count: q('[data-count]'), target: q('[data-target]'), progress: q('[data-progress]'),
    reactions: q('[data-reactions]'),
    resEyebrow: q('[data-res-eyebrow]'), resTitle: q('[data-res-title]'), resDetail: q('[data-res-detail]'), resDelta: q('[data-res-delta]'),
    resLine: q('[data-res-line]'), resWallet: q('[data-res-wallet]'), resBalance: q('[data-res-balance]'),
    betBtns: {},
  };
  root.querySelectorAll('[data-bet]').forEach((b) => (els.betBtns[b.dataset.bet] = b));
  return els;
}

function paintConnect({ els, S }) {
  const v = connectView(S);
  els.connectTitle.textContent = v.title;
  els.connectText.textContent = v.text;
  els.busy.hidden = !v.busy;
  els.retry.hidden = !v.retry;
}

function paintLobby(r) {
  const { els, S } = r;
  const v = lobbyView(S);
  const me = who(r.guest);
  els.meAvatar.textContent = me.avatar;
  els.meName.textContent = me.name;
  els.meBalance.textContent = S.balance == null ? '' : kr(S.balance);
  els.chTitle.textContent = v.title;
  els.facts.innerHTML = v.facts.map((f) => `<span class="friend__fact">${esc(f)}</span>`).join('');
  els.poolText.textContent = v.pool.text;
  els.poolFill.style.transform = `scaleX(${v.pool.ratio})`;
  els.bets.innerHTML = S.bets
    .map((b) => `<li class="friend__chip"><span>${esc(b.avatar ?? '🙂')}</span><b>${esc(b.name ?? 'Друг')}</b><i>${esc(kr(b.amount))}</i></li>`)
    .join('');
  for (const o of v.options) {
    const btn = els.betBtns[o.amount];
    btn.disabled = o.disabled;
    btn.classList.toggle('is-selected', o.selected);
    btn.classList.toggle('is-pending', S.pending === o.amount);
  }
  els.notice.hidden = !v.notice;
  if (v.notice) {
    els.notice.dataset.tone = v.notice.tone;
    els.notice.textContent = v.notice.text;
  }
  els.foot.textContent = v.foot;
}

function bump(el) {
  el.classList.remove('is-bump');
  void el.offsetWidth;
  el.classList.add('is-bump');
}

function syncFeed(r) {
  const { els, S } = r;
  const ids = new Set(S.feed.map((f) => String(f.id)));
  for (const li of [...els.feed.children]) if (!ids.has(li.dataset.id)) li.remove();
  for (const f of S.feed) {
    if (els.feed.querySelector(`[data-id="${f.id}"]`)) continue;
    const li = document.createElement('li');
    li.className = 'friend__fault';
    li.dataset.id = f.id;
    li.dataset.kind = f.kind;
    li.textContent = f.kind === 'rejected' ? `Не засчитан: ${f.text}` : f.text;
    els.feed.append(li);
  }
}

function paintLost(r, now) {
  const { els } = r;
  const v = lostView(r.S, now);
  els.lost.hidden = !v;
  if (!v) return;
  els.banner.hidden = true;
  els.lostTitle.textContent = v.title;
  els.lostText.textContent = v.text;
  els.reload.hidden = !v.reload;
}

/** Раз в четверть секунды: таймер эфира и карточка «связь пропала» (она появляется по времени, а не по событию). */
function tickTimer(r) {
  if (!r.els || r.S.phase !== 'live') return;
  const now = performance.now();
  const t = timerView(r.S, now);
  r.els.timerText.textContent = t.text;
  r.els.timer.classList.toggle('is-low', t.low);
  r.els.timer.classList.toggle('is-frozen', r.S.lostAt != null);
  paintLost(r, now);
}

function paintLive(r) {
  const { els, S } = r;
  const d = describeChallenge(S.challenge);
  const count = Math.floor(S.count);
  els.liveLabel.textContent = `${d.emoji} ${d.label}`;
  if (count !== r.shownCount) {
    const up = r.shownCount >= 0 && count > r.shownCount;
    r.shownCount = count;
    els.count.textContent = count;
    els.target.textContent = `/${S.target}`;
    els.progress.style.transform = `scaleX(${S.target ? Math.min(1, count / S.target) : 0})`;
    if (up) bump(els.counter);
  }
  els.stake.textContent = S.myBet != null ? `Ты против: ${kr(S.myBet)}` : 'Смотришь без ставки';
  const nv = videoView(S);
  els.novideo.hidden = !nv.show;
  if (nv.show) {
    els.nvBusy.hidden = !nv.busy;
    els.nvIcon.hidden = nv.busy;
    els.nvTitle.textContent = nv.title;
    els.nvText.textContent = nv.text;
  }
  syncFeed(r);
  tickTimer(r);
}

function paintResult(r) {
  const { els, S } = r;
  const done = S.phase === 'result';
  const v = done ? resultView(S) : voidView(S);
  els.friend.dataset.verdict = done ? String(v.success) : 'void';
  els.resEyebrow.textContent = done ? 'Игрок' : '';
  els.resTitle.textContent = v.title;
  els.resDetail.textContent = v.detail;
  els.resLine.textContent = v.line;
  els.resDelta.hidden = !(done && v.showDelta);
  if (done && v.showDelta) {
    els.resDelta.dataset.tone = v.deltaTone;
    els.resDelta.textContent = v.deltaText;
  }
  els.resWallet.hidden = S.balance == null;
  if (S.balance != null) els.resBalance.textContent = kr(S.balance);
}

function paint(r) {
  const { els, S } = r;
  els.friend.dataset.phase = S.phase;
  els.friend.dataset.link = S.link;
  // плашка «связь пропала»; когда посреди эфира уже показана карточка, плашка не нужна
  const lostCard = S.phase === 'live' && lostView(S, performance.now()) != null;
  els.banner.hidden = !(S.link !== 'open' && S.phase !== 'connecting' && S.phase !== 'error') || lostCard;
  if (S.phase === 'connecting' || S.phase === 'error') paintConnect(r);
  else if (S.phase === 'lobby') paintLobby(r);
  else if (S.phase === 'live') paintLive(r);
  else paintResult(r);
  r.ctx.debug.set('друг', `${S.phase}, связь ${S.link}, осталось ${S.left}, ставка ${S.myBet ?? '-'}, баланс ${S.balance ?? '?'}`);
}

/** Применить событие и побочные эффекты (звуки, гашение ошибок), потом перерисовать. */
function dispatch(r, ev) {
  if (run !== r || !r.els) return;
  const prev = r.S;
  r.S = reduce(prev, ev);
  const S = r.S;
  if (S.phase !== prev.phase) {
    if (S.phase === 'live') {
      r.shownCount = -1;
      r.els.video.play?.().catch(() => {});
      const epoch = (r.liveEpoch += 1);
      r.ctx.timeout(() => r.liveEpoch === epoch && dispatch(r, { type: 'video:late' }), VIDEO_LATE_MS);
    }
    if (S.phase === 'result') {
      const v = resultView(S);
      sound.play(v.deltaTone === 'up' || (v.deltaTone === 'zero' && v.success) ? 'win' : 'lose');
    }
  }
  if (S.seq !== prev.seq) {
    const item = S.feed[S.feed.length - 1];
    if (item) {
      sound.play('error');
      r.ctx.timeout(() => dispatch(r, { type: 'feed:drop', id: item.id }), FEED_TTL_MS);
    }
  }
  paint(r);
}

function floatEmoji(btn, emoji) {
  const el = document.createElement('span');
  el.className = 'friend__float';
  el.textContent = emoji;
  btn.append(el);
  el.addEventListener('animationend', () => el.remove());
  setTimeout(() => el.remove(), 1800);
}

function attachStream(r, stream) {
  const v = r.els.video;
  try {
    if (v.srcObject !== (stream ?? null)) v.srcObject = stream ?? null;
    if (stream) v.play?.().catch(() => {});
  } catch (err) {
    console.warn('[friend] видео игрока не подключилось', err);
  }
}

/** Подсказка «долго» и ошибка «не подключились»; старая попытка после «Повторить» уже ничего не делает. */
function armTimers(r) {
  const at = (r.attempt += 1);
  r.ctx.timeout(() => r.attempt === at && dispatch(r, { type: 'slow' }), SLOW_MS);
  r.ctx.timeout(() => r.attempt === at && dispatch(r, { type: 'giveup' }), GIVEUP_MS);
}

/** Подключаем нажатия: ставка, реакция, повтор. Экран управляется касанием. */
function wire(r) {
  const { els, ctx } = r;
  els.betRow.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-bet]');
    if (!btn || btn.disabled) return;
    const amount = Number(btn.dataset.bet);
    sound.play('click');
    dispatch(r, { type: 'bet:sent', amount });
    Promise.resolve()
      .then(() => r.guest?.bet?.(amount))
      .then((result) => dispatch(r, { type: 'bet:result', result: result ?? (r.guest ? 'sent' : 'offline'), myBet: r.guest?.myBet }))
      .catch((err) => {
        console.warn('[friend] bet', err);
        dispatch(r, { type: 'bet:result', result: 'offline' });
      });
    ctx.timeout(() => dispatch(r, { type: 'bet:timeout' }), BET_WAIT_MS);
  });
  els.reactions.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-react]');
    if (!btn || btn.disabled) return;
    const reaction = REACTIONS[Number(btn.dataset.react)];
    sound.play('click');
    let sent = true;
    try {
      sent = r.guest?.react?.(reaction.text) !== false; // false: нет связи или слишком часто
    } catch (err) {
      console.warn('[friend] react', err);
    }
    btn.disabled = true;
    if (sent) floatEmoji(btn, reaction.emoji);
    ctx.timeout(() => (btn.disabled = false), REACT_GAP_MS);
  });
  els.retry.addEventListener('click', async () => {
    if (r.retrying) return;
    r.retrying = true;
    try {
      // connect() у настоящего гостя второй раз ничего не делает: старого останавливаем, берём нового
      const old = r.guest;
      if (old && old !== r.params.guest) old.stop?.();
      dispatch(r, { type: 'retry' });
      armTimers(r);
      const guest = r.params.guest ?? (await makeGuest(ctx, r.params));
      if (run !== r) return guest !== r.params.guest ? guest?.stop?.() : undefined;
      await attach(r, guest);
    } catch (err) {
      console.warn('[friend] повтор', err);
      dispatch(r, { type: 'status', status: 'error' });
    } finally {
      r.retrying = false;
    }
  });
  els.reload.addEventListener('click', () => location.reload()); // перезагрузка возвращает ставку недоигранного раунда
  els.video.addEventListener('playing', () => dispatch(r, { type: 'stream' }));
  // близкие пропорции видео и экрана: во весь экран (cover), иначе целиком с полями (contain), чтобы не срезать игрока
  const fit = () => {
    const v = els.video;
    const k = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 0;
    const view = innerWidth / innerHeight;
    els.video.dataset.fit = k && Math.abs(k - view) < 0.35 ? 'cover' : 'contain';
  };
  els.video.addEventListener('loadedmetadata', fit);
  els.video.addEventListener('resize', fit);
}

/** Подключить гостя к экрану: подтянуть то, что он уже знает, и начать соединение. */
async function attach(r, guest) {
  r.guest = guest;
  if (!guest) return dispatch(r, { type: 'status', status: 'error' });
  const balance = guest.balance?.();
  if (typeof balance === 'number') dispatch(r, { type: 'wallet', balance });
  if (guest.status) dispatch(r, { type: 'status', status: guest.status, now: performance.now() });
  if (guest.lobby) dispatch(r, { type: 'msg', msg: guest.lobby, now: performance.now(), myBet: guest.myBet });
  if (guest.stub) debugKeys(r.ctx.debug);
  try {
    await guest.connect?.();
  } catch (err) {
    console.warn('[friend] connect', err);
    dispatch(r, { type: 'status', status: 'error' });
  }
}

async function makeGuest(ctx, params) {
  if (params.guest) return params.guest;
  // ?debug=1&join=demo: посмотреть экран без настоящего игрока (заглушка играет хоста)
  if (ctx.debug.enabled && String(params.hostId ?? '').startsWith('demo')) return createStubGuest(ctx);
  try {
    const mod = await import('../friends/peer.js');
    if (typeof mod.createGuest === 'function') return mod.createGuest({ hostId: params.hostId, bus: ctx.bus });
  } catch (err) {
    console.warn('[friend] friends/peer.js недоступен', err);
  }
  return ctx.debug.enabled ? createStubGuest(ctx) : null;
}

export default {
  model: 'none',

  async enter(ctx, params = {}) {
    const r = (run = { ctx, params, S: initialState(params.hostId), guest: null, els: null, shownCount: -1, attempt: 0, liveEpoch: 0 });
    await ensureStyles();
    if (run !== r) return;
    ctx.root.innerHTML = skeleton();
    r.els = collect(ctx.root);
    wire(r);
    ctx.on('guest:status', ({ status, error }) => dispatch(r, { type: 'status', status, error, now: performance.now() }));
    ctx.on('guest:msg', ({ msg }) => dispatch(r, { type: 'msg', msg, now: performance.now(), myBet: r.guest?.myBet }));
    ctx.on('guest:stream', ({ stream }) => {
      attachStream(r, stream); // «видео идёт» скажет событие playing
      if (!stream) dispatch(r, { type: 'stream:end' });
    });
    ctx.on('guest:wallet', ({ balance, delta }) => dispatch(r, { type: 'wallet', balance, delta }));
    ctx.interval(() => tickTimer(r), 250);
    armTimers(r);
    paint(r);

    const guest = await makeGuest(ctx, params);
    if (run !== r) return guest?.stop?.();
    await attach(r, guest);
  },

  // камеры на этом экране нет, кадров не будет; пустая отрисовка, чтобы поверх ничего не рисовалось
  frame() {},
  draw() {},

  exit() {
    const r = run;
    run = null;
    if (!r) return;
    try {
      r.guest?.stop?.();
    } catch (err) {
      console.warn('[friend] stop', err);
    }
    if (r.els?.video) r.els.video.srcObject = null;
  },
};

// ─── Заглушка вместо peer.js (только ?debug=1) ────────────────

let keysReady = false;

function debugKeys(debug) {
  if (keysReady || !debug.enabled) return;
  keysReady = true;
  const stub = () => (run?.guest?.stub ? run.guest : null);
  debug.key('f', () => stub()?.step(), 'друг: следующий шаг раунда (заглушка)');
  debug.key('g', () => stub()?.fault(), 'друг: ошибка игрока (заглушка)');
}

/** Играет хоста: те же события шины, что пришлёт peer.js. Шаги раунда по клавише f. */
export function createStubGuest(ctx) {
  const bus = ctx.bus;
  const send = (msg) => bus.emit('guest:msg', { msg });
  let round = 0;
  let challenge = null;
  let left = 0;
  let bets = [];
  let mine = 0;
  let started = false;
  let count = 0;
  let step = 0;
  const lobby = () => send({ t: 'lobby', challenge, left, bets, you: { amount: mine } });
  const wallet = (delta = 0) => bus.emit('guest:wallet', { balance: stub.money, delta });
  const newRound = () => {
    round += 1;
    const type = ['squat', 'pushup', 'meditation'][(round - 1) % 3];
    const def = CHALLENGES[type];
    challenge = { id: `demo-${round}`, type, target: def.defaultTarget, limitSec: def.limitSec, stake: 10 };
    bets = [{ id: 'bot-dima', name: 'Дима', avatar: '🧔', amount: 5, bot: true }];
    left = challenge.stake - 5;
    mine = 0;
    stub.myBet = null;
    started = false;
    count = 0;
    lobby();
  };
  const finish = (success) => {
    const delta = mine ? (success ? -mine : Math.round(mine * (1 - FEE) * 10) / 10) : 0;
    stub.money += mine + delta;
    send({ t: 'end', success, count, target: challenge.target, you: { amount: mine, delta } });
    wallet(delta);
  };
  const steps = [
    () => {
      stub.money -= mine;
      started = true;
      send({ t: 'start', challenge, bets, you: { amount: mine } });
      wallet(-mine);
    },
    () => send({ t: 'count', count: (count = Math.round(challenge.target * 0.3)), target: challenge.target, unit: CHALLENGES[challenge.type].unit }),
    () => stub.fault(),
    () => send({ t: 'count', count: (count = Math.round(challenge.target * 0.6)), target: challenge.target, unit: CHALLENGES[challenge.type].unit }),
    () => send({ t: 'rejected', text: 'недостаточная глубина' }),
    () => finish(false),
    newRound,
    () => steps[0](),
    () => send({ t: 'count', count: (count = challenge.target), target: challenge.target, unit: CHALLENGES[challenge.type].unit }),
    () => finish(true),
    () => send({ t: 'void', reason: 'camera' }),
    newRound,
  ];
  const stub = {
    stub: true,
    name: 'Аня',
    avatar: '👩‍🦰',
    money: 100,
    myBet: null,
    balance: () => stub.money,
    connect() {
      bus.emit('guest:status', { status: 'connecting' });
      ctx.timeout(() => {
        bus.emit('guest:status', { status: 'open' });
        wallet();
        newRound();
      }, 700);
    },
    /** Как настоящий: 'sent' | 'closed' | 'repeat' | 'poor' | 'offline', ответ хоста придёт сообщением. */
    bet(amount) {
      if (!challenge) return 'offline';
      if (started) return 'closed';
      if (mine) return 'repeat';
      if (amount > stub.money) return 'poor';
      ctx.timeout(() => {
        if (amount > left) return send({ t: 'bet:full', left });
        left -= amount;
        mine = amount;
        stub.myBet = amount;
        bets = [...bets, { id: 'me', name: stub.name, avatar: stub.avatar, amount, bot: false }];
        send({ t: 'bet:ok', amount });
        lobby();
      }, 350);
      return 'sent';
    },
    react(text) {
      ctx.debug.log('друг: реакция', text);
    },
    stop() {},
    step() {
      steps[step % steps.length]();
      step += 1;
    },
    fault() {
      send({ t: 'fault', text: 'Колени выходят за носки, сядь глубже назад' });
    },
  };
  return stub;
}
