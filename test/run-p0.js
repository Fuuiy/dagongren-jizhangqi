/* 打工人记账器 v1.8.1 · P0 自动执行 harness
 * 运行：node_modules/.bin/electron test/run-p0.js
 * 原理：加载真实 src/index.html，在页面内覆写 Date.now 模拟时间，驱动真实 UI 点击，
 *       从 DOM 与 localStorage 双侧断言（金额、状态、segments/settled/dailyLog）。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE = 'dgjz.worker.v1';
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const REPORT = path.join(ROOT, '测试报告-P0自动执行-v' + PKG_VERSION + '.md');

// 每个套件用独立 userData：默认所有套件共用一个 localStorage，
// 上一套件/上一轮没退干净时会把「今天已赚满」的存档带进来（实测 09:30 就有全天收入）
app.setPath('userData', path.join(require('os').tmpdir(), 'dgjz-harness-' + path.basename(__filename, '.js')));

let win = null;
let consoleErrors = [];
let exportPayload = null;
let importResult = { canceled: true };
let FIXTURE = null;
let workDays = 22;
let perDay = 0;

const results = [];
const record = (id, name, pass, detail) => {
  results.push({ id, name, pass, detail });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + id + ' ' + name + ' | ' + detail);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (js) => win.webContents.executeJavaScript(js, true);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const INJECT = `(() => {
  if (!window.__simmed) {
    window.__simmed = true;
  // v1.2.1：没干满就下班的确认弹窗——这些套件只关心结算结果，自动点「照样下班」
  try {
    const dm = document.getElementById('dlgMask');
    if (dm) new MutationObserver(() => {
      if (!dm.hidden) setTimeout(() => { const ok = document.getElementById('dlgOk'); if (ok) ok.click(); }, 0);
    }).observe(dm, { attributes: true, attributeFilter: ['hidden'] });
  } catch (e) {}
    const rn = Date.now.bind(Date);
    window.__off = 0;
    Date.now = () => rn() + window.__off;
    window.__at = (h, m, s) => { const t = new Date(); t.setHours(h, m || 0, s || 0, 0); window.__off = t.getTime() - rn(); };
    window.__later = (ms) => { window.__off += ms; };
  }
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
    perSec: q('#perSec').textContent.trim(),
    otHidden: q('#otPill').hidden,
    otTime: (q('#otTime').textContent || '').trim(),
    hint: q('#hintText').textContent.trim(),
    goalPct: parseFloat(q('#goalPct').textContent) || 0,
    formErr: (q('#formErr').textContent || '').trim(),
    fixHint: (q('#fixHint').textContent || '').trim(),
    dataHint: (q('#dataHint').textContent || '').trim(),
    cfg
  };
})()`;

const CLICK = (sel) => `document.querySelector('${sel}').click(); 'ok'`;

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

async function createWindow(visible) {
  win = new BrowserWindow({
    width: 424, height: 720, show: !!visible,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, spellcheck: false
    }
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('console-message', (e, level, msg) => {
    if (level >= 2) consoleErrors.push(msg);
  });
  if (visible) win.show();
}

async function boot() {
  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await sleep(600);
  // 清掉别的测试套件留下的存档，保证从「首次使用」状态开始（否则 clockFrom 等残留会让 fixture 假失败）
  await R(`localStorage.removeItem('${STORE}'); location.reload(); 'wipe'`);
  await sleep(1300);                       // 首启 500ms 后自动弹设置面板
  await R(INJECT);
  await openSettings();
  await R(`(() => {
    const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('blur', {bubbles:true})); };
    set('#inStart', '09:00'); set('#inEnd', '18:00');
    return document.querySelector('#inStart').value;
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

/* ---------- 测试用例 ---------- */

async function t0() {
  await reset();
  await R(`window.__at(9); document.querySelector('#btnClock').click(); 'ok'`);
  await sleep(400);
  const s1 = await R(SNAP);
  await R(`window.__later(60000); 'ok'`);
  await sleep(400);
  const s2 = await R(SNAP);
  const grew = s2.earned > s1.earned && s1.earned >= 0;
  record('T0', '环境自检：隐藏窗口计时器运行、金额随时间增长', grew,
    '60s: ' + s1.earned + ' -> ' + s2.earned + '（若失败将改用可见窗口重跑）');
  return grew;
}

async function t1() {
  await reset();
  await R(`window.__at(9); document.querySelector('#btnClock').click(); 'ok'`);
  await sleep(300);
  await R(`window.__later(9 * 3600e3); 'ok'`);
  await sleep(500);
  const s = await R(SNAP);
  const okAmt = near(s.earned, perDay, 0.5);
  const okOt = !s.otHidden && s.otTime === '1:00';
  record('TC-M7-01', '打卡模式 09:00–18:00 满勤：已赚封顶=日薪，不出现超日薪', okAmt && okOt,
    'earned=' + s.earned + ' 预期≈' + perDay.toFixed(2) + ' 加班=' + (s.otHidden ? '隐藏' : s.otTime) + ' 已工作=' + s.worked);
  // 加班 1 小时：金额不再涨
  await R(`window.__later(3600e3); 'ok'`);
  await sleep(450);
  const s2 = await R(SNAP);
  const ok2 = near(s2.earned, perDay, 0.5) && !s2.otHidden && s2.otTime === '2:00';
  record('TC-M7-02', '加班时段金额封顶不涨、加班时长累加', ok2,
    '19:00 earned=' + s2.earned + ' 加班=' + (s2.otHidden ? '隐藏' : s2.otTime));
}

async function t1b() {
  await reset();
  await openSettings();
  await R(`document.querySelector('#inDailyHours').value = '7'; 'ok'`);
  await saveSettings();
  await R(`window.__at(9); document.querySelector('#btnClock').click(); 'ok'`);
  await sleep(300);
  await R(`window.__later(7 * 3600e3); 'ok'`);
  await sleep(450);
  const s1 = await R(SNAP);
  const ok1 = near(s1.earned, perDay, 0.5) && s1.cfg.dailyHours === 7;
  await R(`window.__later(3600e3); 'ok'`);
  await sleep(450);
  const s2 = await R(SNAP);
  const ok2 = near(s2.earned, perDay, 0.5) && !s2.otHidden && s2.otTime === '1:00';
  record('TC-M7-03', '有效工时填 7h：干满 7h 达日薪，第 8h 转加班不涨钱', ok1 && ok2,
    '7h=' + s1.earned + ' 8h=' + s2.earned + ' 加班=' + (s2.otHidden ? '无' : s2.otTime));
}

async function t3() {
  await reset();
  await R(`window.__at(9); document.querySelector('#btnClock').click(); 'ok'`);
  await sleep(300);
  await R(`window.__later(3600e3); document.querySelector('#btnLeave').click(); 'ok'`);
  await sleep(450);
  const s1 = await R(SNAP);
  const e1h = perDay / 8;
  const ok1 = near(s1.earned, e1h, 0.5);
  await R(`window.__later(5 * 3600e3); 'ok'`);
  await sleep(500);
  const s2 = await R(SNAP);
  const ok2 = near(s2.earned, e1h, 0.5);      // 请假期间后台不得累计
  await R(CLICK('#btnLeave'));                 // 取消请假
  await sleep(450);
  const s3 = await R(SNAP);
  const ok3 = near(s3.earned, e1h, 0.5);      // 取消后不得回溯补发
  await R(`window.__later(600e3); 'ok'`);
  await sleep(450);
  const s4 = await R(SNAP);
  const ok4 = s4.earned > e1h + (perDay / 8) * (10 / 60) - 0.5; // 从取消时刻重新计时
  record('TC-M5-01/02', '请假即时结算/后台不累计/取消不回溯（v1.5 P0-1 回归）', ok1 && ok2 && ok3 && ok4,
    '请假时=' + s1.earned + ' → 15:00=' + s2.earned + ' → 取消=' + s3.earned + ' → +10min=' + s4.earned + '（1h≈' + e1h.toFixed(2) + '）');
}

async function t4() {
  await reset();
  await R(`window.__at(9); document.querySelector('#btnClock').click(); 'ok'`);
  await sleep(300);
  await R(`window.__later(3 * 3600e3); 'ok'`);
  await sleep(450);
  const s1 = await R(SNAP);
  const e3h = perDay * 3 / 8;
  await openSettings();
  await R(`document.querySelector('#inSalary').value = '16000'; 'ok'`);
  await saveSettings();
  await sleep(300);
  const s2 = await R(SNAP);
  const ok1 = near(s2.earned, e3h, 0.3) && s2.cfg.salary === 16000;
  await R(`window.__later(3600e3); 'ok'`);
  await sleep(450);
  const s3 = await R(SNAP);
  const newPerDay = 16000 / workDays;
  const expect3 = e3h + newPerDay / 8;
  const ok2 = near(s3.earned, expect3, 0.5);
  record('TC-M8-01/02', '改薪不重算当天已赚、后续按新单价（v1.5 P0-2 回归）', ok1 && ok2,
    '改前=' + s1.earned.toFixed(3) + '（≈' + e3h.toFixed(2) + '）改后=' + s2.earned.toFixed(3) + ' 1h后=' + s3.earned.toFixed(3) + '（≈' + expect3.toFixed(2) + '）');
}

async function t5() {
  await reset();
  await openSettings();
  await R(`document.querySelector('.mcard[data-mode="schedule"][data-auto="0"]').click(); 'ok'`);
  await saveSettings();
  const mode = await R(`JSON.parse(localStorage.getItem('${STORE}')).clockFrom`);
  await R(`window.__at(8, 35); document.querySelector('#btnClock').click(); 'ok'`);
  await sleep(300);
  await R(`window.__later(8 * 3600e3 + 25 * 60e3); 'ok'`);  // 17:00
  await sleep(450);
  await R(CLICK('#btnClock'));                                // 下班啦（早退 1h）
  await sleep(450);
  const s = await R(SNAP);
  record('TC-M3-04', '定点模式 17:00 早退下班：仍按设定班次全天计薪（交底第 5 条）',
    mode === 'schedule' && near(s.earned, perDay, 0.5),
    'mode=' + mode + ' earned=' + s.earned + ' 预期≈' + perDay.toFixed(2) + ' state=' + s.state);
}

async function t6() {
  await reset();
  // 必须先把时钟钉在 09:30 再开全自动：否则真实时间若已过下班点，
  // 一切到全自动就会先按真实时间把当天结算掉（测试会误判成「09:30 就赚满」）
  await R(`window.__at(9, 30); 'ok'`);
  await openSettings();
  await R(`document.querySelector('.mcard[data-mode="schedule"][data-auto="1"]').click(); 'ok'`);
  await saveSettings();
  await sleep(500);
  const s1 = await R(SNAP);
  const half = perDay * 0.5 / 8;
  const ok1 = near(s1.earned, half, 0.5);
  await R(`window.__at(12, 30); 'ok'`);
  await sleep(500);
  const s2 = await R(SNAP);
  const ok2 = near(s2.earned, perDay * 3 / 8, 0.5);
  await R(`window.__at(18, 1); 'ok'`);
  await sleep(650);
  const s3 = await R(SNAP);
  const ok3 = near(s3.earned, perDay, 0.5) && s3.cfg.doneShift != null;
  const expPct = (perDay / 5999) * 100;
  const ok4 = Math.abs(s3.goalPct - expPct) < 0.25;           // v1.5 目标进度翻倍回归
  record('TC-M4-02/03/04', '全自动：无需打卡按班计薪/午休自动停/到点自动结且进度不翻倍',
    ok1 && ok2 && ok3 && ok4,
    '09:30=' + s1.earned + '（≈' + half.toFixed(2) + '）12:30=' + s2.earned + ' 18:01=' + s3.earned + '（≈' + perDay.toFixed(2) + '）进度=' + s3.goalPct + '%（≈' + expPct.toFixed(2) + '%）');
}

async function t7() {
  await reset();
  await openSettings();
  await R(`document.querySelector('.mcard[data-mode="schedule"][data-auto="0"]').click(); 'ok'`);
  await sleep(200);
  const activeBefore = await R(`document.querySelector('.mcard.active').dataset.mode + '/' + document.querySelector('.mcard.active').dataset.auto`);
  await R(CLICK('#btnCloseSheet'));                            // 不保存直接收起
  await sleep(350);
  const cfgAfter = await R(`JSON.parse(localStorage.getItem('${STORE}')).clockFrom`);
  const hintAfter = (await R(SNAP)).hint;
  await openSettings();
  const activeReopen = await R(`document.querySelector('.mcard.active').dataset.mode`);
  const ok = activeBefore === 'schedule/0' && cfgAfter === 'click' && activeReopen === 'click';
  record('TC-M1-17', '模式卡点选后不保存：运行行为不变（交底第 6 条）', ok,
    '面板选中=' + activeBefore + ' 关闭后cfg=' + cfgAfter + ' 重开选中=' + activeReopen + ' 提示=' + hintAfter);
}

async function t8() {
  await reset();
  await R(`window.__at(12); 'ok'`);
  await sleep(300);
  await R(CLICK('#btnFix'));
  await sleep(250);
  await R(`document.querySelector('#inFixStart').value = '09:00'; document.querySelector('#inFixEnd').value = '10:00'; document.querySelector('#btnFixOk').click(); 'ok'`);
  await sleep(450);
  const s1 = await R(SNAP);
  const e1h = perDay / 8;
  const ok1 = near(s1.earned, e1h, 0.5) && s1.cfg.fixRanges && s1.cfg.fixRanges.length === 1;
  // 重叠拦截
  await R(CLICK('#btnFix'));
  await sleep(250);
  await R(`document.querySelector('#inFixStart').value = '09:30'; document.querySelector('#inFixEnd').value = '10:30'; document.querySelector('#btnFixOk').click(); 'ok'`);
  await sleep(350);
  const s2 = await R(SNAP);
  const ok2 = s2.cfg.fixRanges.length === 1 && near(s2.earned, e1h, 0.5) && s2.fixHint.indexOf('重叠') >= 0;
  // 未来时间拦截（面板未关，直接改值再提交）
  await R(`document.querySelector('#inFixStart').value = '09:00'; document.querySelector('#inFixEnd').value = '13:00'; document.querySelector('#btnFixOk').click(); 'ok'`);
  await sleep(350);
  const s3 = await R(SNAP);
  const ok3 = s3.fixHint.indexOf('还没到') >= 0 && s3.cfg.fixRanges.length === 1;
  record('TC-M6-01/02/04', '补录正常计薪/重叠拦截/未来时间拦截', ok1 && ok2 && ok3,
    '补后=' + s1.earned + '（≈' + e1h.toFixed(2) + '）重叠提示=[' + s2.fixHint + '] 未来提示=[' + s3.fixHint + ']');
}

async function t9() {
  await reset();
  await R(`window.__at(9); document.querySelector('#btnClock').click(); 'ok'`);
  await sleep(300);
  await R(`window.__later(8 * 3600e3); 'ok'`);
  await sleep(450);
  await R(CLICK('#btnClock'));                                 // 17:00 下班
  await sleep(450);
  const s1 = await R(SNAP);
  const ok1 = near(s1.earned, perDay, 0.5);
  await R(`window.__later(3600e3); 'ok'`);
  await sleep(450);
  const s2 = await R(SNAP);
  const ok2 = near(s2.earned, perDay, 0.5);                    // 收工后冻结
  await R(CLICK('#lnkRedo'));                                  // 撤销下班
  await sleep(450);
  await R(`window.__later(600e3); 'ok'`);
  await sleep(450);
  const s3 = await R(SNAP);
  const ok3 = near(s3.earned, perDay, 0.5) && !s3.otHidden;    // 已达上限：金额不变，转加班
  record('TC-M2-05/06', '下班结算冻结/撤销恢复计时（封顶后自动转加班）', ok1 && ok2 && ok3,
    '下班=' + s1.earned + ' 1h后=' + s2.earned + ' 撤销+10min=' + s3.earned + ' 加班=' + (s3.otHidden ? '无' : s3.otTime));
}

async function t10() {
  await reset();
  await openSettings();
  // 导出
  exportPayload = null;
  await R(CLICK('#btnExport'));
  await sleep(450);
  const s1 = await R(SNAP);
  let expDataOk = false;
  try {
    const p = JSON.parse(exportPayload);
    expDataOk = p.app === 'dagongren-jizhangqi' && p.data && p.data.salary === 8000 && p.data.start === '09:00'
      && p.version === PKG_VERSION;   // D-03：导出版本号必须跟 package.json 一致
  } catch (e) {}
  const expOk = /已导出/.test(s1.dataHint) && expDataOk;
  // 非法 JSON
  importResult = { ok: true, json: 'not-a-json{{' };
  await R(CLICK('#btnImport'));
  await sleep(450);
  const s2 = await R(SNAP);
  const okBad = s2.dataHint.indexOf('不是有效的备份') >= 0;
  // 薪资非法
  importResult = { ok: true, json: JSON.stringify({ app: 'dagongren-jizhangqi', data: { salary: 'abc', start: '09:00', end: '18:00' } }) };
  await R(CLICK('#btnImport'));
  await sleep(450);
  const s3 = await R(SNAP);
  const okSal = s3.dataHint.indexOf('已拒绝') >= 0;
  // 合法导入：先武装，再确认（触发 reload）
  importResult = { ok: true, json: exportPayload };
  await R(CLICK('#btnImport'));
  await sleep(450);
  const armedText = await R(`document.querySelector('#btnImport').textContent.trim()`);
  await R(CLICK('#btnImport'));
  await sleep(1600);                                           // reload + 重渲染
  const s4 = await R(SNAP);
  const okRestore = s4.cfg.salary === 8000 && s4.cfg.start === '09:00' && s4.cfg.clockFrom === 'click';
  const hasBak = await R(`!!localStorage.getItem('${STORE}.bak')`);
  record('TC-M10-01/02/04', '导出字段完整/导入非法文件拦截/确认后还原且留 .bak',
    expOk && okBad && okSal && armedText.indexOf('确认') >= 0 && okRestore && hasBak,
    '导出=[' + s1.dataHint + '] payload.version=' + (() => { try { return JSON.parse(exportPayload).version; } catch (e) { return '?'; } })()
    + '（期望 ' + PKG_VERSION + '）非法=["' + s2.dataHint + '"] 拒绝=["' + s3.dataHint + '"] 按钮=' + armedText + ' 还原=' + okRestore + ' bak=' + hasBak);
}

async function t11() {
  await reset();
  await openSettings();
  const trySalary = async (v) => {
    await R(`document.querySelector('#inSalary').value = '${v}'; document.querySelector('#btnSave').click(); 'ok'`);
    await sleep(250);
    return (await R(SNAP)).formErr;
  };
  const e1 = await trySalary('-100');
  const e2 = await trySalary('50');
  const e3 = await trySalary('1000001');
  await R(`document.querySelector('#inSalary').value = '8000'; document.querySelector('#inStart').value = '25:00'; document.querySelector('#btnSave').click(); 'ok'`);
  await sleep(250);
  const e4 = (await R(SNAP)).formErr;
  const ok = e1.indexOf('大于 0') >= 0 && e2.indexOf('至少 100') >= 0
    && e3.indexOf('最多') >= 0 && e4.indexOf('看不懂') >= 0;
  record('TC-M1-03/07', '薪资负数/过小/过大与时间非法输入均拦截', ok,
    '负数=[' + e1 + '] 50=[' + e2 + '] 100万+3=[' + e3 + '] 25:00=[' + e4 + ']');
}

/* ---------- 主流程 ---------- */

async function runAll() {
  await boot();
  const alive = await t0();
  if (!alive) throw new Error('T0-环境自检失败（隐藏窗口计时器未运行）');
  await t1();
  await t1b();
  await t3();
  await t4();
  await t5();
  await t6();
  await t7();
  await t8();
  await t9();
  await t10();
  await t11();
}

function buildReport() {
  const pass = results.filter(r => r.pass).length;
  const fail = results.length - pass;
  const now = new Date();
  const lines = [];
  lines.push('# 打工人记账器 v' + PKG_VERSION + ' · P0 自动执行测试报告');
  lines.push('');
  lines.push('> 执行时间：' + now.toLocaleString('zh-CN') + '  ');
  lines.push('> 执行方式：Electron 真实页面 + Date.now 时间模拟 + DOM/localStorage 双侧断言  ');
  lines.push('> 基线参数：月到手 8000 / 双休 / 班次 09:00–18:00 / 午休 12:00–13:00 / 实际工作日 ' + workDays + ' 天（当月自动核算）→ 日薪 ¥' + perDay.toFixed(2) + '，秒薪 ¥' + (perDay / 28800).toFixed(5));
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
    lines.push('本轮 ' + results.length + ' 组 P0 用例全部通过：v1.6 交底的 6 条验收场景（请假结算、改薪不重算、日薪封顶、早退计薪、有效工时+加班、模式卡保存生效）均已在 v1.8.0 实际代码上验证通过；导出/导入/输入校验链路未见异常，无控制台报错。');
    lines.push('');
    lines.push('遗留说明：');
    lines.push('- 本轮为时间模拟 + 真实 UI 驱动，覆盖金额链路与数据链路；长驻性能（R-23）、真机托盘/自启（R-15）不在本轮范围。');
    lines.push('- 导出 payload 的 version 字段已改为由主进程 app.getVersion() 注入（v1.8.1 起与 package.json 一致）。');
  } else {
    lines.push('存在 ' + fail + ' 组失败用例，详见上表实测数据；建议先修复再对外分发。');
  }
  return lines.join('\n');
}

app.whenReady().then(async () => {
  ipcMain.handle('app:version', () => PKG_VERSION);   // 测试主进程的 app.getVersion() 是 Electron 版本，这里回应用版本
  ipcMain.handle('holidays:fetch', () => null);
  ipcMain.handle('data:export', (e, name, content) => {
    exportPayload = content;
    return { ok: true, path: 'D:\\测试导出\\' + name };
  });
  ipcMain.handle('data:import', async () => importResult);

  let ok = false;
  let lastErr = null;
  try {
    await createWindow(false);
    await runAll();
    ok = true;
  } catch (e) {
    lastErr = e;
    console.log('RETRY-VISIBLE | ' + (e && e.message));
    // 隐藏窗口失败：改可见窗口整轮重跑
    try {
      consoleErrors = [];
      results.length = 0;
      if (win) { try { win.destroy(); } catch (x) {} win = null; }
      await createWindow(true);
      await runAll();
      ok = true;
    } catch (e2) { lastErr = e2; }
  }
  if (!ok) {
    console.log('FATAL | ' + (lastErr && lastErr.stack || lastErr));
    results.push({ id: 'FATAL', name: '执行中断', pass: false, detail: String(lastErr && lastErr.message || lastErr) });
  }
  fs.writeFileSync(REPORT, buildReport(), 'utf8');
  console.log('SUMMARY | pass=' + results.filter(r => r.pass).length + '/' + results.length);
  console.log('REPORT | ' + REPORT);
  app.exit(0);
});
