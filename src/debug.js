// Отладка: только с ?debug=1. В демо ничего из этого не видно.
// debug.set('угол', 97)  → строка в оверлее слева снизу
// debug.key('k', fn, 'что делает') → горячая клавиша (занятые клавиши: CLAUDE.md, раздел 12)

import { DEBUG } from './config.js';

const values = new Map();
const keys = new Map();
let el = null;
let dirty = false;
let showHelp = true;

export const debug = {
  enabled: DEBUG,

  set(name, value) {
    if (!DEBUG) return;
    values.set(name, value);
    dirty = true;
  },

  key(key, fn, label = '') {
    if (!DEBUG) return;
    const k = key.toLowerCase();
    if (keys.has(k)) console.warn(`[debug] клавиша «${k}» уже занята: ${keys.get(k).label}`);
    keys.set(k, { fn, label });
    dirty = true;
  },

  log(...args) {
    if (DEBUG) console.log('[debug]', ...args);
  },

  mount(node) {
    if (!DEBUG) return;
    el = node;
    el.hidden = false;
    addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (e.key === '?') {
        showHelp = !showHelp;
        dirty = true;
        return;
      }
      const k = keys.get(e.key.toLowerCase());
      if (!k) return;
      e.preventDefault();
      k.fn(e);
    });
    setInterval(render, 200);
  },
};

function render() {
  if (!el || !dirty) return;
  dirty = false;
  const fmt = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
  const rows = [...values].map(([k, v]) => `${k}: ${fmt(v)}`);
  const help = showHelp ? ['', ...[...keys].map(([k, v]) => `[${k === ' ' ? 'space' : k}] ${v.label}`), '[?] скрыть'] : [];
  el.textContent = [...rows, ...help].join('\n');
}
