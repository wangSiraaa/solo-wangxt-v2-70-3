import type { DecodedVolume } from '../format/corevol';
import type { DecodeFailure, DecodeSuccess } from './decodeVolume.worker';

type DecodeResponse = DecodeSuccess | DecodeFailure;

export interface DecodedResult {
  volume: DecodedVolume;
  /** 文件内容哈希（SHA-256），用于双体积会话身份校验 */
  hash: string;
}

/** 在 Web Worker 中解码 .corevol 文件（buffer 会被转移，调用方不要再使用）。 */
export function decodeVolumeInWorker(buffer: ArrayBuffer): Promise<DecodedResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./decodeVolume.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (e: MessageEvent<DecodeResponse>) => {
      worker.terminate();
      if (e.data.ok) resolve({ volume: e.data.volume, hash: e.data.hash });
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(`解码线程错误：${e.message}`));
    };
    worker.postMessage(buffer, [buffer]);
  });
}
