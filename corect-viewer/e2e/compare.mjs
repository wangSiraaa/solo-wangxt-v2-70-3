/**
 * 双体积并排同步比较 端到端验收测试（vite preview + 无头 Chromium）。
 * 需先 npm run build。样例对：scripts/generate-compare-samples.mjs
 *   compare-a: dims [33,33,41]  spacing [1,1,2]   物理范围 32×32×80mm
 *   compare-b: dims [65,65,81]  spacing [0.5,.5,1] 物理范围 32×32×80mm（含病灶球）
 * 运行：node e2e/compare.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '../..');
const SAMPLE_A = join(ROOT, 'public/samples/compare-a.corevol');
const SAMPLE_B = join(ROOT, 'public/samples/compare-b.corevol');
const PORT = 5200;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

async function waitForServer(url, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* 尚未就绪 */
    }
    await delay(300);
  }
  throw new Error('vite preview 启动超时');
}

if (!existsSync(SAMPLE_A) || !existsSync(SAMPLE_B)) {
  console.error('缺少比较样例对，请先运行：npm run sample');
  process.exit(1);
}

const server = spawn(
  'npx',
  ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: 'pipe' },
);
process.on('exit', () => server.kill());

/** 通过隐藏文件输入导入 .corevol 工程 */
async function importFile(page, path) {
  await page.locator('input[type="file"]').setInputFiles(path);
  await page.waitForFunction(() => window.__store?.getState().status === 'ready', null, {
    timeout: 30_000,
  });
}

let browser;
try {
  await waitForServer(`${BASE}/`);
  browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  console.log('准备：导入两份体数据');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await importFile(page, SAMPLE_A);
  await importFile(page, SAMPLE_B);
  const ids = await page.evaluate(() => {
    const ps = window.__store.getState().projects;
    return {
      base: ps.find((p) => p.name === 'compare-a')?.id,
      compare: ps.find((p) => p.name === 'compare-b')?.id,
    };
  });
  check('两份工程均已入库', Boolean(ids.base && ids.compare && ids.base !== ids.compare), JSON.stringify(ids));

  console.log('进入双体积比较模式');
  await page.selectOption('[data-testid="base-select"]', ids.base);
  await page.selectOption('[data-testid="compare-select"]', ids.compare);
  await page.getByTestId('enter-compare').click();
  await page.waitForFunction(
    () =>
      window.__store.getState().mode === 'compare' &&
      window.__store.getState().status === 'ready',
    null,
    { timeout: 30_000 },
  );
  const canvasCount = await page.locator('.vtk-container canvas').count();
  check('并排显示六个切面（2 侧 × 3）', canvasCount === 6, `实际 ${canvasCount}`);

  console.log('验收 1：间距不同但物理范围相同，十字丝按物理坐标同步');
  await page.evaluate(() => window.__store.getState().setCrosshair('base', [8, 8, 10]));
  let cc = await page.evaluate(() => window.__store.getState().compare.crosshair);
  check('基准 (8,8,10) 物理(8,8,20) → 对比 (16,16,20)', cc.join() === '16,16,20', JSON.stringify(cc));
  await page.evaluate(() => window.__store.getState().setCrosshair('compare', [32, 32, 40]));
  const cb = await page.evaluate(() => window.__store.getState().base.crosshair);
  check('反向：对比 (32,32,40) 物理(16,16,40) → 基准 (16,16,20)', cb.join() === '16,16,20', JSON.stringify(cb));

  console.log('验收 1b：真实鼠标拖动基准侧 K 视图，对比侧跟随');
  const baseK = page.locator('.view-column').first().locator('.slice-view').nth(0);
  const box = await baseK.boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45, { steps: 6 });
  await page.mouse.up();
  const drag = await page.evaluate(() => {
    const s = window.__store.getState();
    const b = s.base.crosshair;
    const c = s.compare.crosshair;
    // 恒等映射 + 间距减半：对比索引恒为基准 2 倍
    return { b, c, ok: c.join() === b.map((v) => v * 2).join() };
  });
  check('拖动后对比 = 基准索引 ×2（物理位置一致）', drag.ok, `${drag.b} → ${drag.c}`);

  console.log('验收 2：翻转轴后的端点对应准确');
  await page.check('[data-testid="flip-compare-0"]');
  await page.evaluate(() => window.__store.getState().setCrosshair('base', [0, 8, 10]));
  let flipped = await page.evaluate(() => window.__store.getState().compare.crosshair);
  check('翻转 I：基准 i=0（物理0）→ 对比 i=64（物理32）', flipped[0] === 64, JSON.stringify(flipped));
  await page.evaluate(() => window.__store.getState().setCrosshair('base', [32, 8, 10]));
  flipped = await page.evaluate(() => window.__store.getState().compare.crosshair);
  check('翻转 I：基准 i=32（物理32）→ 对比 i=0（物理0）', flipped[0] === 0, JSON.stringify(flipped));
  await page.uncheck('[data-testid="flip-compare-0"]');

  console.log('验收 3：一侧越界保持最近有效位置并提示，且不跳动循环');
  await page.fill('[data-testid="offset-compare-0"]', '40');
  await page.evaluate(() => window.__store.getState().setCrosshair('base', [8, 8, 10]));
  const oob = await page.evaluate(() => {
    const s = window.__store.getState();
    return {
      compareIjk: s.compare.crosshair,
      oob: s.compare.outOfBounds,
      baseIjk: s.base.crosshair,
    };
  });
  check('对比侧越界 → 夹取到 i=0', oob.compareIjk[0] === 0, JSON.stringify(oob.compareIjk));
  check('越界标记置位', oob.oob === true);
  check('基准侧不被回拉（无回流循环）', oob.baseIjk.join() === '8,8,10', JSON.stringify(oob.baseIjk));
  const badgeCount = await page.locator('.view-column').nth(1).locator('.oob-badge').count();
  check('对比侧视图显式提示越界', badgeCount >= 1, `badge=${badgeCount}`);
  const statusOob = await page.locator('.status-bar').innerText();
  check('状态栏提示越界', statusOob.includes('越界'), statusOob);
  // 复位后标记清除
  await page.fill('[data-testid="offset-compare-0"]', '0');
  await page.evaluate(() => window.__store.getState().setCrosshair('base', [8, 8, 10]));
  const cleared = await page.evaluate(() => window.__store.getState().compare.outOfBounds);
  check('回到物理范围内越界标记清除', cleared === false);

  console.log('验收 4：差值探针在同一物理位置取样（Worker，过期丢弃）');
  await page.waitForFunction(
    () => {
      const s = window.__store.getState();
      return s.diff && s.diff.ijkBase && s.diff.ijkBase.join() === s.base.crosshair.join();
    },
    null,
    { timeout: 8000 },
  );
  let probe = await page.evaluate(() => window.__store.getState().diff);
  check('标志块处双侧值均为 255，Δ=0', probe.valueBase === 255 && probe.valueCompare === 255 && probe.diff === 0, JSON.stringify(probe));
  // 仅对比侧有病灶（物理 (16,16,40)，+80）
  await page.evaluate(() => window.__store.getState().setCrosshair('base', [16, 16, 20]));
  await page.waitForFunction(
    () => {
      const s = window.__store.getState();
      return s.diff && s.diff.center[0] === 16 && s.diff.center[2] === 40;
    },
    null,
    { timeout: 8000 },
  );
  probe = await page.evaluate(() => window.__store.getState().diff);
  check('病灶处对比侧 +80，Δ=基准-对比 明显为负', probe.diff <= -60, JSON.stringify({ a: probe.valueBase, b: probe.valueCompare, d: probe.diff }));
  check('邻域统计有效采样 > 0', probe.validCount > 0 && probe.meanAbsDiff !== null, JSON.stringify(probe));

  console.log('验收 4b：快速拖动只显示最后位置的差值');
  const finalIjk = await page.evaluate(() => {
    const st = window.__store.getState();
    for (let k = 0; k < 30; k++) st.setCrosshair('base', [k % 30, 8, 10]);
    return window.__store.getState().base.crosshair; // 重新读取最新状态（zustand 快照不可变）
  });
  await page.waitForFunction(
    (finalPos) => {
      const d = window.__store.getState().diff;
      return d && d.ijkBase && d.ijkBase.join() === finalPos.join();
    },
    finalIjk,
    { timeout: 8000 },
  );
  check('差值结果停在最后位置 i=29', finalIjk[0] === 29, JSON.stringify(finalIjk));

  console.log('验收 5：窗宽窗位独立 / 锁定联动');
  await page.evaluate(() => {
    const s = window.__store.getState();
    s.setWlLocked(false);
    s.setWindowLevel('base', { window: 123, level: 45 });
  });
  const wlIndep = await page.evaluate(() => window.__store.getState().compare.windowLevel);
  check('未锁定时对比侧窗宽窗位独立', wlIndep.window !== 123, JSON.stringify(wlIndep));
  await page.check('[data-testid="wl-lock"]');
  await page.evaluate(() => window.__store.getState().setWindowLevel('compare', { window: 222, level: 77 }));
  const wlLock = await page.evaluate(() => ({
    b: window.__store.getState().base.windowLevel,
    c: window.__store.getState().compare.windowLevel,
  }));
  check('锁定后任一侧调整两侧同步', wlLock.b.window === 222 && wlLock.c.window === 222, JSON.stringify(wlLock));
  await page.uncheck('[data-testid="wl-lock"]');

  console.log('验收 6：测距使用各自体素间距');
  await page.evaluate(() => {
    const s = window.__store.getState();
    s.clickMeasurePoint('base', [0, 0, 0]);
    s.clickMeasurePoint('base', [10, 0, 0]); // 基准 10mm
    s.clickMeasurePoint('compare', [0, 0, 0]);
    s.clickMeasurePoint('compare', [10, 0, 0]); // 对比 10 体素 × 0.5mm = 5mm
  });
  const dists = await page.evaluate(() =>
    window.__store.getState().measurements.map((m) => {
      const vol = window.__store.getState()[m.side].volume;
      const sp = vol.header.spacing;
      const dx = (m.p1[0] - m.p2[0]) * sp[0];
      return { side: m.side, d: Math.abs(dx) };
    }),
  );
  check('基准侧 10 体素 = 10.00mm', dists[0].side === 'base' && Math.abs(dists[0].d - 10) < 1e-9, JSON.stringify(dists));
  check('对比侧 10 体素 = 5.00mm（各自间距）', dists[1].side === 'compare' && Math.abs(dists[1].d - 5) < 1e-9, JSON.stringify(dists));

  console.log('准备会话恢复：设置可辨识映射与视图状态');
  await page.fill('[data-testid="offset-compare-1"]', '3.5');
  await page.check('[data-testid="flip-compare-2"]');
  await page.evaluate(() => window.__store.getState().setCrosshair('base', [11, 12, 13]));
  const before = await page.evaluate(() => {
    const s = window.__store.getState();
    return {
      baseCh: s.base.crosshair,
      compareCh: s.compare.crosshair,
      mapping: s.mapping,
      wlLocked: s.wlLocked,
    };
  });
  await delay(700); // 等防抖写入 IndexedDB

  console.log('验收 7：刷新后双体积身份一致 → 恢复会话');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(
    () =>
      window.__store?.getState().mode === 'compare' &&
      window.__store.getState().status === 'ready',
    null,
    { timeout: 30_000 },
  );
  const restored = await page.evaluate(() => {
    const s = window.__store.getState();
    return {
      mode: s.mode,
      confirmed: s.mappingConfirmed,
      stale: s.mappingStale,
      baseCh: s.base.crosshair,
      compareCh: s.compare.crosshair,
      offsetJ: s.mapping.compare.offset[1],
      flipK: s.mapping.compare.flip[2],
    };
  });
  check('恢复为比较模式且映射仍启用', restored.mode === 'compare' && restored.confirmed === true, JSON.stringify(restored));
  check('无内容变化警告', restored.stale === false);
  check('映射参数恢复（ΔJ=3.5，翻转K）', restored.offsetJ === 3.5 && restored.flipK === true, JSON.stringify(restored));
  check('十字丝视图状态恢复', restored.baseCh.join() === before.baseCh.join() && restored.compareCh.join() === before.compareCh.join(), `${restored.baseCh} / ${restored.compareCh}`);
  const syncAfterRestore = await page.evaluate(() => {
    const s = window.__store.getState();
    s.setCrosshair('base', [8, 8, 10]);
    // ΔJ=3.5：compare 物理 = common-offset = 4.5 → j=9；翻转 K：物理 z=20 → 80-20=60 → k=60
    return window.__store.getState().compare.crosshair.join() === '16,9,60';
  });
  check('恢复后同步功能正常工作（含 ΔJ 与翻转 K）', syncAfterRestore === true);

  console.log('验收 8：任一文件内容改变 → 停用旧映射并要求重新确认');
  const tampered = await page.evaluate(async () => {
    const s = window.__store.getState();
    const compareId = s.compare.projectId;
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('corect-viewer');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction('projects', 'readwrite');
    const store = tx.objectStore('projects');
    const rec = await new Promise((resolve, reject) => {
      const r = store.get(compareId);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    // 翻转一个数据区字节（文件末尾），身份指纹必然变化
    const view = new Uint8Array(rec.fileBuffer);
    view[rec.fileBuffer.byteLength - 1] ^= 0xff;
    await new Promise((resolve, reject) => {
      const r2 = tx.objectStore('projects').put(rec);
      r2.onsuccess = resolve;
      r2.onerror = () => reject(r2.error);
    });
    db.close();
    return compareId;
  });
  check('对比工程文件已篡改', Boolean(tampered));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(
    () =>
      window.__store?.getState().mode === 'compare' &&
      window.__store.getState().status === 'ready',
    null,
    { timeout: 30_000 },
  );
  const staleState = await page.evaluate(() => {
    const s0 = window.__store.getState();
    const beforeCompare = s0.compare.crosshair.join();
    s0.setCrosshair('base', [5, 5, 5]);
    const s1 = window.__store.getState();
    return {
      stale: s1.mappingStale,
      confirmed: s1.mappingConfirmed,
      compareMoved: s1.compare.crosshair.join() !== beforeCompare,
    };
  });
  check('检测到内容变化：mappingStale=true', staleState.stale === true, JSON.stringify(staleState));
  check('旧映射停用、同步关闭', staleState.confirmed === false && staleState.compareMoved === false, JSON.stringify(staleState));
  const banner = page.locator('[data-testid="mapping-stale-banner"]');
  check('显式提示需要重新确认', (await banner.count()) === 1 && (await banner.isVisible()));

  console.log('验收 8b：重新确认后映射重新启用');
  await page.getByTestId('confirm-mapping').click();
  const reconfirmed = await page.evaluate(() => {
    const s0 = window.__store.getState();
    if (!s0.mappingConfirmed) return false;
    s0.setCrosshair('base', [8, 8, 10]);
    // 当前映射：对比 ΔJ=3.5、翻转K。基准 (8,8,10) → 公共 (8,11.5,20) → 对比 i=16,j=23；
    // K 翻转：公共 z=20 → 对比物理 z = 80-20 = 60 → k=60
    return window.__store.getState().compare.crosshair.join() === '16,9,60';
  });
  check('确认后同步按映射恢复（含 ΔJ 与翻转 K）', reconfirmed === true);

  check('无未捕获页面错误', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  await browser?.close();
  server.kill();
}

console.log(`\nE2E 结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
