// Друг по ссылке (P1), сеть: PeerJS с CDN, публичное облако, своего сервера нет. Владелец: блок 3 (Деньги).
//   installHost({ bus, app, camera })   у игрока, один раз при запуске; сам ждёт первого LOBBY
//   createGuest({ hostId, bus })        у друга (страница ?join=<id>); guest.connect() начинает
// Логика живёт в host.js и guest.js (тесты в jsc), здесь только сеть: ленивая загрузка библиотеки,
// Peer, соединения, звонок с видео. Облако недоступно: peer:error, и всё работает как раньше.
//
// Событие шины от хоста:
//   peer:pending {}                    начали грузить PeerJS (боты оставляют место друзьям)
//   peer:ready {id, url, friends}      ссылка готова; повторяется на каждом входе в LOBBY, friends: сколько смотрят
//   peer:error {error, recoverable?}   облако недоступно или пропало (карточки приглашения нет)
//   friend:join / friend:leave / bet / bet:cancel / comment: см. host.js
// Канал: строки JSON (serialization 'raw'), их разбираем сами в try: чужие данные не роняют страницу.

import { MONEY } from '../config.js';
import { createHostCore } from './host.js';
import { createGuestCore } from './guest.js';
import { createGuestWallet } from './guest-wallet.js';
import { parseWire } from './protocol.js';
import { ui as appUi } from '../ui.js';

// ─── Загрузка библиотек ─────────────────────────────────────────

const loading = new Map();

/** Подключить скрипт с CDN один раз и вернуть window[globalName]. Ошибку можно повторить: неудача не запоминается. */
export function loadScript(src, globalName) {
  if (globalThis[globalName]) return Promise.resolve(globalThis[globalName]);
  if (!loading.has(src)) {
    loading.set(
      src,
      new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.async = true;
        el.onload = () => (globalThis[globalName] ? resolve(globalThis[globalName]) : reject(new Error(`${globalName} не появился`)));
        el.onerror = () => {
          el.remove();
          loading.delete(src);
          reject(new Error(`не загрузился ${src}`));
        };
        document.head.append(el);
      }),
    );
  }
  return loading.get(src);
}

export const loadPeerJS = () => loadScript(MONEY.peer.lib, 'Peer');
/** Для карточки в LOBBY (блок 2): window.qrcode из qrcode-generator. */
export const loadQrCode = () => loadScript(MONEY.peer.qr, 'qrcode');

// ─── Мелочи ─────────────────────────────────────────────────────

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // без похожих 0/o, 1/l/i

/** Короткий id игрока для ссылки: pr-k4m9xa. */
export function makeId(rng = Math.random) {
  let s = MONEY.peer.idPrefix;
  for (let i = 0; i < MONEY.peer.idLength; i++) s += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  return s;
}

/** Ссылка для друга: адрес этой страницы + ?join=<id>. */
export function joinUrl(id, loc = globalThis.location) {
  return `${loc.origin}${loc.pathname}?join=${encodeURIComponent(id)}`;
}

function browserStorage() {
  try {
    const s = globalThis.localStorage;
    s.setItem('protiv:probe', '1');
    s.removeItem('protiv:probe');
    return s;
  } catch {
    return null; // приватный режим или запрет: кошелёк друга в памяти
  }
}

/** Ключ кошелька друга: свой, не пересекается с кошельком игрока даже на одном устройстве. */
function friendKey() {
  const dir = globalThis.location?.pathname?.replace(/[^/]*$/, '') ?? '';
  return dir ? `${MONEY.friend.storageKey}@${dir}` : MONEY.friend.storageKey;
}

const warn = (...args) => globalThis.console?.warn?.('[peer]', ...args);

// ─── Хост: игрок ────────────────────────────────────────────────

/**
 * Игрок принимает друзей. Вызвать один раз из main.js. Peer создаётся на первом входе в LOBBY
 * и живёт до закрытия страницы. ui (тосты «Лиса ставит 5 кр.»), Peer, loader, location можно подменить (тесты).
 * → { stop(), get id, get url, get status, get watching }
 */
export function installHost({ bus, app, camera, ui = appUi, Peer: PeerClass = null, loader = loadPeerJS, location: loc = globalThis.location } = {}) {
  const core = createHostCore({
    bus,
    app,
    getStream: () => camera?.stream ?? null,
    toast: ui?.toast ? (text, opts) => ui.toast(text, opts) : null,
  });
  const cfg = MONEY.peer;

  let peer = null;
  let phase = 'idle'; // idle | loading | up | failed | stopped
  let id = '';
  let url = '';
  let tries = 0; // неудачных запусков
  let idTries = 0;
  let reconnects = 0;
  let reconnectTimer = 0;

  const readyPayload = () => ({ id, url, friends: core.watching });

  function fail(error, err) {
    if (phase === 'stopped') return;
    phase = 'failed';
    tries += 1;
    try {
      peer?.destroy();
    } catch {
      /* уже закрыт */
    }
    peer = null;
    if (err) warn(error, err);
    bus.emit('peer:error', { error: String(error) });
  }

  function scheduleReconnect() {
    if (phase !== 'up' || reconnects >= cfg.reconnectTries) return;
    reconnects += 1;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (peer && !peer.destroyed && peer.disconnected) peer.reconnect();
    }, cfg.reconnectMs);
  }

  function onConnection(conn) {
    const fid = conn.peer;
    const link = {
      // по raw-каналу идёт строка, по любому другому (чужой клиент) объект
      send: (msg) => conn.send(conn.serialization === 'raw' ? JSON.stringify(msg) : msg),
      call: (stream) => {
        const mc = peer.call(fid, stream);
        mc.on?.('error', (e) => warn('call', e));
        return { close: () => mc.close() };
      },
      close: () => conn.close(),
    };
    conn.on('open', () => core.attach(fid, link));
    conn.on('data', (data) => core.receive(fid, data));
    conn.on('close', () => core.detach(fid, link));
    conn.on('error', (e) => warn('conn', e));
  }

  function open(Peer) {
    try {
      peer = new Peer(makeId(), { debug: 0 });
    } catch (err) {
      return fail('peer', err);
    }
    const mine = peer;
    peer.on('open', (pid) => {
      if (peer !== mine) return;
      id = pid;
      url = joinUrl(pid, loc);
      phase = 'up';
      reconnects = 0;
      bus.emit('peer:ready', readyPayload());
    });
    peer.on('connection', onConnection);
    peer.on('disconnected', () => {
      if (peer === mine) scheduleReconnect();
    });
    peer.on('error', (err) => {
      if (peer !== mine) return;
      const type = err?.type ?? 'unknown';
      if (type === 'unavailable-id' && idTries < cfg.idTries) {
        idTries += 1;
        try {
          mine.destroy();
        } catch {
          /* уже закрыт */
        }
        return open(Peer);
      }
      if (phase !== 'up') return fail(type, err);
      // связь с облаком пропала: ссылка не принимает новых друзей, пока не вернёмся
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(type)) {
        bus.emit('peer:error', { error: type, recoverable: true });
        return scheduleReconnect();
      }
      warn(type, err); // peer-unavailable (друг уже ушёл), webrtc и прочее: игру не трогаем
    });
  }

  async function start() {
    phase = 'loading';
    bus.emit('peer:pending', {});
    let Peer = PeerClass;
    if (!Peer) {
      try {
        Peer = await loader();
      } catch (err) {
        return fail('lib', err);
      }
    }
    if (phase === 'stopped') return;
    open(Peer);
  }

  bus.on('state', ({ to } = {}) => {
    if (to !== 'LOBBY' || phase === 'stopped') return;
    if (phase === 'up') bus.emit('peer:ready', readyPayload()); // LOBBY открывается заново: ссылка та же
    else if (phase === 'idle' || (phase === 'failed' && tries < cfg.libTries)) start();
  });
  if (app.state === 'LOBBY') start(); // включили уже в LOBBY (отладка ?state=LOBBY)

  globalThis.addEventListener?.('pagehide', () => peer?.destroy?.());

  return {
    get id() {
      return id;
    },
    get url() {
      return url;
    },
    get status() {
      return phase;
    },
    get watching() {
      return core.watching;
    },
    stop() {
      phase = 'stopped';
      clearTimeout(reconnectTimer);
      core.dispose();
      try {
        peer?.destroy();
      } catch {
        /* уже закрыт */
      }
      peer = null;
    },
  };
}

/** То же, под именем из спеки (раздел 14.2). */
export const createHost = installHost;

// ─── Гость: друг ────────────────────────────────────────────────

/**
 * Друг по ссылке. guest.connect() соединяется с хостом и представляется (hello).
 * name, avatar: если не переданы, случайные из MONEY.friend.guests. Всё остальное в шину: см. guest.js.
 * → { name, avatar, id, status, lobby, myBet, balance(), bet(amount), react(text), connect(), stop() }
 */
export function createGuest({ hostId, bus, name, avatar, Peer: PeerClass = null, loader = loadPeerJS, wallet = null, storage } = {}) {
  const w = wallet ?? createGuestWallet({ storage: storage === undefined ? browserStorage() : storage, key: friendKey() });
  const { api, io } = createGuestCore({ bus, wallet: w, name, avatar });

  let peer = null;
  let conn = null;
  let call = null;
  let timer = 0;
  let stopped = false;

  const fail = (error, err) => {
    clearTimeout(timer);
    if (err) warn(error, err);
    io.setStatus('error', error);
    try {
      peer?.destroy();
    } catch {
      /* уже закрыт */
    }
  };

  function wire(c) {
    c.on('open', () => {
      clearTimeout(timer);
      io.open({ send: (msg) => c.send(JSON.stringify(msg)) });
    });
    c.on('data', (data) => io.message(parseWire(data)));
    c.on('close', () => io.closed());
    c.on('error', (err) => {
      if (api.status !== 'open') fail(err?.type ?? 'connection', err);
    });
  }

  api.connect = async function connect() {
    if (peer || stopped) return;
    io.setStatus('connecting');
    timer = setTimeout(() => api.status !== 'open' && fail('timeout'), MONEY.friend.connectTimeoutMs);
    let Peer = PeerClass;
    if (!Peer) {
      try {
        Peer = await loader();
      } catch (err) {
        return fail('lib', err);
      }
    }
    if (stopped) return;
    peer = new Peer(undefined, { debug: 0 });
    peer.on('open', (pid) => {
      io.setPeerId(pid);
      conn = peer.connect(hostId, { reliable: true, serialization: 'raw' });
      wire(conn);
    });
    peer.on('call', (incoming) => {
      try {
        call?.close();
      } catch {
        /* уже закрыт */
      }
      call = incoming;
      incoming.answer(); // без своего видео: только смотрим
      incoming.on('stream', (stream) => io.stream(stream));
      incoming.on('close', () => io.stream(null));
      incoming.on('error', (e) => warn('call', e));
    });
    peer.on('error', (err) => {
      if (api.status === 'open') return warn(err?.type, err); // уже на связи: одиночный сбой не рвёт
      fail(err?.type ?? 'unknown', err);
    });
  };

  api.stop = function stop() {
    stopped = true;
    clearTimeout(timer);
    for (const close of [() => call?.close(), () => conn?.close(), () => peer?.destroy()]) {
      try {
        close();
      } catch {
        /* уже закрыт */
      }
    }
    io.closed();
  };

  return api;
}
