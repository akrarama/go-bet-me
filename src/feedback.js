// Подсказки: текст внизу экрана + озвучка + красные суставы на скелете.
// Владелец: блок 1 (Упражнения).
//
// feedback.hint(text, { level, joints, priority, speak, minMs, ttl, code })
//   На экране одна подсказка, старшая по приоритету (упражнения: видимость 4 > форма 3 > глубина 2 > темп 1).
//   Новая вытесняет текущую, если её приоритет выше или такой же, а текущая уже провисела minMs.
//   Младшая не показывается, пока висит старшая: правила по кадру зовут hint каждый кадр
//   и появятся сами, когда старшая уйдёт.
//   Тот же code: обновить текст, уровень и суставы, продлить ttl.
//   level: 'info' | 'warn' | 'ok'; joints: индексы позы для подсветки красным;
//   minMs: минимум на экране (по умолчанию 1.5 с); ttl: убрать саму через столько мс после
//   последнего вызова (разовые подсказки), без ttl висит до clear(code); code: ключ правила.
// feedback.clear(code)  убрать подсказку этого правила (не раньше её minMs)
// feedback.clearNow()   убрать сразу (смена экрана)
// feedback.say(text, code | { code, priority })  только озвучка, без спама: тот же code не чаще
//   раза в 6 с, и пока звучит подсказка важнее, младшая молчит. say без priority
//   (отсчёт, финал) звучит всегда и перебивает подсказку.
// feedback.highlight    Set индексов, которые draw.js красит красным
//
// createFeedback(env) даёт отдельный экземпляр с подменой часов, таймеров и голоса (тесты в jsc).

import { REPS } from './config.js';

const SPEAK_REPEAT_MS = 6000;
const OUT_MS = 220; // длина анимации ухода (styles/exercises.css, .hint.is-out)

const browserEnv = {
  now: () => performance.now(),
  later(fn, ms) {
    const id = setTimeout(fn, ms);
    return () => globalThis.clearTimeout?.(id);
  },
  synth: () => globalThis.speechSynthesis ?? null,
  utterance: (text) => new SpeechSynthesisUtterance(text),
};

export function createFeedback(env = browserEnv) {
  let el = null;
  let current = null; // { text, level, priority, code, joints, minMs, ttl, shownAt, touchedAt, clearing }
  let cancelSweep = null;
  let cancelOut = null;
  let voice = null;
  let voiceBusy = null; // { priority, until }: что сейчас звучит
  let audioUnlocked = false;
  const spokenAt = new Map();

  /** Когда текущая подсказка уходит сама: Infinity = пока не позовут clear. */
  const deadline = (h) => {
    const min = h.shownAt + h.minMs;
    if (h.clearing) return min;
    return h.ttl > 0 ? Math.max(min, h.touchedAt + h.ttl) : Infinity;
  };

  function arm() {
    cancelSweep?.();
    cancelSweep = null;
    const due = current ? deadline(current) : Infinity;
    if (due !== Infinity) cancelSweep = env.later(sweep, Math.max(0, due - env.now()) + 1);
  }

  function sweep() {
    cancelSweep = null;
    if (current && env.now() >= deadline(current)) api.clearNow();
    else arm();
  }

  function drop() {
    cancelSweep?.();
    cancelSweep = null;
    current = null;
    api.highlight = new Set();
  }

  function render() {
    if (!el) return;
    cancelOut?.();
    cancelOut = null;
    if (!current) {
      if (el.hidden) return;
      el.classList.remove('is-in');
      el.classList.add('is-out');
      cancelOut = env.later(() => {
        cancelOut = null;
        el.hidden = true;
        el.classList.remove('is-out');
        el.textContent = '';
      }, OUT_MS);
      return;
    }
    el.classList.remove('is-out');
    el.hidden = false;
    el.dataset.level = current.level;
    if (el.textContent !== current.text) {
      el.textContent = current.text;
      el.classList.remove('is-in');
      void el.offsetWidth; // перезапуск анимации появления
      el.classList.add('is-in');
    }
  }

  function pickVoice() {
    const voices = env.synth()?.getVoices?.() ?? [];
    const ru = voices.filter((v) => v.lang?.toLowerCase().replace('_', '-').startsWith('ru'));
    // локальный голос отвечает сразу, сетевой (Google) бывает с задержкой
    voice = ru.find((v) => v.localService) ?? ru[0] ?? null;
  }

  const api = {
    highlight: new Set(),

    mount(node) {
      el = node;
      pickVoice();
      env.synth()?.addEventListener?.('voiceschanged', pickVoice);
    },

    /** @returns {boolean} показана ли подсказка (false: занято старшей) */
    hint(text, { level = 'info', joints = [], priority = 0, speak = level === 'warn', minMs = REPS.fault.hintMinMs, ttl = 0, code = text } = {}) {
      const now = env.now();
      if (current && now >= deadline(current)) drop();
      if (current && current.code === code) {
        const changed = current.text !== text || current.level !== level;
        Object.assign(current, { text, level, priority, joints, ttl, touchedAt: now, clearing: false });
        api.highlight = new Set(joints);
        if (changed) {
          render();
          if (speak) api.say(text, { code, priority });
        }
        arm();
        return true;
      }
      if (current && (priority < current.priority || (priority === current.priority && now - current.shownAt < current.minMs))) return false;
      current = { text, level, priority, code, joints, minMs, ttl, shownAt: now, touchedAt: now, clearing: false };
      api.highlight = new Set(joints);
      render();
      arm();
      if (speak) api.say(text, { code, priority });
      return true;
    },

    clear(code) {
      if (!current || (code && current.code !== code)) return;
      current.clearing = true;
      sweep();
    },

    clearNow() {
      drop();
      render();
    },

    get current() {
      return current;
    },

    /** Озвучка. @returns {boolean} прозвучит ли */
    say(text, opts) {
      const { code = text, priority = Infinity } = typeof opts === 'string' ? { code: opts } : opts ?? {};
      const synth = env.synth();
      if (!synth) return false;
      const now = env.now();
      if (now - (spokenAt.get(code) ?? -Infinity) < SPEAK_REPEAT_MS) return false;
      const busy = voiceBusy && now < voiceBusy.until && synth.speaking;
      if (busy && priority !== Infinity && priority <= voiceBusy.priority) return false;
      spokenAt.set(code, now);
      voiceBusy = { priority, until: now + 400 + text.length * 70 };
      try {
        synth.cancel();
        const u = env.utterance(text);
        u.lang = 'ru-RU';
        if (voice) u.voice = voice;
        u.rate = 1.05;
        synth.speak(u);
      } catch {
        return false;
      }
      return true;
    },

    /** Браузер разрешает звук только после первого касания/клавиши. main.js вызывает это сам. */
    unlockAudio() {
      if (audioUnlocked) return;
      audioUnlocked = true;
      try {
        const u = env.utterance(' ');
        u.volume = 0;
        env.synth()?.speak(u);
      } catch {
        /* без звука, ничего страшного */
      }
    },

    get audioUnlocked() {
      return audioUnlocked;
    },
  };
  return api;
}

export const feedback = createFeedback();
