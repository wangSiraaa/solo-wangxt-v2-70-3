import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Vec3 } from '../format/corevol';
import type { Measurement, Roi } from '../geometry/roi';
import type { SideMapping } from '../geometry/compareMath';

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

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
}

/** 双体积对比会话：映射参数、双体积身份（内容哈希）与视图状态 */
export interface CompareSessionRecord {
  /** 固定 'last'：只保留最近一次会话 */
  id: string;
  projectIdA: string;
  projectIdB: string;
  /** 两侧文件内容哈希（SHA-256），任一变化则旧映射停用 */
  hashA: string;
  hashB: string;
  mappingA: SideMapping;
  mappingB: SideMapping;
  /** 共享物理坐标（比较系）下的十字丝位置 */
  crosshairPhys: Vec3;
  windowLevelA: { window: number; level: number };
  windowLevelB: { window: number; level: number };
  lockWindowLevel: boolean;
  updatedAt: number;
}

interface CoreCtDB extends DBSchema {
  projects: { key: string; value: ProjectRecord };
  annotations: { key: string; value: AnnotationRecord };
  compareSessions: { key: string; value: CompareSessionRecord };
}

const DB_NAME = 'corect-viewer';
const DB_VERSION = 2;
const SESSION_ID = 'last';

let dbPromise: Promise<IDBPDatabase<CoreCtDB>> | null = null;

function getDb(): Promise<IDBPDatabase<CoreCtDB>> {
  if (!dbPromise) {
    dbPromise = openDB<CoreCtDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('projects')) {
          db.createObjectStore('projects', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('annotations')) {
          db.createObjectStore('annotations', { keyPath: 'projectId' });
        }
        if (!db.objectStoreNames.contains('compareSessions')) {
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

export async function saveCompareSession(
  record: Omit<CompareSessionRecord, 'id'>,
): Promise<void> {
  const db = await getDb();
  await db.put('compareSessions', { ...record, id: SESSION_ID });
}

export async function getCompareSession(): Promise<CompareSessionRecord | undefined> {
  const db = await getDb();
  return db.get('compareSessions', SESSION_ID);
}

export async function deleteCompareSession(): Promise<void> {
  const db = await getDb();
  await db.delete('compareSessions', SESSION_ID);
}
