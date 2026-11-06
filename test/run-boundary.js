/* 打工人记账器 v1.8.1 · 边界 + 白盒定向 harness
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron test/run-boundary.js
 *
 * 与 P0/P1 的区别：
 *  1) 时间注入改为「子类化 Date」：new Date() 无参也走模拟时间，才能测闰年 / 跨年 / 月末
 *  2) 直接从 localStorage 注入存档，覆盖 load() 的修复分支（白盒路径入口）
 *  3) 带白盒定向用例：用源码里发现的疑点构造最小复现，实测判定是缺陷还是设计
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE = 'dgjz.worker.v1';
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const REPORT = path.join(ROOT, '测试报告-边界与白盒-v' + PKG_VERSION + '.md');

// 每个套件用独立 userData：默认所有套件共用一个 localStorage，
// 上一套件/上一轮没退干净时会把「今天已赚满」的存档带进来（实测 09:30 就有全天收入）
app.setPath('userData', path.join(require('os').tmpdir(), 'dgjz-harness-' + path.basename(__filename, '.js')));

let win = null;
let consoleErrors = [];
let importFile = null;
let BASE = null;
let workDays = 21;
let perDay = 0;

const results = [];
const record = (id, name, pass, detail) => {
  results.push({ id, name, pass, detail });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + id + ' ' + name + ' | ' + detail);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (js) => win.webContents.executeJavaScript(js, true);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* 时间注入：子类化 Date，覆盖 new Date() / Date.now() 两条路径 */
const INJECT = `(() => {
  if (window.__sim2) return 'already';
  window.__sim2 = true;
  // v1.2.1：没干满就下班的确认弹窗——这些套件只关心结算结果，自动点「照样下班」
  try {
    const dm = document.getElementById('dlgMask');
    if (dm) new MutationObserver(() => {
      if (!dm.hidden) setTimeout(() => { const ok = document.getElementById('dlgOk'); if (ok) ok.click(); }, 0);
    }).observe(dm, { attributes: true, attributeFilter: ['hidden'] });
  } catch (e) {}
  const RealDate = Date;
  window.__base = null; window.__off = 0;
  const cur = () => (window.__base == null ? RealDate.now() : window.__base) + window.__off;
  class SimDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(cur()); else super(...a); }
    static now() { return cur(); }
  }
  window.Date = SimDate;
  window.__setBase = (y, mo, d, h, mi) => {
    window.__base = new RealDate(y, mo - 1, d, h || 0, mi || 0, 0, 0).getTime();
    window.__off = 0;
    return new SimDate().toString();
  };
  window.__at = (h, m) => {
    const c = cur();
    const t = new RealDate(c);
    t.setHours(h, m || 0, 0, 0);
    window.__off += t.getTime() - c;
    return new SimDate().toString();
  };
  window.__later = (ms) => { window.__off += ms; return new SimDate().toString(); };
  window.__todayKey = () => { const d = new SimDate(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  return 'ok';
})()`;

const SNAP = `(() => {
  const q = (s) => document.querySelector(s);
  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem('${STORE}') || '{}'); } catch (e) {}
  return {
    earned: parseFloat((q('#todayEarned').textContent || '0').replace(/,/g, '')) || 0,
    rawEarned: (q('#todayEarned').textContent || '').trim(),
    perDay: (q('#perDay').textContent || '').trim(),
    perHour: (q('#perHour').textContent || '').trim(),
    perSec: q('#perSec').textContent.trim(),
    state: q('#workState').textContent.trim(),
    goalMonth: (q('#goalMonth').textContent || '').trim(),
    goalPct: (q('#goalPct').textContent || '').trim(),
    goalMoney: (q('#goalMoney').textContent || '').trim(),
    goalName: (q('#goalName').textContent || '').trim(),
    formErr: (q('#formErr').textContent || '').trim(),
    lunchNote: (q('#lunchNote').textContent || '').trim(),
    lunchHint: (q('#lunchHint').textContent || '').trim(),
    daysHint: (q('#daysHint').textContent || '').trim(),
    inDays: (q('#inDays') || {}).value,
    cfg
  };
})()`;

const CLICK = (sel) => `document.querySelector('${sel}').click(); 'ok'`;
const SET = (sel, v) => `(() => {
  const e = document.querySelector('${sel}');
  e.value = ${JSON.stringify(v)};
  e.dispatchEvent(new Event('input', { bubbles: true }));
  e.dispatchEvent(new Event('blur', { bubbles: true }));
  return e.value;
})()`;

async function inject() {
  await R(INJECT);
  await sleep(120);
}

async function openSettings() {
  await R(`if (!document.querySelector('#sheet').classList.contains('on')) document.querySelector('#btnSettings').click(); 'ok'`);
  await sleep(220);
}
async function closeSettings() {
  await R(CLICK('#btnCloseSheet'));
  await sleep(220);
}
async function saveSettings() { await R(CLICK('#btnSave')); await sleep(380); }

/* 用给定存档重启页面 */
async function reboot(cfgObj) {
  const raw = typeof cfgObj === 'string' ? cfgObj : JSON.stringify(cfgObj);
  await R(`(() => {
    try { localStorage.clear(); } catch (e) {}
    localStorage.setItem(${JSON.stringify(STORE)}, ${JSON.stringify(raw)});
    location.reload();
    return 'rl';
  })()`);
  await sleep(1250);
  await inject();
  await sleep(200);
}
const reset = () => reboot(BASE);
const patch = (p) => Object.assign({}, BASE, p);

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
    if (level >= 3) consoleErrors.push(String(msg).slice(0, 200));
  });
}

async function boot() {
  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await sleep(600);
  // 清掉别的测试套件留下的存档，保证 BASE 从「首次使用」推导（否则 salary 等残留会让基准漂移）
  await R(`localStorage.removeItem('${STORE}'); location.reload(); 'wipe'`);
  await sleep(1300);
  await inject();
  await openSettings();
  await R(SET('#inStart', '09:00'));
  await R(SET('#inEnd', '18:00'));
  await saveSettings();
  const s = await R(SNAP);
  // 基准存档只保留「配置」，运行态一律清零：否则上一次测试留下的 doneShift
  // 会让今天的打卡被判成「已收工」直接晃动函数拦掉，用例全部假失败
  BASE = Object.assign({}, s.cfg, {
    segments: [], clockIn: null, doneShift: null, lastShift: null,
    todaySettled: null, dailyLog: {}, leaves: {}, fixRanges: [], fixDay: '',
    holidays: {}, holidayCheckedAt: 0, settled: 0, savedBase: 0,
    dailyHours: null, workDays: 21, daysMode: 'double', inited: true
  });
  workDays = BASE.workDays || 21;
  perDay = BASE.salary / workDays;
  if (BASE.start !== '09:00' || !BASE.inited) throw new Error('fixture 创建失败');
  console.log('FIXTURE ok | workDays=' + workDays + ' perDay=' + perDay.toFixed(2));
}

/* ================= G1 存档自愈边界（load() 分支） ================= */

async function g1_storage() {
  // 薪资非法（0 / 负数 / 字符串）→ 重置为默认 + 判定未初始化
  const out = [];
  for (const bad of [0, -100, '0x2710']) {
    await reboot(patch({ salary: bad }));
    const s = await R(SNAP);
    const sheetOn = await R(`document.querySelector('#sheet').classList.contains('on')`);
    out.push(bad + '→' + s.cfg.salary + (sheetOn ? '(弹首启)' : ''));
  }
  record('B-01', '存档月薪 0 / 负数 / 十六进制串：重置为默认值并要求重新设置',
    out.every((x) => x.indexOf('8000') >= 0), out.join(' | '));

  // 完全损坏的 JSON
  await reboot('{{{not json');
  const s2 = await R(SNAP);
  const sheetOn2 = await R(`document.querySelector('#sheet').classList.contains('on')`);
  // 注意：完全损坏时走的是 DEFAULTS（08:00–17:00），而不是 load 里的 09:00 兜底
  const defOk = s2.cfg.salary === 8000 && s2.cfg.start === '08:00' && sheetOn2;
  record('B-02', '存档 JSON 损坏：不崩溃、全部走默认值、自动弹首启设置',
    defOk, 'salary=' + s2.cfg.salary + ' 班次=' + s2.cfg.start + '–' + s2.cfg.end + ' 弹面板=' + sheetOn2);

  // 数值类 clamp
  await reboot(patch({ workDays: 0, goalAmount: 0, savedBase: -5, settled: -100 }));
  const s3 = await R(SNAP);
  const ok3 = s3.cfg.workDays >= 1 && s3.cfg.workDays <= 31
    && s3.cfg.goalAmount >= 1 && s3.cfg.savedBase === 0 && s3.cfg.settled === 0;
  record('B-03', '存档 workDays=0 / goalAmount=0 / savedBase=-5 / settled=-100：逐项夹紧到合法区间',
    ok3, 'workDays=' + s3.cfg.workDays + ' goalAmount=' + s3.cfg.goalAmount
    + ' savedBase=' + s3.cfg.savedBase + ' settled=' + s3.cfg.settled);

  // 目标名超长 + emoji
  const longName = '买一台最新款的折叠屏手机📱顺便再配个耳机';
  await reboot(patch({ goalName: longName }));
  const s4 = await R(SNAP);
  const len = await R(`(() => { const g = JSON.parse(localStorage.getItem('${STORE}')).goalName; return Array.from(g).length; })()`);
  record('B-04', '目标名超 12 字（含 emoji）：按字符截断到 12，不截断半个 emoji',
    len === 12, '原文 ' + Array.from(longName).length + ' 字 → 存 ' + len + ' 字：' + s4.goalName);

  // 时间非法 / 模式非法 / segments 类型错
  await reboot(patch({ start: '25:00', end: 'abc', clockFrom: 'weird', segments: 'oops' }));
  const s5 = await R(SNAP);
  const ok5 = s5.cfg.start === '09:00' && s5.cfg.end === '18:00'
    && s5.cfg.clockFrom === 'click' && Array.isArray(s5.cfg.segments) && s5.cfg.segments.length === 0;
  record('B-05', '存档 start=25:00 / end=abc / clockFrom=weird / segments 非数组：全部回退合法值',
    ok5, 'start=' + s5.cfg.start + ' end=' + s5.cfg.end + ' mode=' + s5.cfg.clockFrom
    + ' segments=' + JSON.stringify(s5.cfg.segments));

  // leaves 迁移：true → 整天区间；非法值删除（v1.8.1 起键统一补零）
  const today = await R(`(() => { const d = new Date(); const p2 = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); })()`);
  await reboot(patch({ leaves: { [today]: true, '2026-10-1': 'oops' } }));
  const s6 = await R(SNAP);
  const lv = s6.cfg.leaves || {};
  const ok6 = Array.isArray(lv[today]) && lv[today].length === 1
    && lv[today][0].to - lv[today][0].from === 86400000 && !lv['2026-10-1'];
  record('B-06', '老存档 leaves[k]=true 迁移成整天区间、非法值清除', ok6,
    '今天=' + JSON.stringify(lv[today]) + ' 非法键保留=' + ('2026-10-1' in lv));

  // dailyLog 类型错
  await reboot(patch({ dailyLog: [1, 2, 3], holidays: ['x'], fixRanges: 'no' }));
  const s7 = await R(SNAP);
  const ok7 = !Array.isArray(s7.cfg.dailyLog) && typeof s7.cfg.dailyLog === 'object'
    && Array.isArray(s7.cfg.fixRanges) && !Array.isArray(s7.cfg.holidays);
  record('B-07', 'dailyLog/holidays 存成数组、fixRanges 存成字符串：全部纠正为对象/数组',
    ok7, 'dailyLog=' + JSON.stringify(s7.cfg.dailyLog) + ' fixRanges=' + JSON.stringify(s7.cfg.fixRanges));
}

/* ================= G2 日期边界 ================= */

async function g2_date() {
  // 跨年：12-31 打卡，次日 00:30 才想起收口 → 归属 12-31
  await reset();
  await R(`window.__setBase(2026, 12, 31, 9, 0); 'ok'`);
  await sleep(250);
  await R(CLICK('#btnClock'));
  await sleep(300);
  await R(`window.__later(15.5 * 3600e3); 'ok'`);   // → 2027-01-01 00:30
  await sleep(700);
  const s1 = await R(SNAP);
  const log1 = s1.cfg.dailyLog || {};
  const crossOk = near(log1['2026-12-31'] || 0, perDay, 0.6) && near(s1.earned, 0, 0.05);
  record('B-08', '跨年收口：12-31 打卡 → 次日 00:30 自动结，钱记进 2026-12-31，2027-01-01 从 0 开始',
    crossOk, 'dailyLog[2026-12-31]=' + (log1['2026-12-31'] || 0).toFixed(2)
    + ' dailyLog[2027-1-1]=' + (log1['2027-1-1'] || 0).toFixed(2)
    + ' 今日已赚=' + s1.earned + '（预期 0）');

  // 闰年 2 月（2028-02 有 29 天）
  await reboot(patch({ daysMode: 'double', workDays: 21 }));
  await R(`window.__setBase(2028, 2, 15, 10, 0); 'ok'`);
  await sleep(300);
  await openSettings();
  await R(`document.querySelector('#segDays button[data-mode="double"]').click(); 'ok'`);
  await sleep(300);
  const s2 = await R(SNAP);
  record('B-09', '闰年 2 月（2028-02 共 29 天）双休工作日 = 21 天', Number(s2.inDays) === 21,
    '2028-02 核算=' + s2.inDays + ' 天 · 提示=[' + s2.daysHint + ']');
  await closeSettings();

  // 月末 31 天 + 元旦 3 天假 + 1/4 调休上班
  await R(`window.__setBase(2026, 1, 20, 10, 0); 'ok'`);
  await sleep(300);
  await openSettings();
  await R(`document.querySelector('#segDays button[data-mode="double"]').click(); 'ok'`);
  await sleep(300);
  const s3 = await R(SNAP);
  record('B-10', '2026-01（31 天，元旦 3 天假 + 1/4 调休上班）双休工作日 = 21 天',
    Number(s3.inDays) === 21, '核算=' + s3.inDays + ' 天 · 提示=[' + s3.daysHint + ']');
  await closeSettings();

  // dayKey 无前导零 vs 导入数据带前导零
  await reboot(patch({ dailyLog: { '2026-11-04': 100 }, leaves: {} }));
  await R(`window.__setBase(2026, 11, 4, 9, 0); 'ok'`);
  await sleep(300);
  await R(CLICK('#btnClock'));
  await sleep(250);
  await R(`window.__later(3600e3); 'ok'`);           // 10:00
  await sleep(500);
  const s4 = await R(SNAP);
  await R(CLICK('#btnHistory'));
  await sleep(450);
  const h = await R(`(() => {
    const box = document.querySelector('#histList');
    return {
      months: [...box.querySelectorAll('.hist-month')].map((p) => p.textContent),
      dates: [...box.querySelectorAll('.h-date')].map((p) => p.textContent),
      amts: [...box.querySelectorAll('.h-amt')].map((p) => p.textContent)
    };
  })()`);
  const dup = h.dates.filter((x) => x === '11月4日').length;
  record('B-11', '带前导零的历史键（2026-11-04）与今日 dayKey（2026-11-4）是否合并为同一天',
    dup === 1,
    '明细出现「11月4日」' + dup + ' 行 · 月头=[' + h.months.join(' / ') + '] · 本月卡=[' + s4.goalMonth + ']'
    + (dup > 1 ? ' ← 同一天被拆成两行，天数重复计算' : ''));

  await R(CLICK('#btnCloseHist'));
  await sleep(200);
}

/* ================= G3 数值 / 单价边界 ================= */

async function g3_number() {
  // 每日有效工时上限 24h
  await reboot(patch({ clockFrom: 'click', dailyHours: 24 }));
  await sleep(200);
  const s1 = await R(SNAP);
  const expPerSec = (8000 / workDays) / (24 * 3600);
  const ok1 = near(parseFloat(s1.perSec), expPerSec, 0.0001);
  await R(CLICK('#btnClock'));
  await sleep(200);
  await R(`window.__later(60e3); 'ok'`);              // 1 分钟
  await sleep(450);
  const s1b = await R(SNAP);
  const exp1min = 60 * expPerSec;
  record('B-12', '每日有效工时 = 24h 上限：秒薪按 86400 秒摊，1 分钟 = 1 分钟钱',
    ok1 && near(s1b.earned, exp1min, 0.01),
    '秒薪=' + s1.perSec + '（预期 ' + expPerSec.toFixed(4) + '）1min=' + s1b.earned + '（预期 ' + exp1min.toFixed(3) + '）');

  // 下限 0.5h：干满半小时就该拿满日薪
  await reboot(patch({ clockFrom: 'click', dailyHours: 0.5 }));
  await sleep(200);
  await R(CLICK('#btnClock'));
  await sleep(200);
  await R(`window.__later(30 * 60e3); 'ok'`);
  await sleep(500);
  const s2 = await R(SNAP);
  record('B-13', '每日有效工时 = 0.5h 下限：干满 30 分钟即达日薪并封顶',
    near(s2.earned, perDay, 0.6), '30min 已赚=' + s2.earned + '（预期 ' + perDay.toFixed(2) + '）');

  // 极端单价：月薪 100 万 / 1 个工作日 / 0.5h
  await reboot(patch({ salary: 1000000, workDays: 1, daysMode: 'custom', clockFrom: 'click', dailyHours: 0.5 }));
  await sleep(250);
  const s3 = await R(SNAP);
  const exp3 = 1000000 / (0.5 * 3600);
  record('B-14', '极端单价：月薪 100 万 ÷ 1 天 ÷ 0.5h = 每秒 ¥555.56，格式不溢出',
    near(parseFloat(s3.perSec), exp3, 0.6) && s3.perDay.indexOf('1,000,000') >= 0,
    '秒薪=' + s3.perSec + '（预期 ' + exp3.toFixed(2) + '）日薪=' + s3.perDay + ' 时薪=' + s3.perHour);

  // 已有存款 1 亿 → 亿级格式化
  await reboot(patch({ savedBase: 100000000, goalAmount: 100000000 }));
  await sleep(250);
  const s4 = await R(SNAP);
  record('B-15', '已有存款 1 亿：格式化走「亿」档且进度 100%',
    s4.goalPct.indexOf('100%') >= 0, '目标=' + s4.goalMoney + ' 进度=' + s4.goalPct);

  // 目标达成撒花：必须「从 <100 跨到 100」才触发一次
  await reboot(patch({ goalAmount: 1000, savedBase: 500, settled: 0 }));
  await sleep(300);
  const before = await R(`document.querySelector('.goal').classList.contains('complete')`);
  await openSettings();
  await R(SET('#inSaved', '1000'));
  await saveSettings();
  await sleep(500);
  const after = await R(`(() => ({
    complete: document.querySelector('.goal').classList.contains('complete'),
    confetti: document.querySelectorAll('.confetti').length,
    pct: document.querySelector('#goalPct').textContent.trim()
  }))()`);
  record('B-16', '目标从 50% 跨到 100%：进度满格 + 撒花只触发一次',
    !before && after.complete && after.confetti >= 20 && after.pct.indexOf('100%') >= 0,
    '达成前有 complete 类=' + before + ' 达成后=' + after.complete + ' 彩带=' + after.confetti + ' 进度=' + after.pct);
}

/* ================= G4 输入边界 ================= */

async function g4_input() {
  await reset();
  await openSettings();

  // 科学计数法 '1e5'：type=number 接受，checkNumField 用 Number() 解析成 100000
  await R(SET('#inSalary', '1e5'));
  await saveSettings();
  const s1 = await R(SNAP);
  const sci = s1.cfg.salary;

  // 千分位/空格：type=number 本身承载不了，这条路径只能从「粘贴/导入」进来
  const stripRaw = await R(`(() => {
    const el = document.querySelector('#inSalary');
    el.value = ' 8,800 ';
    return el.value;
  })()`);

  record('B-17', '数字输入：科学计数法 1e5 被当成 100000 接受（Number 宽松解析）',
    sci === 100000,
    '1e5→' + sci + '；「 8,800 」写入 number 输入框后 value=[' + stripRaw + ']（浏览器直接丢弃，该路径不可达，仅导入/粘贴边界需关注）');
  await openSettings();
  await R(SET('#inSalary', '8000'));
  await saveSettings();

  // 自定义天数 12.5（半天天数）
  await openSettings();
  await R(SET('#inSalary', '8000'));
  await R(SET('#inDays', '12.5'));
  await sleep(200);
  await saveSettings();
  const s3 = await R(SNAP);
  record('B-18', '每月工作天数填 12.5：按 0.5 天粒度保存，日薪=8000/12.5',
    s3.cfg.workDays === 12.5 && s3.perDay.indexOf('640') >= 0,
    'workDays=' + s3.cfg.workDays + ' 日薪=' + s3.perDay + '（预期 ¥640）');

  // 每日工时上下限
  await openSettings();
  await R(`document.querySelector('.mcard[data-mode="click"]').click(); 'ok'`);
  await sleep(150);
  const tryDh = async (v) => {
    await R(SET('#inDailyHours', v));
    await sleep(150);
    const txt = await R(SNAP);
    return txt.formErr;
  };
  const e04 = await tryDh('0.4');
  const e245 = await tryDh('24.5');
  const e24 = await tryDh('24');
  record('B-19', '每日有效工时边界：0.4 拦截 / 24.5 拦截 / 24 恰好通过',
    e04.indexOf('最少 0.5') >= 0 && e245.indexOf('最多 24') >= 0 && e24 === '',
    '0.4=[' + e04 + '] 24.5=[' + e245 + '] 24=[' + (e24 || '通过') + ']');

  // 时间掩码与非法回退
  const mask = await R(`(() => {
    const el = document.querySelector('#inStart');
    const out = [];
    const set = (v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); out.push(v + '→' + el.value); };
    set('9'); set('930'); set('1532'); set('2400'); set('0000');
    return out;
  })()`);
  await R(`(() => { const el = document.querySelector('#inStart'); el.value = '2360'; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('blur', {bubbles:true})); return el.value; })()`);
  await sleep(250);
  const badBack = await R(`(() => ({ v: document.querySelector('#inStart').value, bad: document.querySelector('#inStart').classList.contains('bad') }))()`);
  const okMask = /^[0-2]\d:[0-5]\d$/.test(badBack.v) && badBack.bad;
  record('B-20', '时间掩码：930→9:30、1532→15:32、2400→24:00 待校验；2360 blur 后回退成合法 HH:MM 并标红',
    mask[0].indexOf('9→9') === 0 && mask[1].indexOf('9:30') > 0 && mask[2].indexOf('15:32') > 0
    && mask[3].indexOf('24:00') > 0 && okMask,
    '掩码=' + mask.join(' ') + ' 2360→回退[' + badBack.v + '] 标红=' + badBack.bad);

  // 目标金额 1 亿边界
  const tryGoal = async (v) => {
    await R(SET('#inGoalAmount', v));
    await sleep(150);
    return (await R(SNAP)).formErr;
  };
  const g1 = await tryGoal('100000000');
  const g2 = await tryGoal('100000001');
  record('B-21', '目标金额边界：1 亿通过、1 亿零 1 拦截',
    g1 === '' && g2.indexOf('最多 100,000,000') >= 0,
    '1e8=[' + (g1 || '通过') + '] 1e8+1=[' + g2 + ']');

  await closeSettings();
}

/* ================= G5 容量 / 存储边界 ================= */

async function g5_capacity() {
  await reset();

  // 配额耗尽难以稳定复现，这里直接让 setItem 抛 QuotaExceededError，
  // 精确打中 save() 里那个 `catch (e) { /* 忽略 */ }` 分支
  const filled = await R(`(() => {
    window.__origSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === '${STORE}') { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
      return window.__origSet.call(this, k, v);
    };
    return 'patched';
  })()`);
  await openSettings();
  await R(SET('#inSalary', '12000'));
  await saveSettings();
  await sleep(300);
  const afterSave = await R(`(() => {
    const raw = JSON.parse(localStorage.getItem('${STORE}') || '{}');
    return {
      diskSalary: raw.salary,
      uiPerDay: document.querySelector('#perDay').textContent.trim(),
      formErr: document.querySelector('#formErr').textContent.trim(),
      dataHint: document.querySelector('#dataHint').textContent.trim(),
      warnShown: !document.querySelector('#saveWarn').hidden,
      warnText: document.querySelector('#saveWarn').textContent.trim()
    };
  })()`);
  const memChanged = afterSave.uiPerDay.indexOf('571') >= 0;   // 12000/21
  const diskOld = afterSave.diskSalary === 8000;
  // v1.8.1（D-06）：写不进去可以，但必须让用户看见（常驻「未保存」提示条）
  record('B-22', '磁盘写入失败时保存：要么落盘、要么界面出现常驻「未保存」提示',
    !(memChanged && diskOld) || afterSave.warnShown,
    '注入=' + filled + ' · 界面日薪=' + afterSave.uiPerDay + '（12000/21=571）'
    + ' 存档月薪=' + afterSave.diskSalary + ' 未保存提示=' + (afterSave.warnShown ? '已显示[' + afterSave.warnText + ']' : '无')
    + (memChanged && diskOld && !afterSave.warnShown ? ' ← 用户以为改成功，重启即丢' : ''));

  // 还原 setItem 后重启，验证是否真的回退
  await R(`(() => { Storage.prototype.setItem = window.__origSet; return 'ok'; })()`);
  await R(`location.reload(); 'rl'`);
  await sleep(1300);
  await inject();
  const back = await R(SNAP);
  record('B-23', '写入失败后重启：薪资应仍为原值（若回退即证实上次保存丢失）',
    back.cfg.salary === 12000, '重启后月薪=' + back.cfg.salary + '（12000=未丢；8000=已丢）');

  // 大量历史数据：明细 62 条上限 + 渲染耗时
  const bigLog = {};
  for (let i = 0; i < 1000; i++) {
    const d = new Date(2024, 0, 1 + i);
    bigLog[d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()] = 100 + (i % 50);
  }
  await reboot(patch({ dailyLog: bigLog }));
  await sleep(300);
  const t0 = Date.now();
  await R(CLICK('#btnHistory'));
  await sleep(50);
  const perf = await R(`(() => {
    const box = document.querySelector('#histList');
    return { rows: box.querySelectorAll('.hist-row').length, months: box.querySelectorAll('.hist-month').length };
  })()`);
  const cost = Date.now() - t0;
  record('B-24', '存档 1000 天历史：明细只渲染最近 62 条、按月分组正确、单次耗时可控',
    perf.rows === 62 && perf.months >= 2 && cost < 1500,
    '渲染 ' + perf.rows + ' 行 / ' + perf.months + ' 个月 · 打开耗时 ' + cost + 'ms');
  await R(CLICK('#btnCloseHist'));
  await sleep(200);
}

/* ================= G6 白盒定向：源码疑点实测 ================= */

async function g6_whitebox() {
  // 疑点 1：settleIfRunning 用 dayKey(now)，settle 用 dayKey(shiftStart)
  // 夜班 22:00–06:00，凌晨 01:00 改薪 → 钱该记在班次开始那天（11-4）还是现在（11-5）？
  await reboot(patch({ start: '22:00', end: '06:00', lunchStart: '00:00', lunchEnd: '00:00', clockFrom: 'click' }));
  await sleep(300);
  await R(`window.__setBase(2026, 11, 4, 23, 0); 'ok'`);
  await sleep(250);
  await R(CLICK('#btnClock'));
  await sleep(250);
  await R(`window.__later(2 * 3600e3); 'ok'`);          // → 11-05 01:00
  await sleep(400);
  await openSettings();
  await R(SET('#inSalary', '16000'));
  await saveSettings();
  await sleep(400);
  const s1 = await R(SNAP);
  const log = s1.cfg.dailyLog || {};
  const keys = Object.keys(log);
  record('B-25', '夜班跨零点时改薪：正在计时的钱固化到哪一天（源码 settle 用班次日、settleIfRunning 用当前日）',
    keys.length === 1 && keys[0] === '2026-11-04',
    'dailyLog 键=[' + keys.join(',') + '] 值=' + keys.map((k) => log[k].toFixed(2)).join(',')
    + (keys.indexOf('2026-11-05') >= 0 ? ' ← 记到了次日（11-5），与正常下班结算的归属日不一致' : '（v1.8.1 起与 settle 同口径，键统一补零）'));

  // 疑点 2：午休完全在班外时，note 显示「总时长」而非「实际扣除 0」
  await reset();
  await openSettings();
  await R(SET('#inStart', '09:00'));
  await R(SET('#inEnd', '18:00'));
  await R(SET('#inLunchStart', '08:00'));
  await R(SET('#inLunchEnd', '09:00'));
  await sleep(300);
  const s2 = await R(SNAP);
  record('B-26', '午休完全在班外：卡片显示时长与「不会被扣除」提示是否自洽',
    s2.lunchHint.indexOf('不会被扣除') >= 0,
    '午休卡片=[' + s2.lunchNote + '] 提示=[' + s2.lunchHint + ']'
    + (s2.lunchNote !== '无' ? ' ← 实际不扣任何时间，却显示' + s2.lunchNote : ''));
  await closeSettings();

  // 疑点 3：openSheet 里改写 cfg.workDays 是否落盘（refreshWorkDays 已在启动时兜底）
  await reboot(patch({ workDays: 22, daysMode: 'double' }));
  await sleep(400);
  const bootCfg = await R(SNAP);
  await openSettings();
  await sleep(300);
  const opened = await R(SNAP);
  await closeSettings();
  const persisted = await R(`(() => {
    const raw = JSON.parse(localStorage.getItem('${STORE}') || '{}');
    return { disk: raw.workDays, mem: document.querySelector('#perDay').textContent.trim() };
  })()`);
  record('B-27', '存活的旧天数（22）与当月实际（21）不一致：启动即自愈并落盘，打开面板不再二次改写',
    bootCfg.cfg.workDays === 21 && persisted.disk === 21 && Number(opened.inDays) === 21,
    '启动后内存=' + bootCfg.cfg.workDays + ' 面板天数=' + opened.inDays + ' 磁盘=' + persisted.disk
    + ' 日薪=' + persisted.mem);

  // 疑点 4（D-04 同类）：全自动夜班凌晨改薪，固化的钱也要记在班次开始日
  await reboot(patch({
    start: '22:00', end: '06:00', lunchStart: '00:00', lunchEnd: '00:00',
    clockFrom: 'schedule', autoRun: true, doneShift: null, lastShift: null, todaySettled: null
  }));
  await sleep(250);
  // 日期不能写死：启动那一刻是按真实时间跑的（可能已经补结过"昨晚那班"），
  // 写死 2026-11-04 会在不同时间点跑出完全不同的结果。改成「今天 23:00」起算。
  const d0 = new Date();
  const y0 = d0.getFullYear(), mo0 = d0.getMonth() + 1, day0 = d0.getDate();
  const kOf = (dd) => dd.getFullYear() + '-' + String(dd.getMonth() + 1).padStart(2, '0')
    + '-' + String(dd.getDate()).padStart(2, '0');
  const todayK = kOf(d0);
  const tmrK = kOf(new Date(d0.getTime() + 24 * 3600e3));
  await R(`window.__setBase(${y0}, ${mo0}, ${day0}, 23, 0); 'ok'`);
  await sleep(250);
  await R(`window.__later(2 * 3600e3); 'ok'`);          // → 次日 01:00
  await sleep(400);
  await openSettings();
  await R(SET('#inSalary', '16000'));
  await saveSettings();
  await sleep(400);
  const s28 = await R(SNAP);
  const log28 = s28.cfg.dailyLog || {};
  const keys28 = Object.keys(log28);
  // 改薪发生在次日凌晨 01:00，但这一班是「今天 22:00」开始的，钱必须记在今天
  record('B-28', '全自动夜班凌晨改薪：固化金额记在班次开始日（今天），不落到次日',
    (log28[todayK] || 0) > 0 && !log28[tmrK],
    '班次开始日=' + todayK + ' 次日=' + tmrK + ' 键=[' + keys28.join(',') + '] 值='
    + keys28.map((k) => log28[k].toFixed(2)).join(','));
  await closeSettings();

  // 疑点 5（D-04 同类）：夜班凌晨补录记在班次开始日；删除后今日已赚要退回
  await reboot(patch({ start: '22:00', end: '06:00', lunchStart: '00:00', lunchEnd: '00:00', clockFrom: 'click' }));
  await sleep(250);
  await R(`window.__setBase(2026, 11, 4, 23, 0); 'ok'`);
  await sleep(200);
  await R(CLICK('#btnClock'));                          // 23:00 打卡
  await sleep(300);
  await R(`window.__later(2 * 3600e3); 'ok'`);          // → 11-05 01:00
  await sleep(400);
  const beforeFix = (await R(SNAP)).earned;
  await R(CLICK('#btnFix'));
  await sleep(300);
  await R(`document.querySelector('#inFixStart').value = '22:10';
           document.querySelector('#inFixEnd').value = '22:50';
           document.querySelector('#btnFixOk').click(); 'ok'`);   // 打卡之前的一段，不重叠
  await sleep(450);
  const afterFix = await R(SNAP);
  const log29 = afterFix.cfg.dailyLog || {};
  const keyOk = (log29['2026-11-04'] || 0) > 0 && !log29['2026-11-05'];
  await R(CLICK('#btnFix'));                            // 补完会自动关弹层，重新打开才能删
  await sleep(300);
  await R(`document.querySelector('.fi-del').click(); 'ok'`);
  await sleep(150);
  await R(`document.querySelector('.fi-del').click(); 'ok'`);
  await sleep(450);
  const afterDel = await R(SNAP);
  const backOk = Math.abs(afterDel.earned - beforeFix) < 0.3 && !afterDel.cfg.fixRanges.length;
  record('B-29', '夜班凌晨补录：钱记在班次开始日（11-04），删除后今日已赚退回原值',
    keyOk && afterFix.earned > beforeFix && backOk,
    '补前=' + beforeFix.toFixed(2) + ' 补后=' + afterFix.earned.toFixed(2) + ' 删后=' + afterDel.earned.toFixed(2)
    + ' 键=[' + Object.keys(log29).join(',') + ']');
}

/* ================= 汇总 ================= */

async function runAll() {
  const groups = [
    ['g1_storage', g1_storage],
    ['g2_date', g2_date],
    ['g3_number', g3_number],
    ['g4_input', g4_input],
    ['g5_capacity', g5_capacity],
    ['g6_whitebox', g6_whitebox]
  ];
  for (const [name, fn] of groups) {
    try {
      await fn();
    } catch (e) {
      console.log('GROUP-FAIL | ' + name + ' | ' + (e && e.message));
      results.push({ id: name, name: '（组内异常）', pass: false, detail: String((e && e.message) || e) });
    }
  }
}

function writeReport() {
  const pass = results.filter((r) => r.pass).length;
  const lines = [];
  lines.push('# 测试报告 · 边界与白盒定向（打工人记账器 v' + PKG_VERSION + '）', '');
  lines.push('- 执行时间：' + new Date().toLocaleString('zh-CN'));
  lines.push('- 测试对象：`src/app.js`（2603 行）/' + 'src/index.html（384 行）/ main.js（194 行）');
  lines.push('- 时间模拟：子类化 `Date`，`new Date()` 无参与 `Date.now()` 双路径受控');
  lines.push('- 结果：**' + pass + '/' + results.length + ' 通过**', '');
  lines.push('| 编号 | 用例 | 结果 | 实测 |', '|---|---|---|---|');
  results.forEach((r) => {
    lines.push('| ' + r.id + ' | ' + r.name + ' | ' + (r.pass ? '✅ 通过' : '❌ 失败') + ' | ' + String(r.detail).replace(/\|/g, '\\|') + ' |');
  });
  if (consoleErrors.length) {
    lines.push('', '## 渲染进程错误（级别 ≥3）', '');
    Array.from(new Set(consoleErrors)).slice(0, 10).forEach((m) => lines.push('- ' + m));
  }
  fs.writeFileSync(REPORT, lines.join('\n') + '\n', 'utf8');
  console.log('SUMMARY | pass=' + pass + '/' + results.length);
  console.log('REPORT | ' + REPORT);
}

app.whenReady().then(async () => {
  ipcMain.handle('app:version', () => PKG_VERSION);   // 测试主进程的 app.getVersion() 是 Electron 版本，这里回应用版本
  ipcMain.handle('holidays:fetch', () => null);
  ipcMain.handle('data:export', (_e, name, json) => {
    const dir = path.join(ROOT, '.preview');
    const p = path.join(dir, 'boundary-export.json');
    fs.writeFileSync(p, json, 'utf8');
    return { ok: true, path: p };
  });
  ipcMain.handle('data:import', () => (importFile ? { ok: true, json: fs.readFileSync(importFile, 'utf8') } : { canceled: true }));
  ipcMain.on('win:pin', () => {});
  ipcMain.on('win:compact', () => {});
  ipcMain.on('win:minimize', () => {});
  ipcMain.on('win:close', () => {});

  await createWindow();
  let fatal = null;
  try {
    await boot();
    await runAll();
  } catch (e) {
    fatal = e;
    console.log('FATAL | ' + ((e && e.stack) || e));
    results.push({ id: 'FATAL', name: '执行中断', pass: false, detail: String((e && e.message) || e) });
  }
  if (fatal) consoleErrors.slice(-10).forEach((m) => console.log('CONSOLE | ' + m));
  writeReport();
  app.exit(0);
});
