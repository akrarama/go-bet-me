// VOID: камера пропала больше 5 с в LIVE → отмена, всем возврат ставок.
// Владелец: блок 3 (Деньги). Сейчас заглушка. Возврат делает блок 3 (например по событию live:void).

export default {
  model: 'gesture',

  enter(ctx) {
    ctx.root.innerHTML = `
      <div class="panel panel--narrow">
        <h2 class="h2">Челлендж отменён</h2>
        <p class="lead">Камера пропала дольше чем на 5 секунд. Всем вернули ставки.</p>
        <p class="muted">👍 в начало</p>
      </div>`;
    ctx.on('gesture', ({ name }) => {
      if (name === 'Thumb_Up') ctx.app.go('IDLE');
    });
  },
};
