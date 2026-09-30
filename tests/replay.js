// Прогон ролика по кадрам через модель и контроллер упражнения, без <video> и без камеры.
// Работает в скрытой вкладке и в headless Chrome. Кадры режет tools/frames.swift.
//
// tests/replay.html?frames=/fixtures/frames/squat-side&type=squat
//   &target=N                цель (по умолчанию 999, чтобы прогон дошёл до конца ролика)
//   &save=/fixtures/replays/squat-side.json    итог в файл (через tools/serve.py)
//   &trace=/fixtures/traces/squat-side.json    покадровые точки для тестов в jsc
// Итог: window.__REPLAY__ и заголовок страницы «DONE count=N» (или «ERROR …»).

import * as models from '../src/vision/models.js';
import { normalize } from '../src/vision/runner.js';
import { CHALLENGES } from '../src/config.js';
import { newChallenge } from '../src/app.js';

const q = new URLSearchParams(location.search);
const dir = q.get('frames');
const type = q.get('type') || 'squat';
const def = CHALLENGES[type];
const out = document.querySelector('#out');
const r1 = (v) => Math.round(v * 10) / 10;
const r4 = (v) => Math.round(v * 1e4) / 1e4;

let now = 0; // время ролика, мс
const hints = [];
const events = [];

const feedback = {
  highlight: new Set(),
  current: null,
  hint(text, o = {}) {
    const code = o.code ?? text;
    const last = hints.findLast((h) => h.code === code);
    if (!last || now - last.lastAt > 1500) hints.push({ t: now, lastAt: now, code, text, level: o.level ?? 'info' });
    else last.lastAt = now;
    this.highlight = new Set(o.joints ?? []);
  },
  clear() {},
  clearNow() {},
  say() {},
  mount() {},
  unlockAudio() {},
};
const bus = {
  emit(type, p = {}) {
    events.push({ t: now, type, code: p.code, text: p.text, count: p.count });
  },
  on: () => () => {},
  once: () => () => {},
};
const debug = { enabled: false, set() {}, key() {}, log() {} };

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`не загрузился кадр ${src}`));
    img.src = src;
  });
}

function compact(frame) {
  if (def.model === 'pose') {
    // lm: нормализованные точки кадра [x, y, z, visibility]; world: 3D в метрах (не зависят от ракурса камеры)
    const lm = frame.pose?.landmarks?.map((p) => [r4(p.x), r4(p.y), r4(p.z), r4(p.visibility ?? 0)]);
    const world = frame.pose?.world?.map((p) => [r4(p.x), r4(p.y), r4(p.z)]);
    return lm ? { lm, world } : null;
  }
  if (def.model === 'face') {
    const f = frame.face;
    const bs = f?.blendshapes?.[0];
    return { n: f?.faces?.length ?? 0, nose: f?.faces?.[0]?.[1] ? [r4(f.faces[0][1].x), r4(f.faces[0][1].y)] : null, blink: bs ? [r4(bs.eyeBlinkLeft ?? 0), r4(bs.eyeBlinkRight ?? 0)] : null };
  }
  return null;
}

async function save(path, data) {
  const res = await fetch(`/__save?path=${encodeURIComponent(path.replace(/^\//, ''))}`, { method: 'POST', body: JSON.stringify(data) });
  if (!res.ok) throw new Error(`не сохранилось ${path}: ${res.status}`);
}

async function run() {
  if (!dir || !def) throw new Error('нужны ?frames=/fixtures/frames/<имя>&type=squat|pushup|meditation');
  const idx = await (await fetch(`${dir}/index.json`)).json();
  const task = await models.load(def.model);
  const { createController } = await import(`../src/exercises/${type}.js`);
  const challenge = newChallenge(type, { target: Number(q.get('target')) || 999 });
  const c = createController({ challenge, bus, feedback, debug });
  const latest = { pose: null, gesture: null, face: null };
  const countTimeline = [];
  const trace = q.get('trace') ? [] : null;
  let shown = -1;
  const started = performance.now();

  for (let i = 0; i < idx.count; i++) {
    now = 1 + (i * 1000) / idx.fps;
    const img = await loadImage(`${dir}/f${String(i + 1).padStart(5, '0')}.jpg`);
    const res = def.model === 'gesture' ? task.recognizeForVideo(img, now) : task.detectForVideo(img, now);
    latest[def.model] = normalize[def.model](res, now);
    const frame = { t: now, ran: def.model, width: img.naturalWidth, height: img.naturalHeight, ...latest };
    if (i === 0) c.start?.(now);
    c.frame(frame, now);
    const n = Math.floor(c.count);
    if (n !== shown) {
      if (shown >= 0) countTimeline.push({ t: now, count: n });
      shown = n;
    }
    trace?.push(compact(frame));
    if (i % 15 === 0) document.title = `RUN ${i}/${idx.count}`;
  }

  const result = {
    input: { frames: dir, type, fps: idx.fps, count: idx.count, width: idx.width, height: idx.height, seconds: r1(idx.duration) },
    count: Math.floor(c.count),
    done: c.done,
    failed: c.failed,
    summary: c.summary?.() ?? null,
    countTimeline: countTimeline.map((e) => ({ s: r1(e.t / 1000), count: e.count })),
    events: events.filter((e) => e.type !== 'count').map((e) => ({ s: r1(e.t / 1000), type: e.type, code: e.code, text: e.text })),
    hints: hints.map((h) => ({ s: r1(h.t / 1000), until: r1(h.lastAt / 1000), code: h.code, text: h.text, level: h.level })),
    msPerFrame: r1((performance.now() - started) / idx.count),
  };
  window.__REPLAY__ = result;

  const lines = [
    `${idx.source}: ${type}, ${idx.count} кадров, ${idx.fps} fps, ${r1(idx.duration)} с, ${result.msPerFrame} мс на кадр`,
    `ИТОГ: ${result.count} ${def.unit}${c.failed ? ', провал' : ''}`,
    result.summary?.extra?.rejectedText ? `незасчитанные: ${result.summary.extra.rejectedText}` : '',
    '',
    'Счёт по времени:',
    ...result.countTimeline.map((e) => `  ${e.s} с → ${e.count}`),
    '',
    'События:',
    ...result.events.map((e) => `  ${e.s} с  ${e.type}  ${e.code ?? ''}  ${e.text ?? ''}`),
    '',
    'Подсказки:',
    ...result.hints.map((h) => `  ${h.s}-${h.until} с  [${h.level}] ${h.text}`),
  ];
  out.textContent = lines.filter((l) => l !== undefined).join('\n');

  if (q.get('save')) await save(q.get('save'), result);
  if (trace) await save(q.get('trace'), { input: result.input, frames: trace });
  document.title = `DONE count=${result.count}`;
}

run().catch((err) => {
  console.error(err);
  window.__REPLAY__ = { error: String(err) };
  out.textContent = `Ошибка: ${err.message ?? err}`;
  document.title = `ERROR ${err.message ?? err}`;
  if (q.get('save')) save(q.get('save'), { error: String(err) }).catch(() => {});
});
