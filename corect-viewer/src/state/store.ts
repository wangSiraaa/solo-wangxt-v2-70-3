import { create } from 'zustand';
import type { DecodedVolume, Vec3 } from '../format/corevol';
import type { Measurement, Roi } from '../geometry/roi';
import { clampIjk } from '../geometry/viewMath';
import {
  commonToIjk,
  identityMapping,
  ijkToCommon,
  type Side,
  type SideMapping,
} from '../geometry/syncMap';
import type { DiffResult } from '../geometry/diffSample';
import { decodeVolumeInWorker } from '../workers/decodeClient';
import { DiffClient } from '../workers/diffClient';
import { computeFileHash } from '../format/fileHash';
import {
  evaluateSessionRestore,
  type CompareViewState,
  type WindowLevelState,
} from './sessionRestore';
import {
  deleteCompareSessionsFor,
  deleteProject as dbDeleteProject,
  getAnnotations,
  getCompareSession,
  getProject,
  listProjects,
  saveAnnotations,
  saveCompareSession,
  saveProject,
  type CompareSessionRecord,
  type ProjectMeta,
} from '../db/projectDb';

export type Tool = 'navigate' | 'measure' | 'roi';
export type { Side };

const LAST_PROJECT_KEY = 'corect:lastProjectId';
const LAST_MODE_KEY = 'corect:lastMode';
const LAST_COMPARE_KEY = 'corect:lastCompareSession';
const SAMPLE_URL = `${import.meta.env.BASE_URL}samples/synthetic-core.corevol`;
const SAMPLE_PROJECT_ID = 'sample:synthetic-core';

/** 差值探针：以十字丝公共物理位置为中心的立方体邻域（±5mm，每轴 9 点） */
const DIFF_RADIUS_MM = 5;
const DIFF_SAMPLES = 9;

export interface SideState {
  projectId: string | null;
  projectName: string;
  /** 文件内容 SHA-256：体积身份指纹，用于会话恢复校验 */
  hash: string | null;
  volume: DecodedVolume | null;
  /** 当前十字丝位置（体素索引 IJK），三个切面由此同步 */
  crosshair: Vec3;
  windowLevel: WindowLevelState;
  /** 同步落点超出本侧物理范围（已保持最近有效位置） */
  outOfBounds: boolean;
}

function emptySide(): SideState {
  return {
    projectId: null,
    projectName: '',
    hash: null,
    volume: null,
    crosshair: [0, 0, 0],
    windowLevel: { window: 1, level: 0 },
    outOfBounds: false,
  };
}

export interface AppState {
  status: 'empty' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** single：仅基准侧；compare：双体积并排比较 */
  mode: 'single' | 'compare';
  base: SideState;
  compare: SideState;
  projects: ProjectMeta[];
  /** 最近交互的一侧：差值探针以该侧十字丝的公共物理位置为中心 */
  activeSide: Side;
  tool: Tool;
  /** ROI 阈值预览的阈值 */
  threshold: number;
  /** 双体积映射（公共物理空间 = 物理坐标 + 原点偏移，可逐轴翻转） */
  mapping: { base: SideMapping; compare: SideMapping };
  /** 映射已确认：比较模式下才启用十字丝同步与差值取样 */
  mappingConfirmed: boolean;
  /** 恢复会话时检测到文件内容变化：旧映射已停用，需重新确认 */
  mappingStale: boolean;
  /** 窗宽窗位双侧联动锁定 */
  wlLocked: boolean;
  measurements: Measurement[];
  rois: Roi[];
  activeRoiId: string | null;
  /** 测量工具：已落下的第一个点（同侧内完成第二点） */
  pendingMeasure: { side: Side; ijk: Vec3 } | null;
  /** 最新差值探针结果（Worker 取样，过期响应已被客户端丢弃） */
  diff: DiffResult | null;

  refreshProjectList: () => Promise<void>;
  loadSample: () => Promise<void>;
  importFile: (file: File) => Promise<void>;
  openProject: (id: string) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  restoreLastSession: () => Promise<void>;

  /** 进入双体积比较（restore 存在时表示从 IndexedDB 恢复会话） */
  enterCompare: (
    baseId: string,
    compareId: string,
    restore?: CompareSessionRecord,
  ) => Promise<void>;
  exitCompare: () => void;
  /** 确认当前映射：启用同步，并按当前文件指纹保存会话 */
  confirmMapping: () => void;
  setMapping: (side: Side, partial: Partial<SideMapping>) => void;

  setCrosshair: (side: Side, ijk: Vec3) => void;
  setTool: (tool: Tool) => void;
  setWindowLevel: (side: Side, wl: WindowLevelState) => void;
  setWlLocked: (locked: boolean) => void;
  setThreshold: (t: number) => void;
  clickMeasurePoint: (side: Side, ijk: Vec3) => void;
  cancelPendingMeasure: () => void;
  addRoi: (side: Side, roi: Omit<Roi, 'id' | 'createdAt' | 'side'>) => void;
  deleteMeasurement: (id: string) => void;
  deleteRoi: (id: string) => void;
  setActiveRoi: (id: string | null) => void;
}

function defaultWindowLevel(volume: DecodedVolume): WindowLevelState {
  const range = volume.max - volume.min;
  return { window: Math.max(range, 1), level: volume.min + range / 2 };
}

function centerOf(dims: Vec3): Vec3 {
  return [Math.floor(dims[0] / 2), Math.floor(dims[1] / 2), Math.floor(dims[2] / 2)];
}

export function compareSessionId(baseId: string, compareId: string): string {
  return `${baseId}::${compareId}`;
}

function sideUpdate(side: Side, next: SideState): Partial<AppState> {
  return side === 'base' ? { base: next } : { compare: next };
}

/** 标注按所属侧打标：从某工程的标注记录恢复时，统一归到该侧 */
function withSide<T extends { side: Side }>(items: T[], side: Side): T[] {
  return items.map((it) => ({ ...it, side }));
}

export const useStore = create<AppState>()((set, get) => ({
  status: 'empty',
  error: null,
  mode: 'single',
  base: emptySide(),
  compare: emptySide(),
  projects: [],
  activeSide: 'base',
  tool: 'navigate',
  threshold: 0,
  mapping: { base: identityMapping(), compare: identityMapping() },
  mappingConfirmed: true,
  mappingStale: false,
  wlLocked: false,
  measurements: [],
  rois: [],
  activeRoiId: null,
  pendingMeasure: null,
  diff: null,

  refreshProjectList: async () => {
    set({ projects: await listProjects() });
  },

  loadSample: async () => {
    set({ status: 'loading', error: null });
    try {
      const resp = await fetch(SAMPLE_URL);
      if (!resp.ok) throw new Error(`样例下载失败：HTTP ${resp.status}`);
      const buffer = await resp.arrayBuffer();
      await openBuffer(SAMPLE_PROJECT_ID, buffer, set);
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },

  importFile: async (file: File) => {
    set({ status: 'loading', error: null });
    try {
      const buffer = await file.arrayBuffer();
      const id = `file:${file.name}:${file.size}`;
      await openBuffer(id, buffer, set);
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },

  openProject: async (id: string) => {
    set({ status: 'loading', error: null });
    try {
      const record = await getProject(id);
      if (!record) throw new Error('工程不存在或已被删除');
      await openBuffer(record.id, record.fileBuffer, set);
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },

  removeProject: async (id: string) => {
    const s = get();
    if (s.mode === 'compare' && (s.base.projectId === id || s.compare.projectId === id)) {
      get().exitCompare();
    }
    await dbDeleteProject(id);
    await deleteCompareSessionsFor(id);
    const lastSid = localStorage.getItem(LAST_COMPARE_KEY);
    if (lastSid && !(await getCompareSession(lastSid))) {
      localStorage.removeItem(LAST_COMPARE_KEY);
    }
    if (get().base.projectId === id) {
      set({
        status: 'empty',
        base: emptySide(),
        measurements: [],
        rois: [],
        activeRoiId: null,
        pendingMeasure: null,
        diff: null,
      });
      localStorage.removeItem(LAST_PROJECT_KEY);
    }
    set({ projects: await listProjects() });
  },

  restoreLastSession: async () => {
    set({ projects: await listProjects() });
    if (localStorage.getItem(LAST_MODE_KEY) === 'compare') {
      const sid = localStorage.getItem(LAST_COMPARE_KEY);
      const session = sid ? await getCompareSession(sid) : undefined;
      if (session) {
        const [p1, p2] = await Promise.all([
          getProject(session.baseProjectId),
          getProject(session.compareProjectId),
        ]);
        if (p1 && p2) {
          await get().enterCompare(session.baseProjectId, session.compareProjectId, session);
          return;
        }
      }
    }
    const lastId = localStorage.getItem(LAST_PROJECT_KEY);
    if (lastId && (await getProject(lastId))) {
      await get().openProject(lastId);
    }
  },

  enterCompare: async (baseId, compareId, restore) => {
    if (baseId === compareId) {
      set({ status: 'error', error: '基准与对比不能是同一份数据' });
      return;
    }
    set({ status: 'loading', error: null });
    try {
      disposeDiffClient();
      const [recBase, recCompare] = await Promise.all([
        getProject(baseId),
        getProject(compareId),
      ]);
      if (!recBase || !recCompare) throw new Error('工程不存在或已被删除');
      // 身份指纹始终按当前文件内容重算（不信缓存），用于检测内容变化
      const [hashBase, hashCompare] = await Promise.all([
        computeFileHash(recBase.fileBuffer),
        computeFileHash(recCompare.fileBuffer),
      ]);
      const [volBase, volCompare] = await Promise.all([
        decodeVolumeInWorker(recBase.fileBuffer.slice(0)),
        decodeVolumeInWorker(recCompare.fileBuffer.slice(0)),
      ]);
      const [annBase, annCompare] = await Promise.all([
        getAnnotations(baseId),
        getAnnotations(compareId),
      ]);

      let mapping = { base: identityMapping(), compare: identityMapping() };
      let mappingConfirmed = true;
      let mappingStale = false;
      let view: CompareViewState = {
        crosshairBase: centerOf(volBase.header.dims),
        crosshairCompare: centerOf(volCompare.header.dims),
        windowLevelBase: defaultWindowLevel(volBase),
        windowLevelCompare: defaultWindowLevel(volCompare),
        wlLocked: false,
      };
      if (restore) {
        const decision = evaluateSessionRestore(restore, {
          baseHash: hashBase,
          compareHash: hashCompare,
        });
        // 旧映射参数保留在界面上供查看；身份不一致时停用，待用户重新确认
        mapping = restore.mapping;
        mappingConfirmed = decision.mappingConfirmed;
        mappingStale = decision.mappingStale;
        if (decision.identityMatch) {
          view = {
            ...restore.view,
            crosshairBase: clampIjk(restore.view.crosshairBase, volBase.header.dims),
            crosshairCompare: clampIjk(restore.view.crosshairCompare, volCompare.header.dims),
          };
        }
      }

      set({
        status: 'ready',
        error: null,
        mode: 'compare',
        base: {
          projectId: baseId,
          projectName: volBase.header.name || baseId,
          hash: hashBase,
          volume: volBase,
          crosshair: view.crosshairBase,
          windowLevel: view.windowLevelBase,
          outOfBounds: false,
        },
        compare: {
          projectId: compareId,
          projectName: volCompare.header.name || compareId,
          hash: hashCompare,
          volume: volCompare,
          crosshair: view.crosshairCompare,
          windowLevel: view.windowLevelCompare,
          outOfBounds: false,
        },
        mapping,
        mappingConfirmed,
        mappingStale,
        wlLocked: view.wlLocked,
        measurements: [
          ...withSide(annBase?.measurements ?? [], 'base'),
          ...withSide(annCompare?.measurements ?? [], 'compare'),
        ],
        rois: [
          ...withSide(annBase?.rois ?? [], 'base'),
          ...withSide(annCompare?.rois ?? [], 'compare'),
        ],
        activeRoiId: null,
        pendingMeasure: null,
        activeSide: 'base',
        diff: null,
        threshold: volBase.min + (volBase.max - volBase.min) * 0.6,
        projects: await listProjects(),
      });
      localStorage.setItem(LAST_MODE_KEY, 'compare');
      localStorage.setItem(LAST_COMPARE_KEY, compareSessionId(baseId, compareId));
      initDiffClient(volBase, volCompare);
      persistNow();
      scheduleDiffSample();
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },

  exitCompare: () => {
    const s = get();
    if (s.mode !== 'compare') return;
    persistNow(); // 退出前落盘：会话保留，便于再次进入时恢复
    disposeDiffClient();
    localStorage.setItem(LAST_MODE_KEY, 'single');
    if (s.base.projectId) localStorage.setItem(LAST_PROJECT_KEY, s.base.projectId);
    set({
      mode: 'single',
      compare: emptySide(),
      mapping: { base: identityMapping(), compare: identityMapping() },
      mappingConfirmed: true,
      mappingStale: false,
      wlLocked: false,
      measurements: s.measurements.filter((m) => m.side === 'base'),
      rois: s.rois.filter((r) => r.side === 'base'),
      activeRoiId: null,
      pendingMeasure: null,
      activeSide: 'base',
      diff: null,
    });
  },

  confirmMapping: () => {
    if (get().mode !== 'compare') return;
    set({ mappingConfirmed: true, mappingStale: false });
    persistNow(); // 用当前文件指纹重新保存会话
    scheduleDiffSample();
  },

  setMapping: (side, partial) => {
    const s = get();
    const next = { ...s.mapping[side], ...partial };
    const mapping =
      side === 'base'
        ? { base: next, compare: s.mapping.compare }
        : { base: s.mapping.base, compare: next };
    // 用户主动调整映射即视为重新确认
    set({ mapping, mappingConfirmed: true, mappingStale: false });
    // 映射变化后按活动侧当前位置重新同步另一侧
    const cur = get();
    const active = cur[cur.activeSide];
    if (cur.mode === 'compare' && active.volume) {
      get().setCrosshair(cur.activeSide, active.crosshair);
    }
  },

  setCrosshair: (side, ijk) => {
    const s = get();
    const src = s[side];
    if (!src.volume) return;
    const clamped = clampIjk(ijk, src.volume.header.dims);
    const other: Side = side === 'base' ? 'compare' : 'base';
    const dst = s[other];
    if (s.mode === 'compare' && s.mappingConfirmed && dst.volume) {
      // 单向同步：源侧 → 公共物理空间 → 目标侧（夹取 + 越界标记）。
      // 目标侧更新不会回流重算源侧，从机制上杜绝越界时的跳动循环。
      const common = ijkToCommon(clamped, src.volume.header, s.mapping[side]);
      const r = commonToIjk(common, dst.volume.header, s.mapping[other]);
      set({
        ...sideUpdate(side, { ...src, crosshair: clamped, outOfBounds: false }),
        ...sideUpdate(other, { ...dst, crosshair: r.ijk, outOfBounds: r.outOfBounds }),
        activeSide: side,
      });
    } else {
      set({
        ...sideUpdate(side, { ...src, crosshair: clamped, outOfBounds: false }),
        activeSide: side,
      });
    }
    scheduleDiffSample();
  },

  setTool: (tool) => set({ tool, pendingMeasure: null }),

  setWindowLevel: (side, wl) => {
    const s = get();
    if (s.mode === 'compare' && s.wlLocked) {
      set({
        base: { ...s.base, windowLevel: wl },
        compare: { ...s.compare, windowLevel: wl },
      });
    } else {
      set(sideUpdate(side, { ...s[side], windowLevel: wl }));
    }
  },

  setWlLocked: (locked) => {
    set({ wlLocked: locked });
    if (locked) {
      // 锁定即刻对齐：以活动侧为准应用到两侧
      const s = get();
      const wl = s[s.activeSide].windowLevel;
      set({
        base: { ...s.base, windowLevel: wl },
        compare: { ...s.compare, windowLevel: wl },
      });
    }
  },

  setThreshold: (t) => set({ threshold: t }),

  clickMeasurePoint: (side, ijk) => {
    const { pendingMeasure, measurements } = get();
    if (!pendingMeasure || pendingMeasure.side !== side) {
      set({ pendingMeasure: { side, ijk }, activeSide: side });
    } else {
      set({
        measurements: [
          ...measurements,
          {
            id: crypto.randomUUID(),
            side,
            p1: pendingMeasure.ijk,
            p2: ijk,
            createdAt: Date.now(),
          },
        ],
        pendingMeasure: null,
        activeSide: side,
      });
    }
  },

  cancelPendingMeasure: () => set({ pendingMeasure: null }),

  addRoi: (side, roi) => {
    const id = crypto.randomUUID();
    set({
      rois: [...get().rois, { ...roi, side, id, createdAt: Date.now() }],
      activeRoiId: id,
      activeSide: side,
    });
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

/** 打开一个 .corevol buffer（单体积模式）：Worker 解码 → 原件入库 → 恢复标注。 */
async function openBuffer(projectId: string, buffer: ArrayBuffer, set: Set) {
  disposeDiffClient();
  // 1. Worker 解码（传入副本；解码失败则抛错，不落库）；同时计算内容指纹
  const [volume, hash] = await Promise.all([
    decodeVolumeInWorker(buffer.slice(0)),
    computeFileHash(buffer),
  ]);
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
  set({
    status: 'ready',
    error: null,
    mode: 'single',
    base: {
      projectId,
      projectName: name,
      hash,
      volume,
      crosshair: saved?.crosshair ?? centerOf(dims),
      windowLevel: defaultWindowLevel(volume),
      outOfBounds: false,
    },
    compare: emptySide(),
    mapping: { base: identityMapping(), compare: identityMapping() },
    mappingConfirmed: true,
    mappingStale: false,
    wlLocked: false,
    measurements: withSide(saved?.measurements ?? [], 'base'),
    rois: withSide(saved?.rois ?? [], 'base'),
    activeRoiId: null,
    pendingMeasure: null,
    activeSide: 'base',
    diff: null,
    threshold: volume.min + (volume.max - volume.min) * 0.6,
    projects: await listProjects(),
  });
  localStorage.setItem(LAST_PROJECT_KEY, projectId);
  localStorage.setItem(LAST_MODE_KEY, 'single');
}

// ---- 差值取样（Web Worker）----

let diffClient: DiffClient | null = null;

function disposeDiffClient() {
  diffClient?.dispose();
  diffClient = null;
}

function initDiffClient(volBase: DecodedVolume, volCompare: DecodedVolume) {
  disposeDiffClient();
  const client = new DiffClient();
  client.setOnResult((result) => {
    const s = useStore.getState();
    // 过期响应已在客户端按 requestId 丢弃；这里再防一次模式切换后的迟到结果
    if (s.mode !== 'compare') return;
    useStore.setState({ diff: result });
  });
  client.setOnError((message) => console.warn('差值取样失败：', message));
  // 体素数据副本传入 Worker（转移副本，主线程保留原数据用于渲染）
  client.init({
    base: {
      dims: volBase.header.dims,
      spacing: volBase.header.spacing,
      origin: volBase.header.origin,
      data: volBase.data.slice(),
    },
    compare: {
      dims: volCompare.header.dims,
      spacing: volCompare.header.spacing,
      origin: volCompare.header.origin,
      data: volCompare.data.slice(),
    },
  });
  diffClient = client;
}

/** 以活动侧十字丝的公共物理位置为中心发起差值取样（仅最新请求的结果生效） */
function scheduleDiffSample() {
  const s = useStore.getState();
  if (!diffClient || s.mode !== 'compare' || !s.mappingConfirmed) return;
  const active = s[s.activeSide];
  if (!active.volume || !s.base.volume || !s.compare.volume) return;
  const center = ijkToCommon(active.crosshair, active.volume.header, s.mapping[s.activeSide]);
  diffClient.sample({
    center,
    mapBase: s.mapping.base,
    mapCompare: s.mapping.compare,
    radius: DIFF_RADIUS_MM,
    samples: DIFF_SAMPLES,
  });
}

// ---- 持久化：标注（按侧归属）+ 比较会话（映射 / 身份指纹 / 视图状态）----

function persistNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const s = useStore.getState();
  if (s.status !== 'ready') return;
  const updatedAt = Date.now();
  if (s.mode === 'compare') {
    if (s.base.projectId) {
      void saveAnnotations({
        projectId: s.base.projectId,
        measurements: s.measurements.filter((m) => m.side === 'base'),
        rois: s.rois.filter((r) => r.side === 'base'),
        crosshair: s.base.crosshair,
        updatedAt,
      });
    }
    if (s.compare.projectId) {
      void saveAnnotations({
        projectId: s.compare.projectId,
        measurements: s.measurements.filter((m) => m.side === 'compare'),
        rois: s.rois.filter((r) => r.side === 'compare'),
        crosshair: s.compare.crosshair,
        updatedAt,
      });
    }
    if (s.base.projectId && s.compare.projectId && s.base.hash && s.compare.hash) {
      void saveCompareSession({
        id: compareSessionId(s.base.projectId, s.compare.projectId),
        baseProjectId: s.base.projectId,
        compareProjectId: s.compare.projectId,
        baseHash: s.base.hash,
        compareHash: s.compare.hash,
        mapping: s.mapping,
        confirmed: s.mappingConfirmed,
        view: {
          crosshairBase: s.base.crosshair,
          crosshairCompare: s.compare.crosshair,
          windowLevelBase: s.base.windowLevel,
          windowLevelCompare: s.compare.windowLevel,
          wlLocked: s.wlLocked,
        },
        updatedAt,
      });
    }
  } else if (s.base.projectId) {
    void saveAnnotations({
      projectId: s.base.projectId,
      measurements: s.measurements,
      rois: s.rois,
      crosshair: s.base.crosshair,
      updatedAt,
    });
  }
}

// 标注 / 十字丝 / 映射 / 视图状态变化后防抖写入 IndexedDB —— 刷新页面不丢失
let saveTimer: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe((state, prev) => {
  if (state.status !== 'ready') return;
  if (
    state.measurements === prev.measurements &&
    state.rois === prev.rois &&
    state.base === prev.base &&
    state.compare === prev.compare &&
    state.mapping === prev.mapping &&
    state.mappingConfirmed === prev.mappingConfirmed &&
    state.mappingStale === prev.mappingStale &&
    state.wlLocked === prev.wlLocked &&
    state.mode === prev.mode
  ) {
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 300);
});
