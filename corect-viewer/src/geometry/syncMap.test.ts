import { describe, expect, it } from 'vitest';
import {
  commonToIjk,
  identityMapping,
  ijkToCommon,
  type SideMapping,
  type VolumeGeom,
} from './syncMap';

// 间距不同但物理范围相同：A 每轴 1mm×11 体素，B 每轴 0.5mm×21 体素，物理范围均为 10mm
const GEOM_A: VolumeGeom = { dims: [11, 11, 11], spacing: [1, 1, 1], origin: [0, 0, 0] };
const GEOM_B: VolumeGeom = { dims: [21, 21, 21], spacing: [0.5, 0.5, 0.5], origin: [0, 0, 0] };

const ID = identityMapping();
const flip = (x: boolean, y: boolean, z: boolean): SideMapping => ({
  offset: [0, 0, 0],
  flip: [x, y, z],
});

describe('公共物理空间映射', () => {
  it('间距不同但物理范围相同：端点与中心逐点对应', () => {
    // A(0,0,0)↔B(0,0,0)，A(5,5,5)↔B(10,10,10)，A(10,10,10)↔B(20,20,20)
    expect(ijkToCommon([5, 5, 5], GEOM_A, ID)).toEqual([5, 5, 5]);
    expect(commonToIjk([0, 0, 0], GEOM_B, ID).ijk).toEqual([0, 0, 0]);
    expect(commonToIjk([5, 5, 5], GEOM_B, ID).ijk).toEqual([10, 10, 10]);
    expect(commonToIjk([10, 10, 10], GEOM_B, ID).ijk).toEqual([20, 20, 20]);
  });

  it('间距不同：A 的每个体素都映射到 B 的偶数索引（往返一致）', () => {
    for (const ijk of [
      [0, 0, 0],
      [3, 7, 9],
      [10, 10, 10],
      [1, 2, 3],
    ] as const) {
      const common = ijkToCommon([...ijk], GEOM_A, ID);
      const r = commonToIjk(common, GEOM_B, ID);
      expect(r.outOfBounds).toBe(false);
      expect(r.ijk).toEqual([ijk[0] * 2, ijk[1] * 2, ijk[2] * 2]);
    }
  });

  it('翻转轴后端点对应准确：x=0 ↔ i=max，x=max ↔ i=0', () => {
    const flipI = flip(true, false, false);
    // B 翻转 I：公共 x=0 → B 物理 x=10 → i=20；公共 x=10 → i=0
    expect(commonToIjk([0, 5, 5], GEOM_B, flipI).ijk).toEqual([20, 10, 10]);
    expect(commonToIjk([10, 5, 5], GEOM_B, flipI).ijk).toEqual([0, 10, 10]);
    // 中心不动
    expect(commonToIjk([5, 5, 5], GEOM_B, flipI).ijk).toEqual([10, 10, 10]);
  });

  it('翻转后往返一致（正变换再逆变换回到原点）', () => {
    const flipJK = flip(false, true, true);
    const common = ijkToCommon([7, 3, 19], GEOM_B, flipJK);
    const r = commonToIjk(common, GEOM_B, flipJK);
    expect(r.ijk).toEqual([7, 3, 19]);
    expect(r.outOfBounds).toBe(false);
  });

  it('原点偏移：offset 平移公共物理坐标', () => {
    const off: SideMapping = { offset: [10, -2, 0], flip: [false, false, false] };
    expect(ijkToCommon([0, 0, 0], GEOM_B, off)).toEqual([10, -2, 0]);
    // 公共 (10, -2, 0) ↔ B ijk (0,0,0)
    expect(commonToIjk([10, -2, 0], GEOM_B, off).ijk).toEqual([0, 0, 0]);
    expect(commonToIjk([15, 0.5, 5], GEOM_B, off).ijk).toEqual([10, 5, 10]);
  });

  it('越界检测：夹取到最近有效位置并逐轴标记', () => {
    const r = commonToIjk([12, -3, 5], GEOM_A, ID);
    expect(r.outOfBounds).toBe(true);
    expect(r.oobAxes).toEqual([true, true, false]);
    expect(r.ijk).toEqual([10, 0, 5]);
  });

  it('物理范围边界上不算越界', () => {
    expect(commonToIjk([0, 0, 0], GEOM_A, ID).outOfBounds).toBe(false);
    expect(commonToIjk([10, 10, 10], GEOM_A, ID).outOfBounds).toBe(false);
  });

  it('非零 origin 参与换算', () => {
    const geom: VolumeGeom = { dims: [11, 11, 11], spacing: [2, 2, 2], origin: [100, 200, 300] };
    expect(ijkToCommon([0, 0, 0], geom, ID)).toEqual([100, 200, 300]);
    expect(ijkToCommon([5, 5, 5], geom, ID)).toEqual([110, 210, 310]);
    expect(commonToIjk([110, 210, 310], geom, ID).ijk).toEqual([5, 5, 5]);
  });
});
