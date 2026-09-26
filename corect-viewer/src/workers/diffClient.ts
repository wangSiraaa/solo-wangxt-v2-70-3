import type { DiffRequest, DiffResult, DiffVolumes } from '../geometry/diffSample';

/** 最小 Worker 接口（便于单元测试注入假实现） */
export interface WorkerLike {
  onmessage: ((e: MessageEvent) => void) | null;
  /** 错误回调仅用于赋值（DOM Worker 与假实现的事件签名不同，故不约束类型） */
  onerror?: unknown;
  postMessage: (msg: unknown, transfer: Transferable[]) => void;
  terminate: () => void;
}

export type DiffWorkerFactory = () => WorkerLike;

const defaultFactory: DiffWorkerFactory = () =>
  new Worker(new URL('./diffSample.worker.ts', import.meta.url), { type: 'module' });

interface ResultEnvelope {
  type: 'result';
  result: DiffResult;
}

/**
 * 差值取样客户端：
 * - init 时把双侧体数据副本零拷贝转移进 Worker，大体积取样不阻塞主线程；
 * - 每次取样分配单调递增的 requestId；响应 id 与最新请求不一致时直接丢弃，
 *   保证「过期响应不可覆盖最新光标」（快速拖动时只显示最后位置的差值）。
 */
export class DiffClient {
  private worker: WorkerLike;
  private latestRequestId = 0;
  private onResult: ((result: DiffResult) => void) | null = null;
  private onError: ((message: string) => void) | null = null;

  constructor(factory: DiffWorkerFactory = defaultFactory) {
    this.worker = factory();
    this.worker.onmessage = (e: MessageEvent) => {
      const data = e.data as ResultEnvelope | { type: string };
      if (data.type !== 'result') return;
      const result = (data as ResultEnvelope).result;
      if (result.requestId !== this.latestRequestId) return; // 过期响应丢弃
      this.onResult?.(result);
    };
    this.worker.onerror = (e: unknown) => {
      const message = (e as ErrorEvent | undefined)?.message;
      this.onError?.(message || '差值取样线程错误');
    };
  }

  /** 初始化/替换双侧体数据（体素数组缓冲区被转移，主线程须传副本） */
  init(volumes: DiffVolumes): void {
    this.worker.postMessage({ type: 'init', ...volumes }, [
      volumes.base.data.buffer as ArrayBuffer,
      volumes.compare.data.buffer as ArrayBuffer,
    ]);
  }

  setOnResult(cb: ((result: DiffResult) => void) | null): void {
    this.onResult = cb;
  }

  setOnError(cb: ((message: string) => void) | null): void {
    this.onError = cb;
  }

  /** 发起一次取样；返回 requestId，只有最新一次的结果会回调 */
  sample(req: Omit<DiffRequest, 'requestId'>): number {
    const id = ++this.latestRequestId;
    this.worker.postMessage({ type: 'sample', ...req, requestId: id }, []);
    return id;
  }

  dispose(): void {
    this.worker.terminate();
  }
}
