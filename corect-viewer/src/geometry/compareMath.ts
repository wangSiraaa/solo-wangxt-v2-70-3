import type { CorevolHeader, Vec3 } from '../format/corevol';

/**
 * 双体积并排比较的坐标映射与同步（纯函数，便于测试）。
 *
 * 共享物理坐标系：两侧各自把体素索引映射到同一个"比较物理坐标系"，
 * 映射 = 轴向翻转（i → dims-1-i，保持物理范围不变）+ 原点偏移（mm）。
 * 十字丝的真源是共享物理坐标 crosshairPhys，两侧 IJK 都由它推导，
 * 推导是单向纯函数，因此越界夹取不会回写、不会产生跳动循环。
 */

export interface SideMapping {
  /** 物理原点偏移（mm），加到共享物理坐标 */
  offset: Vec3;
  /** 轴向翻转：true 表示该轴体素索引反向（i → dims-1-i） */
  flip: [boolean, boolean, boolean];
}

export function identityMapping(): SideMapping {
  return { offset: [0, 0, 0], flip: [false, false, false] };
}

type Geom = Pick<CorevolHeader, 'dims' | 'spacing' | 'origin'>;

/** 体素索引 → 共享物理坐标（mm）：可选翻转 → 乘间距加原点 → 加偏移 */
export function ijkToShared(ijk: Vec3, g: Geom, m: SideMapping): Vec3 {
  const out: Vec3 = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const idx = m.flip[a] ? g.dims[a] - 1 - ijk[a] : ijk[a];
    out[a] = g.origin[a] + idx * g.spacing[a] + m.offset[a];
  }
  return out;
}

export interface MapResult {
  ijk: Vec3;
  /** 每轴是否因越界被夹取到最近有效位置 */
  clamped: [boolean, boolean, boolean];
}

/** 共享物理坐标 → 最近体素索引（四舍五入；越界夹取并逐轴标记） */
export function sharedToIjk(phys: Vec3, g: Geom, m: SideMapping): MapResult {
  const ijk: Vec3 = [0, 0, 0];
  const clamped: [boolean, boolean, boolean] = [false, false, false];
  for (let a = 0; a < 3; a++) {
    const raw = (phys[a] - m.offset[a] - g.origin[a]) / g.spacing[a];
    const idx = m.flip[a] ? g.dims[a] - 1 - raw : raw;
    const rounded = Math.round(idx);
    const maxIdx = g.dims[a] - 1;
    if (rounded < 0) {
      ijk[a] = 0;
      clamped[a] = true;
    } else if (rounded > maxIdx) {
      ijk[a] = maxIdx;
      clamped[a] = true;
    } else {
      ijk[a] = rounded;
    }
  }
  return { ijk, clamped };
}

/** 双体积光标：共享物理坐标 + 两侧各自推导出的 IJK 与越界标记 */
export interface CompareCursor {
  phys: Vec3;
  ijkA: Vec3;
  clampedA: [boolean, boolean, boolean];
  ijkB: Vec3;
  clampedB: [boolean, boolean, boolean];
}

/** 以共享物理坐标为锚，推导两侧光标（映射参数变化时调用） */
export function cursorFromPhys(
  phys: Vec3,
  gA: Geom,
  mA: SideMapping,
  gB: Geom,
  mB: SideMapping,
): CompareCursor {
  const a = sharedToIjk(phys, gA, mA);
  const b = sharedToIjk(phys, gB, mB);
  return { phys, ijkA: a.ijk, clampedA: a.clamped, ijkB: b.ijk, clampedB: b.clamped };
}

/** A 侧移动十字丝 → 共享物理坐标 → 推导 B 侧（A 侧保持用户指定位置） */
export function cursorFromA(
  ijkA: Vec3,
  gA: Geom,
  mA: SideMapping,
  gB: Geom,
  mB: SideMapping,
): CompareCursor {
  return cursorFromPhys(ijkToShared(ijkA, gA, mA), gA, mA, gB, mB);
}

/** B 侧移动十字丝 → 共享物理坐标 → 推导 A 侧（B 侧保持用户指定位置） */
export function cursorFromB(
  ijkB: Vec3,
  gA: Geom,
  mA: SideMapping,
  gB: Geom,
  mB: SideMapping,
): CompareCursor {
  return cursorFromPhys(ijkToShared(ijkB, gB, mB), gA, mA, gB, mB);
}

/**
 * 会话是否可恢复：两侧文件内容哈希都与保存时一致。
 * 任一侧内容改变 → 旧映射失效，需用户重新确认。
 */
export function sessionRestorable(
  stored: { hashA: string; hashB: string },
  actual: { hashA: string; hashB: string },
): boolean {
  return stored.hashA === actual.hashA && stored.hashB === actual.hashB;
}
