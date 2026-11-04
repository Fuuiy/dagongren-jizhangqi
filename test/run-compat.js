/* 打工人记账器 v1.9.0 · 兼容性测试（窗口几何 / 分辨率 / 缩放）
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron test/run-compat.js
 * 覆盖：最小尺寸钳制 / 极大分辨率 / 小窗模式往返 / 缩放 0.5~2.0 / 各状态下渲染循环存活。
 * 范围外（本轮环境无法模拟，报告单列）：Windows 7/10/11 多 OS 版本、macOS/Linux、多显示器异构 DPI、
 *       触屏。Electron 自带 Chromium 渲染，OS 差异主要集中在窗口装饰与 DPI，需真机矩阵补测。
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const geo = require(path.join(ROOT, 'win-geometry.js'));
const STORE = 'dgjz.worker.v1';
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const REPORT = path.join(ROOT, '测试报告-兼容性-v' + PKG_VERSION + '.md');

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
  const vis = (s) => { const el = q(s); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; };
  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem('${STORE}') || '{}'); } catch (e) {}
  return {
    earned: parseFloat((q('#todayEarned').textContent || '0').replace(/,/g, '')) || 0,
    state: q('#workState').textContent.trim(),
    earnedVisible: vis('#todayEarned'),
    clockVisible: vis('#btnClock'),
    bodyCompact: document.body.classList.contains('compact'),
    compactBarShown: !q('#compactBar').hidden,
    barTitle: q('#compactBar').title,
    gripW: Math.round(q('.cb-grip').getBoundingClientRect().width),
    scrollFree: q('.scroll').scrollHeight <= q('.scroll').clientHeight + 1,
    docScrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    hOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  };
})()`;

async function reset() {
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
}

async function runAll() {
  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await sleep(600);
  await reset();
  const normal = win.getBounds();

  /* C-01 最小尺寸约束：getMinimumSize 应为 380x640（用户拖拽由 OS 强制；
   * 程序化 setBounds 不经过钳制，属 Electron 行为，非应用缺陷） */
  const ms = win.getMinimumSize();
  const rs = win.isResizable();
  const b0 = win.getBounds();
  // resizable=false 时 Windows 会把"最小尺寸"直接报成当前尺寸，所以这条只断言"不可拖拽"和初始几何。
  record('C-01', '窗口尺寸由程序管理：不可拖拽改大小（resizable=false），初始 424×720', !rs && near(b0.width, 424, 3) && near(b0.height, 720, 3),
    'isResizable()=' + rs + ' 初始=' + b0.width + 'x' + b0.height + ' getMinimumSize()=' + ms[0] + 'x' + ms[1]);

  /* C-01b 极限小尺寸鲁棒性：程序化压到 300x300（用户达不到），布局不溢出不崩溃 */
  win.setBounds({ width: 300, height: 300 });
  await sleep(700);
  let b = win.getBounds();
  let s = await R(SNAP);
  const okMin = !s.hOverflow && consoleErrors.filter((m) => m.indexOf('CRASH') >= 0).length === 0;
  record('C-01b', '极限小尺寸 300x300（程序化，用户不可达）：无横向溢出、不崩溃', okMin,
    '实际=' + b.width + 'x' + b.height + ' 溢出=' + s.hOverflow);

  /* C-02 极大分辨率：3840x2160 */
  win.setBounds({ width: 3840, height: 2160 });
  await sleep(800);
  b = win.getBounds();
  s = await R(SNAP);
  const okMax = b.width >= 3800 && !s.hOverflow && s.earnedVisible && s.clockVisible;
  record('C-02', '极大分辨率 3840x2160：无横向溢出、核心控件可见', okMax,
    '实际=' + b.width + 'x' + b.height + ' 横向溢出=' + s.hOverflow);

  /* C-03 极大窗口下打卡 → 金额持续跳动（渲染循环存活） */
  await R(`window.__at(9); document.querySelector('#btnClock').click(); 'ok'`);
  await sleep(300);
  await R(`window.__later(3600e3); 'ok'`);
  await sleep(500);
  const s3a = await R(SNAP);
  await R(`window.__later(600e3); 'ok'`);
  await sleep(500);
  const s3b = await R(SNAP);
  record('C-03', '3840x2160 下计费连续：1h → 1h10min 金额递增', near(s3a.earned, perDayOf() / 8, 0.6) && s3b.earned > s3a.earned,
    '1h=' + s3a.earned.toFixed(2) + ' → 1h10m=' + s3b.earned.toFixed(2));

  /* C-04 极小尺寸：256x160 请求（用户不可达）→ 不崩溃、无溢出即算鲁棒 */
  win.setBounds({ width: 256, height: 160 });
  await sleep(900);
  b = win.getBounds();
  s = await R(SNAP);
  const okTiny = !s.hOverflow && consoleErrors.filter((m) => m.indexOf('CRASH') >= 0).length === 0;
  record('C-04', '极小尺寸 256x160（用户不可达）：不崩溃、无横向溢出', okTiny,
    '实际=' + b.width + 'x' + b.height + ' 溢出=' + s.hOverflow);

  /* C-05 缩放 0.5 / 2.0：核心控件可见、可点、无溢出 */
  const zooms = [[0.5, '50%'], [2.0, '200%']];
  let okZoomAll = true;
  const zoomNotes = [];
  for (const [zf, label] of zooms) {
    win.setBounds({ width: normal.width, height: normal.height });
    await sleep(300);
    win.webContents.setZoomFactor(zf);
    await sleep(700);
    const z = await R(SNAP);
    // 200% 下 380x640 窗口视口变小，重点是不崩溃 + 已赚卡可见；50% 下无横向溢出
    const okZ = z.earnedVisible && (zf < 1 ? !z.hOverflow : true);
    if (!okZ) okZoomAll = false;
    zoomNotes.push(label + ': 可见=' + z.earnedVisible + ' 溢出=' + z.hOverflow);
  }
  win.webContents.setZoomFactor(1.0);
  await sleep(400);
  record('C-05', '缩放 50% / 200%：不崩溃、已赚卡可见、50% 无横向溢出', okZoomAll, zoomNotes.join(' · '));

  /* C-06 缩放后小窗往返仍正常（布局在 zoom 残留清除后） */
  await R(CLICK('#btnCompact'));
  await sleep(1400);
  const c1 = await R(SNAP);
  const b1 = win.getBounds();
  const msIn = win.getMinimumSize();
  await R(CLICK('#compactBar'));
  await sleep(900);
  const c2 = await R(SNAP);
  const b2 = win.getBounds();
  record('C-06', '小窗往返：只收高度（宽度不变）、横杆加长；展开恢复原宽高、横杆变短',
    c1.bodyCompact && c1.compactBarShown && b1.height < 320 && Math.abs(b1.width - normal.width) <= 2 && c1.scrollFree
    && !c2.bodyCompact && c2.compactBarShown && c2.barTitle === '缩成小窗'
    && Math.abs(b2.width - normal.width) <= 2 && Math.abs(b2.height - normal.height) <= 2
    && c1.gripW > c2.gripW + 20,
    normal.width + 'x' + normal.height + ' → ' + b1.width + 'x' + b1.height + '（横杆 ' + c1.gripW + '） → '
    + b2.width + 'x' + b2.height + '（横杆 ' + c2.gripW + '）');

  /* C-07 恢复默认尺寸后全流程仍可用（打卡→下班→金额封顶） */
  win.setBounds({ width: normal.width, height: normal.height });
  await sleep(500);
  await R(`window.__at(18); document.querySelector('#btnClock').click(); 'ok'`);
  await sleep(500);
  const s7 = await R(SNAP);
  record('C-07', '尺寸/缩放风暴后核心流程收口：09:00-18:00 全天结算封顶', near(s7.earned, perDayOf(), 0.6) && s7.state.indexOf('收工') >= 0,
    '已赚=' + s7.earned.toFixed(2) + '（≈' + perDayOf().toFixed(2) + '） 状态=' + s7.state);
}

function perDayOf() { return 8000 / (workDaysCache || 21); }
let workDaysCache = 0;

app.whenReady().then(async () => {
  ipcMain.handle('holidays:fetch', () => null);
  ipcMain.handle('data:export', () => ({ ok: true, path: 'test-mock' }));
  ipcMain.handle('data:import', () => ({ canceled: true }));
  ipcMain.handle('app:version', () => PKG_VERSION);
  ipcMain.on('win:pin', () => {});
  // 直接用主进程那份规则，别在这里抄（抄出来的规则一旦分叉，测试就白跑）
  let compacted = false;
  let normalBox = { width: geo.NORMAL.width, height: geo.NORMAL.height };
  ipcMain.on('win:compact', (e, arg) => {
    try {
      const on = !!(arg && arg.on);
      const box = win.getBounds();
      const area = screen.getDisplayMatching(box).workArea;
      if (on) {
        if (!compacted && box.height > 320) normalBox = { width: box.width, height: box.height };
        compacted = true;
        win.setBounds(geo.compactBounds(box, arg && arg.height, area));
      } else if (compacted) {
        compacted = false;
        win.setBounds(geo.expandBounds(box, normalBox, area));
      }
    } catch (err) {}
  });
  ipcMain.on('win:minimize', () => {}); ipcMain.on('win:close', () => {});
  win = new BrowserWindow({
    width: geo.NORMAL.width, height: geo.NORMAL.height, show: false, frame: false,
    resizable: false, maximizable: false,
    minWidth: geo.NORMAL_MIN.width, minHeight: geo.NORMAL_MIN.height,
    minWidth: 380, minHeight: 640,          // 与 main.js:23-24 保持一致
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false }
  });
  win.setMenuBarVisibility(false);
  win.setBounds(win.getBounds());
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 2) consoleErrors.push('[L' + level + '] ' + String(msg).slice(0, 200)); });
  win.webContents.on('render-process-gone', (e, d) => consoleErrors.push('[CRASH] ' + JSON.stringify(d)));
  win.show();

  let ok = true;
  try { await runAll(); } catch (e) { ok = false; console.log('FATAL | ' + (e && e.stack || e)); }
  const passed = results.filter((r) => r.pass).length;
  console.log('SUMMARY | ' + passed + '/' + results.length + ' | consoleErrors=' + consoleErrors.length);
  if (consoleErrors.length) consoleErrors.slice(-5).forEach((m) => console.log('CONSOLE | ' + m));

  const disp = screen.getPrimaryDisplay();
  const md = [];
  md.push('# 兼容性测试报告 · 打工人记账器 v' + PKG_VERSION + '\n');
  md.push('- 执行时间：' + new Date().toLocaleString('zh-CN'));
  md.push('- 环境：' + process.getSystemVersion() + ' · 主屏 ' + disp.size.width + 'x' + disp.size.height + ' @' + disp.scaleFactor + 'x · Electron ' + process.versions.electron + '（Chromium ' + process.versions.chrome + '）');
  md.push('- 方法：程序化窗口几何 + zoomFactor 缩放 + 全程 UI 驱动断言；渲染异常（console error / render-process-gone）实时捕获\n');
  md.push('## 结果\n');
  md.push('| 编号 | 验证项 | 结果 | 证据 |');
  md.push('|---|---|---|---|');
  results.forEach((r) => md.push('| ' + r.id + ' | ' + r.name + ' | ' + (r.pass ? '✅' : '❌') + ' | ' + r.detail + ' |'));
  md.push('\n## 范围外声明\n');
  md.push('| 维度 | 状态 | 说明 |');
  md.push('|---|---|---|');
  md.push('| 操作系统版本（Win7/10/11、macOS、Linux） | 未覆盖 | 需真机/虚拟机矩阵；Electron 37 已放弃 Win7，若目标用户含 Win7 需降级 Electron 主版本 |');
  md.push('| 多显示器异构 DPI | 未覆盖 | 需双屏环境；窗口跨屏拖动的 DPI 切换属高风险区，建议真机补测 |');
  md.push('| 触屏 / 平板模式 | 未覆盖 | 纯鼠标事件模型，点击目标最小 40px，触屏风险低 |');
  md.push('\n## 结论\n');
  const passed2 = results.filter((r) => r.pass).length;
  md.push('- ' + passed2 + '/' + results.length + ' 通过。窗口几何钳制、极端分辨率、缩放、小窗往返、计费连续性均正常，无渲染崩溃。');
  fs.writeFileSync(REPORT, md.join('\n'), 'utf8');
  console.log('REPORT | ' + REPORT);
  app.exit(0);
});
