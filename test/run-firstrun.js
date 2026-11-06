/* 打工人记账器 v1.2.0 · 首启校验 + 本批整改项专项
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron test/run-firstrun.js
 *
 * 覆盖用户提的这批整改：
 *   F1-F5  首启不填参数点「收起」→ 必须二次确认；用默认值要留痕（首页黄条）
 *   F6     正常「存好啦」算用户亲自确认，黄条不出现
 *   F7-F8  切计时方式会把当天已赚清零 —— 先问一次；取消不生效、确认才清
 *   F9     加班倍率 1.5 倍：补录班外 1 小时 = 1.5 × 时薪
 *   F10    点 × 行为开关（收到托盘 / 直接退出）落到存档并通知主进程
 *   F11    快捷键 Ctrl+Enter 打卡、再按下班
 *   F12    数据目录展示 + 复制
 *   F13    秒薪主卡 2 位小数、精确值在 title
 *   F14    目标达成后出现「换下一个目标」
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE = 'dgjz.worker.v1';
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const REPORT = path.join(ROOT, '测试报告-首启校验-v' + PKG_VERSION + '.md');

app.setPath('userData', path.join(require('os').tmpdir(), 'dgjz-harness-' + path.basename(__filename, '.js')));

let win = null;
const results = [];
const consoleErrors = [];
let closeTrayCalls = [];
let copiedText = '';

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
  let c = {};
  try { c = JSON.parse(localStorage.getItem('${STORE}') || '{}'); } catch (e) {}
  const num = (s) => parseFloat(String((q(s) || {}).textContent || '').replace(/[^0-9.]/g, '')) || 0;
  return {
    sheetOn: q('#sheet').classList.contains('on'),
    dlgOn: !q('#dlgMask').hidden,
    dlgTitle: (q('#dlgTitle').textContent || '').trim(),
    dlgOk: (q('#dlgOk').textContent || '').trim(),
    toastOn: !q('#toast').hidden && q('#toast').classList.contains('on'),
    toastText: (q('#toast').textContent || '').trim(),
    defBarShown: !q('#defBar').hidden,
    defBarText: (q('#defBar').textContent || '').replace(/\\s+/g, ' ').trim(),
    salaryHintShown: !q('#salaryHint').hidden,
    dataPathText: (q('#dataPath').textContent || '').trim(),
    perSecCard: (q('#perSecCard').textContent || '').trim(),
    perSecTitle: q('#perSecCard').getAttribute('title') || '',
    nextGoalShown: !q('#btnNextGoal').hidden,
    earned: num('#todayEarned'),
    state: (q('#workState').textContent || '').trim(),
    otActive: (() => { const b = document.querySelector('#segOt button.active'); return b ? b.dataset.ot : ''; })(),
    closeActive: (() => { const b = document.querySelector('#segClose button.active'); return b ? b.dataset.close : ''; })(),
    inited: c.inited === true,
    confirmed: c.confirmedByUser === true,
    salary: c.salary,
    mode: c.clockFrom,
    auto: !!c.autoRun,
    closeToTray: c.closeToTray,
    otRate: c.otRate,
    settled: c.settled || 0,
    todaySettled: c.todaySettled || null
  };
})()`;

async function reset() {
  await R(`localStorage.clear(); location.reload(); 'x'`);
  await sleep(1500);
  await R(INJECT);
  await sleep(200);
  win.focus(); win.moveTop();
  await sleep(150);
}

async function main() {
  win = new BrowserWindow({
    width: 424, height: 720, show: false, frame: false, resizable: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.webContents.on('console-message', (e, level, msg) => {
    const m = String(msg);
    if (level >= 2 && m.indexOf('Electron Security Warning') < 0) consoleErrors.push(m.slice(0, 160));
  });
  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await sleep(1400);

  const S = () => R(SNAP);

  /* ---------- F1 首启默认态 ---------- */
  await reset();
  await sleep(600);
  let s = await S();
  record('F1', '首启：面板自动弹出、工资下方有「这是默认值」提示、首页还没有黄条',
    s.sheetOn && s.salaryHintShown && !s.defBarShown && s.inited === false && s.salary === 8000,
    '面板=' + s.sheetOn + ' 工资提示=' + s.salaryHintShown + ' 黄条=' + s.defBarShown
    + ' inited=' + s.inited + ' 工资=' + s.salary);

  /* ---------- F2 收起 → 弹确认 → 选「回去填」 ---------- */
  await R(CLICK('#btnCloseSheet'));
  await sleep(400);
  const ask1 = await S();
  await R(CLICK('#dlgCancel'));
  await sleep(350);
  const back1 = await S();
  record('F2', '首启没填就点「收起」：弹确认（不是默默按默认值开始）；选「回去填」面板还在、设置没被当成完成',
    ask1.dlgOn && ask1.dlgTitle.indexOf('还没填') >= 0 && ask1.dlgOk.indexOf('默认') >= 0
      && back1.sheetOn && back1.inited === false,
    '弹窗=' + ask1.dlgOn + ' 标题=[' + ask1.dlgTitle + '] 按钮=[' + ask1.dlgOk + '] → 面板=' + back1.sheetOn
    + ' inited=' + back1.inited);

  /* ---------- F3 选「先用默认值」→ 留痕 ---------- */
  await R(CLICK('#btnCloseSheet'));
  await sleep(400);
  await R(CLICK('#dlgOk'));
  await sleep(700);
  const used = await S();
  record('F3', '选「先用默认值」：面板关闭、记为已设置但未确认，首页黄条出现且写着 ¥8,000',
    !used.sheetOn && used.inited === true && used.confirmed === false
      && used.defBarShown && used.defBarText.indexOf('8,000') >= 0,
    '面板=' + used.sheetOn + ' inited=' + used.inited + ' 已确认=' + used.confirmed
    + ' 黄条=[' + used.defBarText + ']');

  /* ---------- F4 点黄条回到设置，且首启提示消失 ---------- */
  await R(CLICK('#defBar'));
  await sleep(700);
  const re = await S();
  record('F4', '点首页黄条直接回到设置面板，且「默认值」提示不再出现（已经知道是默认值了）',
    re.sheetOn && re.salaryHintShown === false,
    '面板=' + re.sheetOn + ' 工资提示=' + re.salaryHintShown);

  /* ---------- F5 重开仍然记得「用的是默认值」 ---------- */
  await R(CLICK('#btnCloseSheet'));
  await sleep(300);
  await R(`location.reload(); 'rl'`);
  await sleep(1400);
  await R(INJECT);
  await sleep(700);
  const re2 = await S();
  record('F5', '重开之后：不再自动弹面板（已经算设置过），但黄条还在提醒「这是默认值」',
    !re2.sheetOn && re2.defBarShown && re2.confirmed === false,
    '面板=' + re2.sheetOn + ' 黄条=' + re2.defBarShown + ' 已确认=' + re2.confirmed);

  /* ---------- F6 正常保存 = 亲自确认 ---------- */
  await reset();
  await sleep(600);
  await R(`(() => { const e = document.querySelector('#inSalary'); e.value = '12000';
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
    e.dispatchEvent(new Event('blur', { bubbles: true })); return 'ok'; })()`);
  await sleep(300);
  await R(CLICK('#btnSave'));
  await sleep(800);
  const saved = await S();
  record('F6', '填了真工资点「存好啦」：算用户亲自确认、黄条不出现、并且弹一次「存好啦」轻提示',
    saved.confirmed === true && !saved.defBarShown && saved.sheetOn === false
      && saved.toastText.indexOf('存好啦') >= 0,
    '已确认=' + saved.confirmed + ' 黄条=' + saved.defBarShown + ' 提示=[' + saved.toastText + ']');

  /* ---------- F7 切计时方式 → 先问，不点确定不生效 ---------- */
  await R(`window.__at(9, 0); document.querySelector('#btnClock').click(); 'ok'`);
  await sleep(400);
  await R(`window.__later(2 * 3600e3); 'ok'`);
  await sleep(600);
  const before = await S();
  await R(CLICK('#btnSettings'));
  await sleep(500);
  await R(`document.querySelector('.mcard[data-mode="schedule"][data-auto="0"]').click(); 'ok'`);
  await sleep(250);
  await R(CLICK('#btnSave'));
  await sleep(500);
  const ask2 = await S();
  await R(CLICK('#dlgCancel'));
  await sleep(500);
  const cancel2 = await S();
  record('F7', '当天已有 ¥' + before.earned.toFixed(2) + ' 时切计时方式：弹窗说明会清零；点「先不换」则模式没变、钱还在',
    ask2.dlgOn && ask2.dlgTitle.indexOf('计时方式') >= 0
      && cancel2.mode === 'click' && near(cancel2.earned, before.earned, 0.5),
    '弹窗=' + ask2.dlgOn + ' 取消后 mode=' + cancel2.mode + ' 已赚=' + cancel2.earned.toFixed(2)
    + '（切换前=' + before.earned.toFixed(2) + '）');

  /* ---------- F8 确认切换 → 清零 ---------- */
  await R(CLICK('#btnSave'));
  await sleep(450);
  await R(CLICK('#dlgOk'));
  await sleep(800);
  const switched = await S();
  record('F8', '点「确定切换」：模式真的切过去，当天金额归零（补录不动）',
    switched.mode === 'schedule' && switched.earned < 0.01 && switched.todaySettled === null,
    'mode=' + switched.mode + ' 已赚=' + switched.earned.toFixed(2)
    + ' todaySettled=' + JSON.stringify(switched.todaySettled));

  /* ---------- F9 加班倍率 1.5 ---------- */
  await reset();
  await sleep(600);
  // 用 12000 / 21 天 / 8 小时 → 时薪 71.43
  await R(`(() => { const set = (s, v) => { const e = document.querySelector(s); e.value = v;
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
      e.dispatchEvent(new Event('blur', { bubbles: true })); };
    set('#inSalary', '12000'); set('#inStart', '09:00'); set('#inEnd', '18:00');
    set('#inLunchStart', '12:00'); set('#inLunchEnd', '13:00'); return 'ok'; })()`);
  await sleep(400);
  await R(CLICK('#btnSave'));
  await sleep(800);
  await R(CLICK('#btnSettings'));
  await sleep(500);
  await R(`document.querySelector('#segOt button[data-ot="1.5"]').click(); 'ok'`);
  await sleep(400);
  const ot1 = await S();
  await R(CLICK('#btnCloseSheet'));
  await sleep(400);
  // 20:30 打一次卡再下班，补 19:00-20:00 的班外加班
  await R(`window.__at(20, 30); 'ok'`);
  await sleep(200);
  await R(CLICK('#btnClock'));
  await sleep(300);
  await R(`(() => { const b = document.querySelector('#btnClock'); if (!b.disabled) b.click(); return 'ok'; })()`);
  await sleep(600);
  await R(CLICK('#btnFix'));
  await sleep(600);
  await R(`(() => { const s = (sel, v) => { const e = document.querySelector(sel); e.value = v;
      e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('blur', { bubbles: true })); };
    s('#inFixStart', '19:00'); s('#inFixEnd', '20:00'); return 'ok'; })()`);
  await sleep(400);
  await R(CLICK('#btnFixOk'));
  await sleep(800);
  const ot2 = await S();
  const perHour = 12000 / 21 / 8;
  record('F9', '加班倍率设成 1.5 倍后，补录班外 1 小时 = 1.5 × 时薪（71.43 → 107.14）',
    ot1.otActive === '1.5' && ot1.otRate === 1.5 && near(ot2.earned, perHour * 1.5, 1.2),
    '倍率档=' + ot1.otActive + ' 存档倍率=' + ot1.otRate + ' 补录后已赚=' + ot2.earned.toFixed(2)
    + '（期望≈' + (perHour * 1.5).toFixed(2) + '）');

  /* ---------- F10 点 × 行为开关 ---------- */
  await reset();
  await sleep(600);
  await R(CLICK('#btnSave'));
  await sleep(700);
  await R(CLICK('#btnSettings'));
  await sleep(500);
  closeTrayCalls = [];
  await R(`document.querySelector('#segClose button[data-close="quit"]').click(); 'ok'`);
  await sleep(500);
  const cl = await S();
  record('F10', '设置里把「点 × 时」改成直接退出：存档记住 closeToTray=false 并通知主进程',
    cl.closeToTray === false && cl.closeActive === 'quit'
      && closeTrayCalls.length > 0 && closeTrayCalls[closeTrayCalls.length - 1] === false,
    '存档=' + cl.closeToTray + ' 高亮=' + cl.closeActive + ' 主进程收到=' + JSON.stringify(closeTrayCalls));

  /* ---------- F11 快捷键 ---------- */
  await R(CLICK('#btnCloseSheet'));
  await sleep(400);
  await R(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); 'ok'`);
  await sleep(900);
  const k1 = await S();
  await R(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); 'ok'`);
  await sleep(900);
  const k2 = await S();
  record('F11', '快捷键 Ctrl+Enter：第一次打卡（工作中），第二次下班（已收工）',
    k1.state.indexOf('工作') >= 0 && k2.state.indexOf('收工') >= 0,
    '第一次=' + k1.state + ' 第二次=' + k2.state);

  /* ---------- F12 数据目录显示 + 复制 ---------- */
  await R(CLICK('#btnSettings'));
  await sleep(700);
  const dp = await S();
  copiedText = '';
  await R(CLICK('#btnCopyPath'));
  await sleep(400);
  record('F12', '设置里能看到数据真实存放目录，点「复制数据路径」把路径送进剪贴板',
    dp.dataPathText.indexOf('dgjz-harness') >= 0 && copiedText.indexOf('dgjz-harness') >= 0,
    '文案=[' + dp.dataPathText.slice(0, 46) + '…] 复制到=[' + copiedText.slice(0, 46) + '…]');

  /* ---------- F13 秒薪显示 ---------- */
  const ps = await S();
  record('F13', '秒薪主卡显示 2 位小数，精确 4 位挂在 title 上（鼠标停留可看）',
    /^¥?\d+\.\d{2}$/.test(ps.perSecCard.replace(/,/g, '')) && /\d+\.\d{4}/.test(ps.perSecTitle),
    '卡面=' + ps.perSecCard + ' title=' + ps.perSecTitle);

  /* ---------- F14 目标达成后出现「换下一个目标」 ---------- */
  await R(CLICK('#btnCloseSheet'));
  await sleep(300);
  await R(`(() => { const c = JSON.parse(localStorage.getItem('${STORE}') || '{}');
    c.settled = 6200; c.goalAmount = 5999; c.inited = true; c.confirmedByUser = true;
    localStorage.setItem('${STORE}', JSON.stringify(c)); location.reload(); return 'ok'; })()`);
  await sleep(1500);
  await R(INJECT);
  await sleep(900);
  const done = await S();
  await R(`(() => { const c = JSON.parse(localStorage.getItem('${STORE}') || '{}');
    c.settled = 100; localStorage.setItem('${STORE}', JSON.stringify(c)); location.reload(); return 'ok'; })()`);
  await sleep(1400);
  await R(INJECT);
  await sleep(700);
  const undone = await S();
  record('F14', '目标达成后显示「换下一个目标」，没达成时隐藏',
    done.nextGoalShown === true && undone.nextGoalShown === false,
    '达成时=' + done.nextGoalShown + ' 未达成时=' + undone.nextGoalShown);

  record('F15', '全流程无未捕获 JS 异常', consoleErrors.length === 0,
    consoleErrors.length ? consoleErrors.slice(0, 2).join(' / ') : '无');

  const pass = results.filter((r) => r.pass).length;
  console.log('SUMMARY | pass=' + pass + '/' + results.length);
  writeReport(pass);
  app.exit(pass === results.length ? 0 : 1);
}

function writeReport(pass) {
  const lines = [];
  lines.push('# 测试报告 · 首启校验与整改项 v' + PKG_VERSION);
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
  ipcMain.handle('app:version', () => PKG_VERSION);
  ipcMain.handle('holidays:fetch', () => null);
  ipcMain.handle('data:export', () => ({ canceled: true }));
  ipcMain.handle('data:import', () => ({ canceled: true }));
  ipcMain.handle('app:data-path', () => path.join(require('os').tmpdir(), 'dgjz-harness-firstrun'));
  ipcMain.handle('app:tray', () => ({ hasTray: true, icon: { width: 16, height: 16 }, tooltip: 'x' }));
  ipcMain.on('win:close-behavior', (e, v) => { closeTrayCalls.push(!!v); });
  ipcMain.on('app:copy', (e, t) => { copiedText = String(t || ''); });
  ipcMain.on('win:compact', () => {});
  ipcMain.on('win:pin', () => {});
  ipcMain.on('win:minimize', () => {});
  ipcMain.on('win:close', () => {});
  main().catch((e) => {
    console.log('FATAL | ' + (e && e.stack || e));
    app.exit(1);
  });
});
