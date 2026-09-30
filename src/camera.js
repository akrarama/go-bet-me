// Камера или (с ?debug=1&video=...) видеофайл. Следит за обрывом.
// События: camera:lost {since}  камера замолчала или закрылась, либо нет новых кадров
//                               дольше APP.cameraLostAfterMs, пока вкладка видна
//          camera:back {}       кадры снова идут
//          camera:ended {}      трек камеры закрыт насовсем

import { APP, DEBUG_VIDEO, DEBUG_NO_CAMERA } from './config.js';
import { bus } from './bus.js';

export const camera = {
  video: null,
  source: 'none', // 'camera' | 'file'
  mirror: true, // селфи-вид зеркалим, файл нет
  lost: false,
  frozen: false, // debug: имитация обрыва

  /** Поток для звонка другу (P1): камера как есть, видеофайл отладки через captureStream. null: потока нет. */
  get stream() {
    const v = this.video;
    if (!v) return null;
    if (v.srcObject instanceof MediaStream) return v.srcObject;
    if (this.source === 'file' && v.captureStream) return (this.captured ??= v.captureStream());
    return null;
  },

  async start(video) {
    this.video = video;
    video.muted = true;
    video.playsInline = true;

    if (DEBUG_NO_CAMERA) {
      this.source = 'none';
      this.mirror = false;
      return this;
    }
    if (DEBUG_VIDEO && IMAGE_RE.test(DEBUG_VIDEO)) {
      video.srcObject = await slideshow(DEBUG_VIDEO.split(','));
      this.source = 'file';
      this.mirror = false;
    } else if (DEBUG_VIDEO) {
      video.src = DEBUG_VIDEO;
      video.loop = true;
      this.source = 'file';
      this.mirror = false;
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      });
      video.srcObject = stream;
      this.source = 'camera';
      this.mirror = true;
      stream.getVideoTracks()[0]?.addEventListener('ended', () => bus.emit('camera:ended', {}));
    }

    await video.play();
    await waitForSize(video);
    watchdog(this);
    return this;
  },

  /** debug: включить/выключить имитацию обрыва камеры. */
  freeze(on = !this.frozen) {
    this.frozen = on;
    if (this.source === 'none') {
      // без камеры watchdog не работает: сообщаем об обрыве сразу
      this.lost = on;
      bus.emit(on ? 'camera:lost' : 'camera:back', { since: performance.now() });
      return;
    }
    this.video.style.visibility = on ? 'hidden' : '';
    if (this.source === 'file') on ? this.video.pause() : this.video.play();
  },
};

const IMAGE_RE = /\.(jpe?g|png|webp)(,|$)/i;
const SLIDE_MS = 2500;

/** debug: картинки через запятую → видеопоток, кадр меняется каждые 2.5 с. */
async function slideshow(urls) {
  const images = await Promise.all(
    urls.map((src) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = src;
      return img.decode().then(() => img);
    }),
  );
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const g = canvas.getContext('2d');
  const paint = () => {
    const img = images[Math.floor(performance.now() / SLIDE_MS) % images.length];
    const s = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
    const w = img.naturalWidth * s;
    const h = img.naturalHeight * s;
    g.fillStyle = '#000';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  };
  paint();
  setInterval(paint, 1000 / 30);
  return canvas.captureStream(30);
}

function waitForSize(video) {
  return new Promise((resolve) => {
    if (video.videoWidth) return resolve();
    video.addEventListener('loadedmetadata', () => resolve(), { once: true });
  });
}

/**
 * Обрыв определяем по трём сигналам:
 * 1) трек камеры закрылся (ended) или замолчал (mute): сразу;
 * 2) новые кадры (requestVideoFrameCallback, иначе currentTime) не приходят дольше порога;
 * 3) скрытую вкладку обрывом не считаем: там браузер сам не рисует кадры.
 */
function watchdog(cam) {
  const video = cam.video;
  const track = video.srcObject?.getVideoTracks?.()[0] ?? null;
  let lastFrameAt = performance.now();
  const mark = () => {
    if (!cam.frozen) lastFrameAt = performance.now();
  };

  if ('requestVideoFrameCallback' in video) {
    const onFrame = () => {
      mark();
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  } else {
    let lastTime = -1;
    setInterval(() => {
      if (video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        mark();
      }
    }, 100);
  }

  const set = (lost, since = performance.now()) => {
    if (lost === cam.lost) return;
    cam.lost = lost;
    bus.emit(lost ? 'camera:lost' : 'camera:back', lost ? { since } : {});
  };
  track?.addEventListener('mute', () => set(true));
  track?.addEventListener('ended', () => set(true));
  track?.addEventListener('unmute', () => {
    mark();
    set(false);
  });

  setInterval(() => {
    if (cam.frozen) return set(true, lastFrameAt);
    if (track && (track.readyState === 'ended' || track.muted)) return;
    if (document.visibilityState !== 'visible') {
      lastFrameAt = performance.now();
      return;
    }
    if (performance.now() - lastFrameAt > APP.cameraLostAfterMs) set(true, lastFrameAt);
    else set(false);
  }, 250);
}
