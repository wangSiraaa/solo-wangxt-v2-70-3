import { create } from 'zustand';
import type { DecodedVolume, Vec3 } from '../format/corevol';
import type { Measurement, Roi } from '../geometry/roi';
import { clampIjk } from '../geometry/viewMath';
import {
  cursorFromA,
  cursorFromB,
  cursorFromPhys,
  identityMapping,
  sessionRestorable,
  type SideMapping,
} from '../geometry/compareMath';
import { decodeVolumeInWorker } from '../workers/decodeClient';
import {
  clearSampleVolumes,
  onSampleResult,
  requestSample,
  setSampleVolume,
} from '../workers/sampleClient';
import {
  deleteCompareSession as dbDeleteCompareSession,
  deleteProject as dbDeleteProject,
  getAnnotations,
  getCompareSession,
  getProject,
  listProjects,
  saveAnnotations,
  saveCompareSession,
  saveProject,
  type ProjectMeta,
  type ProjectRecord,
} from '../db/projectDb';

export type Tool = 'navigate' | 'measure' | 'roi';
/** 对比两侧：A=基准，B=对比 */
export type Side = 'A' | 'B';

const LAST_PROJECT_KEY = 'corect:lastProjectId';
const SAMPLE_URL = `${import.meta.env.BASE_URL}samples/synthetic-core.corevol`;
const SAMPLE_PROJECT_ID = 'sample:synthetic-core';
const SAMPLE_B_URL = `${import.meta.env.BASE_URL}samples/synthetic-core-b.corevol`;
const SAMPLE_B_PROJECT_ID = 'sample:synthetic-core-b';

const NO_CLAMP: [boolean, boolean, boolean] = [false, false, false];

export interface AppState {
  status: 'empty' | 'loading' | 'ready' | 'error';
  error: string | null;
  projectId: string | null;
  projectName: string;
  projects: ProjectMeta[];
  volume: DecodedVolume | null;
  /** 当前十字丝位置（体素索引 IJK），三个切面由此同步 */
  crosshair: Vec3;
  tool: Tool;
  windowLevel: { window: number; level: number };
  /** ROI 阈值预览的阈值 */
  threshold: number;
  measurements: Measurement[];
  rois: Roi[];
  activeRoiId: string | null;
  /** 测量工具：已落下的第一个点（可跨视图完成第二点，但限同侧） */
  pendingMeasure: { side: Side; ijk: Vec3 } | null;

  // ---- 双体积并排对比 ----
  compareMode: boolean;
  volumeB: DecodedVolume | null;
  projectIdB: string | null;
  projectNameB: string;
  /** 两侧文件内容哈希（加载时计算），会话身份校验用 */
  hashA: string | null;
  hashB: string | null;
  /** 轴向翻转 + 原点偏移映射（各自侧） */
  mappingA: SideMapping;
  mappingB: SideMapping;
  /** 共享物理坐标（比较系）下的十字丝：双体积同步的真源 */
  crosshairPhys: Vec3 | null;
  crosshairB: Vec3;
  /** 各侧是否因对方越界而被夹取（逐轴），用于显式提示 */
  clampedA: [boolean, boolean, boolean];
  clampedB: [boolean, boolean, boolean];
  windowLevelB: { window: number; level: number };
  lockWindowLevel: boolean;
  /** 恢复会话时文件内容已变化：旧映射已停用，待用户重新确认 */
  mappingStale: boolean;
  /** 同一物理位置两侧的灰度取样值（Worker 计算） */
  sampleValues: { a: number | null; b: number | null } | null;
  compareError: string | null;

  refreshProjectList: () => Promise<void>;
  loadSample: () => Promise<void>;
  importFile: (file: File) => Promise<void>;
  openProject: (id: string) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  loadLastProject: () => Promise<void>;

  loadSampleB: () => Promise<void>;
  importFileB: (file: File) => Promise<void>;
  openProjectB: (id: string) => Promise<void>;
  closeCompare: () => Promise<void>;
  confirmMapping: () => void;

  setCrosshair: (ijk: Vec3) => void;
  setCrosshairB: (ijk: Vec3) => void;
  setMappingA: (m: SideMapping) => void;
  setMappingB: (m: SideMapping) => void;
  setTool: (tool: Tool) => void;
  setWindowLevel: (wl: { window: number; level: number }) => void;
  setWindowLevelB: (wl: { window: number; level: number }) => void;
  setLockWindowLevel: (lock: boolean) => void;
  setThreshold: (t: number) => void;
  clickMeasurePoint: (side: Side, ijk: Vec3) => void;
  cancelPendingMeasure: () => void;
  addRoi: (roi: Omit<Roi, 'id' | 'createdAt'>) => void;
  deleteMeasurement: (id: string) => void;
  deleteRoi: (id: string) => void;
  setActiveRoi: (id: string | null) => void;
}

function defaultWindowLevel(volume: DecodedVolume): { window: number; level: number } {
  const range = volume.max - volume.min;
  return { window: Math.max(range, 1), level: volume.min + range / 2 };
}

export const useStore = create<AppState>()((set, get) => ({
  status: 'empty',
  error: null,
  projectId: null,
  projectName: '',
  projects: [],
  volume: null,
  crosshair: [0, 0, 0],
  tool: 'navigate',
  windowLevel: { window: 1, level: 0 },
  threshold: 0,
  measurements: [],
  rois: [],
  activeRoiId: null,
  pendingMeasure: null,

  compareMode: false,
  volumeB: null,
  projectIdB: null,
  projectNameB: '',
  hashA: null,
  hashB: null,
  mappingA: identityMapping(),
  mappingB: identityMapping(),
  crosshairPhys: null,
  crosshairB: [0, 0, 0],
  clampedA: [...NO_CLAMP],
  clampedB: [...NO_CLAMP],
  windowLevelB: { window: 1, level: 0 },
  lockWindowLevel: false,
  mappingStale: false,
  sampleValues: null,
  compareError: null,

  refreshProjectList: async () => {
    set({ projects: await listProjects() });
  },

  loadSample: async () => {
    set({ status: 'loading', error: null });
    try {
      const resp = await fetch(SAMPLE_URL);
      if (!resp.ok) throw new Error(`样例下载失败：HTTP ${resp.status}`);
      const buffer = await resp.arrayBuffer();
      await openBuffer(SAMPLE_PROJECT_ID, buffer, set, get);
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },

  importFile: async (file: File) => {
    set({ status: 'loading', error: null });
    try {
      const buffer = await file.arrayBuffer();
      const id = `file:${file.name}:${file.size}`;
      await openBuffer(id, buffer, set, get);
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },

  openProject: async (id: string) => {
    set({ status: 'loading', error: null });
    try {
      const record = await getProject(id);
      if (!record) throw new Error('工程不存在或已被删除');
      await openBuffer(record.id, record.fileBuffer, set, get);
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },

  removeProject: async (id: string) => {
    await dbDeleteProject(id);
    const s = get();
    if (s.projectIdB === id) {
      await get().closeCompare();
    }
    if (get().projectId === id) {
      resetToEmpty(set);
      localStorage.removeItem(LAST_PROJECT_KEY);
    }
    set({ projects: await listProjects() });
  },

  loadLastProject: async () => {
    set({ projects: await listProjects() });
    // 优先恢复双体积对比会话（两份工程都在且身份可校验）
    const session = await getCompareSession();
    if (session) {
      const [recA, recB] = await Promise.all([
        getProject(session.projectIdA),
        getProject(session.projectIdB),
      ]);
      if (recA && recB) {
        await restoreCompareSession(session, recA, recB, set);
        return;
      }
      await dbDeleteCompareSession(); // 工程已被删除，会话失效
    }
    const lastId = localStorage.getItem(LAST_PROJECT_KEY);
    if (lastId && (await getProject(lastId))) {
      await get().openProject(lastId);
    }
  },

  loadSampleB: async () => {
    set({ compareError: null });
    try {
      const resp = await fetch(SAMPLE_B_URL);
      if (!resp.ok) throw new Error(`对比样例下载失败：HTTP ${resp.status}`);
      const buffer = await resp.arrayBuffer();
      await openCompareBuffer(SAMPLE_B_PROJECT_ID, buffer, set, get);
    } catch (err) {
      set({ compareError: err instanceof Error ? err.message : String(err) });
    }
  },

  importFileB: async (file: File) => {
    set({ compareError: null });
    try {
      const buffer = await file.arrayBuffer();
      const id = `file:${file.name}:${file.size}`;
      await openCompareBuffer(id, buffer, set, get);
    } catch (err) {
      set({ compareError: err instanceof Error ? err.message : String(err) });
    }
  },

  openProjectB: async (id: string) => {
    set({ compareError: null });
    try {
      const record = await getProject(id);
      if (!record) throw new Error('工程不存在或已被删除');
      await openCompareBuffer(record.id, record.fileBuffer, set, get);
    } catch (err) {
      set({ compareError: err instanceof Error ? err.message : String(err) });
    }
  },

  closeCompare: async () => {
    clearSampleVolumes();
    await dbDeleteCompareSession();
    set({
      compareMode: false,
      volumeB: null,
      projectIdB: null,
      projectNameB: '',
      hashB: null,
      mappingA: identityMapping(),
      mappingB: identityMapping(),
      crosshairPhys: null,
      crosshairB: [0, 0, 0],
      clampedA: [...NO_CLAMP],
      clampedB: [...NO_CLAMP],
      lockWindowLevel: false,
      mappingStale: false,
      sampleValues: null,
      compareError: null,
      pendingMeasure: get().pendingMeasure?.side === 'B' ? null : get().pendingMeasure,
    });
  },

  confirmMapping: () => {
    if (!get().compareMode) return;
    set({ mappingStale: false });
    void persistCompareSession(get);
  },

  setCrosshair: (ijk) => {
    const s = get();
    if (!s.volume) return;
    const clamped = clampIjk(ijk, s.volume.header.dims);
    if (!s.compareMode || !s.volumeB) {
      set({ crosshair: clamped });
      return;
    }
    // 双体积：A 侧移动 → 共享物理坐标 → 推导 B 侧（单向推导，不会回写循环）
    const cur = cursorFromA(clamped, s.volume.header, s.mappingA, s.volumeB.header, s.mappingB);
    set({
      crosshair: cur.ijkA,
      clampedA: cur.clampedA,
      crosshairB: cur.ijkB,
      clampedB: cur.clampedB,
      crosshairPhys: cur.phys,
    });
  },

  setCrosshairB: (ijk) => {
    const s = get();
    if (!s.compareMode || !s.volumeB || !s.volume) return;
    const clamped = clampIjk(ijk, s.volumeB.header.dims);
    const cur = cursorFromB(clamped, s.volume.header, s.mappingA, s.volumeB.header, s.mappingB);
    set({
      crosshair: cur.ijkA,
      clampedA: cur.clampedA,
      crosshairB: cur.ijkB,
      clampedB: cur.clampedB,
      crosshairPhys: cur.phys,
    });
  },

  setMappingA: (m) => {
    set({ mappingA: m });
    remapCursor(set, get);
  },

  setMappingB: (m) => {
    set({ mappingB: m });
    remapCursor(set, get);
  },

  setTool: (tool) => set({ tool, pendingMeasure: null }),

  setWindowLevel: (wl) => {
    if (get().lockWindowLevel && get().compareMode) {
      set({ windowLevel: wl, windowLevelB: wl });
    } else {
      set({ windowLevel: wl });
    }
  },

  setWindowLevelB: (wl) => {
    if (get().lockWindowLevel && get().compareMode) {
      set({ windowLevel: wl, windowLevelB: wl });
    } else {
      set({ windowLevelB: wl });
    }
  },

  setLockWindowLevel: (lock) => {
    // 启用锁定时以 A 侧为准对齐两侧
    if (lock) set({ lockWindowLevel: true, windowLevelB: get().windowLevel });
    else set({ lockWindowLevel: false });
  },

  setThreshold: (t) => set({ threshold: t }),

  clickMeasurePoint: (side, ijk) => {
    const { pendingMeasure, measurements, volume, volumeB } = get();
    const vol = side === 'A' ? volume : volumeB;
    if (!vol) return;
    if (!pendingMeasure || pendingMeasure.side !== side) {
      set({ pendingMeasure: { side, ijk } });
    } else {
      set({
        measurements: [
          ...measurements,
          {
            id: crypto.randomUUID(),
            p1: pendingMeasure.ijk,
            p2: ijk,
            side,
            spacing: [...vol.header.spacing] as Vec3,
            createdAt: Date.now(),
          },
        ],
        pendingMeasure: null,
      });
    }
  },

  cancelPendingMeasure: () => set({ pendingMeasure: null }),

  addRoi: (roi) => {
    const id = crypto.randomUUID();
    set({ rois: [...get().rois, { ...roi, id, createdAt: Date.now() }], activeRoiId: id });
  },

  deleteMeasurement: (id) =>
    set({ measurements: get().measurements.filter((m) => m.id !== id) }),

  deleteRoi: (id) =>
    set({
      rois: get().rois.filter((r) => r.id !== id),
      activeRoiId: get().activeRoiId === id ? null : get().activeRoiId,
    }),

  setActiveRoi: (id) => set({ activeRoiId: id }),
}));

type Set = (partial: Partial<AppState>) => void;
type Get = () => AppState;

/** 清空到未加载状态（删除当前工程时） */
function resetToEmpty(set: Set) {
  clearSampleVolumes();
  void dbDeleteCompareSession();
  set({
    status: 'empty',
    projectId: null,
    projectName: '',
    volume: null,
    hashA: null,
    measurements: [],
    rois: [],
    activeRoiId: null,
    pendingMeasure: null,
    crosshair: [0, 0, 0],
    compareMode: false,
    volumeB: null,
    projectIdB: null,
    projectNameB: '',
    hashB: null,
    mappingA: identityMapping(),
    mappingB: identityMapping(),
    crosshairPhys: null,
    crosshairB: [0, 0, 0],
    clampedA: [...NO_CLAMP],
    clampedB: [...NO_CLAMP],
    lockWindowLevel: false,
    mappingStale: false,
    sampleValues: null,
    compareError: null,
  });
}

/** 映射参数变化后：共享物理坐标锚定不动，重新推导两侧光标 */
function remapCursor(set: Set, get: Get) {
  const { compareMode, volume, volumeB, mappingA, mappingB, crosshairPhys } = get();
  if (!compareMode || !volume || !volumeB || !crosshairPhys) return;
  const cur = cursorFromPhys(crosshairPhys, volume.header, mappingA, volumeB.header, mappingB);
  set({
    crosshair: cur.ijkA,
    clampedA: cur.clampedA,
    crosshairB: cur.ijkB,
    clampedB: cur.clampedB,
  });
}

/** 打开基准侧（A）.corevol buffer：Worker 解码（用副本，会被转移）→ 原件入 IndexedDB → 恢复标注。 */
async function openBuffer(projectId: string, buffer: ArrayBuffer, set: Set, get: Get) {
  // 1. Worker 解码（传入副本；解码失败则抛错，不落库）
  const { volume, hash } = await decodeVolumeInWorker(buffer.slice(0));
  const name = volume.header.name || projectId;
  // 2. 原始文件入库，刷新页面后可恢复体数据
  const existing = await getProject(projectId);
  await saveProject({
    id: projectId,
    name,
    createdAt: existing?.createdAt ?? Date.now(),
    fileBuffer: buffer,
  });
  // 3. 恢复标注（不存在则用体数据中心作为初始十字丝）
  const saved = await getAnnotations(projectId);
  const { dims } = volume.header;
  const center = clampIjk(
    [Math.floor(dims[0] / 2), Math.floor(dims[1] / 2), Math.floor(dims[2] / 2)],
    dims,
  );
  const crosshair = saved?.crosshair ?? center;
  set({
    status: 'ready',
    error: null,
    projectId,
    projectName: name,
    volume,
    hashA: hash,
    crosshair,
    measurements: saved?.measurements ?? [],
    rois: saved?.rois ?? [],
    activeRoiId: null,
    pendingMeasure: null,
    windowLevel: defaultWindowLevel(volume),
    threshold: volume.min + (volume.max - volume.min) * 0.6,
    projects: await listProjects(),
  });
  localStorage.setItem(LAST_PROJECT_KEY, projectId);
  // 4. 对比模式开着时换了基准：重设取样数据并按当前映射重新同步
  const s = get();
  if (s.compareMode && s.volumeB) {
    const phys = cursorFromA(crosshair, volume.header, s.mappingA, s.volumeB.header, s.mappingB);
    set({
      crosshair: phys.ijkA,
      clampedA: phys.clampedA,
      crosshairB: phys.ijkB,
      clampedB: phys.clampedB,
      crosshairPhys: phys.phys,
    });
    setSampleVolume('A', volume.data, volume.header.dims);
  }
}

/** 打开对比侧（B）.corevol buffer 并进入双体积对比模式。 */
async function openCompareBuffer(projectIdB: string, buffer: ArrayBuffer, set: Set, get: Get) {
  const base = get();
  if (!base.volume) throw new Error('请先加载基准体积（A）');
  // 1. Worker 解码
  const { volume: volumeB, hash: hashB } = await decodeVolumeInWorker(buffer.slice(0));
  const name = volumeB.header.name || projectIdB;
  // 2. 原始文件入库
  const existing = await getProject(projectIdB);
  await saveProject({
    id: projectIdB,
    name,
    createdAt: existing?.createdAt ?? Date.now(),
    fileBuffer: buffer,
  });
  // 3. 以 A 侧当前十字丝的物理位置为锚进入对比
  const mappingA = identityMapping();
  const mappingB = identityMapping();
  const cur = cursorFromA(
    base.crosshair,
    base.volume.header,
    mappingA,
    volumeB.header,
    mappingB,
  );
  set({
    compareMode: true,
    volumeB,
    projectIdB,
    projectNameB: name,
    hashB,
    mappingA,
    mappingB,
    crosshairPhys: cur.phys,
    crosshair: cur.ijkA,
    clampedA: cur.clampedA,
    crosshairB: cur.ijkB,
    clampedB: cur.clampedB,
    windowLevelB: defaultWindowLevel(volumeB),
    lockWindowLevel: false,
    mappingStale: false,
    sampleValues: null,
    compareError: null,
    pendingMeasure: null,
    projects: await listProjects(),
  });
  // 4. 大体积取样交给 Worker（数据副本转移，主线程不卡顿）
  setSampleVolume('A', base.volume.data, base.volume.header.dims);
  setSampleVolume('B', volumeB.data, volumeB.header.dims);
  requestSample(cur.ijkA, cur.ijkB);
  // 5. 立即持久化会话（双体积身份 + 映射 + 视图状态）
  await persistCompareSession(get);
}

/** 刷新后恢复双体积会话：身份一致 → 完整恢复；任一文件内容改变 → 停用旧映射待确认 */
async function restoreCompareSession(
  session: NonNullable<Awaited<ReturnType<typeof getCompareSession>>>,
  recA: ProjectRecord,
  recB: ProjectRecord,
  set: Set,
) {
  set({ status: 'loading', error: null });
  try {
    const [a, b] = await Promise.all([
      decodeVolumeInWorker(recA.fileBuffer.slice(0)),
      decodeVolumeInWorker(recB.fileBuffer.slice(0)),
    ]);
    const restorable = sessionRestorable(
      { hashA: session.hashA, hashB: session.hashB },
      { hashA: a.hash, hashB: b.hash },
    );
    // 身份一致 → 恢复保存的映射与视图状态；否则停用旧映射（重置为恒等）
    const mappingA = restorable ? session.mappingA : identityMapping();
    const mappingB = restorable ? session.mappingB : identityMapping();
    const saved = await getAnnotations(recA.id);
    const { dims } = a.volume.header;
    const center = clampIjk(
      [Math.floor(dims[0] / 2), Math.floor(dims[1] / 2), Math.floor(dims[2] / 2)],
      dims,
    );
    const crosshairA0 = saved?.crosshair ?? center;
    const phys = restorable
      ? session.crosshairPhys
      : cursorFromA(crosshairA0, a.volume.header, mappingA, b.volume.header, mappingB).phys;
    const cur = cursorFromPhys(phys, a.volume.header, mappingA, b.volume.header, mappingB);
    set({
      status: 'ready',
      error: null,
      projectId: recA.id,
      projectName: a.volume.header.name || recA.id,
      volume: a.volume,
      hashA: a.hash,
      compareMode: true,
      volumeB: b.volume,
      projectIdB: recB.id,
      projectNameB: b.volume.header.name || recB.id,
      hashB: b.hash,
      mappingA,
      mappingB,
      mappingStale: !restorable,
      crosshairPhys: cur.phys,
      crosshair: cur.ijkA,
      clampedA: cur.clampedA,
      crosshairB: cur.ijkB,
      clampedB: cur.clampedB,
      windowLevel: restorable ? session.windowLevelA : defaultWindowLevel(a.volume),
      windowLevelB: restorable ? session.windowLevelB : defaultWindowLevel(b.volume),
      lockWindowLevel: restorable ? session.lockWindowLevel : false,
      measurements: saved?.measurements ?? [],
      rois: saved?.rois ?? [],
      activeRoiId: null,
      pendingMeasure: null,
      threshold: a.volume.min + (a.volume.max - a.volume.min) * 0.6,
      sampleValues: null,
      compareError: null,
      projects: await listProjects(),
    });
    localStorage.setItem(LAST_PROJECT_KEY, recA.id);
    setSampleVolume('A', a.volume.data, a.volume.header.dims);
    setSampleVolume('B', b.volume.data, b.volume.header.dims);
    requestSample(cur.ijkA, cur.ijkB);
  } catch (err) {
    set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

/** 立即持久化对比会话（双体积身份 + 映射 + 视图状态） */
async function persistCompareSession(get: Get) {
  const s = get();
  if (!s.compareMode || !s.projectId || !s.projectIdB || !s.hashA || !s.hashB) return;
  if (!s.crosshairPhys) return;
  await saveCompareSession({
    projectIdA: s.projectId,
    projectIdB: s.projectIdB,
    hashA: s.hashA,
    hashB: s.hashB,
    mappingA: s.mappingA,
    mappingB: s.mappingB,
    crosshairPhys: s.crosshairPhys,
    windowLevelA: s.windowLevel,
    windowLevelB: s.windowLevelB,
    lockWindowLevel: s.lockWindowLevel,
    updatedAt: Date.now(),
  });
}

// ---- 订阅：标注/十字丝变化后防抖写入 IndexedDB —— 刷新页面不丢失 ----
let saveTimer: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe((state, prev) => {
  if (!state.projectId || state.status !== 'ready') return;
  if (
    state.measurements === prev.measurements &&
    state.rois === prev.rois &&
    state.crosshair === prev.crosshair
  ) {
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const s = useStore.getState();
    if (!s.projectId) return;
    void saveAnnotations({
      projectId: s.projectId,
      measurements: s.measurements,
      rois: s.rois,
      crosshair: s.crosshair,
      updatedAt: Date.now(),
    });
  }, 300);
});

// ---- 订阅：对比会话（映射 / 物理光标 / 窗宽窗位 / 联动锁）变化后防抖保存 ----
// 注意：mappingStale（文件内容已变、待确认）期间不覆盖旧会话，直到用户显式确认
let sessionTimer: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe((state, prev) => {
  if (!state.compareMode || state.mappingStale || state.status !== 'ready') return;
  if (
    state.mappingA === prev.mappingA &&
    state.mappingB === prev.mappingB &&
    state.crosshairPhys === prev.crosshairPhys &&
    state.windowLevel === prev.windowLevel &&
    state.windowLevelB === prev.windowLevelB &&
    state.lockWindowLevel === prev.lockWindowLevel
  ) {
    return;
  }
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => void persistCompareSession(useStore.getState), 300);
});

// ---- 订阅：对比模式下光标移动 → Worker 取样（过期响应不会覆盖最新光标） ----
useStore.subscribe((state, prev) => {
  if (!state.compareMode || state.status !== 'ready') return;
  if (state.crosshair === prev.crosshair && state.crosshairB === prev.crosshairB) return;
  requestSample(state.crosshair, state.crosshairB);
});

onSampleResult((a, b) => {
  if (!useStore.getState().compareMode) return;
  useStore.setState({ sampleValues: { a, b } });
});
