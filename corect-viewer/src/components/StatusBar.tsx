import { useStore } from '../state/store';
import { ijkToWorld, voxelIndex } from '../geometry/viewMath';
import { ijkToCommon } from '../geometry/syncMap';

function fmtSigned(v: number): string {
  return v > 0 ? `+${v}` : `${v}`;
}

export function StatusBar() {
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const mode = useStore((s) => s.mode);
  const base = useStore((s) => s.base);
  const compare = useStore((s) => s.compare);
  const activeSide = useStore((s) => s.activeSide);
  const mapping = useStore((s) => s.mapping);
  const diff = useStore((s) => s.diff);

  if (status === 'error') {
    return <footer className="status-bar error">错误：{error}</footer>;
  }
  if (!base.volume) {
    return <footer className="status-bar">{status === 'loading' ? '解码中…' : '未加载工程'}</footer>;
  }

  // 双体积比较：两侧 IJK + 公共物理坐标 + 差值探针摘要
  if (mode === 'compare' && compare.volume) {
    const active = activeSide === 'base' ? base : compare;
    const common = ijkToCommon(
      active.crosshair,
      active.volume!.header,
      mapping[activeSide],
    );
    return (
      <footer className="status-bar">
        <span className={base.outOfBounds ? 'oob' : ''}>
          基准 IJK = ({base.crosshair.join(', ')}){base.outOfBounds && ' ⚠越界'}
        </span>
        <span className={compare.outOfBounds ? 'oob' : ''}>
          对比 IJK = ({compare.crosshair.join(', ')}){compare.outOfBounds && ' ⚠越界'}
        </span>
        <span>
          公共物理 = ({common.map((v) => v.toFixed(2)).join(', ')}) mm
        </span>
        {diff && (
          <span>
            Δ = {diff.diff !== null ? fmtSigned(diff.diff) : '—'}（基准{' '}
            {diff.valueBase ?? '越界'} / 对比 {diff.valueCompare ?? '越界'}）
          </span>
        )}
      </footer>
    );
  }

  const { spacing, origin, dims } = base.volume.header;
  const world = ijkToWorld(base.crosshair, spacing, origin);
  const value = base.volume.data[voxelIndex(base.crosshair, dims)];
  return (
    <footer className="status-bar">
      <span>{base.projectName}</span>
      <span>
        IJK = ({base.crosshair[0]}, {base.crosshair[1]}, {base.crosshair[2]})
      </span>
      <span>
        物理坐标 = ({world[0].toFixed(2)}, {world[1].toFixed(2)}, {world[2].toFixed(2)}) mm
      </span>
      <span>值 = {value}</span>
    </footer>
  );
}
