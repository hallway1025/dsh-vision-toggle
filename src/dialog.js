/**
 * dialog.js — 原画确认弹窗的数据准备（规格 §四/§九 · R23）。
 *
 * server 侧算文案，client 拉去渲染自定义弹窗（复刻「完全权限」样式）。
 * token 动态化：model-info 有上下文窗口就给「占余量比例」，没有就回静态区间。
 * 0.3.0 换单位（主人 m08525 ⑥）：从「每张 token」改为「每分钟预估消耗」。
 */

const ULTRA_TOKEN_PER_FRAME = 872; // ultra 档 1600×900 单帧 ≈ 872 tok（SIZES 注释同源）

export function ultraDialogText(info) {
  const perMin = `开启后预估消耗：每分钟约 2k～26k token（画面切换 2～30 次/分钟 × ${ULTRA_TOKEN_PER_FRAME} token/张；静止屏接近下限，频繁操作接近上限）`;
  if (!info || !info.contextTokens) {
    return `原画档：满幅单帧 1600×900（逐字级可读）。${perMin}。确认开启？`;
  }
  // 占比按典型中位 8k token/分钟估 —— 精确值取决于实际画面切换频率，区间已在上面给出
  const pct = ((8000 / info.contextTokens) * 100).toFixed(2);
  return `原画档：满幅单帧 1600×900（逐字级可读）。${perMin}，约占当前模型 ${info.name} 上下文 ${pct}%/分钟。确认开启？`;
}
