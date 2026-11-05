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
  // 0.8.0 主人口径（m11149/m11160）：警告只报每分钟消耗预估，参数描述删去；
  // 默认=间歇观看口径（8 次/分钟），实时=连续观看口径（模型每轮 2~3s ≈ 15~30 次/分钟）
  if (speed === 'realtime') {
    const perMinHi = ULTRA_TOKEN_PER_FRAME * 30;
    if (!info || !info.contextTokens) {
      return `ultra：每次观看 ≈${ULTRA_TOKEN_PER_FRAME} token，连续实时观看最高 ≈${perMinHi.toLocaleString('en-US')}/分钟。确认开启？`;
    }
    const pct = ((perMinHi / info.contextTokens) * 100).toFixed(2);
    return `ultra：连续实时观看最高 ≈${perMinHi.toLocaleString('en-US')} token/分钟，约占 ${info.name} 上下文 ${pct}%。确认开启？`;
  }
  const perMin = ULTRA_TOKEN_PER_FRAME * 8;
  if (!info || !info.contextTokens) {
    return `ultra：约每分钟 ${perMin.toLocaleString('en-US')} token（按每分钟看 8 次估）。确认开启？`;
  }
  const pct = ((perMin / info.contextTokens) * 100).toFixed(2);
  return `ultra：约每分钟 ${perMin.toLocaleString('en-US')} token，约占 ${info.name} 上下文 ${pct}%。确认开启？`;
}
