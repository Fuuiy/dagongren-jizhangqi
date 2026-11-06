/* ===== 打工人记账器 · 逻辑 ===== */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const STORE_KEY = 'dgjz.worker.v1';
  const MIN = 60000;
  const DAY = 86400000;

  const DEFAULTS = {
    salary: 8000,
    workDays: 22,
    daysMode: 'double',   // double | bigsmall | single | custom
    start: '08:00',       // 默认早八
    end: '17:00',         // 默认晚五
    lunchStart: '12:00',
    lunchEnd: '13:00',
    clockFrom: 'click',    // click = 打卡那一刻 | schedule = 按上班时间
    autoRun: false,        // 仅「按上班时间」有效：true 全自动，false 需在窗口内打卡
    segments: [],          // 实际干活的时段 [{from,to}]
    goalEmoji: '📱',
    goalName: '买台新手机',
    goalAmount: 5999,
    savedBase: 0,
    settled: 0,
    clockIn: null,
    doneShift: null,
    lastShift: null,
    leaves: {},            // 请假标记：{ '2026-11-4': true }
    dailyHours: null,      // 每日有效工时（小时），null = 按班次推导
    todaySettled: null,    // 今天已固化的部分 { day, seconds, amount }
    dailyLog: {},          // 每天赚了多少：{ '2026-11-4': 363.64 }
    fixDay: '',            // 补录区间属于哪一天
    fixRanges: [],         // 今天已补录的区间 [{from,to}]，防止重复补
    holidays: {},          // 联网拿到的节假日：{ '2026-01-01': true=放假 / false=调休上班 }
    holidayCheckedAt: 0,   // 上次联网检查的时间
    inited: false,
    // 是否由用户亲自确认过参数（用默认值继续 = false，首页会一直挂提示条）
    confirmedByUser: false,
    // 点窗口 × 时收进托盘还是直接退出
    closeToTray: true,
    // 加班费倍率：只作用于「补录的班外加班」
    otRate: 1,
    // 切换计时方式的那一刻：本班从这时起算（null = 从班次开始算，也就是没切过）
    // 只对 timerFromKey 这一班有效，换班/次日自动作废
    timerFrom: null,
    timerFromKey: null
  };

  const EMOJIS = ['🎯', '📱', '💻', '🎧', '🏠', '✈️', '🎁', '🍰', '👗', '🚗'];

  const QUOTES = [
    '摸鱼一分钟，等于白赚 {min}',
    '钱是一秒一秒来的，班是一天一天上的',
    '今天的你，也在为明天的自己打工',
    '别急着下班，先把工资赚回本',
    '你不是在上班，你是在给自己发钱',
    '工资条不会说谎，进度条会',
    '把每一秒都算清楚，才不算白熬',
    '还有 {todo} 就又能买杯奶茶了',
    '起身走两步吧，腰也是你的资产',
    '目标不会自己跑过来，但你可以走过去',
    '喝口水，顺便赚 {min}',
    '今天的进度条，比昨天更满一点'
  ];

  let cfg = null;
  let celebrated = false;
  let modeConfirmSkip = false;   // 切模式确认弹窗里点了「确定切换」后跳过二次询问
  let pendingMode = 'click';   // 第 6 条：卡片只改 pending，保存后才生效
  let pendingAuto = false;
  let lastGoalPct = null;      // 上一帧的目标进度，用来判断「刚刚达成」
  let saveArmed = false;       // 保存前确认（防止把班次填错直接存进去）
  let saveTimer = null;
  let lastShownEarned = 0;
  let delTimer = null;         // 删除补录的二次确认倒计时

  /* ---------- 存储 ---------- */
  function load() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { raw = null; }
    const m = Object.assign({}, DEFAULTS, raw || {});

    m.salary = num(m.salary, DEFAULTS.salary);
    // 旧版本没拦 0 / 负数，存进去就是「时薪 0」的死数据：
    // 当成没设置过处理，启动后让他重新填一次，别让界面一直显示 0
    if (!(m.salary > 0)) { m.salary = DEFAULTS.salary; m.inited = false; }
    m.workDays = clamp(num(m.workDays, 22), 1, 31);
    m.goalAmount = Math.max(1, num(m.goalAmount, 5999));
    m.savedBase = Math.max(0, num(m.savedBase, 0));
    // 目标名最长 12 字：粘贴、导入都可能塞进来更长的一串，统一截断
    if (typeof m.goalName !== 'string' || !m.goalName.trim()) m.goalName = DEFAULTS.goalName;
    else m.goalName = Array.from(m.goalName.trim()).slice(0, 12).join('');
    m.settled = Math.max(0, num(m.settled, 0));

    m.start = validHM(m.start) || '09:00';
    m.end = validHM(m.end) || '18:00';

    const hadLunchRange = !!(raw && validHM(raw.lunchStart) && validHM(raw.lunchEnd));
    if (!hadLunchRange) {
      const mins = clamp(num(raw && raw.lunchMin, 60), 0, 600);
      m.lunchStart = '12:00';
      m.lunchEnd = addMinutes('12:00', mins);
    }
    if (m.clockFrom !== 'schedule') m.clockFrom = 'click';
    m.autoRun = !!m.autoRun;
    if (!Array.isArray(m.segments)) m.segments = [];
    // 老数据只有 clockIn，转成一个正在进行的段
    if (!m.segments.length && typeof m.clockIn === 'number' && m.clockIn > 0) {
      m.segments = [{ from: m.clockIn, to: null }];
    }
    if (!m.segments.length) m.clockIn = null;
    if (typeof m.doneShift !== 'number') m.doneShift = null;
    if (!m.lastShift || typeof m.lastShift !== 'object') m.lastShift = null;
    if (!m.leaves || typeof m.leaves !== 'object' || Array.isArray(m.leaves)) m.leaves = {};
    // 老数据 leaves[k] === true，迁移成「整天请假」的区间
    Object.keys(m.leaves).forEach((k) => {
      const v = m.leaves[k];
      if (v === true) {
        const d = new Date();
        const p2 = k.split('-');
        d.setFullYear(+p2[0], +p2[1] - 1, +p2[2]);
        d.setHours(0, 0, 0, 0);
        m.leaves[k] = [{ from: d.getTime(), to: d.getTime() + 86400000 }];
      } else if (!Array.isArray(v)) {
        delete m.leaves[k];
      }
    });
    m.dailyHours = (typeof m.dailyHours === 'number' && m.dailyHours > 0) ? m.dailyHours : null;
    if (!m.todaySettled || typeof m.todaySettled !== 'object') m.todaySettled = null;
    if (!m.dailyLog || typeof m.dailyLog !== 'object' || Array.isArray(m.dailyLog)) m.dailyLog = {};
    if (!Array.isArray(m.fixRanges)) m.fixRanges = [];
    if (typeof m.fixDay !== 'string') m.fixDay = '';
    if (!m.holidays || typeof m.holidays !== 'object' || Array.isArray(m.holidays)) m.holidays = {};
    if (typeof m.holidayCheckedAt !== 'number') m.holidayCheckedAt = 0;
    // 老用户（已经填过参数）不存在「用默认值混过去」这回事，直接算确认过
    if (typeof m.confirmedByUser !== 'boolean') m.confirmedByUser = m.inited === true;
    if (typeof m.closeToTray !== 'boolean') m.closeToTray = true;
    m.otRate = (m.otRate === 1.5 || m.otRate === 2) ? m.otRate : 1;
    // 切换模式后的「本班起算点」：老存档没有就是没切过 → null
    if (typeof m.timerFrom !== 'number' || !isFinite(m.timerFrom)) m.timerFrom = null;
    if (typeof m.timerFromKey !== 'string') m.timerFromKey = null;
    // 旧版本日期键没有前导零（2026-11-4），外部导入的备份又是有的（2026-11-04）。
    // 统一迁移成补零格式，同一天撞上了就合并，否则明细里一天会拆成两行
    const normKey = (k) => {
      const p = String(k).split('-');
      if (p.length !== 3) return String(k);
      const y = +p[0], mo = +p[1], da = +p[2];
      if (!y || !mo || !da) return String(k);
      const p2 = (n) => String(n).padStart(2, '0');
      return y + '-' + p2(mo) + '-' + p2(da);
    };
    Object.keys(m.dailyLog).forEach((k) => {
      const nk = normKey(k);
      if (nk === k) return;
      m.dailyLog[nk] = (m.dailyLog[nk] || 0) + (m.dailyLog[k] || 0);
      delete m.dailyLog[k];
    });
    Object.keys(m.leaves).forEach((k) => {
      const nk = normKey(k);
      if (nk === k) return;
      m.leaves[nk] = m.leaves[nk] ? m.leaves[nk].concat(m.leaves[k]) : m.leaves[k];
      delete m.leaves[k];
    });
    if (m.fixDay) m.fixDay = normKey(m.fixDay);
    if (m.todaySettled && m.todaySettled.day) m.todaySettled.day = normKey(m.todaySettled.day);
    if (!['double', 'bigsmall', 'single', 'custom'].includes(m.daysMode)) {
      // 老数据没有这个字段：按天数猜一个模式，猜不到就当自定义
      if (Math.abs(m.workDays - 21.75) < 0.3 || Math.abs(m.workDays - 22) < 0.3) m.daysMode = 'double';
      else if (Math.abs(m.workDays - 24) < 0.3) m.daysMode = 'bigsmall';
      else if (Math.abs(m.workDays - 26) < 0.3) m.daysMode = 'single';
      else m.daysMode = 'custom';
    }
    return m;
  }

  // 存档写不进磁盘（磁盘满 / 被占用 / 隐私模式）不能装没事：
  // 内存照常算钱，但界面常驻「未保存」提示，5 秒自动重试，关窗前再抢救一次
  let saveFailed = false;
  let saveRetryTimer = null;

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
      if (saveFailed) { saveFailed = false; updateSaveWarn(); }
      clearTimeout(saveRetryTimer);
      saveRetryTimer = null;
    } catch (e) {
      saveFailed = true;
      updateSaveWarn();
      clearTimeout(saveRetryTimer);
      saveRetryTimer = setTimeout(() => { if (saveFailed) save(); }, 5000);
    }
  }

  function updateSaveWarn() {
    const el = $('#saveWarn');
    if (!el) return;
    el.hidden = !saveFailed;
  }

  window.addEventListener('beforeunload', () => {
    // 关窗 / 刷新前最后一搏：万一这时磁盘恢复了，数据就不会丢
    if (saveFailed) {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) { /* 真没救了 */ }
    }
  });

  function num(v, d) { const n = parseFloat(v); return isFinite(n) ? n : d; }

  function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  // 内置的中国法定节假日与调休（真实数据，离线兜底）
  const HOLIDAY_SEED = {
    '2025': { off: ["2025-01-01", "2025-01-28", "2025-01-29", "2025-01-30", "2025-01-31", "2025-02-01", "2025-02-02", "2025-02-03", "2025-02-04", "2025-04-04", "2025-04-05", "2025-04-06", "2025-05-01", "2025-05-02", "2025-05-03", "2025-05-04", "2025-05-05", "2025-05-31", "2025-06-01", "2025-06-02", "2025-10-01", "2025-10-02", "2025-10-03", "2025-10-04", "2025-10-05", "2025-10-06", "2025-10-07", "2025-10-08"], work: ["2025-01-26", "2025-02-08", "2025-04-27", "2025-09-28", "2025-10-11"] },
    '2026': { off: ["2026-01-01", "2026-01-02", "2026-01-03", "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23", "2026-04-04", "2026-04-05", "2026-04-06", "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05", "2026-06-19", "2026-06-20", "2026-06-21", "2026-09-25", "2026-09-26", "2026-09-27", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"], work: ["2026-01-04", "2026-02-10", "2026-02-11", "2026-02-14", "2026-02-28", "2026-05-09", "2026-09-20", "2026-10-10"] },
  };

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  // 内置表 + 联网更新，合成一张「这一天放不放假」的表
  function holidayMap() {
    const map = {};
    Object.keys(HOLIDAY_SEED).forEach((y) => {
      HOLIDAY_SEED[y].off.forEach((k) => { map[k] = true; });
      HOLIDAY_SEED[y].work.forEach((k) => { map[k] = false; });
    });
    const remote = cfg.holidays || {};
    Object.keys(remote).forEach((k) => { map[k] = !!remote[k]; });
    return map;
  }

  const ymd = (y, m, d) => y + '-' + pad2(m) + '-' + pad2(d);

  // 按当月实际情况数工作日，法定节假日和调休都算进去
  function monthWorkDays(mode, base) {
    const d = base || new Date();
    const y = d.getFullYear(), m = d.getMonth() + 1;
    const total = new Date(y, m, 0).getDate();
    const map = holidayMap();
    let n = 0, satIdx = 0;

    for (let i = 1; i <= total; i++) {
      const w = new Date(y, m - 1, i).getDay();
      const key = ymd(y, m, i);
      if (map[key] === true) continue;         // 法定节假日：不上班
      if (map[key] === false) { n++; continue; } // 调休上班：周末也算
      if (w === 0) continue;                    // 周日固定休
      if (w === 6) {                            // 周六看模式
        satIdx++;
        if (mode === 'single') n++;
        else if (mode === 'bigsmall' && satIdx % 2 === 1) n++;
        continue;
      }
      n++;
    }
    return n;
  }
  const pad2 = (n) => String(n).padStart(2, '0');

  /* ---------- 时间解析 ---------- */
  const hm2min = (s) => {
    const p = String(s).split(':');
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  };

  const validHM = (s) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(s)) ? String(s) : null);

  function addMinutes(hm, mins) {
    const t = (hm2min(hm) + mins) % 1440;
    return pad2(Math.floor(t / 60)) + ':' + pad2(t % 60);
  }

  // 边打边补冒号：1532 → 15:32，930 → 9:30
  // 表单里的时间统一从这里读：5:30 这种没补零的写法也要认
  function readTime(sel) {
    const el = $(sel);
    if (!el) return null;
    return validHM(el.value) || parseHM(el.value);
  }

  function maskHM(digits) {
    const d = String(digits).replace(/\D/g, '').slice(0, 4);
    if (!d) return '';
    if (d.length <= 2) return d;
    // 3 位数字：首字符大于 2 就当成「一位小时 + 两位分钟」（930 → 9:30）
    if (d.length === 3) return d[0] > '2' ? d[0] + ':' + d.slice(1) : d.slice(0, 2) + ':' + d.slice(2);
    // 4 位数字一律是 HHMM，不能拼成 9:300 这种五位怪东西
    return d.slice(0, 2) + ':' + d.slice(2);
  }

  // 把 8、800、0830、8:3 统一成 08:00 / 08:00 / 08:30 / 08:03
  function parseHM(raw) {
    const s = String(raw).replace(/[^\d:]/g, '');
    if (!s) return null;
    let h, m;
    if (s.includes(':')) {
      const p = s.split(':');
      h = parseInt(p[0], 10);
      m = parseInt(p[1], 10);
      if (!isFinite(h)) return null;
      if (!isFinite(m)) m = 0;
    } else if (s.length <= 2) {
      h = parseInt(s, 10); m = 0;
    } else if (s.length === 3) {
      h = parseInt(s.slice(0, 1), 10); m = parseInt(s.slice(1), 10);
    } else {
      h = parseInt(s.slice(0, 2), 10); m = parseInt(s.slice(2, 4), 10);
    }
    if (!isFinite(h) || !isFinite(m) || h > 23 || m > 59) return null;
    return pad2(h) + ':' + pad2(m);
  }

  // 工具就位后再读配置（load 依赖 validHM / addMinutes）
  cfg = load();
  save();   // 顺手把迁移结果落盘
  repairState();
  refreshWorkDays();

  /* ---------- 班次窗口 ---------- */
  function boundsFor(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    const t0 = d.getTime();

    const sMin = hm2min(cfg.start);
    const eMin = hm2min(cfg.end);
    const overnight = eMin <= sMin;
    const spanMin = overnight ? (eMin + 1440 - sMin) : (eMin - sMin);

    const start = t0 + sMin * MIN;
    const end = start + Math.max(1, spanMin) * MIN;

    let lunchStart = 0, lunchEnd = 0;
    let lS = hm2min(cfg.lunchStart);
    let lE = hm2min(cfg.lunchEnd);
    if (lE > lS) {
      while (lS < sMin) { lS += 1440; lE += 1440; }
      let a = t0 + lS * MIN;
      let b = t0 + lE * MIN;
      a = Math.max(a, start);
      b = Math.min(b, end);
      if (b > a) { lunchStart = a; lunchEnd = b; }
    }

    return { start, end, lunchStart, lunchEnd, hasLunch: lunchEnd > lunchStart, overnight, spanMin, t0 };
  }

  function shiftAt(ts) {
    const b = boundsFor(ts);
    if (ts < b.start) {
      const prev = boundsFor(ts - DAY);
      if (prev.end > ts) return prev;
    }
    return b;
  }

  function dayMinutes() {
    const b = boundsFor(Date.now());
    const lunch = b.hasLunch ? (b.lunchEnd - b.lunchStart) / MIN : 0;
    return Math.max(30, b.spanMin - lunch);
  }

  // 实际计薪工时：优先「每日有效工时」，否则按班次推导
  function effectiveMinutes() {
    if (cfg.dailyHours && cfg.dailyHours > 0) return cfg.dailyHours * 60;
    return dayMinutes();
  }

  // 全项目唯一的算钱入口（别处不得再用 cfg.salary）
  function calc() {
    const mins = effectiveMinutes();
    const hours = Math.max(0.001, mins / 60);      // 除数兜底：0 会让单价变成 Infinity
    const days = cfg.workDays > 0 ? cfg.workDays : 1;
    const salary = cfg.salary > 0 ? cfg.salary : 0;
    const perDay = salary / days;                  // 日薪
    const perHour = perDay / hours;
    const perMin = perHour / 60;
    const perSec = perDay / (hours * 3600);        // = 日薪 ÷ (H × 3600)
    return { mins, hours, perDay, perHour, perMin, perSec, capSec: hours * 3600 };
  }

  /* ---------- 两种计时方式 ---------- */
  const segs = () => (Array.isArray(cfg.segments) ? cfg.segments : []);
  const shiftOrigin = () => (segs().length ? segs()[0].from : null);

  function isOnBreak() {
    const s = segs();
    return s.length > 0 && s[s.length - 1].to != null;
  }

  // 这一班的「计薪起点」：正常是班次开始；如果用户中途切过计时方式，
  // 则从切换那一刻起算（切换 = 今天重新开始，不能让新口径把切换前的时段白送一遍）
  function timerStartOf(b) {
    const tf = cfg.timerFrom;
    if (typeof tf !== 'number' || !isFinite(tf)) return b.start;
    // 只有「全自动」用起算点。定点打卡的规则是「按设定班次全天计薪」，
    // 从切换时刻算会把「早退也拿全天」这条交底约定弄坏
    if (!(cfg.clockFrom === 'schedule' && cfg.autoRun)) return b.start;
    // 只对「这一班」有效：换到别的班次/第二天自动作废，不会把起算点带到明天
    if (cfg.timerFromKey !== dayKey(b.start)) return b.start;
    return Math.max(b.start, Math.min(tf, b.end));
  }

  // 自动模式：按设定时间算，午休自动暂停
  function scheduleSeconds(now, b) {
    const s0 = timerStartOf(b);
    const t1 = Math.min(now, b.end);
    if (t1 <= s0) return 0;
    let sec = (t1 - s0) / 1000;
    const ls = Math.max(s0, b.lunchStart);
    const le = Math.min(t1, b.lunchEnd);
    if (le > ls) sec -= (le - ls) / 1000;
    return Math.max(0, sec);
  }

  // 手动模式：按实际打卡时段累加（不裁到班次，加班也照算）
  function manualSeconds(now) {
    let sec = 0;
    for (const g of segs()) {
      const to = g.to == null ? now : g.to;
      if (to > g.from) sec += (to - g.from) / 1000;
    }
    return Math.max(0, sec);
  }

  function workSeconds(now) {
    if (cfg.clockFrom === 'schedule') {
      // 非自动模式下，没打卡就不算钱
      if (!cfg.autoRun && !segs().length) return 0;
      const b = shiftAt(now);
      // 请假期间不算钱，但请假之前已经干的那段照算
      return Math.max(0, scheduleSeconds(now, b) - leaveSeconds(now, b));
    }
    if (!segs().length) return 0;
    return manualSeconds(now);
  }

  /* ---------- 状态 ---------- */
  const GRACE = 30 * MIN;   // 「按上班时间·手动」上下班各放宽 30 分钟

  function currentState(now) {
    const b = shiftAt(now);
    const mode = cfg.clockFrom;                 // click | schedule
    const auto = mode === 'schedule' && !!cfg.autoRun;
    const origin = shiftOrigin();
    const started = mode === 'click'
      ? !!origin
      : (!!origin && shiftAt(origin).start === b.start);
    const onBreak = mode === 'click' && started && isOnBreak();

    const before = now < b.start;
    const within = now >= b.start && now < b.end;
    const after = now >= b.end;
    const inWindow = now >= b.start - GRACE && now <= b.end + GRACE;

    // 自动模式完全由时间驱动：到点就是到点，不认「收工标记」
    // 手动模式才看 doneShift（用户自己点了下班）
    const done = auto ? after : (cfg.doneShift === b.start);

    const onLeave = isOnLeaveNow(now);
    const onLunch = auto && b.hasLunch && now >= b.lunchStart && now < b.lunchEnd;

    // 切换计时方式时已经过了下班点：这一班在新口径下「没开始就结束了」，
    // 不能再按整天算钱，状态也不该说"已收工"（那是干完了才有的词）。
    // 只对全自动有意义：定点打卡没打卡天然就是 0，「过点」由 after 分支负责。
    const switchedCut = (() => {
      if (!auto) return false;
      const tf = cfg.timerFrom;
      if (typeof tf !== 'number' || !isFinite(tf)) return false;
      if (cfg.timerFromKey !== dayKey(b.start)) return false;
      return tf >= b.end;
    })();

    let running = false;
    if (onLeave || onLunch) running = false;
    else if (auto) running = within && !switchedCut;
    else if (mode === 'schedule') running = started && !done && within;
    else running = started && !onBreak;         // 打卡那一刻：不受上下班时间约束

    return { b, mode, auto, origin, started, onBreak, onLunch, done, before, within, after,
      running, inWindow, onLeave, switchedCut };
  }

  // 跨月了，按当月实际重新数一遍工作日
  function refreshWorkDays() {
    if (!cfg.daysMode || cfg.daysMode === 'custom') return;
    const n = monthWorkDays(cfg.daysMode);
    if (n !== cfg.workDays) { cfg.workDays = n; save(); }
  }

  // 修复历史残留：自动模式下没到下班点却带着「已收工」标记（多因切换过模式）
  function repairState() {
    const now = Date.now();
    const b = shiftAt(now);
    const auto = cfg.clockFrom === 'schedule' && !!cfg.autoRun;

    // 老补录记录：from/to 存的是「用户输入的整段」，但全自动/定点只对班外那截计薪
    // （填 09:00–18:00、班次 09:00–17:00 时，实际只给 17:00–18:00 的钱）。
    // 补上 parts，否则列表会写成「09:00–18:00（1 小时）」，还会把后面想补的时段错判成重叠。
    if (Array.isArray(cfg.fixRanges) && cfg.fixRanges.length) {
      let touched = false;
      for (const fr of cfg.fixRanges) {
        if (Array.isArray(fr.parts) && fr.parts.length) continue;
        if (typeof fr.from !== 'number' || typeof fr.to !== 'number'
          || typeof fr.sec !== 'number') continue;
        const span = (fr.to - fr.from) / 1000;
        // 跨度没比计薪秒数大多少 → 就是整段（含跨午休的正常偏差）
        if (span <= fr.sec + 120) {
          fr.parts = [{ from: fr.from, to: fr.to }];
          touched = true;
          continue;
        }
        // 班内也有计薪（打卡那一刻）：整段都算钱，只是午休被扣掉了时长
        if (typeof fr.inSec === 'number' && fr.inSec > 0) {
          fr.parts = [{ from: fr.from, to: fr.to }];
          touched = true;
          continue;
        }
        const ps = [];
        if (fr.to <= b.start || fr.from >= b.end) ps.push({ from: fr.from, to: fr.to });
        else {
          if (fr.from < b.start) ps.push({ from: fr.from, to: b.start });
          if (fr.to > b.end) ps.push({ from: b.end, to: fr.to });
        }
        fr.parts = ps.length ? ps : [{ from: fr.from, to: fr.to }];
        touched = true;
      }
      if (touched) save();
    }

    if (!auto) return;
    if (now < b.end && (cfg.doneShift != null || (cfg.lastShift && cfg.lastShift.start === b.start))) {
      cfg.doneShift = null;
      cfg.lastShift = null;
      save();
    }
  }

  // 今天的请假区间：[{from, to}]，to == null 表示还在请
  function leavesOf(now) {
    const v = cfg.leaves[dayKey(now)];
    return Array.isArray(v) ? v : [];
  }

  function isOnLeaveNow(now) {
    return leavesOf(now).some((s) => s.to == null || (now >= s.from && now < s.to));
  }

  // 请假区间落在本班内的秒数（只扣这段时间）
  // 注意：请假若跨过午休，午休本来就不计薪，不能重复扣一遍
  function leaveSeconds(now, b) {
    const limit = Math.min(now, b.end);
    let sec = 0;
    for (const s of leavesOf(now)) {
      const from = Math.max(s.from, b.start);
      const to = Math.min(s.to == null ? limit : s.to, limit);
      if (to <= from) continue;
      let d = (to - from) / 1000;
      if (b.hasLunch) {
        const ls = Math.max(from, b.lunchStart);
        const le = Math.min(to, b.lunchEnd);
        if (le > ls) d -= (le - ls) / 1000;
      }
      sec += Math.max(0, d);
    }
    return sec;
  }

  // 今天的「已固化」账本：金额已经进过 settled，显示时要单独叠加
  function baseToday() {
    const k = dayKey(Date.now());
    const t = cfg.todaySettled;
    if (t && t.day === k) return t;
    return { day: k, seconds: 0, amount: 0 };
  }

  function addTodaySettled(sec, amount, otSec) {
    const b = baseToday();
    b.seconds += sec;
    b.amount += amount;
    if (otSec > 0) b.otSec = (b.otSec || 0) + otSec;
    cfg.todaySettled = b;
  }

  // 今天「手动补录」一共加了多少钱/多少秒。
  // 补录是用户自己加的一段，跟计时方式无关，切换模式时不能被顺手抹掉。
  function todayFixTotals(key) {
    const list = (cfg.fixDay === key ? (cfg.fixRanges || []) : []);
    let amount = 0, inSec = 0, otSec = 0;
    for (const fr of list) {
      const at = typeof fr.at === 'number' ? dayKey(fr.at) : key;
      if (at !== key) continue;                     // 只算这一班补的，别的班不动
      amount += typeof fr.amount === 'number' ? fr.amount : 0;
      inSec += typeof fr.inSec === 'number' ? fr.inSec
        : (typeof fr.sec === 'number' ? fr.sec : 0);
      otSec += typeof fr.otSec === 'number' ? fr.otSec : 0;
    }
    return { amount, inSec, otSec };
  }

  // 换了计时方式 = 这一班的时间口径整个换了：
  // 旧规则下「按时间/打卡」算出来的钱一律作废，首页从 0 重新开始；
  // 人工补录的那部分保留（那是用户明确加进去的，不该被模式切换吃掉）。
  function resetTodayTiming(now) {
    const todayK = dayKey(now);
    const shiftK = dayKey(shiftAt(now).start);      // 夜班凌晨时这一班算昨天
    const t = cfg.todaySettled;
    // 只动「属于今天或当前这一班」的账本，昨天以前的绝不能被顺手抹掉
    const target = (t && (t.day === todayK || t.day === shiftK)) ? t.day : null;

    if (!target) {
      cfg.todaySettled = null;
      return;
    }

    const fix = todayFixTotals(target);
    const timingAmt = Math.max(0, (t.amount || 0) - fix.amount);

    if (timingAmt > 0.0005) {
      // 累计与当日明细一起退回，否则「本月已赚」会多出一笔无主的钱
      cfg.settled = Math.max(0, cfg.settled - timingAmt);
      if (typeof cfg.dailyLog[target] === 'number') {
        const left = cfg.dailyLog[target] - timingAmt;
        if (left < 0.005) delete cfg.dailyLog[target];
        else cfg.dailyLog[target] = left;
      }
    }

    if (fix.amount > 0.0005 || fix.inSec > 0 || fix.otSec > 0) {
      cfg.todaySettled = { day: target, seconds: fix.inSec, amount: fix.amount, otSec: fix.otSec };
    } else {
      cfg.todaySettled = null;
    }
  }

  // 计费秒数：不超过当天应出勤时长（第 3 条封顶）
  function billableOf(sec, alreadySec) {
    const c = calc();
    const room = Math.max(0, c.capSec - (alreadySec || 0));
    return { billable: Math.min(sec, room), room };
  }

  function settle(shiftStart, sec) {
    const c = calc();
    const base = baseToday();
    // 真实打卡的起止：收工后时间轴按这个画，而不是回到填写的班次时间
    const sg = segs();
    const actualFrom = sg.length ? sg[0].from : null;
    const actualTo = sg.length ? (sg[sg.length - 1].to == null ? Date.now() : sg[sg.length - 1].to) : null;
    const { billable, room } = billableOf(sec, base.seconds);
    const amount = billable * c.perSec;
    cfg.settled += amount;                       // 只增不改
    // 跨天结算时钱属于「班次那一天」，不能记到结算发生的今天
    const logKey = dayKey(shiftStart);
    // 0 元结算（切换模式时已经过了下班点）不要往明细里塞一行「¥0.00」
    if (amount > 0.0000001) cfg.dailyLog[logKey] = (cfg.dailyLog[logKey] || 0) + amount;
    cfg.doneShift = shiftStart;
    // sec 是「这一班一共多少秒」（不是增量），所以不能和 base.seconds 相加 ——
    // 改了上下班时间后再结算一次，相加会变成 8h+7h=15h，钱却只给 8h
    const shiftSec = Math.max(base.seconds, sec);
    cfg.lastShift = {
      start: shiftStart,
      amount: base.amount + amount,
      seconds: shiftSec,
      overtime: Math.max(0, shiftSec - c.capSec),
      actualFrom: actualFrom,
      actualTo: actualTo
    };
    cfg.segments = [];
    cfg.clockIn = null;
    // 收口但不丢账：把这次结算并入「今日已固化」，重新上班后从这里接着涨
    cfg.todaySettled = {
      day: dayKey(shiftStart),
      seconds: Math.max(base.seconds, sec),
      amount: base.amount + amount,
      otSec: base.otSec || 0
    };
    save();
    void room;
  }

  // 第 2 条：参数变更前把正在计时的部分按旧参数固化
  function settleIfRunning(now) {
    if (!segs().length) return false;
    const b = shiftAt(segs()[0].from);
    let sec;
    if (cfg.clockFrom === 'schedule') {
      sec = scheduleSeconds(now, b);
    } else {
      const last = segs()[segs().length - 1];
      if (last.to == null) last.to = now;
      sec = manualSeconds(now);
    }
    const c = calc();
    const base = baseToday();
    const { billable } = billableOf(sec, base.seconds);
    const amount = billable * c.perSec;
    if (amount > 0) {
      cfg.settled += amount;
      addTodaySettled(sec, amount);
      // 归属日与 settle() 对齐：记到「班次开始那天」，
      // 夜班跨零点改薪时钱不会跑到次日的账上
      const logKey = dayKey(b.start);
      cfg.dailyLog[logKey] = (cfg.dailyLog[logKey] || 0) + amount;
    }
    cfg.segments = [];
    cfg.clockIn = null;
    save();
    return true;
  }

  // 自动模式改参数前：把「从上班到此刻」的秒数按旧单价固化，避免整段被新单价重算
  function settleAutoSoFar(now) {
    if (!(cfg.clockFrom === 'schedule' && cfg.autoRun)) return false;
    const b = shiftAt(now);
    if (cfg.doneShift === b.start) return false;
    const sec = scheduleSeconds(now, b);
    const base = baseToday();
    const delta = Math.max(0, sec - base.seconds);
    if (delta <= 0) return false;
    const { billable } = billableOf(delta, base.seconds);
    const amount = billable * calc().perSec;
    if (amount > 0) {
      cfg.settled += amount;
      addTodaySettled(delta, amount);
      // 同 D-04：归属日跟班次开始日走，夜班凌晨改薪不记到次日
      const logKey = dayKey(b.start);
      cfg.dailyLog[logKey] = (cfg.dailyLog[logKey] || 0) + amount;
      save();
    }
    return true;
  }

  // 打卡那一刻：结算到 to
  function clockOutManual(to) {
    const s = segs();
    if (!s.length) return;
    const last = s[s.length - 1];
    if (last.to == null) last.to = to;
    settle(shiftAt(s[0].from).start, manualSeconds(to));
  }

  // 按上班时间·手动：金额只认设定区间
  function clockOutSched(b) {
    settle(b.start, scheduleSeconds(b.end, b));   // 第 5 条：按设定班次结，实际打卡不影响金额
  }

  function autoSettle() {
    const now = Date.now();

    if (cfg.clockFrom === 'schedule') {
      const b = shiftAt(now);
      // 请假当天也可能干过活，到点照样结算，只是把请假那段扣掉
      const payable = (sb) => Math.max(0, scheduleSeconds(sb.end, sb) - leaveSeconds(sb.end, sb));

      // 夜班（22:00–06:00 这种）：下班点一过，shiftAt 就翻到“今天晚上”那一班，
      // 上一班直接被当成“还没到上班时间”，钱和明细都会丢。这里单独把它结掉。
      if (cfg.autoRun && b.overnight && b.start > now) {
        const pb = boundsFor(b.start - DAY);        // 刚结束的那一班
        if (pb.start !== cfg.doneShift && now > pb.end && now - pb.end < 12 * 3600e3) {
          settle(pb.start, payable(pb));
          return;
        }
      }

      if (cfg.doneShift === b.start) return;
      if (cfg.autoRun) {
        if (now > b.end) settle(b.start, payable(b));
      } else if (now > b.end + GRACE && segs().length) {
        // 下班半小时还没打卡，按设定时间自动结算
        settle(b.start, payable(b));
      }
      return;
    }

    // 打卡那一刻：忘了下班时自动收口。
    // 收口的时机取「班次下班点」和「当天 24 点」里更晚的那个：
    // 白班照样能算到 24 点的加班；夜班（22:00–06:00）不会被 0 点腰斩成两段
    const origin = shiftOrigin();
    if (!origin) return;
    const d = new Date(origin);
    d.setHours(0, 0, 0, 0);
    const dayEnd = d.getTime() + DAY;
    const sb = shiftAt(origin);
    const cutoff = Math.max(dayEnd, sb.end);
    if (now <= cutoff) return;
    clockOutManual(cutoff);
  }

  /* ---------- 格式化 ---------- */
  function fmtNum(v, d = 2) {
    const n = isFinite(v) ? v : 0;
    return n.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  const fmtMoney = (v, d = 2) => '¥' + fmtNum(v, d);

  function fmtShort(v) {
    const n = Math.abs(v);
    if (n >= 1e8) return '¥' + (v / 1e8).toFixed(n >= 1e9 ? 0 : 1) + '亿';
    if (n >= 1e4) return '¥' + (v / 1e4).toFixed(n >= 1e5 ? 0 : 1) + '万';
    return fmtMoney(v, Number.isInteger(v) ? 0 : 2);
  }

  function fmtSpan(days) {
    if (!isFinite(days) || days <= 0) return '已经够了';
    if (days < 1) return `${Math.max(1, Math.round(days * 24))} 小时`;
    if (days < 1000) return `${days.toFixed(1)} 天`;
    const years = days / 250;
    if (years < 10000) return `${years.toFixed(years >= 100 ? 0 : 1)} 年`;
    return `${(years / 10000).toFixed(1)} 万年`;
  }

  function fmtPerSec(v) {
    if (!isFinite(v) || v <= 0) return '0.0000';
    return v >= 1 ? v.toFixed(2) : v.toFixed(4);
  }

  // 每秒只有几分钱时，别显示成 +¥0.00
  function fmtCoin(v) {
    if (!isFinite(v) || v <= 0) return '0.00';
    if (v >= 1) return v.toFixed(2);
    if (v >= 0.01) return v.toFixed(3);
    return v.toFixed(4);
  }

  function hms(ms) {
    const t = Math.max(0, Math.floor(ms / 1000));
    return pad2(Math.floor(t / 3600)) + ':' + pad2(Math.floor((t % 3600) / 60)) + ':' + pad2(t % 60);
  }

  const hhmm = (ts) => {
    const d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  };

  function hmShort(sec) {
    const t = Math.max(0, Math.floor(sec / 60));
    return Math.floor(t / 60) + ':' + pad2(t % 60);
  }

  function fmtDuration(min) {
    if (min <= 0) return '无';
    if (min < 60) return min + ' 分钟';
    const h = min / 60;
    return (Number.isInteger(h) ? h : h.toFixed(1)) + ' 小时';
  }

  /* ---------- 渲染 ---------- */
  function render() {
    autoSettle();

    const now = Date.now();
    const c = calc();
    const st = currentState(now);

    // 第 3 条：今日已赚封顶日薪，超出的部分只记加班时长
    // 两种模式的秒数口径不同：
    //   自动模式 —— workSeconds 已是「从上班到此刻」的全天累计
    //   手动模式 —— workSeconds 只是「当前这段」，要加上今天已固化的部分
    const base = baseToday();
    const rawSec = workSeconds(now);
    let totalSec, shownEarned, deltaEarned;
    // 全自动 / 定点打卡：workSeconds 返回的是「从上班到此刻」的全量
    // 打卡那一刻：返回的是「当前这一段」，要加上今天已经固化的部分
    const fullDay = st.auto || st.mode === 'schedule';
    if (fullDay) {
      totalSec = rawSec;
      const delta = Math.max(0, rawSec - base.seconds);
      const room = Math.max(0, c.capSec - base.seconds);
      deltaEarned = Math.min(delta, room) * c.perSec;
      shownEarned = base.amount + deltaEarned;
    } else {
      totalSec = base.seconds + rawSec;
      const { billable } = billableOf(rawSec, base.seconds);
      deltaEarned = billable * c.perSec;
      shownEarned = base.amount + deltaEarned;
    }
    // 加班时长 = 班内超出的部分 + 补录的班外加班（补录不占日薪额度，要单独加）
    const otFix = (cfg.todaySettled && cfg.todaySettled.day === dayKey(now) ? cfg.todaySettled.otSec : 0) || 0;
    const overtimeSec = st.onLeave ? 0 : Math.max(0, totalSec - c.capSec) + otFix;

    // 今天有记录（在跑 / 已请假结算过 / 自动模式）就看今天，否则停在「本班赚了多少」
    // 按「同一班」而不是「同一时间戳」比：改了上下班时间后 start 会变，但那一班还是那一班
    const last = (cfg.lastShift && dayKey(cfg.lastShift.start) === dayKey(st.b.start)) ? cfg.lastShift : null;
    const hasToday = segs().length > 0 || st.auto || base.amount > 0;
    // 已收工：工时用「真正结算的秒数」。否则改了班次会出现「干了 7 小时却拿 8 小时的钱」
    const shownSec = (st.done && last)
      ? last.seconds + otFix
      : (hasToday ? totalSec : (last ? last.seconds : 0)) + otFix;
    if (!hasToday) shownEarned = last ? last.amount : 0;
    lastShownEarned = shownEarned;

    $('#todayEarned').textContent = fmtNum(shownEarned, shownEarned >= 10000 ? 2 : 3);
    $('#perSec').textContent = fmtPerSec(c.perSec);
    $('#worked').textContent = hms(shownSec * 1000);
    // 打卡那一刻：班次时间只是参照，但「应工作多久」要摆在眼前
    const wn = $('#workedNeed');
    if (wn) {
      if (st.mode === 'click') {
        wn.hidden = false;
        wn.textContent = ' / ' + hmShort(c.capSec);
      } else {
        wn.hidden = true;
        wn.textContent = '';
      }
    }

    // 加班：只在超出应出勤时长时出现
    const otPill = $('#otPill');
    if (otPill) {
      if (overtimeSec > 1) {
        otPill.hidden = false;
        $('#otTime').textContent = hmShort(overtimeSec);
      } else {
        otPill.hidden = true;
      }
    }

    $('#perHour').textContent = fmtMoney(c.perHour, c.perHour >= 1000 ? 0 : 2);
    $('#perDay').textContent = fmtMoney(c.perDay, 0);
    $('#perMin').textContent = fmtMoney(c.perMin, 2);
    // 主卡给 2 位（0.0198 读不出感觉），精确值挂在 title 上，鼠标停留能看到
    $('#perSecCard').textContent = fmtMoney(c.perSec, 2);
    $('#perSecCard').title = fmtMoney(c.perSec, 4) + ' / 秒';

    renderTimeline(now, st);
    renderConvert(shownEarned);
    renderState(st);
    // 目标进度只叠加「还没进 settled 的增量」，已固化的部分已经在 settled 里
    renderGoal(st.done ? 0 : deltaEarned);
    renderClock(st);
    renderDefBar();
    fitGuard();
  }

  /* 首页不滚动（桌面程序不让人"拉"），所以内容必须真的塞得下。
     万一某行提示（比如「是不是忘了点下班」）把高度撑出去了，
     就先收掉最不重要的那行吐槽，保证卡片和按钮永远完整。 */
  // 版面不够时分级收纳：先收「吐槽」，再收「换算卡 / 目标分项」，
  // 绝不牺牲打卡按钮（小屏笔记本 1366×768@125% 就靠这个）
  function fitGuard() {
    const body = document.body;
    body.classList.remove('tight', 'tight2');
    if (body.classList.contains('compact')) return;
    const sc = document.querySelector('.scroll');
    if (!sc) return;
    if (sc.scrollHeight - sc.clientHeight <= 0) return;
    body.classList.add('tight');
    if (sc.scrollHeight - sc.clientHeight <= 0) return;
    body.classList.add('tight2');
  }

  function renderTimeline(now, st) {
    const b = st.b;
    // 打卡那一刻：时间轴完全按「真实打卡」画，不套填写的班次时间
    //   · 计时中 → 从打卡那一刻起，到「打卡 + 班次时长」的预计收工
    //   · 已收工 → 从打卡那一刻起，到真正点下班的时刻（收工后不再变形）
    const lastShift = (cfg.lastShift && cfg.lastShift.start === b.start) ? cfg.lastShift : null;
    const clickDone = st.mode === 'click' && st.done && lastShift
      && typeof lastShift.actualFrom === 'number' && typeof lastShift.actualTo === 'number';
    const byClick = st.mode === 'click' && st.started && !!st.origin;
    let axisStart, axisEnd;
    if (clickDone) {
      axisStart = lastShift.actualFrom;
      axisEnd = Math.max(lastShift.actualFrom + MIN, lastShift.actualTo);
    } else if (byClick) {
      axisStart = st.origin;
      axisEnd = st.origin + b.spanMin * MIN;
    } else {
      axisStart = b.start;
      axisEnd = b.end;
    }
    const span = Math.max(1, axisEnd - axisStart);

    const posPct = clamp(((now - axisStart) / span) * 100, 0, 100);
    $('#tlFill').style.width = posPct + '%';
    $('#tlNow').style.left = clamp(posPct, 3, 97) + '%';

    // 午休块：自动模式画设定区间，手动模式画实际休息区间
    let list = [];
    if (st.auto) {
      if (b.hasLunch) list.push([b.lunchStart, b.lunchEnd]);
    } else if (st.mode === 'click') {
      const sg = segs();
      for (let i = 0; i < sg.length - 1; i++) {
        if (sg[i].to != null && sg[i + 1].from > sg[i].to) list.push([sg[i].to, sg[i + 1].from]);
      }
      if (sg.length && sg[sg.length - 1].to != null) list.push([sg[sg.length - 1].to, now]);
    } else if (b.hasLunch) {
      list.push([b.lunchStart, b.lunchEnd]);
    }
    list = list
      .map(([a, z]) => [Math.max(a, axisStart), Math.min(z, axisEnd)])
      .filter(([a, z]) => z > a);
    renderBreaks(list, axisStart, span);

    const crossDay = new Date(axisEnd).getDate() !== new Date(axisStart).getDate();
    const pre = crossDay ? '次日 ' : '';
    if (clickDone) {
      $('#tlStart').textContent = hhmm(axisStart) + ' 打卡';
      $('#tlEnd').textContent = pre + hhmm(axisEnd) + ' 收工';
    } else if (byClick) {
      $('#tlStart').textContent = hhmm(axisStart) + ' 打卡';
      // 还没点下班：右端只是「干满一班」的预计，别写死成填写的下班时间
      $('#tlEnd').textContent = '预计 ' + pre + hhmm(axisEnd);
    } else {
      $('#tlStart').textContent = hhmm(axisStart) + ' 上班';
      $('#tlEnd').textContent = pre + hhmm(axisEnd) + ' 下班';
    }

    let tlText;
    if (st.onLeave) tlText = '今天请假';
    else if (st.onBreak) tlText = '午休中 · 计时暂停';
    else if (st.onLunch) tlText = '午休中 · 不计薪';
    else if (clickDone) tlText = '已收工 · 共 ' + hmShort((axisEnd - axisStart) / 1000);
    else if (st.done) tlText = '本班已收工';
    else if (st.started) tlText = '打卡于 ' + hhmm(st.origin || now);
    else if (st.before) tlText = '距上班 ' + hms(b.start - now);
    else if (st.within) tlText = '距下班 ' + hms(b.end - now);
    else tlText = '今天结束啦 ♪';
    $('#tlLeft').textContent = tlText;

    // 打卡那一刻：把「本班应工作的时间段 / 时长」摆在时间轴下面当参照，
    // 实际区间仍然只按真实打卡画（这点是之前特意定过的，不改）
    const ref = $('#tlRef');
    if (ref) {
      if (st.mode === 'click') {
        const need = calc().capSec;
        const lunchMin = b.hasLunch ? Math.round((b.lunchEnd - b.lunchStart) / MIN) : 0;
        let txt = '应工作 <b>' + hmShort(need) + '</b>（参照 ' + hhmm(b.start) + '–' + hhmm(b.end)
          + (lunchMin > 0 ? '，含午休 ' + lunchMin + ' 分钟' : '') + '）';
        if (clickDone) {
          txt += ' · 实际干了 ' + hmShort(Math.max(0, (axisEnd - axisStart) / 1000));
        } else if (byClick) {
          const done = manualSeconds(now);
          txt += ' · 已完成 ' + Math.min(100, Math.round((done / need) * 100)) + '%';
        }
        ref.innerHTML = txt;
        ref.hidden = false;
      } else {
        ref.hidden = true;
        ref.textContent = '';
      }
    }

    // 班次明显不合理（跨度太长）时，主界面也要提醒，不用非得打开设置
    const tw = $('#tlWarn');
    if (tw) {
      const spanH = b.spanMin / 60;
      const hTxt = spanH % 1 === 0 ? spanH : spanH.toFixed(1);
      const tooLong = spanH > 16;
      if (b.overnight || tooLong) {
        tw.hidden = false;
        if (tooLong) {
          tw.classList.add('warn');
          tw.textContent = '这一班有 ' + hTxt + ' 小时'
            + (b.overnight ? '（跨夜）' : '') + '，点右上「改一下」核对上下班时间';
        } else {
          tw.classList.remove('warn');
          tw.textContent = '跨夜班：' + hhmm(b.start) + ' 上班 → 次日 ' + hhmm(b.end)
            + ' 下班，共 ' + hTxt + ' 小时';
        }
      } else {
        tw.hidden = true;
        tw.classList.remove('warn');
      }
    }

    // 忘了点「下班啦」：打卡模式没有下班点，钱会一直涨到封顶，
    // 超过班次时长 4 小时还在跑就提醒一句（比默默封顶有用）
    if (tw && byClick && !clickDone && now - axisStart > span + 4 * 3600 * 1000) {
      tw.hidden = false;
      tw.classList.add('warn');
      tw.textContent = '这班已经打了 ' + hmShort((now - axisStart) / 1000)
        + '，是不是忘了点「下班啦」？钱到 ' + hhmm(axisStart + span) + ' 就不涨了';
    }

    // 补录：全自动 / 定点打卡也显示出来，点进去讲清楚为什么不用补（别做成点了没反应）
    const fb = $('#btnFix');
    if (fb) fb.hidden = false;

    // 请假按钮
    const lb = $('#btnLeave');
    if (lb) {
      lb.textContent = st.onLeave ? '取消请假' : '请假';
      lb.classList.toggle('on', st.onLeave);
      // 今天已经收工了，再点请假只会把「已收工」状态清掉，反而更乱
      lb.hidden = st.done && !st.onLeave;
    }
  }

  function renderBreaks(list, origin, span) {
    const layer = $('#tlBreaks');
    while (layer.children.length < list.length) {
      const d = document.createElement('div');
      d.className = 'tl-break';
      d.innerHTML = '<span>午休</span>';
      layer.appendChild(d);
    }
    while (layer.children.length > list.length) layer.lastElementChild.remove();

    list.forEach(([a, z], i) => {
      const el = layer.children[i];
      const l = clamp(((a - origin) / span) * 100, 0, 100);
      const w = clamp(((z - a) / span) * 100, 0, 100 - l);
      el.style.left = l + '%';
      el.style.width = w + '%';
      el.style.display = w < 0.8 ? 'none' : 'flex';
    });
  }

  function renderConvert(earned) {
    const conv = (v) => (v >= 100 ? String(Math.round(v)) : v.toFixed(1));
    $('#cvMilk').textContent = conv(earned / 18);
    $('#cvRice').textContent = conv(earned / 25);
    $('#cvMovie').textContent = conv(earned / 45);
  }

  function renderState(st) {
    const el = $('#workState');
    el.classList.remove('working', 'off');
    if (st.onLeave) { el.textContent = '今天请假'; el.classList.add('off'); return; }
    if (st.onBreak || st.onLunch) { el.textContent = '午休中 ⏸'; el.classList.add('off'); return; }
    if (st.running) { el.textContent = '工作中 ♥'; el.classList.add('working'); return; }
    if (st.done) {
      // 切换模式时已经过了下班点：这一班在新口径下等于没开始，不能说"已收工"
      el.textContent = st.switchedCut ? '今天过点了' : '今日已收工';
      el.classList.add('off');
      return;
    }

    // 自动模式：状态完全由时间推出来
    if (st.auto) {
      if (st.before) el.textContent = '还没到上班时间';
      else el.textContent = '今日已结束';
      el.classList.add('off');
      return;
    }

    // B-05：打卡那一刻不套上下班时段，只有「打了 / 没打」两种
    if (st.mode === 'click') {
      if (st.started) { el.textContent = '该下班了'; el.classList.add('off'); }
      else el.textContent = '还没打卡';
      return;
    }
    if (st.started && st.before) { el.textContent = '已打卡 · 等开工'; el.classList.add('off'); return; }
    if (st.started) { el.textContent = '已打卡 · 待收工'; el.classList.add('off'); return; }
    if (st.before) { el.textContent = '还没到点'; return; }
    if (st.after) { el.textContent = '今天过点了'; el.classList.add('off'); return; }
    el.textContent = '还没打卡';
  }

  // 还差多少时间：按秒薪反推，几秒钟的事就写秒钟，别写成「1 小时」
  function etaText(remain) {
    const c = calc();
    const sec = remain / Math.max(1e-9, c.perSec);
    if (sec < 60) return '还需 ' + Math.max(1, Math.round(sec)) + ' 秒';
    const min = sec / 60;
    if (min < 60) return '还需 ' + Math.max(1, Math.round(min)) + ' 分钟';

    const h = min / 60;
    const perDay = Math.max(1, c.hours);          // 每天实际能干几小时
    if (h < perDay) return '需工作 ' + (h < 10 ? h.toFixed(1) : Math.round(h)) + ' 小时';

    const days = h / perDay;
    if (days < 250) return '约 ' + (days < 10 ? days.toFixed(1) : Math.round(days)) + ' 个工作日';
    return '约 ' + fmtSpan(days);
  }

  function renderGoal(delta) {
    const total = cfg.savedBase + cfg.settled + delta;

    // 本月累计（今天的用实时值替换已记账的部分，避免重复）
  function monthStats(delta) {
    const d = new Date();
    const prefix = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-';
    const todayKey = dayKey(Date.now());
    let sum = 0, days = 0;
    Object.keys(cfg.dailyLog || {}).forEach((k) => {
      if (k.indexOf(prefix) !== 0) return;
      days++;
      if (k !== todayKey) sum += cfg.dailyLog[k] || 0;
    });
    const todayLive = Math.max(0, baseToday().amount + delta);
    if (todayLive > 0) {
      sum += todayLive;
      if (!(cfg.dailyLog || {})[todayKey]) days++;
    }
    return { sum, days };
  }

  // 让人看得懂：钱是哪来的。「今日」= 今天已固化的 + 正在涨的
    const parts = $('#goalParts');
    if (parts) {
      const todayEarned = Math.min(total, Math.max(0, baseToday().amount + delta));
      parts.textContent = '已有 ' + fmtShort(Math.max(0, total - todayEarned))
        + ' + 今日 ' + fmtShort(todayEarned);
    }
    const mo = monthStats(delta);
    const moEl = $('#goalMonth');
    if (moEl) {
      moEl.textContent = '本月已赚 ' + fmtShort(mo.sum) + ' · ' + mo.days + ' 天';
    }

    const goal = Math.max(1, cfg.goalAmount);
    const pct = clamp((total / goal) * 100, 0, 100);
    const remain = Math.max(0, goal - total);
    const c = calc();

    $('#goalEmoji').textContent = cfg.goalEmoji;
    $('#goalName').textContent = cfg.goalName || '未命名目标';
    $('#goalMoney').textContent = '目标 ' + fmtShort(cfg.goalAmount);

    $('#goalFill').style.width = pct + '%';
    const pctEl = $('#goalPct');
    pctEl.textContent = pct >= 100 ? '100% 🎉' : pct.toFixed(1) + '%';
    pctEl.classList.toggle('full', pct >= 100);

    if (remain <= 0) {
      $('#goalRemain').textContent = '目标达成啦 🎉';
      $('#goalEta').textContent = '去下单吧';
      // 只在「刚刚达成」的那一刻撒花，不是每次打开都撒一遍
      if (lastGoalPct !== null && lastGoalPct < 100) celebrateOnce();
    } else {
      $('#goalRemain').textContent = '还差 ' + fmtShort(remain);
      $('#goalEta').textContent = etaText(remain);
    }
    const nextBtn = $('#btnNextGoal');
    if (nextBtn) nextBtn.hidden = remain > 0;
    lastGoalPct = pct;
  }

  /* ---------- 按钮 ---------- */
  function renderClock(st) {
    const btn = $('#btnClock');
    const side = $('#btnBreak');
    const ico = btn.querySelector('.clock-ico');
    const txt = btn.querySelector('.clock-text');
    const hintText = $('#hintText');
    const redo = $('#lnkRedo');

    btn.classList.remove('working', 'done', 'disabled');
    side.classList.remove('breaking');
    side.hidden = true;
    redo.hidden = true;

    // ===== 今天请假：什么都不用做 =====
    if (st.onLeave) {
      btn.classList.add('disabled');
      ico.textContent = '🌴';
      txt.textContent = '今 天 请 假';
      const kept = workSeconds(Date.now()) > 0;
      hintText.textContent = kept
        ? '已经干的那部分照算，之后不再计薪；点「取消请假」可恢复'
        : '今天不计薪，点时间轴上的「取消请假」恢复';
      return;
    }

    // ===== 按上班时间 · 自动：全交给系统时间 =====
    if (st.auto) {
      btn.classList.add('disabled');
      if (st.done) {
        if (st.switchedCut) {
          ico.textContent = '🌙';
          txt.textContent = '今 天 过 点 了';
          hintText.textContent = '换计时方式时已过 ' + cfg.end + '，这一班不补算；明天 ' + cfg.start + ' 自动开始';
        } else {
          ico.textContent = '✅';
          txt.textContent = '今 日 已 收 工';
          hintText.textContent = '明天 ' + cfg.start + ' 自动开始';
        }
      } else if (st.before) {
        ico.textContent = '😴';
        txt.textContent = '还 没 到 上 班 时 间';
        hintText.textContent = '到 ' + cfg.start + ' 自动开始计时';
      } else if (st.onLunch) {
        ico.textContent = '⏸';
        txt.textContent = '午 休 中';
        hintText.textContent = hhmm(st.b.lunchEnd) + ' 自动继续，这段时间不计薪';
      } else if (st.within) {
        ico.textContent = '🕐';
        txt.textContent = '自 动 计 时 中';
        hintText.textContent = st.b.hasLunch
          ? '午休 ' + hhmm(st.b.lunchStart) + '–' + hhmm(st.b.lunchEnd) + ' 自动暂停'
          : '按设定时间自动计时，不用打卡';
      } else {
        ico.textContent = '🌙';
        txt.textContent = '今 天 已 结 束';
        hintText.textContent = '明天 ' + cfg.start + ' 自动开始';
      }
      return;
    }

    // ===== 按上班时间 · 要打卡：窗口 ±30 分钟，计薪只认设定时间 =====
    if (st.mode === 'schedule') {
      if (st.done) {
        btn.classList.add('done');
        ico.textContent = '✅';
        txt.textContent = '今 日 已 收 工';
        hintText.textContent = '今天收工啦，明天 ' + cfg.start + ' 见';
        redo.hidden = false;                     // 误点了可以撤销
        return;
      }
      if (!st.inWindow) {
        btn.classList.add('disabled');
        if (st.before) {
          ico.textContent = '😴';
          txt.textContent = '还 没 到 打 卡 时 间';
          hintText.textContent = cfg.start + ' 前 30 分钟就能打（' + earlyMinus(cfg.start, 30) + ' 起）';
        } else {
          ico.textContent = '🌙';
          txt.textContent = '今 天 已 过 点';
          hintText.textContent = '下班后 30 分钟内才能打卡';
        }
        return;
      }
      if (!st.started) {
        ico.textContent = '💪';
        txt.textContent = '上 班 打 卡';
        hintText.textContent = '打卡后计薪从 ' + cfg.start + ' 开始，不用掐点';
        return;
      }
      btn.classList.add('working');
      ico.textContent = '🏃';
      txt.textContent = '下 班 啦';
      hintText.textContent = st.after
        ? '金额已经停在 ' + cfg.end + '，点一下收工'
        : st.before
          ? '已打卡，到 ' + cfg.start + ' 才开始计薪'
          : '计薪按设定班次，实际打卡不影响金额';
      return;
    }

    // ===== 打卡那一刻：只看你自己的打卡 =====
    if (st.done) {
      btn.classList.add('done');
      ico.textContent = '✅';
      txt.textContent = '今 日 已 收 工';
      hintText.textContent = '今天收工啦，明天见';
      redo.hidden = false;
      return;
    }
    if (!st.started) {
      ico.textContent = '💪';
      txt.textContent = '上 班 打 卡';
      hintText.textContent = '什么时候都能打，只记你真实上班的这段时间';
      return;
    }
    side.hidden = false;
    btn.classList.add('working');
    ico.textContent = '🏃';
    txt.textContent = '下 班 啦';
    if (st.onBreak) {
      side.classList.add('breaking');
      side.querySelector('.clock-ico').textContent = '▶';
      side.querySelector('.clock-text').textContent = '继 续 计 时';
      hintText.textContent = '休息中，计时已暂停';
    } else {
      side.querySelector('.clock-ico').textContent = '⏸';
      side.querySelector('.clock-text').textContent = '午 休 一 下';
      hintText.textContent = '午休会暂停计时，想休息几分钟就按几分钟';
    }
  }

  const earlyMinus = (hm, mins) => {
    const t = (hm2min(hm) - mins + 1440) % 1440;
    return pad2(Math.floor(t / 60)) + ':' + pad2(t % 60);
  };

  /* ---------- 动画 ---------- */
  function quoteTick() {
    const c = calc();
    const todo = Math.max(0.5, 18 - (lastShownEarned % 18));
    const q = QUOTES[Math.floor(Math.random() * QUOTES.length)];
    const el = $('#quote');
    const text = q
      .replace('{min}', fmtMoney(c.perMin, 2))
      .replace('{todo}', fmtMoney(todo, todo < 10 ? 1 : 0));
    el.style.opacity = '0';
    setTimeout(() => { el.textContent = text; el.style.opacity = '1'; }, 380);
  }

  function spawnCoin(amount) {
    const layer = $('#coinLayer');
    if (!layer || layer.childElementCount > 6) return;
    const el = document.createElement('span');
    el.className = 'coin';
    el.textContent = '+¥' + fmtCoin(amount);
    el.style.left = (66 + Math.random() * 24) + '%';
    layer.appendChild(el);
    setTimeout(() => el.remove(), 1300);
  }

  function celebrateOnce() {
    if (celebrated) return;
    celebrated = true;
    const card = document.querySelector('.goal');
    if (card) card.classList.add('complete');
    const icons = ['🎉', '✨', '🎊', '💖', '💰', '⭐'];
    for (let i = 0; i < 34; i++) {
      const el = document.createElement('span');
      el.className = 'confetti';
      el.textContent = icons[Math.floor(Math.random() * icons.length)];
      el.style.left = Math.random() * 100 + 'vw';
      el.style.animationDuration = (2.2 + Math.random() * 1.8) + 's';
      el.style.animationDelay = (Math.random() * 0.9) + 's';
      el.style.fontSize = (12 + Math.random() * 12) + 'px';
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 4800);
    }
  }

  /* ---------- 交互 ---------- */
  /* ---------- 迷你模式：只留「今日已赚」，底部一根横杆来回切 ---------- */
  let compact = false;

  // 按实际内容算窗口该多高（标题栏 + 卡片 + 底部横杆区 + 内边距）
  // 注意：卡片本身在小窗里尺寸不变（宽高都被冻住），所以这个高度是可预测的，
  // 不会出现「先按错的高度缩一次、再纠正」的抖动
  function compactHeight() {
    const tb = document.querySelector('.titlebar');
    const sc = document.querySelector('.scroll');
    const hero = $('#hero');
    const dock = $('#dock');
    if (!tb || !sc || !hero || !dock) return 240;
    const cs = getComputedStyle(sc);
    const padB = parseFloat(cs.paddingBottom) || 0;
    // hero 上面可能还有别的块（比如"默认值"提示条），按实际偏移算，别假设只有 padding
    const padT = Math.max(0, hero.getBoundingClientRect().top - sc.getBoundingClientRect().top);
    const heroH = Math.ceil(hero.getBoundingClientRect().height);
    return Math.ceil(tb.offsetHeight + padT + heroH + padB + dock.offsetHeight);
  }

  // 窗口变矮会触发 max-height 媒体查询（卡片内边距、大字号都会缩），
  // 那会让卡片“跳”一下。缩小前把当前的尺寸写成内联样式冻住，展开时再解开。
  function freezeHeroBox() {
    const sc = document.querySelector('.scroll');
    const hero = $('#hero');
    const num = $('#todayEarned');
    if (!sc || !hero || !num) return;
    sc.style.paddingTop = getComputedStyle(sc).paddingTop;
    hero.style.padding = getComputedStyle(hero).padding;
    num.style.fontSize = getComputedStyle(num).fontSize;
  }
  function unfreezeHeroBox() {
    const sc = document.querySelector('.scroll');
    const hero = $('#hero');
    const num = $('#todayEarned');
    if (sc) sc.style.paddingTop = '';
    if (hero) hero.style.padding = '';
    if (num) num.style.fontSize = '';
  }

  // 底部横杆：两种形态都在，只是"这一下是缩还是展"不一样。
  // 正常态 = 一条较短的杠，点它缩；迷你态 = 一条更长的杠，点它展开。
  function syncCompactBar() {
    const bar = $('#compactBar');
    if (!bar) return;
    if (bar.hidden) bar.hidden = false;
    const tip = compact ? '展开完整面板' : '缩成小窗';
    if (bar.title !== tip) bar.title = tip;
    if (bar.getAttribute('aria-label') !== tip) bar.setAttribute('aria-label', tip);
    bar.classList.toggle('is-expand', compact);
    bar.setAttribute('aria-pressed', compact ? 'true' : 'false');
  }

  function setCompact(on) {
    on = !!on;
    if (on === compact) return;          // 连点也只缩/展一次，避免窗口来回跳
    compact = on;
    if (compact) freezeHeroBox();

    const btn = $('#btnCompact');
    if (btn) {
      btn.title = compact ? '展开完整面板' : '缩成小窗';
      btn.setAttribute('aria-label', btn.title);
    }
    if (compact) {                       // 小窗里放不下任何弹层
      closeFix();
      closeSheet();
      closeHistory();
    }
    document.body.classList.toggle('compact', compact);
    syncCompactBar();
    if (!compact) unfreezeHeroBox();

    const api = window.desktop;
    if (api && api.setCompact) {
      // 只报高度：宽度由主进程按 win-geometry.js 的规则定，这里不重复一份常量
      api.setCompact({ on: compact, height: compact ? compactHeight() : 0 });
    }
  }

  /* ---------- 迷你模式按钮 ---------- */
  function bindCompact() {
    const btn = $('#btnCompact');
    const bar = $('#compactBar');
    if (btn) btn.addEventListener('click', () => setCompact(!compact));
    // 同一个横杆：正常态缩小、迷你态展开
    if (bar) bar.addEventListener('click', () => setCompact(!compact));
    // 托盘右键菜单里的「缩成小窗 / 展开完整面板」
    try {
      const api = window.desktop;
      if (api && api.onTrayCommand) {
        api.onTrayCommand((cmd) => { if (cmd === 'toggle-compact') setCompact(!compact); });
      }
    } catch (e) { /* 浏览器里跑测试时没有托盘，忽略 */ }
    syncCompactBar();

    // 迷你态窗口变窄后，卡片换行可能让实际高度差几个像素：量一次再校正。
    // 只在「算出来的高度」变了才动窗口，不会和用户抢窗口。
    let lastH = 0;
    let t = 0;
    const remeasure = (force) => {
      if (!compact) { lastH = 0; return; }
      const h = compactHeight();
      if (!force && Math.abs(h - lastH) < 3) return;
      lastH = h;
      const api = window.desktop;
      if (api && api.setCompact) api.setCompact({ on: true, height: h });
    };
    window.addEventListener('resize', () => {
      if (!compact) return;
      clearTimeout(t);
      t = setTimeout(() => remeasure(false), 80);
    });
    setInterval(() => remeasure(false), 800);
  }

  function bindWindowControls() {
    const api = window.desktop;
    const pinBtn = $('#btnPin');
    if (!api) {
      document.querySelector('.win-ctrl').style.visibility = 'hidden';
      return;
    }
    $('#btnMin').addEventListener('click', () => api.minimize());
    $('#btnClose').addEventListener('click', () => api.close());

    let pinned = false;
    pinBtn.addEventListener('click', () => {
      pinned = !pinned;
      api.pin(pinned);
      pinBtn.classList.toggle('on', pinned);
      pinBtn.textContent = pinned ? '📍' : '📌';
    });
  }

  function shake(el) {
    if (!el) return;
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
    setTimeout(() => el.classList.remove('shake'), 500);
  }

  function clockIn() {
    const now = Date.now();
    cfg.segments = [{ from: now, to: null }];
    cfg.clockIn = now;
    cfg.doneShift = null;
    cfg.lastShift = null;
    save();
    render();
    quoteTick();
  }

  // 第 1 条：请假要把正在跑的那段真的收掉，不能让它后台继续走
  // 请假 = 从此刻起不计薪；请假之前已经干的那段照算（三种模式一致）
  function enterLeave(now) {
    if (cfg.clockFrom === 'click') {
      settleIfRunning(now);                  // 把已工作的部分固化下来
    }
    const spans = leavesOf(now);
    spans.push({ from: now, to: null });
    cfg.leaves[dayKey(now)] = spans;
    cfg.doneShift = null;                    // 请假了就不算收工
    save();
    render();
  }

  function exitLeave(now) {
    const spans = leavesOf(now);
    const last = spans[spans.length - 1];
    if (last && last.to == null) last.to = now;   // 请假这段时间记为「不计薪」
    cfg.leaves[dayKey(now)] = spans;
    if (cfg.clockFrom === 'click') {
      cfg.segments = [{ from: now, to: null }];   // 从此刻重新开始
      cfg.clockIn = now;
    }
    save();
    render();
  }

  function toggleBreak() {
    const now = Date.now();
    const s = segs();
    if (!s.length) return;
    const last = s[s.length - 1];
    if (last.to == null) last.to = now;                 // 午休开始，暂停计时
    else s.push({ from: now, to: null });               // 午休结束，继续计时
    save();
    render();
  }

  function toggleClock() {
    const now = Date.now();
    const st = currentState(now);

    // 自动模式：按钮本来就不该点
    if (st.auto) { shake($('#btnClock')); return; }

    // 按上班时间 · 手动：只认打卡窗口，金额只认设定区间
    if (st.mode === 'schedule') {
      if (st.done || !st.inWindow) { shake($('#btnClock')); return; }
      if (st.started) { clockOutSched(st.b); render(); quoteTick(); return; }
      clockIn();
      return;
    }

    // 打卡那一刻：随时能打，随时能下
    if (st.started) {
      const wasBreak = st.onBreak;
      const done = () => {
        clockOutManual(now);
        if (wasBreak && cfg.lastShift) {
          cfg.lastShift.breakBefore = true;
          save();
        }
        render();
        quoteTick();
      };
      // 班次时间在打卡模式下只是参照，但它是「应工作多久」的依据：
      // 没干满就下班，先说清楚差多少，别让人以为系统算错了钱
      const worked = manualSeconds(now);
      const need = calc().capSec;
      // 提示里的时长按分钟取整（干了 4 小时零 2 秒，说"少 3:59"会让人以为算错）
      const wMin = Math.floor(worked / 60) * 60;
      if (worked + 30 < need) {
        askDlg('还没干满这一班',
          '现在下班的话，今天算 <b>' + hmShort(wMin) + '</b>，比应工作的 <b>' + hmShort(need)
          + '</b> 少 <b>' + hmShort(Math.max(0, need - wMin)) + '</b>。钱按实际工时算，确定下班吗？',
          '照样下班', '再干一会儿')
          .then((ok) => { if (ok) done(); });
        return;
      }
      done();
      if (worked > need + 60) toast('超出应工作 ' + hmShort(worked - need) + '，按加班算');
      return;
    }
    if (st.done) { shake($('#btnClock')); return; }
    clockIn();
  }

  // 撤销「下班啦」：误点后能回来，已赚的钱不清零
  function redoShift() {
    const now = Date.now();
    const b = shiftAt(now);
    const settledToday = cfg.doneShift === b.start
      || (cfg.lastShift && cfg.lastShift.start === b.start);
    if (!settledToday) { shake($('#btnClock')); return; }

    // 收工前本来在午休，撤销后应该回到午休，而不是直接开始计薪
    const wasBreak = !!(cfg.lastShift && cfg.lastShift.breakBefore);
    cfg.doneShift = null;
    cfg.clockIn = now;
    cfg.segments = wasBreak
      ? [{ from: now, to: now }]      // to 有值 = 暂停中
      : [{ from: now, to: null }];
    save();
    render();
    quoteTick();
  }

  /* ---------- 设置面板 ---------- */
  function syncDaysSeg() {
    const v = num($('#inDays').value, cfg.workDays);
    const mode = cfg.daysMode || 'double';
    document.querySelectorAll('#segDays button').forEach((b) => {
      b.classList.toggle('active', (b.dataset.mode || '') === mode);
    });
    void v;
  }

  function lunchOverlap(lStart, lEnd, start, end) {
    const s = hm2min(start);
    const e0 = hm2min(end);
    const span = e0 > s ? (e0 - s) : (e0 + 1440 - s);
    let a = hm2min(lStart);
    let b = hm2min(lEnd);
    if (b <= a) return 0;
    while (a < s) { a += 1440; b += 1440; }
    return Math.max(0, Math.min(s + span, b) - Math.max(s, a));
  }

  function updateLunchInfo() {
    const a = readTime('#inLunchStart');
    const z = readTime('#inLunchEnd');
    const note = $('#lunchNote');
    const hint = $('#lunchHint');

    if (!a || !z || hm2min(z) <= hm2min(a)) {
      note.textContent = '无午休';
      hint.textContent = '';
      hint.classList.remove('warn');
      return;
    }
    const total = hm2min(z) - hm2min(a);
    const start = readTime('#inStart') || cfg.start;
    const end = readTime('#inEnd') || cfg.end;
    const ov = lunchOverlap(a, z, start, end);

    // 显示的必须是「实际扣掉的时长」：一点没扣就明说「不在班内」，
    // 不能显示总时长让人以为扣了
    note.textContent = ov > 0 ? fmtDuration(ov) : '无（不在班内）';

    const sMin = hm2min(start);
    const eMin = hm2min(end);
    const span = eMin > sMin ? (eMin - sMin) : (eMin + 1440 - sMin);

    const msgs = [];
    if (ov === 0) {
      msgs.push('这段不在上班时段里，不会被扣除');
    } else if (ov < total) {
      msgs.push('午休填了 ' + fmtDuration(total) + '，只有 ' + fmtDuration(ov) + '在班内，只扣这段');
    }
    if (total >= span) {
      msgs.push('午休比整班还长，检查一下');
    } else if (ov >= total && total > 5 * 60) {
      msgs.push('午休 ' + fmtDuration(total) + '？一般不会这么久');
    }
    hint.textContent = msgs.join('；');
    hint.classList.toggle('warn', msgs.length > 0);
  }

  /* 时间输入：边打边补冒号，但绝不重排你正在改的那一位
     v1.10.0 的老实现是「每次 input 都把整个值重新格式化」，
     于是在 14:30 里删掉 4 再补 5，值会被重排成 13:05 之类——
     现在只在「末尾连续打字」时补冒号，删字和中间插入一律不动。 */
  function timeMask(el, inputType) {
    const raw = String(el.value);
    const deleting = /^delete/.test(inputType || '');
    let v = raw.replace(/[^\d:]/g, '');

    // 只留第一个冒号（多打的冒号直接吞掉）
    const ci = v.indexOf(':');
    if (ci >= 0) {
      // 冒号两边各自最多两位：多打的数字直接吞掉，绝不拼出 9:300 / 153:0
      const hh = v.slice(0, ci).replace(/\D/g, '').slice(0, 2);
      const mm = v.slice(ci + 1).replace(/\D/g, '').slice(0, 2);
      return hh + ':' + mm;
    }

    // 数字超过 4 位：截到 4 位（多了的时间不存在）
    const digits = v.replace(/\D/g, '');
    if (digits.length > 4) {
      const d4 = digits.slice(0, 4);
      v = d4.length > 2 ? d4.slice(0, 2) + ':' + d4.slice(2) : d4;
      return v;
    }

    // 还没冒号、又不是在删字 → 边打边补（1532 → 15:32，930 → 9:30）
    if (!deleting) v = maskHM(v);
    return v;
  }

  // extra：值确定后要跟着刷新的一串界面（补录要把校验提示也刷了）
  function bindTimeInput(sel, extra) {
    const el = $(sel);
    if (!el || el._timeBound) return;
    el._timeBound = true;
    el._last = el.value;

    // 点进来整段选中：改时间基本都是「整段换掉」，不用三击；
    // 再点一下（mouseup）就取消全选，允许定位到某一位微调
    el.addEventListener('focus', () => {
      el._selAll = true;
      // 用 setTimeout 而不是 rAF：窗口被遮住/最小化时 rAF 会停，
      // 那时点回来就选不中了；setTimeout 照样跑，而且排在鼠标默认定位之后
      setTimeout(() => {
        if (el._selAll && document.activeElement === el) {
          try { el.select(); } catch (e) {}
        }
      }, 0);
    });
    el.addEventListener('mouseup', () => { el._selAll = false; });

    el.addEventListener('input', (e) => {
      el.classList.remove('bad');
      const next = timeMask(el, e && e.inputType);
      if (next !== el.value) {
        el.value = next;
        // 自动补冒号后光标落到末尾，接着打分钟就是顺着来
        try { el.setSelectionRange(next.length, next.length); } catch (err) {}
      }
      if (extra) extra();
    });

    const commit = () => {
      const v = parseHM(el.value);
      if (!v) {
        el.value = el._last || '';
        if (el.value) el.classList.add('bad');
        shake(el);
        if (extra) extra();
        return;
      }
      el.value = v;
      el._last = v;
      el.classList.remove('bad');
      updateLunchInfo();
      updateSpanHint();
      updateSalaryEcho();
      updateModeHint();
      if (extra) extra();
    };
    el.addEventListener('blur', commit);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { commit(); e.preventDefault(); }
      if (e.key === 'Escape') el.blur();
    });
    return el;
  }

  /* ---------- 时间滑块选择器（所有时间输入共用一个浮层） ---------- */
  let tpTarget = null;
  let tpBack = null;
  let tpRaf = 0;

  function tpValue() {
    return pad2(parseInt($('#tpHour').value, 10) || 0) + ':' + pad2(parseInt($('#tpMin').value, 10) || 0);
  }

  function tpPush() {
    const v = tpValue();
    $('#tpHourVal').textContent = v.slice(0, 2);
    $('#tpMinVal').textContent = v.slice(3);
    $('#tpPreview').textContent = v;
    if (!tpTarget) return;
    tpTarget.value = v;
    tpTarget.classList.remove('bad');
    tpTarget.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function openTimePicker(el) {
    if (!el) return;
    tpTarget = el;
    // 打开时先记住原值，点「取消」能退回去
    tpBack = el.value;
    const cur = parseHM(el.value) || (el.id === 'inFixEnd' ? '18:00' : '09:00');
    const hm = cur.split(':');
    $('#tpHour').value = String(parseInt(hm[0], 10));
    $('#tpMin').value = String(parseInt(hm[1], 10));
    const lab = el.closest('.field') && el.closest('.field').querySelector('.f-label');
    const title = lab ? lab.textContent.trim() : '选时间';
    $('#tpTitle').textContent = title ? title + ' · 拖一下选' : '选时间';
    $('#tpMask').hidden = false;
    // 记下这帧：万一用户手快，在下一帧之前就点了「就用这个」，
    // 这个回调会把已经关掉的浮层又"点亮"，于是永远关不上
    if (tpRaf) cancelAnimationFrame(tpRaf);
    tpRaf = requestAnimationFrame(() => { tpRaf = 0; $('#tpMask').classList.add('on'); });
    tpPush();
  }

  function closeTimePicker(keep) {
    const m = $('#tpMask');
    if (!m || m.hidden) return;
    if (!keep && tpTarget) {
      tpTarget.value = tpBack || '';
      tpTarget.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (tpTarget) {
      tpTarget.dispatchEvent(new Event('blur', { bubbles: true }));
      tpTarget.classList.remove('bad');
    }
    if (tpRaf) { cancelAnimationFrame(tpRaf); tpRaf = 0; }
    m.classList.remove('on');
    tpTarget = null;
    tpBack = null;
    setTimeout(() => {
      if (!$('#tpMask').classList.contains('on')) $('#tpMask').hidden = true;
    }, 200);
  }

  function bindTimePicker() {
    if (!$('#tpMask')) return;
    ['#tpHour', '#tpMin'].forEach((sel) => {
      $(sel).addEventListener('input', tpPush);
    });
    $('#tpQuick').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-q]');
      if (!b) return;
      let v = b.dataset.q;
      if (v === 'now') {
        const d = new Date();
        v = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      }
      $('#tpHour').value = String(parseInt(v.slice(0, 2), 10));
      $('#tpMin').value = String(parseInt(v.slice(3), 10));
      tpPush();
    });
    $('#tpOk').addEventListener('click', () => closeTimePicker(true));
    $('#tpCancel').addEventListener('click', () => closeTimePicker(false));
    $('#tpMask').addEventListener('click', (e) => { if (e.target.id === 'tpMask') closeTimePicker(false); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#tpMask').hidden) {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeTimePicker(false);
      }
    }, true);
  }

  /* 每个时间输入右边挂一个小钟：点它开滑块，不用键盘敲 */
  const TIME_INPUTS = ['#inStart', '#inEnd', '#inLunchStart', '#inLunchEnd', '#inFixStart', '#inFixEnd'];

  function decorateTimeInputs() {
    TIME_INPUTS.forEach((sel) => {
      const el = $(sel);
      if (!el || el._tinWrapped) return;
      el._tinWrapped = true;
      const wrap = document.createElement('span');
      wrap.className = 'tin-wrap';
      el.parentNode.insertBefore(wrap, el);
      wrap.appendChild(el);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tin-btn';
      btn.title = '用滑块选时间';
      btn.setAttribute('aria-label', '用滑块选时间');
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">'
        + '<circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="1.9"/>'
        + '<path d="M12 7.4 V12 L15.2 13.9" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';
      btn.addEventListener('mousedown', (e) => { e.preventDefault(); });
      btn.addEventListener('click', (e) => { e.preventDefault(); openTimePicker(el); });
      wrap.appendChild(btn);
    });
  }

  /* ---------- 数字输入的上下小箭头（自绘，跟粉色风格统一） ---------- */
  function stepNumber(el, dir) {
    const step = Math.abs(parseFloat(el.step)) || 1;
    const min = el.min === '' ? NaN : parseFloat(el.min);
    const max = el.max === '' ? NaN : parseFloat(el.max);
    const cur = parseFloat(el.value);
    let next;
    if (!isFinite(cur)) {
      // 清空后点箭头：从「下限」开始，绝不一上来就跳一个 step
      if (isFinite(min) && min > 0) next = min;
      else next = dir > 0 ? step : 0;
    } else {
      next = cur + dir * step;
    }
    if (isFinite(min)) next = Math.max(min, next);
    if (isFinite(max)) next = Math.min(max, next);
    const dec = (String(step).split('.')[1] || '').length;
    el.value = dec ? String(Number(next.toFixed(dec))) : String(Math.round(next));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const ARR_UP = '<svg viewBox="0 0 10 6" aria-hidden="true"><path d="M1 5 L5 1 L9 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ARR_DN = '<svg viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1 L5 5 L9 1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function decorateNumberInputs() {
    document.querySelectorAll('input[type="number"]').forEach((el) => {
      if (el._spinWrapped) return;
      el._spinWrapped = true;
      const fnum = el.closest('.f-num');
      let host;
      if (fnum) {
        host = fnum;
        fnum.classList.add('has-spin');
      } else {
        host = document.createElement('span');
        host.className = 'num-wrap';
        el.parentNode.insertBefore(host, el);
        host.appendChild(el);
      }
      const box = document.createElement('span');
      box.className = 'num-spin';
      box.innerHTML = '<button type="button" class="ns-up" tabindex="-1" aria-label="加一档">' + ARR_UP + '</button>'
        + '<button type="button" class="ns-dn" tabindex="-1" aria-label="减一档">' + ARR_DN + '</button>';
      box.addEventListener('mousedown', (e) => e.preventDefault());
      box.querySelector('.ns-up').addEventListener('click', () => stepNumber(el, 1));
      box.querySelector('.ns-dn').addEventListener('click', () => stepNumber(el, -1));
      host.appendChild(box);
    });
  }


  // N-01：三张模式卡 + 当前模式的一句话说明
  function syncModeCards() {
    document.querySelectorAll('#modeCards .mcard').forEach((b) => {
      const isClick = b.dataset.mode === 'click';
      const active = isClick
        ? pendingMode === 'click'
        : (pendingMode === 'schedule' && (b.dataset.auto === '1') === !!pendingAuto);
      b.classList.toggle('active', active);
    });
    updateModeHint();
    updateHoursRow();
  }

  // 第 4 条：「每日有效工时」只在打卡那一刻模式下出现
  function updateHoursRow() {
    const row = $('#hoursRow');
    if (row) row.hidden = pendingMode !== 'click';
  }

  function updateModeHint() {
    const el = $('#modeHint');
    if (!el) return;
    const isClick = pendingMode === 'click';
    const st = readTime('#inStart') || cfg.start;
    const en = readTime('#inEnd') || cfg.end;
    if (isClick) {
      el.textContent = '随时能打卡，只记你真实上班的这段时间';
    } else if (pendingAuto) {
      el.textContent = '到点自动开始 · 午休自动暂停 · 下班自动结算（不用打卡，也不用补录）';
    } else {
      el.textContent = earlyMinus(st, 30) + ' 起可打卡 · 计薪固定按 ' + st + '–' + en + '（不用补录）';
    }
    el.classList.remove('warn');
  }

  // 班次跨度校验：跨夜 / 超长班次必须说清楚，别让人把 17:30 打成 5:30
  function updateSpanHint() {
    const el = $('#spanHint');
    if (!el) return;
    const st = readTime('#inStart');
    const en = readTime('#inEnd');
    if (!st || !en) { el.textContent = ''; el.classList.remove('warn'); return; }

    const a = hm2min(st), z = hm2min(en);
    if (a === z) {
      el.textContent = '上班和下班不能是同一个时间';
      el.classList.add('warn');
      return;
    }
    const overnight = z < a;
    const spanMin = overnight ? (z + 1440 - a) : (z - a);
    const hTxt = (spanMin / 60).toFixed(spanMin % 60 === 0 ? 0 : 1);

    const lunchMin = (() => {
      const ls = readTime('#inLunchStart'), le = readTime('#inLunchEnd');
      if (!ls || !le) return 0;
      const d = hm2min(le) - hm2min(ls);
      return d > 0 ? d : 0;
    })();
    const clickTip = pendingMode === 'click'
      ? '打卡那一刻模式下，这两个时间只作参考：用来算时薪、以及"应工作 ' + hmShort(Math.max(0, spanMin - lunchMin) * 60) + '"'
      : '';

    if (!overnight) {
      if (spanMin > 12 * 60) {
        el.textContent = '这一班有 ' + hTxt + ' 小时，确认没填错？';
        el.classList.add('warn');
      } else {
        el.textContent = clickTip;
        el.classList.remove('warn');
      }
      return;
    }

    // 只要跨过 24 点就提示（用户要求）：短夜班只是说明，超长的才是警告
    const tooLong = spanMin >= 12 * 60;
    let tip;
    if (tooLong) {
      tip = '跨夜 ' + hTxt + ' 小时（' + st + ' → 次日 ' + en + '），太长了，是不是想填 '
        + addMinutes(en, 720) + '？';
      el.classList.add('warn');
    } else {
      tip = '跨夜班：' + st + ' → 次日 ' + en + '，共 ' + hTxt + ' 小时';
      el.classList.remove('warn');
    }
    el.textContent = tip;
  }

  // FR-01：填完月到手立即回显折合日薪 / 时薪
  // 每年自动拿一次节假日：缺今年就拿今年；12 月中下旬提前把明年的拿下来
  async function refreshHolidays(force) {
    const api = window.desktop && window.desktop.fetchHolidays;
    if (!api) return;
    const now = new Date();
    const y = now.getFullYear();
    if (!force && cfg.holidayCheckedAt && (Date.now() - cfg.holidayCheckedAt) < 7 * DAY) return;

    const haveYears = new Set(Object.keys(cfg.holidays || {}).map((k) => parseInt(k.slice(0, 4), 10)));
    const targets = [];
    if (!haveYears.has(y)) targets.push(y);
    if (now.getMonth() === 11 && now.getDate() >= 15 && !haveYears.has(y + 1)) targets.push(y + 1);
    if (force) { targets.push(y); targets.push(y + 1); }
    if (!targets.length) return;

    cfg.holidayCheckedAt = Date.now();
    let got = 0;
    for (const ty of Array.from(new Set(targets))) {
      try {
        const r = await api(ty);
        if (!r) continue;
        r.off.forEach((k) => { cfg.holidays[k] = true; });
        r.work.forEach((k) => { cfg.holidays[k] = false; });
        got++;
      } catch (e) { /* 网络不通就继续用内置表 */ }
    }
    if (got) {
      save();
      refreshWorkDays();
      updateDaysHint();
      updateSalaryEcho();
      render();
    }
  }

  function updateDaysHint() {
    const el = $('#daysHint');
    if (!el) return;
    const mode = cfg.daysMode || 'double';
    const d = new Date();
    if (mode === 'custom') {
      el.textContent = '自己填的天数，跨月不会自动变';
      return;
    }
    const label = mode === 'single' ? '单休' : mode === 'bigsmall' ? '大小周' : '双休';
    // 内置表或联网表，只要覆盖到当前月份就算「已扣节假日」
    const d0 = new Date();
    const prefix = d0.getFullYear() + '-' + pad2(d0.getMonth() + 1) + '-';
    const hasHoliday = Object.keys(holidayMap()).some((k) => k.indexOf(prefix) === 0);
    el.textContent = (d.getMonth() + 1) + ' 月按' + label + '算，共 '
      + monthWorkDays(mode) + ' 个工作日' + (hasHoliday ? '（已扣法定节假日）' : '');
  }

  function updateSalaryEcho() {
    const el = $('#salaryEcho');
    if (!el) return;
    const sal = num($('#inSalary').value, 0);
    const days = clamp(num($('#inDays').value, cfg.workDays), 1, 31);
    const st = readTime('#inStart') || cfg.start;
    const en = readTime('#inEnd') || cfg.end;
    const ls = readTime('#inLunchStart') || cfg.lunchStart;
    const le = readTime('#inLunchEnd') || cfg.lunchEnd;

    const a = hm2min(st), z = hm2min(en);
    const span = z > a ? (z - a) : (z + 1440 - a);
    const dh = num($('#inDailyHours') ? $('#inDailyHours').value : '', 0);
    const mins = dh > 0 ? dh * 60 : Math.max(30, span - lunchOverlap(ls, le, st, en));
    const perDay = sal / days;
    const perHour = (perDay / mins) * 60;
    el.textContent = sal > 0
      ? '日薪 ' + fmtMoney(perDay, 0) + ' · 时薪 ' + fmtMoney(perHour, 2)
      : '';
  }

  function updateGoalSummary() {
    const el = $('#goalSummary');
    if (!el) return;
    const name = ($('#inGoalName').value || '').trim() || '未命名目标';
    const amt = num($('#inGoalAmount').value, 0);
    el.textContent = '目标 · ' + name + (amt > 0 ? ' ' + fmtShort(amt) : '');
  }

  /* ---------- 补录一段 ---------- */
  // 提示里的时间段带上「今天 / 昨天」，夜班跨零点才看得明白
  function fixWhen(from, to) {
    const k = dayKey(Date.now());
    const tag = (ts) => (dayKey(ts) === k ? '今天' : '昨天');
    if (tag(from) === tag(to)) return tag(from) + ' ' + hhmm(from) + ' – ' + hhmm(to);
    return tag(from) + ' ' + hhmm(from) + ' – ' + tag(to) + ' ' + hhmm(to);
  }

  // 补录校验：每一种「补不成」都要说清楚理由。
  // 以前是把越界的结束时间悄悄截到「现在」，补完钱少了却不知道为什么；
  // 现在直接拦住并告诉他该改成几点。
  function fixCheck() {
    const now = Date.now();
    const aRaw = String($('#inFixStart').value || '').trim();
    const zRaw = String($('#inFixEnd').value || '').trim();
    const a = readTime('#inFixStart');
    const z = readTime('#inFixEnd');
    const bad = (msg, sel) => ({ err: msg, sel });

    if (!aRaw && !zRaw) return bad('先把要补的时间段填上，像 09:00 – 12:00', '#inFixStart');
    if (!aRaw) return bad('开始时间没填', '#inFixStart');
    if (!a) return bad('开始时间看不懂，像 09:00 这样填（最大 23:59）', '#inFixStart');
    if (!zRaw) return bad('结束时间没填', '#inFixEnd');
    if (!z) return bad('结束时间看不懂，像 12:00 这样填（最大 23:59）', '#inFixEnd');
    if (hm2min(a) === hm2min(z)) return bad('开始和结束是同一时刻，至少补 1 分钟', '#inFixEnd');

    // 锚在「当前这一班」的那一天：夜班 23:00–01:00 才不会被算成明天
    const b = shiftAt(now);
    const t0 = b.t0;
    // 夜班里零点以后的时刻（如 02:00）属于「今天」，不是昨天的同一时刻；
    // 不然凌晨填 02:00 会被当昨天 02:00，理由也说不清
    const eMin = hm2min(cfg.end);
    const at = (hm) => t0 + hm * MIN + (b.overnight && hm < eMin ? DAY : 0);
    let from = at(hm2min(a));
    let to = at(hm2min(z));
    if (to <= from) to += DAY;

    const nowTxt = hhmm(now);
    // 结束比开始早、顺到明天还落在未来 → 多半是填反了，直说
    if (hm2min(z) < hm2min(a) && to > now) {
      return bad('结束时间 ' + z + ' 早于开始时间 ' + a + '，是不是填反了？', '#inFixEnd');
    }
    // 补录 = 加班，允许补到上班前 4 小时（早到、临时顶班都算），
    // 再早就分不清是哪一天了，容易白送钱
    const floor = b.start - 4 * 3600 * 1000;
    if (from < floor) {
      return bad('只能补这一班前后一段时间（最早 ' + hhmm(floor) + '），再早就分不清是哪天了', '#inFixStart');
    }
    if (from >= now) {
      return bad('这段时间还没到（现在 ' + nowTxt + '），补录只能补已经过去的', '#inFixStart');
    }
    if (to > now) {
      return bad('结束时间 ' + z + ' 还没到（现在 ' + nowTxt + '），把结束时间改到 ' + nowTxt + ' 或更早', '#inFixEnd');
    }

    // 已经点过「下班啦」的那一段，钱在下班时就按打卡时长结过了；
    // 再往里补就是同一段时间领两次钱（收工后 segs 已经清空，光靠 segs 查不出来）
    if (cfg.clockFrom === 'click' && cfg.doneShift != null) {
      const ls = cfg.lastShift;
      if (ls && ls.start === b.start
        && typeof ls.actualFrom === 'number' && typeof ls.actualTo === 'number'
        && Math.min(to, ls.actualTo) > Math.max(from, ls.actualFrom)) {
        return bad('这段已经在 ' + hhmm(ls.actualFrom) + '–' + hhmm(ls.actualTo)
          + ' 那次下班结算里算过了，补进去会重复。要补就补这段之外的加班', '#inFixStart');
      }
    }

    let sec = (to - from) / 1000;
    let lunchSec = 0;
    if (b.hasLunch) {                        // 跨到午休的，把午休扣掉
      const ls = Math.max(from, b.lunchStart);
      const le = Math.min(to, b.lunchEnd);
      if (le > ls) { lunchSec = (le - ls) / 1000; sec -= lunchSec; }
    }
    if (sec <= 0) {
      return bad(lunchSec > 0
        ? '这段正好是午休（' + hhmm(b.lunchStart) + '–' + hhmm(b.lunchEnd) + '），午休本来就不算钱'
        : '算下来是 0 分钟，换个时间段', '#inFixStart');
    }
    if (sec < 60) return bad('这段只有 ' + Math.round(sec) + ' 秒，至少补 1 分钟', '#inFixStart');

    // 拆成「班内」和「班外」：班外那段就是加班，加班不封顶
    let inSec = 0;
    const iF = Math.max(from, b.start);
    const iT = Math.min(to, b.end);
    if (iT > iF) {
      let d = (iT - iF) / 1000;
      if (b.hasLunch) {
        const ls = Math.max(iF, b.lunchStart);
        const le = Math.min(iT, b.lunchEnd);
        if (le > ls) d -= (le - ls) / 1000;
      }
      inSec = Math.max(0, d);
    }
    let outSec = Math.max(0, sec - inSec);

    // 全自动 / 定点打卡：班次内整段已经算过钱，再补就是重复；
    // 但班外的加班一样该补，所以这里只把班内那截剔掉，不是整段拒绝
    if (cfg.clockFrom === 'schedule') {
      if (outSec < 60) {
        return bad((cfg.autoRun ? '全自动' : '定点打卡') + '已经把 ' + hhmm(b.start) + '–' + hhmm(b.end)
          + ' 整段算过钱了，班次内不用补。要补加班就填班外的时间，比如 '
          + hhmm(b.end) + ' 之后', '#inFixStart');
      }
      sec = outSec;
      inSec = 0;
    }

    // 会重复算钱的三种情况：已补过的 / 正在计时的 / 请假的
    const k = dayKey(b.start);
    const ranges = cfg.fixDay === k ? cfg.fixRanges : [];
    const hit = ranges.find((fr) => fixPartsOf(fr)
      .some((p) => Math.min(to, p.to) > Math.max(from, p.from)));
    if (hit) {
      // 只报真正撞上的那几段：一次补了「班前+班后」两条时，别把没关系的也列出来
      const hs = fixPartsOf(hit)
        .filter((p) => Math.min(to, p.to) > Math.max(from, p.from))
        .map((p) => hhmm(p.from) + '–' + hhmm(p.to)).join('、');
      return bad('和已经补过的 ' + (hs || '那一段') + ' 重叠了，换一段没补过的', '#inFixStart');
    }
    // 定点打卡/全自动下只补班外，和正在跑的打卡段重叠也无所谓（班内本来就不补）
    if (cfg.clockFrom === 'click') {
      const run = segs().find((sg) => Math.min(to, sg.to == null ? now : sg.to) > Math.max(from, sg.from));
      if (run) {
        return bad('这段你正在计时（' + hhmm(run.from) + ' 起），补进去会重复算钱', '#inFixStart');
      }
    }
    const lv = leavesOf(now).find((s) => Math.min(to, s.to == null ? now : s.to) > Math.max(from, s.from));
    if (lv) {
      return bad('这段时间你请了假（' + hhmm(lv.from) + ' 起），请假不计薪，补进去也不会加钱', '#inFixStart');
    }

    // 真正会入账的时间段：全自动/定点只算班外那截，打卡那一刻整段都算。
    // 列表显示、重叠判定、写入记录全用这一份，免得三处各算一套对不上
    const parts = [];
    if (cfg.clockFrom === 'schedule') {
      if (to <= b.start || from >= b.end) parts.push({ from: from, to: to });
      else {
        if (from < b.start) parts.push({ from: from, to: b.start });
        if (to > b.end) parts.push({ from: b.end, to: to });
      }
    } else {
      parts.push({ from: from, to: to });
    }
    return { from, to, sec, inSec, outSec, parts };
  }

  function updateFixHint() {
    const el = $('#fixHint');
    if (!el) return;
    ['#inFixStart', '#inFixEnd'].forEach((s) => $(s) && $(s).classList.remove('bad'));
    const r = fixCheck();
    if (r.err) {
      el.textContent = r.err;
      el.classList.add('warn');
      if (r.sel) $(r.sel).classList.add('bad');
      return;
    }
    const c = calc();
    const rate = cfg.otRate || 1;
    const money = r.inSec * c.perSec + r.outSec * c.perSec * rate;
    // 把「哪部分是加班」说清楚：班外的钱不占今天的日薪额度
    const dur = fmtDuration(Math.round(r.sec / 60));
    let mark = '';
    if (r.outSec >= 60 && r.inSec >= 60) {
      mark = ' · 其中班外加班 ' + fmtDuration(Math.round(r.outSec / 60));
    } else if (r.outSec >= 60) {
      mark = ' · 班外加班';
    }
    // 全自动/定点：用户填的范围可能大部分是班内（已整段算过钱），
    // 直接告诉他「实际入账的是这一段」，别只写总区间让人以为 9 小时都给了钱
    const realSpans = (r.parts || []).map((p) => hhmm(p.from) + '–' + hhmm(p.to)).join('、');
    const nPart = (r.parts || []).length;
    const partial = cfg.clockFrom === 'schedule' && realSpans
      && (nPart > 1 || (r.parts[0].from !== r.from || r.parts[0].to !== r.to));
    const which = partial ? ('只补 ' + realSpans + (nPart > 1 ? ' 这 ' + nPart + ' 段' : ' 这一段'))
      : ('这段 ' + fixWhen(r.from, r.to));
    el.textContent = which + '（' + dur + mark + '），可补 ' + fmtMoney(money, 2);
    el.classList.remove('warn');
  }

  function openFix() {
    const now = Date.now();
    const b = shiftAt(now);
    const sched = cfg.clockFrom === 'schedule';
    const d = new Date(now); d.setHours(0, 0, 0, 0);
    const t0 = d.getTime();
    const dayStart = Math.max(b.start, t0);

    // 默认别落在已经补过 / 正在计时的区间上：从上班时间起找第一个空闲的 1 小时
    const ranges = cfg.fixDay === dayKey(now) ? cfg.fixRanges : [];
    const busy = (a, z) => ranges.some((fr) => fixPartsOf(fr)
      .some((p) => Math.min(z, p.to) > Math.max(a, p.from)))
      || segs().some((sg) => Math.min(z, sg.to == null ? now : sg.to) > Math.max(a, sg.from));
    let a;
    let z;
    if (sched) {
      // 全自动 / 定点打卡：班次内已经整段算过钱，默认填「下班后 1 小时」的加班；
      // 还没下班就填「上班前 1 小时」，省得每次都要自己敲
      if (now >= b.end) { a = b.end; z = Math.min(now, b.end + 60 * MIN); }
      else if (now <= b.start) { a = Math.max(t0, now - 60 * MIN); z = now; }
      else { a = Math.max(b.start - 60 * MIN, t0); z = b.start; }
      if (z <= a) { a = Math.max(t0, now - 60 * MIN); z = now; }
    } else {
      a = dayStart;
      z = a + 60 * MIN;
      for (let i = 0; i < 96 && z <= now && busy(a, z); i++) {
        a += 30 * MIN;
        z = a + 60 * MIN;
      }
      if (z > now) { z = now; a = Math.max(dayStart, now - 60 * MIN); }
      if (a >= z) { a = Math.max(t0, now - 60 * MIN); z = now; }
    }
    // 今天刚过 0 点、还没有「过去的时间」可填：说清楚，别让用户对着空地发呆
    if (a >= z) { openAutoTip(); return; }

    const sub = $('#fixSub');
    if (sub) {
      sub.textContent = sched
        ? '班次内已整段算钱，这里补的是班外加班，不封顶'
        : '补这一班已经过去的时间或班外加班，补完直接算钱';
    }

    $('#inFixStart').value = hhmm(a);
    $('#inFixEnd').value = hhmm(z);
    $('#fixBox').hidden = false;
    $('#autoBox').hidden = true;
    $('#miniMask').hidden = false;
    renderFixList();
    updateFixHint();
  }

  // 全自动 / 定点打卡点「补录」：告诉他为什么不用补，以及该怎么改
  function openAutoTip() {
    const auto = cfg.clockFrom === 'schedule' && !!cfg.autoRun;
    const now = Date.now();
    const b = shiftAt(now);
    const tip = $('#autoTip1');
    if (tip) {
      tip.textContent = (auto ? '全自动' : '定点打卡') + '：' + hhmm(b.start) + '–' + hhmm(b.end)
        + ' 整段算钱' + (b.hasLunch
          ? '，午休 ' + hhmm(b.lunchStart) + '–' + hhmm(b.lunchEnd) + ' 自动跳过'
          : '');
    }
    $('#fixBox').hidden = true;
    $('#autoBox').hidden = false;
    $('#miniMask').hidden = false;
  }

  function closeFix() {
    $('#miniMask').hidden = true;
    const fb = $('#fixBox'), ab = $('#autoBox');
    if (fb) fb.hidden = false;      // 下次打开默认是补录面板
    if (ab) ab.hidden = true;
  }

  // 一条补录实际占了哪些时间段。
  // 老数据没有 parts：from/to 就是那段（可能比真正计薪的区间大，见 repairState 的迁移）
  function fixPartsOf(fr) {
    if (fr && Array.isArray(fr.parts) && fr.parts.length) return fr.parts;
    if (fr && typeof fr.from === 'number' && typeof fr.to === 'number') {
      return [{ from: fr.from, to: fr.to }];
    }
    return [];
  }

  // 打开弹层时把「今天已补的段」列出来，避免补重
  function renderFixList() {
    const box = $('#fixList');
    if (!box) return;
    const k = dayKey(shiftAt(Date.now()).start);   // 补录挂在「当前这一班」的归属日上
    const list = cfg.fixDay === k ? cfg.fixRanges : [];
    if (!list.length) { box.hidden = true; return; }
    box.hidden = false;
    const c = calc();
    let sum = 0;
    const html = list.map((fr, i) => {
      // 老数据没有 amount：按当时的时长估算一个
      const amt = typeof fr.amount === 'number'
        ? fr.amount
        : (typeof fr.sec === 'number' ? fr.sec * c.perSec : 0);
      sum += amt;
      const dur = typeof fr.sec === 'number' ? fmtDuration(Math.round(fr.sec / 60)) : '';
      const ot = typeof fr.otSec === 'number' && fr.otSec >= 60;
      const spans = fixPartsOf(fr).map((p) => hhmm(p.from) + '–' + hhmm(p.to)).join('、');
      return '<div class="fix-item">'
        + '<span class="fi-when">' + (spans || hhmm(fr.from) + ' – ' + hhmm(fr.to))
        + (dur ? '<span class="fi-tag">' + dur + '</span>' : '')
        + (ot ? '<span class="fi-tag ot">加班</span>' : '')
        + '</span>'
        + '<span class="fi-right"><b>+' + fmtMoney(amt, 2) + '</b>'
        + '<button class="fi-del" data-i="' + i + '" title="删掉这段补录">删除</button></span>'
        + '</div>';
    }).join('');
    $('#fixItems').innerHTML = html;
    $('#fixCount').textContent = list.length;
    $('#fixSum').textContent = fmtMoney(sum, 2);
  }

  // 删掉一段补录：钱、时长、当天账本一起退回去，别只删显示
  function removeFix(idx) {
    const list = cfg.fixRanges || [];
    const fr = list[idx];
    if (!fr) return;
    const amt = typeof fr.amount === 'number' ? fr.amount : 0;
    const sec = typeof fr.sec === 'number' ? fr.sec : 0;
    // 班内秒数才算「今日已工作」，班外加班单独退，别把日薪额度还错了
    const inSec = typeof fr.inSec === 'number' ? fr.inSec : sec;
    const otSec = typeof fr.otSec === 'number' ? fr.otSec : 0;
    const k = cfg.fixDay || dayKey(Date.now());
    list.splice(idx, 1);

    cfg.settled = Math.max(0, cfg.settled - amt);
    if (typeof cfg.dailyLog[k] === 'number') {
      const left = cfg.dailyLog[k] - amt;
      if (left < 0.005) delete cfg.dailyLog[k];
      else cfg.dailyLog[k] = left;
    }
    // 只有「今天补进去的」才从今日账本里退；跨天删旧补录不能动今天的数
    const addedOn = typeof fr.at === 'number' ? dayKey(fr.at) : k;
    if (cfg.todaySettled && cfg.todaySettled.day === addedOn) {
      cfg.todaySettled.amount = Math.max(0, cfg.todaySettled.amount - amt);
      cfg.todaySettled.seconds = Math.max(0, cfg.todaySettled.seconds - inSec);
      if (otSec > 0) {
        cfg.todaySettled.otSec = Math.max(0, (cfg.todaySettled.otSec || 0) - otSec);
      }
      if (cfg.todaySettled.amount < 0.0005) cfg.todaySettled.amount = 0;
    }
    if (cfg.lastShift && dayKey(cfg.lastShift.start) === k) {
      cfg.lastShift.amount = Math.max(0, cfg.lastShift.amount - amt);
      cfg.lastShift.seconds = Math.max(0, (cfg.lastShift.seconds || 0) - sec);
    }
    // 删光了就别留一个空的补录日
    if (!list.length) { cfg.fixRanges = []; cfg.fixDay = ''; }
    save();
    render();
    renderFixList();
    updateFixHint();
  }

  function applyFix() {
    const r = fixCheck();
    if (r.err) {
      const el = $('#fixHint');
      el.textContent = r.err;
      el.classList.add('warn');
      if (r.sel) { $(r.sel).classList.add('bad'); shake($(r.sel)); }
      return;
    }
    const c = calc();
    const b = shiftAt(Date.now());
    // 补录 = 加班：班内按 1 倍、班外按用户设的倍率，都不被「今天已满」砍掉
    const rate = cfg.otRate || 1;
    const amount = r.inSec * c.perSec + r.outSec * c.perSec * rate;
    if (amount <= 0) {
      const el = $('#fixHint');
      el.textContent = '这段算下来是 0 元，检查一下时间';
      el.classList.add('warn');
      return;
    }
    cfg.settled += amount;
    // 只有班内那段算进「今日已工作」，班外加班单独记，别把日薪额度挤掉
    addTodaySettled(r.inSec, amount, r.outSec);
    // 同 D-04：补录的钱也记在「当前这一班」的归属日，夜班凌晨不记到次日
    const k = dayKey(shiftAt(Date.now()).start);
    cfg.dailyLog[k] = (cfg.dailyLog[k] || 0) + amount;
    cfg.fixDay = k;
    // parts 来自 fixCheck：真正会入账的时段（全自动/定点只有班外那截）。
    // 只存用户输入的整段会让列表写成「09:00–18:00（1 小时）」，还会挡住后面想补的时段
    cfg.fixRanges.push({
      from: r.from, to: r.to,
      parts: (r.parts && r.parts.length) ? r.parts : [{ from: r.from, to: r.to }],
      sec: r.sec, amount: amount,
      inSec: r.inSec, otSec: r.outSec, at: Date.now()
    });
    // 已经收工的班次记录也跟着涨，否则第二天显示的还是补录前的数
    if (cfg.lastShift && dayKey(cfg.lastShift.start) === k) {
      cfg.lastShift.amount += amount;
      cfg.lastShift.seconds += r.sec;
    }
    save();
    render();
    closeFix();
  }

  /* ---------- 数据备份 ---------- */
  let importArmed = false;
  let importPayload = null;
  let importTimer = null;

  function setDataHint(msg, warn) {
    const el = $('#dataHint');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('warn', !!warn);
  }

  async function exportData() {
    const api = window.desktop && window.desktop.exportData;
    if (!api) { setDataHint('当前环境不支持导出', true); return; }
    // 版本号跟 package.json 走，别再手抄一份抄错
    let ver = '';
    try { ver = (window.desktop && window.desktop.getVersion) ? await window.desktop.getVersion() : ''; } catch (e) { /* 无所谓 */ }
    const payload = {
      app: 'dagongren-jizhangqi',
      version: ver || 'unknown',
      exportedAt: new Date().toISOString(),
      data: cfg
    };
    const d = new Date();
    const name = '打工人记账器-' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '.json';
    const r = await api(name, JSON.stringify(payload, null, 2));
    if (r && r.ok) setDataHint('已导出到 ' + r.path, false);
    else if (r && r.error) setDataHint('导出失败：' + r.error, true);
    // r.canceled = 用户取消了保存框，不打扰
  }

  function disarmImport() {
    importArmed = false;
    importPayload = null;
    clearTimeout(importTimer);
    const b = $('#btnImport');
    if (b) { b.textContent = '导入数据'; b.classList.remove('armed'); }
  }

  async function importData() {
    const api = window.desktop && window.desktop.importData;
    if (!api) { setDataHint('当前环境不支持导入', true); return; }

    // 第二下：确认覆盖
    if (importArmed && importPayload) {
      try {
        // 导入前把当前数据留一份备份，反悔了还能找回来
        localStorage.setItem(STORE_KEY + '.bak', JSON.stringify(cfg));
        localStorage.setItem(STORE_KEY, JSON.stringify(importPayload));
        location.reload();
      } catch (e) {
        setDataHint('写入失败：' + e.message, true);
        disarmImport();
      }
      return;
    }

    const r = await api();
    if (!r || !r.ok) {
      if (r && r.error) setDataHint('读取失败：' + r.error, true);
      return;                                    // canceled 不打扰
    }
    let payload = null;
    try {
      const parsed = JSON.parse(r.json);
      payload = parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
    } catch (e) {
      setDataHint('这个文件不是有效的备份', true);
      return;
    }
    // 基本校验：至少要有月薪和上下班时间，别把别的 json 灌进来
    if (!payload || typeof payload !== 'object'
      || !isFinite(parseFloat(payload.salary))
      || !validHM(payload.start) || !validHM(payload.end)) {
      setDataHint('文件内容不像本应用的备份，已拒绝', true);
      return;
    }
    // 备份里的月薪也得是正数，否则导进来又是「时薪 0」的死数据
    if (!(parseFloat(payload.salary) > 0)) {
      setDataHint('这份备份里的月薪是 ' + payload.salary + '，不是正数，导进来算不出时薪，已拒绝', true);
      return;
    }
    payload.inited = true;
    importPayload = payload;
    importArmed = true;
    const b = $('#btnImport');
    b.textContent = '确认导入？';
    b.classList.add('armed');
    setDataHint('备份里：月薪 ' + fmtMoney(parseFloat(payload.salary), 0)
      + '、累计 ' + fmtMoney(num(payload.settled, 0) + num(payload.savedBase, 0), 2)
      + '。导入会覆盖当前全部数据（已自动留备份），再点一次「确认导入」生效', true);
    clearTimeout(importTimer);
    importTimer = setTimeout(() => {
      disarmImport();
      setDataHint('已取消导入', false);
    }, 8000);
  }

  /* ---------- 每日明细 ---------- */
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  function renderHistory() {
    const box = $('#histList');
    if (!box) return;
    const now = Date.now();
    const todayK = dayKey(now);
    const st = currentState(now);
    const base = baseToday();

    // 今天的实时金额（和主界面同一个口径）
    let todayLive = base.amount;
    if (!st.done) {
      const rawSec = workSeconds(now);
      const c = calc();
      const fullDay = st.auto || st.mode === 'schedule';
      const deltaSec = fullDay ? Math.max(0, rawSec - base.seconds) : rawSec;
      const room = Math.max(0, c.capSec - base.seconds);
      todayLive = base.amount + Math.min(deltaSec, room) * c.perSec;
    }

    const keys = {};
    Object.keys(cfg.dailyLog || {}).forEach((k) => { keys[k] = true; });
    Object.keys(cfg.leaves || {}).forEach((k) => { keys[k] = true; });
    if (todayLive > 0 || cfg.leaves[todayK]) keys[todayK] = true;

    const list = Object.keys(keys)
      .map((k) => {
        const p = k.split('-');
        return { k, y: +p[0], m: +p[1], d: +p[2] };
      })
      .filter((r) => r.y > 2000)
      .sort((a, b) => (b.y - a.y) || (b.m - a.m) || (b.d - a.d))
      .slice(0, 62);

    if (!list.length) {
      box.innerHTML = '<p class="hist-empty">还没有记录，上完今天就有啦</p>';
      return;
    }

    let html = '';
    let curYM = '';
    let monthSum = 0, monthCnt = 0, monthLeave = 0;
    const flush = () => {
      if (!curYM) return;
      // 天数口径与主界面「本月已赚」一致：只数有钱的天，请假日单列，不混进合计
      html = html.replace('@@SUM@@', fmtMoney(monthSum, 2)).replace('@@CNT@@', String(monthCnt))
        .replace('@@LV@@', monthLeave > 0 ? ' · 请假 ' + monthLeave + ' 天' : '');
    };
    list.forEach((r) => {
      const ym = r.y + '-' + r.m;
      if (ym !== curYM) {
        flush();
        curYM = ym; monthSum = 0; monthCnt = 0; monthLeave = 0;
        html += '<p class="hist-month">' + r.y + ' 年 ' + r.m + ' 月 · 共 @@SUM@@ · @@CNT@@ 天@@LV@@</p>';
      }
      const dt = new Date(r.y, r.m - 1, r.d);
      const isToday = r.k === todayK;
      const onLeave = !!cfg.leaves[r.k];
      const amt = isToday ? todayLive : (cfg.dailyLog[r.k] || 0);
      monthSum += amt;
      if (amt > 0) monthCnt++;
      if (onLeave && amt <= 0) monthLeave++;
      const tag = isToday && !st.done
        ? '<span class="h-tag work">进行中</span>'
        : onLeave ? '<span class="h-tag leave">请假</span>' : '';
      html += '<div class="hist-row">'
        + '<span class="h-date">' + r.m + '月' + r.d + '日</span>'
        + '<span class="h-week">周' + WEEK[dt.getDay()] + '</span>'
        + tag
        + '<span class="h-amt">' + fmtMoney(amt, 2) + '</span>'
        + '</div>';
    });
    flush();
    box.innerHTML = html;
  }

  function openHistory() {
    closeSheet();
    renderHistory();
    $('#histMask').classList.add('on');
    $('#histSheet').classList.add('on');
  }

  function closeHistory() {
    const m = $('#histMask'), sh = $('#histSheet');
    if (m) m.classList.remove('on');
    if (sh) sh.classList.remove('on');
  }

  function openSheet() {
    $('#inSalary').value = cfg.salary;
    if (cfg.daysMode !== 'custom') cfg.workDays = monthWorkDays(cfg.daysMode);
    $('#inDays').value = cfg.workDays;
    updateDaysHint();
    $('#inStart').value = cfg.start;
    $('#inEnd').value = cfg.end;
    $('#inLunchStart').value = cfg.lunchStart;
    $('#inLunchEnd').value = cfg.lunchEnd;
    $('#inGoalName').value = cfg.goalName;
    $('#inGoalAmount').value = cfg.goalAmount;
    $('#inSaved').value = cfg.savedBase;
    if ($('#inDailyHours')) $('#inDailyHours').value = cfg.dailyHours || '';
    $('#formErr').style.display = 'none';

    pendingMode = cfg.clockFrom;
    pendingAuto = !!cfg.autoRun;

    ['#inStart', '#inEnd', '#inLunchStart', '#inLunchEnd'].forEach((s) => {
      const el = $(s);
      el._last = el.value;
      el.classList.remove('bad');
    });

    syncModeCards();
    updateSalaryEcho();
    updateGoalSummary();
    updateSpanHint();
    document.querySelectorAll('#emojiRow button').forEach((b) => {
      b.classList.toggle('active', b.dataset.e === cfg.goalEmoji);
    });
    syncDaysSeg();
    updateLunchInfo();
    renderDataPath();

    syncOtSeg();
    syncCloseSeg();
    const sh = $('#salaryHint');
    if (sh) sh.hidden = cfg.inited === true;      // 只有首启才提示「这是默认值」

    closeHistory();                       // 面板互斥，一次只开一个
    $('#mask').classList.add('on');
    $('#sheet').classList.add('on');
    $('#btnSettings').classList.add('on');
  }

  function closeSheet() {
    $('#mask').classList.remove('on');
    $('#sheet').classList.remove('on');
    const g = $('#btnSettings');
    if (g) g.classList.remove('on');
    disarmImport();
  }

  /* ---------- 数字输入校验 ----------
     0 / 负数 / 字母 / 离谱的大数都不能悄悄放过：
     以前是 Math.max(0, …) 直接改掉，用户填 0 也能存进去，界面就变成「每秒 +0.0000」。 */
  const NUM_FIELDS = [
    {
      sel: '#inSalary',
      label: '月到手（税后）',
      check(v) {
        if (v <= 0) return '要大于 0，填 0 或负数算出来时薪就是 0';
        if (v < 100) return '至少 100 元，看看是不是少打了几个 0';
        if (v > 1000000) return '最多 1,000,000，看看是不是多打了几个 0';
        return '';
      }
    },
    {
      sel: '#inDays',
      label: '每月工作天数',
      check(v) {
        if (v <= 0) return '要大于 0，一个月不可能上 0 天班';
        if (v < 1) return '最少 1 天';
        if (v > 31) return '最多 31 天，一个月没这么多天';
        return '';
      }
    },
    {
      sel: '#inDailyHours',
      label: '每日有效工时',
      allowEmpty: true,
      check(v) {
        if (v <= 0) return '要么留空（按班次自动算），要么填大于 0 的小时数';
        if (v < 0.5) return '最少 0.5 小时';
        if (v > 24) return '一天最多 24 小时';
        return '';
      }
    },
    {
      sel: '#inGoalAmount',
      label: '目标金额',
      check(v) {
        if (v <= 0) return '要大于 0，填 0 进度条会直接满格';
        if (v > 100000000) return '最多 100,000,000，检查一下';
        return '';
      }
    },
    {
      sel: '#inSaved',
      label: '已有存款',
      allowEmpty: true,                     // 留空 = 0，不用逼着填
      check(v) {
        if (v < 0) return '不能是负数，存款最少填 0';
        if (v > 100000000) return '最多 100,000,000，检查一下';
        return '';
      }
    }
  ];

  // 单个字段：分清「空」「不是数字」「越界」，返回 { el, msg }
  function checkNumField(f) {
    const el = $(f.sel);
    if (!el) return { el: null, msg: '' };
    if (el.closest('[hidden]')) return { el, msg: '' };      // 隐藏的（比如非打卡模式下的工时）不校验
    if (el.validity && el.validity.badInput) return { el, msg: '得是数字，别填字母或符号' };
    const raw = String(el.value).trim().replace(/[,，\s]/g, '');
    if (!raw) {
      return f.allowEmpty ? { el, msg: '' } : { el, msg: '不能空着，填个数' };
    }
    const v = Number(raw);
    if (!isFinite(v)) return { el, msg: '得是数字，别填字母或符号' };
    return { el, msg: f.check(v) };
  }

  function markBad(el) {
    if (!el) return;
    const box = el.closest('.f-num');
    if (box) box.classList.add('bad');
    else el.classList.add('bad');
  }

  function clearBad() {
    document.querySelectorAll('.form input.bad, .f-num.bad').forEach((el) => el.classList.remove('bad'));
  }

  // 逐项检查：返回第一条错误（顺便标红）。skipEmpty 用于「正在输入」时别一惊一乍
  function numFormError(skipEmpty) {
    clearBad();
    for (const f of NUM_FIELDS) {
      const { el, msg } = checkNumField(f);
      if (!msg) continue;
      if (skipEmpty && msg === '不能空着，填个数') continue;
      markBad(el);
      return { el, msg: f.label + '：' + msg };
    }
    return null;
  }

  function formError(msg) {
    const el = $('#formErr');
    el.textContent = msg;
    el.style.display = 'block';
    return false;
  }

  function clearFormError() {
    const el = $('#formErr');
    el.textContent = '';
    el.style.display = 'none';
  }

  // 明显不合理的组合：需要再点一次才保存
  function formIssues(start, end, ls, le) {
    const sMin = hm2min(start), eMin = hm2min(end);
    const span = eMin > sMin ? (eMin - sMin) : (eMin + 1440 - sMin);
    const out = [];
    if (span >= 16 * 60) {
      out.push('这一班有 ' + (span / 60).toFixed(1).replace('.0', '') + ' 小时，太长了');
    }
    const lunch = hm2min(le) > hm2min(ls) ? (hm2min(le) - hm2min(ls)) : 0;
    if (lunch > 0 && lunchOverlap(ls, le, start, end) === 0) {
      out.push('午休完全不在上班时间里，等于没午休');
    }
    return out;
  }

  function armSave(issues) {
    saveArmed = true;
    const b = $('#btnSave');
    b.textContent = '确认保存？';
    b.classList.add('armed');
    const w = $('#formWarn');
    if (w) {
      w.hidden = false;
      w.textContent = issues.join('；') + '。再点一次「确认保存」才生效';
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(disarmSave, 5000);
  }

  function disarmSave() {
    saveArmed = false;
    const b = $('#btnSave');
    if (b) {
      b.textContent = '存好啦 ♪';
      b.classList.remove('armed');
    }
    const w = $('#formWarn');
    if (w) { w.hidden = true; w.textContent = ''; }
  }

  /* ---------- 轻提示 + 通用确认弹窗 ---------- */
  let toastTimer = 0;
  function toast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('on'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('on');
      setTimeout(() => { el.hidden = true; }, 220);
    }, 1500);
  }

  let dlgResolve = null;
  function askDlg(title, html, okText, cancelText) {
    return new Promise((resolve) => {
      const mask = $('#dlgMask');
      if (!mask) { resolve(true); return; }
      $('#dlgTitle').textContent = title || '提示';
      $('#dlgText').innerHTML = html || '';
      $('#dlgOk').textContent = okText || '确定';
      $('#dlgCancel').textContent = cancelText || '取消';
      mask.hidden = false;
      dlgResolve = resolve;
    });
  }
  function closeDlg(ok) {
    const mask = $('#dlgMask');
    if (!mask || mask.hidden) return;
    mask.hidden = true;
    const r = dlgResolve;
    dlgResolve = null;
    if (r) r(!!ok);
  }

  // 首启没填参数就点「收起」：不能拿默认工资悄悄记账，先把选择权交回用户
  function onCloseSheetClick() {
    if (cfg.inited) { closeSheet(); return; }
    askDlg('还没填你的工资',
      '直接关掉的话，会按现在的 <b>' + fmtMoney(cfg.salary, 0) + '/月 · ' + cfg.workDays + ' 天 · '
      + cfg.start + '–' + cfg.end + '</b> 开始记账。'
      + '这些数字不是你的，首页会一直挂着提醒。',
      '先用默认值', '回去填')
      .then((ok) => {
        if (!ok) return;
        cfg.inited = true;
        cfg.confirmedByUser = false;
        save();
        closeSheet();
        render();
        toast('先用默认值，随时点顶部黄条改成你的');
      });
  }

  /* ---------- 设置面板里的开关类小件 ---------- */
  function syncOtSeg() {
    document.querySelectorAll('#segOt button').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.ot) === (cfg.otRate || 1));
    });
    const note = $('#otRateNote');
    if (note) note.textContent = (cfg.otRate || 1) + ' 倍';
  }
  function syncCloseSeg() {
    document.querySelectorAll('#segClose button').forEach((b) => {
      b.classList.toggle('active', (b.dataset.close === 'tray') === (cfg.closeToTray !== false));
    });
  }
  function applyCloseBehavior() {
    const api = window.desktop;
    if (api && api.setCloseToTray) api.setCloseToTray(cfg.closeToTray !== false);
  }

  let dataPathCache = '';
  function renderDataPath() {
    const el = $('#dataPath');
    if (!el) return;
    const api = window.desktop;
    if (!api || !api.dataPath) { el.textContent = '数据存在本机（浏览器本地存储）'; return; }
    api.dataPath().then((dir) => {
      if (!dir) return;
      dataPathCache = dir;
      el.textContent = '数据存在：' + dir;
    }).catch(() => {});
  }

  // 用默认值混过首启时，首页一直挂一条可点的提醒
  function renderDefBar() {
    const bar = $('#defBar');
    if (!bar) return;
    const show = cfg.inited && !cfg.confirmedByUser;
    bar.hidden = !show;
    if (show) {
      const n = $('#defSalary');
      if (n) n.textContent = fmtMoney(cfg.salary, 0);
    }
  }

  function saveSheet() {
    // 第 1 关：数字。0 / 负数 / 字母 / 离谱大数一律拦住，
    // 不许再像以前那样 Math.max(0, …) 悄悄改掉然后照样存进去
    const badNum = numFormError(false);
    if (badNum) {
      shake(badNum.el);
      return formError(badNum.msg);
    }

    // 第 2 关：时间。空了也不能拿旧值顶上——那会让人以为改成功了
    const sRaw = String($('#inStart').value || '').trim();
    const eRaw = String($('#inEnd').value || '').trim();
    const lsRaw = String($('#inLunchStart').value || '').trim();
    const leRaw = String($('#inLunchEnd').value || '').trim();
    const start = readTime('#inStart');
    const end = readTime('#inEnd');
    const ls = readTime('#inLunchStart');
    const le = readTime('#inLunchEnd');

    const badTime = (sel, msg) => {
      markBad($(sel));
      shake($(sel));
      return formError(msg);
    };
    if (!sRaw) return badTime('#inStart', '上班时间不能空着，像 09:00 这样填');
    if (!start) return badTime('#inStart', '上班时间看不懂，像 09:00 这样填（最大 23:59）');
    if (!eRaw) return badTime('#inEnd', '下班时间不能空着，像 17:00 这样填');
    if (!end) return badTime('#inEnd', '下班时间看不懂，像 17:00 这样填（最大 23:59）');
    if (start === end) return badTime('#inEnd', '上班和下班时间不能一样');
    if (!lsRaw) return badTime('#inLunchStart', '午休开始不能空着（没有午休就都填 00:00）');
    if (!ls) return badTime('#inLunchStart', '午休开始看不懂，像 12:00 这样填（最大 23:59）');
    if (!leRaw) return badTime('#inLunchEnd', '午休结束不能空着（没有午休就都填 00:00）');
    if (!le) return badTime('#inLunchEnd', '午休结束看不懂，像 13:00 这样填（最大 23:59）');
    if (hm2min(le) < hm2min(ls)) return badTime('#inLunchEnd', '午休结束要晚于开始');

    $('#formErr').style.display = 'none';

    // 防误操作：一眼就不对的组合，先弹一次确认
    const issues = formIssues(start, end, ls, le);
    if (issues.length && !saveArmed) {
      armSave(issues);
      return;
    }
    disarmSave();

    // 换计时方式会把今天已经按旧方式算出来的钱作废 —— 那可能是几百块，先问一次
    const modeWillChange = pendingMode !== cfg.clockFrom || !!pendingAuto !== !!cfg.autoRun;
    if (modeWillChange && !modeConfirmSkip) {
      // 用屏幕上显示的那个数（打卡模式的钱还没结算，只算 settled 会漏）
      const todayMoney = Math.max(0, lastShownEarned || 0);
      if (todayMoney > 0.005) {
        askDlg('要换计时方式吗？',
          '换方式后，今天按旧方式算出的 <b>' + fmtMoney(todayMoney, 2) + '</b> 会清零，从 0 重新开始。'
          + '<br>手动补录的钱会保留。',
          '确定切换', '先不换')
          .then((ok) => {
            if (!ok) return;
            modeConfirmSkip = true;
            saveSheet();
            modeConfirmSkip = false;
          });
        return;
      }
    }

    // 班次（时间）变了 = 今天的时间口径整个换了，旧口径下算出的数字不能接着用
    const timeChanged = start !== cfg.start || end !== cfg.end
      || ls !== cfg.lunchStart || le !== cfg.lunchEnd;

    // 第 2 条：先把正在计时的部分按旧参数固化，再改参数
    // 但班次变了就不固化——那一整段马上要被重新定义，固化反而会把今天的钱拆成两套口径
    const now = Date.now();
    const oldMode = cfg.clockFrom;
    const oldAuto = !!cfg.autoRun;
    // 首次设置（还没 inited）不按"切换"处理：全自动仍从班次开始算
    const wasInited = cfg.inited === true;
    let wasRunning = false;
    if (!timeChanged) {
      // 用「改之前的模式」决定怎么固化：
      // 只有本来就在全自动，才把「上班到此刻」按旧单价结掉；
      // 从打卡/定点切进全自动时，绝不能反过来把一整天白送一遍
      if (oldMode === 'schedule' && oldAuto) {
        wasRunning = settleAutoSoFar(now);
      } else {
        wasRunning = settleIfRunning(now);
      }
    }

    // 走到这里已经全部校验过，直接取原值，不再二次「修正」
    cfg.salary = num($('#inSalary').value, cfg.salary);
    cfg.workDays = cfg.daysMode !== 'custom'
      ? monthWorkDays(cfg.daysMode)
      : Math.round(num($('#inDays').value, 22) * 2) / 2;
    cfg.start = start;
    cfg.end = end;
    cfg.lunchStart = ls;
    cfg.lunchEnd = le;
    cfg.goalName = Array.from((($('#inGoalName').value || '').trim()) || '我的小目标').slice(0, 12).join('');
    cfg.goalAmount = num($('#inGoalAmount').value, 5999);
    cfg.savedBase = num($('#inSaved').value, 0);
    cfg.clockFrom = pendingMode;                 // 第 6 条：保存才生效
    cfg.autoRun = !!pendingAuto;

    // 换了计时方式，旧的「收工标记」属于上一套规则，必须清掉，
    // 否则自动模式会误判成「今日已收工」却仍在计费；
    // 今天已经按旧规则算出来的钱也一并作废（保留人工补录），首页归零重来
    const modeChanged = oldMode !== cfg.clockFrom || oldAuto !== cfg.autoRun;
    if (modeChanged) {
      cfg.doneShift = null;
      cfg.lastShift = null;
      cfg.segments = [];
      cfg.clockIn = null;
      resetTodayTiming(now);
      // 换了玩法就不能替用户「接着计时」：
      // 打卡那一刻要他自己点打卡，否则切完模式会凭空开始上班（v1.1.0 前就是这样）
      wasRunning = false;
      // 新口径从「现在」起算。不这样做的话，切到全自动/定点会立刻按 08:00 起
      // 把今天整天补算一遍 —— 和弹窗里承诺的「从 0 重新开始」直接打架。
      // 首次设置（还没 inited）不算切换，全自动该怎么算还怎么算。
      if (cfg.clockFrom === 'schedule' && wasInited) {
        cfg.timerFrom = now;
        cfg.timerFromKey = dayKey(shiftAt(now).start);
      } else {
        cfg.timerFrom = null;
        cfg.timerFromKey = null;
      }
    }

    const dhVal = $('#inDailyHours') ? num($('#inDailyHours').value, 0) : 0;
    // 只有「打卡那一刻」才按你填的有效工时算；切到定点/全自动后这行是隐藏的，
    // 那就不能让它留在后台偷偷改单价
    cfg.dailyHours = (pendingMode === 'click' && dhVal > 0) ? dhVal : null;

    cfg.inited = true;
    cfg.confirmedByUser = true;          // 这次是他自己点「存好啦」的

    // 班次变了：已确认的钱（补录、已收工结算）是既成事实，保留；
    // 正在计时的段落按新口径接着跑，不重算旧段，避免两套口径相加
    if (timeChanged) {
      if (cfg.clockFrom === 'schedule') {
        cfg.segments = [];
        cfg.clockIn = null;
      }
      // 今天已经收工：收工状态和金额都保留，别因为改午休变成「没上班」
      if (cfg.doneShift != null) {
        wasRunning = false;
        // 班次起点变了，收工标记要跟着挪到新班次上，
        // 否则 autoSettle 会认为「今天还没结算」，再结一次（工时被叠加成 15 小时）
        cfg.doneShift = shiftAt(now).start;
        if (cfg.lastShift) cfg.lastShift.start = cfg.doneShift;
      }
    }

    // 改完参数接着计：新开一段，之前的钱已经固化，不会被重算
    if (cfg.autoRun) {
      cfg.segments = [];                         // 自动模式不靠打卡段
      cfg.clockIn = null;
    } else if (wasRunning && !cfg.leaves[dayKey(now)]) {
      cfg.segments = [{ from: now, to: null }];
      cfg.clockIn = now;
    }

    celebrated = false;
    save();
    render();
    closeSheet();
    quoteTick();
    toast('存好啦 ♡');
  }

  function buildEmojiRow() {
    const row = $('#emojiRow');
    EMOJIS.forEach((e) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.e = e;
      b.textContent = e;
      b.addEventListener('click', () => {
        cfg.goalEmoji = e;
        save();                                  // 选了 emoji 就落盘，关面板不保存也不丢
        row.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x.dataset.e === e));
      });
      row.appendChild(b);
    });
  }

  function bindEvents() {
    const retryBtn = $('#btnSaveRetry');
    if (retryBtn) retryBtn.addEventListener('click', () => save());
    $('#btnClock').addEventListener('click', toggleClock);
    $('#btnSettings').addEventListener('click', () => {
      // 小窗里点齿轮：先复原成完整面板，再把设置打开
      if (compact) {
        setCompact(false);
        setTimeout(() => {
          if (!$('#sheet').classList.contains('on')) openSheet();
        }, 220);
        return;
      }
      if ($('#sheet').classList.contains('on')) closeSheet();
      else openSheet();
    });
    bindCompact();
    $('#btnHoliday').addEventListener('click', async () => {
      const b = $('#btnHoliday');
      b.textContent = '更新中…';
      b.disabled = true;
      await refreshHolidays(true);
      b.textContent = '更新';
      b.disabled = false;
      updateDaysHint();
    });
    $('#btnFix').addEventListener('click', openFix);
    $('#btnFixCancel').addEventListener('click', closeFix);
    $('#btnFixClose').addEventListener('click', closeFix);
    $('#btnAutoClose').addEventListener('click', closeFix);
    $('#btnAutoCancel').addEventListener('click', closeFix);
    $('#btnAutoGo').addEventListener('click', () => {
      closeFix();
      openSheet();
      setTimeout(() => {
        const el = $('#inStart');
        if (el) { el.focus(); el.select && el.select(); }
      }, 320);
    });
    $('#btnHistory').addEventListener('click', () => {
      if ($('#histSheet').classList.contains('on')) closeHistory();
      else openHistory();
    });
    $('#btnCloseHist').addEventListener('click', closeHistory);
    $('#histMask').addEventListener('click', closeHistory);
    $('#btnExport').addEventListener('click', exportData);
    $('#btnImport').addEventListener('click', importData);
    // 回到首次使用：清空本机配置 → 重新加载 → 又弹出首次设置
    const firstBtn = $('#btnFirstRun');
    if (firstBtn) firstBtn.addEventListener('click', () => {
      if (!firstBtn.dataset.arm) {
        firstBtn.dataset.arm = '1';
        firstBtn.dataset.old = firstBtn.textContent;
        firstBtn.textContent = '点第二下：清空并重来';
        firstBtn.classList.add('armed');
        setTimeout(() => {
          if (!firstBtn.dataset.arm) return;
          delete firstBtn.dataset.arm;
          firstBtn.textContent = firstBtn.dataset.old || '回到首次使用（清空全部数据）';
          firstBtn.classList.remove('armed');
        }, 3500);
        return;
      }
      delete firstBtn.dataset.arm;
      firstBtn.classList.remove('armed');
      try { localStorage.removeItem(STORE_KEY); } catch (e) {}
      location.reload();
    });
    $('#btnFixOk').addEventListener('click', applyFix);
    // 删除补录：第一次点变成「确认?」，再点才真删（误触不会丢钱）
    $('#fixItems').addEventListener('click', (e) => {
      const b = e.target.closest ? e.target.closest('.fi-del') : null;
      if (!b) return;
      if (b.dataset.arm !== '1') {
        b.dataset.arm = '1';
        b.textContent = '确认?';
        b.classList.add('armed');
        clearTimeout(delTimer);
        delTimer = setTimeout(() => {
          if (!b.isConnected) return;
          delete b.dataset.arm;
          b.textContent = '删除';
          b.classList.remove('armed');
        }, 3200);
        return;
      }
      clearTimeout(delTimer);
      removeFix(parseInt(b.dataset.i, 10));
    });
    $('#miniMask').addEventListener('click', (e) => { if (e.target.id === 'miniMask') closeFix(); });
    // 补录的两个时间也走同一套「不打乱正在改的那一位」逻辑
    ['#inFixStart', '#inFixEnd'].forEach((sel) => bindTimeInput(sel, updateFixHint));
    decorateTimeInputs();
    decorateNumberInputs();
    bindTimePicker();
    $('#btnBreak').addEventListener('click', toggleBreak);
    $('#lnkRedo').addEventListener('click', redoShift);
    $('#btnEditGoal').addEventListener('click', openSheet);
    $('#mask').addEventListener('click', onCloseSheetClick);
    $('#btnCloseSheet').addEventListener('click', onCloseSheetClick);
    $('#btnSave').addEventListener('click', saveSheet);

    // 通用确认弹窗
    $('#dlgOk').addEventListener('click', () => closeDlg(true));
    $('#dlgCancel').addEventListener('click', () => closeDlg(false));
    $('#dlgMask').addEventListener('click', (e) => { if (e.target.id === 'dlgMask') closeDlg(false); });

    // 加班倍率：点一下就落盘（不用等「存好啦」，符合"开关"的直觉）
    document.querySelectorAll('#segOt button').forEach((b) => {
      b.addEventListener('click', () => {
        cfg.otRate = Number(b.dataset.ot) || 1;
        save();
        syncOtSeg();
        toast('加班按 ' + (cfg.otRate === 1 ? '1 倍（不加价）' : cfg.otRate + ' 倍') + ' 算');
      });
    });

    // 点 × 的行为：立即生效并通知主进程
    document.querySelectorAll('#segClose button').forEach((b) => {
      b.addEventListener('click', () => {
        cfg.closeToTray = b.dataset.close === 'tray';
        save();
        syncCloseSeg();
        applyCloseBehavior();
        toast(cfg.closeToTray ? '点 × 会收到右下角继续计时' : '点 × 会直接退出程序');
      });
    });

    // 复制数据目录
    const copyBtn = $('#btnCopyPath');
    if (copyBtn) copyBtn.addEventListener('click', () => {
      const api = window.desktop;
      if (!dataPathCache) { renderDataPath(); toast('路径还没取到，再点一次'); return; }
      if (api && api.copyText) { api.copyText(dataPathCache); toast('路径已复制'); }
    });

    // 首页黄条：点一下直接回设置改工资
    const defBar = $('#defBar');
    if (defBar) defBar.addEventListener('click', () => openSheet());

    // 目标达成后：换下一个目标（把入口直接递到手上）
    const nextGoal = $('#btnNextGoal');
    if (nextGoal) nextGoal.addEventListener('click', () => {
      openSheet();
      const g = $('#goalGroup');
      if (g) g.open = true;
      setTimeout(() => {
        const el = $('#inGoalName');
        if (el) { el.focus(); el.select && el.select(); }
      }, 260);
    });

    // 键盘快捷键（只在窗口内，不抢系统全局热键）
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key;
      if (k === 'Enter') {
        e.preventDefault();
        if ($('#sheet').classList.contains('on')) saveSheet();
        else toggleClock();
      } else if (k.toLowerCase() === 'b') {
        e.preventDefault();
        if (!$('#btnBreak').hidden) toggleBreak();
      } else if (k === ',') {
        e.preventDefault();
        if ($('#sheet').classList.contains('on')) onCloseSheetClick();
        else openSheet();
      }
    });

    document.querySelectorAll('#modeCards .mcard').forEach((b) => {
      b.addEventListener('click', () => {
        pendingMode = b.dataset.mode;
        pendingAuto = b.dataset.auto === '1';
        syncModeCards();
        updateSalaryEcho();
      });
    });

    // 边打边提示：0 / 负数 / 字母 当场标红并说明，别等点保存才发现
    NUM_FIELDS.forEach((f) => {
      const el = $(f.sel);
      if (!el) return;
      const live = () => {
        const bad = numFormError(true);   // 正在输入时不管「空」，免得刚清空就报错
        if (bad) formError(bad.msg);
        else clearFormError();
      };
      el.addEventListener('input', () => { live(); updateSalaryEcho(); updateGoalSummary(); });
      el.addEventListener('blur', () => { live(); updateSalaryEcho(); updateGoalSummary(); });
    });
    ['#inGoalName'].forEach((sel) => {
      $(sel).addEventListener('input', updateGoalSummary);
    });
    ['#inStart', '#inEnd'].forEach((sel) => {
      $(sel).addEventListener('input', () => {
        updateModeHint(); updateSpanHint(); updateSalaryEcho(); updateLunchInfo();
      });
      $(sel).addEventListener('blur', () => {
        updateModeHint(); updateSpanHint(); updateSalaryEcho(); updateLunchInfo();
      });
    });
    ['#inLunchStart', '#inLunchEnd'].forEach((sel) => {
      $(sel).addEventListener('input', () => { updateLunchInfo(); updateSalaryEcho(); });
      $(sel).addEventListener('blur', () => { updateLunchInfo(); updateSalaryEcho(); });
    });

    // FR-05：今天请假 / 取消
    $('#btnLeave').addEventListener('click', () => {
      const now = Date.now();
      if (cfg.leaves[dayKey(now)]) exitLeave(now);
      else enterLeave(now);
    });

    document.querySelectorAll('#segDays button').forEach((b) => {
      b.addEventListener('click', () => {
        cfg.daysMode = b.dataset.mode;
        const n = monthWorkDays(cfg.daysMode);
        $('#inDays').value = n;
        syncDaysSeg();
        updateSalaryEcho();
        updateDaysHint();
      });
    });
    $('#inDays').addEventListener('input', () => {
      cfg.daysMode = 'custom';           // 手动改了就是自定义
      syncDaysSeg();
      updateSalaryEcho();
      updateDaysHint();
    });

    ['#inStart', '#inEnd', '#inLunchStart', '#inLunchEnd'].forEach((s) => bindTimeInput(s));

    $('#btnReset').addEventListener('click', () => {
      const btn = $('#btnReset');
      if (!btn.dataset.arm) {
        btn.dataset.arm = '1';
        btn.textContent = '真的要清零？';
        btn.classList.add('armed');
        setTimeout(() => {
          if (!btn.dataset.arm) return;
          delete btn.dataset.arm;
          btn.textContent = '清零累计';
          btn.classList.remove('armed');
        }, 3200);
        return;
      }
      delete btn.dataset.arm;
      btn.textContent = '清零累计';
      btn.classList.remove('armed');

      cfg.settled = 0;
      cfg.savedBase = 0;
      cfg.doneShift = null;
      cfg.segments = [];
      cfg.clockIn = null;
      cfg.lastShift = null;
      // 只清「累计」是不够的：今天的固化账本、补录、请假标记都得一起清，
      // 否则界面上的「今日已赚」还挂着一笔，跟清零对不上
      const k = dayKey(Date.now());
      cfg.todaySettled = { day: k, seconds: 0, amount: 0 };
      cfg.fixRanges = [];
      cfg.fixDay = '';
      delete cfg.dailyLog[k];
      delete cfg.leaves[k];
      $('#inSaved').value = 0;
      celebrated = false;
      save();
      render();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // 层级从高到低：确认弹窗 → 时间滑块 → 设置面板
      if (!$('#dlgMask').hidden) { e.preventDefault(); closeDlg(false); return; }
      // 滑块浮层开着的时候，Esc 只关滑块，别把整个设置面板一起关掉
      if ($('#tpMask').hidden) onCloseSheetClick();
    });

    document.querySelectorAll('.form input').forEach((inp) => {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveSheet();
      });
    });
  }

  /* ---------- 主循环 ---------- */
  function start() {
    buildEmojiRow();
    bindWindowControls();
    bindEvents();
    render();

    // 标题栏版本号与导出包版本号同源（package.json），不再各写各的
    if (window.desktop && window.desktop.getVersion) {
      window.desktop.getVersion().then((v) => {
        const el = $('#ver');
        if (el && v) el.textContent = 'v' + v;
      }).catch(() => {});
    }

    setInterval(render, 100);
    refreshHolidays(false);

    // 只有真在计时的时候才飘金币、跳数字
    setInterval(() => {
      const st = currentState(Date.now());
      if (!st.running) return;
      spawnCoin(calc().perSec);
      const n = $('#todayEarned');
      n.classList.remove('bump');
      void n.offsetWidth;
      n.classList.add('bump');
    }, 1000);

    quoteTick();
    setInterval(quoteTick, 18000);

    applyCloseBehavior();
    if (!cfg.inited) setTimeout(openSheet, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
