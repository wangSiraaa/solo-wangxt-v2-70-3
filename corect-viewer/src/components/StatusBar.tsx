import { useStore } from '../state/store';
import { ijkToShared } from '../geometry/compareMath';
import { ijkToWorld, voxelIndex } from '../geometry/viewMath';

function fmt(v: number | null): string {
  if (v === null) return '…';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

export function StatusBar() {
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const volume = useStore((s) => s.volume);
  const crosshair = useStore((s) => s.crosshair);
  const projectName = useStore((s) => s.projectName);
  const compareMode = useStore((s) => s.compareMode);
  const volumeB = useStore((s) => s.volumeB);
  const projectNameB = useStore((s) => s.projectNameB);
  const crosshairB = useStore((s) => s.crosshairB);
  const mappingA = useStore((s) => s.mappingA);
  const mappingB = useStore((s) => s.mappingB);
  const clampedA = useStore((s) => s.clampedA);
  const clampedB = useStore((s) => s.clampedB);
  const sampleValues = useStore((s) => s.sampleValues);

  if (status === 'error') {
    return <footer className="status-bar error">错误：{error}</footer>;
  }
  if (!volume) {
    return <footer className="status-bar">{status === 'loading' ? '解码中…' : '未加载工程'}</footer>;
  }

  // ---- 双体积对比模式 ----
  if (compareMode && volumeB) {
    const sharedA = ijkToShared(crosshair, volume.header, mappingA);
    const sharedB = ijkToShared(crosshairB, volumeB.header, mappingB);
    const va = sampleValues?.a ?? null;
    const vb = sampleValues?.b ?? null;
    const diff = va !== null && vb !== null ? va - vb : null;
    const oobA = clampedA.some(Boolean);
    const oobB = clampedB.some(Boolean);
    return (
      <footer className="status-bar compare">
        <span>
          {projectName} ⇄ {projectNameB}
        </span>
        <span>
          A：IJK = ({crosshair.join(', ')})，值 = {fmt(va)}
        </span>
        <span>
          B：IJK = ({crosshairB.join(', ')})，值 = {fmt(vb)}
        </span>
        <span className="diff-value">Δ(A−B) = {fmt(diff)}</span>
        <span>
          共享物理 = ({sharedA[0].toFixed(2)}, {sharedA[1].toFixed(2)}, {sharedA[2].toFixed(2)}) mm
          {Math.abs(sharedA[0] - sharedB[0]) +
            Math.abs(sharedA[1] - sharedB[1]) +
            Math.abs(sharedA[2] - sharedB[2]) >
            0.01 && '（B 已夹取）'}
        </span>
        {(oobA || oobB) && (
          <span className="oob-text">
            ⚠ {[oobA && '基准 A', oobB && '对比 B'].filter(Boolean).join('、')}越界，已保持最近有效位置
          </span>
        )}
      </footer>
    );
  }

  // ---- 单体积模式 ----
  const { spacing, origin, dims } = volume.header;
  const world = ijkToWorld(crosshair, spacing, origin);
  const value = volume.data[voxelIndex(crosshair, dims)];
  return (
    <footer className="status-bar">
      <span>{projectName}</span>
      <span>
        IJK = ({crosshair[0]}, {crosshair[1]}, {crosshair[2]})
      </span>
      <span>
        物理坐标 = ({world[0].toFixed(2)}, {world[1].toFixed(2)}, {world[2].toFixed(2)}) mm
      </span>
      <span>值 = {value}</span>
    </footer>
  );
}
