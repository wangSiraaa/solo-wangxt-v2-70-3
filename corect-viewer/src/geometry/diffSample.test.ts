import { describe, expect, it } from 'vitest';
import { sampleDiff, type DiffVolume, type DiffVolumes } from './diffSample';
import { identityMapping } from './syncMap';
import type { Vec3 } from '../format/corevol';

// 物理范围同为 10mm 的一对体积：A 间距 1mm（11³），B 间距 0.5mm（21³）
function makeVolume(
  dims: Vec3,
  spacing: Vec3,
  fill: (i: number, j: number, k: number) => number,
): DiffVolume {
  const data = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (let k = 0; k < dims[2]; k++)
    for (let j = 0; j < dims[1]; j++)
      for (let i = 0; i < dims[0]; i++) data[i + dims[0] * (j + dims[1] * k)] = fill(i, j, k);
  return { dims, spacing, origin: [0, 0, 0], data };
}

const ID = identityMapping();
const req = (center: Vec3, radius: number, samples: number) => ({
  center,
  mapBase: ID,
  mapCompare: ID,
  radius,
  samples,
});

describe('差值取样（同一物理位置的双侧灰度）', () => {
  it('中心位置按物理坐标取两侧体素并计算差值', () => {
    // A(i,j,k) = i；B(i,j,k) = i（索引值）。物理 x=5 时 A i=5，B i=10
    const base = makeVolume([11, 11, 11], [1, 1, 1], (i) => i);
    const compare = makeVolume([21, 21, 21], [0.5, 0.5, 0.5], (i) => i);
    const vols: DiffVolumes = { base, compare };
    const r = sampleDiff(vols, { ...req([5, 5, 5], 0, 1), requestId: 1 });
    expect(r.ijkBase).toEqual([5, 5, 5]);
    expect(r.ijkCompare).toEqual([10, 10, 10]);
    expect(r.valueBase).toBe(5);
    expect(r.valueCompare).toBe(10);
    expect(r.diff).toBe(-5);
    expect(r.oobBase).toBe(false);
    expect(r.oobCompare).toBe(false);
    expect(r.totalCount).toBe(1);
    expect(r.validCount).toBe(1);
  });

  it('邻域统计：物理值同源时 |Δ| 随网格确定（A=i，B=i 索引，物理 x 处 B i=2x）', () => {
    const base = makeVolume([11, 11, 11], [1, 1, 1], (i) => i);
    const compare = makeVolume([21, 21, 21], [0.5, 0.5, 0.5], (i) => i);
    // 中心 (5,5,5)，半径 2mm，5 个点 → x∈{3,4,5,6,7}；
    // 物理 x 处 A 值=x，B 值=2x，|Δ|=x → 均值 5，最大 7
    const r = sampleDiff(
      { base, compare },
      { ...req([5, 5, 5], 2, 5), requestId: 7 },
    );
    expect(r.totalCount).toBe(125);
    expect(r.validCount).toBe(125);
    expect(r.meanAbsDiff).toBeCloseTo(5, 10);
    expect(r.maxAbsDiff).toBe(7);
    expect(r.requestId).toBe(7);
  });

  it('翻转轴：公共 x=2 取到 B 翻转后的体素 i=16（值 16），而非 i=4', () => {
    const base = makeVolume([11, 11, 11], [1, 1, 1], () => 30);
    const compare = makeVolume([21, 21, 21], [0.5, 0.5, 0.5], (i) => i);
    const r = sampleDiff(
      { base, compare },
      {
        requestId: 1,
        center: [2, 5, 5],
        mapBase: ID,
        mapCompare: { offset: [0, 0, 0], flip: [true, false, false] },
        radius: 0,
        samples: 1,
      },
    );
    expect(r.ijkCompare).toEqual([16, 10, 10]);
    expect(r.valueCompare).toBe(16);
    expect(r.diff).toBe(14);
  });

  it('中心越界：该侧值为 null，统计只计双侧有效采样点', () => {
    const base = makeVolume([11, 11, 11], [1, 1, 1], () => 100);
    // 对比侧 x 方向物理范围 0..15mm，x=12 时仅基准侧越界
    const compare = makeVolume([31, 21, 21], [0.5, 0.5, 0.5], () => 120);
    // 公共 x=12：基准范围只到 10 → 基准越界，对比有效
    const r = sampleDiff({ base, compare }, { ...req([12, 5, 5], 0, 1), requestId: 2 });
    expect(r.oobBase).toBe(true);
    expect(r.oobCompare).toBe(false);
    expect(r.valueBase).toBeNull();
    expect(r.valueCompare).toBe(120);
    expect(r.diff).toBeNull();
    expect(r.validCount).toBe(0);
    expect(r.meanAbsDiff).toBeNull();
  });

  it('邻域部分越界时仅统计双侧均有效点', () => {
    const base = makeVolume([11, 11, 11], [1, 1, 1], () => 100);
    const compare = makeVolume([21, 21, 21], [0.5, 0.5, 0.5], () => 100);
    // 中心 x=1，半径 2 → x∈{-1,0,1,2,3}，x=-1 对两侧均越界 → 4/5 沿 x 有效
    const r = sampleDiff({ base, compare }, { ...req([1, 5, 5], 2, 5), requestId: 3 });
    expect(r.validCount).toBe(100); // 4×5×5
    expect(r.totalCount).toBe(125);
    expect(r.meanAbsDiff).toBe(0); // 同值
  });
});
