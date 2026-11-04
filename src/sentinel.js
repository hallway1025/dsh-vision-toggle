/**
 * sentinel.js — 本地预筛接口（S4 · 规格 §八 D1 钉死形状）。
 *
 * ## v1 语义（已定决策 4：预筛默认关）
 * 本地小模型哨兵是**配置项不是依赖**：没有 ollama 完全可用（不绑架用户）。
 * v1 只留接口形状，evaluateImpl 由 v2 注入（ollama 对接在部署流程 §十一）。
 *
 * ## D1 钉死的接口形状（S4 冻结后可扩不可改语义）
 *   async function evaluate(frame) // frame = {grid: Uint8Array(64*36*3), seq, ts}
 *     → { worthReading: boolean, reason?: string }
 *
 * ## 三条硬约束（R8/R9/O8）
 * - **绝不 reject（R8）**：evaluate 内部 catch 一切错误返回
 *   {worthReading:false, reason:'sentinel-error'}——不 await 的 promise
 *   一旦 reject 就是 unhandled rejection 崩宿主。
 * - **超时降跳帧率=统计决策（R8）**：滑动窗口统计最近 N 次 evaluate 耗时，
 *   P50 > 200ms 则跳帧率 1/6→1/12；不是单帧同步判定。
 * - **grid 类型（R9）**：Uint8Array rgb24 64×36（由 buffer.js/调用方在调用前
 *   从 Float32Array 量化，6912 次 cast ~0.01ms）——本模块不负责量化。
 * - O8：每 6 帧评 1 次，输入 64×36 网格复用（sampleEvery=6，降级后 12）。
 *
 * ## 决策分层（O9）
 * evaluate 的结果**只标 worthReading flag**——它是 autoMode 决策器的输入之一，
 * 不直接触发档位升降。档位升降判据主体在 autoMode.js（纯代码层）。
 */

/** 滑动窗口长度（evaluate 耗时样本数） */
const DEFAULT_WINDOW = 12;
/** P50 超过这个值就降跳帧率（统计决策，非单帧判定） */
const DEFAULT_P50_MS = 200;

/**
 * @param {object} [opts]
 * @param {boolean} [opts.enabled=false] v1 默认关（已定决策 4）
 * @param {Function|null} [opts.evaluateImpl=null] v2 注入；形状 async (frame) => {worthReading, reason?}
 * @param {number} [opts.windowSize=12] 滑动窗口
 * @param {number} [opts.p50LimitMs=200] 降速阈值
 * @param {number} [opts.timeoutMs=1000] 单次评估挂起上限——不中断调用方（R8 不 await），
 *   只把返回值降为 sentinel-timeout
 */
export function createSentinel({
  enabled = false,
  evaluateImpl = null,
  windowSize = DEFAULT_WINDOW,
  p50LimitMs = DEFAULT_P50_MS,
  timeoutMs = 1000,
} = {}) {
  /** 最近 N 次 evaluate 耗时（ms） */
  let durations = [];
  /** 降级后的跳帧率（6=每 6 帧评 1 次；12=降级） */
  let sampleEvery = 6;
  let evaluated = 0;
  let errors = 0;
  let timeouts = 0;

  /** P50（中位数）——样本不足时返回 0（不判定） */
  function p50() {
    if (durations.length < Math.min(3, windowSize)) return 0;
    const sorted = [...durations].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  /**
   * 滑动窗口统计 + 降速（R8：统计决策）。
   * P50 > p50LimitMs → sampleEvery 6→12；持续快（P50 < 一半阈值）→ 恢复。
   * 恢复是单向滞后：只有降过速才可能恢复。
   */
  function account(ms) {
    durations.push(ms);
    if (durations.length > windowSize) durations = durations.slice(-windowSize);
    const med = p50();
    if (med > p50LimitMs) sampleEvery = 12;
    else if (sampleEvery > 6 && med > 0 && med < p50LimitMs / 2) sampleEvery = 6;
  }

  /**
   * D1 形状的 evaluate。**绝不 reject**（R8）：内部 catch 一切。
   * disabled / 无 impl → {worthReading:false, reason:'disabled'}（v1 默认路径）。
   *
   * @param {{grid:Uint8Array, seq:number, ts:number}} frame
   * @returns {Promise<{worthReading:boolean, reason?:string}>}
   */
  async function evaluate(frame) {
    if (!enabled || typeof evaluateImpl !== 'function') {
      return { worthReading: false, reason: 'disabled' };
    }
    const t0 = Date.now();
    try {
      // 挂起保护：不中断 impl（调用方本来就不 await），超时只降返回值
      const out = await Promise.race([
        Promise.resolve(evaluateImpl(frame)),
        new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), timeoutMs)),
      ]);
      account(Date.now() - t0);
      if (out && out.__timeout === true) {
        timeouts += 1;
        return { worthReading: false, reason: 'sentinel-timeout' };
      }
      evaluated += 1;
      // 形状防御：impl 返回垃圾也不崩
      if (out === null || out === undefined) return { worthReading: false, reason: 'sentinel-empty' };
      return {
        worthReading: Boolean(out.worthReading),
        reason: typeof out.reason === 'string' ? out.reason : undefined,
      };
    } catch (e) {
      errors += 1;
      account(Date.now() - t0);
      return { worthReading: false, reason: 'sentinel-error' };
    }
  }

  /** 该不该在这一帧上调用 evaluate（O8 跳帧；调用方用 seq % sampleEvery === 0 判断也行） */
  function shouldSample(seq) {
    return seq % sampleEvery === 0;
  }

  return {
    evaluate,
    shouldSample,
    get stats() {
      return {
        enabled: enabled && typeof evaluateImpl === 'function',
        evaluated, errors, timeouts,
        sampleEvery,
        p50Ms: p50(),
        window: durations.length,
      };
    },
    /** 预筛任何环节失败 → 自动降关（部署纪律：不阻塞主流程） */
    disable() { enabled = false; },
    enable() { enabled = true; },
  };
}
