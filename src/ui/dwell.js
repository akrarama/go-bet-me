// Палец-курсор и dwell-клик. Владелец: блок 2 (Жесты).
//
// Слушает cursor {x, y, visible} из шины (его шлёт vision/gestures.js), рисует курсор в #cursor,
// находит под ним [data-dwell] внутри #screen, заполняет кольцо и через GESTURES.dwellMs
// вызывает el.click(). Кнопки на экранах: <button class="btn" data-dwell>.
//
// Кнопке под пальцем: класс .is-hover и --dwell (0..1); при клике .is-dwell-click на ~450 мс.
// После клика та же кнопка заблокирована, пока палец с неё не уйдёт. После смены экрана dwell
// ждёт GESTURES.dwellSettleMs (кнопки въезжают), а кнопка под неподвижным пальцем не нажмётся.
// Отладка (?debug=1): клавиша m = мышь работает как палец.
//
// Чистая логика (createOneEuro2D, createDweller) без DOM: её гоняют тесты в jsc.

import { GESTURES } from '../config.js';
import { sound } from '../sound.js';

// ─── One Euro: сглаживание курсора ──────────────────────────────

/**
 * One Euro filter для точки: в покое сильно гасит дрожание, в движении почти без задержки.
 * Одна частота среза на обе оси, от скорости в px/с. t в мс. Первая точка проходит как есть.
 */
export function createOneEuro2D(opts = GESTURES.cursorFilter) {
  const { minCutoff = 1, beta = 0, dCutoff = 1 } = opts;
  const alpha = (cutoff, dt) => {
    const r = 2 * Math.PI * cutoff * dt;
    return r / (r + 1);
  };
  let s = null; // { x, y, dx, dy, t }

  return {
    filter(x, y, t) {
      if (!s) {
        s = { x, y, dx: 0, dy: 0, t };
        return { x, y };
      }
      const dt = (t - s.t) / 1000;
      if (!(dt > 0)) return { x: s.x, y: s.y };
      const ad = alpha(dCutoff, dt);
      s.dx += ad * ((x - s.x) / dt - s.dx);
      s.dy += ad * ((y - s.y) / dt - s.dy);
      const a = alpha(minCutoff + beta * Math.hypot(s.dx, s.dy), dt);
      s.x += a * (x - s.x);
      s.y += a * (y - s.y);
      s.t = t;
      return { x: s.x, y: s.y };
    },
    reset() {
      s = null;
    },
  };
}

// ─── Dwell: наведение и клик ────────────────────────────────────

const inside = (p, r, pad) => p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;

/**
 * Чистая логика dwell.
 * dweller.update(pos | null, targets, t) → { target, progress, click, blocked }
 *   pos: {x, y} в px или null (курсора нет); targets: [{ el, x, y, w, h, disabled }]
 *   target: элемент под пальцем или null; progress 0..1; click: элемент, который нажать сейчас
 * dweller.settle(t)  смена экрана; dweller.reset()
 */
export function createDweller(opts = GESTURES) {
  let cur = null; // элемент под пальцем
  let hoverSince = 0;
  let block = null; // { el, x, y, w, h }: только что нажатая кнопка (или та, что оказалась под пальцем)
  let settleUntil = -Infinity;
  let blockNext = false;

  const snap = (tg) => ({ el: tg.el, x: tg.x, y: tg.y, w: tg.w, h: tg.h });

  function hit(pos, targets) {
    if (!pos) return null;
    if (cur) {
      // текущую кнопку держим, пока палец в её зоне с запасом dwellLeavePad
      const keep = targets.find((tg) => tg.el === cur);
      if (keep && !keep.disabled && inside(pos, keep, opts.dwellLeavePad)) return keep;
    }
    let best = null;
    let bestD = Infinity;
    for (const tg of targets) {
      if (tg.disabled || !inside(pos, tg, opts.dwellPad)) continue;
      const d = Math.hypot(pos.x - (tg.x + tg.w / 2), pos.y - (tg.y + tg.h / 2));
      if (d < bestD) {
        best = tg;
        bestD = d;
      }
    }
    return best;
  }

  return {
    update(pos, targets, t) {
      if (t < settleUntil) {
        cur = null;
        return { target: null, progress: 0, click: null, blocked: false };
      }
      const tg = hit(pos, targets);
      if (blockNext) {
        // первый кадр после смены экрана: кнопка под неподвижным пальцем не нажмётся
        blockNext = false;
        block = tg ? snap(tg) : null;
      }
      const el = tg ? tg.el : null;
      if (el !== cur) {
        cur = el;
        hoverSince = t;
      }
      // блок снимается, когда палец ушёл из зоны нажатой кнопки (или пропал)
      if (block && block.el !== el && (!pos || !inside(pos, block, opts.dwellLeavePad))) block = null;
      if (!el) return { target: null, progress: 0, click: null, blocked: false };
      if (block) return { target: el, progress: 0, click: null, blocked: true };
      const progress = Math.min(1, Math.max(0, (t - Math.max(hoverSince, settleUntil)) / opts.dwellMs));
      if (progress < 1) return { target: el, progress, click: null, blocked: false };
      block = snap(tg);
      return { target: el, progress: 1, click: el, blocked: false };
    },

    settle(t) {
      settleUntil = t + opts.dwellSettleMs;
      blockNext = true;
      cur = null;
      block = null;
    },

    reset() {
      cur = null;
      hoverSince = 0;
      block = null;
      settleUntil = -Infinity;
      blockNext = false;
    },
  };
}

// ─── Курсор на экране (браузер) ─────────────────────────────────

const EASE_MS = 35; // показанная точка догоняет сглаженную с такой постоянной времени
const SILENT_MS = 400; // нет событий cursor столько: прячем
const CLICK_MS = 450;
const MOUSE_REPEAT_MS = 100; // debug: мышь стоит, а «кадры руки» идут

const filter = createOneEuro2D();
const dweller = createDweller();
let ctx = null;
let root = null;
let cursorEl = null;
let shown = false;
let goal = null; // сглаженная точка
const disp = { x: 0, y: 0 }; // показанная точка
const drawn = { x: NaN, y: NaN, p: -1, visible: false, hover: false, blocked: false };
let lastSample = -Infinity;
let hideAt = Infinity;
let lastFrame = 0;
let hoverEl = null;
let hoverP = ''; // последнее --dwell, записанное кнопке
let popUntil = 0; // до этого времени кольцо после клика показываем полным (оно разлетается)
const mouse = { on: false, inside: false, x: 0, y: 0, sentAt: 0 };
const pulses = new WeakMap();

export const dwell = {
  target: null,
  progress: 0,

  /** Один раз из main.js. */
  start(context) {
    if (ctx) return;
    ctx = context;
    root = ctx.root;
    cursorEl = document.getElementById('cursor');
    if (!cursorEl) return console.warn('[dwell] нет #cursor');
    cursorEl.innerHTML = `
      <div class="cursor__body">
        <svg class="cursor__ring" viewBox="0 0 64 64" aria-hidden="true">
          <circle class="cursor__track" cx="32" cy="32" r="27" pathLength="1"></circle>
          <circle class="cursor__fill" cx="32" cy="32" r="27" pathLength="1"></circle>
        </svg>
        <div class="cursor__dot"></div>
      </div>`;
    cursorEl.hidden = false;
    cursorEl.style.setProperty('--p', '0');

    ctx.bus.on('cursor', onCursor);
    // не ctx.on: такие подписки снимаются при каждой смене экрана
    ctx.bus.on('state', () => {
      dweller.settle(performance.now());
      setHover(null);
      dwell.target = null;
      dwell.progress = 0;
    });
    if (ctx.debug.enabled) debugMouse();

    lastFrame = performance.now();
    requestAnimationFrame(loop);
  },
};

function onCursor(e) {
  const now = performance.now();
  if (e?.visible && Number.isFinite(e.x) && Number.isFinite(e.y)) {
    if (!shown) {
      // появился после паузы: сразу на место, без плавного переезда со старой точки
      filter.reset();
      goal = filter.filter(e.x, e.y, now);
      disp.x = goal.x;
      disp.y = goal.y;
      shown = true;
    } else goal = filter.filter(e.x, e.y, now);
    lastSample = now;
    hideAt = Infinity;
  } else if (shown && hideAt === Infinity) hideAt = now + GESTURES.cursorGraceMs;
}

function targets() {
  const list = [];
  for (const el of root.querySelectorAll('[data-dwell]')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    list.push({ el, x: r.left, y: r.top, w: r.width, h: r.height, disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' });
  }
  return list;
}

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = Math.min(100, Math.max(0, now - lastFrame));
  lastFrame = now;

  if (mouse.on && mouse.inside && now - mouse.sentAt >= MOUSE_REPEAT_MS) sendMouse(now);
  if (shown && (now >= hideAt || now - lastSample > SILENT_MS)) shown = false;
  if (shown) {
    const k = 1 - Math.exp(-dt / EASE_MS);
    disp.x += (goal.x - disp.x) * k;
    disp.y += (goal.y - disp.y) * k;
  }

  const r = dweller.update(shown ? disp : null, shown ? targets() : [], now);
  setHover(r.target);
  if (hoverEl) {
    const v = r.progress.toFixed(3);
    if (v !== hoverP) hoverEl.style.setProperty('--dwell', (hoverP = v));
  }
  dwell.target = r.target;
  dwell.progress = r.progress;
  render(r, now);
  if (r.click) click(r.click, now);
}

function setHover(el) {
  if (el === hoverEl) return;
  if (hoverEl) {
    hoverEl.classList.remove('is-hover');
    hoverEl.style.removeProperty('--dwell');
  }
  hoverEl = el;
  hoverP = '';
  if (el) el.classList.add('is-hover');
}

function render(r, now) {
  const c = cursorEl;
  if (shown !== drawn.visible) c.classList.toggle('is-visible', (drawn.visible = shown));
  const hover = shown && !!r.target;
  if (hover !== drawn.hover) c.classList.toggle('is-hover', (drawn.hover = hover));
  const blocked = hover && r.blocked;
  if (blocked !== drawn.blocked) c.classList.toggle('is-blocked', (drawn.blocked = blocked));
  if (shown && (Math.abs(disp.x - drawn.x) > 0.05 || Math.abs(disp.y - drawn.y) > 0.05 || Number.isNaN(drawn.x))) {
    drawn.x = disp.x;
    drawn.y = disp.y;
    c.style.transform = `translate3d(${disp.x.toFixed(1)}px, ${disp.y.toFixed(1)}px, 0)`;
  }
  const pop = now < popUntil && (r.blocked || !r.target);
  const p = pop ? 1 : Math.round(r.progress * 1000) / 1000;
  if (p !== drawn.p) {
    drawn.p = p;
    c.style.setProperty('--p', String(p));
  }
}

/** Класс на короткую анимацию: снять, перезапустить, снять через ms. */
function pulse(el, cls, ms = CLICK_MS) {
  clearTimeout(pulses.get(el));
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  pulses.set(el, setTimeout(() => el.classList.remove(cls), ms));
}

function click(el, now) {
  popUntil = now + CLICK_MS;
  pulse(el, 'is-dwell-click');
  pulse(cursorEl, 'is-click');
  try {
    if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(12);
  } catch {
    /* без вибрации */
  }
  sound.play('click'); // звук включает main.js после первого касания
  try {
    el.click();
  } catch (err) {
    console.error('[dwell] click', err);
  }
}

// ─── Отладка: мышь = палец ──────────────────────────────────────

function sendMouse(now) {
  mouse.sentAt = now;
  ctx.bus.emit('cursor', { x: mouse.x, y: mouse.y, visible: true, source: 'mouse' });
}

function mouseGone() {
  mouse.inside = false;
  if (mouse.on) ctx.bus.emit('cursor', { visible: false, source: 'mouse' });
}

function debugMouse() {
  globalThis.__dwell = dwell;
  addEventListener('mousemove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.inside = true;
    if (mouse.on) sendMouse(performance.now());
  }, { passive: true });
  document.documentElement.addEventListener('mouseleave', mouseGone);
  addEventListener('blur', mouseGone);
  ctx.debug.key('m', () => {
    mouse.on = !mouse.on;
    ctx.ui.toast(mouse.on ? 'Мышь работает как палец' : 'Мышь выключена', { icon: '🖱️' });
    if (!mouse.on) ctx.bus.emit('cursor', { visible: false, source: 'mouse' });
    else if (mouse.inside) sendMouse(performance.now());
  }, 'мышь = палец (dwell)');
}
