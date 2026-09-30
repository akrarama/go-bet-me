// Симулированные друзья (P0): ставят против в LOBBY и болтают в ленте во время LIVE.
// Владелец: блок 3 (Деньги).
//
// LOBBY: lobby.js зовёт join(challenge). Боты из MONEY.bots приходят по одному через MONEY.botDelayMs
//   и ставят против через acceptBet (кто раньше, тот и в пуле): тост + событие bet.
//   Кому не хватило места, тому «пул полон», в этот челлендж он больше не приходит.
//   Уход из LOBBY закрывает ставки: кто не успел, уже не придёт. Debug: клавиша b, все сразу.
// LIVE: говорят только боты со ставкой в этом челлендже (соло = тишина): приветствие на старте,
//   каждые MONEY.feed.repsEvery повторов (в медитации secondsEvery секунд), нервы у самой цели,
//   подкол на ошибку, обрыв камеры, реакция на финиш. Не чаще MONEY.feed.gapMs, кроме приветствий и финала.
// Лента #feed рисует любое событие comment, не только от ботов (P1: настоящие друзья).
// RESULT: reaction(botId) = что бот сказал на финише этого челленджа.
//
// Слушает: state, live:start, count, fault, rejected, camera:lost, camera:back, live:end, comment.
// Шлёт: bet {bet, challenge}, comment {from, text, avatar, id, bot}.
// Реплики и чистые помощники (LINES, FAULT_LINES, fill, pickLine, faultTheme, arrive) проверяет tests/money.test.js.

import { MONEY } from '../config.js';
import { bus } from '../bus.js';
import { acceptBet, formatCredits, plural } from '../money.js';
import { ui, esc, $ } from '../ui.js';

// ─── Реплики ────────────────────────────────────────────────────
// {а}: «а» для бота женского рода («поставил{а}» → «поставила»), для мужского пусто. Только про самого бота:
// пол игрока неизвестен, поэтому к игроку без прошедшего времени и кратких прилагательных («устал», «смог»).
// {n} счёт сейчас, {left} сколько осталось, {target} цель, {amount} ставка бота числом, {credits} она же со словом.
// all: подходят к любому типу челленджа, squat / pushup / meditation: только к своему.

export const LINES = {
  opener: {
    all: [
      'Ну давай, удиви меня',
      'Спорим, не выйдет? 😏',
      'Смотрю внимательно, не халтурь',
      'Поехали! Я в тебя не верю',
      'Я поставил{а} не просто так',
      'Удачи. Она тебе понадобится',
      'Попкорн на месте, начинай 🍿',
    ],
    squat: ['Цель {target}? Смешно', 'Ноги уже дрожат, да? 😏', 'Посмотрим, как ты приседаешь'],
    pushup: ['Цель {target}? Руки не выдержат', 'Пол уже ждёт тебя', 'Посмотрим, как ты отжимаешься'],
    meditation: ['Сидеть без телефона? Не верю', 'Главное, не усни 😴', 'Глаза закрыты? Я подглядываю 👀', 'Дыши, дыши. Я жду ошибку'],
  },
  milestone: {
    all: [
      'Уже {n}? Везёт новичкам',
      'Ещё {left}? Не дотянешь 😏',
      'Ладно, {n}. Но это пока',
      'Хм. Я всё ещё жду ошибку',
      'Не расслабляйся, я смотрю 👀',
      'Ничего, это только начало',
    ],
    squat: ['Уже {n}, ноги ещё держат?', 'Бодро приседаешь. Подозрительно 🤔'],
    pushup: ['Уже {n}, руки ещё держат?', 'Бодро отжимаешься. Подозрительно 🤔'],
    meditation: ['Тихо сидишь. Даже странно', 'Спишь там, что ли? 😴', 'Я бы уже открыл{а} глаза', 'Не шевелишься? Ну-ну', 'Скучно смотреть, если честно'],
  },
  // у самой цели, один раз за челлендж (только повторы)
  nervous: {
    all: [
      'Стоп, стоп! Так не договаривались',
      'Эй, сбавь темп, мне страшно',
      'Осталось {left}?! Я нервничаю',
      'Только не это... 😰',
      'Ну пожалуйста, ошибись',
      'Мои кредиты, не уходите!',
    ],
    squat: ['Колени, подведите, прошу'],
    pushup: ['Руки, ну сдавайтесь уже'],
  },
  // подкол на ошибку, если для неё нет своей темы в FAULT_LINES
  jab: {
    all: ['Я всё вижу 👀', 'Ой. Ну бывает', 'ИИ не обманешь 😏', 'Мои кредиты в безопасности', 'Давай-давай, ошибайся ещё', 'Так я точно выиграю'],
    squat: ['Это присед или реверанс?'],
    pushup: ['Это отжимание или поклон?'],
    meditation: ['Медитация так не работает 🙃'],
  },
  // камера пропала
  lost: {
    all: ['Эй, ты куда?', 'Алло, где ты? 👀', 'Камера пропала. Сбегаешь?', 'Эй, тебя не видно!', 'Ку-ку, ты где?', 'Прятки не считаются 😏'],
  },
  // финиш, игрок не сделал: бот выиграл свою ставку
  botWon: {
    all: [
      'Спасибо за {credits} 😎',
      'Я же говорил{а}!',
      'Лёгкие деньги, спасибо',
      'Приходи ещё, мне понравилось',
      'Не расстраивайся. Мне весело 😂',
      'Я знал{а}, что так будет',
      'Твои {credits} теперь мои',
    ],
    squat: ['Ноги подвели? Бывает 😏'],
    pushup: ['Руки подвели? Бывает 😏'],
    meditation: ['Медитация не твоё, похоже'],
  },
  // финиш, игрок сделал: бот проиграл свою ставку
  botLost: {
    all: [
      'Минус {amount}, обидно',
      'Ладно, признаю, это было круто',
      'Не может быть! 😱',
      'Честно? Не ожидал{а}',
      'Отдаю {credits}. Больно',
      'Ну ты даёшь! Реванш?',
      'Больше против тебя не ставлю',
    ],
    squat: ['Ноги из железа, что ли?'],
    pushup: ['Руки из железа, что ли?'],
    meditation: ['Спокойствие как у монаха 🧘'],
  },
};

/** Подколы по теме ошибки (раздел 6 спеки). Тему выбирает faultTheme(). */
export const FAULT_LINES = {
  knees: ['Колени уехали за носки, я вижу', 'Садись назад, как на стул', 'Коленки, вы куда? 😂', 'Колени за носками, не считается'],
  depth: ['Ниже! Это полуприсед', 'Глубже, так не считается', 'Присядь по-честному 😏', 'Бедро выше колена, я вижу'],
  straighten: ['До конца! Половинка не в счёт', 'Это была половинка, я видел{а}', 'До конца давай, не халтурь', 'Полповтора? Так не пойдёт 😏'],
  lower: ['Ниже! До пола ещё далеко', 'Грудью к полу, не ленись', 'Это кивок, а не отжимание 😂', 'Опускайся, пол не кусается'],
  hips: ['Таз гуляет, я всё вижу 👀', 'Ровнее! Тело как доска', 'Живот напряги, халтура же', 'Держи тело ровно, не хитри'],
  back: ['Спину ровно, не падай', 'Грудь вперёд, смотри прямо', 'Не кланяйся, это не концерт 😂', 'Спина уехала вперёд, я вижу'],
  tempo: ['Куда спешишь? Медленнее', 'Быстро не значит правильно', 'Не гони, я не успеваю смотреть', 'Это спорт или тряска? 😂'],
  eyes: ['Подглядываешь? Я всё вижу 👀', 'Глаза открыты, не жульничай', 'Ага, глазки открылись!', 'Закрой глаза, я же смотрю'],
  head: ['Не вертись, это медитация', 'Голова гуляет, ха', 'Замри! Как статуя 🗿', 'Сиди ровно, не качайся'],
  face: ['Эй, лицо пропало из кадра', 'Вернись в кадр, я не вижу', 'Прячешься? Не выйдет 😏'],
  second: ['Это кто там рядом? 👀', 'Подсказчики не разрешены', 'Вдвоём нечестно!', 'Друзей в кадр не зовём'],
  body: ['Отойди, тебя не видно целиком', 'Я вижу только кусочек тебя', 'Где ноги? Отойди от камеры', 'Отойди подальше, не прячься'],
};

// ─── Чистые помощники (без DOM и таймеров, тесты в jsc) ─────────

/** Пул реплик для типа челленджа: общие + свои. */
export const poolFor = (kind, type) => [...(LINES[kind]?.all ?? []), ...(LINES[kind]?.[type] ?? [])];

/** Шаблон → текст: род бота и числа. Неизвестное {имя} остаётся как есть, его ловит тест. */
export function fill(template, bot = {}, vars = {}) {
  return String(template).replace(/\{(а|\w+)\}/g, (m, key) => {
    if (key === 'а') return bot.female ? 'а' : '';
    return vars[key] != null ? String(vars[key]) : m;
  });
}

/** Числа для реплик бота: ставка числом («5») и со словом («5 кредитов», «2 кредита»), плюс extra. */
export function lineVars(bot = {}, extra = {}) {
  const amount = Number(bot.amount) || 0;
  const sum = formatCredits(amount);
  return { amount: sum, credits: `${sum} ${plural(amount, 'кредит', 'кредита', 'кредитов')}`, ...extra };
}

/**
 * Случайная реплика из пула. used: что уже сказано в этом челлендже, последнее в конце.
 * Сначала то, чего ещё не было, если было всё, то любое, кроме последнего. Нечего сказать: null.
 */
export function pickLine(pool = [], rng = Math.random, used = []) {
  const last = used[used.length - 1];
  const fresh = pool.filter((line) => !used.includes(line));
  const options = fresh.length ? fresh : pool.filter((line) => line !== last);
  if (!options.length) return null;
  return options[Math.min(options.length - 1, Math.floor(rng() * options.length))];
}

// Тема по коду и тексту ошибки. Порядок важен: «выпрями колени» не про носки, «бедро выше колена»
// это глубина, «контролируй опускание» это темп, «корпус в кадре» и «второй человек в кадре» не про лицо.
const THEMES = [
  ['second', /второй|two_face/],
  ['body', /корпус|visib|не вижу/],
  ['face', /лиц|face|кадр/],
  ['eyes', /глаз|eye/],
  ['head', /голов|head/],
  ['tempo', /быстр|темп|tempo/],
  ['lower', /опуска|half_down/],
  ['straighten', /выпрям|встань до конца|не встал|half_up|рук/],
  ['depth', /глубин|присядь ниже|shallow/],
  ['knees', /колен|носк|knee/],
  ['hips', /таз|hip/],
  ['back', /спин|наклон|lean/],
];

/** Тема подкола для fault / rejected {code, text, label}: ключ FAULT_LINES или null (общий подкол). */
export function faultTheme({ code = '', text = '', label = '' } = {}, type = '') {
  const s = `${code} ${text} ${label}`.toLowerCase();
  const theme = THEMES.find(([, re]) => re.test(s))?.[0] ?? null;
  // «недостаточная глубина» бывает и в приседаниях, и в отжиманиях
  if (theme === 'depth' && type === 'pushup') return 'lower';
  if (theme === 'lower' && type === 'squat') return 'depth';
  return theme;
}

const TOAST = {
  ok: '{name} поставил{а} {amount} против тебя',
  trimmed: '{name} поставил{а} {amount} против тебя, больше в пул не влезло',
  full: '{name} хотел{а} поставить {amount}, но пул уже полон',
};

/**
 * Бот пришёл в LOBBY и ставит против: acceptBet (ставка попадает в challenge.bets) и что показать.
 * → { status: 'ok' | 'trimmed' | 'full' | 'repeat' | 'invalid', bet, left, toast: { text, icon, tone } | null }
 */
export function arrive(challenge, bot) {
  const { id, name, avatar = '', amount } = bot;
  const r = acceptBet(challenge, { id, name, avatar, amount, bot: true, female: !!bot.female });
  const tpl = TOAST[r.status];
  const sum = formatCredits(r.bet ? r.bet.amount : amount);
  const toast = tpl ? { text: fill(tpl, bot, { name, amount: sum }), icon: avatar, tone: r.status === 'full' ? '' : 'danger' } : null;
  return { ...r, toast };
}

// ─── LOBBY: боты приходят и ставят ──────────────────────────────

let arrivals = []; // кто в пути: { bot, challenge, timer }
const turnedAway = new WeakMap(); // челлендж → id ботов, которым не хватило места в пуле

const between = ([a, b]) => a + Math.random() * (b - a);

function awayOf(challenge) {
  if (!turnedAway.has(challenge)) turnedAway.set(challenge, new Set());
  return turnedAway.get(challenge);
}

function land({ bot, challenge }) {
  const r = arrive(challenge, bot);
  if (r.status === 'full') awayOf(challenge).add(bot.id);
  if (r.toast) ui.toast(r.toast.text, { icon: r.toast.icon, tone: r.toast.tone });
  if (r.status === 'ok' || r.status === 'trimmed') bus.emit('bet', { bet: r.bet, challenge });
}

function cancelArrivals() {
  arrivals.forEach((a) => clearTimeout(a.timer));
  arrivals = [];
}

/** Debug: все, кто в пути, ставят сразу и по порядку. */
function arriveNow() {
  const list = arrivals;
  cancelArrivals();
  list.forEach(land);
}

// ─── LIVE: реплики ботов ────────────────────────────────────────

const OPENER_FIRST_MS = [600, 1800]; // первое приветствие после старта
const OPENER_NEXT_MS = [1500, 2500]; // следующий бот
const REACT_MS = [500, 1000]; // на событие бот отвечает чуть позже, как живой
const FINAL_FIRST_MS = 250; // реакция на финиш, первый бот (RESULT через APP.resultDelayMs)
const FINAL_NEXT_MS = 700; // следующий бот
// События почти вместе: скажут про более важное (незачёт важнее ошибки, нервы важнее счёта)
const RANK = { milestone: 1, nervous: 2, fault: 3, rejected: 4, lost: 5 };

let live = null; // текущий LIVE: кто говорит и что уже сказано
const timers = new Set(); // таймеры реплик LIVE, снимаются при уходе с экрана
const reactions = new Map(); // id бота → реплика на финише

function later(fn, ms) {
  const id = setTimeout(() => {
    timers.delete(id);
    fn();
  }, ms);
  timers.add(id);
}

function hush() {
  timers.forEach(clearTimeout);
  timers.clear();
}

function begin(challenge) {
  hush();
  reactions.clear();
  const speakers = (challenge?.bets ?? []).filter((b) => b.bot);
  live = {
    ch: challenge,
    bots: speakers,
    used: [], // шаблоны, сказанные в этом челлендже
    lastAt: -Infinity, // последняя реплика
    jabAt: -Infinity, // последний подкол
    mark: 0, // сколько раз уже отмечали счёт
    nervous: false,
    lost: false,
    pending: null, // реплика ждёт своей очереди: { kind, make }
    over: false,
    turn: Math.floor(Math.random() * speakers.length), // боты говорят по очереди
  };
}

/** Реплика бота из пула: не повторяет только что сказанное, род и числа подставлены. */
function line(bot, pool, extra = {}) {
  const tpl = pickLine(pool, Math.random, live.used);
  if (!tpl) return null;
  live.used.push(tpl);
  return fill(tpl, bot, lineVars(bot, { target: live.ch.target, ...extra }));
}

function speak(bot, text) {
  if (!text) return;
  live.lastAt = Date.now();
  bus.emit('comment', { from: bot.name, text, avatar: bot.avatar, id: bot.id, bot: true });
}

/**
 * Реакция на событие: чуть позже и не чаще MONEY.feed.gapMs. Пока реплика ждёт, более важное
 * событие её заменяет. make(bot) → текст или null (передумал).
 */
function react(kind, make) {
  if (!live?.bots.length || live.over) return;
  const waiting = live.pending;
  if (waiting && RANK[kind] < RANK[waiting.kind]) return;
  live.pending = { kind, make };
  if (waiting) return;
  const wait = Math.max(between(REACT_MS), live.lastAt + MONEY.feed.gapMs - Date.now());
  later(() => {
    const { make: say } = live.pending;
    live.pending = null;
    if (Date.now() - live.lastAt < MONEY.feed.gapMs) return; // между делом успело прозвучать приветствие
    const bot = live.bots[live.turn++ % live.bots.length];
    speak(bot, say(bot));
  }, wait);
}

function onStart({ challenge }) {
  begin(challenge);
  let at = 0;
  live.bots.forEach((bot, i) => {
    at += between(i ? OPENER_NEXT_MS : OPENER_FIRST_MS);
    later(() => speak(bot, line(bot, poolFor('opener', challenge.type))), at);
  });
}

function onCount({ count, target, unit }) {
  if (!live || count >= target) return; // на самой цели скажут реакцию на финиш
  const seconds = unit === 'секунды';
  const mark = Math.floor(count / (seconds ? MONEY.feed.secondsEvery : MONEY.feed.repsEvery));
  const milestone = mark > live.mark;
  live.mark = Math.max(live.mark, mark);
  const vars = { n: count, left: target - count };
  const type = live.ch.type;
  if (!seconds && vars.left <= 2 && !live.nervous) {
    react('nervous', (bot) => {
      live.nervous = true;
      return line(bot, poolFor('nervous', type), vars);
    });
  } else if (milestone) {
    react('milestone', (bot) => line(bot, poolFor('milestone', type), vars));
  }
}

function onJab(kind) {
  return (payload) => {
    if (!live || Date.now() - live.jabAt < MONEY.feed.faultCooldownMs) return;
    react(kind, (bot) => {
      live.jabAt = Date.now();
      const theme = faultTheme(payload, live.ch.type);
      return line(bot, theme ? FAULT_LINES[theme] : poolFor('jab', live.ch.type));
    });
  };
}

function onLost() {
  if (!live) return;
  live.lost = true;
  react('lost', (bot) => (live.lost ? line(bot, poolFor('lost', live.ch.type)) : null));
}

function onEnd({ session, challenge }) {
  const ch = challenge ?? live?.ch;
  if (!ch) return;
  if (live?.ch !== ch) begin(ch); // финиш без старта (debug во время отсчёта)
  hush();
  live.pending = null;
  live.over = true;
  const pool = poolFor(session?.success ? 'botLost' : 'botWon', ch.type);
  live.bots.forEach((bot, i) => {
    const text = line(bot, pool);
    reactions.set(bot.id, text);
    later(() => speak(bot, text), FINAL_FIRST_MS + i * FINAL_NEXT_MS);
  });
}

function onState({ from, to }) {
  if (from === 'LOBBY' && to !== 'LOBBY') cancelArrivals(); // Старт: ставки закрыты
  if (from === 'LIVE' || to === 'LIVE') {
    hush();
    live = null;
  }
  if (to === 'LIVE') feed?.replaceChildren();
}

// ─── Лента #feed ────────────────────────────────────────────────

const LEAVE_MS = 400; // пузырь уходит за 0.35 с (styles/money.css)
let feed = null;

/** Пузырь из события comment {from, text, avatar}: так же покажутся и настоящие друзья (P1). */
function post({ from = '', text = '', avatar = '' } = {}) {
  if (!feed || !text) return;
  const el = document.createElement('div');
  el.className = 'feed__msg';
  el.innerHTML = `
    <span class="feed__avatar" aria-hidden="true">${esc(avatar || '💬')}</span>
    <div class="feed__body">
      ${from ? `<div class="feed__name">${esc(from)}</div>` : ''}
      <div class="feed__text">${esc(text)}</div>
    </div>`;
  feed.append(el);
  fit();
  setTimeout(() => leave(el), MONEY.feed.ttlMs);
}

/** Не больше MONEY.feed.max пузырей и не выше самой ленты: лишние старые уходят. */
function fit() {
  const shown = [...feed.children].filter((el) => !el.classList.contains('is-out')).reverse();
  const gap = parseFloat(getComputedStyle(feed).rowGap) || 0;
  let room = feed.clientHeight;
  shown.forEach((el, i) => {
    room -= el.offsetHeight + (i ? gap : 0);
    if (i >= MONEY.feed.max || (i && room < 0)) leave(el);
  });
}

/** Гаснет и схлопывается. Высота из auto в px (--h), чтобы схлопывание шло плавно. */
function leave(el) {
  if (!el.isConnected || el.classList.contains('is-out')) return;
  el.style.setProperty('--h', `${el.offsetHeight}px`);
  void el.offsetHeight;
  el.classList.add('is-out');
  setTimeout(() => el.remove(), LEAVE_MS);
}

export const bots = {
  /** Один раз при запуске (main.js): лента, реплики в LIVE, отмена ставок на Старте, debug-клавиша. */
  init(ctx) {
    feed = $('#feed');
    bus.on('comment', post);
    bus.on('state', onState);
    bus.on('live:start', onStart);
    bus.on('count', onCount);
    bus.on('fault', onJab('fault'));
    bus.on('rejected', onJab('rejected'));
    bus.on('camera:lost', onLost);
    bus.on('camera:back', () => {
      if (live) live.lost = false;
    });
    bus.on('live:end', onEnd);
    ctx.debug.key('b', () => ctx.app.state === 'LOBBY' && arriveNow(), 'боты: поставить сразу');
  },

  /** LOBBY: боты, которые ещё не ставили и не получили «пул полон», идут ставить по одному. */
  join(challenge) {
    cancelArrivals();
    const away = awayOf(challenge);
    let at = 0;
    arrivals = MONEY.bots
      .filter((b) => !away.has(b.id) && !challenge.bets?.some((x) => x.id === b.id))
      .map((bot) => {
        at += between(MONEY.botDelayMs);
        const a = { bot, challenge };
        a.timer = setTimeout(() => {
          arrivals = arrivals.filter((x) => x !== a);
          land(a);
        }, at);
        return a;
      });
  },

  /** Что бот сказал на финише текущего челленджа (для RESULT), null если ничего. */
  reaction(botId) {
    return reactions.get(botId) ?? null;
  },
};
