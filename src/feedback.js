// Подсказки: текст внизу экрана + озвучка + красные суставы на скелете.
// Владелец: блок 1 (Упражнения). Основа: рабочая базовая версия, блок 1 её дорабатывает.
//
// feedback.hint(text, { level, joints, priority, speak, minMs, code })
//   level: 'info' | 'warn' | 'ok'; joints: индексы позы для подсветки красным;
//   priority: у кого выше, тот и показывается (видимость > форма > глубина > темп);
//   minMs: минимум на экране (по умолчанию 1.5 с); code: ключ правила (для clear и лога).
// feedback.clear(code)  убрать подсказку этого правила (не раньше её minMs)
// feedback.clearNow()   убрать сразу (смена экрана)
// feedback.say(text)    только озвучка
// feedback.highlight    Set индексов, которые draw.js красит красным

import { REPS } from './config.js';

let el = null;
let current = null;
let clearTimer = 0;
let voice = null;
let audioUnlocked = false;
const spokenAt = new Map();
const SPEAK_REPEAT_MS = 4000;

function pickVoice() {
  const voices = globalThis.speechSynthesis?.getVoices?.() ?? [];
  voice = voices.find((v) => v.lang?.toLowerCase().startsWith('ru')) ?? null;
}

function render() {
  if (!el) return;
  if (!current) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.dataset.level = current.level;
  if (el.textContent !== current.text) {
    el.textContent = current.text;
    el.classList.remove('is-in');
    void el.offsetWidth; // перезапуск анимации появления
    el.classList.add('is-in');
  }
}

export const feedback = {
  highlight: new Set(),

  mount(node) {
    el = node;
    pickVoice();
    globalThis.speechSynthesis?.addEventListener?.('voiceschanged', pickVoice);
  },

  hint(text, { level = 'info', joints = [], priority = 0, speak = level === 'warn', minMs = REPS.fault.hintMinMs, code = text } = {}) {
    const now = performance.now();
    if (current && current.code === code) {
      current.until = Math.max(current.until, now + minMs);
      return;
    }
    if (current && now < current.until && priority < current.priority) return;
    clearTimeout(clearTimer);
    current = { text, level, priority, code, until: now + minMs };
    this.highlight = new Set(joints);
    render();
    if (speak) this.say(text, code);
  },

  clear(code) {
    if (!current || (code && current.code !== code)) return;
    const left = current.until - performance.now();
    if (left > 0) {
      const mine = current;
      clearTimeout(clearTimer);
      clearTimer = setTimeout(() => current === mine && this.clearNow(), left);
      return;
    }
    this.clearNow();
  },

  clearNow() {
    clearTimeout(clearTimer);
    current = null;
    this.highlight = new Set();
    render();
  },

  get current() {
    return current;
  },

  /** Озвучка. Один и тот же код не повторяется чаще раза в 4 с. */
  say(text, code = text) {
    const synth = globalThis.speechSynthesis;
    if (!synth) return;
    const now = performance.now();
    if (now - (spokenAt.get(code) ?? -Infinity) < SPEAK_REPEAT_MS) return;
    spokenAt.set(code, now);
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ru-RU';
    if (voice) u.voice = voice;
    u.rate = 1.05;
    synth.speak(u);
  },

  /** Браузер разрешает звук только после первого касания/клавиши. main.js вызывает это сам. */
  unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      globalThis.speechSynthesis?.speak(u);
    } catch {
      /* без звука, ничего страшного */
    }
  },

  get audioUnlocked() {
    return audioUnlocked;
  },
};
