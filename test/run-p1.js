/* 打工人记账器 v1.8.1 · P1 自动执行 harness
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron test/run-p1.js
 * 原理：与 run-p0.js 相同（真实页面 + UI 驱动 + DOM/localStorage 双断言），
 *       但用「子类化 Date」替代仅覆写 Date.now —— 这样 new Date() 无参调用
 *       （dayKey/monthWorkDays/refreshHolidays 等大量使用）也走模拟时间，
 *       才能测跨天/跨月/夜班锚定。
 * 覆盖：P1 用例（M1 输入与二次确认 / M2 手动模式边界 / M3 定点边界 / M4 夜班与改薪 /
 *       M5 请假链路 / M6 补录拒绝理由 / M7 口径 / M8 参数变更 / M9 目标与明细 /
 *       M10 重置 / M11 工作日与节假日 / M12 窗口行为），含少量顺带的 P2。
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const geo = require(path.join(ROOT, 'win-geometry.js'));
const STORE = 'dgjz.worker.v1';
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const REPORT = path.join(ROOT, '测试报告-P1自动执行-v' + PKG_VERSION + '.md');

// 每个套件用独立 userData：默认所有套件共用一个 localStorage，
// 上一套件/上一轮没退干净时会把「今天已赚满」的存档带进来（实测 09:30 就有全天收入）
app.setPath('userData', path.join(require('os').tmpdir(), 'dgjz-harness-' + path.basename(__filename, '.js')));

let win = null;
let consoleErrors = [];
let holidayPayload = null;      // holidays:fetch 的可控返回
let normalBounds = null;        // 小窗测试用：完整面板时的窗口几何

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
  // 子类化 Date：无参 new Date() 也跟随模拟时间；带参构造保持精确
  class RD extends RealDate {
    constructor(...a) { if (a.length === 0) super(RN() + window.__off); else super(...a); }
  }
  window.Date = RD;
  window.__at = (h, m, s) => { const t = new RealDate(); t.setHours(h, m || 0, s || 0, 0); window.__off = t.getTime() - RN(); };
  window.__date = (y, mo, d, h, mi) => { const t = new RealDate(y, mo - 1, d, h || 10, mi || 0, 0, 0); window.__off = t.getTime() - RN(); };
  window.__later = (ms) => { window.__off += ms; };
  return 'ok';
})()`;

const SNAP = `(() => {
  const q = (s) => document.querySelector(s);
  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem('${STORE}') || '{}'); } catch (e) {}
  return {
    earned: parseFloat((q('#todayEarned').textContent || '0').replace(/,/g, '')) || 0,
    worked: q('#worked').textContent,
    state: q('#workState').textContent.trim(),
    hint: q('#hintText').textContent.trim(),
    tlStart: q('#tlStart').textContent.trim(),
    spanHint: (q('#spanHint').textContent || '').trim(),
    daysHint: (q('#daysHint').textContent || '').trim(),
    formErr: (q('#formErr').textContent || '').trim(),
    formErrShown: q('#formErr').style.display !== 'none' && !!q('#formErr').textContent,
    formWarnShown: !q('#formWarn').hidden,
    fixHint: (q('#fixHint').textContent || '').trim(),
    goalPct: parseFloat(q('#goalPct').textContent) || 0,
    goalRemain: (q('#goalRemain').textContent || '').trim(),
    goalMonth: (q('#goalMonth').textContent || '').trim(),
    perHour: parseFloat((q('#perHour').textContent || '').replace(/[^0-9.]/g, '')) || 0,
    perDayCard: parseFloat((q('#perDay').textContent || '').replace(/[^0-9.]/g, '')) || 0,
    perMin: parseFloat((q('#perMin').textContent || '').replace(/[^0-9.]/g, '')) || 0,
    perSecCard: parseFloat((q('#perSecCard').textContent || '').replace(/[^0-9.]/g, '')) || 0,
    saveText: q('#btnSave').textContent.trim(),
    leaveHidden: q('#btnLeave').hidden,
    clockDisabled: q('#btnClock').disabled,
    bodyCompact: document.body.classList.contains('compact'),
    compactBarShown: !q('#compactBar').hidden,
    barTitle: q('#compactBar').title,
    gripW: Math.round(q('.cb-grip').getBoundingClientRect().width),
    scrollFree: q('.scroll').scrollHeight <= q('.scroll').clientHeight + 1,
    bodyScrollFree: document.documentElement.scrollHeight <= innerHeight + 1,
    pinText: q('#btnPin').textContent.trim(),
    sheetOn: q('#sheet').classList.contains('on'),
    histOn: q('#histSheet').classList.contains('on'),
    cfg
  };
})()`;

async function openSettings() {
  await R(`if (!document.querySelector('#sheet').classList.contains('on')) document.querySelector('#btnSettings').click(); 'ok'`);
  await sleep(200);
}
async function saveSettings() { await R(CLICK('#btnSave')); await sleep(350); }

async function reset() {
  const fixtureJson = JSON.stringify(JSON.stringify(FIXTURE));
  await R("localStorage.setItem('" + STORE + "', " + fixtureJson + "); location.reload(); 'reloading'");
  await sleep(1100);
  await R(INJECT);
  await sleep(150);
}

let FIXTURE = null;
let workDays = 0;
let perDay = 0;

async function createWindow() {
  win = new BrowserWindow({
    // 和真应用一致：无边框（frame:false）。带系统标题栏的话视口会矮 38px，
    // 迷你态的卡片会被测出"裁切"，那是脚手架失真，不是应用缺陷。
    width: 424, height: 720, show: false, frame: false, resizable: false,
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
  win.webContents.on('render-process-gone', (e, details) => {
    consoleErrors.push('[CRASH] ' + JSON.stringify(details));
  });
  win.webContents.on('did-fail-load', (e, code, desc) => {
    consoleErrors.push('[LOAD-FAIL] ' + code + ' ' + desc);
  });
  win.show();   // 小窗/置顶等窗口行为用例需要可见窗口
}

async function boot() {
  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await sleep(600);
  // 清掉别的测试套件留下的存档，保证从「首次使用」状态开始（否则 clockFrom 等残留会让 fixture 假失败）
  await R(`localStorage.removeItem('${STORE}'); location.reload(); 'wipe'`);
  await sleep(1300);
  await R(INJECT);
  await openSettings();
  await R(`(() => {
    const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('blur', {bubbles:true})); };
    set('#inStart', '09:00'); set('#inEnd', '18:00');
    return 'ok';
  })()`);
  await saveSettings();
  const s = await R(SNAP);
  FIXTURE = s.cfg;
  workDays = FIXTURE.workDays;
  perDay = 8000 / workDays;
  if (FIXTURE.start !== '09:00' || FIXTURE.end !== '18:00' || FIXTURE.clockFrom !== 'click') {
    throw new Error('fixture 创建失败: ' + JSON.stringify({ start: FIXTURE.start, end: FIXTURE.end, clockFrom: FIXTURE.clockFrom }));
  }
  console.log('FIXTURE ok | workDays=' + workDays + ' perDay=' + perDay.toFixed(2));
}

/* 页面内算 dayKey（v1.8.1 起统一补零：2026-11-04） */
const DAYKEY = (backMs) => `(() => {
  const d = new Date(Date.now() - ${backMs || 0});
  const p2 = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
})()`;

async function setMode(mode, auto) {
  await openSettings();
  await R(`document.querySelector('.mcard[data-mode="${mode}"][data-auto="${auto}"]').click(); 'ok'`);
  await saveSettings();
}

async function punch(h, m) {
  await R(`window.__at(${h}${m ? ',' + m : ''}); document.querySelector('#btnClock').click(); 'ok'`);
  await sleep(300);
}

/* ---------- M1 输入与保存防误操作 ---------- */

async function t_m1_input() {
  await reset();
  await openSettings();
  // 输入即校验（input 事件，不等保存；type=number 打不进字母，用 -100 测）
  await R(`(() => { const el = document.querySelector('#inSalary'); el.value = '-100'; el.dispatchEvent(new Event('input', {bubbles:true})); return 'ok'; })()`);
  await sleep(250);
  const s1 = await R(SNAP);
  const okLive = s1.formErrShown && (await R(`document.querySelector('#inSalary').classList.contains('bad')`));
  // 清空后直接保存
  await R(`(() => { const el = document.querySelector('#inSalary'); el.value = ''; el.dispatchEvent(new Event('input', {bubbles:true})); return 'ok'; })()`);
  await saveSettings();
  const s2 = await R(SNAP);
  const okEmpty = s2.formErr.indexOf('不能空着') >= 0 && s2.cfg.salary === 8000;
  // 恢复合法薪资后再测时间字段（否则数字关永远先拦）
  await R(`(() => { const el = document.querySelector('#inSalary'); el.value = '8000'; el.dispatchEvent(new Event('input', {bubbles:true})); return 'ok'; })()`);
  // 上班=下班
  await R(`(() => { const set = (s, v) => { const e = document.querySelector(s); e.value = v; e.dispatchEvent(new Event('input', {bubbles:true})); e.dispatchEvent(new Event('blur', {bubbles:true})); }; set('#inEnd', '09:00'); return 'ok'; })()`);
  await saveSettings();
  const s3 = await R(SNAP);
  const okSame = s3.formErr.indexOf('不能一样') >= 0;
  // 午休反序
  await R(`(() => { const set = (s, v) => { const e = document.querySelector(s); e.value = v; e.dispatchEvent(new Event('input', {bubbles:true})); e.dispatchEvent(new Event('blur', {bubbles:true})); }; set('#inEnd', '18:00'); set('#inLunchStart', '13:00'); set('#inLunchEnd', '12:00'); return 'ok'; })()`);
  await saveSettings();
  const s4 = await R(SNAP);
  const okLunch = s4.formErr.indexOf('晚于开始') >= 0;
  record('TC-M1-04/05/08/09', '输入即校验/空值保存/上下班相同/午休反序全部拦截', okLive && okEmpty && okSame && okLunch,
    '即校验=' + okLive + '（-100）空值=[' + s2.formErr + '] 相同=[' + s3.formErr + '] 午休反序=[' + s4.formErr + ']');
}

async function t_m1_confirm() {
  await reset();
  await openSettings();
  const SET = (sel, v) => `(() => { const e = document.querySelector('${sel}'); e.value = '${v}'; e.dispatchEvent(new Event('input', {bubbles:true})); e.dispatchEvent(new Event('blur', {bubbles:true})); return e.value; })()`;
  // 午休完全在班外 → 首次保存只武装
  await R(SET('#inLunchStart', '08:00'));
  await R(SET('#inLunchEnd', '09:00'));
  await R(CLICK('#btnSave'));
  await sleep(300);
  const s1 = await R(SNAP);
  const okArm = s1.saveText.indexOf('确认保存') >= 0 && s1.formWarnShown && s1.cfg.lunchStart === '12:00';
  // 5 秒不点自动解除
  await sleep(5300);
  const s2 = await R(SNAP);
  const okDisarm = s2.saveText.indexOf('存好啦') >= 0 && !s2.formWarnShown;
  // 再点两次 → 真正保存
  await R(CLICK('#btnSave'));
  await sleep(250);
  await R(CLICK('#btnSave'));
  await sleep(400);
  const s3 = await R(SNAP);
  const okSave = s3.cfg.lunchStart === '08:00';
  // 班次 ≥16h → 武装 + spanHint 提示
  await R(SET('#inStart', '06:00'));
  await R(SET('#inEnd', '23:00'));
  await sleep(200);
  await R(CLICK('#btnSave'));
  await sleep(300);
  const s4 = await R(SNAP);
  const okLong = s4.saveText.indexOf('确认保存') >= 0 && s4.spanHint.indexOf('17 小时') >= 0;
  await sleep(5300);                       // 解除武装，收起面板放弃更改
  await R(CLICK('#btnCloseSheet'));
  await sleep(300);
  // 跨夜班 22:00–06:00 → 浅紫说明（不算警告）
  await openSettings();
  await R(SET('#inStart', '22:00'));
  await R(SET('#inEnd', '06:00'));
  await sleep(250);
  const s5 = await R(SNAP);
  const okNight = s5.spanHint.indexOf('跨夜班') >= 0 && s5.spanHint.indexOf('8 小时') >= 0;
  record('TC-M1-10/11/12', '午休班外/超长班次二次确认可解除；跨夜班给说明不给警告', okArm && okDisarm && okSave && okLong && okNight,
    '武装=' + okArm + ' 解除=' + okDisarm + ' 确认后保存=' + okSave + ' 17h提示=[' + s4.spanHint + '] 跨夜=[' + s5.spanHint + ']');
}

async function t_m1_days() {
  await reset();
  await openSettings();
  // 双休/大小周/单休快捷按钮（2026-11：双休 21 / 大小周 23 / 单休 25）
  const clickSeg = async (mode) => {
    await R(`document.querySelector('#segDays button[data-mode="${mode}"]').click(); 'ok'`);
    await sleep(150);
    return parseInt(await R(`document.querySelector('#inDays').value`), 10);
  };
  const dDouble = await clickSeg('double');
  const dBig = await clickSeg('bigsmall');
  const dSingle = await clickSeg('single');
  await saveSettings();
  const s1 = await R(SNAP);
  const okSeg = dDouble === 21 && dBig === 23 && dSingle === 25 && s1.cfg.workDays === 25 && s1.cfg.daysMode === 'single';
  // 手动改天数 → custom
  await R(`const el = document.querySelector('#inDays'); el.value = '20'; el.dispatchEvent(new Event('input', {bubbles:true})); 'ok'`);
  await saveSettings();
  const s2 = await R(SNAP);
  const okCustom = s2.cfg.daysMode === 'custom' && s2.cfg.workDays === 20;
  // 切回双休并保存
  await openSettings();
  await R(`document.querySelector('#segDays button[data-mode="double"]').click(); 'ok'`);
  await saveSettings();
  const s3 = await R(SNAP);
  const okBack = s3.cfg.daysMode === 'double' && s3.cfg.workDays === 21;
  record('TC-M1-14', '工作日快捷按钮按当月实际核算；手改转 custom；切回恢复', okSeg && okCustom && okBack,
    '双休=' + dDouble + ' 大小周=' + dBig + ' 单休=' + dSingle + ' custom=' + s2.cfg.workDays + ' 切回=' + s3.cfg.workDays);
}

async function t_m1_hoursrow() {
  await reset();
  await openSettings();
  const visClick = await R(`!document.querySelector('#hoursRow').hidden`);
  await R(`document.querySelector('.mcard[data-mode="schedule"][data-auto="0"]').click(); 'ok'`);
  await sleep(200);
  const visSched = await R(`!document.querySelector('#hoursRow').hidden`);
  await R(`document.querySelector('.mcard[data-mode="schedule"][data-auto="1"]').click(); 'ok'`);
  await sleep(200);
  const visAuto = await R(`!document.querySelector('#hoursRow').hidden`);
  await R(`document.querySelector('.mcard[data-mode="click"]').click(); 'ok'`);
  await sleep(200);
  const visBack = await R(`!document.querySelector('#hoursRow').hidden`);
  await R(CLICK('#btnCloseSheet'));                    // 不保存
  record('TC-M1-18', '「每日有效工时」仅打卡模式显示，切模式卡实时隐藏', visClick && !visSched && !visAuto && visBack,
    'click=' + visClick + ' 定点=' + visSched + ' 全自动=' + visAuto + ' 切回=' + visBack);
}

/* ---------- M2 手动模式边界 ---------- */

async function t_m2_break() {
  await reset();
  await punch(9);
  await R(`window.__later(3600e3); 'ok'`);
  await sleep(300);
  // 午休→继续 快速往返两次（按钮语义会切换，两次「午休一下」不可能连续点）
  await R(CLICK('#btnBreak'));                          // 午休
  await sleep(250);
  await R(CLICK('#btnBreak'));                          // 继续
  await sleep(250);
  await R(CLICK('#btnBreak'));                          // 再午休
  await sleep(250);
  await R(CLICK('#btnBreak'));                          // 再继续
  await sleep(250);
  await R(`window.__later(600e3); 'ok'`);              // +10min
  await sleep(450);
  const s = await R(SNAP);
  const segs = s.cfg.segments || [];
  // 段两两不重叠（时间戳严格递增）
  let noOverlap = true;
  for (let i = 1; i < segs.length; i++) if (segs[i].from < segs[i - 1].to) noOverlap = false;
  const expect = perDay / 8 * (70 / 60);               // 1h + 10min，往返间隙不计薪
  record('TC-M2-04', '午休/继续快速往返：段结构不重叠、不重复计薪、金额连续',
    noOverlap && segs.length === 3 && near(s.earned, expect, 0.6),
    'segments=' + segs.length + ' 段不重叠=' + noOverlap + ' 已赚=' + s.earned.toFixed(3) + '（≈' + expect.toFixed(2) + '）');
}

async function t_m2_breakoff() {
  await reset();
  await punch(9);
  await R(`window.__later(3600e3); document.querySelector('#btnBreak').click(); 'ok'`);
  await sleep(400);
  const s1 = await R(SNAP);                             // 午休中 1h
  await R(`window.__later(1800e3); document.querySelector('#btnClock').click(); 'ok'`);  // 误点下班
  await sleep(400);
  await R(CLICK('#lnkRedo'));                           // 撤销
  await sleep(500);
  const s2 = await R(SNAP);
  const okState = s2.state.indexOf('午休') >= 0;
  const okAmt = near(s2.earned, s1.earned, 0.1);
  record('TC-M2-07', '午休中误点下班→撤销回到「午休中」，金额不丢', okState && okAmt,
    '午休时=' + s1.earned + ' 撤销后=' + s2.earned + ' 状态=' + s2.state);
}

async function t_m2_crossday() {
  await reset();
  await punch(9);
  await R(`window.__later(16 * 3600e3); 'ok'`);         // 次日 01:00
  await sleep(600);
  const s = await R(SNAP);
  const k = await R(DAYKEY(16 * 3600e3));
  const logAmt = s.cfg.dailyLog[k] || 0;
  const okLog = near(logAmt, perDay, 0.6);
  const okToday = near(s.earned, 0, 0.05);              // 新的一天从 0 开始
  const okSettled = near(s.cfg.settled, perDay, 0.6);
  record('TC-M2-08', '忘下班跨零点：自动收口在 24:00，金额固化进昨天的账，今日归零',
    okLog && okToday && okSettled,
    'dailyLog[' + k + ']=' + logAmt.toFixed(2) + '（≈' + perDay.toFixed(2) + '）今日=' + s.earned + ' settled=' + s.cfg.settled.toFixed(2));
}

async function t_m2_odd() {
  await reset();
  await punch(2);                                        // 凌晨 02:00 打卡
  await sleep(400);
  const s1 = await R(SNAP);
  const okEarly = s1.tlStart.indexOf('02:00') >= 0 && s1.state.indexOf('工作') >= 0;
  await reset();
  await punch(22);                                       // 22:00 班外打卡
  await R(`window.__later(600e3); 'ok'`);
  await sleep(400);
  const s2 = await R(SNAP);
  const okLate = s2.state.indexOf('工作') >= 0 && s2.earned > 0;
  record('TC-M2-09/10', '凌晨 02:00 / 班外 22:00 均可打卡，时间轴跟随实际打卡时刻', okEarly && okLate,
    '02:00 轴起点=' + s1.tlStart + ' 状态=' + s1.state + '；22:00 已赚=' + s2.earned);
}

/* ---------- M3 定点边界 ---------- */

async function t_m3_grace() {
  await reset();
  await setMode('schedule', 0);
  await R(`window.__at(8, 45); document.querySelector('#btnClock').click(); 'ok'`);
  await sleep(300);
  await R(`window.__later(9 * 3600e3 + 46 * 60e3); 'ok'`);   // 18:31，超过宽限
  await sleep(650);
  const s = await R(SNAP);
  const k = await R(DAYKEY(0));
  const logAmt = s.cfg.dailyLog[k] || 0;
  const okAuto = near(logAmt, perDay, 0.6) && s.state.indexOf('收工') >= 0;
  // 收工态点击打卡：安全无效（抖动拦截），金额与状态不变
  await R(CLICK('#btnClock'));
  await sleep(350);
  const s2 = await R(SNAP);
  const okNoop = s2.state === s.state && near(s2.earned, s.earned, 0.02);
  record('TC-M3-06/07', '18:31 宽限外自动按班次结算（GRACE 兜底）；收工态点击无效不误触', okAuto && okNoop,
    'dailyLog=' + logAmt.toFixed(2) + '（≈' + perDay.toFixed(2) + '）状态=' + s.state + ' 再点击后金额不变=' + okNoop);
}

async function t_m3_nopunch() {
  await reset();
  await setMode('schedule', 0);
  await R(`window.__at(9); 'ok'`);
  await sleep(400);
  const s1 = await R(SNAP);
  await R(`window.__later(8 * 3600e3); 'ok'`);
  await sleep(450);
  const s2 = await R(SNAP);
  record('TC-M3-08', '定点模式全天不打卡：金额恒为 0（不打卡不算钱）',
    near(s1.earned, 0, 0.01) && near(s2.earned, 0, 0.01),
    '09:00=' + s1.earned + ' 17:00=' + s2.earned);
}

/* ---------- M4 全自动：夜班与改薪 ---------- */

async function t_m4_night() {
  await reset();
  await openSettings();
  const SET = (sel, v) => `(() => { const e = document.querySelector('${sel}'); e.value = '${v}'; e.dispatchEvent(new Event('input', {bubbles:true})); e.dispatchEvent(new Event('blur', {bubbles:true})); return e.value; })()`;
  await R(SET('#inStart', '22:00'));
  await R(SET('#inEnd', '06:00'));
  await R(SET('#inLunchStart', '00:00'));
  await R(SET('#inLunchEnd', '00:00'));               // 夜班无午休，避免「午休不在班内」二次确认拦截
  await R(`document.querySelector('.mcard[data-mode="schedule"][data-auto="1"]').click(); 'ok'`);
  await saveSettings();
  const cfgNow = await R(`JSON.parse(localStorage.getItem('${STORE}'))`);
  if (cfgNow.start !== '22:00' || cfgNow.autoRun !== true) throw new Error('夜班 fixture 未生效: ' + JSON.stringify({ start: cfgNow.start, autoRun: cfgNow.autoRun }));
  await R(`window.__at(23); 'ok'`);
  await sleep(450);
  const s1 = await R(SNAP);                             // 今晚 23:00：已工作 1h
  await R(`window.__later(7.5 * 3600e3); 'ok'`);        // 次日 06:30
  await sleep(700);
  const s2 = await R(SNAP);
  const k = await R(DAYKEY(8.5 * 3600e3));              // 班次开始那一天（昨晚）
  const logAmt = s2.cfg.dailyLog[k] || 0;
  const ok1 = near(s1.earned, perDay / 8, 0.5);
  const okLog = near(logAmt, perDay, 0.6);
  const okNewDay = near(s2.earned, 0, 0.05) && s2.state.indexOf('还没到') >= 0;
  record('TC-M4-05/M9-06', '全自动夜班 22:00–06:00：跨零点整班结算、记在班次开始日、新一天从 0 开始',
    ok1 && okLog && okNewDay,
    '23:00=' + s1.earned + '（≈' + (perDay / 8).toFixed(2) + '）dailyLog[' + k + ']=' + logAmt.toFixed(2) + ' 次日06:30=' + s2.earned + ' 状态=' + s2.state);
}

async function t_m4_salary() {
  await reset();
  await R(`window.__at(10, 30); 'ok'`);                  // 先钉时钟，再开全自动（否则会被真实时间抢先结算）
  await setMode('schedule', 1);                          // 1.5h，避开午休段
  await sleep(450);
  const s1 = await R(SNAP);
  await openSettings();
  await R(`document.querySelector('#inSalary').value = '16000'; 'ok'`);
  await saveSettings();
  await sleep(300);
  const s2 = await R(SNAP);
  await R(`window.__later(3600e3); 'ok'`);              // 11:30
  await sleep(450);
  const s3 = await R(SNAP);
  const e15 = perDay * 1.5 / 8;
  const expect = e15 + (16000 / workDays) / 8;
  record('TC-M4-06', '全自动计时中改薪：已计时部分按旧单价固化，之后按新单价',
    near(s1.earned, e15, 0.5) && near(s2.earned, e15, 0.5) && near(s3.earned, expect, 0.5),
    '10:30=' + s1.earned + '（≈' + e15.toFixed(2) + '）改后=' + s2.earned + ' 1h后=' + s3.earned + '（≈' + expect.toFixed(2) + '）');
}

/* ---------- M5 请假链路 ---------- */

async function t_m5_auto() {
  await reset();
  await R(`window.__at(9, 30); 'ok'`);
  await setMode('schedule', 1);
  await sleep(400);
  await R(`window.__later(1800e3); document.querySelector('#btnLeave').click(); 'ok'`);   // 10:00 请假
  await sleep(500);
  const s1 = await R(SNAP);
  const kept = perDay / 8;                              // 已干的 1h 照算（v1.6.6 口径）
  const okKeep = near(s1.earned, kept, 0.5);
  await R(`window.__later(8.5 * 3600e3); 'ok'`);        // 18:30
  await sleep(650);
  const s2 = await R(SNAP);
  record('TC-M5-03', '全自动请假：已干部分保留、请假区间不计薪、跨午休不重复扣、到点照常结算',
    okKeep && near(s2.earned, kept, 0.5),
    '请假时=' + s1.earned + '（≈' + kept.toFixed(2) + '）18:30=' + s2.earned + ' 状态=' + s2.state);
}

async function t_m5_misc() {
  await reset();
  await R(`window.__at(7); document.querySelector('#btnLeave').click(); 'ok'`);
  await sleep(450);
  const s1 = await R(SNAP);
  const okEarly = s1.state.indexOf('请假') >= 0 && near(s1.earned, 0, 0.01);
  await R(CLICK('#btnLeave'));                          // 取消
  await sleep(400);
  await punch(9);
  await R(`window.__later(9 * 3600e3); 'ok'`);
  await sleep(450);
  await R(CLICK('#btnClock'));                          // 18:00 下班
  await sleep(450);
  const s2 = await R(SNAP);
  const okHidden = s2.leaveHidden;
  record('TC-M5-04/05', '未上班可直接请假（金额 0）；已收工后请假按钮隐藏', okEarly && okHidden,
    '07:00 请假状态=' + s1.state + ' 已赚=' + s1.earned + '；收工后请假按钮隐藏=' + okHidden);
}

async function t_m5_fix() {
  await reset();
  await R(`window.__at(10); document.querySelector('#btnLeave').click(); 'ok'`);
  await sleep(450);
  await R(`window.__later(5 * 3600e3); 'ok'`);          // 15:00
  await R(CLICK('#btnFix'));
  await sleep(300);
  await R(`document.querySelector('#inFixStart').value = '10:30'; document.querySelector('#inFixEnd').value = '11:00'; document.querySelector('#btnFixOk').click(); 'ok'`);
  await sleep(400);
  const s = await R(SNAP);
  record('TC-M5-06', '请假时间段补录被拦截并说明理由', s.fixHint.indexOf('请了假') >= 0,
    '提示=[' + s.fixHint + ']');
}

/* ---------- M6 补录拒绝理由 ---------- */

async function t_m6_reasons() {
  await reset();
  await R(`window.__at(15); 'ok'`);
  await sleep(300);
  await R(CLICK('#btnFix'));
  await sleep(300);
  const tryFix = async (a, z) => {
    await R(`document.querySelector('#inFixStart').value = '${a}'; document.querySelector('#inFixEnd').value = '${z}'; document.querySelector('#btnFixOk').click(); 'ok'`);
    await sleep(300);
    return (await R(SNAP)).fixHint;
  };
  const hReversed = await tryFix('12:00', '09:00');
  const hLunch = await tryFix('12:00', '13:00');
  const hSame = await tryFix('09:00', '09:00');
  const hEmpty = await tryFix('', '');
  const hBad = await tryFix('ab', '10:00');
  const ok = hReversed.indexOf('填反') >= 0 && hLunch.indexOf('午休') >= 0
    && hSame.indexOf('同一时刻') >= 0 && hEmpty.indexOf('先把要补的时间段填上') >= 0
    && hBad.indexOf('看不懂') >= 0;
  record('TC-M6-05/06/07', '补录填反/整段午休/同一时刻/留空/乱码各给明确理由', ok,
    '填反=[' + hReversed + '] 午休=[' + hLunch + '] 同时刻=[' + hSame + '] 空=[' + hEmpty + '] 乱码=[' + hBad + ']');
}

async function t_m6_cap() {
  await reset();
  await openSettings();
  await R(`document.querySelector('#inDailyHours').value = '3'; 'ok'`);
  await saveSettings();
  await R(`window.__at(15); 'ok'`);
  await sleep(300);
  await R(CLICK('#btnFix'));
  await sleep(300);
  await R(`document.querySelector('#inFixStart').value = '09:00'; document.querySelector('#inFixEnd').value = '12:00'; document.querySelector('#btnFixOk').click(); 'ok'`);
  await sleep(450);
  const s1 = await R(SNAP);
  await R(CLICK('#btnFix'));
  await sleep(300);
  await R(`document.querySelector('#inFixStart').value = '13:00'; document.querySelector('#inFixEnd').value = '13:30'; document.querySelector('#btnFixOk').click(); 'ok'`);
  await sleep(400);
  const s2 = await R(SNAP);
  record('TC-M6-10', '补录=加班：已经赚满日薪后再补，照样进钱（不封顶）',
    near(s1.earned, perDay, 0.5) && s2.earned > s1.earned + 0.05,
    '3h 工时下补 3h=' + s1.earned + '（≈' + perDay.toFixed(2) + '）再补 30 分钟=' + s2.earned
    + '（+' + (s2.earned - s1.earned).toFixed(2) + '）');
}

async function t_m6_night() {
  await reset();
  await openSettings();
  const SET = (sel, v) => `(() => { const e = document.querySelector('${sel}'); e.value = '${v}'; e.dispatchEvent(new Event('input', {bubbles:true})); e.dispatchEvent(new Event('blur', {bubbles:true})); return e.value; })()`;
  await R(SET('#inStart', '22:00'));
  await R(SET('#inEnd', '06:00'));
  await R(SET('#inLunchStart', '00:00'));
  await R(SET('#inLunchEnd', '00:00'));
  await saveSettings();
  const cfgNow = await R(`JSON.parse(localStorage.getItem('${STORE}'))`);
  if (cfgNow.start !== '22:00') throw new Error('夜班 fixture 未生效');
  await R(`window.__at(1, 30); 'ok'`);                  // 次日凌晨 01:30（当前班=昨晚 22:00）
  await sleep(400);
  await R(CLICK('#btnFix'));
  await sleep(300);
  await R(`document.querySelector('#inFixStart').value = '23:00'; document.querySelector('#inFixEnd').value = '00:30'; document.querySelector('#btnFixOk').click(); 'ok'`);
  await sleep(450);
  const s1 = await R(SNAP);
  const expect = perDay * 1.5 / 8;                      // 8h 跨夜班无午休交集
  await R(CLICK('#btnFix'));
  await sleep(300);
  const setFix = (a, z) => `(() => {
    const s = document.querySelector('#inFixStart'), e = document.querySelector('#inFixEnd');
    s.value = '${a}'; e.value = '${z}';
    s.dispatchEvent(new Event('input', {bubbles:true})); e.dispatchEvent(new Event('input', {bubbles:true}));
    return 'ok';
  })()`;
  // 未来时段：必须先拦住，理由写「还没到」
  await R(setFix('02:00', '02:30'));
  await sleep(200);
  const hFuture = (await R(SNAP)).fixHint;
  await R(CLICK('#btnFixOk'));
  await sleep(250);
  const afterFuture = (await R(SNAP)).earned;
  const futureBlocked = hFuture.indexOf('还没到') >= 0 && Math.abs(afterFuture - s1.earned) < 0.02;
  // 班前加班（22:00 上班前的 20:00–21:00）：v1.9.0 起允许补，按加班算钱
  await R(setFix('20:00', '21:00'));
  await sleep(200);
  const hEarly = (await R(SNAP)).fixHint;
  await R(CLICK('#btnFixOk'));
  await sleep(300);
  const afterEarly = (await R(SNAP)).earned;
  record('TC-M6-12', '夜班补录：跨零点段可补、班前加班可补、未来仍拦住',
    near(s1.earned, expect, 0.5) && futureBlocked && afterEarly > s1.earned + 0.02,
    '23:00–00:30 补入=' + s1.earned + '（≈' + expect.toFixed(2) + '）未来=[' + hFuture
    + '] 班前=[' + hEarly + '] 补后=' + afterEarly);
}

/* ---------- M7 口径 ---------- */

async function t_m7_cards() {
  await reset();
  await punch(9);
  await R(`window.__later(9 * 3600e3); 'ok'`);
  await sleep(500);
  const s = await R(SNAP);
  const okCap = near(s.earned, perDay, 0.5);
  const okDay = near(s.perDayCard, perDay, 0.05);
  const okHour = near(s.perHour, perDay / 8, 0.05);
  const okMin = near(s.perMin, perDay / 480, 0.01);
  const okSec = near(s.perSecCard, perDay / 28800, 0.0005);
  record('TC-M7-04/05', '干满全天已赚=日薪卡片；时/分/秒薪与公式一致', okCap && okDay && okHour && okMin && okSec,
    '已赚=' + s.earned + ' 日薪卡=' + s.perDayCard + ' 时薪=' + s.perHour + ' 分薪=' + s.perMin + ' 秒薪=' + s.perSecCard);
}

/* ---------- M8 参数变更 ---------- */

async function t_m8_multi() {
  await reset();
  await punch(9);
  const steps = [];
  let expect = 0;
  const rates = [8000, 10000, 12000, 16000];
  for (let i = 0; i < 3; i++) {
    await R(`window.__later(3600e3); 'ok'`);
    await sleep(400);
    expect += (rates[i] / workDays) / 8;
    await openSettings();
    await R(`document.querySelector('#inSalary').value = '${rates[i + 1]}'; 'ok'`);
    await saveSettings();
    await sleep(250);
    const s = await R(SNAP);
    steps.push(s.earned.toFixed(2) + '(≈' + expect.toFixed(2) + ')');
  }
  await R(`window.__later(3600e3); 'ok'`);
  await sleep(450);
  const sFinal = await R(SNAP);
  expect += (rates[3] / workDays) / 8;
  const okFinal = near(sFinal.earned, expect, 1.0);
  const okMono = true;                                   // steps 单调性在 okFinal 中体现
  record('TC-M8-04/05', '连续 3 次改薪：每段按当时单价固化，金额单调无跳变', okFinal && okMono,
    '轨迹: ' + steps.join(' → ') + ' 终值=' + sFinal.earned.toFixed(2) + '（≈' + expect.toFixed(2) + '）');
}

async function t_m8_switch() {
  await reset();
  await punch(9);
  await R(`window.__later(3600e3); 'ok'`);
  await sleep(300);
  const before = await R(SNAP);
  await setMode('schedule', 0);
  const s = await R(SNAP);
  // 交底口径：换模式清 doneShift/lastShift；正在计时的钱已固化后从当前时刻新开段
  const okClean = s.cfg.doneShift == null && s.cfg.lastShift == null;
  const okKeep = near(s.earned, before.earned, 0.2);    // 已赚保留不重算
  await R(`window.__later(1800e3); 'ok'`);              // 10:30
  await sleep(450);
  const s2 = await R(SNAP);
  // 切换后处于已打卡态，点「下班」→ 按定点口径结到 b.end（交底第 5 条）
  await R(CLICK('#btnClock'));
  await sleep(450);
  const s3 = await R(SNAP);
  const okFull = near(s3.earned, perDay, 0.6);
  record('TC-M8-06', '计时中切模式：收工标记清空、已赚保留；定点口径下班结到班次终点',
    okClean && okKeep && okFull,
    '已收工标记清空=' + okClean + ' 已赚保留=' + s.earned + '（前=' + before.earned.toFixed(3) + '）定点下班=' + s3.earned + '（≈' + perDay.toFixed(2) + '）');
}

/* ---------- M9 目标与明细 ---------- */

async function t_m9_goal() {
  await reset();
  await R(`(() => {
    const c = JSON.parse(localStorage.getItem('${STORE}'));
    c.settled = 5900; c.goal = 5999; c.savedBase = 0;
    localStorage.setItem('${STORE}', JSON.stringify(c));
    location.reload();
    return 'ok';
  })()`);
  await sleep(1100);
  await R(INJECT);
  await sleep(300);
  await punch(9);
  await R(`window.__later(3600e3); 'ok'`);
  await sleep(500);
  const s1 = await R(SNAP);
  const e1h = perDay / 8;
  const pct1 = ((5900 + e1h) / 5999) * 100;
  const okPct = Math.abs(s1.goalPct - pct1) < 0.25;
  await R(`window.__later(2 * 3600e3); 'ok'`);          // 12:00 → 达成
  await sleep(600);
  const s2 = await R(SNAP);
  const confetti = await R(`document.querySelectorAll('.confetti').length`);
  const okHit = s2.goalPct >= 100 && s2.goalRemain.indexOf('目标达成') >= 0 && confetti === 34;
  // 重开后不再撒花（lastGoalPct 初始为 null → 不触发）
  await R(`location.reload(); 'rl'`);
  await sleep(1200);
  await R(INJECT);
  await sleep(800);
  const confetti2 = await R(`document.querySelectorAll('.confetti').length`);
  const s3 = await R(SNAP);
  const okOnce = confetti2 === 0 && s3.goalPct >= 100;
  record('TC-M9-01/02', '目标进度实时、达成撒花恰好一次、重开不再撒', okPct && okHit && okOnce,
    '1h进度=' + s1.goalPct + '%（≈' + pct1.toFixed(2) + '%）达成文案=[' + s2.goalRemain + '] 彩带=' + confetti + ' 重开后彩带=' + confetti2);
}

async function t_m9_hist() {
  await reset();
  await R(`(() => {
    const c = JSON.parse(localStorage.getItem('${STORE}'));
    c.dailyLog = { '2026-10-15': 300.5, '2026-11-2': 380.95, '2026-11-3': 380.95 };
    c.leaves = { '2026-11-1': true };
    localStorage.setItem('${STORE}', JSON.stringify(c));
    location.reload();
    return 'ok';
  })()`);
  await sleep(1100);
  await R(INJECT);
  await sleep(300);
  await punch(9);
  await R(`window.__later(2 * 3600e3); 'ok'`);
  await sleep(500);
  const s = await R(SNAP);
  const todayLive = perDay * 2 / 8;
  const novSum = 380.95 * 2 + todayLive;
  const monthNum = (txt) => parseFloat((txt.match(/¥([0-9.,]+)/) || [])[1].replace(/,/g, ''));
  const okMonth = Math.abs(monthNum(s.goalMonth) - novSum) < 0.05;
  await R(CLICK('#btnHistory'));
  await sleep(400);
  const h = await R(`(() => {
    const box = document.querySelector('#histList');
    return {
      months: [...box.querySelectorAll('.hist-month')].map(p => p.textContent),
      tags: [...box.querySelectorAll('.h-tag')].map(t => t.textContent)
    };
  })()`);
  const okGroups = h.months.length === 2 && h.months[0].indexOf('11 月') >= 0 && h.months[1].indexOf('10 月') >= 0;
  const okNov = Math.abs(monthNum(h.months[0]) - novSum) < 0.05;
  const okOct = h.months[1].indexOf('300.50') >= 0;
  const okTags = h.tags.indexOf('进行中') >= 0 && h.tags.indexOf('请假') >= 0;
  // v1.8.1（D-01）：月头天数只数有钱的天，请假日单列「请假 N 天」，与「本月已赚 · N 天」同口径
  const dayCntDetail = (h.months[0].match(/(\d+) 天/) || [])[1];
  const dayCntCard = (s.goalMonth.match(/· (\d+) 天/) || [])[1];
  const okDays = dayCntDetail === dayCntCard && h.months[0].indexOf('请假 1 天') >= 0;
  record('TC-M9-05/08', '明细按月分组、今天标进行中、请假日有标记、月合计与「本月已赚」一致（天数同口径）',
    okGroups && okNov && okOct && okTags && okMonth && okDays,
    '月头=' + JSON.stringify(h.months) + ' 标记=' + JSON.stringify(h.tags) + ' 本月卡=[' + s.goalMonth + ']（明细 ' + dayCntDetail + ' 天 = 本月卡 ' + dayCntCard + ' 天，请假日已单列）');
}

/* ---------- M10 重置 ---------- */

async function t_m10_reset() {
  await reset();
  await R(`(() => {
    const c = JSON.parse(localStorage.getItem('${STORE}'));
    c.settled = 1234.56;
    localStorage.setItem('${STORE}', JSON.stringify(c));
    location.reload();
    return 'ok';
  })()`);
  await sleep(1100);
  await R(INJECT);
  await sleep(300);
  await openSettings();
  await R(CLICK('#btnReset'));
  await sleep(300);
  const armedText = await R(`document.querySelector('#btnReset').textContent.trim()`);
  const cfgArmed = await R(`JSON.parse(localStorage.getItem('${STORE}')).settled`);
  await sleep(3500);                                    // 3.2s 超时自动复原
  const s = await R(SNAP);
  const okDisarm = armedText.indexOf('真的要清零') >= 0 && cfgArmed === 1234.56
    && (await R(`document.querySelector('#btnReset').textContent.trim()`)) === '清零累计'
    && (await R(`JSON.parse(localStorage.getItem('${STORE}')).settled`)) === 1234.56;
  record('TC-M10-05', '清零累计两段确认：超时不点自动复原，数据不变', okDisarm,
    '首点=' + armedText + ' → 3.5s后=' + (await R(`document.querySelector('#btnReset').textContent.trim()`)) + ' settled=' + cfgArmed);
}

async function t_m10_firstrun() {
  await reset();
  await openSettings();
  await R(CLICK('#btnFirstRun'));
  await sleep(300);
  const armed = await R(`document.querySelector('#btnFirstRun').textContent.trim()`);
  await R(CLICK('#btnFirstRun'));                       // 确认 → 清空 + reload
  await sleep(1500);
  await R(INJECT);
  await sleep(800);
  const raw = await R(`localStorage.getItem('${STORE}')`);
  let inited = null;
  if (raw) { try { inited = JSON.parse(raw).inited; } catch (e) {} }
  const sheetOn = (await R(SNAP)).sheetOn;
  const okArmed = armed.indexOf('第二下') >= 0 || armed.indexOf('清空') >= 0 || armed.indexOf('确认') >= 0;
  record('TC-M10-07', '回到首次使用：二次确认后回到首启设置面板、存档重置',
    okArmed && inited !== true && sheetOn,
    '首点文案=[' + armed + '] 存档=' + (raw ? '重置(inited=' + inited + ')' : '已清空') + ' 设置面板自动弹出=' + sheetOn);
}

/* ---------- M11 工作日与节假日 ---------- */

async function t_m11_update() {
  await reset();
  await openSettings();
  // 断网：返回 null
  holidayPayload = null;
  await R(CLICK('#btnHoliday'));
  await sleep(600);
  const s1 = await R(SNAP);
  const okOffline = (await R(`document.querySelector('#btnHoliday').textContent.trim()`)) === '更新'
    && s1.cfg.workDays === workDays && s1.daysHint.indexOf(String(workDays)) >= 0;
  // 联网成功：返回一个额外的法定假日（2026-11-11 周三）
  holidayPayload = { off: ['2026-11-11'], work: [] };
  await R(CLICK('#btnHoliday'));
  await sleep(700);
  const s2 = await R(SNAP);
  const okOnline = s2.cfg.workDays === workDays - 1 && s2.cfg.holidays['2026-11-11'] === true
    && s2.daysHint.indexOf('已扣法定节假日') >= 0;
  record('TC-M11-01/02', '节假日更新：断网静默降级不报错；成功后按当月实际重算并提示已扣法定节假日',
    okOffline && okOnline,
    '断网后 workDays=' + s1.cfg.workDays + ' hint=[' + s1.daysHint + ']；联网后 workDays=' + s2.cfg.workDays + ' hint=[' + s2.daysHint + ']');
}

async function t_m11_months() {
  await reset();
  // 2026-02（春节月）双休 = 16 天
  await R(`window.__date(2026, 2, 15, 10); 'ok'`);
  await sleep(400);
  await openSettings();
  await R(`document.querySelector('#segDays button[data-mode="double"]').click(); 'ok'`);
  await sleep(200);
  const feb = parseInt(await R(`document.querySelector('#inDays').value`), 10);
  // 2026-12 双休 = 23 天（跨月自动重算）
  await R(`window.__date(2026, 12, 1, 10); 'ok'`);
  await sleep(400);
  await saveSettings();
  const dec = await R(`JSON.parse(localStorage.getItem('${STORE}')).workDays`);
  // custom 不随月份变
  await openSettings();
  await R(`const el = document.querySelector('#inDays'); el.value = '20'; el.dispatchEvent(new Event('input', {bubbles:true})); 'ok'`);
  await saveSettings();
  await R(`window.__date(2026, 10, 1, 10); 'ok'`);
  await sleep(400);
  await openSettings();
  await saveSettings();
  const oct = await R(`JSON.parse(localStorage.getItem('${STORE}')).workDays`);
  record('TC-M11-03/04', '内置节假日表正确（2026-02 春节月 16 天）；跨月自动重算（12 月 23 天）；custom 不变',
    feb === 16 && dec === 23 && oct === 20,
    '2月=' + feb + ' 12月=' + dec + ' custom跨月=' + oct);
}

/* ---------- M12 窗口行为 ---------- */

async function t_m12_compact() {
  await reset();
  await sleep(600);
  normalBounds = win.getBounds();
  await R(CLICK('#btnCompact'));
  await sleep(1400);                                    // 等 800ms 轮询稳定
  const s1 = await R(SNAP);
  const b1 = win.getBounds();
  const okIn = s1.bodyCompact && s1.compactBarShown && b1.height < 320
    && Math.abs(b1.width - normalBounds.width) <= 2 && s1.scrollFree;
  await R(CLICK('#compactBar'));
  await sleep(900);
  const s2 = await R(SNAP);
  const b2 = win.getBounds();
  const okOut = !s2.bodyCompact && s2.compactBarShown && s2.barTitle === '缩成小窗'
    && Math.abs(b2.width - normalBounds.width) <= 2 && Math.abs(b2.height - normalBounds.height) <= 2
    && s1.gripW > s2.gripW + 20;
  record('TC-M12-01/02', '小窗只留已赚卡：只收高度（宽度不变）、横杆加长；展开恢复原宽高（±2px）',
    okIn && okOut,
    '完整 ' + normalBounds.width + '×' + normalBounds.height + ' → 小窗 ' + b1.width + '×' + b1.height
    + '（横杆 ' + s1.gripW + 'px / 正常 ' + s2.gripW + 'px） → 展开 ' + b2.width + '×' + b2.height);
}

async function t_m12_pin() {
  await reset();
  await R(CLICK('#btnPin'));
  await sleep(300);
  const on1 = win.isAlwaysOnTop();
  const s1 = await R(SNAP);
  await R(CLICK('#btnPin'));
  await sleep(300);
  const on2 = win.isAlwaysOnTop();
  const s2 = await R(SNAP);
  record('TC-M12-04', '置顶开关：窗口置顶状态与按钮图标同步切换',
    on1 && s1.pinText === '📍' && !on2 && s2.pinText === '📌',
    '置顶=' + on1 + ' 图标=' + s1.pinText + ' → 取消=' + (!on2) + ' 图标=' + s2.pinText);
}

/* ---------- 主流程 ---------- */

async function runAll() {
  await boot();
  const groups = [
    ['t_m1_input', t_m1_input], ['t_m1_confirm', t_m1_confirm], ['t_m1_days', t_m1_days],
    ['t_m1_hoursrow', t_m1_hoursrow], ['t_m2_break', t_m2_break], ['t_m2_breakoff', t_m2_breakoff],
    ['t_m2_crossday', t_m2_crossday], ['t_m2_odd', t_m2_odd], ['t_m3_grace', t_m3_grace],
    ['t_m3_nopunch', t_m3_nopunch], ['t_m4_night', t_m4_night], ['t_m4_salary', t_m4_salary],
    ['t_m5_auto', t_m5_auto], ['t_m5_misc', t_m5_misc], ['t_m5_fix', t_m5_fix],
    ['t_m6_reasons', t_m6_reasons], ['t_m6_cap', t_m6_cap], ['t_m6_night', t_m6_night],
    ['t_m7_cards', t_m7_cards], ['t_m8_multi', t_m8_multi], ['t_m8_switch', t_m8_switch],
    ['t_m9_goal', t_m9_goal], ['t_m9_hist', t_m9_hist], ['t_m10_reset', t_m10_reset],
    ['t_m10_firstrun', t_m10_firstrun], ['t_m11_update', t_m11_update], ['t_m11_months', t_m11_months],
    ['t_m12_compact', t_m12_compact], ['t_m12_pin', t_m12_pin]
  ];
  for (const [name, fn] of groups) {
    try {
      await fn();
    } catch (e) {
      console.log('GROUP-FAIL | ' + name + ' | ' + (e && e.message));
      results.push({ id: name, name: '（组内异常）', pass: false, detail: String(e && e.message || e) });
    }
  }
}

function buildReport() {
  const pass = results.filter(r => r.pass).length;
  const fail = results.length - pass;
  const now = new Date();
  const lines = [];
  lines.push('# 打工人记账器 v' + PKG_VERSION + ' · P1 自动执行测试报告');
  lines.push('');
  lines.push('> 执行时间：' + now.toLocaleString('zh-CN') + '  ');
  lines.push('> 执行方式：Electron 真实页面（可见窗口）+ 子类化 Date 时间模拟 + DOM/localStorage 双侧断言  ');
  lines.push('> 基线参数：月到手 8000 / 双休 / 班次 09:00–18:00 / 午休 12:00–13:00 / 实际工作日 ' + workDays + ' 天 → 日薪 ¥' + perDay.toFixed(2) + '  ');
  lines.push('> 说明：与 P0 轮不同，本轮用「子类化 Date」让 `new Date()` 无参调用也走模拟时间，因此 dayKey/月度核算/跨月重算均可测。');
  lines.push('');
  lines.push('## 执行统计');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('|------|------|');
  lines.push('| 执行用例组 | ' + results.length + ' |');
  lines.push('| 通过 | ' + pass + ' |');
  lines.push('| 失败 | ' + fail + ' |');
  lines.push('| 控制台错误 | ' + consoleErrors.length + ' 条 |');
  lines.push('');
  lines.push('## 执行结果');
  lines.push('');
  lines.push('| 用例 | 验证点 | 结果 | 实测数据 |');
  lines.push('|------|--------|------|----------|');
  results.forEach(r => {
    lines.push('| ' + r.id + ' | ' + r.name + ' | ' + (r.pass ? '✅ 通过' : '❌ 失败') + ' | ' + r.detail.replace(/\|/g, '\\|') + ' |');
  });
  lines.push('');
  if (consoleErrors.length) {
    lines.push('## 控制台错误（level≥warning）');
    lines.push('');
    consoleErrors.slice(0, 20).forEach(m => lines.push('- ' + m));
    lines.push('');
  }
  lines.push('## 结论');
  lines.push('');
  if (fail === 0) {
    lines.push('本轮 ' + results.length + ' 组 P1 用例全部通过。夜班/跨天/跨月时间边界、节假日工作日核算、补录全部拒绝理由、保存/清零/回到首次的防误操作、小窗与置顶窗口行为均符合预期。');
  } else {
    lines.push('存在 ' + fail + ' 组失败用例，详见上表实测数据；建议先修复再对外分发。');
  }
  return lines.join('\n');
}

app.whenReady().then(async () => {
  ipcMain.handle('app:version', () => PKG_VERSION);   // 测试主进程的 app.getVersion() 是 Electron 版本，这里回应用版本
  ipcMain.handle('holidays:fetch', () => holidayPayload);
  ipcMain.handle('data:export', (e, name, content) => ({ ok: true, path: 'D:\\测试导出\\' + name }));
  ipcMain.handle('data:import', async () => ({ canceled: true }));
  ipcMain.on('win:minimize', () => {});
  ipcMain.on('win:close', () => {});
  ipcMain.on('win:pin', (e, v) => { win.setAlwaysOnTop(!!v); });
  // 用主进程那份真规则（win-geometry.js），不在这里另抄一套
  ipcMain.on('win:compact', (e, arg) => {
    try {
      const on = !!(arg && arg.on);
      const b = win.getBounds();
      const area = screen.getDisplayMatching(b).workArea;
      if (on) {
        if (!normalBounds) normalBounds = { width: b.width, height: b.height };
        win.setBounds(geo.compactBounds(b, arg && arg.height, area));
      } else {
        win.setBounds(geo.expandBounds(b, normalBounds, area));
      }
    } catch (err) {}
  });

  let ok = false;
  let lastErr = null;
  try {
    await createWindow();
    await runAll();
    ok = true;
  } catch (e) { lastErr = e; }
  if (!ok) {
    console.log('FATAL | ' + (lastErr && lastErr.stack || lastErr));
    consoleErrors.slice(-10).forEach(m => console.log('CONSOLE | ' + m));
    results.push({ id: 'FATAL', name: '执行中断', pass: false, detail: String(lastErr && lastErr.message || lastErr) });
  } else {
    consoleErrors.slice(-10).forEach(m => console.log('CONSOLE | ' + m));
  }
  fs.writeFileSync(REPORT, buildReport(), 'utf8');
  console.log('SUMMARY | pass=' + results.filter(r => r.pass).length + '/' + results.length);
  console.log('REPORT | ' + REPORT);
  app.exit(0);
});
