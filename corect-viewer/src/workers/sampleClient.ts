import type { Vec3, VoxelArray } from '../format/corevol';
import type { SampleWorkerRequest, SampleWorkerResponse } from './sampleVolume.worker';

/**
 * 取样 Worker 的主线程封装。
 *
 * 过期响应防护：每次请求分配单调递增 id，响应 id 与最新请求不一致时直接丢弃，
 * 因此快速拖动十字丝时，晚到的旧位置结果不会覆盖最新光标的取样值；
 * 同时在途期间的新请求会被合并，拖动结束后只计算并显示最后位置。
 */

type SampleListener = (valueA: number | null, valueB: number | null) => void;

interface PendingRequest {
  id: number;
  ijkA: Vec3 | null;
  ijkB: Vec3 | null;
}

let worker: Worker | null = null;
let latestId = 0;
let inFlight = false;
let queued: PendingRequest | null = null;
let listener: SampleListener | null = null;

function send(req: PendingRequest) {
  inFlight = true;
  worker!.postMessage({ type: 'sample', ...req } satisfies SampleWorkerRequest);
}

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./sampleVolume.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<SampleWorkerResponse>) => {
      inFlight = false;
      const msg = e.data;
      const next = queued;
      queued = null;
      if (next) send(next);
      // 过期响应（id 落后于最新请求）丢弃，不得覆盖最新光标对应的值
      if (msg.id === latestId && listener) listener(msg.valueA, msg.valueB);
    };
  }
  return worker;
}

/** 更新某侧体素数据（复制后转移，主线程数据不受影响） */
export function setSampleVolume(side: 'A' | 'B', data: VoxelArray, dims: Vec3): void {
  const copy = data.slice();
  ensureWorker().postMessage({ type: 'setVolume', side, data: copy, dims }, [
    copy.buffer as ArrayBuffer,
  ]);
}

export function clearSampleVolumes(): void {
  worker?.postMessage({ type: 'clear' } satisfies SampleWorkerRequest);
}

/** 请求在当前两侧光标位置取样；快速连续调用只保证最后位置的结果生效 */
export function requestSample(ijkA: Vec3 | null, ijkB: Vec3 | null): void {
  ensureWorker();
  const req: PendingRequest = { id: ++latestId, ijkA, ijkB };
  if (inFlight) {
    queued = req; // 合并：在途期间只保留最新请求
    return;
  }
  send(req);
}

export function onSampleResult(cb: SampleListener): void {
  listener = cb;
}
