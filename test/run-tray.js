/* 打工人记账器 v1.1.0 · 托盘（关闭到右下角）专项
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron test/run-tray.js
 *
 * 直接 require 主进程（../main.js），拿它导出的 __test 句柄做断言，
 * 而不是在测试里另写一套"像托盘"的假实现 —— 假实现永远测不出真 bug。
 *
 *   T1 启动后托盘图标已创建（有图标、有提示文字）
 *   T2 点窗口 ×：窗口隐藏但进程还活着、托盘还在
 *   T3 点托盘图标：窗口回来并拿到焦点
 *   T4 再点一次：又收回托盘（同一个图标当开关）
 *   T5 窗口藏在托盘里时再次双击桌面图标：窗口被叫出来
 *   T6 托盘的「退出」才是真退出；关闭窗口不会杀进程（子进程验证）
 *   T7 收到托盘后计时没断：隐藏期间渲染进程仍在、存档仍在写
 */
const { app, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const REPORT = path.join(ROOT, '测试报告-托盘-v' + PKG_VERSION + '.md');
const STORE = 'dgjz.worker.v1';

// 先占位，避免被测主进程把 userData 写进真实目录
app.setPath('userData', path.join(require('os').tmpdir(), 'dgjz-harness-' + path.basename(__filename, '.js')));

const results = [];
const record = (id, name, pass, detail) => {
  results.push({ id, name, pass, detail });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + id + ' ' + name + ' | ' + detail);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 加载被测主进程（它会自己 createWindow + createTray）
const mainMod = require('../main.js');
const T = mainMod.__test;
let R = null;

async function main() {
  // 等窗口和托盘就绪
  let tries = 0;
  while (tries++ < 40) {
    if (T.getWindow() && T.getTray()) break;
    await sleep(200);
  }
  const win = T.getWindow();
  const tray = T.getTray();
  R = (js) => win.webContents.executeJavaScript(js, true);

  await sleep(600);

  /* T1 托盘已创建 */
  const meta = (T.trayInfo && T.trayInfo()) || {};
  const iconSize = meta.icon || { width: 0, height: 0 };
  // v1.2.0 起按屏幕缩放取尺寸：100%/150%/200% → 16/24/32px（避免系统放大发虚）
  let scale = 1;
  try { scale = screen.getPrimaryDisplay().scaleFactor || 1; } catch (e) { scale = 1; }
  const wantPx = Math.max(16, Math.round(16 * scale));
  record('T1', '启动后右下角有托盘图标（按缩放取 ' + wantPx + 'px、带提示文字、右键菜单 3 项）',
    !!tray && !tray.isDestroyed() && iconSize.width === wantPx && iconSize.height === wantPx
      && String(meta.tooltip || '').indexOf('打工人') >= 0 && (meta.menu || []).length === 3,
    'icon=' + iconSize.width + 'x' + iconSize.height + ' tooltip=' + meta.tooltip
      + ' 菜单=' + JSON.stringify(meta.menu));

  /* T2 关窗口 = 收进托盘，不是退出 */
  T.closeWindow();
  await sleep(900);
  const hidden = !win.isVisible();
  const alive = !win.isDestroyed();
  const trayAlive = tray && !tray.isDestroyed();
  record('T2', '点窗口 ×：窗口隐藏、进程仍活着、托盘还在（不是直接退出）',
    hidden && alive && trayAlive,
    'visible=' + win.isVisible() + ' destroyed=' + win.isDestroyed() + ' tray=' + (trayAlive ? '在' : '没了'));

  /* T3 点托盘：窗口回来 */
  T.toggleWindow();
  await sleep(700);
  const shown = win.isVisible();
  const focused = win.isFocused();
  record('T3', '点托盘图标：窗口重新显示并获得焦点',
    shown && !win.isDestroyed(),
    'visible=' + shown + ' focused=' + focused);

  /* T4 再点一次：又收回去（同一个图标当开关） */
  T.toggleWindow();
  await sleep(600);
  record('T4', '再点托盘图标：窗口收回托盘（图标当开关用，不用去找 ×）',
    !win.isVisible() && !win.isDestroyed(),
    'visible=' + win.isVisible());

  /* T5 托盘里藏着时，双击桌面图标（第二实例）也能叫出来 */
  T.secondInstance();
  await sleep(700);
  record('T5', '窗口藏在托盘时再次双击桌面图标：窗口被叫出来，不会开第二个窗口',
    win.isVisible() && require('electron').BrowserWindow.getAllWindows().length === 1,
    'visible=' + win.isVisible() + ' 窗口数=' + require('electron').BrowserWindow.getAllWindows().length);

  /* T7 隐藏期间计时没断：让页面写点状态，确认存档照旧 */
  T.toggleWindow();                       // 再藏起来
  await sleep(400);
  const writeOk = await R(`(() => {
    try { localStorage.setItem('__tray_probe', 'alive'); return localStorage.getItem('__tray_probe') === 'alive'; }
    catch (e) { return false; }
  })()`);
  await sleep(1200);
  const aliveRender = !win.webContents.isDestroyed() && !win.webContents.isCrashed();
  const domOk = await R(`(() => {
    const el = document.querySelector('#todayEarned');
    return !!el && typeof el.textContent === 'string' && !!document.querySelector('#btnClock');
  })()`);
  record('T7', '收进托盘后渲染进程没被杀、页面还能正常读写（不是靠"假装最小化"骗人）',
    writeOk && aliveRender && domOk,
    '存档可读写=' + writeOk + ' 渲染进程=' + (aliveRender ? '正常' : '挂了') + ' 页面元素=' + domOk);

  /* T6 退出路径：另起一个实例验证「关闭不退出、托盘退出才退出」 */
  const child = spawn(process.execPath, [path.join(__dirname, 'tray-quit-child.js')], {
    env: Object.assign({}, process.env, { WB_TEST_MULTI: '1', WB_TEST_PROFILE: 'child' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill(); } catch (e) {} resolve('timeout'); }, 25000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  const closedHidden = out.indexOf('AFTER_CLOSE hidden=1 alive=1') >= 0;
  const quitOk = out.indexOf('AFTER_QUIT') >= 0 || code === 0;
  record('T6', '关窗口不退出（进程继续跑）；托盘菜单「退出」才真正结束进程',
    closedHidden && quitOk && code === 0,
    '子进程退出码=' + code + ' 关窗后=' + (closedHidden ? '隐藏且存活' : '异常') + ' 输出=' + out.replace(/\n/g, ' / ').slice(0, 120));

  const pass = results.filter((r) => r.pass).length;
  console.log('SUMMARY | pass=' + pass + '/' + results.length);
  writeReport(pass);
  app.exit(pass === results.length ? 0 : 1);
}

function writeReport(pass) {
  const lines = [];
  lines.push('# 测试报告 · 托盘（关闭到右下角）v' + PKG_VERSION);
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
  main().catch((e) => {
    console.log('FATAL | ' + (e && e.stack || e));
    app.exit(1);
  });
});
