/**
 * dialog.js — ultra 开档确认弹窗的数据准备（规格 §四/§九 · R23）。
 *
 * server 侧算文案，client 拉去渲染自定义弹窗（复刻「完全权限」样式）。
 * token 动态化：model-info 有上下文窗口就给「占余量比例」，没有就回静态区间。
 * 0.4.0 改拉取语义（主人 m09062 定位「参数拉满」）：开档本身零消耗，消耗在模型 peek 时。
 * 0.7.0 文案简化（主人 m09916）：只说高消耗 + 每分钟约多少 token（peek 8 次/分钟估）。
 */

const ULTRA_TOKEN_PER_FRAME = 872; // ultra 档 1600×900 单帧 ≈ 872 tok（SIZES 注释同源）

export function ultraDialogText(info, speed = 'default') {
  // 0.8.1 终版（m11187 主人口径）：警告统一写**满载消耗**——872/次 × 模型每轮 2~3s 的物理上限 30 次/分钟
  // = 26,160 token/分钟；实际消耗随观看次数线性下降，不看不耗（采集零消耗）
  const max = ULTRA_TOKEN_PER_FRAME * 30;
  if (!info || !info.contextTokens) {
    return `ultra：满载 ≈${max.toLocaleString('en-US')} token/分钟（每次观看 ≈${ULTRA_TOKEN_PER_FRAME}，不看不耗）。确认开启？`;
  }
  const pct = ((max / info.contextTokens) * 100).toFixed(2);
  return `ultra：满载 ≈${max.toLocaleString('en-US')} token/分钟（每次观看 ≈${ULTRA_TOKEN_PER_FRAME}），约占 ${info.name} 上下文 ${pct}%。确认开启？`;
}
