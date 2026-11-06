'use strict';
/* 窗口形态的唯一真相：缩小/展开时的尺寸规则都写在这里。
 * 主进程和自动化测试共用同一份实现 —— 测试里再抄一遍 setBounds 逻辑，
 * 就只会测到"抄本"，测不到真身（v1.9.0 的补录 bug 就是这么漏过去的）。
 */
const NORMAL = { width: 424, height: 720 };
const COMPACT_MIN_HEIGHT = 150;   // 再小就没法看了
const NORMAL_MIN = { width: 380, height: 640 };
const MAX_SIDE = 4000;

// 横向也别把窗口怼出屏幕：贴边缩小时往回收一点
function clampX(box, width, area) {
  const x0 = Math.round(box && box.x || 0);
  if (!area || !area.width) return x0;
  let x = x0;
  if (x + width > area.x + area.width) x = area.x + area.width - width;
  if (x < area.x) x = area.x;
  return Math.round(x);
}

// 改高度时别把窗口顶到屏幕外面去（贴着任务栏/屏幕底边时最容易发生）
function fitY(box, height, area) {
  const y0 = Math.round(box && box.y || 0);
  if (!area || !area.height) return y0;
  let y = y0;
  if (y + height > area.y + area.height) y = area.y + area.height - height;
  if (y < area.y) y = area.y;
  return Math.round(y);
}

// 迷你态只收高度，**宽度一个像素都不动**：
// 卡片还是那张卡片、还是那么宽，只是下面被裁掉 —— 用户要的是"少看几块"，不是"整张变小"。
function compactBounds(box, wantHeight, area) {
  const width = Math.max(320, Math.round((box && box.width) || NORMAL.width));
  const height = Math.min(Math.max(COMPACT_MIN_HEIGHT, Math.round(wantHeight || 240)), MAX_SIDE);
  return { x: clampX(box, width, area), y: fitY(box, height, area), width, height };
}

// 展开 = 回到「缩小前那一份」宽高，而不是沿用迷你态的宽度
// （v1.9.0 只记了高度，迷你窗被拉宽过就会一直满屏）
function expandBounds(box, normal, area) {
  const n = normal || NORMAL;
  const width = Math.min(Math.max(320, Math.round(n.width || NORMAL.width)), MAX_SIDE);
  const height = Math.min(Math.max(400, Math.round(n.height || NORMAL.height)), MAX_SIDE);
  return { x: clampX(box, width, area), y: fitY(box, height, area), width, height };
}

// 正常态的初始尺寸：设计值 424×720，但绝不超出工作区（小屏/高缩放下放不下就矮一点）
function normalBounds(area) {
  const width = NORMAL.width;
  let height = NORMAL.height;
  if (area && area.height) {
    // 留 8px 余量，别贴着任务栏/屏幕边
    height = Math.min(NORMAL.height, Math.max(480, Math.round(area.height - 8)));
  }
  return { width, height };
}

function sameBounds(a, b) {
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

module.exports = {
  NORMAL,
  NORMAL_MIN,
  COMPACT_MIN_HEIGHT,
  compactBounds,
  expandBounds,
  normalBounds,
  clampX,
  fitY,
  sameBounds
};
