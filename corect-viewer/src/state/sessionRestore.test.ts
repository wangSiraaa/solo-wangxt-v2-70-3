import { describe, expect, it } from 'vitest';
import { evaluateSessionRestore } from './sessionRestore';

const H_A = 'a'.repeat(64);
const H_B = 'b'.repeat(64);
const H_A2 = 'a2'.padEnd(64, 'x');
const H_B2 = 'b2'.padEnd(64, 'x');

describe('双体积会话恢复判定', () => {
  it('两份文件身份均一致 → 恢复并启用已确认的映射', () => {
    const d = evaluateSessionRestore(
      { baseHash: H_A, compareHash: H_B, confirmed: true },
      { baseHash: H_A, compareHash: H_B },
    );
    expect(d.identityMatch).toBe(true);
    expect(d.mappingConfirmed).toBe(true);
    expect(d.mappingStale).toBe(false);
  });

  it('身份一致但保存时映射未确认 → 恢复后仍不启用', () => {
    const d = evaluateSessionRestore(
      { baseHash: H_A, compareHash: H_B, confirmed: false },
      { baseHash: H_A, compareHash: H_B },
    );
    expect(d.identityMatch).toBe(true);
    expect(d.mappingConfirmed).toBe(false);
    expect(d.mappingStale).toBe(false);
  });

  it('基准文件内容改变 → 停用旧映射，要求重新确认', () => {
    const d = evaluateSessionRestore(
      { baseHash: H_A, compareHash: H_B, confirmed: true },
      { baseHash: H_A2, compareHash: H_B },
    );
    expect(d.identityMatch).toBe(false);
    expect(d.mappingConfirmed).toBe(false);
    expect(d.mappingStale).toBe(true);
  });

  it('对比文件内容改变 → 同样停用旧映射', () => {
    const d = evaluateSessionRestore(
      { baseHash: H_A, compareHash: H_B, confirmed: true },
      { baseHash: H_A, compareHash: H_B2 },
    );
    expect(d.identityMatch).toBe(false);
    expect(d.mappingStale).toBe(true);
  });
});
