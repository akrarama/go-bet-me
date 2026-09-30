// Медитация. Владелец: блок 4 (Медитация).
// Таймер (count, секунды) идёт, только пока в кадре одно лицо, глаза закрыты и голова неподвижна.
// Нарушения (раздел 6 спеки), каждое: минус жизнь, подсказка текстом и звуком ошибки, событие fault:
//   лица нет ≥ 2 с; второе лицо ≥ 1 с; глаза открыты ≥ 2 с;
//   голова двигается: нос сместился больше чем на 4% ширины кадра за 1 с (держится 400 мс или 8 кадров).
// Первые 5 с после старта нарушения не считаются. Одно и то же нарушение не списывает жизни подряд, пока его не исправили
// (условия нет 1 с, и это видно: лицо в кадре), но если оно висит дольше persistMs (12 с), списывает ещё жизнь, и так до
// провала: лимита времени у медитации нет, без этого игрок, ушедший из кадра, держал бы LIVE бесконечно. За persistWarnMs (6 с)
// подсказка предупреждает «иначе минус жизнь». После нарушения 3 с на исправление:
// другое нарушение за это время ждёт и списывает жизнь, только если его так и не исправили.
// Подсказка нового нарушения 1.5 с держится поверх старых: каждая списанная жизнь со своей причиной.
// 0 жизней: failed (через 1.5 с, чтобы подсказку успели увидеть). count ≥ цели: done.
// Пороги: config.MEDITATION. Контракт контроллера: см. squat.js. Картинка поверх видео: meditation-view.js.
// До отсчёта экран LIVE зовёт ready(frame): «Встань в позицию», две галочки (лицо в кадре, в кадре только ты).
// Отладка (?debug=1): f виртуальное лицо (face, без человека в кадре), e глаза авто/закрыты/открыты, n дёрнуть головой,
//   l лицо пропало, y второе лицо. Клавиши меняют данные лица кадра, поэтому без лица и без f они ничего не покажут.

import { MEDITATION as M } from '../config.js';
import { ema } from '../vision/geometry.js';
import { blink, nose, noseTracker, primaryIndex, shiftW, syntheticFace } from '../vision/face.js';
import { createView } from './meditation-view.js';

/**
 * Правила по приоритету: видимость > второй человек > глаза > голова. label: строка для итогов.
 * needsFace: без лица не видно, исправил ли; needsWindow: движение видно, только когда окно носа полное.
 */
export const RULES = [
  { code: 'face_lost', holdMs: M.faceLostMs, priority: 4, text: 'Лицо вышло из кадра, вернись', warnText: 'Лицо вышло из кадра: вернись, иначе минус жизнь', label: 'лицо вышло из кадра' },
  { code: 'two_faces', holdMs: M.twoFacesMs, priority: 3, text: 'В кадре второй человек: должен остаться только ты', warnText: 'В кадре второй человек: пусть отойдёт, иначе минус жизнь', label: 'второй человек в кадре' },
  { code: 'eyes_open', holdMs: M.eyesOpenMs, priority: 2, text: 'Глаза открыты, закрой глаза', warnText: 'Глаза открыты: закрой, иначе минус жизнь', label: 'глаза открыты', needsFace: true },
  {
    code: 'head_moving', holdMs: M.headMoveMs, holdFrames: M.headMoveFrames, priority: 1, text: 'Голова двигается, замри', warnText: 'Голова двигается: замри, иначе минус жизнь', label: 'голова двигалась',
    needsFace: true, needsWindow: true,
  },
];

const INTRO = 'Закрой глаза и замри';
// «Встань в позицию»: что сделать для непройденной галочки
const READY_HINTS = {
  none: 'Лица не видно: сядь напротив камеры, лицо по центру',
  edge: 'Лицо у края кадра: сдвинься к центру',
  crowd: 'В кадре второй человек: пусть отойдёт, должен остаться только ты',
};
const FRESH = 10; // добавка к приоритету свежего нарушения: выше любого правила
const round1 = (v) => Math.round(v * 10) / 10;

export function createController({ challenge, bus, feedback, debug }) {
  const track = noseTracker(M.headWindowMs);
  const rules = RULES.map((rule) => ({ rule, since: null, lastOn: 0, frames: 0, fired: false, firedAt: 0, shown: false, count: 0 }));
  const byCode = Object.fromEntries(rules.map((s) => [s.rule.code, s]));
  let started = false;
  let t0 = 0;
  let last = 0;
  let graceEnd = 0;
  let nextFaultAt = 0;
  let introSaid = false;
  let graceOver = false;
  let failAt = 0;
  let prevNose = null;
  let eyeLevel = null;
  let closed = null;
  let streak = 0;
  let lastFaceAt = -Infinity; // когда последний раз видели лицо медитирующего
  let lastTwoAt = -Infinity; // когда последний раз в кадре было два лица
  let jumpSince = null; // одинокое лицо далеко от прошлого носа: с какого кадра
  let fresh = null; // { code, until }: подсказка нового нарушения поверх старых
  const view = createView(); // картинка поверх видео: DOM не трогает до первого draw

  const c = {
    model: 'face',
    unit: 'секунды',
    count: 0,
    done: false,
    failed: false,
    lives: M.lives,
    maxLives: M.lives,
    target: challenge.target,
    started: false,
    best: 0, // самый долгий спокойный отрезок, с
    paused: 0, // сколько таймер стоял, с
    /** Данные лица последнего кадра (с подменой из клавиш отладки). */
    faceData: null,
    /** Что видно сейчас: для отрисовки и отладки. primary: индекс главного лица в faceData.faces, fired: списанные и не исправленные. */
    view: { faces: 0, primary: -1, closed: null, eyeLevel: null, shift: 0, moving: false, calm: false, grace: 0, pending: null, active: null, fired: [] },

    start(t) {
      started = c.started = true;
      t0 = last = t;
      graceEnd = t + M.graceSec * 1000;
      // «Старт» говорит экран LIVE, голосом скажем чуть позже (frame), чтобы его не перебить
      feedback.hint(INTRO, { level: 'info', code: 'med_intro', speak: false, minMs: M.graceSec * 1000 });
    },

    frame(frame, t) {
      if (!started || c.done || c.failed) return;
      if (failAt) {
        if (t >= failAt) c.failed = true;
        return;
      }
      const gap = t - last;
      last = t;
      const stale = gap > M.maxFrameGapMs;
      if (stale) {
        // кадров долго не было (камера, скрытая вкладка): это время не считаем, окна начинаем заново,
        // а исправленным нарушение за это время не считается: его просто не было видно
        track.reset();
        for (const s of rules) {
          if (s.fired) {
            s.lastOn = t;
            s.firedAt += gap; // кадров не было: висит ли нарушение, не видно, время для «ещё минус жизнь» не идёт
          } else s.since = null;
          s.frames = 0;
        }
      }
      const dt = stale ? 0 : gap / 1000;
      const aspect = frame.width && frame.height ? frame.width / frame.height : 16 / 9;

      const res = (c.faceData = simulate(frame.face, t));
      const faces = res?.faces ?? [];
      const n = faces.length;
      if (n > 1) lastTwoAt = t;
      let i = n ? primaryIndex(faces, prevNose, aspect) : -1;
      // Второй человек рядом, а модель на кадр потеряла медитирующего и видит только того:
      // одинокое лицо далеко от прошлого носа. Медитирующего не видно; держится 3 с: значит, это он.
      const far = n === 1 && prevNose && shiftW(nose(faces[0]), prevNose, aspect) > M.jumpMax;
      if (far && !stale && (jumpSince != null || t - lastTwoAt < M.faceLostMs)) {
        jumpSince ??= t;
        if (t - jumpSince < M.jumpAcceptMs) i = -1;
        else {
          jumpSince = null;
          track.reset(); // скачок к этому лицу не движение головы
        }
      } else jumpSince = null;
      const face = i >= 0 ? faces[i] : null;

      let shift = 0;
      let moving = false;
      if (face) {
        lastFaceAt = t;
        prevNose = nose(face);
        track.push(t, prevNose);
        shift = track.shift(aspect);
        moving = shift > M.headMoveMax;
        const b = blink(res.blendshapes?.[i]);
        if (Number.isFinite(b)) {
          eyeLevel = ema(eyeLevel, b, M.eyesEma);
          if (eyeLevel > M.eyesClosedMin) closed = true;
          else if (closed !== true || eyeLevel < M.eyesClosedMin - M.eyesHysteresis) closed = false;
        }
      } else if (!n) {
        // лица нет: окно носа заново (вернётся в другом месте: это не движение головы),
        // а глаза и место носа помним, пока пропажа короткая (кадр без лица не сбивает гистерезис)
        track.reset();
        if (t - lastFaceAt > M.gapMs) {
          prevNose = null;
          eyeLevel = null;
          closed = null;
        }
      }

      const grace = t < graceEnd;
      if (!introSaid && t - t0 >= M.introDelayMs) {
        introSaid = true;
        if (grace) feedback.say(INTRO, 'med_intro');
      }
      if (!grace && !graceOver) {
        // grace кончился: движение за это время не в счёт, окно носа начинаем заново
        graceOver = true;
        feedback.clear('med_intro');
        track.reset();
        if (prevNose) track.push(t, prevNose);
        shift = 0;
        moving = false;
      }

      const calm = Boolean(face) && n === 1 && closed === true && !moving;
      if (calm) {
        c.count += dt;
        streak += dt;
        c.best = Math.max(c.best, streak);
      } else {
        streak = 0;
        c.paused += dt;
      }
      c.done = c.count >= challenge.target;

      const on = {
        face_lost: !face,
        // медитирующего не видно, а второй остался: уже списанное нарушение не считаем исправленным
        two_faces: n > 1 || (!face && n > 0 && byCode.two_faces.fired),
        eyes_open: Boolean(face) && closed === false,
        head_moving: Boolean(face) && moving,
      };
      let pending = null;
      let active = null;
      const fired = [];
      for (const s of rules) {
        const { rule } = s;
        if (on[rule.code]) {
          if (s.since == null) s.since = t;
          s.lastOn = t;
          if (s.fired) {
            // нарушение ещё не исправили: подсказка держится (без звука), через persistWarnMs предупреждает про жизнь,
            // через persistMs списывает ещё одну (и так до провала); пока свежая подсказка другого нарушения на экране, свою не просим
            if (!c.done && t - s.firedAt >= M.persistMs && t >= nextFaultAt) fire(s, t);
            active ??= rule.code;
            fired.push(rule.code);
            s.shown = true;
            const freshOn = fresh && t < fresh.until;
            if (!freshOn || fresh.code === rule.code) {
              const late = t - s.firedAt >= M.persistWarnMs;
              feedback.hint(late ? rule.warnText : rule.text, { level: 'warn', priority: rule.priority + (freshOn ? FRESH : 0), code: rule.code, speak: false });
            }
            continue;
          }
          if (grace) continue;
          s.frames += 1;
          const held = t - Math.max(s.since, graceEnd);
          const ready = held >= rule.holdMs || (rule.holdFrames && s.frames >= rule.holdFrames);
          if (ready && t >= nextFaultAt && !c.done) {
            fire(s, t);
            active ??= rule.code;
            fired.push(rule.code);
          } else pending ??= rule.code;
        } else {
          s.frames = 0;
          if (s.since == null) continue;
          if (s.fired) {
            if (s.shown) {
              s.shown = false;
              feedback.clear(rule.code);
            }
            // лица не видно или окно носа ещё не набралось: нельзя сказать, что исправил
            if ((rule.needsFace && !face) || (rule.needsWindow && track.span < M.headWindowMs)) s.lastOn = t;
            else if (t - s.lastOn >= M.fixedMs) {
              s.fired = false;
              s.since = null;
            }
          } else if (t - s.lastOn > M.gapMs) s.since = null;
        }
      }

      c.view = { faces: n, primary: i, closed, eyeLevel, shift, moving, calm, grace: grace ? (graceEnd - t) / 1000 : 0, pending, active, fired };
      debug?.set('медитация', `${calm ? 'идёт' : 'пауза'}, лиц ${n}, глаза ${eyeLevel == null ? '?' : eyeLevel.toFixed(2)}, нос ${(shift * 100).toFixed(1)}%`);
      debug?.set('нарушение', active ?? pending ?? 'нет');
    },

    /**
     * «Встань в позицию» до отсчёта: лицо в кадре (нос внутри кадра) и в кадре только ты.
     * У непройденной галочки есть hint (что сделать), верхний hint = подсказка первой непройденной, null, если все ✓.
     * Чистая проверка: без событий, подсказок и счёта, работает и до start().
     */
    ready(frame) {
      const faces = peekFaces(frame?.face);
      const face = faces.length > 0 && inFrame(nose(faces[primaryIndex(faces)]));
      const alone = faces.length === 1;
      const checks = [
        { id: 'face', text: 'Лицо в кадре', ok: face, ...(face ? {} : { hint: faces.length ? READY_HINTS.edge : READY_HINTS.none }) },
        { id: 'alone', text: 'В кадре только ты', ok: alone, ...(alone || !faces.length ? {} : { hint: READY_HINTS.crowd }) },
      ];
      return { ok: face && alone, checks, hint: checks.find((chk) => !chk.ok)?.hint ?? null };
    },

    /** Своя отрисовка поверх видео (экран LIVE зовёт её вместо скелета, и во время отсчёта тоже). */
    draw(frame, d) {
      if (!c.faceData || c.faceData.t !== (sim.virtual ? frame.t : frame.face?.t)) c.faceData = simulate(frame.face, frame.t);
      view.draw(frame, d, c);
    },

    stop() {
      view.destroy(); // после этого вид чипы больше не создаёт, даже если кадр ещё придёт
      if (current === c) current = null;
    },

    summary() {
      const faults = rules
        .filter((s) => s.count)
        .sort((a, b) => b.count - a.count || b.rule.priority - a.rule.priority)
        .map((s) => ({ code: s.rule.code, text: s.rule.label, count: s.count }));
      return {
        faults,
        rejected: [],
        extra: { lives: c.lives, maxLives: c.maxLives, bestStreakSec: round1(c.best), pausedSec: round1(c.paused) },
      };
    },
  };

  function fire(s, t) {
    const { rule } = s;
    s.fired = true;
    s.firedAt = t;
    s.shown = true;
    s.count += 1;
    nextFaultAt = t + M.cooldownMs;
    c.lives = Math.max(0, c.lives - 1);
    // новое нарушение видно и слышно сразу, даже если на экране подсказка старше: жизнь не уходит молча
    fresh = { code: rule.code, until: t + M.freshHintMs };
    feedback.clearNow();
    feedback.hint(rule.text, { level: 'warn', priority: rule.priority + FRESH, code: rule.code });
    bus.emit('fault', { code: rule.code, text: rule.text, joints: [], lives: c.lives });
    if (c.lives === 0) failAt = t + M.failDelayMs;
  }

  current = c;
  sim.virtual = false;
  sim.eyes = 'auto';
  sim.lost = false;
  sim.second = false;
  sim.jolt = false;
  sim.joltFrom = -Infinity;
  if (debug?.enabled) debugKeys(debug);
  return c;
}

// ─── Отладка: подмена данных лица клавишами (только ?debug=1) ─────

let current = null; // контроллер, который сейчас на экране

/** Контроллер медитации, который сейчас на экране (для отладки в консоли), или null. */
export const active = () => current;
const sim = { virtual: false, eyes: 'auto', lost: false, second: false, jolt: false, joltFrom: -Infinity };
const OPEN_LEVEL = 0.05; // моргание виртуального лица: глаза открыты
const CLOSED_LEVEL = 0.9; // и закрыты
const JOLT_MS = 1200;
let keysReady = false;

function debugKeys(debug) {
  if (keysReady) return;
  keysReady = true;
  const EYES = ['auto', 'closed', 'open'];
  const show = () => debug.set('подмена лица', `${sim.virtual ? 'виртуальное лицо, ' : ''}глаза ${sim.eyes}${sim.lost ? ', лица нет' : ''}${sim.second ? ', второе лицо' : ''}`);
  // клавиши глобальные: работают, только пока на экране LIVE идёт медитация
  const key = (k, fn, label) => debug.key(k, () => current && (fn(), show()), label);
  key('f', () => (sim.virtual = !sim.virtual), 'медитация: виртуальное лицо (без человека в кадре) вкл/выкл');
  key('e', () => (sim.eyes = EYES[(EYES.indexOf(sim.eyes) + 1) % EYES.length]), 'медитация: глаза авто / закрыты / открыты');
  key('n', () => (sim.jolt = true), 'медитация: дёрнуть головой');
  key('l', () => (sim.lost = !sim.lost), 'медитация: лицо пропало вкл/выкл');
  key('y', () => (sim.second = !sim.second), 'медитация: второе лицо вкл/выкл');
}

/** Лица кадра с подменой клавишами отладки l и y, без побочных эффектов (simulate съедает рывок головы). */
function peekFaces(res) {
  if (sim.lost) return [];
  const faces = sim.virtual ? [syntheticFace()] : (res?.faces ?? []);
  return sim.second && faces.length ? [...faces, faces[0]] : faces;
}

/** Точка внутри кадра с небольшим полем: лицо у самого края или за ним лицом в кадре не считаем. */
const inFrame = (p) => Boolean(p) && p.x > 0.02 && p.x < 0.98 && p.y > 0.02 && p.y < 0.98;

/** Данные лица с подменой из клавиш отладки. Без подмены: те же самые данные. */
export function simulate(res, t) {
  if (sim.virtual) {
    // модель ничего не показывает: вместо неё синтетическое лицо, глаза по клавише e (авто = закрыты)
    const level = sim.eyes === 'open' ? OPEN_LEVEL : CLOSED_LEVEL;
    res = { t, faces: [syntheticFace(0.5, 0.5, level)], blendshapes: [{ eyeBlinkLeft: level, eyeBlinkRight: level }] };
  }
  if (sim.jolt) {
    // рывок отсчитываем от времени кадра: так же, как его видит контроллер
    sim.jolt = false;
    sim.joltFrom = t;
  }
  const jolt = t - sim.joltFrom < JOLT_MS;
  if (!res || (sim.eyes === 'auto' && !sim.lost && !sim.second && !jolt)) return res;
  if (sim.lost) return { ...res, faces: [], blendshapes: [] };
  let faces = res.faces ?? [];
  let blendshapes = res.blendshapes ?? [];
  if (jolt && faces.length) {
    const dx = 0.1 * Math.sin((Math.PI * (t - sim.joltFrom)) / JOLT_MS);
    faces = [faces[0].map((p) => ({ ...p, x: p.x + dx })), ...faces.slice(1)];
  }
  if (sim.eyes !== 'auto') {
    const v = sim.eyes === 'closed' ? 0.9 : 0.05;
    blendshapes = blendshapes.map((b) => ({ ...b, eyeBlinkLeft: v, eyeBlinkRight: v }));
  }
  if (sim.second && faces.length) {
    const f = faces[0];
    const cx = f.reduce((s, p) => s + p.x, 0) / f.length;
    const dx = cx > 0.5 ? -0.32 : 0.32;
    faces = [...faces, f.map((p) => ({ ...p, x: cx + dx + (p.x - cx) * 0.8, y: p.y + 0.04 }))];
    blendshapes = [...blendshapes, blendshapes[0] ?? {}];
  }
  return { ...res, faces, blendshapes };
}
