/**
 * 生成双体积比较验收样例对：
 *   public/samples/compare-a.corevol（基准）
 *   public/samples/compare-b.corevol（对比）
 *
 * 设计目标（对应「双体积并排同步比较」验收清单）：
 * - 间距不同但物理范围相同：均为 32 × 32 × 80 mm
 *   A: dims [33,33,41]   spacing [1.0, 1.0, 2.0]
 *   B: dims [65,65,81]   spacing [0.5, 0.5, 1.0]
 *   → 恒等映射下 B 的体素索引恒为 A 的 2 倍
 * - 体素值是物理坐标的确定函数（两侧同源）→ 同一物理位置灰度接近
 * - 标志块：物理 (8,8,20) 处 3×3×3 值 255（A ijk 中心 (8,8,10)，B ijk 中心 (16,16,20)）
 * - 仅 B 在物理 (16,16,40) 处有 +80「病灶」球（半径 5mm）→ 差值探针可见 Δ≈-80
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAGIC = [0x43, 0x4f, 0x52, 0x45, 0x56, 0x4f, 0x4c, 0x00];

/** 物理坐标 → 基础灰度（两侧共用，保证同物理位置同源） */
function baseValue(x, y, z) {
  return 120 + 40 * Math.sin(x / 6) * Math.cos(y / 6) + 30 * Math.sin(z / 12);
}

const LESION = { x: 16, y: 16, z: 40, r: 5, boost: 80 }; // 仅 B 有
const MARKER_PHYS = [8, 8, 20]; // 标志块中心（物理 mm）

function buildVolume({ dims, spacing, name, lesion }) {
  const [NI, NJ, NK] = dims;
  const data = new Uint8Array(NI * NJ * NK);
  const idx = (i, j, k) => i + NI * (j + NJ * k);
  for (let k = 0; k < NK; k++) {
    for (let j = 0; j < NJ; j++) {
      for (let i = 0; i < NI; i++) {
        const x = i * spacing[0];
        const y = j * spacing[1];
        const z = k * spacing[2];
        let v = baseValue(x, y, z);
        if (lesion) {
          const d = Math.hypot(x - LESION.x, y - LESION.y, z - LESION.z);
          if (d <= LESION.r) v += LESION.boost;
        }
        data[idx(i, j, k)] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }
  // 标志块 3×3×3 值 255，中心在 MARKER_PHYS 对应的体素
  const mi = Math.round(MARKER_PHYS[0] / spacing[0]);
  const mj = Math.round(MARKER_PHYS[1] / spacing[1]);
  const mk = Math.round(MARKER_PHYS[2] / spacing[2]);
  for (let dk = -1; dk <= 1; dk++)
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) data[idx(mi + di, mj + dj, mk + dk)] = 255;
  return { dims, spacing, name, data };
}

function writeCorevol(path, { dims, spacing, name, data }) {
  const nameBytes = Buffer.from(name, 'utf8');
  const headerSize = Math.ceil((78 + nameBytes.length) / 8) * 8;
  const buffer = Buffer.alloc(headerSize + data.byteLength);
  MAGIC.forEach((b, i) => (buffer[i] = b));
  buffer.writeUInt16LE(1, 8); // version
  buffer.writeUInt16LE(0, 10); // dtype uint8
  buffer.writeUInt32LE(headerSize, 12);
  buffer.writeUInt32LE(dims[0], 16);
  buffer.writeUInt32LE(dims[1], 20);
  buffer.writeUInt32LE(dims[2], 24);
  buffer.writeDoubleLE(spacing[0], 28);
  buffer.writeDoubleLE(spacing[1], 36);
  buffer.writeDoubleLE(spacing[2], 44);
  buffer.writeDoubleLE(0, 52); // origin
  buffer.writeDoubleLE(0, 60);
  buffer.writeDoubleLE(0, 68);
  buffer.writeUInt16LE(nameBytes.length, 76);
  nameBytes.copy(buffer, 78);
  Buffer.from(data.buffer).copy(buffer, headerSize);
  writeFileSync(path, buffer);
  console.log(`已生成 ${path}（${(buffer.length / 1024).toFixed(1)} KB）`);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../public/samples');
mkdirSync(outDir, { recursive: true });

// A：间距 1×1×2 mm；B：间距 0.5×0.5×1 mm —— 物理范围同为 32×32×80 mm
writeCorevol(
  join(outDir, 'compare-a.corevol'),
  buildVolume({ dims: [33, 33, 41], spacing: [1.0, 1.0, 2.0], name: 'compare-a', lesion: false }),
);
writeCorevol(
  join(outDir, 'compare-b.corevol'),
  buildVolume({ dims: [65, 65, 81], spacing: [0.5, 0.5, 1.0], name: 'compare-b', lesion: true }),
);
