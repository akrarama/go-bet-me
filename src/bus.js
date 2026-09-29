// Шина событий между блоками. Список событий и их данные: CLAUDE.md, раздел 12.
// На экранах подписывайся через ctx.on(): подписка снимется сама при смене экрана.

const map = new Map();

export const bus = {
  on(type, fn) {
    if (!map.has(type)) map.set(type, new Set());
    map.get(type).add(fn);
    return () => map.get(type)?.delete(fn);
  },

  once(type, fn) {
    const off = bus.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  },

  emit(type, payload = {}) {
    const set = map.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus] ${type}`, err);
      }
    }
  },
};
