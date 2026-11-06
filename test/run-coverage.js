/* 打工人记账器 v1.8.1 · 白盒覆盖率采集（CDP Profiler 精确覆盖率）
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron test/run-coverage.js
 *
 * 原理：Chrome DevTools Protocol 的 Profiler.startPreciseCoverage 按「字节区间 + 执行次数」
 *       返回真实执行数据（非插桩猜测）。跑完一条尽可能宽的业务流后 takePreciseCoverage，
 *       把 offset 映射回行号，算出渲染层（app.js / preload.js）的行覆盖与函数覆盖，
 *       并列出未覆盖行，作为「还需要补哪些用例」的依据。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE = 'dgjz.worker.v1';
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const REPORT = path.join(ROOT, '测试报告-白盒覆盖率-v' + PKG_VERSION + '.md');

// 每个套件用独立 userData：默认所有套件共用一个 localStorage，
// 上一套件/上一轮没退干净时会把「今天已赚满」的存档带进来（实测 09:30 就有全天收入）
app.setPath('userData', path.join(require('os').tmpdir(), 'dgjz-harness-' + path.basename(__filename, '.js')));
const SRC_APP = path.join(ROOT, 'src', 'app.js');

let win = null;
let dbg = null;
let importMode = 'good';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (js) => win.webContents.executeJavaScript(js, true);

const INJECT = `(() => {
  // v1.2.1：没干满就下班的确认弹窗——这些套件只关心结算结果，自动点「照样下班」
  try {
    const dm = document.getElementById('dlgMask');
    if (dm) new MutationObserver(() => {
      if (!dm.hidden) setTimeout(() => { const ok = document.getElementById('dlgOk'); if (ok) ok.click(); }, 0);
    }).observe(dm, { attributes: true, attributeFilter: ['hidden'] });
  } catch (e) {}
  if (window.__sim3) return 'already';
  window.__sim3 = true;
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
    window.__off = 0; return new SimDate().toString();
  };
  window.__at = (h, m) => { const c = cur(); const t = new RealDate(c); t.setHours(h, m || 0, 0, 0); window.__off += t.getTime() - c; return new SimDate().toString(); };
  window.__later = (ms) => { window.__off += ms; return new SimDate().toString(); };
  return 'ok';
})()`;

const CLICK = (sel) => `document.querySelector('${sel}').click(); 'ok'`;
const SET = (sel, v) => `(() => {
  const e = document.querySelector('${sel}');
  if (!e) return 'NOEL';
  e.value = ${JSON.stringify(v)};
  e.dispatchEvent(new Event('input', { bubbles: true }));
  e.dispatchEvent(new Event('blur', { bubbles: true }));
  return e.value;
})()`;

async function click(sel, wait) {
  await R(CLICK(sel));
  await sleep(wait == null ? 200 : wait);
}
async function setVal(sel, v) {
  await R(SET(sel, v));
  await sleep(120);
}
async function inject() { await R(INJECT); await sleep(100); }

async function reload(raw) {
  if (raw === undefined) {
    await R(`location.reload(); 'rl'`);
  } else if (raw === null) {
    await R(`(() => { localStorage.clear(); location.reload(); return 'rl'; })()`);
  } else {
    await R(`(() => { localStorage.clear(); localStorage.setItem(${JSON.stringify(STORE)}, ${JSON.stringify(raw)}); location.reload(); return 'rl'; })()`);
  }
  await sleep(1300);
  await inject();
}

/* ---------------- 业务流：尽可能打满分支 ---------------- */

async function flow() {
  /* 1) 首启：无存档 → 自动弹设置面板（start 里 !inited 分支） */
  await reload(null);
  await sleep(600);

  /* 2) 设置面板：数字校验（合法/空/负数/过大）、时间掩码与非法、午休提示、目标、工时 */
  await setVal('#inSalary', '-1');                 // 负数 → live 校验
  await setVal('#inSalary', '');                   // 空
  await setVal('#inSalary', '2000000');            // 过大
  await setVal('#inSalary', '8000');
  await setVal('#inDays', '31');                   // 触发 daysMode=custom
  await R(`document.querySelector('#segDays button[data-mode="single"]').click(); 'ok'`);
  await sleep(200);
  await R(`document.querySelector('#segDays button[data-mode="bigsmall"]').click(); 'ok'`);
  await sleep(200);
  await R(`document.querySelector('#segDays button[data-mode="double"]').click(); 'ok'`);
  await sleep(200);

  await setVal('#inStart', '0930');                // 掩码路径
  await setVal('#inStart', '09:00');
  await setVal('#inEnd', '2400');                  // 非法 → 回退
  await setVal('#inEnd', '');
  await setVal('#inEnd', '18:00');
  await setVal('#inLunchStart', '12:00');
  await setVal('#inLunchEnd', '11:00');            // 午休反序提示
  await setVal('#inLunchEnd', '13:00');

  // v1.11.0 新控件：时间滑块（打开 → 拖 → 取消 / 快捷 → 确定）
  await R(`document.querySelector('#inStart').parentElement.querySelector('.tin-btn').click(); 'ok'`);
  await sleep(280);
  await R(`(() => { const h = document.querySelector('#tpHour'); h.value = 8; h.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#tpCancel').click(); return 'ok'; })()`);
  await sleep(300);
  await R(`document.querySelector('#inLunchStart').parentElement.querySelector('.tin-btn').click(); 'ok'`);
  await sleep(280);
  await R(`(() => { document.querySelector('#tpQuick button[data-q="now"]').click();
    const m = document.querySelector('#tpMin'); m.value = 30; m.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#tpOk').click(); return 'ok'; })()`);
  await sleep(320);

  // 超长输入截断 + 焦点全选
  await R(`(() => { const el = document.querySelector('#inStart'); el.focus(); el.select();
    document.execCommand('insertText', false, '123456'); el.blur(); return el.value; })()`);
  await sleep(180);
  await setVal('#inStart', '09:00');

  // 滑块开着按 Esc：只关滑块，不关设置面板
  await R(`document.querySelector('#inEnd').parentElement.querySelector('.tin-btn').click(); 'ok'`);
  await sleep(280);
  await R(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 'ok'`);
  await sleep(320);

  // 时间中间删改写一位：不跳位（用户报的 bug）
  await R(`(() => { const el = document.querySelector('#inStart'); el.focus(); el.value = '14:30';
    el.setSelectionRange(2, 2); document.execCommand('delete');
    document.execCommand('insertText', false, '5'); el.blur(); return el.value; })()`);
  await sleep(200);
  await setVal('#inStart', '09:00');
  await setVal('#inLunchStart', '12:00');
  await setVal('#inLunchEnd', '13:00');

  // 数字箭头：空值 → 1、2，再减回 1
  await R(`(() => { const el = document.querySelector('#inGoalAmount'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true }));
    const host = el.parentElement; host.querySelector('.ns-up').click(); host.querySelector('.ns-up').click();
    host.querySelector('.ns-dn').click(); return el.value; })()`);
  await sleep(180);
  await setVal('#inGoalName', '买一台最新款的折叠屏手机📱顺便再配个耳机');
  await setVal('#inGoalAmount', '0');              // 非法
  await setVal('#inGoalAmount', '6000');
  await setVal('#inSaved', '');
  await R(`document.querySelectorAll('#emojiRow button')[3].click(); 'ok'`);
  await sleep(150);

  // 模式卡三张各点一遍（pending 只改内存）
  await R(`document.querySelector('.mcard[data-mode="schedule"][data-auto="0"]').click(); 'ok'`);
  await sleep(150);
  await R(`document.querySelector('.mcard[data-mode="schedule"][data-auto="1"]').click(); 'ok'`);
  await sleep(150);
  await R(`document.querySelector('.mcard[data-mode="click"]').click(); 'ok'`);
  await sleep(150);

  // 超长班次 → 二次确认（arm + disarm 两条分支都走）
  await setVal('#inStart', '06:00');
  await setVal('#inEnd', '23:00');
  await click('#btnSave', 350);
  await sleep(5300);                                // 5s 自动解除
  await setVal('#inStart', '09:00');
  await setVal('#inEnd', '18:00');
  await click('#btnSave', 400);                     // 真正保存
  await setVal('#inDailyHours', '0.4');             // 边界拦截
  await setVal('#inDailyHours', '');
  await click('#btnSave', 400);

  /* 3) 打卡那一刻：打卡 / 午休 / 继续 / 请假 / 取消 / 补录 / 下班 / 撤销 */
  await R(`window.__at(9); 'ok'`);
  await sleep(200);
  await click('#btnClock', 300);
  await R(`window.__later(3600e3); 'ok'`);          // 10:00
  await sleep(300);
  await click('#btnBreak', 300);                    // 午休
  await R(`window.__later(600e3); 'ok'`);
  await sleep(300);
  await click('#btnBreak', 300);                    // 继续
  await R(`window.__later(600e3); 'ok'`);
  await sleep(300);

  // 补录：先打开（默认区间自动避让）、拒绝一条、补成功一条
  await click('#btnFix', 350);
  await setVal('#inFixStart', '10:30');
  await setVal('#inFixEnd', '10:30');               // 同一时刻拒绝
  await setVal('#inFixEnd', '11:00');               // 与正在计时重叠 → 拒绝
  await click('#btnFixOk', 300);
  await setVal('#inFixStart', '07:00');             // 班前 → 仍允许（白班从 0 点起）
  await setVal('#inFixEnd', '08:00');
  await sleep(200);
  await click('#btnFixOk', 350);
  await click('#btnFix', 350);                      // 打开看已补列表
  await sleep(200);
  await R(`(() => { const b = document.querySelector('.fi-del'); if (b) b.click(); return 'ok'; })()`);
  await sleep(200);
  await R(`(() => { const b = document.querySelector('.fi-del'); if (b) b.click(); return 'ok'; })()`);
  await sleep(300);
  await click('#btnFixClose', 250);

  // 请假 → 取消
  await click('#btnLeave', 400);
  await R(`window.__later(1800e3); 'ok'`);
  await sleep(300);
  await click('#btnLeave', 400);

  // 下班 → 撤销
  await R(`window.__later(3600e3); 'ok'`);
  await sleep(300);
  await click('#btnClock', 400);
  await click('#lnkRedo', 400);

  /* 4) 明细 / 小窗 / 置顶 / 清零 */
  await click('#btnHistory', 400);
  await click('#btnCloseHist', 250);
  await click('#btnCompact', 1300);
  await click('#compactBar', 900);
  await click('#btnPin', 250);
  await click('#btnPin', 250);

  await click('#btnSettings', 300);
  await click('#btnReset', 300);                    // 武装
  await sleep(3400);                                // 超时自动复原
  await click('#btnReset', 300);
  await click('#btnReset', 400);                    // 确认清零
  await click('#btnCloseSheet', 250);

  /* 5) 定点打卡模式：打卡 / 宽限外自动结 / 撤销 */
  await click('#btnSettings', 300);
  await R(`document.querySelector('.mcard[data-mode="schedule"][data-auto="0"]').click(); 'ok'`);
  await sleep(200);
  await click('#btnSave', 450);
  await R(`window.__at(8, 45); 'ok'`);
  await sleep(200);
  await click('#btnClock', 300);
  await R(`window.__later(10 * 3600e3); 'ok'`);      // 18:45 超宽限 → autoSettle
  await sleep(700);
  await click('#btnFix', 300);                       // 非 click 模式 → openAutoTip
  await click('#btnAutoGo', 500);                    // 跳到设置并聚焦
  await click('#btnCloseSheet', 300);

  /* 6) 全自动（含夜班跨零点、午休自动停） */
  await click('#btnSettings', 300);
  await setVal('#inStart', '22:00');
  await setVal('#inEnd', '06:00');
  await setVal('#inLunchStart', '00:00');
  await setVal('#inLunchEnd', '00:00');
  await R(`document.querySelector('.mcard[data-mode="schedule"][data-auto="1"]').click(); 'ok'`);
  await sleep(150);
  await click('#btnSave', 400);
  await click('#btnSave', 500);                      // 二次确认（午休班外）
  await R(`window.__at(23, 30); 'ok'`);
  await sleep(400);
  await R(`window.__later(8 * 3600e3); 'ok'`);       // 次日 07:30 → 夜班兜底结算
  await sleep(700);
  await click('#btnFix', 300);
  await click('#btnAutoClose', 250);

  /* 7) 导出 / 导入（各分支） */
  await click('#btnSettings', 300);
  await click('#btnExport', 500);

  importMode = 'badjson';
  await click('#btnImport', 400);
  importMode = 'nofield';
  await click('#btnImport', 400);
  importMode = 'negsalary';
  await click('#btnImport', 400);
  importMode = 'good';
  await click('#btnImport', 400);
  await click('#btnImport', 1200);                   // 二次确认 → 写入 + reload

  await inject();
  await click('#btnSettings', 300);
  await click('#btnImport', 400);                    // 再走一次：8 秒超时自动取消
  await sleep(8300);
  await click('#btnCloseSheet', 250);

  /* 8) 节假日更新（成功分支）+ 明细空态 */
  await click('#btnSettings', 300);
  await click('#btnHoliday', 800);
  await click('#btnCloseSheet', 250);
  await click('#btnHistory', 350);
  await click('#btnCloseHist', 250);

  /* 9) 回到首次使用（清空 + reload），走完最后一跳 */
  await click('#btnSettings', 300);
  await click('#btnFirstRun', 300);
  await click('#btnFirstRun', 1400);
  await sleep(600);
}

/* 补覆盖：第一轮没走到的分支（老存档迁移、极小单价/加班、目标达成、定点手动、全自动请假） */
async function flow2() {
  // A) 老格式存档：leaves[k]=true 迁移、segments=null、clockIn 兼容
  await reload(JSON.stringify({
    salary: 8000, workDays: 22, start: '09:00', end: '18:00',
    lunchStart: '12:00', lunchEnd: '13:00', clockFrom: 'click', inited: true,
    leaves: { '2026-11-03': true, '2026-11-02': 'bad' },
    clockIn: 1793600000000, segments: null
  }));
  await sleep(400);
  await click('#btnSettings', 300);
  // 时间补零的短写法：'9'（≤2 位）与 '930'（3 位）
  await setVal('#inStart', '9');
  await setVal('#inStart', '930');
  await setVal('#inStart', '09:00');
  await setVal('#inEnd', '18:00');
  await click('#btnSave', 400);

  // B) 极小单价：加班药丸（hmShort）、撒金币小数（fmtCoin < 0.01）、目标极远（fmtSpan）
  await reload(JSON.stringify({
    salary: 100, workDays: 31, daysMode: 'custom', dailyHours: 0.5,
    start: '09:00', end: '18:00', lunchStart: '12:00', lunchEnd: '13:00',
    clockFrom: 'click', inited: true, goalAmount: 100000000, savedBase: 0,
    goalName: '小目标', goalEmoji: '🎯'
  }));
  await R(`window.__at(9); 'ok'`);
  await sleep(250);
  await click('#btnClock', 300);
  await R(`window.__later(3600e3); 'ok'`);          // 超过 0.5h 上限 → 加班
  await sleep(1400);                                 // 让每秒撒金币至少跑一次
  await click('#btnClock', 400);                     // 下班，产出 lastShift.overtime

  // C) 目标从 50% 跨到 100% → celebrateOnce
  await click('#btnSettings', 300);
  await setVal('#inGoalAmount', '1');
  await setVal('#inSaved', '0.5');
  await click('#btnSave', 450);
  await click('#btnSettings', 300);
  await setVal('#inSaved', '1');
  await click('#btnSave', 600);

  // D) 定点手动：打卡后改薪（settleIfRunning 的 schedule 分支）+ 点下班（clockOutSched）
  await click('#btnSettings', 300);
  await R(`document.querySelector('.mcard[data-mode="schedule"][data-auto="0"]').click(); 'ok'`);
  await sleep(200);
  await click('#btnSave', 450);
  await R(`window.__at(8, 50); 'ok'`);
  await sleep(200);
  await click('#btnClock', 300);
  await click('#btnSettings', 300);
  await setVal('#inSalary', '8600');
  await click('#btnSave', 500);
  await click('#btnClock', 500);
  await click('#lnkRedo', 400);

  // E) 全自动请假（leaveSeconds 路径）+ 改薪（settleAutoSoFar）
  await click('#btnSettings', 300);
  await R(`document.querySelector('.mcard[data-mode="schedule"][data-auto="1"]').click(); 'ok'`);
  await sleep(200);
  await click('#btnSave', 450);
  await R(`window.__at(10, 30); 'ok'`);
  await sleep(450);
  await click('#btnLeave', 450);
  await R(`window.__later(3600e3); 'ok'`);
  await sleep(450);
  await click('#btnSettings', 300);
  await setVal('#inSalary', '9000');
  await click('#btnSave', 550);
  await click('#btnLeave', 450);
  await sleep(300);
}

/* ---------------- 覆盖率计算 ---------------- */

function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}
function offsetToLine(starts, off) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= off) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function analyze(script, src) {
  const starts = lineIndex(src);
  const nLines = starts.length;
  const counts = new Int32Array(src.length).fill(-1);
  const ranges = [];
  (script.functions || []).forEach((fn) => {
    (fn.ranges || []).forEach((r) => ranges.push({ s: r.startOffset, e: r.endOffset, c: r.count }));
  });
  // 短区间后写 → 最内层覆盖外层，得到每个字符的真实执行次数
  ranges.sort((a, b) => (b.e - b.s) - (a.e - a.s));
  ranges.forEach((r) => {
    const s = Math.max(0, r.s), e = Math.min(src.length, r.e);
    for (let i = s; i < e; i++) counts[i] = r.c;
  });

  const lineState = new Uint8Array(nLines);   // 0 不可执行 / 1 未覆盖 / 2 已覆盖
  const lineExec = [];
  for (let i = 0; i < nLines; i++) {
    const s = starts[i];
    const e = i + 1 < nLines ? starts[i + 1] : src.length;
    let any = false, anyPos = false;
    for (let j = s; j < e; j++) {
      const ch = src[j];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') continue;
      const c = counts[j];
      if (c < 0) continue;
      any = true;
      if (c > 0) { anyPos = true; break; }
    }
    if (!any) continue;
    lineState[i] = anyPos ? 2 : 1;
    lineExec.push(i);
  }
  const execLines = lineExec.length;
  const covered = lineExec.filter((i) => lineState[i] === 2).length;

  const fns = (script.functions || []).filter((f) => {
    const len = f.ranges && f.ranges.length ? f.ranges[0].endOffset - f.ranges[0].startOffset : 0;
    return len > 0;                                // 忽略 V8 的空壳区间
  });
  const fnCalled = fns.filter((f) => (f.ranges[0] || {}).count > 0).length;

  const uncovered = lineExec
    .filter((i) => lineState[i] === 1)
    .map((i) => ({ line: i + 1, text: src.slice(starts[i], (i + 1 < nLines ? starts[i + 1] : src.length)).trim() }))
    .filter((x) => x.text && !x.text.startsWith('//') && !x.text.startsWith('*') && !x.text.startsWith('/*'));

  return { execLines, covered, uncovered, fns: fns.length, fnCalled, nLines, lineState, starts };
}

function mergeLineCov(acc, cur, nLines) {
  for (let i = 0; i < nLines; i++) {
    if (cur.lineState[i] === 2) acc[i] = 2;
    else if (cur.lineState[i] === 1 && acc[i] !== 2) acc[i] = 1;
  }
}

function betterAnalyze(scripts, src) {
  const starts = lineIndex(src);
  const nLines = starts.length;
  const merged = new Uint8Array(nLines);
  let fnTotal = 0, fnCalled = 0;
  const uncoveredMap = new Map();
  let seen = 0;
  scripts.forEach((script) => {
    seen++;
    const r = analyze(script, src);
    // 行：任一实例覆盖即算覆盖
    for (let i = 0; i < r.execLines.length; i++) {
      const li = r.execLines[i];
      merged[li] = merged[li] === 2 ? 2 : 1;
    }
    r.uncovered.forEach((u) => {
      if (!uncoveredMap.has(u.line)) uncoveredMap.set(u.line, u.text);
    });
    // 函数：取覆盖最全的那个实例
    if (r.fns > fnTotal || (r.fnCalled / Math.max(1, r.fns)) > (fnCalled / Math.max(1, fnTotal))) {
      fnTotal = r.fns; fnCalled = r.fnCalled;
    }
  });
  // 重新按「任一实例覆盖」判定
  scripts.forEach((script) => {
    const r = analyze(script, src);
    r.uncovered.forEach((u) => { /* 保留 */ });
    const coveredSet = new Set();
    for (let i = 0; i < r.execLines.length; i++) if (r.lineStateCompat && r.lineStateCompat[i] === 2) coveredSet.add(i);
  });
  // 简化：用每个脚本的 covered 行集合做并集
  const coveredLines = new Set();
  const execLines = new Set();
  scripts.forEach((script) => {
    const r = analyze(script, src);
    for (let i = 0; i < nLines; i++) {
      if (r.lineState[i] === 2) coveredLines.add(i);
    }
    if (r.lineStateProxy) { /* noop */ }
    r.uncovered.forEach(() => {});
  });
  // 需要 lineState，重新取一次
  const coveredFinal = new Set();
  const execFinal = new Set();
  scripts.forEach((script) => {
    const starts2 = lineIndex(src);
    const n2 = starts2.length;
    const counts = new Int32Array(src.length).fill(-1);
    const ranges = [];
    (script.functions || []).forEach((fn) => (fn.ranges || []).forEach((x) => ranges.push({ s: x.startOffset, e: x.endOffset, c: x.count })));
    ranges.sort((a, b) => (b.e - b.s) - (a.e - a.s));
    ranges.forEach((x) => { for (let i = Math.max(0, x.s); i < Math.min(src.length, x.e); i++) counts[i] = x.c; });
    for (let i = 0; i < n2; i++) {
      const s = starts2[i], e = i + 1 < n2 ? starts2[i + 1] : src.length;
      let any = false, anyPos = false;
      for (let j = s; j < e; j++) {
        const ch = src[j];
        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') continue;
        const c = counts[j];
        if (c < 0) continue;
        any = true;
        if (c > 0) { anyPos = true; break; }
      }
      if (!any) continue;
      execFinal.add(i);
      if (anyPos) coveredFinal.add(i);
    }
  });

  const uncovered = [];
  for (const i of execFinal) {
    if (coveredFinal.has(i)) continue;
    const s = starts[i], e = i + 1 < nLines ? starts[i + 1] : src.length;
    const text = src.slice(s, e).trim();
    if (!text || text.startsWith('//') || text.startsWith('*') || text.startsWith('/*')) continue;
    uncovered.push({ line: i + 1, text });
  }
  uncovered.sort((a, b) => a.line - b.line);

  return { execLines: execFinal.size, covered: coveredFinal.size, uncovered, fns: fnTotal, fnCalled, nLines, instances: seen };
}

app.whenReady().then(async () => {
  ipcMain.handle('app:version', () => PKG_VERSION);   // 测试主进程的 app.getVersion() 是 Electron 版本，这里回应用版本
  // v1.2.0/1.2.1 新增的 IPC：数据路径、托盘状态、关闭行为、复制
  ipcMain.handle('app:data-path', () => path.join(require('os').tmpdir(), 'dgjz-harness-coverage'));
  ipcMain.handle('app:tray', () => ({ hasTray: true, icon: { width: 16, height: 16 }, tooltip: 'coverage' }));
  ipcMain.on('win:close-behavior', () => {});
  ipcMain.on('app:copy', () => {});
  ipcMain.handle('holidays:fetch', () => ({ off: ['2026-11-26'], work: [] }));
  ipcMain.handle('data:export', () => ({ ok: true, path: path.join(ROOT, '.preview', 'cov-export.json') }));
  ipcMain.handle('data:import', () => {
    if (importMode === 'badjson') return { ok: true, json: '{{{ not json' };
    if (importMode === 'nofield') return { ok: true, json: JSON.stringify({ app: 'x', data: { salary: 8000 } }) };
    if (importMode === 'negsalary') return { ok: true, json: JSON.stringify({ app: 'x', data: { salary: -5, start: '09:00', end: '18:00' } }) };
    return { ok: true, json: JSON.stringify({ app: 'dagongren-jizhangqi', version: '1.7.0', data: { salary: 9000, start: '09:00', end: '18:00', lunchStart: '12:00', lunchEnd: '13:00', inited: true } }) };
  });
  ipcMain.on('win:pin', () => {});
  ipcMain.on('win:compact', () => {});
  ipcMain.on('win:minimize', () => {});
  ipcMain.on('win:close', () => {});

  win = new BrowserWindow({
    width: 424, height: 720, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, spellcheck: false
    }
  });
  win.setMenuBarVisibility(false);

  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await sleep(1200);

  dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Profiler.enable');
  await dbg.sendCommand('Profiler.startPreciseCoverage', { callCount: true, detailed: true });

/* v1.2.0 新增路径：首启闸门 / 默认值黄条 / 加班倍率 / 点×开关 / 复制路径 / 换目标 / 快捷键 */
async function flow3() {
  await R(`(() => { const c = JSON.parse(localStorage.getItem('${STORE}') || '{}');
    c.inited = false; c.confirmedByUser = false; c.clockFrom = 'click'; c.autoRun = false;
    localStorage.setItem('${STORE}', JSON.stringify(c)); location.reload(); return 'ok'; })()`);
  await sleep(1500);
  await R(`document.querySelector('#btnCloseSheet').click(); 'ok'`);      // 首启收起 → 弹确认
  await sleep(350);
  await R(`document.querySelector('#dlgCancel').click(); 'ok'`);          // 取消分支
  await sleep(250);
  await R(`document.querySelector('#btnCloseSheet').click(); 'ok'`);
  await sleep(350);
  await R(`document.querySelector('#dlgOk').click(); 'ok'`);              // 用默认值分支
  await sleep(700);
  await R(`document.querySelector('#defBar').click(); 'ok'`);             // 黄条 → 回设置
  await sleep(600);
  await R(`document.querySelector('#segOt button[data-ot="2"]').click(); 'ok'`);     // 倍率 2 倍
  await sleep(300);
  await R(`document.querySelector('#segClose button[data-close="quit"]').click(); 'ok'`);
  await sleep(300);
  await R(`document.querySelector('#segClose button[data-close="tray"]').click(); 'ok'`);
  await sleep(300);
  await R(`document.querySelector('#btnCopyPath').click(); 'ok'`);
  await sleep(300);
  await R(`document.querySelector('#btnSave').click(); 'ok'`);
  await sleep(600);
  if (await R(`!document.querySelector('#dlgMask').hidden`)) {
    await R(`document.querySelector('#dlgOk').click(); 'ok'`);
    await sleep(500);
  }
  // 目标达成 → 「换下一个目标」
  await R(`(() => { const c = JSON.parse(localStorage.getItem('${STORE}') || '{}');
    c.settled = 9000; c.confirmedByUser = true; localStorage.setItem('${STORE}', JSON.stringify(c));
    location.reload(); return 'ok'; })()`);
  await sleep(1500);
  await R(`document.querySelector('#btnNextGoal').click(); 'ok'`);
  await sleep(700);
  await R(`document.querySelector('#btnCloseSheet').click(); 'ok'`);
  await sleep(400);
  if (await R(`!document.querySelector('#dlgMask').hidden`)) {
    await R(`document.querySelector('#dlgCancel').click(); 'ok'`);
    await sleep(300);
  }
  // 快捷键：打卡 / 午休 / Esc / 下班
  await R(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); 'ok'`);
  await sleep(700);
  await R(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true })); 'ok'`);
  await sleep(500);
  await R(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 'ok'`);
  await sleep(300);
  await R(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); 'ok'`);
  await sleep(600);
}

  let fatal = null;
  try {
    await inject();
    await flow();
    await flow2();
    await flow3();
  } catch (e) {
    fatal = e;
    console.log('FATAL | ' + ((e && e.stack) || e));
  }

  const { result } = await dbg.sendCommand('Profiler.takePreciseCoverage');
  await dbg.sendCommand('Profiler.stopPreciseCoverage').catch(() => {});

  const srcApp = fs.readFileSync(SRC_APP, 'utf8');
  const appScripts = result.filter((s) => String(s.url).endsWith('/src/app.js') || String(s.url).endsWith('app.js'));
  const preScripts = result.filter((s) => String(s.url).endsWith('preload.js'));

  const appCov = betterAnalyze(appScripts, srcApp);
  let preCov = null;
  if (preScripts.length) {
    const srcPre = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    preCov = betterAnalyze(preScripts, srcPre);
  }

  const pct = (c, t) => (t ? ((c / t) * 100).toFixed(1) : '0.0');
  console.log('COV-APP | lines ' + appCov.covered + '/' + appCov.execLines + ' = ' + pct(appCov.covered, appCov.execLines) + '%'
    + ' | functions ' + appCov.fnCalled + '/' + appCov.fns + ' = ' + pct(appCov.fnCalled, appCov.fns) + '%'
    + ' | instances=' + appCov.instances);
  if (preCov) console.log('COV-PRE | lines ' + preCov.covered + '/' + preCov.execLines + ' = ' + pct(preCov.covered, preCov.execLines) + '%');
  console.log('UNCOVERED-COUNT | ' + appCov.uncovered.length);
  appCov.uncovered.slice(0, 80).forEach((u) => console.log('UNCOV | L' + u.line + ' | ' + u.text.slice(0, 110)));

  const lines = [];
  lines.push('# 测试报告 · 白盒覆盖率（打工人记账器 v' + PKG_VERSION + '）', '');
  lines.push('- 采集方式：CDP `Profiler.startPreciseCoverage`（V8 精确覆盖率，callCount + detailed）');
  lines.push('- 采集对象：渲染层 `src/app.js`、`preload.js`（主进程 `main.js` 由打包版 9 项冒烟覆盖行为）');
  lines.push('- 采集时间：' + new Date().toLocaleString('zh-CN'));
  lines.push('- 业务流：首启 → 设置全项 → 打卡/午休/请假/补录/下班/撤销 → 清零 → 定点 → 全自动夜班 → 导出导入各分支 → 节假日 → 回到首次', '');
  lines.push('## 覆盖结果', '');
  lines.push('| 文件 | 行覆盖 | 函数覆盖 | 脚本实例数 |', '|---|---|---|---|');
  lines.push('| src/app.js | ' + appCov.covered + '/' + appCov.execLines + ' = **' + pct(appCov.covered, appCov.execLines) + '%** | '
    + appCov.fnCalled + '/' + appCov.fns + ' = **' + pct(appCov.fnCalled, appCov.fns) + '%** | ' + appCov.instances + ' |');
  if (preCov) lines.push('| preload.js | ' + preCov.covered + '/' + preCov.execLines + ' = **' + pct(preCov.covered, preCov.execLines) + '%** | '
    + preCov.fnCalled + '/' + preCov.fns + ' | ' + preCov.instances + ' |');
  lines.push('', '## 未覆盖行（' + appCov.uncovered.length + ' 行）', '');
  if (!appCov.uncovered.length) lines.push('无。');
  else {
    lines.push('| 行号 | 代码 |', '|---|---|');
    appCov.uncovered.forEach((u) => lines.push('| ' + u.line + ' | `' + u.text.replace(/\|/g, '\\|').slice(0, 120) + '` |'));
  }
  if (fatal) lines.push('', '## 执行异常', '', '```', String((fatal && fatal.message) || fatal), '```');
  fs.writeFileSync(REPORT, lines.join('\n') + '\n', 'utf8');
  console.log('REPORT | ' + REPORT);

  app.exit(0);
});
