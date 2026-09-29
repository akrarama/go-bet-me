// IDLE: камера, скелет, «покажи 👍, чтобы начать».
// Владелец: блок 2 (Жесты). Сейчас заглушка от основы.

export default {
  model: 'gesture',

  enter(ctx) {
    ctx.root.innerHTML = `
      <div class="hero">
        <h1 class="title">Против</h1>
        <p class="subtitle">Поставь на себя. Друзья ставят против. ИИ судит по камере.</p>
        <div class="gesture-cta"><span class="gesture-cta__icon">👍</span><span>Покажи большой палец, чтобы начать</span></div>
      </div>`;
    ctx.on('gesture', ({ name }) => {
      if (name === 'Thumb_Up') ctx.app.go('SETUP');
    });
  },
};
