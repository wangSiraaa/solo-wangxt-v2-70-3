import type { Vec3, VoxelArray } from '../format/corevol';
import { voxelIndex } from './viewMath';
import { commonToIjk, type SideMapping, type VolumeGeom } from './syncMap';

/** 差值取样所需的单侧体数据（几何 + 体素数组） */
export interface DiffVolume extends VolumeGeom {
  data: VoxelArray;
}

export interface DiffVolumes {
  base: DiffVolume;
  compare: DiffVolume;
}

export interface DiffRequest {
  /** 请求序号：客户端保证单调递增，用于丢弃过期响应 */
  requestId: number;
  /** 采样中心（公共物理空间坐标，mm） */
  center: Vec3;
  mapBase: SideMapping;
  mapCompare: SideMapping;
  /** 邻域半径（mm）：以中心为心的立方体半边长 */
  radius: number;
  /** 每轴采样点数（≥1），总采样数 = samples³ */
  samples: number;
}

export interface DiffResult {
  requestId: number;
  /** 实际采样的公共物理中心（与请求一致，供界面自洽显示） */
  center: Vec3;
  /** 中心位置两侧各自的体素索引（越界为 null） */
  ijkBase: Vec3 | null;
  ijkCompare: Vec3 | null;
  /** 中心位置两侧灰度值（越界为 null） */
  valueBase: number | null;
  valueCompare: number | null;
  /** 灰度差 valueBase - valueCompare（任一侧越界为 null） */
  diff: number | null;
  oobBase: boolean;
  oobCompare: boolean;
  /** 邻域内双侧均有效的采样点上 |Δ| 的均值 / 最大值 */
  meanAbsDiff: number | null;
  maxAbsDiff: number | null;
  /** 双侧均有效的采样点数 / 总采样点数 */
  validCount: number;
  totalCount: number;
}

/** 在公共物理坐标处取本侧最近体素，越界返回 null */
function sampleAt(vol: DiffVolume, common: Vec3, map: SideMapping): number | null {
  const r = commonToIjk(common, vol, map);
  if (r.outOfBounds) return null;
  return vol.data[voxelIndex(r.ijk, vol.dims)];
}

/**
 * 差值探针（纯函数，在 Web Worker 中运行）：
 * 以公共物理坐标为中心取邻域网格，双侧分别按各自映射采样并统计灰度差。
 */
export function sampleDiff(volumes: DiffVolumes, req: DiffRequest): DiffResult {
  const { center, radius } = req;
  const n = Math.max(1, Math.floor(req.samples));

  const cBase = commonToIjk(center, volumes.base, req.mapBase);
  const cCompare = commonToIjk(center, volumes.compare, req.mapCompare);
  const valueBase = cBase.outOfBounds
    ? null
    : volumes.base.data[voxelIndex(cBase.ijk, volumes.base.dims)];
  const valueCompare = cCompare.outOfBounds
    ? null
    : volumes.compare.data[voxelIndex(cCompare.ijk, volumes.compare.dims)];

  let validCount = 0;
  let sumAbs = 0;
  let maxAbs = -1;
  for (let iz = 0; iz < n; iz++) {
    const dz = n === 1 ? 0 : -radius + (2 * radius * iz) / (n - 1);
    for (let iy = 0; iy < n; iy++) {
      const dy = n === 1 ? 0 : -radius + (2 * radius * iy) / (n - 1);
      for (let ix = 0; ix < n; ix++) {
        const dx = n === 1 ? 0 : -radius + (2 * radius * ix) / (n - 1);
        const p: Vec3 = [center[0] + dx, center[1] + dy, center[2] + dz];
        const a = sampleAt(volumes.base, p, req.mapBase);
        const b = sampleAt(volumes.compare, p, req.mapCompare);
        if (a !== null && b !== null) {
          const d = Math.abs(a - b);
          validCount++;
          sumAbs += d;
          if (d > maxAbs) maxAbs = d;
        }
      }
    }
  }

  return {
    requestId: req.requestId,
    center,
    ijkBase: cBase.outOfBounds ? null : cBase.ijk,
    ijkCompare: cCompare.outOfBounds ? null : cCompare.ijk,
    valueBase,
    valueCompare,
    diff: valueBase !== null && valueCompare !== null ? valueBase - valueCompare : null,
    oobBase: cBase.outOfBounds,
    oobCompare: cCompare.outOfBounds,
    meanAbsDiff: validCount > 0 ? sumAbs / validCount : null,
    maxAbsDiff: validCount > 0 ? maxAbs : null,
    validCount,
    totalCount: n * n * n,
  };
}
