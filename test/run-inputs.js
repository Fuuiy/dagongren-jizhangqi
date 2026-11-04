/* 打工人记账器 v1.11.0 · 时间输入 / 数字步进 / 表单排版测试
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron test/run-inputs.js
 *
 * 为什么单独一套：
 *   用户报了两个很具体的操作级 bug——
 *   ① 在 14:30 中间删掉 4 再补 5，值会被重排成 10:05 之类（老实现每次都整体重排字符串）
 *   ② 目标金额清空后点向上，先 1 再 101、201（原生 spinner 用 step=100 + min=1）
 *   这两条都只有在"真的用键盘编辑 + 真的点箭头"时才会暴露，所以这一套只测交互。
 *
 * 覆盖：
 *   I-01  时间中间删一位再补一位：不跳位（14:30 → 删4 → 补5 → 15:30）
 *   I-02  全选整段替换：输入 1500 → 15:00
 *   I-03  边打边补冒号：1532 → 15:32、930 → 9:30 → blur 09:30
 *   I-04  非法时间：2400 → 回退上次合法值 + 标红
 *   I-05  滑块：打开 → 预览是当前值 → 拖动实时写回 → 确定关闭
 *   I-06  滑块取消：值还原成打开前
 *   I-07  滑块快捷项：12:00 / 现在
 *   I-08  补录的两个时间输入同一套逻辑（中间编辑 + 滑块）
 *   I-09  目标金额清空后连点向上 = 1、2、3；向下回到 2
 *   I-10  其它数字框清空后从下限起步（月到手 100 / 天数 1、1.5 / 存款 100）
 *   I-11  每个数字框都有自绘箭头、每个时间框都有小时钟
 *   I-12  设置面板：提示条不与输入框重叠、时钟不越界、无横向溢出
 *   I-13  表单被压到需要滚动时，各块按内容高度排（相邻块不重叠）
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE = 'dgjz.worker.v1';
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const REPORT = path.join(ROOT, '测试报告-输入交互-v' + PKG_VERSION + '.md');
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

/* 打开设置面板里的目标分组，并滚到能看见目标输入框 */
const OPEN_SHEET = `(() => {
  if (!document.querySelector('#sheet').classList.contains('on')) document.querySelector('#btnSettings').click();
  return 'ok';
})()`;

/* 用真实 execCommand 做键盘编辑：只有它会产生和用户一样的 inputType */
const TYPE = (sel, ops) => `(() => {
  const el = document.querySelector('${sel}');
  el.focus();
  const out = [];
  ${ops}
  return out;
})()`;

ipcMain.on('win:compact', () => {});
ipcMain.on('win:pin', () => {});
ipcMain.on('win:minimize', () => {});
ipcMain.on('win:close', () => {});
ipcMain.handle('holidays:fetch', () => null);

const SNAP = `(() => {
  const q = (s) => document.querySelector(s);
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }; };
  const sheetEl = q('#sheet');
  const form = sheetEl.querySelector('.form');
  const kids = [...form.children].map((e) => ({ c: (e.className || e.tagName).slice(0, 20), ...box(e) }));
  return {
    sheetOn: sheetEl.classList.contains('on'),
    formScrollable: form.scrollHeight > form.clientHeight + 1,
    formSh: form.scrollHeight, formCh: form.clientHeight,
    kids,
    hOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    start: box(q('#inStart')), hint: box(q('#spanHint')),
    lunch: box(q('#inLunchStart')), lunchHint: box(q('#lunchHint')),
    numInputs: document.querySelectorAll('input[type="number"]').length,
    spins: document.querySelectorAll('.num-spin').length,
    tins: document.querySelectorAll('.tin-btn').length,
    goalGroupOpen: q('#goalGroup').open
  };
})()`;

async function reset() {
  await R(`localStorage.removeItem('${STORE}'); location.reload(); 'wipe'`);
  await sleep(1500);
  await R(`if (document.querySelector('#sheet').classList.contains('on')) document.querySelector('#btnCloseSheet').click(); 'ok'`);
  await sleep(300);
  // 窗口没有系统焦点时，blur/execCommand 的行为会飘；每次重置后先把窗口拉回前台
  win.focus();
  win.moveTop();
  await sleep(250);
}

async function openSheet() {
  await R(OPEN_SHEET);
  await sleep(650);
}

async function runAll() {
  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await sleep(900);
  await reset();

  /* ---------- I-01 中间删一位再补一位 ---------- */
  const e1 = await R(`(() => {
    const el = document.querySelector('#inStart');
    el.focus();
    el.value = '14:30';
    el.setSelectionRange(2, 2);
    const before = el.value;
    document.execCommand('delete');
    const afterDel = el.value;
    document.execCommand('insertText', false, '5');
    const afterIns = el.value;
    const caret = el.selectionStart;
    el.blur();
    return { before, afterDel, afterIns, caret, final: el.value };
  })()`);
  record('I-01', '时间中间删一位再补一位：不跳位（14:30 → 删 4 → 补 5 → 15:30）',
    e1.afterDel === '1:30' && e1.afterIns === '15:30' && e1.final === '15:30',
    JSON.stringify(e1));

  /* ---------- I-02 全选整段替换 ---------- */
  const e2 = await R(`(() => {
    const el = document.querySelector('#inStart');
    el.focus();
    el.select();
    document.execCommand('insertText', false, '1500');
    const live = el.value;
    el.blur();
    return { live, final: el.value };
  })()`);
  record('I-02', '点进来全选、直接打 1500 → 15:00（不用先删干净）',
    e2.live === '15:00' && e2.final === '15:00', JSON.stringify(e2));

  /* ---------- I-03 边打边补冒号 ---------- */
  const e3 = await R(`(() => {
    const el = document.querySelector('#inStart');
    el.focus(); el.select();
    const seen = [];
    for (const d of ['1', '5', '3', '2']) { document.execCommand('insertText', false, d); seen.push(el.value); }
    el.blur();
    const el2 = document.querySelector('#inEnd');
    el2.focus(); el2.select();
    for (const d of ['9', '3', '0']) document.execCommand('insertText', false, d);
    const nine = el2.value;
    el2.blur();
    return { seen, live: el.value, nine, nineFinal: el2.value };
  })()`);
  record('I-03', '边打边补冒号：1532→15:32，930→9:30，blur 规范成 09:30',
    e3.seen.join(',') === '1,15,15:3,15:32' && e3.live === '15:32' && e3.nine === '9:30' && e3.nineFinal === '09:30',
    JSON.stringify(e3));

  /* ---------- I-04 非法时间回退 ---------- */
  const e4 = await R(`(() => {
    const el = document.querySelector('#inStart');
    el.focus();
    el.value = '2400';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.blur();
    return { value: el.value, bad: el.classList.contains('bad') };
  })()`);
  record('I-04', '非法时间 2400：回退到上次合法值并标红，不会存进配置',
    e4.value === '15:32' && e4.bad === true, JSON.stringify(e4));

  await openSheet();
  await R(`document.querySelector('#inStart').focus(); document.querySelector('#inStart').blur(); 'x'`);
  await sleep(200);

  /* ---------- I-05 滑块：打开 → 拖动 → 确定 ---------- */
  const t5 = await R(`(() => {
    const el = document.querySelector('#inStart');
    el.value = '09:00';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.parentElement.querySelector('.tin-btn').click();
    const open = { mask: !document.querySelector('#tpMask').hidden, preview: document.querySelector('#tpPreview').textContent,
      title: document.querySelector('#tpTitle').textContent };
    const h = document.querySelector('#tpHour'), m = document.querySelector('#tpMin');
    h.value = 15; h.dispatchEvent(new Event('input', { bubbles: true }));
    m.value = 30; m.dispatchEvent(new Event('input', { bubbles: true }));
    const live = el.value;
    document.querySelector('#tpOk').click();
    return { open, live, after: el.value };
  })()`);
  await sleep(320);
  const t5b = await R(`({ hidden: document.querySelector('#tpMask').hidden, on: document.querySelector('#tpMask').classList.contains('on') })`);
  record('I-05', '点小时钟开滑块（预览=当前值）→ 拖到 15:30 实时写回 → 确定后浮层收起',
    t5.open.mask && t5.open.preview === '09:00' && t5.open.title.indexOf('上班时间') === 0
    && t5.live === '15:30' && t5.after === '15:30' && t5b.hidden === true,
    JSON.stringify({ open: t5.open, live: t5.live, after: t5.after, hidden: t5b.hidden }));

  /* ---------- I-06 滑块取消还原 ---------- */
  const t6 = await R(`(() => {
    const el = document.querySelector('#inStart');
    el.parentElement.querySelector('.tin-btn').click();
    const h = document.querySelector('#tpHour'), m = document.querySelector('#tpMin');
    h.value = 8; h.dispatchEvent(new Event('input', { bubbles: true }));
    m.value = 20; m.dispatchEvent(new Event('input', { bubbles: true }));
    const dragged = el.value;
    document.querySelector('#tpCancel').click();
    return { dragged, after: el.value };
  })()`);
  await sleep(300);
  const t6b = await R(`(() => {
    const el = document.querySelector('#inStart');
    el.blur();
    return { v: el.value, hidden: document.querySelector('#tpMask').hidden };
  })()`);
  record('I-06', '滑块拖成 08:20 后点「取消」→ 值还原成 15:30，浮层收起',
    t6.dragged === '08:20' && t6.after === '15:30' && t6b.v === '15:30' && t6b.hidden === true,
    JSON.stringify({ dragged: t6.dragged, after: t6.after, final: t6b.v }));

  /* ---------- I-07 快捷项 ---------- */
  const t7 = await R(`(() => {
    const el = document.querySelector('#inStart');
    el.parentElement.querySelector('.tin-btn').click();
    document.querySelector('#tpQuick button[data-q="12:00"]').click();
    const noon = el.value;
    document.querySelector('#tpQuick button[data-q="now"]').click();
    const now = el.value;
    const d = new Date();
    const real = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    document.querySelector('#tpCancel').click();
    return { noon, now, real };
  })()`);
  const minDiff = Math.abs(parseInt(t7.now.slice(0, 2), 10) * 60 + parseInt(t7.now.slice(3), 10)
    - (parseInt(t7.real.slice(0, 2), 10) * 60 + parseInt(t7.real.slice(3), 10)));
  record('I-07', '滑块快捷项：12:00 一键到位；「现在」= 系统当前时间（±1 分钟）',
    t7.noon === '12:00' && minDiff <= 1, JSON.stringify({ noon: t7.noon, now: t7.now, real: t7.real }));

  /* ---------- I-08 补录输入同一套逻辑 ---------- */
  await R(`document.querySelector('#btnCloseSheet').click(); 'x'`);
  await sleep(500);
  const t8 = await R(`(() => {
    const b = document.querySelector('#btnFix');
    if (b.hidden) return { skip: true };
    b.click();
    const el = document.querySelector('#inFixStart');
    el.focus(); el.select();
    document.execCommand('insertText', false, '10:30');
    el.setSelectionRange(5, 5);
    document.execCommand('delete');
    const afterDel = el.value;
    document.execCommand('insertText', false, '5');
    const afterIns = el.value;
    el.blur();
    const afterBlur = el.value;
    const btn = el.parentElement.querySelector('.tin-btn');
    btn.click();
    const opened = !document.querySelector('#tpMask').hidden;
    document.querySelector('#tpHour').value = 7;
    document.querySelector('#tpHour').dispatchEvent(new Event('input', { bubbles: true }));
    const picked = el.value;
    document.querySelector('#tpOk').click();
    return { afterDel, afterIns, afterBlur, final: el.value, opened, picked };
  })()`);
  await sleep(300);
  record('I-08', '补录时间框：中间删改不跳位（10:30 → 10:35）+ 小时钟能开滑块并写回 07:35',
    t8.afterDel === '10:3' && t8.afterIns === '10:35' && t8.afterBlur === '10:35'
    && t8.opened === true && t8.picked === '07:35' && t8.final === '07:35',
    JSON.stringify(t8));

  /* 关掉补录 */
  await R(`(() => { const b = document.querySelector('#btnFixCancel'); if (b && !document.querySelector('#miniMask').hidden) b.click(); return 'x'; })()`);
  await sleep(400);

  /* ---------- I-09 目标金额步进 ---------- */
  await openSheet();
  const g9 = await R(`(() => {
    document.querySelector('#goalGroup').open = true;
    const el = document.querySelector('#inGoalAmount');
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const host = el.parentElement;
    const up = host.querySelector('.ns-up'), dn = host.querySelector('.ns-dn');
    const seq = [];
    up.click(); seq.push(el.value);
    up.click(); seq.push(el.value);
    up.click(); seq.push(el.value);
    dn.click(); seq.push(el.value);
    return { seq, step: el.step, min: el.min };
  })()`);
  record('I-09', '目标金额清空后连点向上 = 1、2、3，再向下 = 2（step 改成 1，不再 1/101/201）',
    g9.seq.join(',') === '1,2,3,2' && g9.step === '1', JSON.stringify(g9));

  /* ---------- I-10 其它数字框从下限起步 ---------- */
  const g10 = await R(`(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      const host = el.closest('.num-wrap') || el.closest('.f-num');
      const up = host.querySelector('.ns-up');
      up.click(); const a = el.value;
      up.click(); const b = el.value;
      return [a, b];
    };
    const salary = pick('#inSalary');
    const days = pick('#inDays');
    const saved = pick('#inSaved');
    return { salary, days, saved };
  })()`);
  record('I-10', '清空后点向上：月到手 100→200、天数 1→1.5、存款 100→200（按各自 step/min 走）',
    g10.salary[0] === '100' && g10.days[0] === '1' && g10.days[1] === '1.5' && g10.saved[0] === '100',
    JSON.stringify(g10));

  /* ---------- I-11 控件齐全 ---------- */
  const s11 = await R(SNAP);
  const allTins = await R(`(() => {
    const ids = ['inStart', 'inEnd', 'inLunchStart', 'inLunchEnd', 'inFixStart', 'inFixEnd'];
    const out = {};
    ids.forEach((id) => {
      const el = document.getElementById(id);
      const b = el && el.parentElement.querySelector('.tin-btn');
      out[id] = !!b;
    });
    out.numbers = [...document.querySelectorAll('input[type=number]')].map((e) => {
      const host = e.closest('.num-wrap') || e.closest('.f-num');
      return !!(host && host.querySelector('.num-spin'));
    });
    return out;
  })()`);
  record('I-11', '6 个时间框都有小时钟、5 个数字框都有自绘上下箭头',
    s11.tins === 6 && s11.numInputs === 5 && s11.spins === 5
    && Object.keys(allTins).filter((k) => k !== 'numbers').every((k) => allTins[k])
    && allTins.numbers.length === 5 && allTins.numbers.every(Boolean),
    '时钟=' + s11.tins + ' 数字框=' + s11.numInputs + ' 箭头=' + s11.spins);

  /* ---------- I-12 布局：提示条不压输入框、时钟不越界 ---------- */
  const s12 = await R(`(() => {
    const q = (s) => document.querySelector(s);
    const box = (el) => { const r = el.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right) }; };
    return {
      start: box(q('#inStart')), hint: box(q('#spanHint')), lunch: box(q('#inLunchStart')),
      lunchHint: box(q('#lunchHint')),
      startBtn: box(q('#inStart').parentElement.querySelector('.tin-btn')),
      startWrap: box(q('#inStart').parentElement),
      lunchBtn: box(q('#inLunchStart').parentElement.querySelector('.tin-btn')),
      lunchWrap: box(q('#inLunchStart').parentElement),
      err: box(q('#formErr')), errShown: getComputedStyle(q('#formErr')).display
    };
  })()`);
  const noOverlap = s12.hint.t >= s12.start.b - 1 && s12.lunch.t >= s12.hint.b - 1
    && (s12.lunchHint.t >= s12.lunch.b - 1);
  const btnInside = s12.startBtn.l >= s12.startWrap.l && s12.startBtn.r <= s12.startWrap.r + 1
    && s12.lunchBtn.l >= s12.lunchWrap.l && s12.lunchBtn.r <= s12.lunchWrap.r + 1;
  record('I-12', '设置面板排版：提示行不压输入框、午休行不被吞、小时钟在框内、无横向溢出',
    noOverlap && btnInside && !s11.hOverflow,
    JSON.stringify({ hintTop: s12.hint.t, startBottom: s12.start.b, lunchTop: s12.lunch.t,
      btnIn: btnInside, hOverflow: s11.hOverflow }));

  /* ---------- I-13 表单被压缩时按内容高度排 ---------- */
  const s13 = await R(SNAP);
  let overlap = null;
  for (let i = 1; i < s13.kids.length; i++) {
    const prev = s13.kids[i - 1], cur = s13.kids[i];
    if (cur.t < prev.b - 1 && prev.h > 0 && cur.h > 0) overlap = prev.c + ' ↘ ' + cur.c;
  }
  record('I-13', '表单需要滚动时各块仍按内容高度排（相邻块零重叠），表单自身滚动',
    s13.formScrollable && !overlap && s13.formSh > 0,
    '滚动区 ' + s13.formSh + '/' + s13.formCh + ' 重叠=' + (overlap || '无'));

  /* ---------- I-14 焦点自动全选 ---------- */
  // 先 blur 复位：若前序用例已让 #inEnd 保持焦点，重复 focus() 不会触发 focus 事件
  await R(`(() => { const el = document.querySelector('#inEnd'); el.blur(); document.body.focus && document.body.focus(); return 'x'; })()`);
  await sleep(120);
  await R(`document.querySelector('#inEnd').focus(); 'x'`);
  await sleep(150);
  const f14 = await R(`(() => {
    const el = document.querySelector('#inEnd');
    return { a: el.selectionStart, b: el.selectionEnd, len: el.value.length, v: el.value };
  })()`);
  record('I-14', '点进时间框自动整段选中（直接打字就是整段替换）',
    f14.a === 0 && f14.b === f14.len && f14.len === 5, JSON.stringify(f14));

  /* ---------- I-15 超长输入截断 ---------- */
  const t15 = await R(`(() => {
    const el = document.querySelector('#inStart');
    el.focus(); el.select();
    document.execCommand('insertText', false, '123456');
    const live = el.value;
    el.blur();
    return { live, final: el.value };
  })()`);
  record('I-15', '时间多打了（123456）→ 只留 4 位数字 12:34，不会溢出输入框',
    t15.live === '12:34' && t15.final === '12:34', JSON.stringify(t15));

  /* ---------- I-16 Enter 提交 ---------- */
  const t16 = await R(`(() => {
    const el = document.querySelector('#inStart');
    el.focus(); el.select();
    document.execCommand('insertText', false, '830');
    const live = el.value;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const after = el.value;
    return { live, after, focused: document.activeElement === el };
  })()`);
  record('I-16', '打 830 后按回车 → 当场补成 08:30（回车同时等于「存好啦」，和表单习惯一致）',
    t16.live === '8:30' && t16.after === '08:30' && t16.focused === true, JSON.stringify(t16));

  // 上面那条回车会顺手保存并收起面板，后面的用例重新打开
  await openSheet();

  /* ---------- I-17 Esc 关滑块并还原 ---------- */
  const t17 = await R(`(() => {
    const el = document.querySelector('#inStart');
    el.value = '09:00'; el.dispatchEvent(new Event('input', { bubbles: true }));
    el.parentElement.querySelector('.tin-btn').click();
    const h = document.querySelector('#tpHour'); h.value = 6; h.dispatchEvent(new Event('input', { bubbles: true }));
    const dragged = el.value;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { dragged, after: el.value, hidden: document.querySelector('#tpMask').hidden };
  })()`);
  await sleep(300);
  const t17b = await R(`({ hidden: document.querySelector('#tpMask').hidden, sheetOn: document.querySelector('#sheet').classList.contains('on') })`);
  record('I-17', '滑块里按 Esc → 浮层关掉、值还原、设置面板不被一起关掉',
    t17.dragged === '06:00' && t17.after === '09:00' && t17b.hidden === true && t17b.sheetOn === true,
    JSON.stringify({ dragged: t17.dragged, after: t17.after, hidden: t17b.hidden, sheetOn: t17b.sheetOn }));

  /* ---------- I-18 分钟位不会越写越长 ---------- */
  await R(`(() => { const el = document.querySelector('#inStart'); el.blur(); return 'x'; })()`);
  await sleep(120);
  const t18 = await R(`(() => {
    const el = document.querySelector('#inStart');
    el.focus(); el.select();
    document.execCommand('insertText', false, '9:30');
    el.setSelectionRange(4, 4);
    document.execCommand('insertText', false, '0');   // 在分钟后再补一位
    const live = el.value;
    el.blur();
    return { live, final: el.value };
  })()`);
  record('I-18', '分钟位多打一位（9:30 再补 0）→ 仍是 9:30，不会变成 9:300',
    t18.live === '9:30' && t18.final === '09:30', JSON.stringify(t18));

  const s14 = await R(`(() => {
    const el = document.querySelector('#inGoalAmount');
    return { v: el.value, step: el.step };
  })()`);
  record('I-19', '目标金额输入框仍是合法值、step=1（控件改动没污染数据）',
    /^\d+$/.test(s14.v) && s14.step === '1', JSON.stringify(s14));
}

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: geo.NORMAL.width, height: geo.NORMAL.height, show: true, frame: false,
    resizable: false, maximizable: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, spellcheck: false
    }
  });
  win.setMenuBarVisibility(false);
  win.setBounds(win.getBounds());
  win.webContents.on('console-message', (e, level, msg) => {
    const m = String(msg);
    if (level >= 2 && m.indexOf('Electron Security Warning') < 0) consoleErrors.push('[L' + level + '] ' + m.slice(0, 200));
  });
  win.webContents.on('render-process-gone', (e, d) => consoleErrors.push('[CRASH] ' + JSON.stringify(d)));
  win.focus();

  let fatal = null;
  try { await runAll(); } catch (e) { fatal = e && e.stack || String(e); console.log('FATAL | ' + fatal); }

  const passed = results.filter((r) => r.pass).length;
  console.log('SUMMARY | ' + passed + '/' + results.length + ' | consoleErrors=' + consoleErrors.length);
  if (consoleErrors.length) consoleErrors.slice(-5).forEach((m) => console.log('CONSOLE | ' + m));

  const disp = screen.getPrimaryDisplay();
  const md = [];
  md.push('# 输入交互与表单排版测试报告 · 打工人记账器 v' + PKG_VERSION + '\n');
  md.push('- 执行时间：' + new Date().toLocaleString('zh-CN'));
  md.push('- 环境：' + process.getSystemVersion() + ' · ' + disp.size.width + '×' + disp.size.height
    + ' @' + disp.scaleFactor + 'x · Electron ' + process.versions.electron);
  md.push('- 方法：真实键盘编辑（`execCommand` 产生与用户一致的 inputType）+ 真实点击自绘箭头/滑块\n');
  md.push('| 编号 | 验证项 | 结果 | 证据 |');
  md.push('|---|---|---|---|');
  results.forEach((r) => md.push('| ' + r.id + ' | ' + r.name + ' | ' + (r.pass ? '✅' : '❌') + ' | ' + r.detail + ' |'));
  md.push('\n## 结论\n');
  md.push('- ' + passed + '/' + results.length + ' 通过'
    + (fatal ? '（执行中断：' + fatal.split('\n')[0] + '）' : '，无渲染崩溃') + '。');
  fs.writeFileSync(REPORT, md.join('\n'), 'utf8');
  console.log('REPORT | ' + REPORT);
  app.exit(0);
});
