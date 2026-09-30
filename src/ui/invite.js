// Приглашение друга в LOBBY (P1): QR, короткая ссылка, «Смотрят: N». Владелец: блок 2 (Жесты).
//
// Слушает события шины от src/friends/peer.js (блок 3), подписка живёт с загрузки страницы,
// поэтому экран LOBBY видит ссылку, даже если она пришла до его открытия или он открыт повторно:
//   peer:ready {id, url}                 ссылка для друга есть → в LOBBY карточка приглашения
//   peer:error {error}                   облако недоступно → карточки нет, всё как в P0 (боты)
//   friend:join {id, name, avatar}       друг подключился: «Смотрят: N» растёт
//   friend:leave {id}                    друг ушёл: N падает
// Ставка друга приходит обычным событием bet (bet.bot = false, bet.id = 'peer:<id>'): betRow() готовит для
// списка ставок строку и отличает её от бота. Имя и аватар приходят по сети: режем длину, экранирует экран.
//
// Чистая логика (createInvite, attachInvite, shortLink, qrSvg, betRow) без DOM: её гоняют тесты в jsc.
// Библиотека QR (qrcode-generator, CDN) грузится лениво script-тегом, только когда пришёл peer:ready.

import { GESTURES } from '../config.js';
import { bus } from '../bus.js';

const NAME_DEFAULT = 'Друг';
const AVATAR_DEFAULT = '🙂';

/** Имя друга: без лишних пробелов, не длиннее GESTURES.invite.nameMax символов, пустое → «Друг». */
export function cleanName(name, max = GESTURES.invite.nameMax) {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, max).join('') || NAME_DEFAULT;
}

/** Аватар: эмодзи (до 8 знаков с учётом составных), пустой → 🙂. */
export function cleanAvatar(avatar) {
  return Array.from(String(avatar ?? '').trim()).slice(0, 8).join('') || AVATAR_DEFAULT;
}

/** Только http(s) без пробелов: из этого рисуем QR и показываем ссылку. */
export function cleanUrl(url) {
  const s = typeof url === 'string' ? url.trim() : '';
  return /^https?:\/\/\S+$/i.test(s) ? s : null;
}

/**
 * Ссылка для показа: без https:// и без длинного хвоста id.
 * shortLink('https://a.github.io/go-bet-me/?join=123e4567-e89b-12d3-a456-426614174000') → 'a.github.io/go-bet-me/?join=123e…000'
 */
export function shortLink(url, keep = 8) {
  const s = String(url ?? '').trim().replace(/^https?:\/\/(www\.)?/i, '');
  return s.replace(/([?&]join=)([^&#\s]+)/, (m, key, id) => (id.length > keep + 3 ? `${key}${id.slice(0, keep - 3)}…${id.slice(-3)}` : m));
}

// ─── Состояние приглашения ──────────────────────────────────────

/**
 * Хранилище: есть ли ссылка и кто из друзей на связи.
 * store.on / .url / .id / .count / .friends; store.subscribe(fn) → отписка; fn(store) на каждое изменение.
 * ready({id, url}) · fail() · join({id, name, avatar}) · leave({id}).
 */
export function createInvite() {
  let link = null; // { id, url }
  const friends = new Map(); // id → { id, name, avatar }
  const subs = new Set();
  const notify = () => {
    for (const fn of [...subs]) {
      try {
        fn(store);
      } catch (err) {
        console.error('[invite]', err);
      }
    }
  };

  const store = {
    get on() {
      return link !== null;
    },
    get url() {
      return link ? link.url : null;
    },
    get id() {
      return link ? link.id : null;
    },
    get count() {
      return friends.size;
    },
    get friends() {
      return [...friends.values()];
    },

    /** Пришла ссылка. Без нормального http(s) адреса игнорируем. Новый id = новый хост: прежние друзья отвалились. */
    ready(payload) {
      const url = cleanUrl(payload?.url);
      if (!url) return;
      const id = String(payload?.id ?? url);
      if (link && link.id !== id) friends.clear();
      link = { id, url };
      notify();
    },

    /** peer:error: карточки нет, друзей тоже. */
    fail() {
      if (!link && !friends.size) return;
      link = null;
      friends.clear();
      notify();
    },

    join(payload) {
      if (payload?.id == null) return;
      const id = String(payload.id);
      friends.set(id, { id, name: cleanName(payload.name), avatar: cleanAvatar(payload.avatar) });
      notify();
    },

    leave(payload) {
      if (payload?.id == null) return;
      if (friends.delete(String(payload.id))) notify();
    },

    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
  return store;
}

/** Подписывает хранилище на события шины. → функция «отписать». */
export function attachInvite(eventBus, store) {
  const offs = [
    eventBus.on('peer:ready', (p) => store.ready(p)),
    eventBus.on('peer:error', () => store.fail()),
    eventBus.on('friend:join', (p) => store.join(p)),
    eventBus.on('friend:leave', (p) => store.leave(p)),
  ];
  return () => offs.forEach((off) => off?.());
}

/** Общее хранилище приглашения: живёт с загрузки страницы. */
export const invite = createInvite();
attachInvite(bus, invite);

// ─── Ставки друзей в списке LOBBY ───────────────────────────────

/**
 * Строка списка ставок из события bet. link: ставка настоящего друга по ссылке (bet.bot = false
 * или id вида 'peer:<id>'), бот всегда link = false.
 */
export function betRow(bet) {
  const id = String(bet?.id ?? '');
  const link = bet?.bot !== true && (bet?.bot === false || id.startsWith('peer:'));
  const amount = Number(bet?.amount);
  return { id, name: cleanName(bet?.name), avatar: cleanAvatar(bet?.avatar), amount: Number.isFinite(amount) ? amount : 0, link };
}

// ─── QR ─────────────────────────────────────────────────────────

/**
 * SVG-картинка QR для текста text. factory: window.qrcode из qrcode-generator (у неё addData, make, getModuleCount, isDark).
 * Модули рисуются одним <path> (подряд идущие тёмные клетки склеены), тихая зона quiet модулей внутри viewBox.
 * Цвета задаёт CSS (fill у svg). Не вышло (слишком длинный текст, сбой библиотеки) → null.
 */
export function qrSvg(factory, text, { level = 'M', quiet = 2 } = {}) {
  try {
    const qr = factory(0, level);
    qr.addData(String(text));
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) {
      let run = 0;
      for (let c = 0; c <= n; c++) {
        if (c < n && qr.isDark(r, c)) run++;
        else if (run) {
          d += `M${c - run} ${r}h${run}v1h-${run}z`;
          run = 0;
        }
      }
    }
    const size = n + quiet * 2;
    return `<svg viewBox="${-quiet} ${-quiet} ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR-код приглашения"><path d="${d}"/></svg>`;
  } catch {
    return null;
  }
}

let qrLib = null; // Promise библиотеки, пока грузится
const svgCache = new Map(); // url → svg

/** Библиотека QR из CDN: script-тег один раз, без ответа за GESTURES.invite.qrLoadMs → null (карточка без QR). */
export function loadQr({ src = GESTURES.invite.qrUrl, timeoutMs = GESTURES.invite.qrLoadMs } = {}) {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (typeof window.qrcode === 'function') return Promise.resolve(window.qrcode);
  if (qrLib) return qrLib;
  qrLib = new Promise((resolve) => {
    const script = document.createElement('script');
    let timer = 0;
    const done = (ok) => {
      clearTimeout(timer);
      script.onload = script.onerror = null;
      if (!ok) {
        script.remove();
        qrLib = null; // в следующий раз попробуем снова
      }
      resolve(ok && typeof window.qrcode === 'function' ? window.qrcode : null);
    };
    timer = setTimeout(() => done(false), timeoutMs);
    script.src = src;
    script.async = true;
    script.onload = () => done(true);
    script.onerror = () => done(false);
    document.head.appendChild(script);
  });
  return qrLib;
}

/** Готовая картинка для url, если уже рисовали. */
export const qrCached = (url) => svgCache.get(url) ?? null;

/** QR для url: из кэша или после ленивой загрузки библиотеки. → Promise<string | null> */
export function qrFor(url) {
  const hit = svgCache.get(url);
  if (hit) return Promise.resolve(hit);
  return loadQr().then((factory) => {
    const svg = factory ? qrSvg(factory, url) : null;
    if (svg) svgCache.set(url, svg);
    return svg;
  });
}
