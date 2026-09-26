import { describe, expect, it } from 'vitest';
import { DiffClient, type WorkerLike } from './diffClient';
import type { DiffResult } from '../geometry/diffSample';
import type { SideMapping } from '../geometry/syncMap';
import type { Vec3 } from '../format/corevol';

/** 假 Worker：记录发送消息，允许测试手动派发响应（可乱序） */
class FakeWorker implements WorkerLike {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  posted: { msg: Record<string, unknown>; transfer?: Transferable[] }[] = [];
  terminated = false;  postMessage(msg: unknown, transfer?: Transferable[]): void {
    this.posted.push({ msg: msg as Record<string, unknown>, transfer });
  }

  emitResult(result: DiffResult): void {
    this.onmessage?.({ data: { type: 'result', result } } as MessageEvent);
  }

  terminate(): void {
    this.terminated = true;
  }
}

const map: SideMapping = { offset: [0, 0, 0], flip: [false, false, false] };
const baseReq = (center: Vec3) => ({
  center,
  mapBase: map,
  mapCompare: map,
  radius: 5,
  samples: 9,
});

function resultFor(id: number, center: Vec3): DiffResult {
  return {
    requestId: id,
    center,
    ijkBase: [id, 0, 0],
    ijkCompare: [id, 0, 0],
    valueBase: id,
    valueCompare: 0,
    diff: id,
    oobBase: false,
    oobCompare: false,
    meanAbsDiff: 0,
    maxAbsDiff: 0,
    validCount: 1,
    totalCount: 1,
  };
}

describe('DiffClient 过期响应保护', () => {
  it('乱序到达的旧响应被丢弃，只有最新请求的结果回调', () => {
    const fake = new FakeWorker();
    const client = new DiffClient(() => fake);
    const received: DiffResult[] = [];
    client.setOnResult((r) => received.push(r));

    client.sample(baseReq([0, 0, 0])); // id=1
    client.sample(baseReq([1, 1, 1])); // id=2
    client.sample(baseReq([2, 2, 2])); // id=3

    // 模拟 Worker 乱序：先到 id=2、再到 id=1，均过期
    fake.emitResult(resultFor(2, [1, 1, 1]));
    fake.emitResult(resultFor(1, [0, 0, 0]));
    expect(received).toHaveLength(0);

    fake.emitResult(resultFor(3, [2, 2, 2]));
    expect(received).toHaveLength(1);
    expect(received[0].requestId).toBe(3);
    expect(received[0].center).toEqual([2, 2, 2]);
    client.dispose();
    expect(fake.terminated).toBe(true);
  });

  it('快速拖动：连续 10 次取样，Worker 按序响应后界面只显示最后位置', () => {
    const fake = new FakeWorker();
    const client = new DiffClient(() => fake);
    const received: DiffResult[] = [];
    client.setOnResult((r) => received.push(r));

    for (let i = 0; i < 10; i++) client.sample(baseReq([i, i, i]));
    for (let i = 1; i <= 9; i++) fake.emitResult(resultFor(i, [i, i, i]));
    expect(received).toHaveLength(0); // 1..9 全部过期
    fake.emitResult(resultFor(10, [9, 9, 9]));
    expect(received).toHaveLength(1);
    expect(received[0].requestId).toBe(10);
    client.dispose();
  });

  it('init 转移两份体数据缓冲区', () => {
    const fake = new FakeWorker();
    const client = new DiffClient(() => fake);
    client.init({
      base: {
        dims: [2, 2, 2],
        spacing: [1, 1, 1],
        origin: [0, 0, 0],
        data: new Uint8Array(8),
      },
      compare: {
        dims: [2, 2, 2],
        spacing: [1, 1, 1],
        origin: [0, 0, 0],
        data: new Uint8Array(8),
      },
    });
    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0].msg.type).toBe('init');
    expect(fake.posted[0].transfer).toHaveLength(2);
    client.dispose();
  });
});
