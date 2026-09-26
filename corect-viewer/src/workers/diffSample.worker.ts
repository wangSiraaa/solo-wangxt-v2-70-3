/// <reference lib="webworker" />
import { sampleDiff, type DiffRequest, type DiffVolumes } from '../geometry/diffSample';

const scope = self as unknown as DedicatedWorkerGlobalScope;

export type DiffWorkerMessage =
  | ({ type: 'init' } & DiffVolumes)
  | ({ type: 'sample' } & DiffRequest);

/** 双侧体数据常驻 Worker（init 时零拷贝转移），主线程保留原数据用于渲染 */
let volumes: DiffVolumes | null = null;

scope.onmessage = (e: MessageEvent<DiffWorkerMessage>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    volumes = { base: msg.base, compare: msg.compare };
    scope.postMessage({ type: 'ready' });
    return;
  }
  if (!volumes) return; // 尚未初始化，丢弃取样请求
  const result = sampleDiff(volumes, msg);
  scope.postMessage({ type: 'result', result });
};
