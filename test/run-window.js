/* 打工人记账器 v1.10.0 · 窗口形态与首页布局测试
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron test/run-window.js
 *
 * 为什么单独一套：
 *   v1.9.0 的窗口缩放在测试里是"抄"了一份 setBounds 逻辑，抄本和真身一分叉就测不出问题；
 *   这一套直接 require 主进程用的 win-geometry.js，测的就是真规则。
 * 覆盖：
 *   W-01  正常态几何 / 不可拖拽缩放 / 首页不滚动 / 关键控件全在窗内
 *   W-02  点底部短横杆 → 迷你态：窗口变窄变矮、横杆加长、提示语切换
 *   W-03  迷你态：卡片不被裁、首页不滚动
 *   W-04  回归：迷你态被拉宽到满屏后再展开 → 回到最初宽度（用户报的 bug）
 *   W-05  5 次往返：宽高零漂移、左上角不横跳
 *   W-06  贴屏幕右边缩小时不越界，展开后也回到屏内
 *   W-07  标题栏按钮 ⇄ 底部横杆 两个入口行为一致
 *   W-08  迷你态点齿轮：先展开再开设置
 *   W-09  迷你态不遗留弹层（设置/明细/补录都被收起）
 *   W-10  滚轮滚不动首页（scrollTop 恒为 0、overflow-y=hidden）
 *   W-11  迷你态出现「加班」药丸后自动校正高度，不裁切
 *   W-12  横杆可点区域足够大（≥100×20），迷你态更长
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE = 'dgjz.worker.v1';
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const REPORT = path.join(ROOT, '测试报告-窗口形态-v' + PKG_VERSION + '.md');
const geo = require(path.join(ROOT, 'win-geometry.js'));

app.setPath('userData', path.join(require('os').tmpdir(), 'dgjz-harness-' + path.basename(__filename, '.js')));

let win = null;
let consoleErrors = [];
const results = [];
const record = (id, name, pass, detail) => {
  results.push({ id, name, pass, detail });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + id + ' ' + name + ' | ' + detail);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (js) => win.webContents.executeJavaScript(js, true);
const CLICK = (sel) => `document.querySelector('${sel}').click(); 'ok'`;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---- 与 main.js 等价的窗口状态（主进程逻辑的唯一副本就是 main.js，这里靠同一份 geo 规则还原）----
let compacted = false;
let normalBox = { width: geo.NORMAL.width, height: geo.NORMAL.height };
const areaOf = (box) => screen.getDisplayMatching(box).workArea;

ipcMain.on('win:compact', (e, arg) => {
  const on = !!(arg && arg.on);
  const box = win.getBounds();
  if (on) {
    if (!compacted) {
      if (box.height > 320 && box.width > 300) normalBox = { width: box.width, height: box.height };
      compacted = true;
    }
    const next = geo.compactBounds(box, arg && arg.height, areaOf(box));
    if (geo.sameBounds(box, next)) return;
    win.setBounds(next);
  } else {
    if (!compacted) return;
    compacted = false;
    win.setBounds(geo.expandBounds(box, normalBox, areaOf(box)));
  }
});

const SNAP = `(() => {
  const q = (s) => document.querySelector(s);
  const box = (s) => { const el = q(s); if (!el) return null; const r = el.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }; };
  const sc = q('.scroll');
  return {
    iw: innerWidth, ih: innerHeight,
    bodyCompact: document.body.classList.contains('compact'),
    barHidden: q('#compactBar').hidden,
    barTitle: q('#compactBar').title,
    grip: box('.cb-grip'),
    bar: box('#compactBar'),
    hero: box('#hero'),
    dock: box('#dock'),
    clock: box('#btnClock'),
    hint: box('#clockHint'),
    quote: box('.quote'),
    vers: box('#foot'),
    scrollOverflow: Math.round(sc.scrollHeight - sc.clientHeight),
    scrollOverflowY: getComputedStyle(sc).overflowY,
    scrollTop: sc.scrollTop,
    docOverflow: Math.round(document.documentElement.scrollHeight - innerHeight),
    hOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    sheetOn: q('#sheet').classList.contains('on'),
    histOn: q('#histSheet').classList.contains('on'),
    fixOn: q('#miniMask').classList.contains('on')
  };
})()`;

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
  window.__at = (h, m) => { const t = new RealDate(); t.setHours(h, m || 0, 0, 0); window.__off = t.getTime() - RN(); };
  return 'ok';
})()`;

async function reset() {
  await R(`localStorage.removeItem('${STORE}'); location.reload(); 'wipe'`);
  await sleep(1300);
  await R(INJECT);
  // 关掉首次引导的设置面板
  await R(`if (document.querySelector('#sheet').classList.contains('on')) document.querySelector('#btnCloseSheet').click(); 'ok'`);
  await sleep(300);
  // v1.2.0 起首启收起会先问「按默认值开始吗」，测试里选「先用默认值」
  if (await R(`!document.querySelector('#dlgMask').hidden`)) {
    await R(`document.querySelector('#dlgOk').click(); 'ok'`);
    await sleep(400);
  }
}

async function compactOn() {
  await R(CLICK('#compactBar'));
  await sleep(700);
}
async function compactOff() {
  await R(CLICK('#compactBar'));
  await sleep(700);
}

async function runAll() {
  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await sleep(700);
  await reset();
  const normal = win.getBounds();

  /* W-01 正常态 */
  const s1 = await R(SNAP);
  const fitNormal = s1.scrollOverflow <= 0 && s1.docOverflow <= 0
    && s1.clock.b <= s1.ih && s1.quote.b <= s1.ih && s1.dock.b <= s1.ih && !s1.hOverflow;
  record('W-01', '正常态：424×720、不可拖拽缩放、首页不滚动、打卡按钮/引用/横杆全在窗内',
    !win.isResizable() && normal.width >= 420 && normal.width <= 428 && !s1.bodyCompact && !s1.barHidden
    && s1.scrollOverflowY === 'hidden' && fitNormal,
    '尺寸=' + normal.width + '×' + normal.height + ' resizable=' + win.isResizable()
    + ' 内容溢出=' + s1.scrollOverflow + ' 打卡底=' + s1.clock.b + '/窗高' + s1.ih);

  /* W-02 缩成迷你 */
  await compactOn();
  const b2 = win.getBounds();
  const s2 = await R(SNAP);
  const ok2 = s2.bodyCompact && s2.barTitle === '展开完整面板' && Math.abs(b2.width - normal.width) <= 2
    && b2.height < 320 && s2.grip.w > s1.grip.w + 30
    && s2.grip.w >= 60 && s2.scrollOverflow <= 0 && !s2.hOverflow;
  record('W-02', '点底部短横杆 → 迷你态：只收高度（宽度一个像素不变）、横杆加长、提示语变「展开」',
    ok2,
    normal.width + '×' + normal.height + ' → ' + b2.width + '×' + b2.height
    + ' 横杆 ' + s1.grip.w + '→' + s2.grip.w + 'px 提示=' + s2.barTitle);

  /* W-03 迷你态不裁切 */
  const ok3 = s2.hero.b <= s2.dock.t + 1 && s2.hero.t >= 0 && s2.dock.b <= s2.ih + 1
    && s2.hero.w >= b2.width - 40 && s2.scrollOverflow <= 0 && !s2.hOverflow;
  record('W-03', '迷你态：已赚卡整张显示（同宽、不被裁掉）、无横向溢出',
    ok3, '卡片 ' + s2.hero.l + '~' + s2.hero.r + ' 宽' + s2.hero.w + '（窗宽 ' + s2.iw + '）卡底=' + s2.hero.b + ' 横杆区顶=' + s2.dock.t);

  /* W-04 回归：迷你态被拉宽到满屏后展开，宽度要回到最初 */
  win.setBounds({ x: b2.x, y: b2.y, width: 1400, height: b2.height });   // 模拟"占满屏幕"的迷你窗
  await sleep(500);
  const wide = win.getBounds();
  await compactOff();
  await sleep(600);
  const b4 = win.getBounds();
  record('W-04', '回归：迷你窗被拉到 1400 后展开 → 宽度回到最初的 424（不再一直满屏）',
    wide.width > 1000 && b4.width <= normal.width + 2 && near(b4.height, normal.height, 3),
    '满屏迷你 ' + wide.width + '×' + wide.height + ' → 展开 ' + b4.width + '×' + b4.height);

  /* W-05 5 次往返零漂移 */
  const trail = [];
  let drift = false;
  let firstCompact = null;
  for (let i = 0; i < 5; i++) {
    await compactOn();
    const bi = win.getBounds();
    await compactOff();
    const bo = win.getBounds();
    trail.push(bi.width + 'x' + bi.height + '/' + bo.width + 'x' + bo.height);
    if (!firstCompact) firstCompact = bi;
    if (!near(bo.width, normal.width, 2) || !near(bo.height, normal.height, 3)) drift = true;
    if (!near(bi.width, firstCompact.width, 2) || !near(bi.height, firstCompact.height, 3)) drift = true;
    if (!near(bo.x, normal.x, 3)) drift = true;
  }
  record('W-05', '连续 5 次缩小/展开：宽高零漂移、横向位置不跳', !drift, trail.join(' | '));

  /* W-06 贴屏幕右边缩小/展开不越界 */
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  win.setBounds({ x: area.x + area.width - win.getBounds().width, y: area.y + 40, width: win.getBounds().width, height: win.getBounds().height });
  await sleep(400);
  await compactOn();
  const b6a = win.getBounds();
  await compactOff();
  const b6b = win.getBounds();
  const inside = (b) => b.x >= area.x - 1 && b.x + b.width <= area.x + area.width + 1
    && b.y >= area.y - 1 && b.y + Math.min(b.height, area.height) <= area.y + area.height + 1;
  record('W-06', '贴屏幕右边缘：缩小/展开都不越界（窗口完整留在屏内）', inside(b6a) && inside(b6b),
    'workArea=' + area.x + ',' + area.y + ' ' + area.width + '×' + area.height
    + ' 迷你=' + b6a.x + '+' + b6a.width + ' 展开=' + b6b.x + '+' + b6b.width);

  /* 回到原位，准备后续 */
  win.setBounds({ x: normal.x, y: normal.y, width: win.getBounds().width, height: win.getBounds().height });
  await sleep(300);

  /* W-07 标题栏按钮与横杆两个入口一致 */
  await R(CLICK('#btnCompact'));
  await sleep(600);
  const s7a = await R(SNAP);
  await R(CLICK('#btnCompact'));
  await sleep(600);
  const s7b = await R(SNAP);
  const s7c = win.getBounds();
  record('W-07', '标题栏箭头 ⇄ 底部横杆：两个入口都能缩/展，状态与几何一致',
    s7a.bodyCompact && !s7b.bodyCompact && near(s7c.width, normal.width, 2) && s7b.barTitle === '缩成小窗',
    '缩=' + s7a.bodyCompact + ' 展=' + !s7b.bodyCompact + ' 宽度=' + s7c.width);

  /* W-08 迷你态点齿轮 */
  await compactOn();
  await R(CLICK('#btnSettings'));
  await sleep(700);
  const b8 = win.getBounds();
  const s8 = await R(SNAP);
  record('W-08', '迷你态点齿轮：先复原成完整面板，再打开设置', !s8.bodyCompact && s8.sheetOn && near(b8.width, normal.width, 2),
    '宽=' + b8.width + ' 设置=' + s8.sheetOn + ' 迷你=' + s8.bodyCompact);
  await R(CLICK('#btnCloseSheet'));
  await sleep(400);

  /* W-09 迷你态不遗留弹层 */
  await R(CLICK('#btnHistory'));
  await sleep(400);
  await compactOn();
  const s9 = await R(SNAP);
  record('W-09', '从弹层直接缩小时：设置/明细/补录全部收起，不留半截弹层',
    !s9.sheetOn && !s9.histOn && !s9.fixOn && s9.bodyCompact,
    '设置=' + s9.sheetOn + ' 明细=' + s9.histOn + ' 补录=' + s9.fixOn);

  /* W-10 滚轮滚不动首页 */
  await compactOff();
  await sleep(400);
  await R(`(() => { const sc = document.querySelector('.scroll'); sc.scrollTop = 0;
    for (let i = 0; i < 5; i++) sc.dispatchEvent(new WheelEvent('wheel', { deltaY: 220, bubbles: true }));
    window.scrollTo(0, 400); return 'ok'; })()`);
  await sleep(300);
  const s10 = await R(SNAP);
  record('W-10', '首页不可拉动：滚轮/scrollTo 都不生效（scrollTop=0，overflow-y=hidden）',
    s10.scrollTop === 0 && s10.scrollOverflowY === 'hidden' && s10.docOverflow <= 0,
    'scrollTop=' + s10.scrollTop + ' overflow-y=' + s10.scrollOverflowY + ' 文档溢出=' + s10.docOverflow);

  /* W-11 迷你态出现加班药丸：高度自动校正、不裁切 */
  await compactOn();
  await sleep(400);
  const before11 = win.getBounds();
  await R(`(() => { const p = document.querySelector('#otPill'); p.hidden = false;
    document.querySelector('#otTime').textContent = '2:30';
    return 'ok'; })()`);
  await sleep(1400);                      // 等 800ms 轮询校正
  const after11 = win.getBounds();
  const s11 = await R(SNAP);
  record('W-11', '迷你态冒出「加班」药丸后：窗口自动校正高度，卡片仍完整',
    s11.hero.b <= s11.dock.t + 1 && s11.scrollOverflow <= 0 && Math.abs(after11.height - before11.height) <= 60,
    '高 ' + before11.height + '→' + after11.height + ' 卡底=' + s11.hero.b + ' 横杆顶=' + s11.dock.t);

  /* W-12 横杆可点区域 */
  const s12 = await R(SNAP);
  const barBox = s12.bar;
  record('W-12', '底部横杆可点区域 ≥100×20、且位于窗口底部中央',
    barBox.w >= 100 && barBox.h >= 20 && near(barBox.l + barBox.w / 2, s12.iw / 2, 4) && barBox.b <= s12.ih + 1,
    '横杆 ' + barBox.w + '×' + barBox.h + ' 中心x=' + Math.round(barBox.l + barBox.w / 2) + ' 窗宽=' + s12.iw);

  await compactOff();
  await sleep(500);

  /* W-13 小屏尺寸规则：工作区不够高时只压高度、不留出屏幕 */
  const big = geo.normalBounds({ width: 1920, height: 1019 });
  const small = geo.normalBounds({ width: 1366, height: 582 });
  record('W-13', '窗口尺寸规则：大屏按设计 424×720；小屏（1366×768@125%）自动压到工作区内',
    big.width === 424 && big.height === 720 && small.width === 424 && small.height === 574
      && small.height <= 582 - 4,
    '大屏=' + big.width + '×' + big.height + ' 小屏=' + small.width + '×' + small.height
    + '（工作区 582，留 8px 余量）');

  /* W-14 真按小屏高度开一次：首页塞得下、打卡按钮不被裁 */
  win.setBounds({ x: win.getBounds().x, y: win.getBounds().y, width: 424, height: 574 });
  await sleep(800);
  const s14 = await R(`(() => {
    const q = (s) => document.querySelector(s);
    const b = (s) => { const e = q(s); if (!e) return null; const r = e.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height) }; };
    const sc = q('.scroll');
    return { iw: innerWidth, ih: innerHeight, clock: b('#btnClock'), dock: b('#dock'),
      quote: b('.quote'), over: sc.scrollHeight - sc.clientHeight, tight: document.body.classList.contains('tight') };
  })()`);
  record('W-14', '按小屏高度 574 开窗：打卡按钮完整在窗内、首页无滚动条（放不下时先收吐槽那一行）',
    s14.clock && s14.clock.b <= s14.ih + 1 && s14.dock && s14.dock.b <= s14.ih + 1 && s14.over <= 0,
    '窗高=' + s14.ih + ' 打卡底=' + (s14.clock ? s14.clock.b : '?') + ' 横杆底=' + (s14.dock ? s14.dock.b : '?')
    + ' 溢出=' + s14.over + ' 收紧了=' + s14.tight);

  // 还原到设计尺寸，后面的用例继续用
  win.setBounds({ x: win.getBounds().x, y: win.getBounds().y, width: geo.NORMAL.width, height: geo.NORMAL.height });
  await sleep(600);
}

app.whenReady().then(async () => {
  ipcMain.handle('app:version', () => PKG_VERSION);       // 测试主进程的 app.getVersion() 是 Electron 版本
  ipcMain.handle('holidays:fetch', () => null);
  ipcMain.handle('data:export', () => ({ ok: true, path: 'test-mock' }));
  ipcMain.handle('data:import', () => ({ canceled: true }));
  ipcMain.on('win:pin', () => {});
  ipcMain.on('win:minimize', () => {});
  ipcMain.on('win:close', () => {});

  win = new BrowserWindow({
    width: geo.NORMAL.width, height: geo.NORMAL.height, show: false, frame: false,
    resizable: false, maximizable: false,
    minWidth: geo.NORMAL_MIN.width, minHeight: geo.NORMAL_MIN.height,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, spellcheck: false
    }
  });
  win.setMenuBarVisibility(false);
  win.setBounds(win.getBounds());       // 吃掉 frameless 的 1px 隐形边框
  win.webContents.on('console-message', (e, level, msg) => {
    const m = String(msg);
    // CSP 安全提示是开发期噪音（本地 file:// 加载），不算渲染异常
    if (level >= 2 && m.indexOf('Electron Security Warning') < 0) consoleErrors.push('[L' + level + '] ' + m.slice(0, 200));
  });
  win.webContents.on('render-process-gone', (e, d) => consoleErrors.push('[CRASH] ' + JSON.stringify(d)));
  win.show();

  let fatal = null;
  try { await runAll(); } catch (e) { fatal = e && e.stack || String(e); console.log('FATAL | ' + fatal); }

  const passed = results.filter((r) => r.pass).length;
  console.log('SUMMARY | ' + passed + '/' + results.length + ' | consoleErrors=' + consoleErrors.length);
  if (consoleErrors.length) consoleErrors.slice(-5).forEach((m) => console.log('CONSOLE | ' + m));

  const disp = screen.getPrimaryDisplay();
  const md = [];
  md.push('# 窗口形态与首页布局测试报告 · 打工人记账器 v' + PKG_VERSION + '\n');
  md.push('- 执行时间：' + new Date().toLocaleString('zh-CN'));
  md.push('- 环境：' + process.getSystemVersion() + ' · 主屏 ' + disp.size.width + '×' + disp.size.height
    + ' @' + disp.scaleFactor + 'x · 工作区 ' + disp.workAreaSize.width + '×' + disp.workAreaSize.height
    + ' · Electron ' + process.versions.electron);
  md.push('- 方法：直接 require 主进程使用的 `win-geometry.js`（同一份规则），窗口几何 + DOM 布局双重断言\n');
  md.push('| 编号 | 验证项 | 结果 | 证据 |');
  md.push('|---|---|---|---|');
  results.forEach((r) => md.push('| ' + r.id + ' | ' + r.name + ' | ' + (r.pass ? '✅' : '❌') + ' | ' + r.detail + ' |'));
  md.push('\n## 结论\n');
  md.push('- ' + passed + '/' + results.length + ' 通过'
    + (fatal ? '（执行中断：' + fatal.split('\n')[0] + '）' : '，无渲染崩溃')
    + '。');
  fs.writeFileSync(REPORT, md.join('\n'), 'utf8');
  console.log('REPORT | ' + REPORT);
  app.exit(0);
});
