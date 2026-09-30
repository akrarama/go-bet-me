// Тесты блока 4 (Медитация): глаза, неподвижность, лица, жизни, таймер. Синтетические кадры, без камеры.

import { MEDITATION as M } from '../src/config.js';
import { FACE, blink, eyesClosed, faceCount, nose, noseTracker, primaryIndex, shiftW } from '../src/vision/face.js';
import { createController } from '../src/exercises/meditation.js';

const W = 1280;
const H = 720;
const STEP = 50; // мс между кадрами: 20 кадров в секунду
const T0 = 1000; // время старта

/** Синтетическое лицо: 478 точек по овалу, кончик носа (точка 1) в центре. */
function face(cx = 0.5, cy = 0.45, r = 0.1) {
  const pts = Array.from({ length: 478 }, (_, i) => {
    const a = (i / 478) * Math.PI * 2;
    return { x: cx + r * Math.cos(a), y: cy + r * 1.4 * Math.sin(a), z: 0 };
  });
  pts[FACE.nose] = { x: cx, y: cy, z: -0.05 };
  return pts;
}
const CLOSED = { eyeBlinkLeft: 0.85, eyeBlinkRight: 0.8 };
const OPEN = { eyeBlinkLeft: 0.05, eyeBlinkRight: 0.1 };

// Сцены: что в кадре в момент ms от старта
const calm = () => ({ faces: [face()], blendshapes: [CLOSED] });
const open = () => ({ faces: [face()], blendshapes: [OPEN] });
const empty = () => ({ faces: [], blendshapes: [] });
const two = () => ({ faces: [face(), face(0.8, 0.5, 0.07)], blendshapes: [CLOSED, OPEN] });

/** Контроллер с заглушками feedback/bus и прогон кадров. */
function setup(target = 60) {
  let t = T0;
  const log = { hints: [], clears: [], says: [], faults: [], clearNow: 0 };
  const feedback = {
    hint: (text, o = {}) => log.hints.push({ text, ...o, at: t - T0 }),
    clear: (code) => log.clears.push(code),
    clearNow: () => (log.clearNow += 1),
    say: (text) => log.says.push(text),
  };
  const bus = { emit: (type, p) => type === 'fault' && log.faults.push(p) };
  const c = createController({ challenge: { target }, bus, feedback, debug: { enabled: false, set() {} } });
  c.start(T0);
  const frameAt = (ms, scene) => {
    t = T0 + ms;
    const s = scene(ms);
    c.frame({ t, ran: 'face', width: W, height: H, face: { t, faces: s.faces, blendshapes: s.blendshapes } }, t);
  };
  /** Кадры каждые STEP мс, пока время от старта < to. */
  const run = (to, scene = calm) => {
    while (t - T0 + STEP <= to) frameAt(t - T0 + STEP, scene);
  };
  const codes = () => log.faults.map((f) => f.code);
  return { c, log, run, frameAt, codes, now: () => t - T0 };
}

export default (t) => {
  // ─── face.js ───────────────────────────────────────────────

  t.test('face: глаза закрыты, когда среднее моргание больше порога', (a) => {
    const both = (v) => ({ eyeBlinkLeft: v, eyeBlinkRight: v });
    a.near(blink({ eyeBlinkLeft: 0.6, eyeBlinkRight: 0.5 }), 0.55);
    a.eq(eyesClosed({ eyeBlinkLeft: 0.6, eyeBlinkRight: 0.5 }), true);
    a.eq(eyesClosed(both(M.eyesClosedMin)), false, 'ровно порог: ещё открыты');
    a.eq(eyesClosed(both(0.45)), true, 'закрытые глаза в очках или при тусклом свете дают 0.4-0.6');
    a.eq(eyesClosed(both(0.3)), false, 'открытые глаза при взгляде вниз обычно ниже 0.3');
    a.eq(eyesClosed(OPEN), false);
    a.eq(blink(null), null);
    a.eq(eyesClosed(undefined), false);
  });

  t.test('face: нос это точка 1, число лиц', (a) => {
    const f = face(0.3, 0.4);
    a.deep(nose(f), { x: 0.3, y: 0.4, z: -0.05 });
    a.eq(nose(null), null);
    a.eq(faceCount({ faces: [f, f] }), 2);
    a.eq(faceCount(null), 0);
  });

  t.test('face: смещение в долях ширины кадра, y переводится через aspect', (a) => {
    a.near(shiftW({ x: 0.5, y: 0.5 }, { x: 0.54, y: 0.5 }, W / H), 0.04, 1e-9);
    a.near(shiftW({ x: 0, y: 0 }, { x: 0, y: 0.09 }, W / H), 0.09 / (W / H), 1e-9);
  });

  t.test('face: смещение носа за последнюю секунду', (a) => {
    const track = noseTracker(1000);
    for (let ms = 0; ms <= 3000; ms += 100) track.push(ms, { x: 0.5 + ms * 0.0001, y: 0.5 }); // 0.1 ширины в секунду
    a.near(track.shift(W / H), 0.1, 1e-6);
    a.near(track.span, 1000, 1e-9);
    track.reset();
    a.eq(track.shift(), 0);
    for (let ms = 0; ms <= 2000; ms += 50) track.push(ms, { x: 0.5 + (ms % 100 ? 0.002 : -0.002), y: 0.45 });
    a.ok(track.shift(W / H) < 0.01, 'дрожание точек не похоже на движение');
  });

  t.test('face: главное лицо ближе к прошлому носу, без истории самое крупное', (a) => {
    const small = face(0.2, 0.5, 0.05);
    const big = face(0.7, 0.5, 0.12);
    a.eq(primaryIndex([small, big]), 1);
    a.eq(primaryIndex([big, small], { x: 0.21, y: 0.5 }), 1);
    a.eq(primaryIndex([small, big], { x: 0.21, y: 0.5 }), 0);
    a.eq(primaryIndex([]), -1);
  });

  // ─── Таймер ────────────────────────────────────────────────

  t.test('таймер идёт, пока глаза закрыты и голова неподвижна', (a) => {
    const { c, run, log } = setup();
    run(10000);
    a.near(c.count, 10, 0.06);
    a.eq(c.lives, 3);
    a.eq(log.faults.length, 0);
    a.eq(c.done, false);
  });

  t.test('таймер стоит, пока глаза открыты', (a) => {
    const { c, run } = setup();
    run(3000, open);
    a.eq(c.count, 0, 'глаза открыты с самого старта');
    run(6000);
    a.near(c.count, 3, 0.11);
    const before = c.count;
    run(7500, open);
    a.near(c.count, before, 0.06, 'во время открытых глаз');
  });

  t.test('done: набрал цель в секундах', (a) => {
    const { c, run } = setup(10);
    run(9900);
    a.eq(c.done, false);
    run(10200);
    a.eq(c.done, true);
    a.eq(Math.floor(c.count), 10);
  });

  // ─── Первые 5 секунд ───────────────────────────────────────

  t.test('grace: первые 5 с нарушения не считаются, дальше отсчёт с конца grace', (a) => {
    const { c, run, codes } = setup();
    run(4900, open);
    run(4950, two);
    run(5000, open);
    a.eq(codes().length, 0, 'в первые 5 с');
    a.eq(c.lives, 3);
    run(6950, open);
    a.eq(codes().length, 0, 'после grace ещё не прошло 2 с');
    run(7050, open);
    a.deep(codes(), ['eyes_open']);
    a.eq(c.lives, 2);
  });

  t.test('grace: подсказка «Закрой глаза и замри» сразу, голос через секунду, после grace убирается', (a) => {
    const { run, log } = setup();
    a.eq(log.hints[0].text, 'Закрой глаза и замри');
    a.eq(log.hints[0].speak, false);
    run(900);
    a.eq(log.says.length, 0);
    run(1100);
    a.deep(log.says, ['Закрой глаза и замри']);
    a.ok(!log.clears.includes('med_intro'));
    run(5100);
    a.ok(log.clears.includes('med_intro'));
  });

  t.test('grace: движение головой в первые 5 с не штрафуется', (a) => {
    const { run, codes } = setup();
    run(4800, (ms) => ({ faces: [face(0.3 + (ms % 1000) / 2500)], blendshapes: [CLOSED] }));
    run(8000);
    a.eq(codes().length, 0);
  });

  // ─── Глаза открыты ─────────────────────────────────────────

  t.test('глаза открыты ≥ 2 с: минус жизнь, подсказка текстом и звуком, событие fault', (a) => {
    const { c, run, log, codes } = setup();
    run(10000);
    run(11900, open);
    a.eq(codes().length, 0, '1.9 с ещё можно');
    run(12100, open);
    a.deep(codes(), ['eyes_open']);
    a.eq(c.lives, 2);
    const f = log.faults[0];
    a.eq(f.text, 'Глаза открыты, закрой глаза');
    a.deep(f.joints, []);
    a.eq(f.lives, 2);
    const h = log.hints.find((x) => x.code === 'eyes_open');
    a.eq(h.text, 'Глаза открыты, закрой глаза');
    a.eq(h.level, 'warn');
    a.ok(h.speak !== false, 'звук ошибки не заглушён');
    a.ok(log.hints.filter((x) => x.code === 'eyes_open' && x.speak !== false).length === 1, 'звук один раз, пока не исправил');
  });

  t.test('одно и то же нарушение не списывает жизни подряд, пока его не исправили', (a) => {
    const { c, run, log, codes } = setup();
    run(8000);
    run(20000, open);
    a.deep(codes(), ['eyes_open'], '12 с с открытыми глазами = одно нарушение');
    a.eq(c.lives, 2);
    run(20500);
    run(23000, open);
    a.deep(codes(), ['eyes_open'], 'закрыл на 0.5 с: ещё не исправил');
    a.ok(log.clears.includes('eyes_open'), 'подсказка уходит, как только закрыл');
    run(24500);
    run(26700, open);
    a.deep(codes(), ['eyes_open', 'eyes_open'], 'закрыл на 1.5 с, открыл снова на 2 с');
    a.eq(c.lives, 1);
  });

  t.test('моргание не сбрасывает счёт открытых глаз', (a) => {
    const { run, codes } = setup();
    run(8000);
    run(9000, open);
    run(9150);
    run(10150, open);
    a.deep(codes(), ['eyes_open'], '2 с с открытыми глазами, посередине моргнул');
  });

  // ─── Голова двигается ──────────────────────────────────────

  t.test('голова: нос сместился больше 4% ширины за 1 с = нарушение, таймер стоит', (a) => {
    const { c, run, log, codes } = setup();
    run(8000);
    const moved = (ms) => {
      const k = Math.min(1, Math.max(0, (ms - 8000) / 300));
      return { faces: [face(0.5 + 0.06 * k)], blendshapes: [CLOSED] };
    };
    const before = c.count;
    run(8150, moved);
    a.eq(codes().length, 0);
    run(8800, moved);
    a.deep(codes(), ['head_moving']);
    a.eq(log.faults[0].text, 'Голова двигается, замри');
    run(9200, moved);
    a.ok(c.count - before < 0.3, `таймер стоит, пока нос далеко от места секунду назад (${(c.count - before).toFixed(2)} с)`);
    run(12000, moved);
    a.ok(c.count - before > 2.2, 'замер: таймер снова идёт');
    a.eq(c.lives, 2);
  });

  t.test('голова: мелкое дрожание и медленный дрейф не нарушение', (a) => {
    const { c, run, codes } = setup();
    run(20000, (ms) => ({ faces: [face(0.5 + 0.004 * Math.sin(ms / 37) + ms * 0.000001)], blendshapes: [CLOSED] }));
    a.eq(codes().length, 0);
    a.near(c.count, 20, 0.06);
  });

  t.test('голова: одиночный скачок точек на кадр не нарушение', (a) => {
    const { run, codes } = setup();
    run(8000);
    run(8050, () => ({ faces: [face(0.62)], blendshapes: [CLOSED] }));
    run(12000);
    a.eq(codes().length, 0);
  });

  // ─── Лицо пропало ──────────────────────────────────────────

  t.test('лицо пропало ≥ 2 с = нарушение, меньше 2 с нет', (a) => {
    const { c, run, log, codes } = setup();
    run(8000);
    run(9500, empty);
    run(10500);
    run(12000, empty);
    run(13000);
    a.eq(codes().length, 0, 'дважды по 1.5 с');
    const before = c.count;
    run(15100, empty);
    a.deep(codes(), ['face_lost']);
    a.eq(log.faults[0].text, 'Лицо вышло из кадра, вернись');
    a.near(c.count, before, 1e-9, 'без лица таймер стоит');
  });

  t.test('лицо вернулось в другом месте: не движение головы', (a) => {
    const { run, codes } = setup();
    run(8000);
    run(9000, empty);
    run(14000, () => ({ faces: [face(0.25)], blendshapes: [CLOSED] }));
    a.eq(codes().length, 0);
  });

  // ─── Второй человек ────────────────────────────────────────

  t.test('два лица ≥ 1 с = нарушение, меньше нет; таймер стоит сразу', (a) => {
    const { c, run, log, codes } = setup();
    run(8000);
    const before = c.count;
    run(8800, two);
    a.eq(codes().length, 0);
    a.near(c.count, before, 1e-9, 'второе лицо: таймер стоит');
    run(10000);
    run(11100, two);
    a.deep(codes(), ['two_faces']);
    a.eq(log.faults[0].text, 'В кадре второй человек, ты должен быть один');
  });

  t.test('два лица меняются местами в выдаче модели: голова не «прыгает»', (a) => {
    const { c, run, codes } = setup();
    run(8000, () => ({ faces: [face(0.35)], blendshapes: [CLOSED] }));
    run(8800, (ms) => {
      const A = face(0.35);
      const B = face(0.75, 0.5, 0.07);
      return (ms / STEP) % 2 ? { faces: [A, B], blendshapes: [CLOSED, OPEN] } : { faces: [B, A], blendshapes: [OPEN, CLOSED] };
    });
    a.eq(c.view.moving, false);
    a.eq(c.view.closed, true, 'глаза берём у главного лица');
    a.eq(codes().length, 0);
  });

  // ─── Жизни, пауза между нарушениями, итоги ─────────────────

  t.test('3 разных нарушения: 0 жизней, провал чуть позже, дальше кадры не считаются', (a) => {
    const { c, run, codes } = setup();
    const at = (x) => () => ({ faces: [face(x)], blendshapes: [CLOSED] });
    run(6000);
    run(8200, open); // 1: глаза открыты с 6.1 с, жизнь на 8.1 с
    run(12000);
    run(12200, (ms) => ({ faces: [face(0.5 + 0.08 * Math.min(1, (ms - 12000) / 200))], blendshapes: [CLOSED] }));
    run(13500, at(0.58)); // 2: голова, жизнь на ~12.5 с
    a.deep(codes(), ['eyes_open', 'head_moving']);
    run(15600, () => ({ faces: [face(0.58), face(0.2, 0.5, 0.06)], blendshapes: [CLOSED, OPEN] })); // 3: второй человек, ждёт паузу до 15.5 с
    a.deep(codes(), ['eyes_open', 'head_moving', 'two_faces']);
    a.eq(c.lives, 0);
    a.eq(c.failed, false, 'сразу не проваливаем: подсказку должны увидеть и услышать');
    run(15600 + M.failDelayMs, open);
    a.eq(c.failed, true);
    const count = c.count;
    run(25000, empty);
    a.eq(codes().length, 3);
    a.eq(c.count, count);
    a.eq(c.lives, 0);
  });

  t.test('после нарушения 3 с на исправление: другое нарушение ждёт', (a) => {
    const { c, run, codes } = setup();
    run(8000);
    run(10000, open); // глаза открыты с 8.1 с: жизнь на 10.1 с
    const twoOpen = () => ({ faces: [face(), face(0.8, 0.5, 0.07)], blendshapes: [OPEN, OPEN] });
    run(12900, twoOpen); // второе лицо с 10.05 с: готово на 11.05 с, но ждёт паузу до 13.1 с
    a.deep(codes(), ['eyes_open']);
    run(13100, twoOpen);
    a.deep(codes(), ['eyes_open', 'two_faces']);
    a.eq(c.lives, 1);
  });

  t.test('исправил во время паузы: второе нарушение не списывается', (a) => {
    const { c, run, codes } = setup();
    run(8000);
    run(10200, open); // жизнь на 10.1 с, пауза до 13.1 с
    run(11500, two); // второе лицо 1.3 с, но ушло до конца паузы
    run(16000);
    a.deep(codes(), ['eyes_open']);
    a.eq(c.lives, 2);
  });

  t.test('кадры пропали на 3 с (камера, вкладка): время не засчитано, штрафа нет', (a) => {
    const { c, run, frameAt, codes } = setup();
    run(8000);
    run(9500, open);
    frameAt(12500, open); // 3 с без кадров
    run(13400, open);
    a.eq(codes().length, 0, 'окно открытых глаз началось заново после разрыва');
    run(16000);
    a.ok(c.count < 8 + 2.7, `разрыв не засчитан в таймер (${c.count.toFixed(2)} с)`);
  });

  t.test('разрыв кадров при спокойном лице не добавляет времени', (a) => {
    const { c, run, frameAt } = setup();
    run(8000);
    const b = c.count;
    frameAt(11000, calm); // 3 с без кадров
    a.near(c.count, b, 1e-9, 'разрыв не засчитан');
    run(12000);
    a.near(c.count - b, 1, 0.06, 'после разрыва таймер идёт как обычно');
  });

  // ─── Находки ревью ─────────────────────────────────────────

  t.test('новое нарушение под старшей подсказкой: своя подсказка и звук сразу', (a) => {
    const { c, run, log, codes } = setup();
    run(8000);
    const twoOpen = () => ({ faces: [face(), face(0.8, 0.5, 0.07)], blendshapes: [OPEN, OPEN] });
    run(9100, two); // второй человек: жизнь на 9.0 с, остаётся в кадре
    const clearsBefore = log.clearNow;
    run(12100, twoOpen); // глаза открыты с ~9.15 с: ждут паузу до 12.0 с
    a.deep(codes(), ['two_faces', 'eyes_open']);
    a.eq(c.lives, 1);
    const at = log.faults[1] && log.hints.findIndex((h) => h.code === 'eyes_open');
    const h = log.hints[at];
    a.ok(h && h.priority > 3 && h.speak !== false, 'подсказка глаз выше старшей и со звуком');
    a.ok(log.clearNow > clearsBefore, 'старую подсказку убрали сразу');
    const during = log.hints.filter((x) => x.code === 'two_faces' && x.at > h.at && x.at < h.at + M.freshHintMs);
    a.eq(during.length, 0, 'пока свежая подсказка на экране, старшая её не перебивает');
    run(14500, twoOpen);
    const back = log.hints.filter((x) => x.code === 'two_faces' && x.at >= h.at + M.freshHintMs);
    a.ok(back.length > 0 && back.every((x) => x.speak === false), 'потом старшая возвращается, но без звука');
  });

  t.test('лицо пропало: это не «исправил» глаза, вторую жизнь за них не списываем', (a) => {
    const { c, run, codes } = setup();
    run(8000);
    run(10500, open); // глаза: жизнь на ~10.1 с
    run(11700, empty); // лица нет 1.2 с (меньше 2 с)
    run(15000, open); // вернулся с открытыми глазами
    a.deep(codes(), ['eyes_open']);
    a.eq(c.lives, 2);
  });

  t.test('сценарий жюри: открыл глаза, вышел из кадра, вернулся с открытыми', (a) => {
    const { c, run, codes } = setup();
    run(10000);
    run(13000, open);
    run(16000, empty);
    run(20000, open);
    a.deep(codes(), ['eyes_open', 'face_lost']);
    a.eq(c.lives, 1);
    a.eq(c.failed, false);
  });

  t.test('второй человек в кадре, модель на кадр потеряла медитирующего: слежка не переходит на чужое лицо', (a) => {
    const { c, run, codes } = setup();
    const me = () => face(0.45);
    const other = () => face(0.8, 0.5, 0.06);
    run(8000, () => ({ faces: [me()], blendshapes: [CLOSED] }));
    run(10000, () => ({ faces: [me(), other()], blendshapes: [CLOSED, OPEN] }));
    run(10150, () => ({ faces: [other()], blendshapes: [OPEN] })) // 3 кадра видно только второго
    run(15000, () => ({ faces: [other(), me()], blendshapes: [OPEN, CLOSED] }));
    run(20000, () => ({ faces: [me()], blendshapes: [CLOSED] }));
    a.deep(codes(), ['two_faces'], 'ни глаз, ни головы: медитирующий не открывал глаза и не двигался');
    a.eq(c.lives, 2);
    a.eq(c.view.closed, true);
  });

  t.test('одинокое чужое лицо держится 2 с: засчитываем пропажу лица и дальше следим за ним', (a) => {
    const { c, run, codes } = setup();
    run(8000, () => ({ faces: [face(0.45)], blendshapes: [CLOSED] }));
    run(9000, () => ({ faces: [face(0.45), face(0.8, 0.5, 0.06)], blendshapes: [CLOSED, OPEN] }));
    run(13000, () => ({ faces: [face(0.8, 0.5, 0.06)], blendshapes: [CLOSED] }));
    a.ok(codes().includes('face_lost'), 'медитирующего не видно 2 с');
    a.ok(!codes().includes('head_moving'), 'переход к другому лицу не движение головы');
    a.eq(c.view.primary, 0);
  });

  t.test('голова двигается без остановки, посередине разрыв кадров: одна жизнь', (a) => {
    const { run, frameAt, codes } = setup();
    const drift = (ms) => ({ faces: [face(0.3 + 0.08 * Math.max(0, ms - 8000) / 1000)], blendshapes: [CLOSED] });
    run(8000);
    run(10000, drift);
    frameAt(10800, drift); // 800 мс без кадров
    run(14000, drift);
    a.deep(codes(), ['head_moving']);
  });

  t.test('кадр без лица не сбивает гистерезис: мягко закрытые глаза остаются закрытыми', (a) => {
    const { c, run, codes } = setup();
    const band = M.eyesClosedMin - M.eyesHysteresis / 2; // внутри гистерезиса: закрытыми держит только он
    const soft = { eyeBlinkLeft: band, eyeBlinkRight: band };
    const firm = { eyeBlinkLeft: 0.7, eyeBlinkRight: 0.7 };
    run(8000, () => ({ faces: [face()], blendshapes: [firm] }));
    run(12000, () => ({ faces: [face()], blendshapes: [soft] }));
    const b = c.count;
    run(12050, empty);
    run(20000, () => ({ faces: [face()], blendshapes: [soft] }));
    a.eq(codes().length, 0);
    a.ok(c.count - b > 7.5, `таймер идёт (${(c.count - b).toFixed(2)} с)`);
  });

  t.test('summary: нарушения по видам с количеством для итогов', (a) => {
    const { c, run } = setup();
    run(8000);
    run(10100, open);
    run(12000);
    run(14100, open);
    run(20000);
    run(22200, empty);
    const s = c.summary();
    a.deep(s.faults, [
      { code: 'eyes_open', text: 'глаза открыты', count: 2 },
      { code: 'face_lost', text: 'лицо вышло из кадра', count: 1 },
    ]);
    a.deep(s.rejected, []);
    a.eq(s.extra.lives, 0);
    a.eq(s.extra.maxLives, 3);
    a.ok(s.extra.bestStreakSec >= 5.8, 'самый долгий спокойный отрезок');
  });

  t.test('для отрисовки: started, target, данные лица кадра и главное лицо', (a) => {
    const { c, run } = setup(60);
    a.eq(c.started, true);
    a.eq(c.target, 60);
    run(1000, () => ({ faces: [face(0.75, 0.5, 0.05), face()], blendshapes: [OPEN, CLOSED] }));
    a.eq(c.faceData.faces.length, 2);
    a.eq(c.view.primary, 1, 'главное: крупное лицо');
    a.eq(c.view.faces, 2);
    run(2000, empty);
    a.eq(c.view.primary, -1);
    a.eq(c.view.closed, null);
  });

  t.test('контракт: модель лица, единица секунды, жизни', (a) => {
    const { c } = setup();
    a.eq(c.model, 'face');
    a.eq(c.unit, 'секунды');
    a.eq(c.lives, M.lives);
    a.eq(c.maxLives, M.lives);
    a.eq(typeof c.stop, 'function');
  });

  // ─── ready: «Встань в позицию» до отсчёта ──────────────────

  t.test('ready: лицо в кадре и в кадре только ты, чистая проверка до старта', (a) => {
    const seen = { hints: 0, faults: 0, clears: 0 };
    const c = createController({
      challenge: { target: 60 },
      bus: { emit: () => (seen.faults += 1) },
      feedback: { hint: () => (seen.hints += 1), clear: () => (seen.clears += 1), clearNow: () => (seen.clears += 1), say: () => (seen.hints += 1) },
      debug: { enabled: false, set() {} },
    });
    const at = (faces) => ({ t: T0, ran: 'face', width: W, height: H, face: { t: T0, faces, blendshapes: faces.map(() => OPEN) } });
    const byId = (r) => Object.fromEntries(r.checks.map((k) => [k.id, k.ok]));
    a.eq(typeof c.ready, 'function');

    const none = c.ready(at([]));
    a.eq(none.ok, false);
    a.deep(byId(none), { face: false, alone: false }, 'никого нет: обе галочки не стоят');

    const one = c.ready(at([face()]));
    a.eq(one.ok, true);
    a.deep(one.checks.map((k) => [k.id, k.text]), [['face', 'Лицо в кадре'], ['alone', 'В кадре только ты']]);

    const duo = c.ready(at([face(), face(0.8, 0.5, 0.07)]));
    a.eq(duo.ok, false);
    a.deep(byId(duo), { face: true, alone: false }, 'второй человек: лицо есть, но ты не один');

    a.eq(c.ready(at([face(1.02, 0.45)])).ok, false, 'нос за краем кадра: лица в кадре нет');
    a.eq(c.ready({ t: T0, ran: 'face', width: W, height: H, face: null }).ok, false, 'модель ещё не ответила');
    a.eq(c.ready(undefined).ok, false);
    for (const r of [none, one, duo]) for (const k of r.checks) a.ok(k.text.length <= 22, `текст до 22 символов: ${k.text}`);

    // чистая проверка: ни событий, ни подсказок, ни счёта, ни жизней, старт не начат
    a.deep(seen, { hints: 0, faults: 0, clears: 0 });
    a.eq(c.count, 0);
    a.eq(c.lives, M.lives);
    a.eq(c.started, false);
  });

  t.test('ready между кадрами ничего не меняет: те же счёт, жизни и нарушения', (a) => {
    const plain = setup();
    plain.run(12000, open);
    const probed = setup();
    probed.run(12000, () => {
      const s = open();
      probed.c.ready({ t: 0, ran: 'face', width: W, height: H, face: { t: 0, faces: s.faces, blendshapes: s.blendshapes } });
      return s;
    });
    a.deep(plain.codes(), ['eyes_open']);
    a.eq(probed.c.count, plain.c.count);
    a.eq(probed.c.lives, plain.c.lives);
    a.deep(probed.codes(), plain.codes());
  });
};
