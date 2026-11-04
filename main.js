const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const fs = require('fs');
const https = require('https');
const path = require('path');
const geo = require('./win-geometry.js');

// 开发期调试端口（仅当设置了环境变量才生效，正常使用无影响）
if (process.env.WB_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.WB_DEBUG_PORT);
}

let win = null;
let compacted = false;
// 记住「缩小前」的整份几何（宽 + 高）。只记高度不够：
// 迷你窗被拉宽过，展开时就会一直占满屏 —— 这正是 v1.9.0 的毛病。
let normalBox = { width: geo.NORMAL.width, height: geo.NORMAL.height };

// 任务栏图标与分组标识
app.setAppUserModelId('com.workbuddy.dagongren.jizhangqi');

function workAreaOf(box) {
  try { return screen.getDisplayMatching(box).workArea; } catch (e) { return null; }
}

function createWindow() {
  win = new BrowserWindow({
    width: geo.NORMAL.width,
    height: geo.NORMAL.height,
    minWidth: geo.NORMAL_MIN.width,
    minHeight: geo.NORMAL_MIN.height,
    frame: false,
    // 桌面小工具：大小只有两种形态（正常 / 迷你），都由底部横杆切换。
    // 允许用户拖边改尺寸的话，首页内容就会被裁掉或需要滚动 —— 都不是桌面程序该有的样子。
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#FFF4F6',
    title: '打工人记账器',
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  win.setMenuBarVisibility(false);
  // frameless 窗口创建时带 1px 隐形边框，第一次 setBounds 会把它吃掉，
  // 客户区会凭空变宽 2px —— 那正是缩放时“抖一下”的元凶。
  // 在 show 之前先归一化一次，之后缩放只改尺寸，不会再抖。
  try { win.setBounds(win.getBounds()); } catch (e) {}
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
  });

  // 记住正常态的宽高（缩小期间不记，否则迷你尺寸会被当成展开尺寸）
  win.on('resize', () => {
    if (compacted) return;
    try {
      const b = win.getBounds();
      if (b.width >= 320 && b.height >= 400) normalBox = { width: b.width, height: b.height };
    } catch (e) {}
  });

  win.on('closed', () => {
    win = null;
  });
}

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('holidays:fetch', (event, year) => new Promise((resolve) => {
  const url = 'https://api.jiejiariapi.com/v1/holidays/' + year;
  const req = https.get(url, { timeout: 9000 }, (res) => {
    if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { buf += c; });
    res.on('end', () => {
      try {
        const d = JSON.parse(buf);
        const off = [], work = [];
        Object.keys(d).forEach((k) => {
          const v = d[k];
          if (!v || !v.date) return;
          if (v.isOffDay) off.push(k); else work.push(k);
        });
        resolve(off.length ? { year: year, off: off, work: work } : null);
      } catch (e) { resolve(null); }
    });
  });
  req.on('error', () => resolve(null));
  req.on('timeout', () => { req.destroy(); resolve(null); });
}));

ipcMain.handle('data:export', async (event, name, content) => {
  try {
    // 测试钩子：设了 WB_TEST_EXPORT_DIR 就不弹窗，直接写进该目录
    if (process.env.WB_TEST_EXPORT_DIR) {
      const fp = path.join(process.env.WB_TEST_EXPORT_DIR, name);
      fs.writeFileSync(fp, content, 'utf8');
      return { ok: true, path: fp };
    }
    const r = await dialog.showSaveDialog(win, {
      title: '导出数据备份',
      defaultPath: name,
      filters: [{ name: 'JSON 备份', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    fs.writeFileSync(r.filePath, content, 'utf8');
    return { ok: true, path: r.filePath };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('data:import', async () => {
  try {
    // 测试钩子：WB_TEST_IMPORT_FILE 指定要读的文件，不弹窗
    if (process.env.WB_TEST_IMPORT_FILE) {
      const txt = fs.readFileSync(process.env.WB_TEST_IMPORT_FILE, 'utf8');
      return { ok: true, json: txt };
    }
    const r = await dialog.showOpenDialog(win, {
      title: '选择数据备份',
      properties: ['openFile'],
      filters: [{ name: 'JSON 备份', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    const txt = fs.readFileSync(r.filePaths[0], 'utf8');
    if (txt.length > 2 * 1024 * 1024) return { error: '文件太大，不像备份' };
    return { ok: true, json: txt };
  } catch (e) { return { error: e.message }; }
});

ipcMain.on('win:minimize', () => {
  if (win) win.minimize();
});

ipcMain.on('win:close', () => {
  if (win) win.close();
});

ipcMain.on('win:pin', (event, pinned) => {
  if (win) win.setAlwaysOnTop(!!pinned);
});

// 迷你模式：只留「今日已赚」那张卡，窗口同时收窄、压矮，位置尽量原地不动。
// 尺寸规则全在 win-geometry.js 里，测试与主进程共用一份，不靠抄。
ipcMain.on('win:compact', (event, arg) => {
  if (!win) return;
  const on = !!(arg && arg.on);
  let box;
  try { box = win.getBounds(); } catch (e) { return; }

  if (on) {
    if (!compacted) {
      // 只有「正常态」的几何才值得记，别把迷你尺寸当成展开尺寸
      if (box.height > 320 && box.width > 300) normalBox = { width: box.width, height: box.height };
      compacted = true;
    }
    const next = geo.compactBounds(box, arg && arg.height, workAreaOf(box));
    if (geo.sameBounds(box, next)) return;   // 尺寸没变就别动窗口，避免抖
    win.setBounds(next);
  } else {
    if (!compacted) return;
    compacted = false;
    win.setBounds(geo.expandBounds(box, normalBox, workAreaOf(box)));
  }
});

// 只允许开一个窗口：再双击就把已有窗口拎到前面，避免两份各自计时
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
