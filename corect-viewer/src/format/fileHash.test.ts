import { describe, expect, it } from 'vitest';
import { computeFileHash } from './fileHash';

describe('文件内容身份指纹', () => {
  it('内容一致哈希一致，单字节变化即产生不同哈希', async () => {
    const a = new Uint8Array([1, 2, 3, 4]).buffer;
    const b = new Uint8Array([1, 2, 3, 4]).buffer;
    const c = new Uint8Array([1, 2, 3, 5]).buffer;
    expect(await computeFileHash(a)).toBe(await computeFileHash(b));
    expect(await computeFileHash(a)).not.toBe(await computeFileHash(c));
  });

  it('输出为 64 位十六进制（SHA-256）', async () => {
    const h = await computeFileHash(new Uint8Array([0, 255]).buffer);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
