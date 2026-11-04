/**
 * dialog.js — 原画确认弹窗的数据准备（规格 §四/§九 · R23）。
 *
 * server 侧算文案，client 拉去渲染自定义弹窗（复刻「完全权限」样式）。
 * token 动态化：model-info 有上下文窗口就给「占余量比例」，没有就回静态 872。
 */

const ULTRA_TOKEN_PER_FRAME = 872; // ultra 档 1600×900 单帧 ≈ 872 tok（SIZES 注释同源）

export function ultraDialogText(info) {
  if (!info || !info.contextTokens) {
    return `原画档：满幅单帧 1600×900，每张约 ${ULTRA_TOKEN_PER_FRAME} token（最贵一档，逐字级可读）。确认开启？`;
  }
  const pct = ((ULTRA_TOKEN_PER_FRAME / info.contextTokens) * 100).toFixed(2);
  return `原画档：满幅单帧 1600×900，每张约 ${ULTRA_TOKEN_PER_FRAME} token（约占当前模型 ${info.name} 上下文余量的 ${pct}%）。确认开启？`;
}
