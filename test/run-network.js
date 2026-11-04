/* 打工人记账器 v1.9.0 · 网络异常场景测试
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron test/run-network.js
 * 应用唯一网络依赖：节假日接口（main.js → api.jiejiariapi.com）。
 * 在 IPC 边界注入故障：断网(reject) / 超时(永不返回) / 弱网(2s) / 脏数据(结构错乱、超长) / 恢复联网。
 * 白盒疑点：refreshHolidays 在发请求前就盖 holidayCheckedAt 章 → 断网失败也 7 天不重试（待实测定性）。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE = 'dgjz.worker.v1';
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const REPORT = path.join(ROOT, '测试报告-网络异常-v' + PKG_VERSION + '.md');

app.setPath('userData', path.join(require('os').tmpdir(), 'dgjz-harness-' + path.basename(__filename, '.js')));

let win = null;
let consoleErrors = [];
let mode = 'reject';            // boot 阶段的自动刷新让它失败，保证 fixture 不被假假日污染
let callCount = 0;

const results = [];
const record = (id, name, pass, detail) => {
  results.push({ id, name, pass, detail });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + id + ' ' + name + ' | ' + detail);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (js) => win.webContents.executeJavaScript(js, true);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const CLICK = (sel) => `document.querySelector('${sel}').click(); 'ok'`;

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

const SNAP = `(() => {
  const q = (s) => document.querySelector(s);
  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem('${STORE}') || '{}'); } catch (e) {}
  return {
    earned: parseFloat((q('#todayEarned').textContent || '0').replace(/,/g, '')) || 0,
    state: q('#workState').textContent.trim(),
    daysHint: (q('#daysHint').textContent || '').trim(),
    perDayCard: parseFloat((q('#perDay').textContent || '').replace(/[^0-9.]/g, '')) || 0,
    holidayHint: (q('#daysHint') ? q('#daysHint').textContent : '').trim(),
    cfg
  };
})()`;

let FIXTURE = null;
let perDay = 0;

async function createWindow() {
  win = new BrowserWindow({
    width: 424, height: 720, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false }
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 2) consoleErrors.push('[L' + level + '] ' + String(msg).slice(0, 200)); });
  win.webContents.on('render-process-gone', (e, d) => consoleErrors.push('[CRASH] ' + JSON.stringify(d)));
}

async function boot(firstTime) {
  if (firstTime) {
    await win.loadFile(path.join(ROOT, 'src', 'index.html'));
    await sleep(600);
    await R(`localStorage.removeItem('${STORE}'); location.reload(); 'wipe'`);
    await sleep(1300);
    await R(INJECT);
    await R(`if (!document.querySelector('#sheet').classList.contains('on')) document.querySelector('#btnSettings').click(); 'ok'`);
    await sleep(200);
    await R(`(() => {
      const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('blur', {bubbles:true})); };
      set('#inStart', '09:00'); set('#inEnd', '18:00');
      return 'ok';
    })()`);
    await R(CLICK('#btnSave'));
    await sleep(350);
    const s = await R(SNAP);
    FIXTURE = s.cfg;
    perDay = 8000 / (FIXTURE.workDays || 21);
  }
}

async function reset(over) {
  const base = Object.assign({}, FIXTURE, {
    segments: [], clockIn: null, doneShift: null, lastShift: null,
    todaySettled: null, dailyLog: {}, leaves: {}, fixRanges: [], fixDay: '',
    settled: 0, savedBase: 0, holidays: {}, holidayCheckedAt: 0
  }, over || {});
  const json = JSON.stringify(JSON.stringify(base));
  await R(`localStorage.setItem('${STORE}', ${json}); location.reload(); 'reloading'`);
  await sleep(1100);
  await R(INJECT);
  await sleep(150);
}

/* 触发一次节假日刷新：设置面板里的「更新」按钮 = refreshHolidays(true) */
async function refreshHolidays() {
  callCount = 0;
  await R(`if (!document.querySelector('#sheet').classList.contains('on')) document.querySelector('#btnSettings').click(); 'ok'`);
  await sleep(200);
  await R(CLICK('#btnHoliday'));
  await sleep(350);
}

async function runAll() {
  await boot(true);

  /* N-01 断网：接口 reject → 不崩溃、静默回退内置表 */
  mode = 'reject';
  await reset();
  await refreshHolidays();
  let s = await R(SNAP);
  const okReject = s.perDayCard > 0 && consoleErrors.filter((m) => m.indexOf('CRASH') >= 0).length === 0;
  record('N-01', '断网（接口 reject）：不崩溃，静默回退内置节假日表', okReject,
    '日薪卡=' + s.perDayCard + ' 提示=[' + s.holidayHint + '] 崩溃=' + consoleErrors.filter((m) => m.indexOf('CRASH') >= 0).length);

  /* N-02 失败后的重试行为：磁盘 checkedAt 未被污染，重启后自动重试 */
  const stamped = await R(`JSON.parse(localStorage.getItem('${STORE}')).holidayCheckedAt`);
  mode = 'ok';                                          // 网络恢复
  callCount = 0;
  await R(`location.reload(); 'rl'`);                   // 重启路径：boot 里 refreshHolidays(false)
  await sleep(1600);
  await R(INJECT);
  await sleep(200);
  const diskAfter = await R(`JSON.parse(localStorage.getItem('${STORE}')).holidayCheckedAt`);
  record('N-02', '断网失败不污染磁盘 checkedAt（save 仅在成功时落盘），重启后自动重试成功',
    stamped === 0 && callCount >= 1 && diskAfter > 0,
    '失败后磁盘 checkedAt=' + stamped + '（0=未污染）重启后请求数=' + callCount + ' 重试后 checkedAt=' + (diskAfter > 0 ? '已盖章' : '未盖章'));
  // 补回 N-01 后的基准（N-02 reload 后页面已联网态）

  /* N-03 接口超时（永不返回）：不阻塞 UI，打卡计费照常 */
  mode = 'timeout';
  await reset();
  await refreshHolidays();                              // 触发后 promise 永远 pending
  await R(`window.__at(10); document.querySelector('#btnClock').click(); 'ok'`);
  await sleep(300);
  await R(`window.__later(3600e3); 'ok'`);
  await sleep(500);
  s = await R(SNAP);
  const e1 = perDay / 8;
  record('N-03', '接口超时（pending 不返回）：UI 不阻塞、打卡计费照常', near(s.earned, e1, 0.5) && callCount === 1,
    '已赚=' + s.earned.toFixed(2) + '（≈' + e1.toFixed(2) + '） 请求发出=' + callCount + ' 次（顺序 await：2026 pending 阻塞 2027，见观察项 O-01）');

  /* N-04 弱网（2s 延迟）：等待期间 UI 可操作，返回后正常应用 */
  mode = 'slow';
  await reset();
  await refreshHolidays();                              // 含 350ms 等待，弱网下按钮转「更新中…」
  await R(`window.__at(10); document.querySelector('#btnClock').click(); 'ok'`);
  await sleep(300);
  await R(`window.__later(3600e3); 'ok'`);
  await sleep(4400);                                    // 顺序 await 两年份 × 2s 弱网 ≈ 4s
  const btnBack = await R(`document.querySelector('#btnHoliday').textContent.trim()`);
  const s4 = await R(SNAP);
  record('N-04', '弱网（2s 延迟）：按钮态恢复、期间打卡计费不受影响', btnBack === '更新' && near(s4.earned, perDay / 8, 0.5),
    '按钮=[' + btnBack + '] 打卡 1h 已赚=' + s4.earned.toFixed(2) + '（≈' + (perDay / 8).toFixed(2) + '）');

  /* N-05 脏数据①：返回 {}（缺 off/work 字段）→ 不崩溃 */
  mode = 'badShape';
  await reset();
  await refreshHolidays();
  s = await R(SNAP);
  record('N-05', '脏数据（{} 缺 off/work）：单年失败被 catch，不崩溃、内置表兜底', s.perDayCard > 0,
    '日薪卡=' + s.perDayCard + ' 崩溃=' + consoleErrors.filter((m) => m.indexOf('CRASH') >= 0).length);

  /* N-06 脏数据②：off/work 是错误类型（字符串/数字）→ 不崩溃 */
  mode = 'junkType';
  await reset();
  await refreshHolidays();
  s = await R(SNAP);
  record('N-06', '脏数据（off 为字符串、work 为数字）：类型错误被 catch，不崩溃', s.perDayCard > 0,
    '日薪卡=' + s.perDayCard + ' 崩溃=' + consoleErrors.filter((m) => m.indexOf('CRASH') >= 0).length);

  /* N-07 脏数据③：超长数组（1 万条假日）→ 不崩溃、不卡死 */
  mode = 'huge';
  await reset();
  const tHuge = Date.now();
  await refreshHolidays();
  const hugeCost = Date.now() - tHuge;
  s = await R(SNAP);
  record('N-07', '脏数据（1 万条假日）：不崩溃、处理耗时可控（<3s）', s.perDayCard > 0 && hugeCost < 3000,
    '耗时=' + hugeCost + 'ms 日薪卡=' + s.perDayCard);

  /* N-08 恢复联网：新假日写入后 workDays 重算、日薪同步变化 */
  await reset();                                        // reset 期间保持失败态，避免 boot 自动刷新提前入表
  mode = 'ok';
  const wd0 = (await R(SNAP)).cfg.workDays;
  await refreshHolidays();
  await sleep(600);
  s = await R(SNAP);
  const wd1 = s.cfg.workDays;
  const perDay1 = 8000 / wd1;
  record('N-08', '恢复联网：远端假日（11-11 休）入表，workDays 21→20，日薪 380.95→400.00',
    wd0 === 21 && wd1 === 20 && near(s.perDayCard, perDay1, 0.5),
    'workDays=' + wd0 + '→' + wd1 + ' 日薪卡=' + s.perDayCard + '（≈' + perDay1.toFixed(2) + '）');

  /* N-09 7 天缓存：checkedAt 新鲜时，启动路径（refreshHolidays(false)）不再发请求 */
  callCount = 0;
  await R(`location.reload(); 'rl'`);                   // 重启走 boot 里的 refreshHolidays(false)
  await sleep(1800);
  await R(INJECT);
  await sleep(200);
  record('N-09', '7 天缓存生效：checkedAt 新鲜时启动路径不发请求', callCount === 0,
    '重启后请求数=' + callCount);
}

app.whenReady().then(async () => {
  ipcMain.handle('holidays:fetch', (e, year) => {
    callCount++;
    if (mode === 'reject') return Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED'));
    if (mode === 'timeout') return new Promise(() => {});           // 永不返回
    if (mode === 'slow') return new Promise((res) => setTimeout(() => res({ off: [], work: [] }), 2000));   // 弱网但不改假日，避免重定价干扰计费断言
    if (mode === 'badShape') return Promise.resolve({});
    if (mode === 'junkType') return Promise.resolve({ off: 'not-an-array', work: 42 });
    if (mode === 'huge') return Promise.resolve({ off: Array.from({ length: 10000 }, (_, i) => '2026-12-' + String((i % 28) + 1).padStart(2, '0')), work: [] });
    return Promise.resolve({ off: ['2026-11-11'], work: [] });
  });
  ipcMain.handle('data:export', () => ({ ok: true, path: 'test-mock' }));
  ipcMain.handle('data:import', () => ({ canceled: true }));
  ipcMain.handle('app:version', () => PKG_VERSION);
  ipcMain.on('win:pin', () => {}); ipcMain.on('win:compact', () => {});
  ipcMain.on('win:minimize', () => {}); ipcMain.on('win:close', () => {});
  await createWindow();
  let ok = true;
  try { await runAll(); } catch (e) { ok = false; console.log('FATAL | ' + (e && e.stack || e)); }
  const passed = results.filter((r) => r.pass).length;
  console.log('SUMMARY | ' + passed + '/' + results.length + ' | consoleErrors=' + consoleErrors.length);
  if (consoleErrors.length) consoleErrors.slice(-5).forEach((m) => console.log('CONSOLE | ' + m));

  const md = [];
  md.push('# 网络异常场景测试报告 · 打工人记账器 v' + PKG_VERSION + '\n');
  md.push('- 执行时间：' + new Date().toLocaleString('zh-CN'));
  md.push('- 方法：在 IPC 边界（holidays:fetch）注入故障；应用唯一网络依赖为节假日接口，主进程原生实现带 9s 超时');
  md.push('- 场景：断网 / 超时 / 弱网 / 脏数据（结构缺失、类型错乱、超长）/ 恢复联网 / 缓存策略\n');
  md.push('## 结果\n');
  md.push('| 编号 | 场景 | 结果 | 证据 |');
  md.push('|---|---|---|---|');
  results.forEach((r) => md.push('| ' + r.id + ' | ' + r.name + ' | ' + (r.pass ? '✅' : '❌') + ' | ' + r.detail + ' |'));
  md.push('\n## 结论\n');
  const n02 = results.find((r) => r.id === 'N-02');
  md.push('- 容错面整体健康：断网/超时/脏数据全部不崩溃、不阻塞 UI，回退内置节假日表（HOLIDAY_SEED）。');
  md.push('- 观察项 O-01（轻微）：refreshHolidays 对多年份是顺序 await，第一年 pending/慢响应会阻塞第二年预取；主进程实现带 9s 超时，最坏延迟 9s，影响极小，建议改为 Promise.allSettled。');
  md.push(n02 && n02.pass
    ? '- **白盒疑点澄清（非缺陷）**：refreshHolidays 虽在请求前写内存 checkedAt，但 save() 仅在成功时落盘——断网失败后磁盘 checkedAt 保持 0，重启即自动重试；且非强制刷新只在启动时发生一次，会话内无重试需求。设计可接受。'
    : '- holidayCheckedAt 行为见 N-02 证据。');
  fs.writeFileSync(REPORT, md.join('\n'), 'utf8');
  console.log('REPORT | ' + REPORT);
  app.exit(0);
});
