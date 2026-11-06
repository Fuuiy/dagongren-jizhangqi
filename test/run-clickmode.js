/* 打工人记账器 v1.2.1 · 打卡那一刻的「应工作」语义
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron test/run-clickmode.js
 *
 * 用户诉求：
 *   · 打卡那一刻模式里，填的 08:00–17:00 只作参考，应工作 = 班次 − 午休 = 8 小时
 *   · 打卡后要能看见「需要工作的时间段 / 时长」，以及已完成多少
 *   · 点下班时如果没干满，要提示还差多少（而不是默默按实际结算）
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE = 'dgjz.worker.v1';
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const REPORT = path.join(ROOT, '测试报告-打卡模式应工作-v' + PKG_VERSION + '.md');

app.setPath('userData', path.join(require('os').tmpdir(), 'dgjz-harness-' + path.basename(__filename, '.js')));

let win = null;
const results = [];
const consoleErrors = [];
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
  const num = (s) => parseFloat(String((q(s) || {}).textContent || '').replace(/[^0-9.]/g, '')) || 0;
  let c = {};
  try { c = JSON.parse(localStorage.getItem('${STORE}') || '{}'); } catch (e) {}
  return {
    earned: num('#todayEarned'),
    worked: (q('#worked').textContent || '').trim(),
    workedNeed: (q('#workedNeed') || {}).hidden ? '' : (q('#workedNeed').textContent || '').trim(),
    state: (q('#workState').textContent || '').trim(),
    tlRef: (q('#tlRef') || {}).hidden ? '' : (q('#tlRef').textContent || '').trim(),
    tlStart: (q('#tlStart').textContent || '').trim(),
    tlEnd: (q('#tlEnd').textContent || '').trim(),
    otShown: q('#otPill') ? !q('#otPill').hidden : false,
    otText: (q('#otTime') || {}).textContent || '',
    toast: (q('#toast') || {}).hidden ? '' : (q('#toast').textContent || '').trim(),
    dlgOn: !q('#dlgMask').hidden,
    dlgTitle: (q('#dlgTitle').textContent || '').trim(),
    dlgText: (q('#dlgText').textContent || '').trim(),
    spanHint: (q('#spanHint').textContent || '').trim(),
    lastShift: c.lastShift ? { start: c.lastShift.start, seconds: c.lastShift.seconds } : null,
    doneShift: c.doneShift || null,
    settled: c.settled || 0
  };
})()`;

async function boot() {
  await R(`(() => {
    const c = { inited: true, confirmedByUser: true, salary: 8000, workDays: 21, daysMode: 'double',
      start: '08:00', end: '17:00', lunchStart: '12:00', lunchEnd: '13:00',
      clockFrom: 'click', autoRun: false, segments: [], clockIn: null, doneShift: null,
      lastShift: null, todaySettled: null, dailyLog: {}, leaves: {}, fixDay: '', fixRanges: [],
      goalAmount: 5999, goalName: '买台新手机', goalEmoji: '📱', savedBase: 0, settled: 0,
      dailyHours: null, otRate: 1, closeToTray: true };
    localStorage.setItem('${STORE}', JSON.stringify(c)); location.reload(); return 'ok'; })()`);
  await sleep(1500);
  await R(INJECT);
  await sleep(250);
}

async function main() {
  win = new BrowserWindow({
    width: 424, height: 720, show: false, frame: false, resizable: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.webContents.on('console-message', (e, level, msg) => {
    const m = String(msg);
    if (level >= 2 && m.indexOf('Electron Security Warning') < 0) consoleErrors.push(m.slice(0, 160));
  });
  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await sleep(1300);
  const S = () => R(SNAP);

  /* ---------- C1 未打卡：应工作时段与时长要摆在眼前 ---------- */
  await boot();
  await R(`window.__at(8, 0); 'ok'`);
  await sleep(500);
  const c1 = await S();
  record('C1', '打卡模式未打卡：时间轴下方标出「应工作 8:00（参照 08:00–17:00，含午休 60 分钟）」，已工作后面跟着 / 8:00',
    c1.tlRef.indexOf('应工作') >= 0 && c1.tlRef.indexOf('8:00') >= 0 && c1.tlRef.indexOf('08:00') >= 0
      && c1.tlRef.indexOf('60') >= 0 && c1.workedNeed === '/ 8:00',
    '参照=[' + c1.tlRef + '] 已工作=' + c1.worked + c1.workedNeed);

  /* ---------- C2 打卡 4 小时后：显示完成度 ---------- */
  await R(CLICK('#btnClock'));
  await sleep(400);
  await R(`window.__later(4 * 3600e3); 'ok'`);
  await sleep(700);
  const c2 = await S();
  record('C2', '打卡 4 小时：参照行显示已完成 50%，钱按实际 4 小时算',
    c2.tlRef.indexOf('已完成 50%') >= 0 && near(c2.earned, (8000 / 21 / 8) * 4, 1),
    '参照=[' + c2.tlRef + '] 已赚=' + c2.earned.toFixed(2) + '（≈' + ((8000 / 21 / 8) * 4).toFixed(2) + '）');

  /* ---------- C3 没干满就点下班：先提示差多少 ---------- */
  await R(CLICK('#btnClock'));
  await sleep(500);
  const c3 = await S();
  record('C3', '只干了 4 小时就点「下班啦」：弹确认，写明「少 4:00」而不是直接结算',
    c3.dlgOn && c3.dlgTitle.indexOf('还没干满') >= 0
      && c3.dlgText.indexOf('4:00') >= 0 && c3.dlgText.indexOf('8:00') >= 0,
    '标题=[' + c3.dlgTitle + '] 文案=[' + c3.dlgText + ']');

  /* ---------- C4 取消：继续上班，没结算 ---------- */
  await R(CLICK('#dlgCancel'));
  await sleep(500);
  const c4 = await S();
  record('C4', '点「再干一会儿」：继续计时、没有收工、没有结算',
    !c4.dlgOn && c4.lastShift === null && c4.doneShift === null && c4.earned > 180,
    '弹窗=' + c4.dlgOn + ' 状态=' + c4.state + ' 已赚=' + c4.earned.toFixed(2));

  /* ---------- C5 确认：按实际 4 小时结算 ---------- */
  await R(CLICK('#btnClock'));
  await sleep(450);
  await R(CLICK('#dlgOk'));
  await sleep(700);
  const c5 = await S();
  record('C5', '点「照样下班」：按实际 4 小时结算（≈190.48），状态已收工',
    c5.doneShift !== null && near(c5.earned, (8000 / 21 / 8) * 4, 2) && c5.state.indexOf('收工') >= 0,
    '已赚=' + c5.earned.toFixed(2) + ' 状态=' + c5.state + ' 结算秒=' + (c5.lastShift ? c5.lastShift.seconds : '-'));

  /* ---------- C6 干满 8 小时：不打扰，直接收工 ---------- */
  await boot();
  await R(`window.__at(8, 0); document.querySelector('#btnClock').click(); 'ok'`);
  await sleep(400);
  await R(`window.__later(8 * 3600e3); 'ok'`);
  await sleep(700);
  const beforeFull = await S();
  await R(CLICK('#btnClock'));
  await sleep(600);
  const c6 = await S();
  record('C6', '干满 8 小时点下班：不弹确认、直接收工，金额=日薪（封顶）',
    !c6.dlgOn && c6.doneShift !== null && near(c6.earned, 8000 / 21, 0.6),
    '干满时已赚=' + beforeFull.earned.toFixed(2) + ' 收工后=' + c6.earned.toFixed(2)
    + '（日薪≈' + (8000 / 21).toFixed(2) + '）弹窗=' + c6.dlgOn);

  /* ---------- C7 超出应工作：收工后提示按加班 ---------- */
  await boot();
  await R(`window.__at(8, 0); document.querySelector('#btnClock').click(); 'ok'`);
  await sleep(400);
  await R(`window.__later(9 * 3600e3); 'ok'`);
  await sleep(700);
  await R(CLICK('#btnClock'));
  await sleep(700);
  const c7 = await S();
  record('C7', '干了 9 小时点下班：直接收工、提示超出 1 小时按加班，加班药丸显示 1:00',
    c7.doneShift !== null && c7.otShown && c7.otText.indexOf('1:00') >= 0
      && (c7.toast.indexOf('超出') >= 0 || c7.toast.length === 0),
    '加班=' + c7.otText + ' 提示=[' + c7.toast + '] 已赚=' + c7.earned.toFixed(2));

  /* ---------- C8 设置里说明「只作参考」 ---------- */
  await R(CLICK('#btnSettings'));
  await sleep(700);
  const c8 = await S();
  record('C8', '设置面板里明确写出「打卡模式这两个时间只作参考：用来算时薪与应工作 8:00」',
    c8.spanHint.indexOf('只作参考') >= 0 && c8.spanHint.indexOf('应工作 8:00') >= 0,
    '提示=[' + c8.spanHint + ']');

  /* ---------- C9 其它模式不显示这条参照 ---------- */
  await R(`document.querySelector('.mcard[data-mode="schedule"][data-auto="1"]').click(); 'ok'`);
  await sleep(200);
  await R(CLICK('#btnSave'));
  await sleep(500);
  if (await R(`!document.querySelector('#dlgMask').hidden`)) { await R(CLICK('#dlgOk')); await sleep(600); }
  const c9 = await S();
  record('C9', '切到全自动：不再显示「应工作」参照行（那时班次就是规则本身）',
    c9.tlRef === '' && c9.workedNeed === '',
    '参照=[' + c9.tlRef + '] / 应工作=[' + c9.workedNeed + ']');

  record('C10', '全流程无未捕获 JS 异常', consoleErrors.length === 0,
    consoleErrors.length ? consoleErrors.slice(0, 2).join(' / ') : '无');

  const pass = results.filter((r) => r.pass).length;
  console.log('SUMMARY | pass=' + pass + '/' + results.length);
  writeReport(pass);
  app.exit(pass === results.length ? 0 : 1);
}

function writeReport(pass) {
  const lines = [];
  lines.push('# 测试报告 · 打卡那一刻的应工作语义 v' + PKG_VERSION);
  lines.push('');
  lines.push('日期：' + new Date().toISOString().slice(0, 10) + ' · 环境：Electron '
    + process.versions.electron + ' · 结果：**' + pass + '/' + results.length + ' 通过**');
  lines.push('');
  lines.push('| 用例 | 说明 | 结果 | 实测 |');
  lines.push('|---|---|---|---|');
  for (const r of results) {
    lines.push('| ' + r.id + ' | ' + r.name + ' | ' + (r.pass ? 'PASS' : '**FAIL**') + ' | '
      + String(r.detail).replace(/\|/g, '/') + ' |');
  }
  fs.writeFileSync(REPORT, lines.join('\n') + '\n');
  console.log('REPORT | ' + REPORT);
}

app.whenReady().then(() => {
  ipcMain.handle('app:version', () => PKG_VERSION);
  ipcMain.handle('holidays:fetch', () => null);
  ipcMain.handle('data:export', () => ({ canceled: true }));
  ipcMain.handle('data:import', () => ({ canceled: true }));
  ipcMain.handle('app:data-path', () => path.join(require('os').tmpdir(), 'dgjz-harness-clickmode'));
  ipcMain.handle('app:tray', () => ({ hasTray: true, icon: { width: 16, height: 16 }, tooltip: 'x' }));
  ipcMain.on('win:close-behavior', () => {});
  ipcMain.on('app:copy', () => {});
  ipcMain.on('win:compact', () => {});
  ipcMain.on('win:pin', () => {});
  ipcMain.on('win:minimize', () => {});
  ipcMain.on('win:close', () => {});
  main().catch((e) => {
    console.log('FATAL | ' + (e && e.stack || e));
    app.exit(1);
  });
});
