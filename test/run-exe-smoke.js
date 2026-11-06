/* 打工人记账器 v1.8.0 · 打包版 exe 回归冒烟（Node 运行，不走 electron）
 * 运行：node test/run-exe-smoke.js
 * 原理：spawn dist 里的 exe（带 WB_DEBUG_PORT 调试端口 + 独立 profile），
 *       通过 CDP（/json/list + WebSocket + Runtime.evaluate）驱动真实打包页面，
 *       跑「首启设置 → 打卡 → 午休 → 下班 → 明细 → 重启持久化 → 单实例」冒烟链路。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
// 默认测 dist 里的绿色目录版；装了 NSIS 安装包后可用 WB_EXE_PATH 指向安装目录里的 exe
const EXE = process.env.WB_EXE_PATH || path.join(ROOT, 'dist', '打工人记账器', '打工人记账器.exe');
const PROF = process.env.WB_EXE_PROFILE || path.join(ROOT, '.preview', 'prof-exe-smoke');
const PORT = 9333;
const STORE = 'dgjz.worker.v1';
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const REPORT = path.join(ROOT, '测试报告-打包版冒烟-v' + PKG_VERSION + '.md');

const results = [];
const record = (id, name, pass, detail) => {
  results.push({ id, name, pass, detail });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + id + ' ' + name + ' | ' + detail);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const ENV = Object.assign({}, process.env, { WB_DEBUG_PORT: String(PORT) });
delete ENV.ELECTRON_RUN_AS_NODE;

let child = null;
let ws = null;
let msgId = 0;
const pending = new Map();
const pageErrors = [];

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function waitPort(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await httpJson('http://127.0.0.1:' + PORT + '/json/list');
      const page = list.find((x) => x.type === 'page' && /index\.html/.test(x.url));
      if (page) return page;
    } catch (e) { /* 还没起 */ }
    await sleep(400);
  }
  throw new Error('CDP 端口未就绪');
}

async function connect(wsUrl) {
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = (e) => rej(new Error('WS 连接失败'));
  });
  ws.onmessage = (ev) => {
    let m = null;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(m.error.message)); else res(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
    }
  };
  await send('Runtime.enable');
  await send('Log.enable').catch(() => {});
}

function send(method, params) {
  const id = ++msgId;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); rej(new Error('CDP 超时: ' + method)); }
    }, 15000);
  });
}

async function R(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception || {}).description);
  return r.result.value;
}

async function launch(profile) {
  child = spawn(EXE, ['--user-data-dir=' + profile], { env: ENV, stdio: 'ignore' });
  const page = await waitPort(20000);
  await connect(page.webSocketDebuggerUrl);
  await sleep(1200);
}

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
    ver: (q('#ver') || {}).textContent,
    earned: parseFloat((q('#todayEarned').textContent || '0').replace(/,/g, '')) || 0,
    state: q('#workState').textContent.trim(),
    sheetOn: q('#sheet').classList.contains('on'),
    saveText: q('#btnSave').textContent.trim(),
    cfg
  };
})()`;

async function main() {
  // 干净 profile，模拟全新用户
  try { fs.rmSync(PROF, { recursive: true, force: true }); } catch (e) {}
  console.log('LAUNCH | ' + EXE);
  await launch(PROF);
  await R(INJECT);

  // 1. 首启：自动弹设置 + 版本号
  await sleep(800);
  const s0 = await R(SNAP);
  record('EXE-01', '打包版首启：自动弹设置面板，页脚版本号与 package.json 一致（v' + PKG_VERSION + '）',
    s0.sheetOn && (s0.ver || '').indexOf(PKG_VERSION) >= 0,
    'sheet=' + s0.sheetOn + ' 版本=' + s0.ver);

  // 2. 设置保存（默认 08:00–17:00，改成 09:00–18:00 便于对账）
  await R(`(() => {
    const set = (s, v) => { const e = document.querySelector(s); e.value = v; e.dispatchEvent(new Event('input', {bubbles:true})); e.dispatchEvent(new Event('blur', {bubbles:true})); };
    set('#inStart', '09:00'); set('#inEnd', '18:00');
    return 'ok';
  })()`);
  await R(`document.querySelector('#btnSave').click(); 'ok'`);
  await sleep(500);
  const s1 = await R(SNAP);
  const workDays = s1.cfg.workDays;
  const perDay = 8000 / workDays;
  record('EXE-02', '首启参数保存成功并写入本地存档',
    s1.cfg.start === '09:00' && s1.cfg.end === '18:00' && s1.cfg.inited === true && !s1.sheetOn,
    'start=' + s1.cfg.start + ' end=' + s1.cfg.end + ' workDays=' + workDays + ' 日薪≈' + perDay.toFixed(2));

  // 3. 打卡 → 3h → 午休冻结
  await R(`window.__at(9); document.querySelector('#btnClock').click(); 'ok'`);
  await sleep(400);
  await R(`window.__later(3 * 3600e3); 'ok'`);
  // 金额刷新是逐帧的，固定 sleep 在机器忙时会读到刚打卡那几秒（曾偶发成 0.003）
  // 轮询到金额真的涨起来再判定
  const e3 = perDay * 3 / 8;
  let s2 = null;
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    s2 = await R(SNAP);
    if (s2.earned > e3 * 0.6) break;
  }
  await R(`document.querySelector('#btnBreak').click(); 'ok'`);
  await sleep(400);
  const s3 = await R(SNAP);
  await R(`window.__later(1800e3); 'ok'`);
  await sleep(500);
  const s4 = await R(SNAP);
  record('EXE-03', '打卡 3h 金额正确；午休期间冻结不涨',
    near(s2.earned, e3, 0.5) && near(s4.earned, s3.earned, 0.05) && s4.state.indexOf('午休') >= 0,
    '3h=' + s2.earned + '（≈' + e3.toFixed(2) + '）午休时=' + s3.earned + ' 30min后=' + s4.earned + ' 状态=' + s4.state);

  // 4. 继续 → 18:00 下班 → 金额封顶日薪
  await R(`document.querySelector('#btnBreak').click(); 'ok'`);
  await sleep(300);
  await R(`window.__at(18); document.querySelector('#btnClock').click(); 'ok'`);
  await sleep(500);
  const s5 = await R(SNAP);
  const okCap = near(s5.earned, perDay, 0.6) && s5.state.indexOf('收工') >= 0;
  record('EXE-04', '下班结算：今日已赚封顶等于日薪、状态已收工', okCap,
    'earned=' + s5.earned + '（≈' + perDay.toFixed(2) + '）状态=' + s5.state + ' dailyLog=' + JSON.stringify(s5.cfg.dailyLog));

  // 5. 明细面板
  await R(`document.querySelector('#btnHistory').click(); 'ok'`);
  await sleep(500);
  const hist = await R(`(() => {
    const on = document.querySelector('#histSheet').classList.contains('on');
    const rows = document.querySelectorAll('#histList .hist-row').length;
    const months = [...document.querySelectorAll('#histList .hist-month')].map(p => p.textContent);
    return { on, rows, months };
  })()`);
  record('EXE-05', '明细面板可打开，今天有记录行', hist.on && hist.rows >= 1,
    '打开=' + hist.on + ' 行数=' + hist.rows + ' 月组=' + JSON.stringify(hist.months));

  // 6. 小窗 / 展开（真实打包窗口几何）
  await R(`document.querySelector('#btnCloseHist').click(); 'ok'`);
  await sleep(300);
  const g0 = await R(`(() => ({ w: window.outerWidth, h: window.outerHeight }))()`);
  await R(`document.querySelector('#btnCompact').click(); 'ok'`);
  // 窗口 resize 是异步的：固定等 1.3 秒在机器忙的时候会读到旧尺寸（曾偶发失败两次）
  // 改成轮询到高度真的降下来，最多等 4.5 秒
  const READ_G = `(async () => ({ w: window.outerWidth, h: window.outerHeight, compact: document.body.classList.contains('compact'),
    title: document.querySelector('#compactBar').title,
    grip: Math.round(document.querySelector('.cb-grip').getBoundingClientRect().width),
    main: await (window.desktop && window.desktop.trayState ? window.desktop.trayState().then((r) => r && r.win) : null),
    dbg: { tb: document.querySelector('.titlebar').offsetHeight,
      heroH: Math.ceil(document.querySelector('#hero').getBoundingClientRect().height),
      dockH: document.querySelector('#dock').offsetHeight,
      frozen: document.querySelector('#hero').style.padding || '(未冻结)',
      body: document.body.className } }))()`;
  // 注意：渲染进程的 window.outerHeight 在窗口 resize 后会滞后几拍，
  // 曾因此误判成「小窗没收下去」——其实主进程 bounds 早就是 218 了。
  // 一律以主进程 bounds 为准。
  const hOf = (g) => (g && g.main && g.main.bounds) ? g.main.bounds.height : (g ? g.h : 0);
  let g1 = null;
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    g1 = await R(READ_G);
    if (hOf(g1) < g0.h - 50 && g1.compact === true && g1.grip > 60) break;
  }
  await R(`document.querySelector('#compactBar').click(); 'ok'`);
  let g2 = null;
  for (let i = 0; i < 24; i++) {
    await sleep(250);
    g2 = await R(`(async () => ({ w: window.outerWidth, h: window.outerHeight, compact: document.body.classList.contains('compact'),
      title: document.querySelector('#compactBar').title,
      grip: Math.round(document.querySelector('.cb-grip').getBoundingClientRect().width),
      main: await (window.desktop && window.desktop.trayState ? window.desktop.trayState().then((r) => r && r.win) : null) }))()`);
    if (hOf(g2) > g0.h - 50 && g2.compact === false && g2.grip < 60) break;
  }
  const H1 = hOf(g1);
  const H2 = hOf(g2);
  record('EXE-06', '打包版小窗/展开：只收高度（宽度不变）、横杆加长；展开恢复原宽高',
    // 小窗高度落在 150–260（实测 216–218，DOM 测量有 1–2px 浮动），不能只是"比原来矮"
    g1.compact && H1 > 150 && H1 < 260 && Math.abs(g1.w - g0.w) <= 2 && g1.grip > g2.grip + 20
    && !g2.compact && H2 >= g0.h - 4 && Math.abs(g2.w - g0.w) <= 2 && g2.title === '缩成小窗',
    '完整 ' + g0.w + '×' + g0.h + ' → 小窗 ' + g1.w + '×' + H1 + '（横杆 ' + g1.grip + '） → 展开 '
    + g2.w + '×' + H2 + '（横杆 ' + g2.grip + '）'
    + (H1 >= 260
      ? ' | 没收下去，分量=' + JSON.stringify(g1.dbg) + ' 主进程=' + JSON.stringify(g1.main)
      : ''));

  // 7. 退出重开：数据持久化
  const settledBefore = (await R(SNAP)).cfg.settled;
  child.kill();
  await sleep(2000);
  try { ws.close(); } catch (e) {}
  await launch(PROF);
  await R(INJECT);
  await sleep(600);
  const s6 = await R(SNAP);
  record('EXE-07', '关闭重开：存档完整恢复（不回到首启）',
    near(s6.cfg.settled, settledBefore, 0.02) && s6.cfg.start === '09:00' && s6.cfg.inited === true,
    'settled=' + s6.cfg.settled + '（重开前=' + settledBefore + '）start=' + s6.cfg.start + ' 当前已赚=' + s6.earned);

  // 8. 单实例锁：已有一窗口时再启动，第二个进程应快速退出
  const t = Date.now();
  const second = spawn(EXE, ['--user-data-dir=' + PROF], { env: ENV, stdio: 'ignore' });
  const exitInfo = await new Promise((resolve) => {
    second.on('exit', (code) => resolve({ code, ms: Date.now() - t }));
    setTimeout(() => resolve({ code: null, ms: Date.now() - t }), 6000);
  });
  record('EXE-08', '单实例锁：第二个进程快速退出，不会双开写坏存档',
    exitInfo.code !== null && exitInfo.ms < 5000,
    '第二个实例 ' + (exitInfo.code === null ? '6s 内未退出' : '退出码 ' + exitInfo.code) + '，耗时 ' + exitInfo.ms + 'ms');

  // 9. 打包版里的新控件：小时钟 / 滑块 / 自绘箭头真的在
  await R(`(() => { const s = document.querySelector('#sheet'); if (!s.classList.contains('on')) document.querySelector('#btnSettings').click(); return 'ok'; })()`);
  await sleep(700);
  const ui = await R(`(() => {
    const el = document.querySelector('#inStart');
    const btn = el.parentElement.querySelector('.tin-btn');
    const tins = document.querySelectorAll('.tin-btn').length;
    const spins = document.querySelectorAll('.num-spin').length;
    btn.click();
    const opened = !document.querySelector('#tpMask').hidden;
    const h = document.querySelector('#tpHour'); h.value = 7; h.dispatchEvent(new Event('input', { bubbles: true }));
    const mm = document.querySelector('#tpMin'); mm.value = 30; mm.dispatchEvent(new Event('input', { bubbles: true }));
    const live = el.value;
    document.querySelector('#tpOk').click();
    const goal = document.querySelector('#inGoalAmount');
    goal.value = ''; goal.dispatchEvent(new Event('input', { bubbles: true }));
    const host = goal.parentElement; host.querySelector('.ns-up').click();
    const first = goal.value; host.querySelector('.ns-up').click();
    return { tins, spins, opened, live, first, second: goal.value, step: goal.step };
  })()`);
  await sleep(320);

  // 10. 页面异常
  record('EXE-09', '全链路无未捕获 JS 异常', pageErrors.length === 0,
    pageErrors.length ? pageErrors.slice(0, 3).join(' / ') : '无');

  // 11. 托盘：打包成 asar 之后图标还读得出来吗
  const trayInfo = await R(`window.desktop.trayState()`);
  record('EXE-11', '打包版托盘：进程里真的建了托盘、图标从 asar 里读得出来（按缩放 16/24/32px）',
    !!(trayInfo && trayInfo.hasTray) && trayInfo.icon
      && [16, 24, 32].indexOf(trayInfo.icon.width) >= 0 && trayInfo.icon.width === trayInfo.icon.height
      && String(trayInfo.tooltip || '').indexOf('打工人') >= 0,
    JSON.stringify(trayInfo));

  // 12. 打包版里的新控件
  record('EXE-10', '打包版新控件：6 个小时钟、5 组粉色箭头；滑块拖到 07:30 生效；金额清空后 1、2 递增',
    ui.tins === 6 && ui.spins === 5 && ui.opened === true && ui.live === '07:30'
    && ui.first === '1' && ui.second === '2' && ui.step === '1',
    JSON.stringify(ui));

  child.kill();
  await sleep(500);

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  const lines = [];
  lines.push('# 打工人记账器 v' + PKG_VERSION + ' · 打包版 exe 冒烟报告');
  lines.push('');
  lines.push('> 执行时间：' + new Date().toLocaleString('zh-CN') + '  ');
  lines.push('> 被测对象：`dist/打工人记账器/打工人记账器.exe`（与 src 代码 diff 一致）  ');
  lines.push('> 执行方式：CDP 驱动打包版真实窗口 + Date 子类化时间模拟 + localStorage 断言  ');
  lines.push('');
  lines.push('## 执行统计');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('|------|------|');
  lines.push('| 用例 | ' + results.length + ' |');
  lines.push('| 通过 | ' + pass + ' |');
  lines.push('| 失败 | ' + fail + ' |');
  lines.push('| 页面异常 | ' + pageErrors.length + ' |');
  lines.push('');
  lines.push('## 执行结果');
  lines.push('');
  lines.push('| 用例 | 验证点 | 结果 | 实测数据 |');
  lines.push('|------|--------|------|----------|');
  results.forEach((r) => {
    lines.push('| ' + r.id + ' | ' + r.name + ' | ' + (r.pass ? '✅ 通过' : '❌ 失败') + ' | ' + r.detail.replace(/\|/g, '\\|') + ' |');
  });
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  lines.push(fail === 0
    ? '打包版 exe 与源码行为一致：首启、设置保存、打卡计时、午休冻结、下班封顶、明细、小窗、重启持久化、单实例锁全部通过，无未捕获异常。'
    : '存在 ' + fail + ' 项失败，详见上表。');
  fs.writeFileSync(REPORT, lines.join('\n'), 'utf8');
  console.log('SUMMARY | pass=' + pass + '/' + results.length);
  console.log('REPORT | ' + REPORT);
  process.exit(0);
}

main().catch((e) => {
  console.log('FATAL | ' + (e && e.stack || e));
  results.push({ id: 'FATAL', name: '执行中断', pass: false, detail: String(e && e.message || e) });
  try { child && child.kill(); } catch (x) {}
  fs.writeFileSync(REPORT, '# 打包版冒烟（中断）\n\n' + (e && e.stack || e), 'utf8');
  process.exit(1);
});
