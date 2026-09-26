import type { Vec3 } from '../format/corevol';

/** 双体积比较中的一侧：基准 / 对比 */
export type Side = 'base' | 'compare';

/**
 * 单侧映射参数：把本侧体素的物理坐标变换到「公共物理空间」。
 * 变换按轴独立：common = offset + (flip ? lo + hi - phys : phys)
 * 其中 phys = origin + ijk * spacing，[lo, hi] 为本侧该轴的物理范围。
 */
export interface SideMapping {
  /** 公共物理空间中的平移偏移（mm），逐轴加到本侧物理坐标上 */
  offset: Vec3;
  /** 各轴是否翻转：true 时绕本侧物理范围中心镜像该轴（端点互换） */
  flip: [boolean, boolean, boolean];
}

/** 映射计算所需的体数据几何信息 */
export interface VolumeGeom {
  dims: Vec3;
  spacing: Vec3;
  origin: Vec3;
}

export function identityMapping(): SideMapping {
  return { offset: [0, 0, 0], flip: [false, false, false] };
}

/** 体素索引 → 公共物理空间坐标（mm） */
export function ijkToCommon(ijk: Vec3, geom: VolumeGeom, map: SideMapping): Vec3 {
  const out: Vec3 = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const phys = geom.origin[a] + ijk[a] * geom.spacing[a];
    const lo = geom.origin[a];
    const hi = geom.origin[a] + (geom.dims[a] - 1) * geom.spacing[a];
    out[a] = map.offset[a] + (map.flip[a] ? lo + hi - phys : phys);
  }
  return out;
}

export interface CommonToIjkResult {
  /** 最近有效体素索引（越界时夹取到边界体素） */
  ijk: Vec3;
  /** 公共坐标是否落在本侧物理范围之外（任一轴） */
  outOfBounds: boolean;
  /** 各轴越界标记 */
  oobAxes: [boolean, boolean, boolean];
}

/**
 * 公共物理空间坐标 → 本侧最近体素索引。
 * 越界（公共坐标超出本侧物理范围）时夹取到最近有效位置，并置越界标记。
 */
export function commonToIjk(common: Vec3, geom: VolumeGeom, map: SideMapping): CommonToIjkResult {
  const ijk: Vec3 = [0, 0, 0];
  const oobAxes: [boolean, boolean, boolean] = [false, false, false];
  let outOfBounds = false;
  for (let a = 0; a < 3; a++) {
    const lo = geom.origin[a];
    const hi = geom.origin[a] + (geom.dims[a] - 1) * geom.spacing[a];
    const shifted = common[a] - map.offset[a];
    const phys = map.flip[a] ? lo + hi - shifted : shifted;
    const raw = (phys - geom.origin[a]) / geom.spacing[a];
    if (raw < 0 || raw > geom.dims[a] - 1) {
      oobAxes[a] = true;
      outOfBounds = true;
    }
    ijk[a] = Math.min(Math.max(Math.round(raw), 0), geom.dims[a] - 1);
  }
  return { ijk, outOfBounds, oobAxes };
}
