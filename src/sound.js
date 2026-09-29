// Короткие звуки вместо голоса: синтез через WebAudio, без файлов. Владелец: координатор.
// sound.play('rep' | 'error' | 'tick' | 'go' | 'win' | 'lose' | 'click')
// Браузер включает звук только после первого касания или клавиши: main.js вызывает sound.unlock().

let ac = null;
let master = null;

function ensure() {
  if (ac) return ac;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  ac = new AC();
  master = ac.createGain();
  master.gain.value = 0.25;
  master.connect(ac.destination);
  return ac;
}

/** Одна нота с мягкой атакой и затуханием. at и dur в секундах. */
function note(freq, at, dur, { type = 'triangle', gain = 0.8, to = null } = {}) {
  const t0 = ac.currentTime + at;
  const osc = ac.createOscillator();
  const env = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(env).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

const SOUNDS = {
  rep: () => {
    note(988, 0, 0.1); // си
    note(1319, 0.07, 0.18); // ми выше: «дзинь-дзинь»
  },
  error: () => {
    note(311, 0, 0.14, { gain: 0.7, to: 262 }); // мягкое «оу-оу» вниз
    note(233, 0.11, 0.2, { gain: 0.6, to: 196 });
  },
  tick: () => note(740, 0, 0.12, { type: 'sine' }),
  go: () => {
    note(988, 0, 0.1, { type: 'sine' });
    note(1480, 0.08, 0.3, { type: 'sine' });
  },
  win: () => [784, 988, 1175, 1568].forEach((f, i) => note(f, i * 0.08, 0.3)),
  lose: () => [392, 330, 262].forEach((f, i) => note(f, i * 0.14, 0.28, { gain: 0.6 })),
  click: () => note(1200, 0, 0.05, { type: 'sine', gain: 0.5 }),
};

export const sound = {
  unlock() {
    const c = ensure();
    if (c?.state === 'suspended') c.resume();
  },

  play(name) {
    const c = ensure();
    if (!c || c.state !== 'running' || !SOUNDS[name]) return;
    try {
      SOUNDS[name]();
    } catch {
      /* без звука, ничего страшного */
    }
  },
};
