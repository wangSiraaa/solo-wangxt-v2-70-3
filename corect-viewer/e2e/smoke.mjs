/**
 * 端到端冒烟测试：vite preview（生产构建）+ 无头 Chromium（SwiftShader WebGL）。
 * 覆盖：样例加载 → Worker 解码 → 三视图渲染 → 十字丝联动 → 测量 → ROI → 刷新持久化。
 * 运行：node e2e/smoke.mjs（需先 npm run build）
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

// 无 root 权限的环境：若存在本地解压的 Chromium 系统库则自动加入 LD_LIBRARY_PATH
const LOCAL_LIBS = '/home/node/.local/chromium-libs';
if (existsSync(`${LOCAL_LIBS}/usr/lib`)) {
  const archDir = `${LOCAL_LIBS}/usr/lib/aarch64-linux-gnu:${LOCAL_LIBS}/lib/aarch64-linux-gnu`;
  process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
    ? `${archDir}:${process.env.LD_LIBRARY_PATH}`
    : archDir;
}

const PORT = 5199;
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

const server = spawn(
  'npx',
  ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' },
);
process.on('exit', () => server.kill());

let browser;
try {
  await waitForServer(`${BASE}/`);
  browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  console.log('E2E：加载样例与渲染');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '加载样例' }).click();
  await page.waitForFunction(
    () => window.__store?.getState().status === 'ready',
    null,
    { timeout: 30_000 },
  );
  const state0 = await page.evaluate(() => {
    const s = window.__store.getState();
    return {
      dims: s.volume.header.dims,
      spacing: s.volume.header.spacing,
      crosshair: s.crosshair,
      name: s.projectName,
    };
  });
  check('Worker 解码出体数据', state0.dims.join() === '128,128,200', JSON.stringify(state0));
  check('各向异性间距 0.5×0.5×2.0', state0.spacing.join() === '0.5,0.5,2');
  check('工程名来自文件头', state0.name === 'synthetic-core-aniso', state0.name);

  const canvasCount = await page.locator('.vtk-container canvas').count();
  check('三个 vtk 渲染画布', canvasCount === 3, `实际 ${canvasCount}`);
  // 等两帧让 SwiftShader 完成首绘
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  // WebGL 画布默认 preserveDrawingBuffer=false，无法直接读像素；
  // 改为隐藏叠加层后对视图区域截图，验证岩芯灰度真的渲染出来了
  const kView = page.locator('.slice-view').nth(0);
  await page.locator('.slice-view .overlay, .slice-view .view-label').evaluateAll((els) =>
    els.forEach((el) => (el.style.visibility = 'hidden')),
  );
  const shot = await kView.screenshot();
  await page.locator('.slice-view .overlay, .slice-view .view-label').evaluateAll((els) =>
    els.forEach((el) => (el.style.visibility = '')),
  );
  const px = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, 64, 64);
    const d = ctx.getImageData(0, 0, 64, 64).data;
    let mx = 0;
    for (let i = 0; i < d.length; i += 4) mx = Math.max(mx, d[i], d[i + 1], d[i + 2]);
    return mx;
  }, shot.toString('base64'));
  check('WebGL 画布渲染出岩芯灰度', px > 60, `最亮像素=${px}`);

  console.log('E2E：十字丝三视图联动');
  await kView.hover();
  await page.mouse.wheel(0, 120);
  await page.waitForFunction(
    (k0) => window.__store.getState().crosshair[2] === k0 + 1,
    state0.crosshair[2],
  );
  const k1 = await page.evaluate(() => window.__store.getState().crosshair[2]);
  check('滚轮换层 K+1', k1 === state0.crosshair[2] + 1, `K=${k1}`);
  const statusText = await page.locator('.status-bar').innerText();
  check('状态栏同步显示新坐标', statusText.includes(`(${state0.crosshair[0]}, ${state0.crosshair[1]}, ${k1})`), statusText);

  // 点击 K 视图中心 → I/J 应落在体数据中心附近
  const box = await kView.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const ch = await page.evaluate(() => window.__store.getState().crosshair);
  check(
    '点击定位十字丝（中心附近）',
    Math.abs(ch[0] - 63.5) <= 2 && Math.abs(ch[1] - 63.5) <= 2,
    `IJK=${ch}`,
  );

  console.log('E2E：距离测量');
  await page.getByRole('button', { name: '测量' }).click();
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.5);
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.5);
  await page.waitForFunction(() => window.__store.getState().measurements.length === 1);
  const measureText = await page.locator('.annot-list').first().innerText();
  check('测量标注生成且按 mm 显示', /\d+\.\d{2} mm/.test(measureText), measureText);

  console.log('E2E：ROI 框选与阈值预览');
  await page.getByRole('button', { name: '框选 ROI' }).click();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(() => window.__store.getState().rois.length === 1);
  const roiStats = await page.evaluate(() => {
    const s = window.__store.getState();
    const roi = s.rois[0];
    return { total: (roi.max[0] - roi.min[0] + 1) * (roi.max[1] - roi.min[1] + 1), axis: roi.axis };
  });
  check('ROI 生成且体素数 > 0', roiStats.total > 0, JSON.stringify(roiStats));
  const statsText = await page.locator('.side-panel').innerText();
  check('侧栏显示 ROI 统计（体素总数）', statsText.includes('体素总数'), '');

  // 切换切面（换层再换回）后标注不得丢失
  await kView.hover();
  await page.mouse.wheel(0, 240);
  await page.mouse.wheel(0, -240);
  const kept = await page.evaluate(() => {
    const s = window.__store.getState();
    return { m: s.measurements.length, r: s.rois.length };
  });
  check('切换切面后测量与 ROI 不丢失', kept.m === 1 && kept.r === 1, JSON.stringify(kept));

  console.log('E2E：刷新后持久化恢复');
  const before = await page.evaluate(() => {
    const s = window.__store.getState();
    return { m: s.measurements.length, r: s.rois.length, ch: s.crosshair };
  });
  await delay(600); // 等防抖写入 IndexedDB
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__store?.getState().status === 'ready', null, {
    timeout: 30_000,
  });
  const after = await page.evaluate(() => {
    const s = window.__store.getState();
    return { m: s.measurements.length, r: s.rois.length, ch: s.crosshair };
  });
  check('刷新后测量标注保留', after.m === before.m && before.m === 1, JSON.stringify(after));
  check('刷新后 ROI 保留', after.r === before.r && before.r === 1, JSON.stringify(after));
  check('刷新后十字丝位置保留', after.ch.join() === before.ch.join(), `${before.ch} → ${after.ch}`);

  console.log('E2E：双体积并排对比');
  await page.getByRole('button', { name: '加载对比样例' }).click();
  await page.waitForFunction(() => window.__store.getState().compareMode === true, null, {
    timeout: 30_000,
  });
  const cmp0 = await page.evaluate(() => {
    const s = window.__store.getState();
    return {
      dimsB: s.volumeB.header.dims,
      spacingB: s.volumeB.header.spacing,
      nameB: s.projectNameB,
    };
  });
  check('对比体积 B 解码（128×128×100）', cmp0.dimsB.join() === '128,128,100', JSON.stringify(cmp0));
  check('B 间距 0.5×0.5×4.0', cmp0.spacingB.join() === '0.5,0.5,4');
  const canvasCount2 = await page.locator('.vtk-container canvas').count();
  check('对比模式六个渲染画布', canvasCount2 === 6, `实际 ${canvasCount2}`);

  // 物理同步：A (10,20,30) → 共享物理 z=60mm → B k=15（B 层厚 4mm）
  await page.evaluate(() => window.__store.getState().setCrosshair([10, 20, 30]));
  const sync1 = await page.evaluate(() => ({
    b: window.__store.getState().crosshairB,
    phys: window.__store.getState().crosshairPhys,
  }));
  check('不同间距按物理坐标同步（A k=30 ↔ B k=15）', sync1.b.join() === '10,20,15', JSON.stringify(sync1));

  // 越界：A k=199 → z=398mm 超出 B 范围（99×4=396mm）→ B 夹取到 k=99，A 不动
  await page.evaluate(() => window.__store.getState().setCrosshair([0, 0, 199]));
  const oob = await page.evaluate(() => {
    const s = window.__store.getState();
    return { a: s.crosshair, b: s.crosshairB, clampedB: s.clampedB };
  });
  check('B 越界保持最近有效位置（k=99）', oob.b[2] === 99 && oob.clampedB[2] === true, JSON.stringify(oob));
  check('A 不因 B 越界而移动（无跳动循环）', oob.a.join() === '0,0,199', oob.a.join());
  await page.evaluate(() => window.__store.getState().setCrosshair([0, 0, 199]));
  const oob2 = await page.evaluate(() => ({
    a: window.__store.getState().crosshair,
    b: window.__store.getState().crosshairB,
  }));
  check('重复输入状态幂等（不振荡）', oob2.a.join() === '0,0,199' && oob2.b.join() === '0,0,99', JSON.stringify(oob2));
  const oobHint = await page.locator('.status-bar').innerText();
  check('状态栏显式提示越界', oobHint.includes('越界'), oobHint);

  // 翻转 K：端点对应 A k=0 ↔ B k=99、A k=198 ↔ B k=0
  await page.evaluate(() =>
    window.__store.getState().setMappingB({ offset: [0, 0, 0], flip: [false, false, true] }),
  );
  await page.evaluate(() => window.__store.getState().setCrosshair([0, 0, 0]));
  const flipEp = await page.evaluate(() => window.__store.getState().crosshairB);
  check('翻转 K 后端点对应（A k=0 ↔ B k=99）', flipEp[2] === 99, flipEp.join());
  await page.evaluate(() => window.__store.getState().setCrosshair([0, 0, 198]));
  const flipEp2 = await page.evaluate(() => window.__store.getState().crosshairB);
  check('翻转 K 后另一端点（A k=198 ↔ B k=0）', flipEp2[2] === 0, flipEp2.join());

  // 灰度差值：快速连续移动十字丝，最终只显示最后位置的取样
  await page.evaluate(() =>
    window.__store.getState().setMappingB({ offset: [0, 0, 0], flip: [false, false, false] }),
  );
  await page.evaluate(() => {
    const s = window.__store.getState();
    for (let k = 0; k <= 40; k++) s.setCrosshair([50, 50, k]);
  });
  await page.waitForFunction(
    () => {
      const s = window.__store.getState();
      if (!s.sampleValues) return false;
      const idxA = 50 + 128 * (50 + 128 * 40); // 最后位置 A(50,50,40)
      const idxB = 50 + 128 * (50 + 128 * 20); // 对应 B(50,50,20)，z=80mm/4mm
      return s.sampleValues.a === s.volume.data[idxA] && s.sampleValues.b === s.volumeB.data[idxB];
    },
    null,
    { timeout: 10_000 },
  );
  check('快速拖动后只显示最后位置的取样值', true);
  const diffText = await page.locator('.status-bar').innerText();
  check('状态栏显示灰度差值 Δ', diffText.includes('Δ(A−B)'), diffText);

  console.log('E2E：对比会话持久化（映射 / 身份 / 视图状态）');
  await page.evaluate(() =>
    window.__store.getState().setMappingB({ offset: [0, 0, 0], flip: [false, false, true] }),
  );
  await page.evaluate(() => window.__store.getState().setLockWindowLevel(true));
  await page.evaluate(() => window.__store.getState().setCrosshair([10, 20, 30]));
  await delay(600); // 等防抖写入 IndexedDB
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => window.__store?.getState().status === 'ready' && window.__store.getState().compareMode,
    null,
    { timeout: 30_000 },
  );
  const restored = await page.evaluate(() => {
    const s = window.__store.getState();
    return {
      flip: s.mappingB.flip,
      chB: s.crosshairB,
      stale: s.mappingStale,
      lock: s.lockWindowLevel,
    };
  });
  check('刷新后恢复对比会话（翻转映射保留）', restored.flip.join() === 'false,false,true' && !restored.stale, JSON.stringify(restored));
  check('刷新后十字丝按映射恢复（B k=84）', restored.chB.join() === '10,20,84', restored.chB.join());
  check('刷新后窗宽窗位联动锁保留', restored.lock === true, '');

  console.log('E2E：文件内容变化 → 旧映射停用并要求重新确认');
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('corect-viewer');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const tx = db.transaction('projects', 'readwrite');
    const store = tx.objectStore('projects');
    const rec = await new Promise((res, rej) => {
      const g = store.get('sample:synthetic-core-b');
      g.onsuccess = () => res(g.result);
      g.onerror = () => rej(g.error);
    });
    const bytes = new Uint8Array(rec.fileBuffer);
    bytes[bytes.byteLength - 1] ^= 0xff; // 改一个体素字节 → 内容哈希变化
    await new Promise((res, rej) => {
      const p = store.put(rec);
      p.onsuccess = () => res();
      p.onerror = () => rej(p.error);
    });
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => window.__store?.getState().status === 'ready' && window.__store.getState().compareMode,
    null,
    { timeout: 30_000 },
  );
  const stale = await page.evaluate(() => {
    const s = window.__store.getState();
    return { stale: s.mappingStale, flip: s.mappingB.flip };
  });
  check('文件内容变化后旧映射停用（重置为恒等）', stale.stale === true && stale.flip.join() === 'false,false,false', JSON.stringify(stale));
  await page.getByRole('button', { name: '确认当前映射' }).click();
  const confirmed = await page.evaluate(() => window.__store.getState().mappingStale);
  check('重新确认后映射恢复可用', confirmed === false, '');
  await delay(300);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => window.__store?.getState().status === 'ready' && window.__store.getState().compareMode,
    null,
    { timeout: 30_000 },
  );
  const reconfirmed = await page.evaluate(() => window.__store.getState().mappingStale);
  check('确认后再次刷新不再停用', reconfirmed === false, '');

  check('无未捕获页面错误', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  await browser?.close();
  server.kill();
}

console.log(`\nE2E 结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
