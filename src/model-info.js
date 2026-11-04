/**
 * model-info.js — 当前会话模型信息数据源（规格 R23 token 动态化的 B4 补位）。
 *
 * 从 sessionController 读当前会话的模型名与上下文窗口；拿不到就返回 null，
 * 调用方（dialog.js）回退静态文案。**绝不 throw**（弹窗文案不值得崩插件）。
 */

const CTX_WINDOWS = {
  // 常见模型的上下文窗口（token）。只做弹窗文案用的粗估，不参与任何决策。
  'deepseek-chat': 128000,
  'deepseek-reasoner': 128000,
  'gpt-4o': 128000,
  'claude-sonnet': 200000,
  'glm-4': 128000,
  default: null,
};

export function modelInfoOf(sessionController, sessionId) {
  try {
    const s = sessionId ? sessionController?.get?.(sessionId) ?? null : null;
    const model = s?.model ?? s?.header?.model ?? null;
    if (!model) return null;
    const name = typeof model === 'string' ? model : (model.id ?? model.name ?? null);
    if (!name) return null;
    const ctx = Object.entries(CTX_WINDOWS).find(([k]) => name.toLowerCase().includes(k))?.[1]
      ?? CTX_WINDOWS.default;
    return { name, contextTokens: ctx };
  } catch { return null; }
}
