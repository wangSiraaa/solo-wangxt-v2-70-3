/**
 * 生成合成岩芯样例 public/samples/synthetic-core.corevol
 *
 * 设计目标（用于验证坐标系与测量，详见 README「验证清单」）：
 * - 各向异性间距：0.5 × 0.5 × 2.0 mm（K 方向稀疏，模拟真实 CT 层厚）
 * - 验证立方体：IJK [98..102]×[28..32]×[10..14]，值 255，中心 (100,30,12) → 物理 (50,15,24) mm
 * - 标志点 A=(24,24,60)、B=(84,104,120)（值 255 小球）：
 *   体素差 (60,80,60) → 物理差 (30,40,120) mm → 距离恰为 130 mm
 * - 岩芯圆柱：IJ 面圆心 (63.5,63.5)，半径 62 体素（Ø 62 mm），轴沿 K
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIMS = [128, 128, 200];
const SPACING = [0.5, 0.5, 2.0];
const ORIGIN = [0, 0, 0];
const NAME = 'synthetic-core-aniso';

const [NI, NJ, NK] = DIMS;
const data = new Uint8Array(NI * NJ * NK);

const idx = (i, j, k) => i + NI * (j + NJ * k);

// 确定性伪随机（层理抖动用），保证多次生成结果一致
const jitter = (i, j, k) => {
  const h = ((i * 73856093) ^ (j * 19349663) ^ (k * 83492791)) >>> 0;
  return ((h % 1000) / 1000 - 0.5) * 12;
};

const CX = 63.5;
const CY = 63.5;
const RADIUS = 62;

for (let k = 0; k < NK; k++) {
  // 层理：沿 K 的正弦灰度变化
  const bedding = 96 + 28 * Math.sin((2 * Math.PI * k) / 24);
  for (let j = 0; j < NJ; j++) {
    for (let i = 0; i < NI; i++) {
      const di = i - CX;
      const dj = j - CY;
      const r = Math.sqrt(di * di + dj * dj);
      if (r > RADIUS) continue; // 岩芯外为空气（0）
      let v = bedding + jitter(i, j, k);
      // 致密夹层
      if (k >= 100 && k < 110) v += 50;
      // 张性裂隙（低值带）
      if (k >= 150 && k < 153 && r < 25) v = 30;
      data[idx(i, j, k)] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
}

// 黄铁矿结核（高密度球）
function paintSphere(ci, cj, ck, radius, value) {
  for (let k = Math.floor(ck - radius); k <= Math.ceil(ck + radius); k++) {
    for (let j = Math.floor(cj - radius); j <= Math.ceil(cj + radius); j++) {
      for (let i = Math.floor(ci - radius); i <= Math.ceil(ci + radius); i++) {
        if (i < 0 || j < 0 || k < 0 || i >= NI || j >= NJ || k >= NK) continue;
        const d = Math.sqrt((i - ci) ** 2 + (j - cj) ** 2 + (k - ck) ** 2);
        if (d <= radius) data[idx(i, j, k)] = value;
      }
    }
  }
}

paintSphere(40, 80, 60, 6, 230);
paintSphere(90, 40, 140, 8, 230);

// 验证立方体 5×5×5，中心 (100,30,12)
for (let k = 10; k <= 14; k++)
  for (let j = 28; j <= 32; j++)
    for (let i = 98; i <= 102; i++) data[idx(i, j, k)] = 255;

// 测量验证标志点（最后绘制，保证不被覆盖）
paintSphere(24, 24, 60, 3, 255); // A
paintSphere(84, 104, 120, 3, 255); // B

// ---- 写入 .corevol（格式见 src/format/corevol.ts）----
const MAGIC = [0x43, 0x4f, 0x52, 0x45, 0x56, 0x4f, 0x4c, 0x00];
const nameBytes = Buffer.from(NAME, 'utf8');
const headerSize = Math.ceil((78 + nameBytes.length) / 8) * 8;
const buffer = Buffer.alloc(headerSize + data.byteLength);
MAGIC.forEach((b, i) => (buffer[i] = b));
buffer.writeUInt16LE(1, 8); // version
buffer.writeUInt16LE(0, 10); // dtype uint8
buffer.writeUInt32LE(headerSize, 12);
buffer.writeUInt32LE(NI, 16);
buffer.writeUInt32LE(NJ, 20);
buffer.writeUInt32LE(NK, 24);
buffer.writeDoubleLE(SPACING[0], 28);
buffer.writeDoubleLE(SPACING[1], 36);
buffer.writeDoubleLE(SPACING[2], 44);
buffer.writeDoubleLE(ORIGIN[0], 52);
buffer.writeDoubleLE(ORIGIN[1], 60);
buffer.writeDoubleLE(ORIGIN[2], 68);
buffer.writeUInt16LE(nameBytes.length, 76);
nameBytes.copy(buffer, 78);
Buffer.from(data.buffer).copy(buffer, headerSize);

const out = join(dirname(fileURLToPath(import.meta.url)), '../public/samples/synthetic-core.corevol');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, buffer);
console.log(`已生成 ${out}（${(buffer.length / 1024 / 1024).toFixed(2)} MB）`);

// ---- 对比样例 B：synthetic-core-b.corevol ----
// 用于双体积并排比较验证：
// - 间距不同：0.5 × 0.5 × 4.0 mm（K 方向层厚是 A 的 2 倍），IJ 物理范围与 A 相同
// - 层理沿 K 翻转（k → NK-1-k）：开启「翻转 K」映射后与 A 的层理在物理坐标下对齐
//   （A 层理周期 24 层 × 2mm = 48mm = B 层理周期 12 层 × 4mm）
// - 灰度整体偏移 +20，便于观察同一物理位置的灰度差值
const DIMS_B = [128, 128, 100];
const SPACING_B = [0.5, 0.5, 4.0];
const NAME_B = 'synthetic-core-b';
const [NIB, NJB, NKB] = DIMS_B;
const dataB = new Uint8Array(NIB * NJB * NKB);
const idxB = (i, j, k) => i + NIB * (j + NJB * k);

for (let k = 0; k < NKB; k++) {
  // 层理：物理周期与 A 相同（48mm），但沿 K 翻转
  const bedding = 96 + 28 * Math.sin((2 * Math.PI * (NKB - 1 - k)) / 12) + 20;
  for (let j = 0; j < NJB; j++) {
    for (let i = 0; i < NIB; i++) {
      const di = i - CX;
      const dj = j - CY;
      const r = Math.sqrt(di * di + dj * dj);
      if (r > RADIUS) continue;
      let v = bedding + jitter(i, j, k);
      // 致密夹层（物理位置与 A 大致对应：A k∈[100,110) → z∈[200,220) → B k∈[50,55)）
      if (k >= 50 && k < 55) v += 50;
      dataB[idxB(i, j, k)] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
}

// 高密度结核（B 坐标系）
function paintSphereB(ci, cj, ck, radius, value) {
  for (let k = Math.floor(ck - radius); k <= Math.ceil(ck + radius); k++) {
    for (let j = Math.floor(cj - radius); j <= Math.ceil(cj + radius); j++) {
      for (let i = Math.floor(ci - radius); i <= Math.ceil(ci + radius); i++) {
        if (i < 0 || j < 0 || k < 0 || i >= NIB || j >= NJB || k >= NKB) continue;
        const d = Math.sqrt((i - ci) ** 2 + (j - cj) ** 2 + (k - ck) ** 2);
        if (d <= radius) dataB[idxB(i, j, k)] = value;
      }
    }
  }
}

paintSphereB(40, 80, 30, 6, 240);
paintSphereB(90, 40, 70, 8, 240);

const nameBytesB = Buffer.from(NAME_B, 'utf8');
const headerSizeB = Math.ceil((78 + nameBytesB.length) / 8) * 8;
const bufferB = Buffer.alloc(headerSizeB + dataB.byteLength);
MAGIC.forEach((b, i) => (bufferB[i] = b));
bufferB.writeUInt16LE(1, 8);
bufferB.writeUInt16LE(0, 10);
bufferB.writeUInt32LE(headerSizeB, 12);
bufferB.writeUInt32LE(NIB, 16);
bufferB.writeUInt32LE(NJB, 20);
bufferB.writeUInt32LE(NKB, 24);
bufferB.writeDoubleLE(SPACING_B[0], 28);
bufferB.writeDoubleLE(SPACING_B[1], 36);
bufferB.writeDoubleLE(SPACING_B[2], 44);
bufferB.writeDoubleLE(0, 52);
bufferB.writeDoubleLE(0, 60);
bufferB.writeDoubleLE(0, 68);
bufferB.writeUInt16LE(nameBytesB.length, 76);
nameBytesB.copy(bufferB, 78);
Buffer.from(dataB.buffer).copy(bufferB, headerSizeB);

const outB = join(dirname(fileURLToPath(import.meta.url)), '../public/samples/synthetic-core-b.corevol');
writeFileSync(outB, bufferB);
console.log(`已生成 ${outB}（${(bufferB.length / 1024 / 1024).toFixed(2)} MB）`);
