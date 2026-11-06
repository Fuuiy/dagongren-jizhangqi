/* 打工人记账器 v1.2.3 · 补录（补班）逻辑专项
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron test/run-fix.js
 *
 * 起因（用户截图）：
 *   补录列表写着「09:00 – 18:00 · 1 小时 · +¥47.62」，三者对不上；
 *   而且再想补 17:00–18:00 会被判「和 09:00–18:00 重叠」——被自己那条记录挡住。
 * 根因：
 *   记录存的是「用户输入的整段」，但全自动/定点只对班外那截计薪。
 * 修法：
 *   记录里加 parts（真正计薪的时段），列表显示、重叠判定、写入全用它。
 *
 * 基准：8000 元 / 21 天 / 09:00–17:00 / 午休 12:00–13:00
 *   日薪 380.95，有效工时 7 小时，时薪 54.42
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
  window.__at = (h, m) => { const t = new RealDate(); t.setHours(h, m || 0, 0, 0); window.__off = t.getTime() - RN(); };
  window.__later = (ms) => { window.__off += ms; };
  return 'ok';
})()`;

const SNAP = `(() => {
  const q = (s) => document.querySelector(s);
  const n = (s) => parseFloat(String((q(s) || {}).textContent || '').replace(/[^0-9.]/g, '')) || 0;
  let c = {}; try { c = JSON.parse(localStorage.getItem('${STORE}') || '{}'); } catch (e) {}
  const hm = (ts) => { const d = new Date(ts); return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); };
  return {
    earned: n('#todayEarned'),
    hint: (q('#fixHint') || {}).textContent || '',
    hintWarn: !!(q('#fixHint') && q('#fixHint').classList.contains('warn')),
    listText: [...document.querySelectorAll('#fixItems .fix-item')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim()),
    count: (q('#fixCount') || {}).textContent || '',
    sum: (q('#fixSum') || {}).textContent || '',
    ranges: (c.fixRanges || []).map((f) => ({
      from: hm(f.from), to: hm(f.to),
      parts: (f.parts || []).map((p) => hm(p.from) + '-' + hm(p.to)),
      sec: f.sec, inSec: f.inSec, otSec: f.otSec,
      amount: f.amount || 0,
      spanMin: Math.round((f.to - f.from) / 60000)
    })),
    settled: c.settled || 0,
    log: c.dailyLog || {},
    fixCountN: (c.fixRanges || []).length
  };
})()`;

const BASE = {
  inited: true, confirmedByUser: true, salary: 8000, workDays: 21, daysMode: 'custom',
  start: '09:00', end: '17:00', lunchStart: '12:00', lunchEnd: '13:00',
  clockFrom: 'schedule', autoRun: true, segments: [], clockIn: null, doneShift: null,
  lastShift: null, todaySettled: null, dailyLog: {}, leaves: {}, fixDay: '', fixRanges: [],
  goalAmount: 5999, goalName: 'x', goalEmoji: '📱', savedBase: 0, settled: 0,
  dailyHours: null, otRate: 1, closeToTray: true, timerFrom: null, timerFromKey: null
};

const todayKey = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    + '-' + String(d.getDate()).padStart(2, '0');
};
const tsOf = (h, m) => {
  const d = new Date();
  d.setHours(h, m || 0, 0, 0);
  return d.getTime();
};

async function seed(patch) {
  await R(`localStorage.setItem('${STORE}', JSON.stringify(Object.assign(${JSON.stringify(BASE)}, ${JSON.stringify(patch || {})}))); location.reload(); 'ok'`);
  await sleep(1400);
  await R(INJECT);
  await sleep(200);
  await R(`window.__at(18, 30); 'ok'`);
  await sleep(650);
}
const openFix = async () => { await R(CLICK('#btnFix')); await sleep(600); };
const setFix = async (a, b) => {
  await R(`(() => {
    const s = (sel, v) => { const e = document.querySelector(sel); e.value = v;
      e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('blur', { bubbles: true })); };
    s('#inFixStart', '${a}'); s('#inFixEnd', '${b}'); return 'ok';
  })()`);
  await sleep(420);
};
const apply = async () => { await R(CLICK('#btnFixOk')); await sleep(650); };
const closeFix = async () => {
  await R(`(() => { const b = document.querySelector('#btnFixCancel'); if (b) b.click(); return 'ok'; })()`);
  await sleep(300);
};
const snap = () => R(SNAP);

// 时薪 54.42（380.95 / 7h）
const PER_HOUR = (8000 / 21) / 7;
const PER_DAY = 8000 / 21;

app.whenReady().then(async () => {
  ipcMain.handle('app:version', () => '1.2.3');
  ipcMain.handle('holidays:fetch', () => null);
  ipcMain.handle('data:export', () => ({ canceled: true }));
  ipcMain.handle('data:import', () => ({ canceled: true }));
  ipcMain.handle('app:data-path', () => path.join(require('os').tmpdir(), 'dgjz-harness-fix'));
  ipcMain.handle('app:tray', () => ({ hasTray: true }));
  ['win:compact', 'win:pin', 'win:minimize', 'win:close', 'win:close-behavior', 'app:copy']
    .forEach((c) => ipcMain.on(c, () => {}));

  win = new BrowserWindow({
    width: 424, height: 720, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  win.webContents.on('console-message', (e, level, msg) => {
    if (level >= 3 && String(msg).indexOf('Content Security Policy') < 0) consoleErrors.push(msg);
  });
  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await sleep(1200);

  try {
    /* ---------- F1/F2 全自动补「整段 09:00–18:00」：只入账班外 1 小时 ---------- */
    await seed();
    await openFix();
    await setFix('09:00', '18:00');
    const a1 = await snap();
    await apply();
    const a2 = await snap();
    const r1 = a2.ranges[0] || {};
    record('F1', '全自动补 09:00–18:00：记录只存真正入账的 17:00–18:00（不再写整段）',
      r1.parts && r1.parts.length === 1 && r1.parts[0] === '17:00-18:00'
        && r1.sec === 3600 && near(r1.amount, PER_HOUR, 0.6),
      'parts=' + JSON.stringify(r1.parts) + ' sec=' + r1.sec + ' 金额=' + (r1.amount || 0).toFixed(2)
        + '（≈' + PER_HOUR.toFixed(2) + '）');
    record('F2', '补录前的提示写明「只补 17:00–18:00 这一段」，不再是模糊的整段',
      a1.hint.indexOf('只补 17:00–18:00') >= 0 && !a1.hintWarn,
      '提示=' + a1.hint);
    await openFix();                       // 补完会关弹层，重新打开才看得到列表
    const a3 = await snap();
    record('F3', '列表显示的范围与时长对得上（17:00–18:00 / 1 小时），不再是 09:00–18:00 / 1 小时',
      a3.listText.length === 1 && a3.listText[0].indexOf('17:00–18:00') >= 0
        && a3.listText[0].indexOf('1 小时') >= 0 && a3.listText[0].indexOf('09:00') < 0,
      '列表=' + JSON.stringify(a3.listText));

    /* ---------- F4 补完之后还能补班前那小时（不被自己挡住） ---------- */
    await setFix('08:00', '09:00');
    const b1 = await snap();
    await apply();
    const b2 = await snap();
    record('F4', '补过 17:00–18:00 之后，再补 08:00–09:00 不判重叠（之前会被整段记录挡住）',
      !b1.hintWarn && near(b2.earned, PER_DAY + PER_HOUR * 2, 1.5),
      '提示=' + b1.hint + ' | 累计=' + b2.earned.toFixed(2)
        + '（≈' + (PER_DAY + PER_HOUR * 2).toFixed(2) + ' = 日薪 + 2 小时加班）');

    /* ---------- F5 同一段再补一次：判重叠，且只报撞上的那段 ---------- */
    await openFix();
    await setFix('17:00', '18:00');
    const c1 = await snap();
    record('F5', '同一段再补：判重叠，提示只写撞上的 17:00–18:00（不把班前那段也列出来）',
      c1.hintWarn && c1.hint.indexOf('17:00–18:00') >= 0 && c1.hint.indexOf('08:00') < 0,
      '提示=' + c1.hint);
    await closeFix();

    /* ---------- F6 班次内补录被拒（全自动已整段算过钱） ---------- */
    await openFix();
    await setFix('09:30', '10:30');
    const d1 = await snap();
    record('F6', '全自动上班次内补录：拒绝并说清「班次内不用补，要补就填班外」',
      d1.hintWarn && d1.hint.indexOf('班次内') >= 0 && d1.hint.indexOf('17:00') >= 0,
      '提示=' + d1.hint);
    await closeFix();

    /* ---------- F7 跨班前+班后：拆成两段，金额都算 ---------- */
    await seed();
    await openFix();
    await setFix('08:00', '18:00');
    const e1 = await snap();
    await apply();
    const e2 = await snap();
    const r2 = e2.ranges[0] || {};
    record('F7', '全自动补 08:00–18:00：拆成「班前+班后」两段，提示写明这 2 段',
      r2.parts && r2.parts.length === 2 && e1.hint.indexOf('这 2 段') >= 0
        && near(r2.amount, PER_HOUR * 2, 1.2),
      'parts=' + JSON.stringify(r2.parts) + ' 金额=' + (r2.amount || 0).toFixed(2)
        + '（≈' + (PER_HOUR * 2).toFixed(2) + '）提示=' + e1.hint.slice(0, 40));

    /* ---------- F8 打卡那一刻：整段都计薪，parts 就是整段 ---------- */
    await seed({ clockFrom: 'click', autoRun: false });
    await openFix();
    await setFix('09:00', '12:00');
    await apply();
    const f1 = await snap();
    const r3 = f1.ranges[0] || {};
    record('F8', '打卡那一刻补 09:00–12:00：整段计薪（不是只算班外），parts 就是整段',
      r3.parts && r3.parts.length === 1 && r3.parts[0] === '09:00-12:00'
        && r3.sec === 10800 && near(r3.amount, PER_HOUR * 3, 1.2),
      'parts=' + JSON.stringify(r3.parts) + ' sec=' + r3.sec + ' 金额=' + (r3.amount || 0).toFixed(2)
        + '（≈' + (PER_HOUR * 3).toFixed(2) + '）');

    /* ---------- F9 打卡那一刻跨班前班后：inSec/otSec 拆得对 ---------- */
    await seed({ clockFrom: 'click', autoRun: false });
    await openFix();
    await setFix('08:00', '18:00');
    await apply();
    const g1 = await snap();
    const r4 = g1.ranges[0] || {};
    // 08:00-18:00 = 10h，扣午休 1h = 9h 计薪；班内 7h（09-17 扣午休），班外 2h
    record('F9', '打卡那一刻补 08:00–18:00：班内 7h + 班外 2h，合计 9h 都算钱',
      r4.sec === 32400 && r4.inSec === 25200 && r4.otSec === 7200
        && near(r4.amount, PER_HOUR * 9, 2),
      'sec=' + r4.sec + ' 班内=' + r4.inSec + ' 班外=' + r4.otSec
        + ' 金额=' + (r4.amount || 0).toFixed(2) + '（≈' + (PER_HOUR * 9).toFixed(2) + '）');

    /* ---------- F10 老数据迁移：旧记录只有 from/to，重启后补出 parts ---------- */
    await seed({
      fixDay: todayKey(),
      fixRanges: [{
        from: tsOf(9, 0), to: tsOf(18, 0), sec: 3600, inSec: 0, otSec: 3600,
        amount: PER_HOUR, at: tsOf(18, 20)
      }],
      settled: PER_HOUR,
      todaySettled: { day: todayKey(), seconds: 0, amount: PER_HOUR, otSec: 3600 }
    });
    const h1 = await snap();
    const old1 = h1.ranges[0] || {};
    await openFix();
    const h2 = await snap();
    record('F10', '老记录（from=09:00 to=18:00 sec=1h）重启后自动补出 parts=17:00–18:00',
      old1.parts && old1.parts.length === 1 && old1.parts[0] === '17:00-18:00',
      'parts=' + JSON.stringify(old1.parts));
    record('F11', '老记录迁移后列表显示 17:00–18:00，不再自相矛盾',
      h2.listText.length === 1 && h2.listText[0].indexOf('17:00–18:00') >= 0
        && h2.listText[0].indexOf('1 小时') >= 0,
      '列表=' + JSON.stringify(h2.listText));
    await setFix('08:00', '09:00');
    const h3 = await snap();
    record('F12', '老记录迁移后，班前 08:00–09:00 不再被误判重叠',
      !h3.hintWarn && h3.hint.indexOf('08:00') >= 0,
      '提示=' + h3.hint);
    await closeFix();

    /* ---------- F13 删除补录：钱和账本一起退 ---------- */
    await seed();
    await openFix();
    await setFix('17:00', '18:00');
    await apply();
    const i1 = await snap();
    await openFix();
    // 删除按钮是「两下才真删」的防误删设计
    await R(CLICK('#fixItems .fi-del'));
    await sleep(400);
    await R(CLICK('#fixItems .fi-del'));
    await sleep(700);
    const i2 = await snap();
    record('F13', '删除补录：金额、当天账本、记录条数一起退回去（不是只删显示）',
      near(i1.earned, PER_DAY + PER_HOUR, 1.2) && near(i2.earned, PER_DAY, 1.2) && i2.fixCountN === 0
        && near(i2.settled, PER_DAY, 1.2),
      '删前=' + i1.earned.toFixed(2) + '（≈' + (PER_DAY + PER_HOUR).toFixed(2) + '）删后=' + i2.earned.toFixed(2)
        + ' settled=' + i2.settled.toFixed(2) + ' 条数=' + i2.fixCountN);
    await closeFix();

    /* ---------- F14 加班倍率只作用于班外 ---------- */
    await seed({ otRate: 2 });
    await openFix();
    await setFix('17:00', '18:00');
    await apply();
    const j1 = await snap();
    record('F14', '加班倍率 2 倍：班外 1 小时按 2 倍算（2×时薪）',
      near(j1.earned, PER_DAY + PER_HOUR * 2, 1.5),
      '金额=' + j1.earned.toFixed(2) + '（≈' + (PER_DAY + PER_HOUR * 2).toFixed(2)
        + ' = 日薪 + 2 倍时薪）');

    /* ---------- F15 补午休整段：直接说午休不算钱 ---------- */
    await seed({ clockFrom: 'click', autoRun: false });
    await openFix();
    await setFix('12:00', '13:00');
    const k1 = await snap();
    record('F15', '正好补午休那一小时：拒绝并说明「午休本来就不算钱」',
      k1.hintWarn && k1.hint.indexOf('午休') >= 0, '提示=' + k1.hint);
    await closeFix();

    /* ---------- F16 补未来时段：拒绝 ---------- */
    await openFix();
    await setFix('19:00', '20:00');
    const l1 = await snap();
    record('F16', '补还没到的时段：拒绝并给出当前时间', l1.hintWarn && l1.hint.indexOf('还没到') >= 0,
      '提示=' + l1.hint);
    await closeFix();

    record('F17', '全流程无未捕获 JS 异常', consoleErrors.length === 0,
      consoleErrors.length ? String(consoleErrors[0]).slice(0, 100) : '无');
  } catch (e) {
    record('FATAL', '套件执行未抛异常', false, String(e && e.message || e));
  }

  const pass = results.filter((r) => r.pass).length;
  console.log('SUMMARY | pass=' + pass + '/' + results.length);
  app.exit(pass === results.length ? 0 : 1);
});
