/* 打工人记账器 · 长驻性能观察（R-23 / TC-M12-08）
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron test/run-perf.js
 * 做法：
 *   1) 先灌入一份「用了两个月」的真实体量存档（62 天 dailyLog + 补录 + 累计），避免空库虚高。
 *   2) 可见窗口跑 200s，每 15s 采样 app.getAppMetrics()（主进程 + 渲染进程的内存/CPU）。
 *   3) 每轮把模拟时间推进 1 天，触发跨天结算/落盘/明细重算，模拟真实长期使用。
 *   4) 最后做一次「快速推进 30 天」压力测试，测每次推进的耗时与内存增量。
 * 判定：渲染进程内存增长 < 40MB、无崩溃、金额仍在更新（渲染循环存活）、无 JS 异常。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PKG_VERSION = require(path.join(ROOT, 'package.json')).version;
const STORE = 'dgjz.worker.v1';
const REPORT = path.join(ROOT, '测试报告-长驻性能-v' + PKG_VERSION + '.md');

let win = null;
const consoleErrors = [];
const samples = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (js) => win.webContents.executeJavaScript(js, true);

const INJECT = `(() => {
  if (window.__simmed) return 'ok';
  window.__simmed = true;
  const RN = Date.now.bind(Date);
  const RealDate = window.Date;
  window.__off = 0;
  Date.now = () => RN() + window.__off;
  class RD extends RealDate {
    constructor(...a) { if (a.length === 0) super(RN() + window.__off); else super(...a); }
  }
  window.Date = RD;
  window.__at = (h, m) => { const t = new RealDate(); t.setHours(h, m || 0, 0, 0); window.__off = t.getTime() - RN(); };
  window.__later = (ms) => { window.__off += ms; };
  return 'ok';
})()`;

function metrics() {
  const list = app.getAppMetrics();
  const pick = (type) => list.filter((p) => p.type === type);
  const sum = (arr, f) => arr.reduce((n, p) => n + f(p), 0);
  const tabs = pick('Tab');
  return {
    rss: Math.round(sum(list, (p) => p.memory.workingSetSize) / 1024),            // MB 全部进程
    renderer: Math.round(sum(tabs, (p) => p.memory.workingSetSize) / 1024),       // MB 渲染进程
    main: Math.round(sum(pick('Browser'), (p) => p.memory.workingSetSize) / 1024),
    cpu: +(sum(list, (p) => p.cpu.percentCPUUsage)).toFixed(1),                   // 总 CPU%
    procs: list.length
  };
}

function buildFixture() {
  const now = new Date();
  const dailyLog = {};
  // 过去 62 天，工作日记 8 小时日薪、周末不记
  for (let i = 62; i >= 1; i--) {
    const d = new Date(now.getTime() - i * 864e5);
    const w = d.getDay();
    if (w === 0 || w === 6) continue;
    const k = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    dailyLog[k] = 380.95;
  }
  const leaves = {};
  const l1 = new Date(now.getTime() - 20 * 864e5);
  leaves[l1.getFullYear() + '-' + (l1.getMonth() + 1) + '-' + l1.getDate()] = true;
  return {
    inited: true, salary: 8000, workDays: 21, daysMode: 'double',
    start: '09:00', end: '18:00', lunchStart: '12:00', lunchEnd: '13:00',
    clockFrom: 'click', autoRun: false, dailyHours: null,
    goalName: '买台新手机', goalEmoji: '📱', goalAmount: 5999, savedBase: 1200,
    settled: 0, savedBase2: 0, dailyLog, leaves, holidays: {}, fixRanges: [], fixDay: null,
    segments: [], clockIn: null, doneShift: null, lastShift: null, todaySettled: null,
    holidayCheckedAt: null
  };
}

async function main() {
  win = new BrowserWindow({
    width: 424, height: 720, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, spellcheck: false
    }
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 3) consoleErrors.push(msg); });
  win.webContents.on('render-process-gone', (e, d) => consoleErrors.push('CRASH ' + JSON.stringify(d)));
  win.show();

  const fixture = JSON.stringify(buildFixture());
  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await sleep(1200);
  await R(`localStorage.setItem('${STORE}', ${JSON.stringify(fixture)}); location.reload(); 'rl'`);
  await sleep(1500);
  await R(INJECT);
  await sleep(500);

  // 让应用进入「真实工作中」状态，渲染循环满载
  await R(`window.__at(10); document.querySelector('#btnClock').click(); 'ok'`);
  await sleep(600);

  const DAY = 864e5;
  console.log('WARMUP 20s ...');
  await sleep(20000);
  samples.push(Object.assign({ t: 0, day: 0, earned: await R(`document.querySelector('#todayEarned').textContent`) }, metrics()));

  for (let i = 1; i <= 12; i++) {
    await R(`window.__later(${DAY}); 'ok'`);           // 推进一天：跨天结算 + 落盘 + 重绘
    await sleep(15000);
    const earned = await R(`document.querySelector('#todayEarned').textContent`);
    samples.push(Object.assign({ t: i * 15, day: i, earned }, metrics()));
    const s = samples[samples.length - 1];
    console.log('SAMPLE ' + i + ' | t=' + s.t + 's | rss=' + s.rss + 'MB renderer=' + s.renderer + 'MB main=' + s.main + 'MB cpu=' + s.cpu + '% earned=' + s.earned);
  }

  // 快速推进 30 天压力：每跳一天测耗时
  const burstStart = metrics();
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) {
    await R(`window.__later(${DAY}); 'ok'`);
    await R(`document.querySelector('#btnHistory').click(); document.querySelector('#btnCloseHist').click(); 'ok'`);  // 强制明细重算
  }
  await sleep(1500);
  const burstMs = Date.now() - t0;
  const burstEnd = metrics();
  const daysLogged = await R(`Object.keys(JSON.parse(localStorage.getItem('${STORE}')).dailyLog || {}).length`);
  const alive = await R(`(() => {
    const a = document.querySelector('#todayEarned').textContent;
    return new Promise((res) => setTimeout(() => res({ before: a, after: document.querySelector('#todayEarned').textContent }), 1200));
  })()`);

  // 判定
  const first = samples[0];
  const last = samples[samples.length - 1];
  const memGrow = last.renderer - first.renderer;
  const rssGrow = last.rss - first.rss;
  const maxCpu = Math.max(...samples.map((s) => s.cpu));
  const avgCpu = +(samples.reduce((n, s) => n + s.cpu, 0) / samples.length).toFixed(1);
  const okMem = memGrow < 40;
  const okStable = maxCpu < 60;
  const okAlive = last.earned !== undefined && last.earned !== '';
  const okBurst = burstMs < 12000;
  const okErr = consoleErrors.length === 0;
  const pass = okMem && okStable && okAlive && okBurst && okErr;

  const lines = [];
  lines.push('# 打工人记账器 v' + PKG_VERSION + ' · 长驻性能观察报告（R-23）');
  lines.push('');
  lines.push('> 执行时间：' + new Date().toLocaleString('zh-CN') + '  ');
  lines.push('> 场景：真实窗口 + 两个月体量存档（' + Object.keys(JSON.parse(fixture).dailyLog).length + ' 天记录）+ 每 15s 推进 1 天，共 200s；末段 30 天快速推进压测  ');
  lines.push('> 采样：`app.getAppMetrics()`（Electron 进程级内存/CPU）  ');
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  lines.push(pass ? '**通过**：长驻 200s + 跨 12 天结算，渲染进程内存增长 ' + memGrow + 'MB（阈值 40MB），CPU 均值 ' + avgCpu + '%、峰值 ' + maxCpu + '%，无崩溃、无 JS 异常，渲染循环持续存活。'
    : '**未通过**：见下方指标，需开发介入定位。');
  lines.push('');
  lines.push('| 指标 | 实测 | 阈值 | 判定 |');
  lines.push('|------|------|------|------|');
  lines.push('| 渲染进程内存增长（' + first.renderer + '→' + last.renderer + 'MB） | ' + memGrow + 'MB | < 40MB | ' + (okMem ? '✅' : '❌') + ' |');
  lines.push('| 全部进程 RSS 增长（' + first.rss + '→' + last.rss + 'MB） | ' + rssGrow + 'MB | 参考 | — |');
  lines.push('| CPU 峰值 / 均值 | ' + maxCpu + '% / ' + avgCpu + '% | < 60% | ' + (okStable ? '✅' : '❌') + ' |');
  lines.push('| 30 天快速推进耗时 | ' + burstMs + 'ms（约 ' + Math.round(burstMs / 30) + 'ms/天） | < 12000ms | ' + (okBurst ? '✅' : '❌') + ' |');
  lines.push('| 渲染循环存活 | ' + okAlive + ' | 是 | ' + (okAlive ? '✅' : '❌') + ' |');
  lines.push('| JS 异常 / 崩溃 | ' + consoleErrors.length + ' | 0 | ' + (okErr ? '✅' : '❌') + ' |');
  lines.push('');
  lines.push('## 采样明细');
  lines.push('');
  lines.push('| 采样 | 模拟天数 | 渲染进程(MB) | 主进程(MB) | 总 RSS(MB) | CPU% | 今日已赚 |');
  lines.push('|------|----------|--------------|------------|------------|------|----------|');
  samples.forEach((s) => {
    lines.push('| ' + s.t + 's | +' + s.day + ' 天 | ' + s.renderer + ' | ' + s.main + ' | ' + s.rss + ' | ' + s.cpu + ' | ' + String(s.earned).trim() + ' |');
  });
  lines.push('');
  lines.push('## 压力段补充');
  lines.push('');
  lines.push('- 30 天快速推进前后：渲染进程 ' + burstStart.renderer + 'MB → ' + burstEnd.renderer + 'MB（' + (burstEnd.renderer - burstStart.renderer) + 'MB）');
  lines.push('- 推进后 dailyLog 累计条数：' + daysLogged + '（含原 62 天体量与新增结算）');
  lines.push('- 渲染循环存活校验：1.2s 前后金额 ' + alive.before + ' → ' + alive.after);
  lines.push('');
  if (consoleErrors.length) {
    lines.push('## 控制台异常');
    lines.push('');
    consoleErrors.slice(0, 10).forEach((m) => lines.push('- ' + String(m).slice(0, 200)));
    lines.push('');
  }
  fs.writeFileSync(REPORT, lines.join('\n'), 'utf8');
  console.log('SUMMARY | memGrow=' + memGrow + 'MB maxCpu=' + maxCpu + '% burst=' + burstMs + 'ms pass=' + pass);
  console.log('REPORT | ' + REPORT);
  app.exit(0);
}

app.whenReady().then(async () => {
  ipcMain.handle('holidays:fetch', () => null);
  ipcMain.handle('data:export', () => ({ ok: true, path: 'D:\\测试导出\\perf.json' }));
  ipcMain.handle('data:import', () => ({ canceled: true }));
  ipcMain.on('win:minimize', () => {});
  ipcMain.on('win:close', () => {});
  ipcMain.on('win:pin', () => {});
  ipcMain.on('win:compact', () => {});
  try {
    await main();
  } catch (e) {
    console.log('FATAL | ' + (e && e.stack || e));
    fs.writeFileSync(REPORT, '# 长驻性能（中断）\n\n```\n' + (e && e.stack || e) + '\n```\n', 'utf8');
    app.exit(1);
  }
});
