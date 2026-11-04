/* v1.11.0 新增功能专项测试
 * 覆盖：四档换算卡（时/日/分/秒薪）、换算卡（奶茶/午饭/电影票）、
 *       金币动效（上限与存活）、目标表情选择（即选即存）、
 *       撤销下班 lnkRedo、目标达成庆祝（一次性）、btnEditGoal 联动
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron test/run-v111.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const STORE = 'dgjz.worker.v1';
const PKG_VERSION = require(path.join(ROOT, 'package.json')).version;

let win;
const results = [];
const consoleErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.02 : tol);

const INJECT = `(() => {
  if (window.__tb) return 'already';
  const RealDate = Date;
  let offset = 0;
  class FakeDate extends RealDate {
    constructor(...a) { super(); if (a.length === 0) return new RealDate(RealDate.now() + offset); return new RealDate(...a); }
    static now() { return RealDate.now() + offset; }
  }
  FakeDate.UTC = RealDate.UTC; FakeDate.parse = RealDate.parse;
  window.Date = FakeDate;
  window.__tb = {
    set(ms) { offset = ms - RealDate.now(); },
    add(ms) { offset += ms; }
  };
  window.__at = (h, m) => { const d = new Date(); d.setHours(h, m || 0, 0, 0); window.__tb.set(d.getTime()); };
  window.__later = (ms) => window.__tb.add(ms);
  return 'injected';
})()`;

let BASE = null;
let perDay = 380.95;

function holidayPayload() {
  const off = {};
  const add = (y, list) => list.forEach((md) => { off[y + '-' + md] = true; });
  add(2026, ['01-01', '01-02', '02-16', '02-17', '02-18', '02-19', '02-20', '04-05', '05-01', '05-04', '05-05', '06-19', '10-01', '10-02', '10-05', '10-06', '10-07']);
  add(2027, ['01-01']);
  return { off: Object.keys(off), work: [] };
}

async function boot() {
  await app.whenReady();
  ipcMain.handle('holidays:fetch', () => holidayPayload());
  ipcMain.handle('data:export', () => ({ ok: true }));
  ipcMain.handle('data:import', () => ({ canceled: true }));
  ipcMain.on('win:pin', () => {}); ipcMain.on('win:compact', () => {});
  ipcMain.on('win:minimize', () => {}); ipcMain.on('win:close', () => {});
  win = new BrowserWindow({
    width: 424, height: 720, minWidth: 380, minHeight: 640, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false }
  });
  win.webContents.on('console-message', (e, l, m) => { if (l >= 3) consoleErrors.push(String(m).slice(0, 200)); });
  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await sleep(1500);
  await R(INJECT);
  await sleep(200);
  await reset();
  const s = await R(SNAP);
  BASE = Object.assign({}, s.cfg, {
    segments: [], clockIn: null, doneShift: null, lastShift: null,
    todaySettled: null, dailyLog: {}, leaves: {}, fixRanges: [], fixDay: '',
    holidays: s.cfg.holidays || {}, holidayCheckedAt: Date.now(), settled: 0, savedBase: 0,
    dailyHours: null, workDays: 21, daysMode: 'double', inited: true
  });
  perDay = 8000 / 21;
}

const R = (js) => win.webContents.executeJavaScript(js, true);
const CLICK = (sel) => `document.querySelector('${sel}').click(); 'ok'`;

const SNAP = `(() => {
  const q = (s) => document.querySelector(s);
  const cfg = JSON.parse(localStorage.getItem('${STORE}') || 'null');
  return {
    cfg,
    earned: parseFloat(q('#todayEarned').textContent.replace(/,/g, '')) || 0,
    perSec: q('#perSec').textContent.trim(),
    perHour: q('#perHour').textContent.trim(),
    perDayTxt: q('#perDay').textContent.trim(),
    perMin: q('#perMin').textContent.trim(),
    perSecCard: q('#perSecCard').textContent.trim(),
    state: q('#workState').textContent.trim(),
    cvMilk: q('#cvMilk').textContent.trim(),
    cvRice: q('#cvRice').textContent.trim(),
    cvMovie: q('#cvMovie').textContent.trim(),
    coins: q('#coinLayer') ? q('#coinLayer').childElementCount : -1,
    goalEmoji: q('#goalEmoji').textContent.trim(),
    goalPct: q('#goalPct').textContent.trim(),
    goalCardComplete: document.querySelector('.goal').classList.contains('complete'),
    confetti: document.querySelectorAll('.confetti').length,
    lnkRedoHidden: q('#lnkRedo').hidden,
    sheetOn: q('#sheet').classList.contains('on')
  };
})()`;

const record = (id, name, pass, detail) => {
  results.push({ id, name, pass, detail: String(detail).replace(/\s*\n\s*/g, ' ') });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + id + ' ' + name + ' | ' + String(detail).replace(/\s*\n\s*/g, ' '));
};

async function reset(extra) {
  const fixture = Object.assign({}, BASE, extra || {});
  await R(`localStorage.setItem('${STORE}', ${JSON.stringify(JSON.stringify(fixture))}); location.reload(); 'rl'`);
  await sleep(1300);
  await R(INJECT);
  await sleep(250);
}

async function openSettings() {
  const on = await R(`document.querySelector('#sheet').classList.contains('on')`);
  if (!on) { await R(CLICK('#btnSettings')); await sleep(400); }
}

async function punch(h, m) {
  await R(`window.__at(${h}${m != null ? ',' + m : ''}); document.querySelector('#btnClock').click(); 'ok'`);
  await sleep(400);
}

/* V-01 四档换算卡：8000/21 → 日薪 381、时薪 47.62、分薪 0.79、秒薪 0.0132 */
async function v01() {
  await reset();
  const s = await R(SNAP);
  const pd = perDay;                       // 380.952...
  const ph = pd / 8;                       // 47.619
  const pm = ph / 60;                      // 0.7937
  const ps = ph / 3600;                    // 0.01323
  const num = (t) => parseFloat(t.replace(/[^0-9.]/g, ''));
  const ok = near(num(s.perDayTxt), Math.round(pd), 1)
    && near(num(s.perHour), ph, 0.01)
    && near(num(s.perMin), pm, 0.01)
    && near(num(s.perSecCard), ps, 0.0001);
  record('V-01', '四档换算卡：日/时/分/秒薪数值正确', ok,
    '日=' + s.perDayTxt + ' 时=' + s.perHour + '(≈' + ph.toFixed(2) + ') 分=' + s.perMin + '(≈' + pm.toFixed(2) + ') 秒=' + s.perSecCard + '(≈' + ps.toFixed(4) + ')');
}

/* V-02 hero 每秒进账与换算卡联动：打卡后 perSec 显示真实秒薪，换算卡随已赚增长 */
async function v02() {
  await reset();
  await punch(9);
  await R(`window.__later(3600e3); 'ok'`);   // 1h = 47.62
  await sleep(500);
  const s = await R(SNAP);
  const e = perDay / 8;                      // 47.62
  const ps = perDay / 8 / 3600;
  const num = (t) => parseFloat(t.replace(/[^0-9.]/g, ''));
  const milk = num(s.cvMilk), rice = num(s.cvRice), movie = num(s.cvMovie);
  const ok = near(num(s.perSec), ps, 0.0002)
    && near(milk, e / 18, 0.15) && near(rice, e / 25, 0.15) && near(movie, e / 45, 0.15);
  record('V-02', '计时中：每秒进账=真实秒薪；奶茶/午饭/电影票换算与已赚成正比', ok,
    'perSec=' + s.perSec + ' 已赚=' + s.earned.toFixed(2) + ' → 奶茶=' + s.cvMilk + '(≈' + (e / 18).toFixed(1) + ') 午饭=' + s.cvRice + '(≈' + (e / 25).toFixed(1) + ') 电影=' + s.cvMovie + '(≈' + (e / 45).toFixed(1) + ')');
}

/* V-03 金币动效：计时中每秒飘金币、上限 6 个、TTL 后自动清除；停止计时不飘 */
async function v03() {
  await reset();
  await punch(9);
  await sleep(4200);                          // 4 秒 → 应飘 4 个左右（≤6）
  const running = (await R(SNAP)).coins;
  await R(`window.__later(3600e3); document.querySelector('#btnClock').click(); 'ok'`);  // 下班
  await sleep(2600);                          // 等 1.3s TTL 全部移除 + 确认不再新增
  const stopped = (await R(SNAP)).coins;
  const ok = running >= 2 && running <= 6 && stopped === 0;
  record('V-03', '金币动效：计时中飘币（≤6 上限）、1.3s 自清除、下班即停', ok,
    '计时中=' + running + ' 个 下班 2.6s 后=' + stopped + ' 个');
}

/* V-04 目标表情：点选即落盘（不关面板不保存也不丢）、首页同步 */
async function v04() {
  await reset();
  await openSettings();
  await R(`document.querySelector('#emojiRow button[data-e="🚗"]').click(); 'ok'`);
  await sleep(300);
  const diskEmoji = await R(`JSON.parse(localStorage.getItem('${STORE}')).goalEmoji`);
  const active = await R(`document.querySelector('#emojiRow button.active').dataset.e`);
  await R(CLICK('#btnCloseSheet'));
  await sleep(400);
  const s = await R(SNAP);
  const ok = diskEmoji === '🚗' && active === '🚗' && s.goalEmoji === '🚗';
  record('V-04', '目标表情：点选即落盘、active 态正确、首页目标卡同步', ok,
    '磁盘=' + diskEmoji + ' active=' + active + ' 首页=' + s.goalEmoji);
}

/* V-05 撤销下班：收工后出现 lnkRedo，点击恢复计时（已赚不清零继续涨） */
async function v05() {
  await reset();
  await punch(9);
  await R(`window.__later(3600e3); 'ok'`);
  await sleep(300);
  await R(CLICK('#btnClock'));                // 10:00 下班
  await sleep(500);
  const s1 = await R(SNAP);
  const redoShown = !s1.lnkRedoHidden;
  const earnedAtDone = s1.earned;
  await R(CLICK('#lnkRedo'));                 // 撤销
  await sleep(400);
  await R(`window.__later(600e3); 'ok'`);     // 再计 10min
  await sleep(500);
  const s2 = await R(SNAP);
  const e10 = perDay / 8 * (70 / 60);
  const ok = redoShown && s2.lnkRedoHidden && near(s2.earned, e10, 0.6) && s2.earned >= earnedAtDone;
  record('V-05', '撤销下班：链接出现→点击恢复计时→已赚续涨→链接消失', ok,
    '收工=' + earnedAtDone.toFixed(2) + ' lnkRedo 显示=' + redoShown + ' 撤销后+10min=' + s2.earned.toFixed(2) + '(≈' + e10.toFixed(2) + ')');
}

/* V-06 撤销下班守卫：未收工时（运行中）无链接可点；收工标记不符时 shake 不动作 */
async function v06() {
  await reset();
  await punch(9);
  await sleep(400);
  const s = await R(SNAP);
  const hiddenWhileRunning = s.lnkRedoHidden;
  // 直接强点（即便 hidden，程序化 click 也会触发 handler）→ 应 shake 拦截、状态不变
  await R(CLICK('#lnkRedo'));
  await sleep(400);
  const s2 = await R(SNAP);
  const ok = hiddenWhileRunning && s2.state === s.state && near(s2.earned, s.earned, 0.02) && s2.cfg.doneShift == null;
  record('V-06', '撤销下班守卫：计时中点击无效（shake），不产生状态变化', ok,
    '运行中隐藏=' + hiddenWhileRunning + ' 强点后状态=' + s2.state + ' 已赚不变=' + near(s2.earned, s.earned, 0.02));
}

/* V-07 目标达成庆祝：进度跨 100% 时 confetti 绽放一次、卡片加 complete、不重复 */
async function v07() {
  await reset({ savedBase: 5900, goalAmount: 5999, settled: 0 });
  await punch(9);
  await R(`window.__later(2 * 3600e3 + 1800e3); 'ok'`);   // 2.5h ≈ 119 > 99 差额
  await sleep(800);
  const s1 = await R(SNAP);
  const celebratedOnce = s1.goalCardComplete && s1.confetti > 0;
  await sleep(4600);                                       // confetti TTL 4.8s
  const s2 = await R(SNAP);
  const cleaned = s2.confetti === 0 && s2.goalCardComplete;
  const pct = s2.goalPct;
  record('V-07', '目标达成：confetti 一次性绽放+自动清扫、目标卡 complete 常驻', celebratedOnce && cleaned && pct.indexOf('100%') === 0,
    '达成时 confetti=' + s1.confetti + ' complete=' + s1.goalCardComplete + ' 4.6s 后 confetti=' + s2.confetti + ' 进度=' + pct);
}

/* V-08 btnEditGoal 打开设置面板并定位到目标区 */
async function v08() {
  await reset();
  await R(CLICK('#btnEditGoal'));
  await sleep(500);
  const s = await R(SNAP);
  const goalOpen = await R(`document.querySelector('#goalGroup').open`);
  record('V-08', '「改一下」按钮：打开设置面板并展开目标分组', s.sheetOn && goalOpen,
    '面板=' + s.sheetOn + ' 目标分组展开=' + goalOpen);
}

async function runAll() {
  await boot();
  const groups = [
    ['v01', v01], ['v02', v02], ['v03', v03], ['v04', v04],
    ['v05', v05], ['v06', v06], ['v07', v07], ['v08', v08]
  ];
  for (const [n, f] of groups) {
    try { await f(); } catch (e) {
      console.log('GROUP-FAIL | ' + n + ' | ' + (e && e.message));
      results.push({ id: n, name: '（组内异常）', pass: false, detail: String(e && e.message || e) });
    }
  }
}

function report() {
  const pass = results.filter((r) => r.pass).length;
  const lines = [];
  lines.push('# v1.11.0 新增功能专项测试报告');
  lines.push('');
  lines.push('- 版本：' + PKG_VERSION + '　执行：' + new Date().toLocaleString('zh-CN'));
  lines.push('- 结果：**' + pass + '/' + results.length + ' 通过**　控制台错误：' + consoleErrors.length + ' 条');
  lines.push('');
  lines.push('| 编号 | 用例 | 结果 | 证据 |');
  lines.push('|---|---|---|---|');
  results.forEach((r) => lines.push('| ' + r.id + ' | ' + r.name + ' | ' + (r.pass ? '✅' : '❌') + ' | ' + r.detail + ' |'));
  if (consoleErrors.length) {
    lines.push('');
    lines.push('## 控制台错误');
    consoleErrors.forEach((m) => lines.push('- ' + m));
  }
  fs.writeFileSync(path.join(ROOT, '测试报告-v1.11.0新增功能.md'), lines.join('\n'), 'utf8');
  console.log('SUMMARY | ' + pass + '/' + results.length + ' | consoleErrors=' + consoleErrors.length);
  console.log('REPORT | 测试报告-v1.11.0新增功能.md');
}

runAll().then(report).catch((e) => { console.log('FATAL | ' + (e && e.stack || e)); report(); }).finally(() => app.exit(0));
