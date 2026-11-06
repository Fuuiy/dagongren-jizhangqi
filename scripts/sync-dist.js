/* 把刚打好的免安装产物镜像到 dist/打工人记账器，双击就能测，不用装
 *
 * 用法：
 *   npm run build:win        （先出包，产出 release/win-unpacked）
 *   node scripts/sync-dist.js
 * 或者一步：npm run pack:dist
 *
 * 说明文件（使用说明.txt / 第一次用先看这里.txt）是手工维护的，
 * 镜像时会保留原样，不会被清掉。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const DST = path.join(ROOT, 'dist', '打工人记账器');
const KEEP = ['使用说明.txt', '第一次用先看这里.txt'];
const EXE = '打工人记账器.exe';

const candidates = [
  path.join(ROOT, 'release', 'win-unpacked'),
  path.join(ROOT, 'release', `打工人记账器-${pkg.version}-免安装版`)
];
const SRC = candidates.find((p) => fs.existsSync(path.join(p, EXE)));

if (!SRC) {
  console.error('[sync-dist] 找不到打包产物，先跑 npm run build:win');
  candidates.forEach((p) => console.error('  试过：' + p));
  process.exit(1);
}

// 说明文件先读进内存：它们不属于打包产物，复制过程中不能被覆盖或删除
const kept = {};
for (const f of KEEP) {
  const p = path.join(DST, f);
  if (fs.existsSync(p)) {
    kept[f] = fs.readFileSync(p);
    const m = kept[f].toString('utf8').match(/v(\d+\.\d+\.\d+)/);
    if (m && m[1] !== pkg.version) {
      console.warn('[sync-dist] 注意：' + f + ' 里写的是 v' + m[1] + '，当前是 v' + pkg.version);
    }
  }
}

const sizeOf = (dir) => {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else n += fs.statSync(p).size;
    }
  };
  walk(dir);
  return n;
};

// 逐文件复制：不用 fs.cpSync / fs.rmSync 的递归模式，
// 一是某些运行环境会拦递归删/复制，二是目录被资源管理器占着时整棵树删不动
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

const t0 = Date.now();
copyTree(SRC, DST);

// 只清掉「源里没有」的顶层条目（比如旧版遗留的 LICENSE）
const stale = [];
for (const name of fs.readdirSync(DST)) {
  if (KEEP.indexOf(name) >= 0) continue;
  if (!fs.existsSync(path.join(SRC, name))) stale.push(name);
}
for (const name of stale) {
  try {
    const p = path.join(DST, name);
    if (fs.statSync(p).isDirectory()) continue;
    fs.unlinkSync(p);
  } catch (e) {
    console.warn('[sync-dist] 清不掉旧文件（忽略）：' + name);
  }
}

for (const f of KEEP) {
  if (kept[f]) fs.writeFileSync(path.join(DST, f), kept[f]);
}

// 「第一次用先看这里.txt」里写的是发布包名（打工人记账器-x.y.z-免安装版），
// 但这里的目标目录叫 dist\打工人记账器，复制后统一改成「当前这个文件夹」
const introPath = path.join(DST, '第一次用先看这里.txt');
if (fs.existsSync(introPath)) {
  let t = fs.readFileSync(introPath, 'utf8');
  const before = t;
  const pkgDir = `打工人记账器-${pkg.version}-免安装版`;
  // 先把整句改掉，再替换剩下的名字，不然会出现「删掉 当前这个文件夹 整个文件夹」这种重复
  t = t.replace(`直接删掉 ${pkgDir} 整个文件夹即可`, '直接删掉当前这个文件夹即可');
  t = t.replace(new RegExp(pkgDir.replace(/\./g, '\\.'), 'g'), '当前这个文件夹');
  // 幂等兜底：重复跑过一次之后会留下「删掉 当前这个文件夹 整个文件夹」这种绕口句子
  t = t.replace('直接删掉 当前这个文件夹 整个文件夹即可', '直接删掉当前这个文件夹即可');
  t = t.replace('打开文件夹：当前这个文件夹', '就在当前这个文件夹里');
  t = t.replace('打工人记账器 v' + pkg.version + ' · 免安装版（绿色版）',
                '打工人记账器 v' + pkg.version + ' · 免安装版（绿色版 · 开发测试目录）');
  if (t !== before) fs.writeFileSync(introPath, t);
}

const exePath = path.join(DST, EXE);
if (!fs.existsSync(exePath)) {
  console.error('[sync-dist] 复制完了却没有 exe，检查源目录：' + SRC);
  process.exit(1);
}

console.log('[sync-dist] OK  v' + pkg.version
  + '  ' + Math.round(sizeOf(DST) / 1048576) + 'MB'
  + '  ' + ((Date.now() - t0) / 1000).toFixed(1) + 's'
  + (stale.length ? '  清掉旧文件：' + stale.join(',') : ''));
console.log('[sync-dist] 源：' + path.relative(ROOT, SRC));
console.log('[sync-dist] 双击这个就能测：' + path.join('dist', '打工人记账器', EXE));
