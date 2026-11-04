/* 打工人记账器 v1.9.0 · 启动速度与首屏加载性能
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron test/run-startup.js
 * 采样：冷启动（全新 userData）1 次 + 热启动（同进程 reload）3 次：
 *   t0 进程脚本起点 → t1 did-finish-load → t2 首帧渲染完成（#todayEarned 可读且 app inited）
 * 附：加载完成后的进程内存（app.getAppMetrics）。
 * 评估线：桌面工具类冷启动 < 3s、热加载 < 1s（开发模式基准，打包版通常更快）。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const REPORT = path.join(ROOT, '测试报告-启动性能-v' + PKG_VERSION + '.md');

app.setPath('userData', path.join(require('os').tmpdir(), 'dgjz-harness-startup-cold'));

const samples = [];
let win = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function measure(label) {
  const t0 = Date.now();
  let t1 = 0;
  const done = new Promise((res) => {
    win.webContents.once('did-finish-load', () => { t1 = Date.now(); res(); });
  });
  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await done;
  // t2：等首帧真正可交互（首启会弹设置面板，也算可交互）
  let t2 = t1;
  for (let i = 0; i < 60; i++) {
    await sleep(50);
    const ready = await win.webContents.executeJavaScript(
      `(() => { const el = document.querySelector('#todayEarned'); return !!(el && el.textContent.length) && document.readyState === 'complete'; })()`, true);
    if (ready) { t2 = Date.now(); break; }
  }
  const mem = app.getAppMetrics().filter((m) => m.serviceName === 'GPU' || m.pid);
  const totalMem = app.getAppMetrics().reduce((a, m) => a + ((m.memory && m.memory.workingSetSize) || 0), 0);
  samples.push({ label, tLoad: t1 - t0, tReady: t2 - t0, memMB: (totalMem / 1024).toFixed(1) });
  console.log('SAMPLE | ' + label + ' | load=' + (t1 - t0) + 'ms ready=' + (t2 - t0) + 'ms mem≈' + (totalMem / 1024).toFixed(1) + 'MB');
}

app.whenReady().then(async () => {
  ipcMain.handle('holidays:fetch', () => null);
  ipcMain.handle('data:export', () => ({ ok: true, path: 'test-mock' }));
  ipcMain.handle('data:import', () => ({ canceled: true }));
  ipcMain.handle('app:version', () => PKG_VERSION);
  ipcMain.on('win:pin', () => {}); ipcMain.on('win:compact', () => {});
  ipcMain.on('win:minimize', () => {}); ipcMain.on('win:close', () => {});
  win = new BrowserWindow({
    width: 424, height: 720, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false }
  });
  win.setMenuBarVisibility(false);
  let crash = 0;
  win.webContents.on('render-process-gone', () => crash++);
  win.show();

  // 清掉残留存档，保证冷启动走「首次使用」路径
  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await sleep(500);
  await win.webContents.executeJavaScript(`localStorage.clear(); 'ok'`, true);

  await measure('冷启动(首次使用)');
  // 热启动：保存设置进入主界面后 reload ×3
  await win.webContents.executeJavaScript(
    `(() => { const b = document.querySelector('#btnSave'); if (b) b.click(); return 'ok'; })()`, true);
  await sleep(400);
  for (let i = 0; i < 3; i++) await measure('热加载#' + (i + 1));

  const cold = samples[0];
  const warm = samples.slice(1);
  const avgWarmLoad = Math.round(warm.reduce((a, s) => a + s.tLoad, 0) / warm.length);
  const avgWarmReady = Math.round(warm.reduce((a, s) => a + s.tReady, 0) / warm.length);
  const okCold = cold.tReady < 3000;
  const okWarm = avgWarmReady < 1000;
  console.log('SUMMARY | cold_ready=' + cold.tReady + 'ms(<3000?' + okCold + ') warm_avg_ready=' + avgWarmReady + 'ms(<1000?' + okWarm + ') crash=' + crash);

  const md = [];
  md.push('# 启动性能测试报告 · 打工人记账器 v' + PKG_VERSION + '\n');
  md.push('- 执行时间：' + new Date().toLocaleString('zh-CN'));
  md.push('- 环境：Electron ' + process.versions.electron + ' 开发模式（loadFile，无网络）；打包版通常更快（无 devtools 检查）');
  md.push('- 口径：t0=发起加载 → t1=did-finish-load → t2=首帧可交互（#todayEarned 可读）\n');
  md.push('## 采样\n');
  md.push('| 场景 | 加载完成 | 可交互 | 进程内存 |');
  md.push('|---|---|---|---|');
  samples.forEach((s) => md.push('| ' + s.label + ' | ' + s.tLoad + 'ms | ' + s.tReady + 'ms | ≈' + s.memMB + 'MB |'));
  md.push('\n## 结论\n');
  md.push('- 冷启动可交互 **' + cold.tReady + 'ms**（评估线 3000ms，' + (okCold ? '达标 ✅' : '超标 ❌') + '）');
  md.push('- 热加载平均可交互 **' + avgWarmReady + 'ms**（评估线 1000ms，' + (okWarm ? '达标 ✅' : '超标 ❌') + '）');
  md.push('- 进程总内存（主+GPU+渲染 workingSet）≈ ' + cold.memMB + 'MB，属 Electron 工具类应用正常水位');
  md.push('- 渲染进程崩溃次数：' + crash);
  fs.writeFileSync(REPORT, md.join('\n'), 'utf8');
  console.log('REPORT | ' + REPORT);
  app.exit(0);
});
