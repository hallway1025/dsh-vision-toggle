/**
 * dialog.js — ultra 开档确认弹窗的数据准备（规格 §四/§九 · R23）。
 *
 * server 侧算文案，client 拉去渲染自定义弹窗（复刻「完全权限」样式）。
 * token 动态化：model-info 有上下文窗口就给「占余量比例」，没有就回静态区间。
 * 0.4.0 改拉取语义（主人 m09062 定位「参数拉满」）：开档本身零消耗，
 * 消耗发生在模型 peek 时 —— 文案从「每分钟预估」改为「单帧成本 + 缓冲留存」。
 */

const ULTRA_TOKEN_PER_FRAME = 872; // ultra 档 1600×900 单帧 ≈ 872 tok（SIZES 注释同源）

export function ultraDialogText(info) {
  const perFrame = `模型每次 peek 单帧约 ${ULTRA_TOKEN_PER_FRAME} token（1600×900 ≈ 原屏逐字级可读）；48MB 缓冲约存 11 帧，越旧越被挤掉`;
  if (!info || !info.contextTokens) {
    return `ultra：参数拉满 —— 1600×900 满幅采集 + 最高灵敏度（dense）。采集不消耗 token，${perFrame}。确认开启？`;
  }
  // 占比按单帧 × 假定每分钟 peek 8 次估 —— 实际消耗完全由模型调用频率决定
  const pct = ((ULTRA_TOKEN_PER_FRAME * 8 / info.contextTokens) * 100).toFixed(2);
  return `ultra：参数拉满 —— 1600×900 满幅采集 + 最高灵敏度（dense）。采集不消耗 token，${perFrame}；按每分钟 peek 8 次估约占 ${info.name} 上下文 ${pct}%/分钟。确认开启？`;
}
