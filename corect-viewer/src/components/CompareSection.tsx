import { useRef } from 'react';
import { useStore, type Side } from '../state/store';
import type { Vec3 } from '../format/corevol';
import { dtypeLabel } from '../format/corevol';

const AXES = ['I', 'J', 'K'] as const;

/** 双体积对比控制：加载/关闭对比、映射参数（原点偏移 + 轴向翻转）、窗宽窗位联动锁 */
export function CompareSection() {
  const fileRef = useRef<HTMLInputElement>(null);
  const s = useStore();

  if (!s.volume) return null;

  if (!s.compareMode) {
    return (
      <section>
        <h3>双体积对比</h3>
        <div className="btn-row">
          <button onClick={() => void s.loadSampleB()}>加载对比样例</button>
          <button onClick={() => fileRef.current?.click()}>导入对比 .corevol</button>
          <input
            ref={fileRef}
            type="file"
            accept=".corevol"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void s.importFileB(f);
              e.target.value = '';
            }}
          />
        </div>
        {s.compareError && <div className="warn-box">错误：{s.compareError}</div>}
        <div className="hint">也可在上方工程列表点「B」把已有工程设为对比侧。</div>
      </section>
    );
  }

  return (
    <section>
      <h3>双体积对比</h3>
      <div className="kv">
        <span>基准 A</span>
        <span>{s.projectName}</span>
        <span>对比 B</span>
        <span>{s.projectNameB}</span>
        {s.volumeB && (
          <>
            <span>B 维度</span>
            <span>{s.volumeB.header.dims.join(' × ')}</span>
            <span>B 间距 (mm)</span>
            <span>{s.volumeB.header.spacing.map((v) => v.toFixed(2)).join(' × ')}</span>
            <span>B 类型</span>
            <span>{dtypeLabel(s.volumeB.header.dtype)}</span>
          </>
        )}
      </div>
      <div className="btn-row" style={{ marginTop: 6 }}>
        <button onClick={() => void s.closeCompare()}>关闭对比</button>
      </div>
      {s.compareError && <div className="warn-box">错误：{s.compareError}</div>}

      {s.mappingStale && (
        <div className="warn-box">
          文件内容已变化，旧映射已停用（已重置为恒等映射）。请检查或调整映射后重新确认。
          <div className="btn-row" style={{ marginTop: 6 }}>
            <button className="active" onClick={s.confirmMapping}>
              确认当前映射
            </button>
          </div>
        </div>
      )}

      <MappingEditor side="A" />
      <MappingEditor side="B" />

      <label className="check-row">
        <input
          type="checkbox"
          checked={s.lockWindowLevel}
          onChange={(e) => s.setLockWindowLevel(e.target.checked)}
        />
        锁定两侧窗宽窗位联动
      </label>
    </section>
  );
}

/** 单侧映射编辑：物理原点偏移（mm）+ 轴向翻转 */
function MappingEditor({ side }: { side: Side }) {
  const mapping = useStore((s) => (side === 'A' ? s.mappingA : s.mappingB));
  const setMapping = useStore((s) => (side === 'A' ? s.setMappingA : s.setMappingB));

  return (
    <div className="mapping-editor">
      <div className="mapping-title">{side === 'A' ? '基准 A 映射' : '对比 B 映射'}</div>
      <div className="mapping-row">
        <span className="mapping-label">偏移 (mm)</span>
        {AXES.map((label, a) => (
          <label key={label} className="mapping-field">
            <span>{label}</span>
            <input
              type="number"
              step={0.5}
              value={mapping.offset[a]}
              onChange={(e) => {
                const offset = [...mapping.offset] as Vec3;
                offset[a] = Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : 0;
                setMapping({ ...mapping, offset });
              }}
            />
          </label>
        ))}
      </div>
      <div className="mapping-row">
        <span className="mapping-label">翻转轴</span>
        {AXES.map((label, a) => (
          <label key={label} className="check-row">
            <input
              type="checkbox"
              checked={mapping.flip[a]}
              onChange={(e) => {
                const flip = [...mapping.flip] as [boolean, boolean, boolean];
                flip[a] = e.target.checked;
                setMapping({ ...mapping, flip });
              }}
            />
            {label}
          </label>
        ))}
      </div>
    </div>
  );
}
