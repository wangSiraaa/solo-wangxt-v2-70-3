/// <reference lib="webworker" />
import type { Vec3, VoxelArray } from '../format/corevol';
import { voxelIndex } from '../geometry/viewMath';

/**
 * 双体积灰度取样 Worker：持有两侧体素数据副本（大体积不阻塞主线程），
 * 按请求 id 返回同一物理位置两侧的体素值。
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;

interface SideData {
  data: VoxelArray;
  dims: Vec3;
}

const sides: { A?: SideData; B?: SideData } = {};

export type SampleWorkerRequest =
  | { type: 'setVolume'; side: 'A' | 'B'; data: VoxelArray; dims: Vec3 }
  | { type: 'clear' }
  | { type: 'sample'; id: number; ijkA: Vec3 | null; ijkB: Vec3 | null };

export interface SampleWorkerResponse {
  type: 'sample';
  id: number;
  valueA: number | null;
  valueB: number | null;
}

function sample(s: SideData, ijk: Vec3): number {
  return s.data[voxelIndex(ijk, s.dims)];
}

scope.onmessage = (e: MessageEvent<SampleWorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'setVolume') {
    sides[msg.side] = { data: msg.data, dims: msg.dims };
    return;
  }
  if (msg.type === 'clear') {
    sides.A = undefined;
    sides.B = undefined;
    return;
  }
  const valueA = msg.ijkA && sides.A ? sample(sides.A, msg.ijkA) : null;
  const valueB = msg.ijkB && sides.B ? sample(sides.B, msg.ijkB) : null;
  scope.postMessage({ type: 'sample', id: msg.id, valueA, valueB } satisfies SampleWorkerResponse);
};
