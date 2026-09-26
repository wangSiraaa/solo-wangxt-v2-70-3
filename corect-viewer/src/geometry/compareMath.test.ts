import { describe, expect, it } from 'vitest';
import {
  cursorFromA,
  cursorFromB,
  cursorFromPhys,
  identityMapping,
  ijkToShared,
  sessionRestorable,
  sharedToIjk,
  type SideMapping,
} from './compareMath';
import type { Vec3 } from '../format/corevol';

// 基准 A：与合成样例一致（各向异性 0.5×0.5×2.0）
const A = { dims: [128, 128, 200] as Vec3, spacing: [0.5, 0.5, 2] as Vec3, origin: [0, 0, 0] as Vec3 };
// 对比 B：间距不同（0.25×0.25×1.0）但物理范围与 A 完全相同
// （A 范围 127×0.5 × 127×0.5 × 199×2 = 63.5×63.5×398 mm = B 范围 254×0.25 × 254×0.25 × 398×1）
const B = { dims: [255, 255, 399] as Vec3, spacing: [0.25, 0.25, 1] as Vec3, origin: [0, 0, 0] as Vec3 };
const ID = identityMapping();

describe('间距不同但物理范围相同的同步', () => {
  it('A→B 按物理坐标等比例定位', () => {
    const cur = cursorFromA([100, 30, 12], A, ID, B, ID);
    expect(cur.phys).toEqual([50, 15, 24]);
    expect(cur.ijkB).toEqual([200, 60, 24]);
    expect(cur.clampedB).toEqual([false, false, false]);
    expect(cur.ijkA).toEqual([100, 30, 12]);
  });

  it('B→A 反向同步', () => {
    const cur = cursorFromB([200, 60, 24], A, ID, B, ID);
    expect(cur.ijkA).toEqual([100, 30, 12]);
    expect(cur.clampedA).toEqual([false, false, false]);
  });

  it('往返无漂移（A→B→A 回到原体素）', () => {
    const c1 = cursorFromA([37, 91, 123], A, ID, B, ID);
    const c2 = cursorFromB(c1.ijkB, A, ID, B, ID);
    expect(c2.ijkA).toEqual([37, 91, 123]);
    expect(c2.phys).toEqual(c1.phys);
  });

  it('物理范围端点一一对应', () => {
    expect(cursorFromA([0, 0, 0], A, ID, B, ID).ijkB).toEqual([0, 0, 0]);
    expect(cursorFromA([127, 127, 199], A, ID, B, ID).ijkB).toEqual([254, 254, 398]);
  });
});

describe('原点偏移映射', () => {
  const offsetB: SideMapping = { offset: [10, 0, 0], flip: [false, false, false] };

  it('偏移参与共享物理坐标', () => {
    // B 的共享 x = 自身物理 x + 10 → A 的 x=10（i=20）对应 B 的 i=0
    expect(ijkToShared([0, 0, 0], B, offsetB)[0]).toBe(10);
    expect(cursorFromA([20, 0, 0], A, ID, B, offsetB).ijkB[0]).toBe(0);
  });

  it('偏移导致的负坐标越界夹取到 0 并标记', () => {
    const cur = cursorFromA([10, 0, 0], A, ID, B, offsetB); // A x=5 → B raw x=-5
    expect(cur.ijkB[0]).toBe(0);
    expect(cur.clampedB[0]).toBe(true);
  });
});

describe('轴向翻转映射', () => {
  const flipK: SideMapping = { offset: [0, 0, 0], flip: [false, false, true] };

  it('翻转轴端点对应准确（k=0 ↔ k=max）', () => {
    expect(cursorFromA([0, 0, 0], A, ID, B, flipK).ijkB[2]).toBe(398);
    expect(cursorFromA([0, 0, 199], A, ID, B, flipK).ijkB[2]).toBe(0);
  });

  it('翻转后中间点线性对应', () => {
    expect(cursorFromA([0, 0, 100], A, ID, B, flipK).ijkB[2]).toBe(198);
    expect(cursorFromA([0, 0, 50], A, ID, B, flipK).ijkB[2]).toBe(298);
  });

  it('翻转不改变物理范围（自身物理坐标不变）', () => {
    // 翻转后 B 的物理范围仍是 [0, 398]mm，只是索引方向相反
    expect(sharedToIjk([0, 0, 0], B, flipK).ijk[2]).toBe(398);
    expect(sharedToIjk([0, 0, 398], B, flipK).ijk[2]).toBe(0);
  });

  it('两侧同轴同时翻转 ⇔ 索引同向对应', () => {
    // A k=30 → 共享 z=(199-30)*2=338 → B：raw=338 → 398-338=60
    const cur = cursorFromA([10, 20, 30], A, flipK, B, flipK);
    expect(cur.ijkB).toEqual([20, 40, 60]);
    // 往返一致
    expect(cursorFromB(cur.ijkB, A, flipK, B, flipK).ijkA).toEqual([10, 20, 30]);
  });
});

describe('越界夹取与无跳动循环', () => {
  // B 物理范围更小：63×63×396 mm（A 为 63.5×63.5×398）
  const Bsmall = {
    dims: [64, 64, 100] as Vec3,
    spacing: [1, 1, 4] as Vec3,
    origin: [0, 0, 0] as Vec3,
  };

  it('越界侧保持最近有效位置并逐轴标记', () => {
    const cur = cursorFromA([127, 127, 199], A, ID, Bsmall, ID); // phys (63.5, 63.5, 398)
    expect(cur.ijkB).toEqual([63, 63, 99]);
    expect(cur.clampedB).toEqual([true, true, true]);
  });

  it('一侧越界不改变另一侧（A 保持用户位置）', () => {
    const input: Vec3 = [127, 127, 199];
    const cur = cursorFromA(input, A, ID, Bsmall, ID);
    expect(cur.ijkA).toEqual(input);
    expect(cur.clampedA).toEqual([false, false, false]);
  });

  it('重复应用幂等（不振荡）', () => {
    const input: Vec3 = [127, 127, 199];
    const c1 = cursorFromA(input, A, ID, Bsmall, ID);
    const c2 = cursorFromA(input, A, ID, Bsmall, ID);
    expect(c2).toEqual(c1);
  });

  it('拖回范围内后越界标记解除', () => {
    const out = cursorFromA([127, 127, 199], A, ID, Bsmall, ID);
    expect(out.clampedB[2]).toBe(true);
    const back = cursorFromA([100, 100, 100], A, ID, Bsmall, ID); // phys z=200 → B k=50
    expect(back.ijkB).toEqual([50, 50, 50]);
    expect(back.clampedB).toEqual([false, false, false]);
  });

  it('映射变化时共享物理锚定，两侧重新推导且稳定', () => {
    const c1 = cursorFromA([50, 50, 50], A, ID, Bsmall, ID);
    const c2 = cursorFromPhys(c1.phys, A, ID, Bsmall, ID);
    expect(c2.ijkA).toEqual(c1.ijkA);
    expect(c2.ijkB).toEqual(c1.ijkB);
    expect(c2.phys).toEqual(c1.phys);
  });
});

describe('会话身份（文件内容哈希）', () => {
  it('两侧哈希都一致才可恢复映射', () => {
    expect(sessionRestorable({ hashA: 'a', hashB: 'b' }, { hashA: 'a', hashB: 'b' })).toBe(true);
    expect(sessionRestorable({ hashA: 'a', hashB: 'b' }, { hashA: 'a', hashB: 'X' })).toBe(false);
    expect(sessionRestorable({ hashA: 'a', hashB: 'b' }, { hashA: 'X', hashB: 'b' })).toBe(false);
    expect(sessionRestorable({ hashA: 'a', hashB: 'b' }, { hashA: 'X', hashB: 'Y' })).toBe(false);
  });
});
