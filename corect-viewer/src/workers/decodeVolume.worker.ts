/// <reference lib="webworker" />
import { decodeCorevol } from '../format/corevol';

const scope = self as unknown as DedicatedWorkerGlobalScope;

export interface DecodeSuccess {
  ok: true;
  volume: ReturnType<typeof decodeCorevol>;
  /** 文件内容哈希（SHA-256 十六进制），用于双体积会话的身份校验 */
  hash: string;
}

export interface DecodeFailure {
  ok: false;
  error: string;
}

/** 计算文件内容哈希；非安全上下文（无 crypto.subtle）降级为 FNV-1a（仅作身份比对） */
async function hashBuffer(buffer: ArrayBuffer): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  const bytes = new Uint8Array(buffer);
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = BigInt.asUintN(64, h * 0x100000001b3n);
  }
  return `fnv1a-${h.toString(16)}`;
}

scope.onmessage = async (e: MessageEvent<ArrayBuffer>) => {
  try {
    const buffer = e.data;
    const volume = decodeCorevol(buffer);
    const hash = await hashBuffer(buffer);
    // 体素数据是输入 buffer 上的视图，整体零拷贝转回主线程
    scope.postMessage({ ok: true, volume, hash } satisfies DecodeSuccess, [
      volume.data.buffer as ArrayBuffer,
    ]);
  } catch (err) {
    scope.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies DecodeFailure);
  }
};
