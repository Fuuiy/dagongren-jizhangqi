/* 退出路径子进程：验证「关窗口 → 只隐藏不退出」「托盘退出 → 进程结束」
 * 由 test/run-tray.js 拉起：WB_TEST_MULTI=1 跳过单实例锁
 */
const { app } = require('electron');
const path = require('path');

app.setPath('userData', path.join(require('os').tmpdir(), 'dgjz-harness-tray-child'));

const mainMod = require('../main.js');
const T = mainMod.__test;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function line(s) { process.stdout.write(s + '\n'); }

app.whenReady().then(async () => {
  let tries = 0;
  while (tries++ < 40) {
    if (T.getWindow() && T.getTray()) break;
    await sleep(150);
  }
  await sleep(500);
  const win = T.getWindow();
  if (!win) { line('NO_WINDOW'); app.exit(2); return; }

  // 1) 关窗口：应该只是隐藏
  T.closeWindow();
  await sleep(800);
  line('AFTER_CLOSE hidden=' + (win.isVisible() ? 0 : 1) + ' alive=' + (win.isDestroyed() ? 0 : 1));

  // 2) 托盘「退出」：应该真的结束进程
  line('AFTER_QUIT');
  T.quitApp();
  setTimeout(() => { app.exit(3); }, 6000);
});
