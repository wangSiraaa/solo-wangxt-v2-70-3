import { useRef, useState } from 'react';
import { useStore, type Side, type Tool } from '../state/store';
import { computeRoiStats } from '../geometry/roi';
import { physicalDistance, VIEW_CONFIGS } from '../geometry/viewMath';
import { dtypeLabel, type Vec3 } from '../format/corevol';
import type { WindowLevelState } from '../state/sessionRestore';

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'navigate', label: '浏览', hint: '拖动定位十字丝，滚轮换层' },
  { id: 'measure', label: '测量', hint: '依次点击两点测距（可跨视图）' },
  { id: 'roi', label: '框选 ROI', hint: '拖出矩形兴趣区' },
];

const SIDE_LABEL: Record<Side, string> = { base: '基准', compare: '对比' };
const AXES = ['I', 'J', 'K'] as const;

function fmtSigned(v: number): string {
  return v > 0 ? `+${v}` : `${v}`;
}

/** 单侧映射编辑：原点偏移（mm）+ 逐轴翻转 */
function MappingEditor({ side }: { side: Side }) {
  const mapping = useStore((s) => s.mapping[side]);
  const setMapping = useStore((s) => s.setMapping);
  return (
    <div className="mapping-editor" data-testid={`mapping-${side}`}>
      <h4>{SIDE_LABEL[side]}侧映射</h4>
      <div className="offset-row">
        {AXES.map((label, a) => (
          <label key={label}>
            Δ{label} (mm)
            <input
              type="number"
              step={0.5}
              data-testid={`offset-${side}-${a}`}
              value={mapping.offset[a]}
              onChange={(e) => {
                const offset = [...mapping.offset] as Vec3;
                offset[a] = Number(e.target.value) || 0;
                setMapping(side, { offset });
              }}
            />
          </label>
        ))}
      </div>
      <div className="flip-row">
        {AXES.map((label, a) => (
          <label key={label}>
            <input
              type="checkbox"
              data-testid={`flip-${side}-${a}`}
              checked={mapping.flip[a]}
              onChange={(e) => {
                const flip = [...mapping.flip] as [boolean, boolean, boolean];
                flip[a] = e.target.checked;
                setMapping(side, { flip });
              }}
            />
            翻转 {label}
          </label>
        ))}
      </div>
    </div>
  );
}

/** 单侧窗宽窗位滑块 */
function WindowLevelSliders({ side }: { side: Side }) {
  const volume = useStore((s) => s[side].volume);
  const windowLevel = useStore((s) => s[side].windowLevel);
  const setWindowLevel = useStore((s) => s.setWindowLevel);
  if (!volume) return null;
  const wl: WindowLevelState = windowLevel;
  return (
    <div className="wl-group">
      <div className="muted">{SIDE_LABEL[side]}侧</div>
      <label>
        窗宽 {wl.window.toFixed(0)}
        <input
          type="range"
          min={1}
          max={Math.max(volume.max - volume.min, 1) * 1.5}
          step={1}
          value={wl.window}
          onChange={(e) => setWindowLevel(side, { ...wl, window: Number(e.target.value) })}
        />
      </label>
      <label>
        窗位 {wl.level.toFixed(0)}
        <input
          type="range"
          min={volume.min}
          max={volume.max}
          step={1}
          value={wl.level}
          onChange={(e) => setWindowLevel(side, { ...wl, level: Number(e.target.value) })}
        />
      </label>
    </div>
  );
}

/** 双体积比较：工程选择 / 映射 / 会话状态 */
function CompareSection() {
  const s = useStore();
  const [baseSel, setBaseSel] = useState('');
  const [compareSel, setCompareSel] = useState('');

  if (s.mode !== 'compare') {
    const baseId = baseSel || s.base.projectId || '';
    const compareId = compareSel;
    return (
      <section>
        <h3>双体积比较</h3>
        <label>
          基准工程
          <select
            data-testid="base-select"
            value={baseId}
            onChange={(e) => setBaseSel(e.target.value)}
          >
            <option value="">请选择</option>
            {s.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || p.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          对比工程
          <select
            data-testid="compare-select"
            value={compareId}
            onChange={(e) => setCompareSel(e.target.value)}
          >
            <option value="">请选择</option>
            {s.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || p.id}
              </option>
            ))}
          </select>
        </label>
        <button
          data-testid="enter-compare"
          disabled={!baseId || !compareId || baseId === compareId}
          onClick={() => void s.enterCompare(baseId, compareId)}
        >
          进入比较
        </button>
        {s.projects.length < 2 && (
          <div className="hint">比较需要两份体数据：请先导入第二个 .corevol 文件。</div>
        )}
      </section>
    );
  }

  return (
    <section>
      <h3>双体积比较</h3>
      <div className="kv">
        <span>基准</span>
        <span>{s.base.projectName}</span>
        <span>对比</span>
        <span>{s.compare.projectName}</span>
      </div>
      <button data-testid="exit-compare" onClick={s.exitCompare}>
        退出比较
      </button>
      {s.mappingStale && (
        <div className="warn-banner" data-testid="mapping-stale-banner">
          检测到文件内容已变化，旧映射已停用。请检查映射参数并重新确认。
        </div>
      )}
      {!s.mappingConfirmed && (
        <button
          className="active"
          data-testid="confirm-mapping"
          onClick={s.confirmMapping}
        >
          确认并启用映射
        </button>
      )}
      <MappingEditor side="base" />
      <MappingEditor side="compare" />
      <div className="hint">
        同步经公共物理空间换算：物理坐标 + 原点偏移，可逐轴翻转。任一侧移动十字丝，另一侧按物理坐标定位。
      </div>
    </section>
  );
}

/** 差值探针：同一公共物理位置的双侧灰度与差值（Worker 取样） */
function DiffSection() {
  const diff = useStore((s) => s.diff);
  const mappingConfirmed = useStore((s) => s.mappingConfirmed);
  return (
    <section>
      <h3>差值探针</h3>
      {!mappingConfirmed ? (
        <div className="hint">映射未确认，差值取样已停用。</div>
      ) : diff ? (
        <div className="kv" data-testid="diff-panel">
          <span>公共物理坐标</span>
          <span>
            ({diff.center.map((v) => v.toFixed(2)).join(', ')}) mm
          </span>
          <span>基准值</span>
          <span>
            {diff.valueBase ?? '越界'}
            {diff.ijkBase && ` @ (${diff.ijkBase.join(', ')})`}
          </span>
          <span>对比值</span>
          <span>
            {diff.valueCompare ?? '越界'}
            {diff.ijkCompare && ` @ (${diff.ijkCompare.join(', ')})`}
          </span>
          <span>灰度差 Δ</span>
          <span>
            <b>{diff.diff !== null ? fmtSigned(diff.diff) : '—'}</b>
          </span>
          <span>邻域平均 |Δ|</span>
          <span>{diff.meanAbsDiff !== null ? diff.meanAbsDiff.toFixed(2) : '—'}</span>
          <span>邻域最大 |Δ|</span>
          <span>{diff.maxAbsDiff ?? '—'}</span>
          <span>有效采样</span>
          <span>
            {diff.validCount} / {diff.totalCount}
          </span>
        </div>
      ) : (
        <div className="hint">移动十字丝后在此显示双侧灰度差（±5mm 邻域统计）。</div>
      )}
    </section>
  );
}

export function SidePanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  const s = useStore();

  const activeRoi = s.rois.find((r) => r.id === s.activeRoiId) ?? null;
  const activeRoiVolume = activeRoi ? s[activeRoi.side].volume : null;
  const roiStats =
    activeRoi && activeRoiVolume
      ? computeRoiStats(activeRoiVolume.data, activeRoiVolume.header.dims, activeRoi, s.threshold)
      : null;

  const inCompare = s.mode === 'compare';

  return (
    <aside className="side-panel">
      <section>
        <h3>工程</h3>
        <div className="btn-row">
          <button onClick={() => void s.loadSample()}>加载样例</button>
          <button onClick={() => fileRef.current?.click()}>导入 .corevol</button>
          <input
            ref={fileRef}
            type="file"
            accept=".corevol"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void s.importFile(f);
              e.target.value = '';
            }}
          />
        </div>
        <ul className="project-list">
          {s.projects.map((p) => (
            <li key={p.id} className={p.id === s.base.projectId ? 'active' : ''}>
              <button className="link" onClick={() => void s.openProject(p.id)} title="打开工程">
                {p.name || p.id}
              </button>
              <button className="danger" onClick={() => void s.removeProject(p.id)} title="删除工程">
                ×
              </button>
            </li>
          ))}
          {s.projects.length === 0 && <li className="muted">暂无工程，请加载样例</li>}
        </ul>
      </section>

      <CompareSection />

      {s.base.volume && (
        <>
          <section>
            <h3>体数据</h3>
            {(['base', 'compare'] as const).map((side) => {
              const vol = s[side].volume;
              if (!vol) return null;
              return (
                <div className="kv" key={side}>
                  {inCompare && (
                    <>
                      <span className="side-tag">{SIDE_LABEL[side]}</span>
                      <span />
                    </>
                  )}
                  <span>维度</span>
                  <span>{vol.header.dims.join(' × ')}</span>
                  <span>间距 (mm)</span>
                  <span>{vol.header.spacing.map((v) => v.toFixed(2)).join(' × ')}</span>
                  <span>类型</span>
                  <span>{dtypeLabel(vol.header.dtype)}</span>
                  <span>值域</span>
                  <span>
                    {vol.min} ~ {vol.max}
                  </span>
                </div>
              );
            })}
          </section>

          <section>
            <h3>工具</h3>
            <div className="btn-row">
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  className={s.tool === t.id ? 'active' : ''}
                  title={t.hint}
                  onClick={() => s.setTool(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {s.pendingMeasure && (
              <div className="hint">
                已落下第一点（{SIDE_LABEL[s.pendingMeasure.side]}侧），点击第二点完成测量。
                <button className="link" onClick={s.cancelPendingMeasure}>
                  取消
                </button>
              </div>
            )}
          </section>

          <section>
            <h3>窗宽 / 窗位</h3>
            {inCompare && (
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  data-testid="wl-lock"
                  checked={s.wlLocked}
                  onChange={(e) => s.setWlLocked(e.target.checked)}
                />
                锁定联动（两侧同步调整）
              </label>
            )}
            {inCompare && s.wlLocked ? (
              <WindowLevelSliders side={s.activeSide} />
            ) : (
              <>
                <WindowLevelSliders side="base" />
                {inCompare && <WindowLevelSliders side="compare" />}
              </>
            )}
          </section>

          {inCompare && <DiffSection />}

          <section>
            <h3>ROI 阈值预览</h3>
            <label>
              阈值 {s.threshold.toFixed(0)}
              <input
                type="range"
                min={Math.min(s.base.volume.min, s.compare.volume?.min ?? Infinity)}
                max={Math.max(s.base.volume.max, s.compare.volume?.max ?? -Infinity)}
                step={1}
                value={s.threshold}
                onChange={(e) => s.setThreshold(Number(e.target.value))}
              />
            </label>
            {activeRoi && roiStats ? (
              <div className="kv">
                <span>所属侧</span>
                <span>{SIDE_LABEL[activeRoi.side]}</span>
                <span>体素总数</span>
                <span>{roiStats.total.toLocaleString()}</span>
                <span>≥ 阈值</span>
                <span>
                  {roiStats.above.toLocaleString()}（
                  {((roiStats.above / roiStats.total) * 100).toFixed(1)}%）
                </span>
                <span>最小 / 最大</span>
                <span>
                  {roiStats.min} / {roiStats.max}
                </span>
                <span>均值</span>
                <span>{roiStats.mean.toFixed(2)}</span>
              </div>
            ) : (
              <div className="hint">用「框选 ROI」工具拖出矩形后在此查看统计。</div>
            )}
          </section>

          <section>
            <h3>测量（{s.measurements.length}）</h3>
            <ul className="annot-list">
              {s.measurements.map((m) => {
                const vol = s[m.side].volume;
                return (
                  <li key={m.id}>
                    <span>
                      {inCompare && <em className="side-tag">{SIDE_LABEL[m.side]}</em>}(
                      {m.p1.join(', ')}) → ({m.p2.join(', ')}) ={' '}
                      <b>
                        {vol
                          ? `${physicalDistance(m.p1, m.p2, vol.header.spacing).toFixed(2)} mm`
                          : '—'}
                      </b>
                    </span>
                    <button className="danger" onClick={() => s.deleteMeasurement(m.id)}>
                      ×
                    </button>
                  </li>
                );
              })}
              {s.measurements.length === 0 && <li className="muted">暂无测量</li>}
            </ul>
          </section>

          <section>
            <h3>ROI（{s.rois.length}）</h3>
            <ul className="annot-list">
              {s.rois.map((r) => (
                <li key={r.id} className={r.id === s.activeRoiId ? 'active' : ''}>
                  <button className="link" onClick={() => s.setActiveRoi(r.id)}>
                    {inCompare && <em className="side-tag">{SIDE_LABEL[r.side]}</em>}
                    {VIEW_CONFIGS[r.axis].label} {r.axis === 0 ? 'I' : r.axis === 1 ? 'J' : 'K'}=
                    {r.slice}，[{r.min[0]}..{r.max[0]}]×[{r.min[1]}..{r.max[1]}]（
                    {(r.max[0] - r.min[0] + 1) * (r.max[1] - r.min[1] + 1)} 体素）
                  </button>
                  <button className="danger" onClick={() => s.deleteRoi(r.id)}>
                    ×
                  </button>
                </li>
              ))}
              {s.rois.length === 0 && <li className="muted">暂无 ROI</li>}
            </ul>
          </section>
        </>
      )}
    </aside>
  );
}
