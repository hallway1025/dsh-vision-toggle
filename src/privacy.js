/**
 * privacy.js — 黑名单本地匹配（规格 R21 / §十 P1 能力边界）。
 *
 * **v1 能力边界（README 同步披露）**：
 * - 只做**本地**窗口标题匹配（框架保留：runner 摘除 window.js 后暂无标题源，
 *   接缝留在这里 —— 接上时标题进 isBlocked，命中帧不出图）；
 * - 零留痕：命中不写日志、不落盘、不上报，只在返回值里给 boolean；
 * - 初始关键词清单中英双语；**不做内容级 OCR 过滤**（承诺不变）。
 */

/** 初始清单（中英双语）。用户可编辑 ~/.dsh/vision-toggle/privacy.json 追加。 */
export const DEFAULT_BLOCKLIST = Object.freeze([
  '银行', 'bank', '支付', 'pay', 'wallet', '钱包',
  '密码', 'password', 'passwd', 'credential',
  '身份证', 'id card', '社保', '(ssn|social security)',
  '1password', 'bitwarden', 'keepass',
]);

export function createPrivacy({ extra = [] } = {}) {
  // 全部转小写做子串匹配；正则形词条用 regex: 前缀
  const subs = [];
  const res = [];
  for (const w of [...DEFAULT_BLOCKLIST, ...extra]) {
    if (typeof w !== 'string' || !w) continue;
    if (w.startsWith('regex:')) {
      try { res.push(new RegExp(w.slice(6), 'i')); } catch { /* 坏词条忽略 */ }
    } else subs.push(w.toLowerCase());
  }
  return {
    /** 命中=true。零留痕：不记哪个词命中，调用方拿到 true 直接丢帧即可。 */
    isBlocked(title) {
      if (typeof title !== 'string' || !title) return false;
      const t = title.toLowerCase();
      if (subs.some((w) => t.includes(w))) return true;
      return res.some((re) => re.test(title));
    },
    get size() { return subs.length + res.length; },
  };
}
