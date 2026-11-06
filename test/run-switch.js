/* 打工人记账器 v1.2.2 · 切换计时方式的金额语义
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron test/run-switch.js
 *
 * 用户诉求（第三次反馈）：
 *   「我切换了后，首页还是有显示价格」
 * 根因：
 *   切模式时旧钱确实被作废了，但切到全自动/定点后 autoSettle 立刻按 08:00 起
 *   把今天整天补算了一遍 —— 弹窗承诺「从 0 重新开始」，屏幕上却是 190 / 333 / 380。
 * 修法：
 *   记下切换时刻 timerFrom，本班计薪起点 = max(班次开始, 切换时刻)，
 *   过了下班点才切则当天直接不补算。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE = 'dgjz.worker.v1';
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
const CLICK = (sel) => `(() => { const e = document.querySelector('${sel}'); if (!e) return 'missing'; e.click(); return 'ok'; })()`;

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
  window.__at = (h, m, dayOffset) => {
    const t = new RealDate();
    t.setHours(h, m || 0, 0, 0);
    if (dayOffset) t.setDate(t.getDate() + dayOffset);
    window.__off = t.getTime() - RN();
  };
  window.__later = (ms) => { window.__off += ms; };
  return 'ok';
})()`;

const SNAP = `(() => {
  const q = (s) => document.querySelector(s);
  const n = (s) => parseFloat(String((q(s) || {}).textContent || '').replace(/[^0-9.]/g, '')) || 0;
  let c = {}; try { c = JSON.parse(localStorage.getItem('${STORE}') || '{}'); } catch (e) {}
  const log = {};
  Object.keys(c.dailyLog || {}).forEach((k) => { log[k] = c.dailyLog[k]; });
  return {
    earned: n('#todayEarned'),
    worked: ((q('#worked') || {}).textContent || '').trim(),
    state: ((q('#workState') || {}).textContent || '').trim(),
    btn: ((q('#btnClock .clock-text') || {}).textContent || '').trim(),
    dlgOn: !q('#dlgMask').hidden,
    dlgText: ((q('#dlgText') || {}).textContent || '').trim(),
    mode: c.clockFrom,
    auto: !!c.autoRun,
    settled: c.settled || 0,
    todaySettled: c.todaySettled ? c.todaySettled.amount : null,
    lastSeconds: c.lastShift ? c.lastShift.seconds : null,
    timerFrom: c.timerFrom || null,
    log: log,
    segs: (c.segments || []).length
  };
})()`;

const BASE = {
  inited: true, confirmedByUser: true, salary: 8000, workDays: 21, daysMode: 'double',
  start: '08:00', end: '17:00', lunchStart: '12:00', lunchEnd: '13:00',
  clockFrom: 'click', autoRun: false, segments: [], clockIn: null, doneShift: null,
  lastShift: null, todaySettled: null, dailyLog: {}, leaves: {}, fixDay: '', fixRanges: [],
  goalAmount: 5999, goalName: '买台新手机', goalEmoji: '📱', savedBase: 0, settled: 0,
  dailyHours: null, otRate: 1, closeToTray: true, timerFrom: null, timerFromKey: null
};

async function seed(patch) {
  await R(`localStorage.setItem('${STORE}', JSON.stringify(Object.assign(${JSON.stringify(BASE)}, ${JSON.stringify(patch || {})}))); location.reload(); 'ok'`);
  await sleep(1400);
  await R(INJECT);
  await sleep(250);
}
const at = async (h, m, d) => { await R(`window.__at(${h}, ${m || 0}, ${d || 0}); 'ok'`); await sleep(700); };
const openSheet = async () => { await R(CLICK('#btnSettings')); await sleep(650); };
const pickMode = async (mode, auto) => {
  await R(`document.querySelector('#modeCards button[data-mode="${mode}"][data-auto="${auto ? 1 : 0}"]').click(); 'ok'`);
  await sleep(320);
};
// 保存并（如果有确认弹窗）点确定；返回弹窗文案，供「文案与实际一致」校验
async function save() {
  await R(CLICK('#btnSave'));
  await sleep(520);
  let txt = '';
  const on = await R(`!document.querySelector('#dlgMask').hidden`);
  if (on) {
    txt = await R(`(document.querySelector('#dlgText')||{}).textContent`);
    await R(CLICK('#dlgOk'));
    await sleep(800);
  }
  const stillOn = await R(`document.querySelector('#sheet').classList.contains('on')`);
  if (stillOn) { await R(CLICK('#btnSave')); await sleep(700); }
  return txt;
}
const snap = () => R(SNAP);

app.whenReady().then(async () => {
  ipcMain.handle('app:version', () => '1.2.2');
  ipcMain.handle('holidays:fetch', () => null);
  ipcMain.handle('data:export', () => ({ canceled: true }));
  ipcMain.handle('data:import', () => ({ canceled: true }));
  ipcMain.handle('app:data-path', () => path.join(require('os').tmpdir(), 'dgjz-harness-switch'));
  ipcMain.handle('app:tray', () => ({ hasTray: true }));
  ['win:compact', 'win:pin', 'win:minimize', 'win:close', 'win:close-behavior', 'app:copy']
    .forEach((c) => ipcMain.on(c, () => {}));

  win = new BrowserWindow({
    width: 424, height: 720, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, spellcheck: false
    }
  });
  win.webContents.on('console-message', (e, level, message) => {
    if (level >= 3 && String(message).indexOf('Content Security Policy') < 0) consoleErrors.push(message);
  });
  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await sleep(1200);

  const perDay = 8000 / 21;              // 380.952
  const perHour = perDay / 8;            // 47.619

  try {
    /* ---------- S1 全自动 18:50 已收工 → 切打卡那一刻 ---------- */
    await seed({ clockFrom: 'schedule', autoRun: true });
    await at(18, 50);
    const a1 = await snap();
    await openSheet(); await pickMode('click', false);
    const aTxt = await save();
    await sleep(500);
    const a2 = await snap();
    record('S1', '全自动 18:50 已收工 → 切「打卡那一刻」：金额归零、账本清空、要自己打卡',
      near(a1.earned, perDay, 0.6) && a2.earned < 0.01
        && a2.segs === 0 && a2.state.indexOf('打卡') >= 0 && Math.abs(a2.settled) < 0.01
        && Object.keys(a2.log).length === 0,
      '切前=' + a1.earned.toFixed(2) + '（≈' + perDay.toFixed(2) + '）切后=' + a2.earned.toFixed(2)
        + ' 状态=' + a2.state + ' settled=' + a2.settled.toFixed(2) + ' 明细=' + JSON.stringify(a2.log));
    record('S2', '切模式弹窗里写的金额 = 切换前屏幕上那个数（不能报错数）',
      aTxt.indexOf(a1.earned.toFixed(2)) >= 0,
      '弹窗=' + aTxt.replace(/\s+/g, ' ').slice(0, 60) + ' | 切换前显示=' + a1.earned.toFixed(2));

    /* ---------- S3 全自动 18:50 → 切定点打卡 ---------- */
    await seed({ clockFrom: 'schedule', autoRun: true });
    await at(18, 50);
    await openSheet(); await pickMode('schedule', false);
    await save();
    await sleep(400);
    const c2 = await snap();
    record('S3', '全自动 18:50 → 切「定点打卡」：没打卡就是 0，不会把全天工资带过来',
      c2.earned < 0.01 && c2.auto === false && c2.segs === 0,
      '切后=' + c2.earned.toFixed(2) + ' 状态=' + c2.state + ' auto=' + c2.auto);

    /* ---------- S4 打卡干到 12:00 → 18:50 切全自动（过点了，不能补算整天） ---------- */
    await seed({});
    await at(9, 0);
    await R(CLICK('#btnClock')); await sleep(700);
    await at(12, 0);
    const d1 = await snap();
    await at(18, 50);
    await openSheet(); await pickMode('schedule', true);
    await save();
    await sleep(600);
    const d2 = await snap();
    await sleep(1300);
    const d3 = await snap();
    record('S4', '打卡 09:00→12:00，18:50 切全自动：归零且不补算（过点切换 = 今天到此为止）',
      near(d1.earned, perHour * 3, 0.6) && d2.earned < 0.05 && d3.earned < 0.05
        && d3.state.indexOf('过点') >= 0,
      '切前=' + d1.earned.toFixed(2) + '（≈' + (perHour * 3).toFixed(2) + '）切后=' + d2.earned.toFixed(2)
        + ' 1.3s后=' + d3.earned.toFixed(2) + ' 状态=' + d3.state);

    /* ---------- S5 班次内切换：从切换时刻起算，之后正常涨 ---------- */
    await seed({});
    await at(9, 0);
    await R(CLICK('#btnClock')); await sleep(700);
    await at(11, 0);
    await openSheet(); await pickMode('schedule', true);
    await save();
    await sleep(500);
    const e1 = await snap();
    await at(12, 30);
    const e2 = await snap();
    await at(14, 0);
    const e3 = await snap();
    record('S5', '11:00 班次内切全自动：从 11:00 起算（11-12 一小时、12-13 午休不涨、到 14:00 共 2 小时）',
      e1.earned < 0.05 && near(e2.earned, perHour * 1, 0.8) && near(e3.earned, perHour * 2, 0.8),
      '切换时=' + e1.earned.toFixed(2) + ' 12:30=' + e2.earned.toFixed(2) + '（≈' + perHour.toFixed(2) + '）'
        + ' 14:00=' + e3.earned.toFixed(2) + '（≈' + (perHour * 2).toFixed(2) + '）');
    record('S6', '切换时刻记在存档里（timerFrom），不是只活在内存里',
      typeof e1.timerFrom === 'number' && e1.timerFrom > 0, 'timerFrom=' + e1.timerFrom);

    /* ---------- S7 次日自动失效：第二天 10:00 仍从 08:00 算 ---------- */
    await at(10, 0, 1);
    await sleep(700);
    const f1 = await snap();
    record('S7', '次日自动失效：第二天 10:00 仍按 08:00–10:00 算 2 小时（切换不影响明天）',
      near(f1.earned, perHour * 2, 1.2),
      '次日10:00=' + f1.earned.toFixed(2) + '（≈' + (perHour * 2).toFixed(2) + '）状态=' + f1.state);

    /* ---------- S8 只改工资不改模式：当天已赚不动（只增不改） ---------- */
    await seed({ clockFrom: 'schedule', autoRun: true });
    await at(18, 50);
    const g1 = await snap();
    await openSheet();
    await R(`(() => { const e=document.querySelector('#inSalary'); e.value='12000';
      e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('blur',{bubbles:true})); return 'ok'; })()`);
    await sleep(320);
    await save();
    await sleep(500);
    const g2 = await snap();
    record('S8', '只改月薪不改模式：当天已收工的金额不清零、也不追溯重算（只增不改）',
      near(g1.earned, g2.earned, 0.02) && near(g2.earned, perDay, 0.6),
      '改前=' + g1.earned.toFixed(2) + ' 改后=' + g2.earned.toFixed(2) + '（8000→12000）');

    /* ---------- S9 改上下班时间：已收工的钱与实际工时必须对得上 ---------- */
    await seed({ clockFrom: 'schedule', autoRun: true });
    await at(18, 50);
    const h1 = await snap();
    await openSheet();
    await R(`(() => { const e=document.querySelector('#inStart'); e.value='09:00';
      e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('blur',{bubbles:true})); return 'ok'; })()`);
    await sleep(320);
    await save();
    await sleep(600);
    const h2 = await snap();
    // 钱按原来那 8 小时给，所以「已工作」也得是 08:00:00（曾经出现过 8h+7h=15h 的重复累加）
    record('S9', '改上班时间 08:00→09:00：已收工的金额与「已工作」对得上（不能出现 15:00:00）',
      near(h2.earned, h1.earned, 0.02) && h2.worked === '08:00:00',
      '改前=' + h1.earned.toFixed(2) + '/' + h1.worked + ' 改后=' + h2.earned.toFixed(2) + '/' + h2.worked);

    /* ---------- S10 连续来回切：金额不会越切越多 ---------- */
    await seed({ clockFrom: 'schedule', autoRun: true });
    await at(18, 50);
    const before = (await snap()).earned;
    for (let i = 0; i < 3; i++) {
      await openSheet(); await pickMode('click', false); await save(); await sleep(350);
      await openSheet(); await pickMode('schedule', true); await save(); await sleep(350);
    }
    const k1 = await snap();
    record('S10', '连续来回切 3 轮：不会越切越多（最终仍是 0，账本只有补录）',
      k1.earned < 0.05 && Math.abs(k1.settled) < 0.05,
      '切前=' + before.toFixed(2) + ' 切 6 次后=' + k1.earned.toFixed(2) + ' settled=' + k1.settled.toFixed(2)
        + ' 明细=' + JSON.stringify(k1.log));

    /* ---------- S11 全自动过点结算不往明细里塞 0 元行 ---------- */
    await seed({});
    await at(18, 50);
    await openSheet(); await pickMode('schedule', true); await save();
    await sleep(700);
    const m1 = await snap();
    const hasZero = Object.keys(m1.log || {}).some((k) => m1.log[k] > 0 && m1.log[k] < 0.005);
    record('S11', '过点切全自动：账本里不会多出一条 ¥0.00 的假记录',
      m1.earned < 0.05 && !hasZero,
      'earned=' + m1.earned.toFixed(2) + ' 明细=' + JSON.stringify(m1.log));

    record('S12', '全流程无未捕获 JS 异常', consoleErrors.length === 0,
      consoleErrors.length ? consoleErrors.slice(0, 2).join(' | ') : '无');
  } catch (e) {
    record('FATAL', '套件执行未抛异常', false, String(e && e.message || e));
  }

  const pass = results.filter((r) => r.pass).length;
  console.log('SUMMARY | pass=' + pass + '/' + results.length);
  app.exit(pass === results.length ? 0 : 1);
});
