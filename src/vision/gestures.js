// Жесты → события шины. Владелец: блок 2 (Жесты). Основа: рабочая базовая версия.
//
// Шлёт:
//   gesture {name}          Thumb_Up | Thumb_Down | Open_Palm | Pointing_Up:
//                           жест держится GESTURES.holdMs, срабатывает один раз за показ
//   handup  {side}          запястье выше носа GESTURES.handUpMs ('left' | 'right', сторона тела)
//                           нужна поза: экран включает модель 'pose' (например ['gesture', 'pose'])
//   cursor  {x, y, visible} кончик указательного пальца (landmark 8) в CSS px экрана
//
// Важно: handedness у GestureRecognizer считается для зеркального кадра,
// а камера отдаёт незеркальный. «Левая рука» в позе (11, 13, 15) это левая рука человека.

import { GESTURES } from '../config.js';
import { bus } from '../bus.js';
import { draw } from '../draw.js';

let shown = 'None';
let since = 0;
let fired = false;
let lastFire = -Infinity;
let upSince = 0;
let upFired = false;
let cursorVisible = false;

export const gestures = {
  start(ctx) {
    ctx.vision.onFrame(onFrame);
  },
};

function onFrame(frame) {
  if (frame.ran === 'gesture') onHands(frame);
  if (frame.ran === 'pose') onPose(frame);
}

function onHands(frame) {
  const hand = frame.gesture.hands[0];
  const name = hand && hand.score >= GESTURES.minScore ? hand.gesture : 'None';
  if (name !== shown) {
    shown = name;
    since = frame.t;
    fired = false;
  } else if (!fired && name !== 'None' && frame.t - since >= GESTURES.holdMs && frame.t - lastFire >= GESTURES.cooldownMs) {
    fired = true;
    lastFire = frame.t;
    bus.emit('gesture', { name });
  }

  if (hand) {
    const { x, y } = draw.project(hand.landmarks[8]);
    cursorVisible = true;
    bus.emit('cursor', { x, y, visible: true });
  } else if (cursorVisible) {
    cursorVisible = false;
    bus.emit('cursor', { visible: false });
  }
}

function onPose(frame) {
  const lm = frame.pose.landmarks;
  let side = null;
  if (lm && (lm[0].visibility ?? 0) > 0.5) {
    if ((lm[15].visibility ?? 0) > 0.5 && lm[15].y < lm[0].y) side = 'left';
    else if ((lm[16].visibility ?? 0) > 0.5 && lm[16].y < lm[0].y) side = 'right';
  }
  if (!side) {
    upSince = 0;
    upFired = false;
    return;
  }
  if (!upSince) upSince = frame.t;
  if (!upFired && frame.t - upSince >= GESTURES.handUpMs) {
    upFired = true;
    bus.emit('handup', { side });
  }
}
