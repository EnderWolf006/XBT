import { API_BASE_URL } from '../api/client';

type PendingImage = {
  promise: Promise<Blob>;
  controller: AbortController;
  consumers: number;
};

const pending = new Map<string, PendingImage>();
let running = 0;
const queue: Array<() => void> = [];

async function download(source: string, token: string, controller: AbortController): Promise<Blob> {
  const signal = controller.signal;
  await new Promise<void>((resolve, reject) => {
    const start = () => {
      signal.removeEventListener('abort', cancel);
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      running++;
      resolve();
    };
    const cancel = () => {
      const index = queue.indexOf(start);
      if (index >= 0) queue.splice(index, 1);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (signal.aborted) return cancel();
    if (running < 2) start();
    else {
      queue.push(start);
      signal.addEventListener('abort', cancel, { once: true });
    }
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 12000);
  try {
    const url = `${API_BASE_URL.replace(/\/$/, '')}/media/image?source=${encodeURIComponent(source)}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!response.ok || !/^image\/(?:jpeg|png|gif|webp)(?:;|$)/i.test(response.headers.get('Content-Type') || '')) {
      throw new Error('图片暂时无法加载');
    }
    const blob = await response.blob();
    if (blob.size > 2 * 1024 * 1024) throw new Error('图片大小超过限制');
    return blob;
  } catch (error) {
    if (timedOut) throw new Error('图片加载超时');
    throw error;
  } finally {
    clearTimeout(timeout);
    running--;
    queue.shift()?.();
  }
}

export function loadMediaImage(source: string, token: string, signal: AbortSignal): Promise<Blob> {
  const key = `${token}\0${source}`;
  let entry = pending.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, consumers: 0, promise: download(source, token, controller) };
    pending.set(key, entry);
    const current = entry;
    void entry.promise.finally(() => {
      if (pending.get(key) === current) pending.delete(key);
    }).catch(() => undefined);
  }
  const current = entry;
  current.consumers++;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      signal.removeEventListener('abort', cancel);
      current.consumers--;
      if (current.consumers === 0) {
        if (pending.get(key) === current) pending.delete(key);
        current.controller.abort();
      }
      return true;
    };
    const cancel = () => {
      if (finish()) reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    current.promise.then(blob => { if (finish()) resolve(blob); }, error => { if (finish()) reject(error); });
  });
}
