/* 打工人记账器 v1.9.0 · 历史缺陷回归验证（D-01 ~ D-07）
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron test/run-defects.js
 * 1.8.0 轮发现的 7 个缺陷，逐条在 1.9.0 上复测：修复 → 转「已关闭」；复现 → 保持「打开」。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE = 'dgjz.worker.v1';
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const REPORT = path.join(ROOT, '测试报告-缺陷回归-v' + PKG_VERSION + '.md');

app.setPath('userData', path.join(require('os').tmpdir(), 'dgjz-harness-' + path.basename(__filename, '.js')));

let win = null;
let consoleErrors = [];
let exported = null;            // D-03：捕获导出 payload

const results = [];
const record = (id, name, pass, detail) => {
  results.push({ id, name, pass, detail: String(detail).replace(/\s*\n\s*/g, ' ') });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + id + ' ' + name + ' | ' + String(detail).replace(/\s*\n\s*/g, ' '));
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
    perDayCard: parseFloat((q('#perDay').textContent || '').replace(/[^0-9.]/g, '')) || 0,
    goalMonth: (q('#goalMonth').textContent || '').trim(),
    formErr: (q('#formErr').textContent || '').trim(),
    fixHint: (q('#fixHint').textContent || '').trim(),
    lunchNote: (q('#lunchNote').textContent || '').trim(),
    saveWarnHidden: q('#saveWarn') ? q('#saveWarn').hidden : null,
    saveWarnText: q('#saveWarn') ? q('#saveWarn').textContent.trim() : '',
    sheetOn: q('#sheet').classList.contains('on'),
    histOn: q('#histSheet').classList.contains('on'),
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

async function boot() {
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
  console.log('FIXTURE ok | workDays=' + (FIXTURE.workDays || 21) + ' perDay=' + perDay.toFixed(2));
}

async function reset(over) {
  const base = Object.assign({}, FIXTURE, {
    segments: [], clockIn: null, doneShift: null, lastShift: null,
    todaySettled: null, dailyLog: {}, leaves: {}, fixRanges: [], fixDay: '',
    settled: 0, savedBase: 0, holidays: {}, holidayCheckedAt: Date.now()
  }, over || {});
  const json = JSON.stringify(JSON.stringify(base));
  await R(`localStorage.setItem('${STORE}', ${json}); location.reload(); 'reloading'`);
  await sleep(1100);
  await R(INJECT);
  await sleep(150);
}

async function openSettings() {
  await R(`if (!document.querySelector('#sheet').classList.contains('on')) document.querySelector('#btnSettings').click(); 'ok'`);
  await sleep(200);
}

/* ---------- 缺陷回归用例 ---------- */

/* D-07【轻微】dayKey 不补零 → 同一天拆两行。修复：dayKey 补零 + 迁移合并旧键 */
async function d07() {
  await reset({ dailyLog: { '2026-11-4': 100 }, leaves: { '2026-11-1': true } });
  await punchToday();
  await R(`window.__at(11); document.querySelector('#btnClock').click(); 'ok'`);   // 11:00 下班结算
  await sleep(600);
  const s = await R(SNAP);
  const keys = Object.keys(s.cfg.dailyLog || {});
  const merged = keys.length === 1 && keys[0] === '2026-11-04'
    && near(s.cfg.dailyLog['2026-11-04'], 100 + perDay * 1 / 8, 0.5);
  await R(CLICK('#btnHistory'));
  await sleep(400);
  const rows = await R(`[...document.querySelectorAll('#histList .hist-row')].length`);
  record('D-07', 'dayKey 不补零：旧键「2026-11-4」迁移合并为「2026-11-04」', merged,
    '键=' + JSON.stringify(keys) + ' 金额=' + ((s.cfg.dailyLog[keys[0]] || 0).toFixed(2)) + '（≈' + (100 + perDay / 8).toFixed(2) + '）明细行数=' + rows + '（11-01 请假 1 行 + 11-04 金额 1 行）');
}
async function punchToday() {
  await R(`window.__at(10); document.querySelector('#btnClock').click(); 'ok'`);
  await sleep(400);
  await R(`window.__later(3600e3); 'ok'`);
  await sleep(300);
}
/* D-01【轻微】明细月头天数（含请假日）与「本月已赚」天数（计薪天）口径打架 */
async function d01() {
  await reset({
    dailyLog: { '2026-10-15': 300.5, '2026-11-2': 380.95, '2026-11-3': 380.95 },
    leaves: { '2026-11-1': true }
  });
  await punchToday();
  const s = await R(SNAP);
  const mm = (txt) => ({ sum: parseFloat((txt.match(/¥([0-9.,]+)/) || [])[1].replace(/,/g, '')) || 0, days: (txt.match(/(\d+) 天/) || [])[1] });
  const goal = mm(s.goalMonth);
  await R(CLICK('#btnHistory'));
  await sleep(400);
  const monthHeads = await R(`[...document.querySelectorAll('#histList .hist-month')].map(p => p.textContent)`);
  const nov = (monthHeads.find(t => t.indexOf('11 月') >= 0) || '');
  const det = mm(nov);
  record('D-01', '明细月头天数与「本月已赚」天数口径一致', goal.days === det.days && near(goal.sum, det.sum, 0.05),
    '本月卡=[¥' + goal.sum + ' · ' + goal.days + ' 天] 明细月头=[¥' + det.sum + ' · ' + det.days + ' 天]');
}

/* D-02【轻微】夜班凌晨补录未来时刻，提示「只能补本班」而非「还没到」 */
async function d02() {
  await reset({ start: '22:00', end: '06:00', lunchStart: '00:00', lunchEnd: '00:00' });
  await R(`window.__at(1, 30); 'ok'`);                    // 次日凌晨 01:30
  await sleep(300);
  await R(CLICK('#btnFix'));
  await sleep(300);
  await R(`document.querySelector('#inFixStart').value = '02:00'; document.querySelector('#inFixEnd').value = '02:30'; document.querySelector('#btnFixOk').click(); 'ok'`);
  await sleep(400);
  const s = await R(SNAP);
  record('D-02', '夜班凌晨补录未来时刻提示「还没到」（含当前时间）', s.fixHint.indexOf('还没到') >= 0,
    '提示=[' + s.fixHint + ']');
}

/* D-04【一般】夜班跨零点改薪：settleIfRunning 归属日用 dayKey(now) 跑到次日 */
async function d04() {
  await reset({ start: '22:00', end: '06:00', lunchStart: '00:00', lunchEnd: '00:00', mode: 'manual', clockFrom: 'click' });
  await R(`window.__at(23); 'ok'`);                      // 今晚 23:00 打卡
  await sleep(300);
  await R(CLICK('#btnClock'));
  await sleep(400);
  await R(`window.__later(2 * 3600e3); 'ok'`);           // 次日 01:00 改薪
  await sleep(300);
  await openSettings();
  await R(`(() => { const el = document.querySelector('#inSalary'); el.value = '16000'; el.dispatchEvent(new Event('input', {bubbles:true})); return 'ok'; })()`);
  await R(CLICK('#btnSave'));
  await sleep(500);
  const s = await R(SNAP);
  const k4 = '2026-11-04', k5 = '2026-11-05';
  const amt = s.cfg.dailyLog[k4] || 0;
  const ok = near(amt, perDay * 2 / 8, 0.5) && !s.cfg.dailyLog[k5];
  record('D-04', '夜班跨零点改薪：已计时部分记到班次开始日（11-04），不落到次日', ok,
    'dailyLog[2026-11-04]=' + amt.toFixed(2) + '（≈' + (perDay * 2 / 8).toFixed(2) + '） dailyLog[2026-11-05]=' + (s.cfg.dailyLog[k5] || '无'));
}

/* D-05【轻微】午休完全在班外：卡片显示总时长与「不会被扣除」矛盾 */
async function d05() {
  await reset();
  await openSettings();
  await R(`(() => { const set = (sel, v) => { const e = document.querySelector(sel); e.value = v; e.dispatchEvent(new Event('input', {bubbles:true})); e.dispatchEvent(new Event('blur', {bubbles:true})); }; set('#inLunchStart', '08:00'); set('#inLunchEnd', '09:00'); return 'ok'; })()`);
  await sleep(300);
  const s = await R(SNAP);
  record('D-05', '午休完全在班外：显示「无（不在班内）」而非总时长 1 小时', s.lunchNote === '无（不在班内）',
    'lunchNote=[' + s.lunchNote + ']');
}

/* D-06【一般】save() 静默吞 setItem 异常：界面生效、磁盘丢失、无提示 */
async function d06() {
  await reset();
  await R(`(() => {
    window.__origSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === '${STORE}') { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
      return window.__origSet.call(this, k, v);
    };
    return 'patched';
  })()`);
  await openSettings();
  await R(`(() => { const el = document.querySelector('#inSalary'); el.value = '12000'; el.dispatchEvent(new Event('input', {bubbles:true})); return 'ok'; })()`);
  await R(CLICK('#btnSave'));
  await sleep(500);
  const s1 = await R(SNAP);
  const warnShown = !s1.saveWarnHidden && s1.saveWarnText.length > 0;
  // 还原写入，等 5s 自动重试
  await R(`(() => { Storage.prototype.setItem = window.__origSet; return 'ok'; })()`);
  await sleep(5800);
  const s2 = await R(SNAP);
  const disk = s2.cfg.salary;
  record('D-06', '写失败有警告横幅 + 自动重试恢复', warnShown && s2.saveWarnHidden && disk === 12000,
    '警告显示=' + warnShown + ' 文案=[' + s1.saveWarnText.slice(0, 30) + '…] 重试后: 磁盘月薪=' + disk + '(需12000) 警告隐藏=' + s2.saveWarnHidden
    + ' 界面日薪卡=' + s2.perDayCard + ' 状态文本=[' + (s2.state || '').slice(0, 20) + ']');
}

/* D-03【轻微】导出 payload version 硬编码 1.7.0，与应用版本脱节 */
async function d03() {
  await reset();
  exported = null;
  await R(CLICK('#btnExport'));
  await sleep(600);
  const ok = exported && exported.version === PKG_VERSION && exported.app === 'dagongren-jizhangqi';
  record('D-03', '导出包 version 与应用版本一致（来自 package.json）', !!ok,
    '导出 version=' + (exported && exported.version) + ' 应用 version=' + PKG_VERSION);
}

async function runAll() {
  await boot();
  await d07();
  await d01();
  await d02();
  await d04();
  await d05();
  await d06();
  await d03();
}

app.whenReady().then(async () => {
  ipcMain.handle('holidays:fetch', () => null);
  ipcMain.handle('data:export', (e, name, content) => {
    try { exported = JSON.parse(content); } catch (err) { exported = null; }
    return { ok: true, path: 'test-mock' };
  });
  ipcMain.handle('data:import', () => ({ canceled: true }));
  ipcMain.handle('app:version', () => PKG_VERSION);
  ipcMain.on('win:pin', () => {}); ipcMain.on('win:compact', () => {});
  ipcMain.on('win:minimize', () => {}); ipcMain.on('win:close', () => {});
  await createWindow();
  let ok = true, lastErr = null;
  try { await runAll(); } catch (e) { ok = false; lastErr = e; console.log('FATAL | ' + (e && e.stack || e)); }
  const passed = results.filter((r) => r.pass).length;
  console.log('SUMMARY | ' + passed + '/' + results.length + ' | consoleErrors=' + consoleErrors.length);
  if (consoleErrors.length) consoleErrors.slice(-5).forEach((m) => console.log('CONSOLE | ' + m));
  const now = new Date();
  const md = [];
  md.push('# 缺陷回归验证报告 · 打工人记账器 v' + PKG_VERSION + '\n');
  md.push('- 执行时间：' + now.toLocaleString('zh-CN'));
  md.push('- 执行方式：Electron 真实页面 + 时间模拟 + DOM/localStorage 双断言（test/run-defects.js）');
  md.push('- 目的：1.8.0 轮发现的 D-01 ~ D-07 在 v' + PKG_VERSION + ' 上逐条复测定级\n');
  md.push('## 结果\n');
  md.push('| 缺陷 | 原级别 | 验证项 | 结果 | 证据 |');
  md.push('|---|---|---|---|---|');
  const sev = { 'D-01': '轻微', 'D-02': '轻微', 'D-03': '轻微', 'D-04': '一般', 'D-05': '轻微', 'D-06': '一般', 'D-07': '轻微' };
  results.forEach((r) => {
    const id = r.id.split(' ')[0];
    md.push('| ' + id + ' | ' + (sev[id] || '') + ' | ' + r.name + ' | ' + (r.pass ? '✅ 已修复关闭' : '❌ 仍复现') + ' | ' + r.detail + ' |');
  });
  md.push('\n## 结论\n');
  const fixed = results.filter((r) => r.pass).length;
  md.push('- ' + fixed + '/' + results.length + ' 项验证通过；' + results.filter((r) => !r.pass).map((r) => r.id).join(', ') + (fixed === results.length ? ' 全部修复。' : ' 仍打开。'));
  fs.writeFileSync(REPORT, md.join('\n'), 'utf8');
  console.log('REPORT | ' + REPORT);
  app.exit(0);
});
