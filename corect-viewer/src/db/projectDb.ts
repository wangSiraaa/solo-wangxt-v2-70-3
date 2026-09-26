import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Vec3 } from '../format/corevol';
import type { Measurement, Roi } from '../geometry/roi';
import type { SideMapping } from '../geometry/syncMap';
import type { CompareViewState } from '../state/sessionRestore';

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: number;
  /** 原始 .corevol 文件内容，刷新后重新解码恢复体数据 */
  fileBuffer: ArrayBuffer;
}

export interface AnnotationRecord {
  projectId: string;
  measurements: Measurement[];
  rois: Roi[];
  crosshair: Vec3;
  updatedAt: number;
}

/**
 * 双体积比较会话：映射参数、双体积身份（内容指纹）与视图状态。
 * 刷新后按指纹校验身份，一致则恢复，任一文件内容变化则停用旧映射。
 */
export interface CompareSessionRecord {
  /** `${baseProjectId}::${compareProjectId}` */
  id: string;
  baseProjectId: string;
  compareProjectId: string;
  /** 会话保存时两份文件的内容 SHA-256 */
  baseHash: string;
  compareHash: string;
  mapping: { base: SideMapping; compare: SideMapping };
  /** 用户已确认映射（文件内容变化后恢复时为 false，需重新确认） */
  confirmed: boolean;
  view: CompareViewState;
  updatedAt: number;
}

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
}

interface CoreCtDB extends DBSchema {
  projects: { key: string; value: ProjectRecord };
  annotations: { key: string; value: AnnotationRecord };
  compareSessions: { key: string; value: CompareSessionRecord };
}

const DB_NAME = 'corect-viewer';
const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase<CoreCtDB>> | null = null;

function getDb(): Promise<IDBPDatabase<CoreCtDB>> {
  if (!dbPromise) {
    dbPromise = openDB<CoreCtDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore('projects', { keyPath: 'id' });
          db.createObjectStore('annotations', { keyPath: 'projectId' });
        }
        if (oldVersion < 2) {
          db.createObjectStore('compareSessions', { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
}

export async function saveProject(record: ProjectRecord): Promise<void> {
  const db = await getDb();
  await db.put('projects', record);
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const db = await getDb();
  const all = await db.getAll('projects');
  return all
    .map(({ id, name, createdAt }) => ({ id, name, createdAt }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getProject(id: string): Promise<ProjectRecord | undefined> {
  const db = await getDb();
  return db.get('projects', id);
}

export async function deleteProject(id: string): Promise<void> {
  const db = await getDb();
  await Promise.all([db.delete('projects', id), db.delete('annotations', id)]);
}

export async function saveAnnotations(record: AnnotationRecord): Promise<void> {
  const db = await getDb();
  await db.put('annotations', record);
}

export async function getAnnotations(projectId: string): Promise<AnnotationRecord | undefined> {
  const db = await getDb();
  return db.get('annotations', projectId);
}

export async function saveCompareSession(record: CompareSessionRecord): Promise<void> {
  const db = await getDb();
  await db.put('compareSessions', record);
}

export async function getCompareSession(id: string): Promise<CompareSessionRecord | undefined> {
  const db = await getDb();
  return db.get('compareSessions', id);
}

/** 删除引用了指定工程的所有比较会话（工程被删除时清理） */
export async function deleteCompareSessionsFor(projectId: string): Promise<void> {
  const db = await getDb();
  const all = await db.getAll('compareSessions');
  await Promise.all(
    all
      .filter((s) => s.baseProjectId === projectId || s.compareProjectId === projectId)
      .map((s) => db.delete('compareSessions', s.id)),
  );
}
