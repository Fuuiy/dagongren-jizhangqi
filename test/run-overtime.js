/* 打工人记账器 v1.9.0 · 加班补录 / 时间轴 / 逻辑合理性 专项 harness
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron test/run-overtime.js
 *
 * 这一套不测「功能有没有」，专测「合不合逻辑、像不像人会用」：
 *   O1  打卡模式补班外时间 = 加班，全额进钱
 *   O2  班内 + 班外混合补录，金额按时长原样算
 *   O3  全自动模式：班内拒绝并说清理由、班外可补
 *   O4  全自动补班外加班，不占用当天日薪额度（补完照样能赚满）
 *   O5  定点打卡同样能补班外加班
 *   O6  打卡模式时间轴 = 真实打卡 → 收工时刻（不再显示填写的班次时间）
 *   O7  计时中时间轴右端是「预计」，不是写死的下班时间
 *   O8  忘了点下班：超过班次 4 小时给出提醒
 *   O9  补录不改单价（时薪/日薪卡不动），只改已赚
 *   O10 加班时长单独统计（加班药丸），并计入「已工作」
 *   O11 删除加班补录：钱、加班时长、账本一起退回
 *   O12 班前超过 4 小时被拦，理由带「最早几点」
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE = 'dgjz.worker.v1';
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const REPORT = path.join(ROOT, '测试报告-加班与时间轴-v' + PKG_VERSION + '.md');

// 每个套件用独立 userData：默认所有套件共用一个 localStorage，
// 上一套件/上一轮没退干净时会把「今天已赚满」的存档带进来（实测 09:30 就有全天收入）
app.setPath('userData', path.join(require('os').tmpdir(), 'dgjz-harness-' + path.basename(__filename, '.js')));

let win = null;
const consoleErrors = [];
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
  // v1.2.1：没干满就下班的确认弹窗——这些套件只关心结算结果，自动点「照样下班」
  try {
    const dm = document.getElementById('dlgMask');
    if (dm) new MutationObserver(() => {
      if (!dm.hidden) setTimeout(() => { const ok = document.getElementById('dlgOk'); if (ok) ok.click(); }, 0);
    }).observe(dm, { attributes: true, attributeFilter: ['hidden'] });
  } catch (e) {}
  const RN = Date.now.bind(Date);
  const RealDate = window.Date;
  window.__off = 0;
  Date.now = () => RN() + window.__off;
  class RD extends RealDate {
    constructor(...a) { if (a.length === 0) super(RN() + window.__off); else super(...a); }
  }
  window.Date = RD;
  window.__at = (h, m, s) => { const t = new RealDate(); t.setHours(h, m || 0, s || 0, 0); window.__off = t.getTime() - RN(); };
  window.__later = (ms) => { window.__off += ms; };
  return 'ok';
})()`;

const SNAP = `(() => {
  const q = (s) => document.querySelector(s);
  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem('${STORE}') || '{}'); } catch (e) {}
  const secOf = (t) => { const p = String(t || '0:0:0').split(':').map(Number); return (p[0]||0)*3600 + (p[1]||0)*60 + (p[2]||0); };
  return {
    earned: parseFloat((q('#todayEarned').textContent || '0').replace(/,/g, '')) || 0,
    worked: q('#worked').textContent.trim(),
    workedSec: secOf(q('#worked').textContent.trim()),
    state: q('#workState').textContent.trim(),
    tlLeft: q('#tlLeft').textContent.trim(),
    tlStart: q('#tlStart').textContent.trim(),
    tlEnd: q('#tlEnd').textContent.trim(),
    tlWarnHidden: q('#tlWarn').hidden,
    tlWarn: (q('#tlWarn').textContent || '').trim(),
    fixHint: (q('#fixHint').textContent || '').trim(),
    fixHintWarn: q('#fixHint').classList.contains('warn'),
    fixOpen: !q('#miniMask').hidden,
    fixSub: (q('#fixSub').textContent || '').trim(),
    otHidden: q('#otPill') ? q('#otPill').hidden : true,
    otText: q('#otTime') ? q('#otTime').textContent.trim() : '',
    perHour: parseFloat((q('#perHour').textContent || '').replace(/[^0-9.]/g, '')) || 0,
    perDayCard: parseFloat((q('#perDay').textContent || '').replace(/[^0-9.]/g, '')) || 0,
    perSecCard: parseFloat((q('#perSecCard').textContent || '').replace(/[^0-9.]/g, '')) || 0,
    cfg
  };
})()`;

async function openSettings() {
  await R(`if (!document.querySelector('#sheet').classList.contains('on')) document.querySelector('#btnSettings').click(); 'ok'`);
  await sleep(200);
}
async function saveSettings() { await R(CLICK('#btnSave')); await sleep(350); }
async function openFix() { await R(CLICK('#btnFix')); await sleep(280); }
async function setFix(a, z) {
  await R(`(() => {
    const s = document.querySelector('#inFixStart'), e = document.querySelector('#inFixEnd');
    s.value = '${a}'; e.value = '${z}';
    s.dispatchEvent(new Event('input', {bubbles:true})); e.dispatchEvent(new Event('input', {bubbles:true}));
    return 'ok';
  })()`);
  await sleep(180);
}
async function applyFix() { await R(CLICK('#btnFixOk')); await sleep(350); }

let FIXTURE = null;
let perDay = 0;
let perHour = 0;

async function createWindow() {
  win = new BrowserWindow({
    width: 424, height: 720, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, spellcheck: false
    }
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('console-message', (e, level, msg) => {
    if (level >= 2) consoleErrors.push('[L' + level + '] ' + msg);
  });
  win.webContents.on('render-process-gone', (e, d) => consoleErrors.push('[CRASH] ' + JSON.stringify(d)));
  win.webContents.on('did-fail-load', (e, c, desc) => consoleErrors.push('[LOAD-FAIL] ' + c + ' ' + desc));
  win.show();
}

async function boot() {
  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await sleep(600);
  await R(`localStorage.removeItem('${STORE}'); location.reload(); 'wipe'`);
  await sleep(1300);
  await R(INJECT);
  await openSettings();
  await R(`(() => {
    const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('blur', {bubbles:true})); };
    set('#inStart', '09:00'); set('#inEnd', '18:00');
    set('#inLunchStart', '12:00'); set('#inLunchEnd', '13:00');
    return 'ok';
  })()`);
  await saveSettings();
  const s = await R(SNAP);
  FIXTURE = s.cfg;
  perDay = 8000 / FIXTURE.workDays;
  perHour = perDay / 8;                       // 09:00–18:00 扣 1 小时午休 = 8 小时
  if (FIXTURE.start !== '09:00' || FIXTURE.end !== '18:00' || FIXTURE.clockFrom !== 'click') {
    throw new Error('fixture 创建失败: ' + JSON.stringify({ s: FIXTURE.start, e: FIXTURE.end, m: FIXTURE.clockFrom }));
  }
  console.log('FIXTURE ok | workDays=' + FIXTURE.workDays + ' perDay=' + perDay.toFixed(2) + ' perHour=' + perHour.toFixed(2));
}

async function reset() {
  await R("localStorage.setItem('" + STORE + "', " + JSON.stringify(JSON.stringify(FIXTURE)) + "); location.reload(); 'reloading'");
  await sleep(1100);
  await R(INJECT);
  await sleep(150);
}

async function setMode(mode, auto) {
  await openSettings();
  await R(`document.querySelector('.mcard[data-mode="${mode}"][data-auto="${auto}"]').click(); 'ok'`);
  await sleep(150);
  await saveSettings();
}

async function punch(h, m) {
  await R(`window.__at(${h}${m ? ',' + m : ''}); document.querySelector('#btnClock').click(); 'ok'`);
  await sleep(320);
}

/* ---------- O1：打卡模式补班外 = 加班 ---------- */
async function o1_click_overtime() {
  await reset();
  await punch(9);
  await R(`window.__at(15); 'ok'`);
  await sleep(400);
  const before = await R(SNAP);
  await openFix();
  await setFix('06:00', '08:00');
  const h = await R(SNAP);
  const okHint = !h.fixHintWarn && h.fixHint.indexOf('可补 ¥') >= 0 && h.fixHint.indexOf('班外加班') >= 0;
  await applyFix();
  const after = await R(SNAP);
  const gain = after.earned - before.earned;
  const want = 2 * perHour;
  const fr = (after.cfg.fixRanges || [])[0] || {};
  record('O1', '打卡模式补 06:00–08:00（班前）→ 按加班全额进钱',
    okHint && near(gain, want, 0.6) && Math.round(fr.otSec) === 7200 && fr.inSec === 0,
    '提示=[' + h.fixHint + '] 进账=' + gain.toFixed(2) + '（期望 ' + want.toFixed(2) + '）'
    + ' otSec=' + fr.otSec + ' inSec=' + fr.inSec);
}

/* ---------- O2：班内 + 班外混合 ---------- */
async function o2_mixed() {
  await reset();
  await punch(13);
  await R(`window.__at(15); 'ok'`);
  await sleep(400);
  const before = await R(SNAP);
  await openFix();
  await setFix('07:00', '12:00');            // 班前 2h + 班内 3h（不碰正在计时的 13:00 之后）
  const h = await R(SNAP);
  const okHint = h.fixHint.indexOf('其中班外加班 2 小时') >= 0;
  await applyFix();
  const after = await R(SNAP);
  const fr = (after.cfg.fixRanges || [])[0] || {};
  const gain = after.earned - before.earned;
  record('O2', '班前+班内混合补录：5 小时全额算，其中 2 小时标成加班',
    okHint && near(gain, 5 * perHour, 1.0) && Math.round(fr.otSec) === 7200 && Math.round(fr.inSec) === 10800,
    '提示=[' + h.fixHint + '] 进账=' + gain.toFixed(2) + '（期望 ' + (5 * perHour).toFixed(2) + '）'
    + ' inSec=' + fr.inSec + ' otSec=' + fr.otSec);
}

/* ---------- O3：全自动：班内拒绝、班外可补 ---------- */
async function o3_auto_scope() {
  await reset();
  await setMode('schedule', 1);
  await R(`window.__at(20); 'ok'`);
  await sleep(400);
  const before = await R(SNAP);

  await openFix();
  await setFix('10:00', '11:00');            // 班内
  const hIn = await R(SNAP);
  await applyFix();
  const afterIn = await R(SNAP);
  const inBlocked = hIn.fixHintWarn && hIn.fixHint.indexOf('整段算过钱了') >= 0
    && Math.abs(afterIn.earned - before.earned) < 0.02;

  await openFix();
  await setFix('18:30', '20:00');            // 班后 1.5h
  const hOut = await R(SNAP);
  const okOutHint = !hOut.fixHintWarn && hOut.fixHint.indexOf('班外加班') >= 0;
  await applyFix();
  const afterOut = await R(SNAP);
  const gain = afterOut.earned - afterIn.earned;
  record('O3', '全自动：班内补录被拒（说明已整段算过），班外加班可以补',
    inBlocked && okOutHint && near(gain, 1.5 * perHour, 0.8),
    '班内=[' + hIn.fixHint + '] 班外=[' + hOut.fixHint + '] 班外进账=' + gain.toFixed(2)
    + '（期望 ' + (1.5 * perHour).toFixed(2) + '）');
}

/* ---------- O4：加班不占日薪额度 ---------- */
async function o4_ot_not_eat_base() {
  await reset();
  // v1.2.2：切换后本班从切换时刻起算，所以切换得在班次开始之前做（否则起算点跑到 18:xx，正班一分不涨）
  await R(`window.__at(8, 0); 'ok'`);
  await setMode('schedule', 1);
  await R(`window.__at(10); 'ok'`);
  await sleep(400);
  await openFix();
  await setFix('08:00', '09:00');            // 班前 1 小时加班
  const h = await R(SNAP);
  await applyFix();
  const mid = await R(SNAP);
  await R(`window.__at(18); 'ok'`);          // 干到下班
  await sleep(500);
  const end = await R(SNAP);
  record('O4', '全自动补了班前加班后，当天照样能赚满日薪（加班不挤占正班额度）',
    !h.fixHintWarn && mid.earned > 1.5 * perHour && near(end.earned, perDay + perHour, 1.2),
    '补时提示=[' + h.fixHint + '] 补后=' + mid.earned + ' 下班后=' + end.earned
    + '（期望 ' + (perDay + perHour).toFixed(2) + '）');
}

/* ---------- O5：定点打卡也能补班外 ---------- */
async function o5_schedule_manual() {
  await reset();
  await setMode('schedule', 0);
  await R(`window.__at(9); document.querySelector('#btnClock').click(); 'ok'`);
  await sleep(300);
  await R(`window.__at(20); 'ok'`);
  await sleep(400);
  const before = await R(SNAP);
  await openFix();
  const sub = (await R(SNAP)).fixSub;
  await setFix('18:30', '19:30');
  const h = await R(SNAP);
  await applyFix();
  const after = await R(SNAP);
  const gain = after.earned - before.earned;
  record('O5', '定点打卡：弹层说明「补班外加班」，班后 1 小时可补',
    sub.indexOf('班外加班') >= 0 && !h.fixHintWarn && near(gain, perHour, 0.8),
    '副标题=[' + sub + '] 提示=[' + h.fixHint + '] 进账=' + gain.toFixed(2) + '（期望 ' + perHour.toFixed(2) + '）');
}

/* ---------- O6：收工后时间轴 = 真实打卡 ---------- */
async function o6_timeline_done() {
  await reset();
  await punch(10);
  await R(`window.__at(15); 'ok'`);
  await sleep(300);
  await R(CLICK('#btnClock'));               // 下班
  await sleep(500);
  const s = await R(SNAP);
  const okStart = s.tlStart.indexOf('10:00') >= 0 && s.tlStart.indexOf('打卡') >= 0;
  const okEnd = s.tlEnd.indexOf('15:00') >= 0 && s.tlEnd.indexOf('收工') >= 0;
  const noSched = s.tlEnd.indexOf('18:00') < 0 && s.tlStart.indexOf('09:00') < 0;
  record('O6', '打卡模式收工后：时间轴显示 10:00 打卡 → 15:00 收工，不再是填写的 09:00/18:00',
    okStart && okEnd && noSched, '左=[' + s.tlStart + '] 右=[' + s.tlEnd + '] 左标=[' + s.tlLeft + ']');
}

/* ---------- O7：计时中右端是「预计」 ---------- */
async function o7_timeline_running() {
  await reset();
  await punch(10);
  await R(`window.__at(12); 'ok'`);
  await sleep(400);
  const s = await R(SNAP);
  const okStart = s.tlStart.indexOf('10:00') >= 0 && s.tlStart.indexOf('打卡') >= 0;
  const okEnd = s.tlEnd.indexOf('预计') >= 0 && s.tlEnd.indexOf('19:00') >= 0;   // 10:00 + 9h
  record('O7', '计时中时间轴：左端打卡时刻，右端写「预计」而不是假装已经下班',
    okStart && okEnd, '左=[' + s.tlStart + '] 右=[' + s.tlEnd + ']');
}

/* ---------- O8：忘下班提醒 ---------- */
async function o8_forgot_clockout() {
  await reset();
  await punch(9);
  await R(`window.__later(14 * 3600e3); 'ok'`);   // 打了 14 小时还没点下班（09:00 → 当天 23:00）
  await sleep(500);
  const s = await R(SNAP);
  const ok = !s.tlWarnHidden && s.tlWarn.indexOf('忘了') >= 0 && s.tlWarn.indexOf('不涨了') >= 0;
  record('O8', '忘了点下班：超时后提示「是不是忘了点下班」，并说明钱会停在几点',
    ok, '警告=[' + s.tlWarn + '] 隐藏=' + s.tlWarnHidden + ' 已工作=' + s.worked);
}

/* ---------- O9：补录不改单价 ---------- */
async function o9_price_untouched() {
  await reset();
  await punch(9);
  await R(`window.__at(15); 'ok'`);
  await sleep(300);
  const b = await R(SNAP);
  await openFix();
  await setFix('06:00', '08:00');
  await applyFix();
  const a = await R(SNAP);
  record('O9', '补录只加钱，不改单价：时薪/日薪/秒薪卡纹丝不动',
    near(a.perHour, b.perHour, 0.01) && near(a.perDayCard, b.perDayCard, 0.01)
    && near(a.perSecCard, b.perSecCard, 0.0002),
    '时薪 ' + b.perHour + '→' + a.perHour + ' 日薪 ' + b.perDayCard + '→' + a.perDayCard
    + ' 秒薪 ' + b.perSecCard + '→' + a.perSecCard);
}

/* ---------- O10：加班单独统计 + 计入已工作 ---------- */
async function o10_ot_pill() {
  await reset();
  await punch(9);
  await R(`window.__at(15); 'ok'`);
  await sleep(300);
  const b = await R(SNAP);
  await openFix();
  await setFix('06:00', '08:00');
  await applyFix();
  const a = await R(SNAP);
  const grew = a.workedSec - b.workedSec;
  record('O10', '班外加班 2 小时：加班药丸出现，且「已工作」把这段算进去',
    !a.otHidden && a.otText.indexOf('2') >= 0 && near(grew, 7200, 120),
    '药丸=' + (a.otHidden ? '隐藏' : a.otText) + ' 已工作 ' + b.worked + '→' + a.worked
    + '（+ ' + Math.round(grew / 60) + ' 分钟）');
}

/* ---------- O11：删除加班补录全额退回 ---------- */
async function o11_remove_ot() {
  await reset();
  await punch(9);
  await R(`window.__at(15); 'ok'`);
  await sleep(300);
  const b = await R(SNAP);
  await openFix();
  await setFix('06:00', '08:00');
  await applyFix();
  const mid = await R(SNAP);
  await openFix();
  await R(`document.querySelector('.fi-del').click(); 'ok'`);   // 第一下变「确认?」
  await sleep(150);
  await R(`document.querySelector('.fi-del.armed, .fi-del').click(); 'ok'`);
  await sleep(400);
  const a = await R(SNAP);
  record('O11', '删掉加班补录：钱与加班时长一起退回，回到补之前',
    near(mid.earned, b.earned + 2 * perHour, 0.8) && near(a.earned, b.earned, 0.05)
    && (a.cfg.fixRanges || []).length === 0 && a.otHidden,
    '补前=' + b.earned + ' 补后=' + mid.earned + ' 删后=' + a.earned
    + ' 剩余段=' + (a.cfg.fixRanges || []).length);
}

/* ---------- O12：班前超过 4 小时拦住 ---------- */
async function o12_too_early() {
  await reset();
  await punch(9);
  await R(`window.__at(15); 'ok'`);
  await sleep(300);
  await openFix();
  await setFix('03:00', '04:00');            // 09:00 上班，最早只能到 05:00
  const h = await R(SNAP);
  const ok = h.fixHintWarn && h.fixHint.indexOf('最早 05:00') >= 0;
  await applyFix();
  const a = await R(SNAP);
  record('O12', '班前 6 小时想补：拦住并给出「最早 05:00」，不白送钱',
    ok && (a.cfg.fixRanges || []).length === 0,
    '提示=[' + h.fixHint + '] 补录段=' + (a.cfg.fixRanges || []).length);
}

/* ---------- O13：收工后补「已结算过的班内时段」要拦住 ---------- */
async function o13_no_double_after_done() {
  await reset();
  await punch(9);
  await R(`window.__at(15); 'ok'`);
  await sleep(300);
  await R(CLICK('#btnClock'));               // 15:00 下班，09:00–15:00 已结过
  await sleep(450);
  const b = await R(SNAP);
  await openFix();
  await setFix('10:00', '11:00');            // 落在已结算区间里
  const h = await R(SNAP);
  await applyFix();
  const a = await R(SNAP);
  const blocked = h.fixHintWarn && h.fixHint.indexOf('算过了') >= 0
    && Math.abs(a.earned - b.earned) < 0.02 && (a.cfg.fixRanges || []).length === 0;

  // 但班外的加班还能补（不碰已结算区间）
  await openFix();
  await setFix('06:00', '08:00');
  const h2 = await R(SNAP);
  await applyFix();
  const a2 = await R(SNAP);
  const otOk = !h2.fixHintWarn && a2.earned > a.earned + 0.5;
  record('O13', '收工后补已结算的班内时段被拦（不重复领钱），班外加班仍可补',
    blocked && otOk,
    '班内=[' + h.fixHint + '] 金额 ' + b.earned + '→' + a.earned
    + ' 班外=[' + h2.fixHint + '] →' + a2.earned);
}

/* ---------- 启动 ---------- */
app.whenReady().then(async () => {
  ipcMain.handle('app:version', () => PKG_VERSION);
  ipcMain.handle('holidays:fetch', () => null);
  ipcMain.handle('win:pin', () => true);
  ipcMain.handle('data:export', () => ({ ok: true, path: 'x' }));
  ipcMain.handle('data:import', () => ({ canceled: true }));
  await createWindow();
  try {
    await boot();
    await o1_click_overtime();
    await o2_mixed();
    await o3_auto_scope();
    await o4_ot_not_eat_base();
    await o5_schedule_manual();
    await o6_timeline_done();
    await o7_timeline_running();
    await o8_forgot_clockout();
    await o9_price_untouched();
    await o10_ot_pill();
    await o11_remove_ot();
    await o12_too_early();
    await o13_no_double_after_done();
  } catch (e) {
    console.log('FATAL | ' + (e && e.stack || e));
  }

  const pass = results.filter((r) => r.pass).length;
  console.log('SUMMARY | pass=' + pass + '/' + results.length);
  if (consoleErrors.length) {
    console.log('CONSOLE-ERR | ' + consoleErrors.slice(0, 5).join(' ;; '));
  }

  const lines = [];
  lines.push('# 打工人记账器 v' + PKG_VERSION + ' · 加班补录 / 时间轴专项报告');
  lines.push('');
  lines.push('- 运行时间：' + new Date().toISOString());
  lines.push('- 结果：**' + pass + ' / ' + results.length + '**');
  lines.push('');
  lines.push('| 编号 | 用例 | 结果 | 实测 |');
  lines.push('| --- | --- | --- | --- |');
  results.forEach((r) => {
    lines.push('| ' + r.id + ' | ' + r.name + ' | ' + (r.pass ? '✅ 通过' : '❌ 失败') + ' | '
      + String(r.detail).replace(/\|/g, '\\|') + ' |');
  });
  if (consoleErrors.length) {
    lines.push('');
    lines.push('## 渲染进程报错');
    consoleErrors.slice(0, 10).forEach((e) => lines.push('- ' + e));
  }
  fs.writeFileSync(REPORT, lines.join('\n'), 'utf8');
  console.log('REPORT | ' + REPORT);

  app.exit(pass === results.length ? 0 : 1);
});
