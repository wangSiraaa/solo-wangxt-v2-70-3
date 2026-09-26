import type { Vec3 } from '../format/corevol';
import type { SideMapping } from '../geometry/syncMap';

export interface WindowLevelState {
  window: number;
  level: number;
}

/** 双体积会话的视图状态（随映射一起持久化） */
export interface CompareViewState {
  crosshairBase: Vec3;
  crosshairCompare: Vec3;
  windowLevelBase: WindowLevelState;
  windowLevelCompare: WindowLevelState;
  wlLocked: boolean;
}

/** 会话恢复时的映射参数（含两侧） */
export interface CompareMappingState {
  base: SideMapping;
  compare: SideMapping;
}

export interface SessionHashes {
  baseHash: string;
  compareHash: string;
}

export interface RestoreDecision {
  /** 两份文件内容指纹均与会话保存时一致 */
  identityMatch: boolean;
  /** 是否启用同步映射（身份一致且会话已确认） */
  mappingConfirmed: boolean;
  /** 任一文件内容已变化：旧映射停用，需用户重新确认 */
  mappingStale: boolean;
}

/**
 * 刷新恢复判定（纯函数）：
 * - 双体积身份全部一致 → 恢复视图状态，映射按保存时的确认状态启用；
 * - 任一文件内容改变 → 停用旧映射（mappingConfirmed=false、mappingStale=true）。
 */
export function evaluateSessionRestore(
  session: SessionHashes & { confirmed: boolean },
  current: SessionHashes,
): RestoreDecision {
  const identityMatch =
    session.baseHash === current.baseHash && session.compareHash === current.compareHash;
  return {
    identityMatch,
    mappingConfirmed: identityMatch && session.confirmed,
    mappingStale: !identityMatch,
  };
}
