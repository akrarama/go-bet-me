// Тесты блока 4 (Медитация): глаза, неподвижность, лица, жизни, таймер. Синтетические кадры, без камеры.

import { MEDITATION as M, MONEY } from '../src/config.js';
import { FACE, blink, eyesClosed, faceCount, nose, noseTracker, primaryIndex, shiftW, syntheticFace } from '../src/vision/face.js';
import { createController } from '../src/exercises/meditation.js';
import friend, {
  REACTIONS, betOptions, connectView, createStubGuest, describeChallenge, goalText, initialState, kr, linkOf, lobbyView, plural, progressText,
  reduce, resultView, timerView, videoView, voidView, lostView,
} from '../src/screens/friend.js';

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

  // ─── FRIEND: экран друга (screens/friend.js), логика без DOM ──

  const CH = { id: 'c1', type: 'squat', target: 15, limitSec: 90, stake: 10 };
  const HOST_BET = { id: 'bot-dima', name: 'Дима', avatar: '🧔', amount: 5, bot: true };
  const msg = (S, m, now = 0) => reduce(S, { type: 'msg', msg: m, now });
  const lobbyOf = (S, over = {}) => msg(S, { t: 'lobby', challenge: CH, left: 5, bets: [HOST_BET], ...over });

  t.test('friend: деньги и слова: kr, plural, goalText', (a) => {
    a.eq(kr(5), '5 кр.');
    a.eq(kr(4.5), '4,5 кр.');
    a.eq(kr(NaN), '0 кр.');
    a.eq(kr(Infinity), '0 кр.');
    a.eq(kr('7'), '0 кр.', 'строка вместо числа: не верим');
    const rep = (n) => plural(n, 'повтор', 'повтора', 'повторов');
    a.deep([1, 2, 5, 11, 12, 21, 22, 25].map(rep), ['повтор', 'повтора', 'повторов', 'повторов', 'повторов', 'повтор', 'повтора', 'повторов']);
    a.eq(goalText('повторы', 15), '15 повторов');
    a.eq(goalText('секунды', 60), '1 минута');
    a.eq(goalText('секунды', 300), '5 минут');
    a.eq(goalText('секунды', 600), '10 минут');
    a.eq(goalText('секунды', 180), '3 минуты');
    a.eq(goalText('секунды', 1800), '30 минут');
    a.eq(goalText('секунды', 45), '45 секунд', 'меньше минуты: секунды');
    a.eq(goalText('секунды', 61), '61 секунда', 'не целые минуты: секунды, а не округление');
    a.eq(goalText('секунды', 90), '90 секунд');
    a.eq(progressText('секунды', 44.6, 300), '00:44 из 05:00', 'время в итоге как у игрока');
    a.eq(progressText('повторы', 6.9, 15), '6 из 15 повторов');
  });

  t.test('friend: статусы связи от peer.js приводятся к четырём', (a) => {
    a.deep(['open', 'connected', 'ready', 'OPEN'].map(linkOf), ['open', 'open', 'open', 'open']);
    a.deep(['error', 'failed', 'peer-unavailable'].map(linkOf), ['error', 'error', 'error']);
    a.deep(['closed', 'disconnected', 'lost'].map(linkOf), ['closed', 'closed', 'closed']);
    a.deep(['connecting', '', undefined, 'что-то новое'].map(linkOf), ['connecting', 'connecting', 'connecting', 'connecting']);
  });

  t.test('friend: подключение → лобби → ставка → старт → счёт и ошибки → итог', (a) => {
    let S = initialState('h1');
    a.eq(S.phase, 'connecting');
    S = reduce(S, { type: 'status', status: 'open' });
    a.eq(S.link, 'open');
    a.eq(S.phase, 'connecting', 'связь есть, условий ещё нет');
    S = lobbyOf(S);
    a.eq(S.phase, 'lobby');
    a.eq(S.left, 5);
    a.deep(S.bets, [HOST_BET]);
    S = reduce(S, { type: 'wallet', balance: 100, delta: 0 });
    S = reduce(S, { type: 'bet:sent', amount: 5 });
    a.eq(S.pending, 5);
    S = msg(S, { t: 'bet:ok', amount: 5 });
    a.eq(S.myBet, 5);
    a.eq(S.pending, null);
    a.eq(S.notice.tone, 'ok');
    S = msg(S, { t: 'start', challenge: CH, bets: [HOST_BET] }, 5000);
    a.eq(S.phase, 'live');
    a.eq(S.startedAt, 5000);
    a.eq(S.target, 15);
    a.eq(S.unit, 'повторы');
    S = msg(S, { t: 'count', count: 4, target: 15, unit: 'повторы' });
    S = msg(S, { t: 'fault', text: 'Колени выходят за носки' });
    S = msg(S, { t: 'rejected', text: 'недостаточная глубина' });
    a.eq(S.count, 4);
    a.deep(S.feed.map((f) => [f.kind, f.text]), [['fault', 'Колени выходят за носки'], ['rejected', 'недостаточная глубина']]);
    S = msg(S, { t: 'end', success: false, count: 6, target: 15, you: { amount: 5, delta: 4.5 } });
    a.eq(S.phase, 'result');
    const v = resultView(S);
    a.eq(v.title, 'Не сделал');
    a.eq(v.detail, '6 из 15 повторов');
    a.eq(v.deltaText, '+4,5 кр.');
    a.eq(v.deltaTone, 'up');
    a.eq(v.line, 'Ты выиграл: игрок не справился');
    a.eq(v.showDelta, true);
  });

  t.test('friend: итог проигрыша, зрителя без ставки и отмена раунда', (a) => {
    let S = lobbyOf(initialState('h'));
    S = msg(S, { t: 'bet:ok', amount: 5 });
    S = msg(S, { t: 'start', challenge: CH }, 0);
    let lost = msg(S, { t: 'end', success: true, count: 15, target: 15, you: { amount: 5, delta: -5 } });
    a.deep([resultView(lost).title, resultView(lost).deltaText, resultView(lost).deltaTone, resultView(lost).line], ['Сделал', '−5 кр.', 'down', 'Ты проиграл: игрок справился']);
    const watcher = msg(lobbyOf(initialState('w')), { t: 'end', success: true, count: 15, target: 15 });
    const w = resultView(watcher);
    a.eq(w.showDelta, false);
    a.eq(w.line, 'Ты смотрел без ставки');
    const cancelled = msg(S, { t: 'void', reason: 'camera' });
    a.eq(cancelled.phase, 'void');
    a.deep([voidView(cancelled).detail, voidView(cancelled).line], ['У игрока пропала камера', 'Ставка вернулась']);
    a.eq(voidView(msg(lobbyOf(initialState('w')), { t: 'void', reason: 'constructor' })).detail, 'Игрок прервал челлендж', 'чужие ключи словаря не берём');
  });

  t.test('friend: кнопки ставки учитывают остаток пула, баланс и уже сделанную ставку', (a) => {
    const S = { ...lobbyOf(initialState('h')), balance: 100 };
    const state = (o) => betOptions(o).map((x) => x.reason);
    a.deep(state(S), [null, 'left', 'left'], 'в пуле осталось 5: влезает только 5');
    a.deep(state({ ...S, left: 0 }), ['full', 'full', 'full']);
    a.deep(state({ ...S, left: 20, balance: 7 }), [null, 'balance', 'balance']);
    a.deep(state({ ...S, left: 20 }), [null, null, null]);
    a.deep(state({ ...S, left: 20, pending: 10 }), ['pending', 'pending', 'pending']);
    const placed = betOptions({ ...S, left: 20, myBet: 10 });
    a.deep(placed.map((x) => x.disabled), [true, true, true]);
    a.deep(placed.map((x) => x.selected), [false, true, false]);
    a.deep(betOptions(S).map((x) => x.amount), [5, 10, 20]);
  });

  t.test('friend: пул полон, ответ на ставку не пришёл, подсказка под кнопками', (a) => {
    let S = { ...lobbyOf(initialState('h'), { left: 20 }), balance: 100 };
    S = reduce(S, { type: 'bet:sent', amount: 20 });
    S = msg(S, { t: 'bet:full', left: 5 });
    a.eq(S.pending, null);
    a.eq(S.left, 5);
    a.eq(lobbyView(S).notice.text, 'Осталось только 5 кр., выбери меньше');
    a.eq(lobbyView(msg(S, { t: 'bet:full', left: 0 })).notice.text, 'Пул полон');
    const waiting = reduce(S, { type: 'bet:sent', amount: 5 });
    const late = reduce(waiting, { type: 'bet:timeout' });
    a.eq(late.pending, null);
    a.eq(late.notice.text, 'Ответа нет, попробуй ещё раз');
    a.eq(reduce(S, { type: 'bet:timeout' }), S, 'ставки в пути нет: ничего не меняем');
    // новое лобби гасит предупреждение про остаток, но не «Ставка принята»
    a.eq(lobbyOf(S, { left: 10 }).notice, null);
    a.eq(lobbyOf(msg(S, { t: 'bet:ok', amount: 5 })).notice.tone, 'ok');
    a.eq(lobbyView({ ...lobbyOf(initialState('h')), left: 0 }).notice.text, 'Пул полон, можно только смотреть');
    a.eq(lobbyView({ ...lobbyOf(initialState('h'), { left: 20 }), balance: 3 }).notice.text, 'Обнови страницу, чтобы пополнить кредиты');
  });

  t.test('friend: следующий раунд приходит с новым челленджем, тот же id итог не убирает', (a) => {
    let S = msg(lobbyOf(initialState('h')), { t: 'bet:ok', amount: 5 });
    S = msg(S, { t: 'start', challenge: CH }, 0);
    S = msg(S, { t: 'end', success: false, count: 3, target: 15, you: { amount: 5, delta: 4.5 } });
    const same = lobbyOf(S);
    a.eq(same.phase, 'result', 'то же лобби: итог остаётся на экране');
    const next = lobbyOf(S, { challenge: { ...CH, id: 'c2', type: 'pushup', target: 20, limitSec: 120 } });
    a.eq(next.phase, 'lobby');
    a.eq(next.myBet, null, 'новая ставка на новый раунд');
    a.eq(next.result, null);
    a.deep(next.feed, []);
    a.eq(lobbyView(next).title, '💪 Отжимания: 20 повторов');
    a.deep(lobbyView(next).facts, ['⏱ 02:00', 'Ставка игрока 10 кр.']);
    // раунд идёт: лобби с тем же id не выбрасывает из эфира
    const live = msg(lobbyOf(initialState('h')), { t: 'start', challenge: CH }, 0);
    a.eq(lobbyOf(live).phase, 'live');
  });

  t.test('friend: пришёл посреди раунда: первый счёт открывает эфир, поздний счёт итог не сбрасывает', (a) => {
    const S = msg(lobbyOf(initialState('h')), { t: 'count', count: 7, target: 15, unit: 'повторы' }, 42000);
    a.eq(S.phase, 'live');
    a.eq(S.startedAt, 42000);
    a.eq(S.count, 7);
    const joined = msg(initialState('h'), { t: 'fault', text: 'Таз провисает' }, 1000);
    a.eq(joined.phase, 'live');
    const done = msg(S, { t: 'end', success: true, count: 15, target: 15 });
    a.eq(msg(done, { t: 'count', count: 15, target: 15 }).phase, 'result');
  });

  t.test('friend: ошибки игрока: не больше трёх, гаснут по одной', (a) => {
    let S = msg(lobbyOf(initialState('h')), { t: 'start', challenge: CH }, 0);
    for (const text of ['раз', 'два', 'три', 'четыре']) S = msg(S, { t: 'fault', text });
    a.deep(S.feed.map((f) => f.text), ['два', 'три', 'четыре']);
    const first = S.feed[0];
    S = reduce(S, { type: 'feed:drop', id: first.id });
    a.deep(S.feed.map((f) => f.text), ['три', 'четыре']);
    a.eq(msg(S, { t: 'fault', text: '' }).feed.length, 2, 'пустой текст не рисуем');
  });

  t.test('friend: связь: до условий обрыв это ошибка, потом плашка, «Повторить» возвращает', (a) => {
    let S = reduce(initialState('h'), { type: 'status', status: 'error' });
    a.eq(S.phase, 'error');
    a.eq(connectView(S).retry, true);
    a.eq(connectView(S).busy, false);
    a.eq(connectView({ ...S, errorKind: 'closed' }).text, 'Связь оборвалась. Проверь интернет и попробуй ещё раз');
    S = reduce(S, { type: 'retry' });
    a.eq(S.phase, 'connecting');
    a.eq(connectView(S).busy, true);
    const inLobby = reduce(lobbyOf(initialState('h')), { type: 'status', status: 'closed' });
    a.eq(inLobby.phase, 'lobby', 'лобби не пропадает');
    a.eq(inLobby.link, 'lost');
    a.eq(reduce(inLobby, { type: 'status', status: 'open' }).link, 'open');
    // долгое подключение: сначала подсказка, потом ошибка; когда связь есть, ни то ни другое
    const slow = reduce(initialState('h'), { type: 'slow' });
    a.eq(connectView(slow).text, 'Долго? Проверь, что игрок не закрыл страницу');
    a.eq(connectView(slow).retry, true);
    a.eq(reduce(initialState('h'), { type: 'giveup' }).phase, 'error');
    const open = reduce(initialState('h'), { type: 'status', status: 'open' });
    a.eq(reduce(open, { type: 'giveup' }).phase, 'connecting');
    a.eq(connectView(open).text, 'Жду условия челленджа');
    a.eq(reduce(lobbyOf(initialState('h')), { type: 'giveup' }).phase, 'lobby');
  });

  t.test('friend: таймер эфира считает назад с лимитом и вперёд без него', (a) => {
    const timed = { ...msg(lobbyOf(initialState('h')), { t: 'start', challenge: CH }, 1000) };
    a.deep(timerView(timed, 31000), { text: '01:00', low: false });
    a.deep(timerView(timed, 84000), { text: '00:07', low: true });
    a.eq(timerView(timed, 500000).text, '00:00', 'время вышло: не уходим в минус');
    const med = msg(lobbyOf(initialState('h'), { challenge: { id: 'm', type: 'meditation', target: 60, limitSec: null, stake: 10 } }), { t: 'start', challenge: { id: 'm', type: 'meditation', target: 60, limitSec: null, stake: 10 } }, 1000);
    a.deep(timerView(med, 31000), { text: '00:30', low: false });
    a.eq(describeChallenge(med.challenge).goal, '1 минута');
    a.eq(describeChallenge(med.challenge).time, null);
  });

  t.test('friend: кривые сообщения хоста не ломают состояние и режутся по длине', (a) => {
    let S = initialState('h');
    const bad = [
      undefined, null, 'строка', 42, {}, { t: 42 }, { t: '__proto__' },
      { t: 'lobby', challenge: 'нет', left: 'abc', bets: 'нет' },
      { t: 'lobby', challenge: { id: 5, type: '__proto__', target: 'много', stake: null, limitSec: 'нет' }, left: NaN, bets: [null, 5, { name: 'я'.repeat(100), avatar: '🙂'.repeat(20), amount: Infinity }] },
      { t: 'bet:ok', amount: 'много' }, { t: 'bet:full', left: {} },
      { t: 'start', challenge: { type: 'constructor' }, bets: 'нет' },
      { t: 'count', count: 'x', target: null, unit: { a: 1 } },
      { t: 'fault', text: 'я'.repeat(400) }, { t: 'fault', text: 42 }, { t: 'rejected' },
      { t: 'end', success: 'да', count: -5, target: 1e99, you: 'нет' },
      { t: 'void', reason: { x: 1 } },
    ];
    for (const m of bad) S = msg(S, m, 1);
    for (const key of ['left', 'count', 'target']) a.ok(Number.isFinite(S[key]) && S[key] >= 0, `${key} конечное число`);
    a.ok(S.target <= 1e9, 'огромное число обрезано');
    const S2 = msg(initialState('h'), { t: 'lobby', challenge: CH, left: 5, bets: [null, 5, { name: 'я'.repeat(100), avatar: '🙂'.repeat(20), amount: Infinity }] });
    a.eq(S2.bets.length, 1, 'ставки не объекты отброшены');
    a.eq(Array.from(S2.bets[0].name).length, 24);
    a.eq(Array.from(S2.bets[0].avatar).length, 6);
    a.eq(S2.bets[0].amount, 0, 'бесконечная сумма не верится');
    const fault = msg(msg(lobbyOf(initialState('h')), { t: 'start', challenge: CH }), { t: 'fault', text: 'я'.repeat(400) });
    a.eq(Array.from(fault.feed[0].text).length, 140);
    a.eq(describeChallenge({ type: '__proto__', target: 3 }).label, 'Челлендж');
    a.eq(describeChallenge({ type: 'constructor' }).emoji, '🎯');
    a.eq(reduce(S, { type: 'что-то новое' }), S);
  });

  t.test('friend: контракт экрана: без камеры и моделей, реакции для пальца', (a) => {
    a.eq(friend.model, 'none');
    a.eq(typeof friend.enter, 'function');
    a.eq(typeof friend.exit, 'function');
    a.eq(typeof friend.frame, 'function');
    a.eq(typeof friend.draw, 'function');
    a.ok(REACTIONS.length >= 2 && REACTIONS.length <= 3, '2-3 реакции');
    for (const r of REACTIONS) a.ok(r.label.length <= 10 && r.text.length <= 20, `короткая реакция: ${r.text}`);
    a.deep(initialState('id').hostId, 'id');
  });

  t.test('friend: заглушка вместо peer.js играет круг раунда теми же сообщениями', (a) => {
    const out = [];
    const ctx = { bus: { emit: (type, p) => out.push([type, p]) }, timeout: (fn) => fn(), debug: { log() {} } };
    const g = createStubGuest(ctx);
    let S = initialState('demo');
    const pump = () => {
      for (const [type, p] of out.splice(0)) {
        if (type === 'guest:status') S = reduce(S, { type: 'status', status: p.status });
        if (type === 'guest:msg') S = reduce(S, { type: 'msg', msg: p.msg, now: 0 });
        if (type === 'guest:wallet') S = reduce(S, { type: 'wallet', balance: p.balance, delta: p.delta });
      }
    };
    g.connect();
    pump();
    a.eq(S.phase, 'lobby');
    a.eq(S.balance, 100);
    a.eq(S.challenge.type, 'squat');
    g.bet(20);
    pump();
    a.eq(S.myBet, null, 'больше остатка: пул полон');
    a.ok(S.notice.text.startsWith('Осталось только 5'), S.notice?.text);
    g.bet(5);
    pump();
    a.eq(S.myBet, 5);
    g.step(); // старт: ставка списана
    pump();
    a.eq(S.phase, 'live');
    a.eq(S.balance, 95);
    g.step(); // счёт
    g.step(); // ошибка
    g.step(); // счёт
    g.step(); // не засчитан
    pump();
    a.ok(S.count > 0 && S.feed.length === 2, `счёт ${S.count}, ошибок ${S.feed.length}`);
    g.step(); // итог: игрок не справился, друг выиграл
    pump();
    a.eq(S.phase, 'result');
    a.eq(S.result.delta, 4.5);
    a.eq(S.balance, 104.5);
    g.step(); // новый раунд: другой челлендж, ставка сброшена
    pump();
    a.eq(S.phase, 'lobby');
    a.eq(S.myBet, null);
    a.eq(S.challenge.type, 'pushup');
    for (let i = 0; i < 3; i++) g.step(); // старт без ставки, счёт, итог: игрок справился
    pump();
    a.eq(S.phase, 'result');
    a.eq(resultView(S).showDelta, false);
    g.step(); // отмена
    pump();
    a.eq(S.phase, 'void');
    a.eq(typeof g.stop, 'function');
  });

  t.test('friend: на каждый ответ guest.bet свой понятный текст', (a) => {
    const S = { ...lobbyOf(initialState('h'), { left: 20 }), balance: 100 };
    const asked = reduce(S, { type: 'bet:sent', amount: 10 });
    a.eq(reduce(asked, { type: 'bet:result', result: 'sent' }), asked, 'sent: ждём ответ хоста');
    const text = (result, extra = {}) => {
      const next = reduce(asked, { type: 'bet:result', result, ...extra });
      a.eq(next.pending, null, `${result}: ставка не в пути`);
      a.eq(next.notice.tone, 'warn');
      return next.notice.text;
    };
    a.eq(text('closed'), 'Ставки закрыты');
    a.eq(text('repeat'), 'Ты уже поставил на этот раунд');
    a.eq(text('poor'), 'Не хватает кредитов');
    a.eq(text('offline'), 'Нет связи с игроком, попробуй ещё раз');
    a.eq(text('invalid'), 'Такую ставку сделать нельзя');
    a.eq(text(undefined), 'Нет связи с игроком, попробуй ещё раз', 'непонятный ответ: как будто связи нет');
    a.eq(text('constructor'), 'Нет связи с игроком, попробуй ещё раз', 'чужие ключи словаря не берём');
    const repeat = reduce(asked, { type: 'bet:result', result: 'repeat', myBet: 10 });
    a.eq(repeat.myBet, 10, 'ставка уже есть у хоста: показываем её');
    a.eq(reduce(asked, { type: 'bet:result', result: 'repeat', myBet: 'много' }).myBet, null);
  });

  t.test('friend: своя ставка из you.amount в лобби и старте', (a) => {
    const withYou = lobbyOf(initialState('h'), { you: { amount: 5 } });
    a.eq(withYou.myBet, 5);
    a.deep(lobbyView(withYou).notice, { tone: 'ok', text: 'Ставка принята' });
    a.deep(betOptions(withYou).map((x) => x.selected), [true, false, false]);
    a.eq(lobbyOf(withYou, { you: { amount: 0 } }).myBet, null, 'you.amount 0: без ставки');
    a.eq(lobbyOf(withYou).myBet, 5, 'you нет в сообщении: не забываем');
    a.eq(lobbyOf(withYou, { you: 'нет' }).myBet, 5, 'you не объект: не верим');
    const started = msg(lobbyOf(initialState('h')), { t: 'start', challenge: CH, you: { amount: 10 } }, 0);
    a.eq(started.myBet, 10);
    a.eq(msg(started, { t: 'start', challenge: CH, you: { amount: -3 } }, 0).myBet, null);
  });

  t.test('friend: заглушка отвечает на ставку как настоящий гость', (a) => {
    const out = [];
    const ctx = { bus: { emit: (type, p) => out.push([type, p]) }, timeout: (fn) => fn(), debug: { log() {} } };
    const g = createStubGuest(ctx);
    a.eq(g.bet(5), 'offline', 'раунда ещё нет');
    g.connect();
    g.money = 3;
    a.eq(g.bet(5), 'poor');
    g.money = 100;
    a.eq(g.bet(5), 'sent');
    a.eq(g.myBet, 5);
    a.eq(g.bet(5), 'repeat');
    g.step();
    a.eq(g.bet(5), 'closed', 'после старта ставки закрыты');
    const lobbyMsg = out.map(([, p]) => p?.msg).filter((m) => m?.t === 'lobby').pop();
    a.deep(lobbyMsg.you, { amount: 5 });
    a.eq(out.map(([, p]) => p?.msg).filter((m) => m?.t === 'start').pop().you.amount, 5);
  });

  t.test('friend: ставке от гостя верим больше, чем полю сообщения; поток видео может кончиться', (a) => {
    const lobby = { t: 'lobby', challenge: CH, left: 5, bets: [HOST_BET] };
    const withGuest = (S, m, myBet) => reduce(S, { type: 'msg', msg: m, now: 0, myBet });
    a.eq(withGuest(initialState('h'), { ...lobby, you: { amount: 5 } }, 10).myBet, 10, 'гость посчитал по списку ставок');
    a.eq(withGuest(initialState('h'), { ...lobby, you: { amount: 5 } }, 0).myBet, null, 'у гостя ставки нет');
    a.eq(withGuest(initialState('h'), { ...lobby, you: { amount: 5 } }, undefined).myBet, 5, 'гостя нет: берём you');
    a.eq(withGuest(initialState('h'), { t: 'count', count: 1, target: 15 }, 10).myBet, null, 'на count поле гостя не смотрим');
    const started = withGuest(lobbyOf(initialState('h')), { t: 'start', challenge: CH }, 5);
    a.eq(started.myBet, 5);
    let S = reduce(started, { type: 'stream' });
    a.eq(S.hasVideo, true);
    S = reduce(S, { type: 'stream:end' });
    a.eq(S.hasVideo, false, 'звонок кончился: снова «жду видео»');
    a.eq(reduce(S, { type: 'stream:end' }), S);
    // число в поле t это не вид сообщения
    a.eq(reduce(initialState('h'), { type: 'msg', msg: { t: 1699999999, type: 'lobby', challenge: CH, left: 5 }, now: 0 }).phase, 'lobby');
    a.eq(reduce(initialState('h'), { type: 'msg', msg: { t: 1699999999, challenge: CH, left: 5 }, now: 0 }).phase, 'connecting');
  });

  t.test('friend: пока видео нет: ждём, потом «не приходит», счёт идёт; пришло: заглушка уходит', (a) => {
    let S = msg(lobbyOf(initialState('h')), { t: 'start', challenge: CH }, 0);
    a.deep(videoView(S), { show: true, busy: true, title: 'Ждём видео игрока', text: '' });
    S = reduce(S, { type: 'video:late' });
    const late = videoView(S);
    a.eq(late.busy, false);
    a.eq(late.title, 'Видео не приходит');
    a.ok(late.text.includes('Счёт и ошибки идут и без видео'), late.text);
    S = msg(S, { t: 'count', count: 4, target: 15 });
    a.eq(S.count, 4, 'без видео счёт идёт');
    S = reduce(S, { type: 'stream' });
    a.eq(videoView(S).show, false);
    a.eq(S.videoLate, false, 'видео пришло: «не приходит» снято');
    // поздний таймер после прихода видео или вне эфира ничего не меняет
    a.eq(reduce(S, { type: 'video:late' }), S);
    a.eq(reduce(lobbyOf(initialState('h')), { type: 'video:late' }).videoLate, false);
    // видео шло и прервалось посреди эфира
    const cut = reduce(S, { type: 'stream:end' });
    a.deep([videoView(cut).title, videoView(cut).busy], ['Видео прервалось', false]);
    a.eq(reduce(cut, { type: 'video:late' }), cut, 'прервалось важнее, чем «не пришло»');
    // следующий раунд начинается с чистого ожидания
    const next = msg(cut, { t: 'start', challenge: { ...CH, id: 'c2' } }, 5);
    a.eq(videoView(next).title, 'Ждём видео игрока');
    // звонок кончился вне эфира (после финиша): в лобби никакого «прервалось»
    a.eq(reduce(lobbyOf(initialState('h')), { type: 'stream:end' }).videoEnded, false);
  });

  t.test('friend: игрок пропал посреди эфира: таймер стоит, через 4 с карточка, через 30 с «обнови страницу»', (a) => {
    let S = msg(lobbyOf(initialState('h')), { t: 'start', challenge: CH }, 1000);
    a.eq(lostView(S, 20000), null, 'связь есть: карточки нет');
    S = reduce(S, { type: 'status', status: 'closed', now: 11000 });
    a.eq(S.link, 'lost');
    a.eq(S.phase, 'live', 'эфир не пропадает: только плашка и карточка');
    a.eq(S.lostAt, 11000);
    a.eq(lostView(S, 13000), null, 'первые 4 с только плашка');
    const wait = lostView(S, 16000);
    a.eq(wait.title, 'Связь с игроком пропала');
    a.eq(wait.reload, false);
    a.ok(wait.text.includes('раунд не продолжится'), wait.text);
    const gone = lostView(S, 45000);
    a.eq(gone.title, 'Игрок не вернулся');
    a.eq(gone.reload, true);
    a.ok(gone.text.includes('ставка вернётся'), gone.text);
    // таймер замер на моменте пропажи: 10 с из 90 прошло, остаётся 01:20
    a.eq(timerView(S, 11000).text, '01:20');
    a.eq(timerView(S, 60000).text, '01:20');
    // повторный статус не сдвигает момент пропажи
    a.eq(reduce(S, { type: 'status', status: 'connecting', now: 20000 }).lostAt, 11000);
    // связь вернулась: таймер снова идёт по настоящему времени, карточка уходит
    const back = reduce(S, { type: 'status', status: 'open', now: 30000 });
    a.eq(back.lostAt, null);
    a.eq(lostView(back, 31000), null);
    a.eq(timerView(back, 31000).text, '01:00');
    // вне эфира момент пропажи не ведём
    a.eq(reduce(lobbyOf(initialState('h')), { type: 'status', status: 'closed', now: 5 }).lostAt, null);
    a.eq(lostView({ ...S, phase: 'result' }, 45000), null);
  });

  t.test('friend: понятный текст ошибки подключения по причине от peer.js', (a) => {
    const text = (error, kind = 'error') => connectView(reduce(initialState('h'), { type: 'status', status: kind, error, now: 0 })).text;
    a.eq(text('peer-unavailable'), 'Игрок не нашёлся. Проверь ссылку или попроси прислать новую');
    a.ok(text('timeout').startsWith('Игрок не отвечает. Проверь интернет'), text('timeout'));
    a.ok(text('lib').startsWith('Не загрузилась связь'), text('lib'));
    a.ok(text('socket-error').startsWith('Нет связи с сервером'), text('socket-error'));
    a.ok(text('network').startsWith('Нет связи с сервером'), text('network'));
    a.ok(text('browser-incompatible').includes('Chrome или Safari'), text('browser-incompatible'));
    a.eq(text('что-то новое'), 'Игрок не отвечает. Проверь ссылку или попроси прислать новую', 'неизвестная причина: общий текст');
    a.eq(text('constructor'), 'Игрок не отвечает. Проверь ссылку или попроси прислать новую', 'чужие ключи словаря не берём');
    a.eq(text(undefined, 'closed'), 'Связь оборвалась. Проверь интернет и попробуй ещё раз');
    a.eq(text({ x: 1 }), 'Игрок не отвечает. Проверь ссылку или попроси прислать новую', 'причина не строка');
  });

  t.test('friend: кнопки ставки те же, что принимает хост (MONEY.friend.bets)', (a) => {
    const S = { ...lobbyOf(initialState('h'), { left: 100 }), balance: 1000 };
    a.deep(betOptions(S).map((x) => x.amount), MONEY.friend.bets);
  });

  t.test('friend: новый челлендж в лобби сбрасывает ставку, «Ставка принята» и выбор кнопки', (a) => {
    let S = { ...lobbyOf(initialState('h'), { left: 20 }), balance: 100 };
    S = msg(S, { t: 'bet:ok', amount: 10 });
    a.deep([S.myBet, S.notice.text, lobbyView(S).notice.text], [10, 'Ставка принята', 'Ставка принята']);
    a.deep(betOptions(S).map((x) => x.selected), [false, true, false]);
    const next = lobbyOf(S, { challenge: { ...CH, id: 'c2' }, left: 20, bets: [] });
    a.eq(next.myBet, null);
    a.eq(next.notice, null, 'подсказка прошлого раунда не переезжает в новый');
    a.eq(lobbyView(next).notice, null);
    a.deep(betOptions(next).map((x) => [x.selected, x.disabled]), [[false, false], [false, false], [false, false]]);
    // то же лобби (пул поменялся): «Ставка принята» остаётся
    a.eq(lobbyOf(S, { left: 10 }).myBet, 10);
  });

  t.test('friend: игрок меняет условия: ставки выключены, вместо них карточка «подожди»', (a) => {
    const S = { ...lobbyOf(initialState('h'), { left: 20, note: 'setup' }), balance: 100 };
    a.eq(S.note, 'setup');
    a.eq(lobbyView(S).mode, 'setup');
    a.deep(betOptions(S).map((x) => x.reason), ['setup', 'setup', 'setup']);
    a.deep(lobbyView(S).notice, { tone: 'info', text: 'Игрок меняет условия, подожди' });
    // условия готовы: новое лобби снимает режим
    const ready = lobbyOf(S, { challenge: { ...CH, id: 'c2' }, left: 20, note: null });
    a.eq(lobbyView(ready).mode, 'open');
    a.deep(betOptions({ ...ready, balance: 100 }).map((x) => x.disabled), [false, false, false]);
    a.eq(lobbyOf(S, { note: { x: 1 } }).note, null, 'пометка не строка: не верим');
  });

  t.test('friend: игрок стартует: «ставки закрыты» вместо «Пул полон»', (a) => {
    const S = { ...lobbyOf(initialState('h'), { left: 0, open: false, note: 'starting' }), balance: 100 };
    a.eq(S.open, false);
    a.deep(lobbyView(S).notice, { tone: 'info', text: 'Игрок стартует, ставки закрыты' });
    a.deep(betOptions(S).map((x) => x.reason), ['closed', 'closed', 'closed']);
    a.eq(lobbyView(S).foot, '', 'нечего обещать: ставки закрыты');
    // ставки закрыты без пометки
    a.eq(lobbyView(lobbyOf(initialState('h'), { left: 5, open: false })).notice.text, 'Ставки закрыты');
    // моя ставка уже принята: подпись говорит, что игрок стартует
    const mine = msg({ ...lobbyOf(initialState('h'), { left: 5 }), balance: 100 }, { t: 'bet:ok', amount: 5 });
    const starting = lobbyOf(mine, { left: 0, open: false, note: 'starting' });
    a.deep(lobbyView(starting).notice, { tone: 'ok', text: 'Ставка принята' });
    a.eq(lobbyView(starting).foot, 'Ты поставил 5 кр. против. Игрок стартует');
    // сообщение bet:closed закрывает ставки
    const closed = msg({ ...lobbyOf(initialState('h'), { left: 5 }), balance: 100 }, { t: 'bet:closed' });
    a.deep([closed.open, closed.pending, lobbyView(closed).notice.text], [false, null, 'Ставки закрыты']);
    a.eq(lobbyOf(closed).open, true, 'новое лобби с open не false открывает ставки снова');
  });

  t.test('friend: игрок отключился (void left): ставка вернулась, кнопка «Повторить», следующего раунда нет', (a) => {
    let S = msg({ ...lobbyOf(initialState('h'), { left: 20 }), balance: 100 }, { t: 'bet:ok', amount: 5 });
    S = msg(S, { t: 'start', challenge: CH }, 0);
    const gone = msg(S, { t: 'void', reason: 'left' });
    a.eq(gone.phase, 'void');
    const v = voidView(gone);
    a.deep([v.title, v.detail, v.retry], ['Игрок отключился', 'Ставка вернулась. Попроси новую ссылку', true]);
    const noBet = msg(msg(lobbyOf(initialState('h')), { t: 'start', challenge: CH }, 0), { t: 'void', reason: 'left' });
    a.eq(voidView(noBet).detail, 'Попроси у игрока новую ссылку', 'без ставки про ставку не говорим');
    a.eq(voidView(msg(S, { t: 'void', reason: 'camera' })).retry, false, 'обычная отмена: ждём следующий раунд');
  });

  t.test('friend: пополнение кредитов: плашка на время, подсказка про пустой кошелёк', (a) => {
    let S = { ...lobbyOf(initialState('h'), { left: 20 }) };
    S = reduce(S, { type: 'wallet', balance: 3, delta: 0, reason: 'sync' });
    a.eq(S.topup, null);
    a.eq(lobbyView(S).notice.text, 'Обнови страницу, чтобы пополнить кредиты', 'меньше 5 кр. и пополнения не было');
    a.deep(betOptions(S).map((x) => x.reason), ['balance', 'balance', 'balance']);
    S = reduce(S, { type: 'wallet', balance: 100, delta: 97, reason: 'topup' });
    a.deep([S.topup, S.balance], [100, 100]);
    a.eq(lobbyView(S).notice, null, 'кредиты есть: подсказки нет');
    a.eq(reduce(S, { type: 'wallet', balance: 95, delta: -5, reason: 'hold' }).topup, 100, 'другая причина плашку не сбрасывает');
    S = reduce(S, { type: 'topup:drop' });
    a.eq(S.topup, null);
    a.eq(reduce(S, { type: 'topup:drop' }), S);
    // пополнили, но всё равно мало (кривые данные): подсказка не спорит с плашкой
    const low = reduce({ ...lobbyOf(initialState('h'), { left: 20 }) }, { type: 'wallet', balance: 2, reason: 'topup' });
    a.eq(lobbyView(low).notice, null);
  });

  t.test('friend: заглушка играет особые случаи лобби теми же сообщениями', (a) => {
    const out = [];
    const ctx = { bus: { emit: (type, p) => out.push([type, p]) }, timeout: (fn) => fn(), debug: { log() {} } };
    const g = createStubGuest(ctx);
    let S = initialState('demo');
    const pump = () => {
      for (const [type, p] of out.splice(0)) {
        if (type === 'guest:status') S = reduce(S, { type: 'status', status: p.status });
        if (type === 'guest:msg') S = reduce(S, { type: 'msg', msg: p.msg, now: 0, myBet: g.myBet });
        if (type === 'guest:wallet') S = reduce(S, { type: 'wallet', balance: p.balance, delta: p.delta, reason: p.reason });
      }
    };
    g.connect();
    pump();
    g.special(); // игрок меняет условия
    pump();
    a.eq(lobbyView(S).mode, 'setup');
    g.special(); // новый челлендж
    pump();
    a.eq(lobbyView(S).mode, 'open');
    g.special(); // игрок стартует
    pump();
    a.eq(lobbyView(S).notice.text, 'Игрок стартует, ставки закрыты');
    g.special(); // ставки закрыты
    pump();
    a.eq(S.open, false);
    g.special(); // пополнение
    pump();
    a.eq(S.topup, 100);
    g.special(); // игрок отключился
    pump();
    a.eq(S.phase, 'void');
    a.eq(voidView(S).retry, true);
  });

  t.test('ready: у непройденной галочки своя подсказка, верхняя подсказка от первой непройденной', (a) => {
    const c = createController({ challenge: { target: 60 }, bus: { emit() {} }, feedback: { hint() {}, clear() {}, clearNow() {}, say() {} }, debug: { enabled: false, set() {} } });
    const at = (faces) => ({ t: T0, ran: 'face', width: W, height: H, face: { t: T0, faces, blendshapes: faces.map(() => OPEN) } });
    const none = c.ready(at([]));
    a.ok(none.hint.includes('Лица не видно'), none.hint);
    a.eq(none.checks[0].hint, none.hint, 'подсказка первой галочки');
    a.eq(none.checks[1].hint, undefined, 'второй галочке нечего сказать: лица нет вообще');
    const edge = c.ready(at([face(1.02, 0.45)]));
    a.ok(edge.hint.includes('у края кадра'), edge.hint);
    const crowd = c.ready(at([face(), face(0.8, 0.5, 0.07)]));
    a.eq(crowd.checks[0].ok, true);
    a.ok(crowd.hint.includes('второй человек'), crowd.hint);
    a.eq(crowd.checks[1].hint, crowd.hint);
    const fine = c.ready(at([face()]));
    a.deep([fine.ok, fine.hint], [true, null]);
    a.eq(fine.checks.every((chk) => !('hint' in chk)), true, 'у пройденных галочек подсказки нет');
    for (const r of [none, edge, crowd]) a.ok(r.hint.length <= 70, `подсказка короткая: ${r.hint}`);
    a.eq(c.ready(undefined).hint, none.hint, 'кадра нет: как «лица не видно»');
  });

  t.test('виртуальное лицо: синтетические точки, глаза открыты и закрыты, нос на месте', (a) => {
    const closed = syntheticFace(0.4, 0.5, 0.9);
    const open = syntheticFace(0.4, 0.5, 0.05);
    a.eq(closed.length, 478);
    a.deep([closed[FACE.nose].x, +closed[FACE.nose].y.toFixed(3)], [0.4, 0.535]);
    const gap = (f) => f[FACE.leftEye.lower[4]].y - f[FACE.leftEye.upper[4]].y;
    a.ok(gap(open) > gap(closed) * 3, `открытый глаз шире закрытого (${gap(open).toFixed(4)} против ${gap(closed).toFixed(4)})`);
    // овал вокруг центра: по ширине примерно 0.156 кадра
    const xs = FACE.oval.map((i) => closed[i].x);
    a.near(Math.max(...xs) - Math.min(...xs), 0.156, 0.01);
    a.ok(closed.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
    a.eq(primaryIndex([closed, syntheticFace(0.8, 0.5, 0.9)], { x: 0.41, y: 0.5 }), 0, 'главное лицо ближе к прошлому носу');
  });

  t.test('виртуальное лицо по клавише f: контроллер видит лицо без человека в кадре, e n l y работают', (a) => {
    const keys = {};
    const seen = { faults: [] };
    const c = createController({
      challenge: { target: 60 },
      bus: { emit: (type, p) => type === 'fault' && seen.faults.push(p.code) },
      feedback: { hint() {}, clear() {}, clearNow() {}, say() {} },
      debug: { enabled: true, set() {}, key: (k, fn) => (keys[k] = fn) },
    });
    a.ok(['f', 'e', 'n', 'l', 'y'].every((k) => typeof keys[k] === 'function'), 'клавиши на месте');
    a.eq(keys.k, undefined, 'k занята у gestures в LOBBY: не трогаем');
    const empty = { t: T0, ran: 'face', width: W, height: H, face: { t: T0, faces: [], blendshapes: [] } };
    a.eq(c.ready(empty).ok, false, 'человека нет');
    keys.f();
    a.eq(c.ready(empty).ok, true, 'виртуальное лицо: обе галочки');
    keys.y();
    a.deep(c.ready(empty).checks.map((x) => x.ok), [true, false], 'второй человек');
    keys.y();
    keys.l();
    a.deep(c.ready(empty).checks.map((x) => x.ok), [false, false], 'лицо пропало');
    keys.l();
    let now = T0;
    const step = (ms) => {
      for (let i = 0; i < ms / STEP; i++) {
        now += STEP;
        c.frame({ t: now, ran: 'face', width: W, height: H, face: null }, now); // модель ничего не вернула
      }
    };
    c.start(T0);
    step(8000);
    a.ok(c.count > 6.5, `виртуальное лицо с закрытыми глазами: таймер идёт (${c.count.toFixed(1)} с)`);
    a.eq(c.view.faces, 1);
    a.deep(seen.faults, []);
    keys.e();
    keys.e(); // авто → закрыты → открыты
    const before = c.count;
    step(2600);
    a.deep(seen.faults, ['eyes_open']);
    a.eq(c.lives, 2);
    a.ok(c.count - before < 0.2, 'глаза открыты: таймер стоит');
    keys.e(); // открыты → авто (закрыты)
    step(4500);
    keys.n(); // рывок головой
    step(2000);
    a.deep(seen.faults, ['eyes_open', 'head_moving']);
    keys.l();
    step(2600);
    a.deep(seen.faults, ['eyes_open', 'head_moving', 'face_lost']);
    a.eq(c.lives, 0);
    step(1700);
    a.eq(c.failed, true, 'три жизни: провал');
  });

  t.test('friend: итог медитации со временем, цель в минутах', (a) => {
    const target = { id: 'm', type: 'meditation', target: 300, limitSec: null, stake: 10 };
    let S = msg(lobbyOf(initialState('h'), { challenge: target, left: 10 }), { t: 'start', challenge: target }, 0);
    a.eq(lobbyView(lobbyOf(initialState('h'), { challenge: target, left: 10 })).title, '🧘 Медитация: 5 минут');
    S = msg(S, { t: 'end', success: false, count: 187.4, target: 300 });
    a.eq(resultView(S).detail, '03:07 из 05:00');
    const done = msg(msg(lobbyOf(initialState('h'), { challenge: target, left: 10 }), { t: 'start', challenge: target }, 0), { t: 'end', success: true, count: 300, target: 300 });
    a.eq(resultView(done).detail, '05:00 из 05:00');
  });
};
