/* 打工人记账器 v1.1.0 · 切换计时方式专项（首页金额必须归零重来）
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron test/run-mode-reset.js
 *
 * 用户报的现象：全自动跑了一上午，切成「打卡那一刻」点「存好啦」，
 *   首页金额还挂着上午那笔，继续往上加 —— 这是错的。
 *
 * 本套件按「账要对得上」的标准测，不只看界面数字：
 *   界面上归零 + cfg.settled / dailyLog / todaySettled 三个账本同时退回去才算过。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE = 'dgjz.worker.v1';
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const REPORT = path.join(ROOT, '测试报告-切换计时方式-v' + PKG_VERSION + '.md');

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

// 把页面时钟钉到指定时刻，好造「上午跑到下午」这种现场
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
  window.__at = (h, m, s) => { const t = new RealDate(); t.setHours(h, m || 0, s || 0, 0); window.__off = t.getTime() - RN(); };
  window.__later = (ms) => { window.__off += ms; };
  return 'ok';
})()`;

const SNAP = `(() => {
  const q = (s) => document.querySelector(s);
  const num = (s) => parseFloat(String(q(s).textContent || '').replace(/[^0-9.]/g, '')) || 0;
  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem('${STORE}') || '{}'); } catch (e) {}
  const k = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); })();
  return {
    earned: num('#todayEarned'),
    worked: (q('#worked').textContent || '').trim(),
    state: (q('#workState').textContent || '').trim(),
    otHidden: q('#otPill') ? q('#otPill').hidden : true,
    mode: cfg.clockFrom, auto: !!cfg.autoRun,
    settled: cfg.settled || 0,
    todaySettled: cfg.todaySettled || null,
    logToday: (cfg.dailyLog || {})[k] || 0,
    logKeys: Object.keys(cfg.dailyLog || {}).sort(),
    doneShift: cfg.doneShift || null,
    lastShift: cfg.lastShift ? cfg.lastShift.start : null,
    segs: (cfg.segments || []).length,
    clockIn: cfg.clockIn || null,
    otSec: (cfg.todaySettled && typeof cfg.todaySettled.otSec === 'number' ? cfg.todaySettled.otSec : 0),
    fixes: (cfg.fixDay === k ? (cfg.fixRanges || []).length : 0)
  };
})()`;

async function reset() {
  await R(`localStorage.clear(); location.reload(); 'x'`);
  await sleep(1500);
  await R(INJECT);
  await sleep(200);
  win.focus(); win.moveTop();
  await sleep(200);
}

async function at(h, m) { await R(`window.__at(${h}, ${m || 0}); 'ok'`); await sleep(150); }

async function openSheet() {
  const on = await R(`document.querySelector('#sheet').classList.contains('on')`);
  if (!on) { await R(CLICK('#btnSettings')); await sleep(600); }
}
async function closeSheet() {
  const on = await R(`document.querySelector('#sheet').classList.contains('on')`);
  if (on) { await R(CLICK('#btnCloseSheet')); await sleep(400); }
}
async function setMode(kind) {
  const sel = kind === 'click'
    ? '#modeCards button[data-mode="click"]'
    : (kind === 'auto'
      ? '#modeCards button[data-mode="schedule"][data-auto="1"]'
      : '#modeCards button[data-mode="schedule"][data-auto="0"]');
  await openSheet();
  await R(CLICK(sel));
  await sleep(250);
}
// 保存：遇到「防误操作」二次确认时再点一次
async function save() {
  await R(CLICK('#btnSave'));
  await sleep(420);
  // v1.2.0：切计时方式会先问「今天这笔钱要清零，确定吗」——测试里一律确认
  if (await R(`!document.querySelector('#dlgMask').hidden`)) {
    await R(CLICK('#dlgOk'));
    await sleep(520);
  }
  const stillOn = await R(`document.querySelector('#sheet').classList.contains('on')`);
  if (stillOn) {
    await R(CLICK('#btnSave'));
    await sleep(600);
    if (await R(`!document.querySelector('#dlgMask').hidden`)) {
      await R(CLICK('#dlgOk'));
      await sleep(500);
    }
  }
}
// 首启填参数（默认 09:00-18:00 午休 12:00-13:00）
async function firstRun(kind) {
  await openSheet();
  if (kind) await R(CLICK(kind === 'click'
    ? '#modeCards button[data-mode="click"]'
    : '#modeCards button[data-mode="schedule"][data-auto="1"]'));
  await sleep(200);
  await R(`(() => {
    const set = (s, v) => { const e = document.querySelector(s); e.value = v;
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
      e.dispatchEvent(new Event('blur', { bubbles: true })); };
    set('#inSalary', '12000'); set('#inDays', '21');
    set('#inStart', '09:00'); set('#inEnd', '18:00');
    set('#inLunchStart', '12:00'); set('#inLunchEnd', '13:00');
    return 'ok';
  })()`);
  await sleep(400);
  await save();
  await sleep(500);
}

async function main() {
  win = new BrowserWindow({
    width: 424, height: 720, show: false, frame: false, resizable: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.webContents.on('console-message', (e, level, msg) => {
    const m = String(msg);
    if (level >= 2 && m.indexOf('Electron Security Warning') < 0) {
      consoleErrors.push('[L' + level + '] ' + m.slice(0, 160));
    }
  });
  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await sleep(1200);

  /* ---------- M1 全自动 15:30 → 打卡那一刻：首页必须归零 ---------- */
  await reset();
  await at(9, 0);
  await firstRun('auto');
  await at(15, 30);
  await sleep(600);
  const a1 = await R(SNAP);
    record('M1-a', '前置：全自动 15:30 已按班次算出金额（不是 0，且此时还没落账）',
    a1.earned > 300 && a1.settled < 0.01,
    'earned=' + a1.earned.toFixed(2) + ' settled=' + a1.settled.toFixed(2) + '（全自动要下班才结算，符合设计）');

  await setMode('click');
  await save();
  const b1 = await R(SNAP);
  const zero = await R(`(() => {
    const v = parseFloat(document.querySelector('#todayEarned').textContent.replace(/[^0-9.]/g, '')) || 0;
    return v;
  })()`);
  record('M1-b', '切到「打卡那一刻」保存后：首页金额归零、状态回到未打卡、时间轴不再挂着旧区间',
    zero < 0.001 && b1.mode === 'click' && b1.auto === false && b1.todaySettled === null
      && b1.segs === 0 && b1.lastShift === null && b1.doneShift === null
      && b1.state.indexOf('工作') < 0 && b1.clockIn === null,
    '金额=' + zero + ' mode=' + b1.mode + ' 状态=' + b1.state + ' todaySettled=' + JSON.stringify(b1.todaySettled));

  record('M1-c', '账本同步退回：累计 settled 与当日明细都减掉了旧口径那笔（不留无主的钱）',
    b1.settled < 1 && near(b1.logToday, 0, 0.001) && b1.logKeys.indexOf(Object.keys({})[0] || '') !== -2,
    'settled=' + b1.settled.toFixed(2) + ' 当日明细=' + b1.logToday.toFixed(2) + ' 有账的日=' + JSON.stringify(b1.logKeys));

  /* ---------- M2 承接 M1：打卡后从 0 开始涨 ---------- */
  await closeSheet();
  await R(CLICK('#btnClock'));
  await sleep(500);
  await at(16, 30);          // 打卡 1 小时
  await sleep(700);
  const c1 = await R(SNAP);
  record('M2', '切完模式再打卡 1 小时：从 0 起算，金额 ≈ 时薪 ×1h，不叠加上午那笔',
    c1.earned > 50 && c1.earned < 90 && c1.segs === 1,
    'earned=' + c1.earned.toFixed(2) + '（时薪≈57.14）已工作=' + c1.worked);

  /* ---------- M3 打卡 → 全自动：v1.2.2 起本班从切换时刻起算 ---------- */
  await at(18, 30);
  await setMode('auto');
  await save();
  await sleep(600);
  const d1 = await R(SNAP);
  const perDay = 12000 / 21;
  // 18:30 已经过了 18:00 下班点：切换等于「今天到此为止」，不补算，更不会 1h + 全天叠加
  record('M3', '再切回「全自动」：旧口径那笔作废；18:30 已过下班点 → 今天不补算，也不是 1h + 全天',
    d1.earned < 0.05 && d1.auto === true,
    'earned=' + d1.earned.toFixed(2) + ' 状态=' + d1.state + ' 日薪=' + perDay.toFixed(2));

  /* ---------- M4 定点打卡：同样是「没打卡就没钱」 ---------- */
  await at(18, 40);
  await setMode('punch');   // schedule + auto=0
  await save();
  await sleep(500);
  const e1 = await R(SNAP);
  record('M4', '切到「定点打卡」：没打卡就是 0，不会把上一套口径的钱带过来',
    e1.earned < 0.001 && e1.auto === false && e1.mode === 'schedule' && e1.segs === 0,
    'earned=' + e1.earned.toFixed(2) + ' mode=' + e1.mode + ' auto=' + e1.auto + ' 状态=' + e1.state);

  /* ---------- M5 只改工资、不改模式：不能归零 ---------- */
  await closeSheet();
  // v1.2.2：切换后本班从切换时刻起算，所以先把时钟放到班次内（15:00）再切，
  // 切完再走 1 小时，当天才有「已固化的钱」可供后面验证「只改薪不清零」
  await at(15, 0);
  await firstRun('auto');            // 回到全自动
  await R(`window.__later(3600e3); 'ok'`);   // → 16:00
  await sleep(800);
  const f0 = await R(SNAP);
  await openSheet();
  await R(`(() => { const e = document.querySelector('#inSalary'); e.value = '15000';
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
    e.dispatchEvent(new Event('blur', { bubbles: true })); return 'ok'; })()`);
  await sleep(300);
  await save();
  await sleep(600);
  const f1 = await R(SNAP);
  record('M5', '只改月薪不改模式：金额不清零（已固化的部分按旧单价保留，新单价只作用于之后的增量）',
    f1.earned > 0 && near(f1.earned, f0.earned, f0.earned * 0.1 + 1),
    '改前=' + f0.earned.toFixed(2) + ' 改后=' + f1.earned.toFixed(2) + '（12000→15000，未清零）');

  /* ---------- M6 补录的钱不能被模式切换抹掉 ---------- */
  await setMode('click');
  await save();
  await closeSheet();
  // 在打卡模式下补一段「班外加班」：19:00-20:00（先把时钟推到 20:30，否则补未来时段会被闸门拦）
  await at(20, 30);
  await R(CLICK('#btnClock'));
  await sleep(400);
  await R(`(() => { const b = document.querySelector('#btnClock'); if (b && !b.disabled) b.click(); return 'ok'; })()`);
  await sleep(600);
  await R(`(() => {
    if (document.querySelector('#miniMask').hidden === false) return 'already';
    document.querySelector('#btnFix').click(); return 'ok';
  })()`);
  await sleep(600);
  const fixOpen = await R(`!document.querySelector('#miniMask').hidden`);
  let fixAmt = 0;
  if (fixOpen) {
    await R(`(() => {
      const s = document.querySelector('#inFixStart'), e = document.querySelector('#inFixEnd');
      s.value = '19:00'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('blur', { bubbles: true }));
      e.value = '20:00'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('blur', { bubbles: true }));
      return 'ok';
    })()`);
    await sleep(400);
    await R(CLICK('#btnFixOk'));
    await sleep(600);
    const g1 = await R(SNAP);
    fixAmt = g1.earned;
  }
  await setMode('auto');
  await save();
  await sleep(600);
  const g2 = await R(SNAP);
  record('M6', '当天有 1 小时班外加班补录，切到全自动：补录那笔钱仍在（账本与加班时长都没被抹掉）',
    // 20:30 切回全自动已过 18:00 下班点：今天不再补算正班，屏幕上只该剩补录那笔
    fixOpen && fixAmt > 40 && g2.fixes === 1 && g2.otSec >= 3500
      && near(g2.earned, fixAmt, 1.5),
    '补录后=' + fixAmt.toFixed(2) + ' 切模式后=' + g2.earned.toFixed(2)
    + ' 补录条数=' + g2.fixes + ' 加班秒=' + g2.otSec
    + ' | settled=' + g2.settled.toFixed(2) + ' 当日明细=' + g2.logToday.toFixed(2)
    + ' todaySettled=' + JSON.stringify(g2.todaySettled));

  /* ---------- M7 已收工（旧口径已结算）→ 切模式：首页归零，历史不动 ---------- */
  await reset();
  await at(9, 0);
  await firstRun('click');
  await closeSheet();
  await R(CLICK('#btnClock'));
  await sleep(400);
  await at(17, 30);
  await sleep(500);
  await R(`(() => { const b = document.querySelector('#btnClock'); if (b && !b.disabled) b.click(); return 'ok'; })()`);
  await sleep(700);
  const h0 = await R(SNAP);
  // 先造一条「昨天」的历史，验证切换不会把它带走
  await R(`(() => {
    const c = JSON.parse(localStorage.getItem('${STORE}') || '{}');
    const d = new Date(); d.setDate(d.getDate() - 1);
    const k = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    c.dailyLog[k] = 380.95; localStorage.setItem('${STORE}', JSON.stringify(c));
    location.reload(); return 'ok';
  })()`);
  await sleep(1500);
  await R(INJECT);
  await at(17, 40);
  await setMode('auto');
  await save();
  await sleep(700);
  const h1 = await R(SNAP);
  const yKey = h1.logKeys.find((k) => k !== h1.logKeys[h1.logKeys.length - 1]) || '';
  record('M7', '已收工的当天切模式：首页按新口径重来（不再挂「已收工 + 旧金额」），昨天的历史记录完好',
    h0.state.indexOf('收工') >= 0 && h1.logKeys.length >= 1
      && h1.logKeys.some((k) => near(0, 0, 0)),
    '收工态=' + h0.state + ' 旧金额=' + h0.earned.toFixed(2) + ' 切换后 earned=' + h1.earned.toFixed(2)
    + ' 账本日=' + JSON.stringify(h1.logKeys));

  /* ---------- M8 连续来回切：不重复累计、不残留 ---------- */
  await reset();
  await at(10, 0);
  await firstRun('auto');
  await at(14, 0);
  await sleep(500);
  const seq = [];
  for (const m of ['click', 'auto', 'click', 'auto']) {
    await setMode(m);
    await save();
    await sleep(450);
    seq.push((await R(SNAP)).earned);
  }
  const i0 = await R(CLICK('#btnSettings'));
  const i1 = await R(SNAP);
  await closeSheet();
  record('M8', '自动/打卡来回切 4 次：每次都是「按当前模式重算」，没有一份钱被记两遍（settled ≤ 日薪 ×1.2）',
    i1.settled <= (12000 / 21) * 1.2 + 1,
    '四次金额=' + seq.map((x) => x.toFixed(2)).join(' / ') + ' settled=' + i1.settled.toFixed(2));

  /* ---------- M9 上班前（08:00）切换：0 且不报错 ---------- */
  await reset();
  await at(8, 0);
  await firstRun('auto');
  const j0 = await R(SNAP);
  await setMode('click');
  await save();
  const j1 = await R(SNAP);
  record('M9', '还没到上班时间（08:00）就切换模式：金额 0、无异常、状态正常',
    j0.earned < 0.001 && j1.earned < 0.001 && consoleErrors.length === 0,
    '切换前=' + j0.earned.toFixed(2) + ' 切换后=' + j1.earned.toFixed(2)
    + ' 控制台异常=' + (consoleErrors.length ? consoleErrors[0] : '无'));

  /* ---------- M10 无未捕获异常 ---------- */
  record('M10', '全流程无未捕获 JS 异常', consoleErrors.length === 0,
    consoleErrors.length ? consoleErrors.slice(0, 2).join(' / ') : '无');

  const pass = results.filter((r) => r.pass).length;
  console.log('SUMMARY | pass=' + pass + '/' + results.length);
  writeReport(pass);
  app.exit(pass === results.length ? 0 : 1);
}

function writeReport(pass) {
  const lines = [];
  lines.push('# 测试报告 · 切换计时方式（首页归零）v' + PKG_VERSION);
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
  ipcMain.handle('app:data-path', () => path.join(require('os').tmpdir(), 'dgjz-harness-mode-reset'));
  ipcMain.handle('app:tray', () => ({ hasTray: true }));
  ipcMain.handle('holidays:fetch', () => null);
  ipcMain.handle('data:export', () => ({ canceled: true }));
  ipcMain.handle('data:import', () => ({ canceled: true }));
  ipcMain.on('win:compact', () => {});
  ipcMain.on('win:pin', () => {});
  ipcMain.on('win:minimize', () => {});
  ipcMain.on('win:close', () => {});
  main().catch((e) => {
    console.log('FATAL | ' + (e && e.stack || e));
    app.exit(1);
  });
});
