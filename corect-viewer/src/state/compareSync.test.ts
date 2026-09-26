/**
 * 双体积同步比较的状态级验收测试：
 * - 间距不同但物理范围相同能正确同步
 * - 翻转轴后的端点对应准确
 * - 一侧越界不造成另一侧跳动循环
 * - 窗宽窗位独立 / 锁定联动
 * - 测距按侧使用各自体素间距
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { decodeCorevol, DType, encodeCorevol, type DecodedVolume, type Vec3 } from '../format/corevol';
import { physicalDistance } from '../geometry/viewMath';
import { identityMapping } from '../geometry/syncMap';
import { useStore, type SideState } from './store';

function makeVolume(dims: Vec3, spacing: Vec3, origin: Vec3 = [0, 0, 0]): DecodedVolume {
  const data = new Uint8Array(dims[0] * dims[1] * dims[2]);
  return decodeCorevol(
    encodeCorevol({ dtype: DType.UInt8, dims, spacing, origin, name: 'test' }, data),
  );
}

function sideState(volume: DecodedVolume): SideState {
  return {
    projectId: null,
    projectName: 'test',
    hash: null,
    volume,
    crosshair: [0, 0, 0],
    windowLevel: { window: 1, level: 0 },
    outOfBounds: false,
  };
}

// 物理范围同为 10mm：A 间距 1mm（11³），B 间距 0.5mm（21³）
const volA = makeVolume([11, 11, 11], [1, 1, 1]);
const volB = makeVolume([21, 21, 21], [0.5, 0.5, 0.5]);

function resetCompare(compareVolume: DecodedVolume = volB) {
  // 注意：status 保持 'empty'，持久化订阅不会触发 IndexedDB 写入
  useStore.setState({
    status: 'empty',
    mode: 'compare',
    base: sideState(volA),
    compare: sideState(compareVolume),
    mapping: { base: identityMapping(), compare: identityMapping() },
    mappingConfirmed: true,
    mappingStale: false,
    wlLocked: false,
    activeSide: 'base',
    measurements: [],
    rois: [],
    pendingMeasure: null,
    diff: null,
  });
}

beforeEach(() => resetCompare());

describe('双体积十字丝同步', () => {
  it('间距不同但物理范围相同：任一侧移动，另一侧按物理坐标定位', () => {
    useStore.getState().setCrosshair('base', [5, 5, 5]);
    expect(useStore.getState().compare.crosshair).toEqual([10, 10, 10]);
    expect(useStore.getState().compare.outOfBounds).toBe(false);

    // 反向：对比侧 → 基准侧
    useStore.getState().setCrosshair('compare', [4, 6, 8]);
    expect(useStore.getState().base.crosshair).toEqual([2, 3, 4]);
    expect(useStore.getState().base.outOfBounds).toBe(false);
  });

  it('翻转轴后的端点对应准确', () => {
    useStore.getState().setMapping('compare', { flip: [true, false, false] });
    useStore.getState().setCrosshair('base', [0, 5, 5]);
    expect(useStore.getState().compare.crosshair).toEqual([20, 10, 10]);
    useStore.getState().setCrosshair('base', [10, 5, 5]);
    expect(useStore.getState().compare.crosshair).toEqual([0, 10, 10]);
  });

  it('原点偏移参与同步', () => {
    useStore.getState().setMapping('compare', { offset: [5, 0, 0] });
    // 基准 x=7 → 公共 x=7 → 对比物理 x = 7-5 = 2 → i=4
    useStore.getState().setCrosshair('base', [7, 5, 5]);
    expect(useStore.getState().compare.crosshair).toEqual([4, 10, 10]);
  });

  it('一侧越界：另一侧保持最近有效位置并标记，源侧不被回拉（无跳动循环）', () => {
    // 对比侧物理范围只有 5mm
    resetCompare(makeVolume([6, 6, 6], [1, 1, 1]));
    useStore.getState().setCrosshair('base', [10, 0, 0]); // 物理 x=10 > 5
    let s = useStore.getState();
    expect(s.compare.crosshair).toEqual([5, 0, 0]); // 最近有效位置
    expect(s.compare.outOfBounds).toBe(true);
    expect(s.base.crosshair).toEqual([10, 0, 0]); // 源侧保持用户落点

    // 重复触发同一位置：状态完全稳定，无漂移、无循环
    useStore.getState().setCrosshair('base', [10, 0, 0]);
    s = useStore.getState();
    expect(s.compare.crosshair).toEqual([5, 0, 0]);
    expect(s.base.crosshair).toEqual([10, 0, 0]);

    // 从越界一侧反向拖动回范围内：正常同步且越界标记清除
    useStore.getState().setCrosshair('compare', [3, 0, 0]);
    s = useStore.getState();
    expect(s.base.crosshair).toEqual([3, 0, 0]);
    expect(s.base.outOfBounds).toBe(false);
    expect(s.compare.outOfBounds).toBe(false);
  });

  it('映射未确认（待重新确认）时两侧独立，不发生同步', () => {
    useStore.setState({ mappingConfirmed: false, mappingStale: true });
    useStore.getState().setCrosshair('base', [7, 7, 7]);
    expect(useStore.getState().base.crosshair).toEqual([7, 7, 7]);
    expect(useStore.getState().compare.crosshair).toEqual([0, 0, 0]);
  });

  it('单体积模式下 setCrosshair 只影响本侧', () => {
    useStore.setState({ mode: 'single' });
    useStore.getState().setCrosshair('base', [9, 9, 9]);
    expect(useStore.getState().base.crosshair).toEqual([9, 9, 9]);
    expect(useStore.getState().compare.crosshair).toEqual([0, 0, 0]);
  });
});

describe('窗宽窗位：独立与锁定联动', () => {
  it('未锁定时两侧独立', () => {
    useStore.getState().setWindowLevel('base', { window: 100, level: 50 });
    expect(useStore.getState().base.windowLevel).toEqual({ window: 100, level: 50 });
    expect(useStore.getState().compare.windowLevel).toEqual({ window: 1, level: 0 });
  });

  it('锁定后任一侧调整即应用到两侧；锁定瞬间以活动侧为准对齐', () => {
    useStore.getState().setWindowLevel('base', { window: 100, level: 50 });
    useStore.getState().setWlLocked(true);
    expect(useStore.getState().compare.windowLevel).toEqual({ window: 100, level: 50 });
    useStore.getState().setWindowLevel('compare', { window: 200, level: 60 });
    expect(useStore.getState().base.windowLevel).toEqual({ window: 200, level: 60 });
    expect(useStore.getState().compare.windowLevel).toEqual({ window: 200, level: 60 });
  });
});

describe('测距按侧使用各自体素间距', () => {
  it('同样的 10 个体素：基准侧 10mm，对比侧 5mm', () => {
    useStore.getState().clickMeasurePoint('base', [0, 0, 0]);
    useStore.getState().clickMeasurePoint('base', [10, 0, 0]);
    useStore.getState().clickMeasurePoint('compare', [0, 0, 0]);
    useStore.getState().clickMeasurePoint('compare', [10, 0, 0]);
    const ms = useStore.getState().measurements;
    expect(ms).toHaveLength(2);
    expect(ms[0].side).toBe('base');
    expect(ms[1].side).toBe('compare');
    expect(physicalDistance(ms[0].p1, ms[0].p2, volA.header.spacing)).toBeCloseTo(10, 10);
    expect(physicalDistance(ms[1].p1, ms[1].p2, volB.header.spacing)).toBeCloseTo(5, 10);
  });

  it('跨侧点击重新开始第一点（测量不跨体积）', () => {
    useStore.getState().clickMeasurePoint('base', [1, 1, 1]);
    useStore.getState().clickMeasurePoint('compare', [2, 2, 2]); // 换侧 → 重落第一点
    expect(useStore.getState().measurements).toHaveLength(0);
    expect(useStore.getState().pendingMeasure).toEqual({ side: 'compare', ijk: [2, 2, 2] });
  });
});
