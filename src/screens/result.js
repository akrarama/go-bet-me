// RESULT: итог челленджа. Владелец: блок 3 (Деньги).
// Сделал / не сделал, счёт (повторы или секунды медитации), время, ошибки с количеством, сводка
// незасчитанных повторов, расчёт кредитов по каждому участнику, баланс. 👍 или кнопка «Ещё раз» → SETUP.
//
// Деньги: при входе wallet.settle(session.challengeId) применяет расчёт, ровно один раз: повторный вход
// показывает ту же запись и второй раз не платит. Раунда нет (прыжок клавишами отладки): предпросмотр
// money.settle() по app.challenge с пометкой «Ставка не списывалась».
// Слушает: gesture (Thumb_Up). Ничего не шлёт.
//
// Чистые помощники (TEXT, shortLabel, faultItems, rejectedSummary, reasonText, ledgerRows) идут в тестах в jsc,
// поэтому DOM только внутри функций. VOID берёт отсюда ledgerRow, amount, balanceLine, ctaButton, armCta, sayLater.

import { CHALLENGES } from '../config.js';
import { esc, formatTime } from '../ui.js';
import { settle, formatCredits, formatFee, plural, toCents, fromCents } from '../money.js';
import { wallet } from '../wallet.js';
import { bots } from '../friends/bots.js';

const GUARD_MS = 1200; // кнопка и 👍 оживают не сразу: жест, который ещё держат после LIVE, не пролистает итоги
const VOICE_MS = 400; // озвучка через столько после входа
const COUNT_MS = 700; // докрутка чисел
const COUNT_DELAY_MS = 250; // числа крутятся, когда строки уже появляются

/** Тексты экрана. Тест проверяет, что в них нет длинного и среднего тире. */
export const TEXT = {
  win: 'Сделал',
  lose: 'Не сделал',
  reason: { target: 'Цель выполнена', time: 'Время вышло', lives: 'Жизни закончились', failed: 'Челлендж провален' },
  time: 'Время',
  of: (n) => `из ${n}`,
  faults: 'Ошибки',
  clean: 'Без ошибок',
  times: (n, label) => `${n} × ${label}`,
  rejected: (n) => `${n} ${plural(n, 'незасчитанный', 'незасчитанных', 'незасчитанных')}`,
  money: 'Расчёт',
  you: 'Ты',
  app: 'Приложение',
  stake: (x) => `ставка ${formatCredits(x)} кр.`,
  against: (x) => `против ${formatCredits(x)} кр.`,
  full: 'пул был полон',
  fee: (f, open = 0) => `комиссия ${formatFee(f)}${toCents(open) > 0 ? ` и незакрытые ${formatCredits(open)} кр.` : ''}`,
  soloWin: 'Никто не поставил против, ставка вернулась',
  soloLose: 'Никто не поставил против, ставка ушла создателям',
  unit: 'кр.',
  balance: 'Баланс',
  change: (x) => (toCents(x) ? `${formatCredits(x, { sign: true })} за челлендж` : 'без изменений'),
  preview: 'Ставка не списывалась',
  again: 'Ещё раз',
  empty: 'Итогов пока нет',
  emptyText: 'Пройди челлендж, и здесь появится расчёт',
  home: 'В начало',
  /** Озвучка итога игрока: «Плюс 9 кредитов», «Минус 10 кредитов», ноль: «Ставка вернулась». */
  voice(x) {
    const c = toCents(x);
    if (!c) return 'Ставка вернулась';
    const n = fromCents(Math.abs(c));
    return `${c > 0 ? 'Плюс' : 'Минус'} ${formatCredits(n)} ${plural(n, 'кредит', 'кредита', 'кредитов')}`;
  },
};

// ─── Чистые помощники (тесты в jsc) ─────────────────────────────

// короткая подпись: до первого двоеточия или запятой (и на всякий случай до тире, «;», «!», «?» и конца фразы)
const CUT = /[:,;!?—–]|\.(?=\s|$)/;

/** «Недостаточная глубина: бедро выше колена, присядь ниже» → «Недостаточная глубина». lower: внутри фразы, с маленькой. */
export function shortLabel(text, { lower = false } = {}) {
  const full = String(text ?? '').trim();
  const label = full.split(CUT)[0].trim() || full;
  return lower ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

/** Подпись ошибки или незасчитанного повтора внутри фразы: label, если есть, иначе начало text. */
const labelOf = (item) => shortLabel(item.label || item.text, { lower: true });

/** Ошибки для списка: [{ code, label, count, text: '3 × недостаточная глубина' }], чаще выше. */
export function faultItems(faults) {
  return (faults ?? [])
    .filter((f) => f?.count > 0)
    .map((f) => {
      const label = labelOf(f);
      return { code: f.code, label, count: f.count, text: TEXT.times(f.count, label) };
    })
    .sort((a, b) => b.count - a.count);
}

/** '4 незасчитанных: 3 × недостаточная глубина, 1 × таз провис'. Ничего не отклонено: ''. */
export function rejectedSummary(rejected) {
  const list = rejected ?? [];
  if (!list.length) return '';
  const groups = new Map(); // code → { label (по первому повтору с этим кодом), count }
  for (const r of list) {
    const key = r.code ?? r.text;
    if (!groups.has(key)) groups.set(key, { label: labelOf(r), count: 0 });
    groups.get(key).count += 1;
  }
  const parts = [...groups.values()].sort((a, b) => b.count - a.count).map((g) => TEXT.times(g.count, g.label));
  return `${TEXT.rejected(list.length)}: ${parts.join(', ')}`;
}

/** Строка под заголовком. forced-success / forced-fail (клавиши отладки) как обычный успех / провал. */
export function reasonText(session) {
  if (session?.success) return TEXT.reason.target;
  if (session?.reason === 'time') return TEXT.reason.time;
  if (session?.reason === 'failed' && session.type === 'meditation') return TEXT.reason.lives;
  return TEXT.reason.failed;
}

/**
 * Строки расчёта из settlement (форма money.settle): игрок, друзья, приложение.
 * Соло: только игрок, под ним одна фраза, куда ушла ставка. reaction(id): реплика бота на финише или null.
 * → [{ kind: 'you' | 'friend' | 'app', avatar, name, detail, quote, delta }]
 */
export function ledgerRows(st, { avatar = '', reaction = () => null } = {}) {
  const rows = [{ kind: 'you', avatar, name: TEXT.you, detail: TEXT.stake(st.player.stake), quote: null, delta: st.player.delta }];
  if (st.solo) return rows;
  for (const f of st.friends) {
    const detail = f.full ? TEXT.full : TEXT.against(f.amount);
    rows.push({ kind: 'friend', avatar: f.avatar, name: f.name, detail, quote: reaction(f.id) || null, delta: f.delta });
  }
  rows.push({ kind: 'app', avatar: '', name: TEXT.app, detail: TEXT.fee(st.fee, st.creators.uncovered), quote: null, delta: st.creators.delta });
  return rows;
}

// ─── Разметка (общая с VOID) ────────────────────────────────────

const tone = (x) => (toCents(x) > 0 ? 'is-up' : toCents(x) < 0 ? 'is-down' : 'is-zero');

const FORMAT = {
  int: (v) => String(Math.round(v)),
  time: (v) => formatTime(v),
  credits: (v) => formatCredits(v),
  sign: (v) => formatCredits(v, { sign: true }),
};

/** Число, которое докручивается (countUp) от from до to в формате fmt. */
const num = (to, fmt, from = 0) => `<span data-from="${esc(from)}" data-to="${esc(to)}" data-fmt="${esc(fmt)}">${esc(FORMAT[fmt](from))}</span>`;

/** Сумма справа в строке расчёта: html числа + «кр.». */
export const amount = (html, cls) => `<span class="ledger__amount ${esc(cls)}">${html}<span class="ledger__unit">${esc(TEXT.unit)}</span></span>`;

/** Строка расчёта: аватар, имя, пояснение, реплика; right: разметка суммы справа (amount). */
export function ledgerRow({ kind, avatar, name, detail, quote }, i, right) {
  const face = kind === 'app' ? '<span class="ledger__logo"></span>' : esc(avatar);
  return `
    <li class="ledger__row is-${esc(kind)}" style="--i: ${i}">
      <span class="ledger__avatar" aria-hidden="true">${face}</span>
      <span class="ledger__who">
        <span class="ledger__name">${esc(name)}</span>
        ${detail ? `<span class="ledger__detail">${esc(detail)}</span>` : ''}
        ${quote ? `<span class="ledger__quote">«${esc(quote)}»</span>` : ''}
      </span>
      ${right}
    </li>`;
}

/** «Баланс 109 кр.» (число докручивается от from) и справа изменение или пометка. mood: цвет пометки. */
export function balanceLine(to, { from = to, note = '', mood = 'is-zero' } = {}) {
  return `
    <div class="balance-line">
      <span>
        <span class="balance-line__label">${esc(TEXT.balance)}</span>
        <span class="balance-line__value">${num(to, 'credits', from)}<span class="balance-line__unit">${esc(TEXT.unit)}</span></span>
      </span>
      ${note ? `<span class="balance-line__note ${esc(mood)}">${esc(note)}</span>` : ''}
    </div>`;
}

/** Кнопка «👍 …» для пальца-курсора. Выключена, пока armCta её не оживит. */
export const ctaButton = (text) =>
  `<button class="btn btn--primary wait-cta" type="button" data-dwell data-cta disabled><span aria-hidden="true">👍</span>${esc(text)}</button>`;

/** Кнопка [data-cta] и жест 👍 ведут дальше (go), но только через GUARD_MS после входа и один раз. */
export function armCta(ctx, go) {
  const btn = ctx.root.querySelector('[data-cta]');
  let ready = false;
  const next = () => {
    if (!ready) return;
    ready = false;
    go();
  };
  btn?.addEventListener('click', next);
  ctx.on('gesture', ({ name }) => name === 'Thumb_Up' && next());
  ctx.timeout(() => {
    ready = true;
    if (btn) btn.disabled = false;
  }, GUARD_MS);
}

/** Сказать через delay мс. Если ещё звучит прошлая фраза (итог LIVE), дождаться её, но не дольше 3 с. */
export function sayLater(ctx, text, delay = VOICE_MS) {
  const until = performance.now() + delay + 3000;
  const attempt = () => {
    if (globalThis.speechSynthesis?.speaking && performance.now() < until) ctx.timeout(attempt, 200);
    else ctx.feedback.say(text);
  };
  ctx.timeout(attempt, delay);
}

let pass = 0; // номер входа на экран: докрутка чисел прошлого входа останавливается

/** Числа [data-to] идут от data-from до data-to, ease-out. prefers-reduced-motion: сразу итог. */
function countUp(root, my) {
  const items = [...root.querySelectorAll('[data-to]')].map((el) => ({
    el,
    from: Number(el.dataset.from ?? 0),
    to: Number(el.dataset.to),
    fmt: FORMAT[el.dataset.fmt] ?? FORMAT.int,
  }));
  // скрытая вкладка не крутит кадры: там сразу итог, иначе на экране так и останутся нули
  const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.hidden;
  // от performance.now(), а не от метки кадра: та бывает раньше или отстаёт (виртуальное время)
  const t0 = performance.now() + COUNT_DELAY_MS;
  const step = () => {
    if (my !== pass) return;
    const k = still ? 1 : Math.min(1, Math.max(0, (performance.now() - t0) / COUNT_MS));
    const e = 1 - (1 - k) ** 3;
    for (const { el, from, to, fmt } of items) el.textContent = fmt(k < 1 ? Math.round(from + (to - from) * e) : to);
    if (k < 1) requestAnimationFrame(step);
  };
  if (!items.length) return;
  if (still) step();
  else requestAnimationFrame(step);
}

// ─── Экран ──────────────────────────────────────────────────────

function renderEmpty(ctx) {
  ctx.root.innerHTML = `
    <div class="panel panel--narrow result-empty">
      <h2 class="h2">${esc(TEXT.empty)}</h2>
      <p class="muted">${esc(TEXT.emptyText)}</p>
      ${ctaButton(TEXT.home)}
    </div>`;
  armCta(ctx, () => ctx.app.go('IDLE'));
}

function faultsHtml(faults, rejected) {
  const list = faults.length
    ? `<div class="result__label">${esc(TEXT.faults)}</div>
       <ul class="result__faults">${faults
         .map((f, i) => `<li class="result__fault" style="--i: ${i}"><span class="result__fault-count">${esc(f.count)} ×</span> <span>${esc(f.label)}</span></li>`)
         .join('')}</ul>`
    : `<p class="result__clean"><span class="result__clean-icon" aria-hidden="true">✓</span>${esc(TEXT.clean)}</p>`;
  return `${list}${rejected ? `<p class="result__rejected">${esc(rejected)}</p>` : ''}`;
}

export default {
  model: 'gesture',

  enter(ctx) {
    const my = ++pass;
    const s = ctx.app.session;
    if (!s) return renderEmpty(ctx);
    const ch = ctx.app.challenge;
    const def = CHALLENGES[s.type] ?? CHALLENGES[ch.type];
    const res = wallet.settle(s.challengeId); // выплата здесь, один раз
    const paid = res && !res.settlement.voided ? res : null; // отменённый раунд (только отладка) показываем как предпросмотр
    const st = paid?.settlement ?? settle({ stake: ch.stake, bets: ch.bets, success: s.success });
    const rows = ledgerRows(st, { avatar: def.emoji, reaction: (id) => bots.reaction?.(id) });
    const fmt = def.unit === 'секунды' ? 'time' : 'int';
    const change = paid ? fromCents(toCents(paid.round.balanceAfter) - toCents(paid.round.balanceBefore)) : 0;
    const balance = paid
      ? balanceLine(paid.round.balanceAfter, { from: paid.round.balanceBefore, note: TEXT.change(change), mood: tone(change) })
      : balanceLine(wallet.balance, { note: TEXT.preview });

    ctx.root.innerHTML = `
      <div class="panel result ${s.success ? 'is-success' : 'is-fail'}">
        <section class="result__main">
          <h1 class="result__title">${esc(s.success ? TEXT.win : TEXT.lose)}</h1>
          <p class="result__reason">${esc(reasonText(s))}</p>
          <div class="result__stats">
            <div class="result__stat" style="--i: 0">
              <div class="result__stat-label">${esc(`${def.emoji} ${def.label}`)}</div>
              <div class="result__stat-value">${num(s.count, fmt)} <span class="result__stat-of">${esc(TEXT.of(FORMAT[fmt](s.target)))}</span></div>
            </div>
            <div class="result__stat" style="--i: 1">
              <div class="result__stat-label">${esc(TEXT.time)}</div>
              <div class="result__stat-value">${esc(formatTime(s.durationSec))}</div>
            </div>
          </div>
          <div class="result__section">${faultsHtml(faultItems(s.faults), rejectedSummary(s.rejected))}</div>
        </section>
        <section class="result__side">
          <div class="result__label">${esc(TEXT.money)}</div>
          <ul class="ledger">${rows.map((r, i) => ledgerRow(r, i, amount(num(r.delta, 'sign'), tone(r.delta)))).join('')}</ul>
          ${st.solo ? `<p class="result__note">${esc(st.success ? TEXT.soloWin : TEXT.soloLose)}</p>` : ''}
          <div class="result__foot">
            ${balance}
            ${ctaButton(TEXT.again)}
          </div>
        </section>
      </div>`;

    countUp(ctx.root, my);
    armCta(ctx, () => ctx.app.go('SETUP'));
    if (paid) sayLater(ctx, TEXT.voice(st.player.delta));
  },

  exit() {
    pass += 1;
  },
};
