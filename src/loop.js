/**
 * loop.js — 常驻看屏幕：起钟、看有没有新图、到点叫醒模型。
 *
 * ## 为什么必须有这一层
 *
 * 最早这里是"模型调 watch(20s) → 拿一张图 → 回话 → 再调一次"。实测跑不住：
 * **模型拿到图、回完话就结束了**。钟必须在插件里：
 *
 *   每 2 秒   本地判定（读一眼状态），纯算术，几乎不花钱
 *   真该看时  叫醒模型（往会话投一条消息 = 模型跑一轮，这才贵）
 *
 * ## 停下来的条件（B3 后）
 *
 * 1. **模型调 stop / 用户胶囊切到关** —— 明确说不看了。
 * 2. **采集真的死了**（ffmpeg 退出、源断了）。
 * 3. **连续叫不醒**（会话没了）或**连续唤醒没人搭理**（防读图循环）。
 *
 * 悬浮窗/插话/语音机制已随 B3 丢弃清单移除 —— 交互面只有对话页。
 */

import { startTicker, wakeWithRetry } from './timer.js';

/** 两次叫醒之间至少隔这么久（叫醒一次 = 模型跑一轮，很贵） */
const WAKE_COOLDOWN_MS = 3000;
/**
 * 两张图之间至少隔这么久才叫醒模型。
 * 8 秒是"不快于一口气说完两句话"的下限；实际间隔由档位 wakeMinGapSec 传入。
 */
const WAKE_MIN_GAP_MS = 8000;
const TICK_MS = 2000;
/** 连续这么多次叫不醒就停：会话没了还每 8 秒烧一次模型，是最贵的失败模式 */
const WAKE_FAILS_MAX = 2;

/** 连续这么多次自动唤醒都没有用户搭理 → 收工（防"模型自己读图循环"） */
export const MAX_AUTONOMOUS_WAKES = 8;

/**
 * 该不该因为「没人在看」收工 —— 纯函数，好测也好读。
 *
 * 社区实报「卡读图循环」：常驻循环只有"采集停了"一个退出条件会每 15 秒叫醒一次永不停止。
 * B3 后不再有悬浮窗"开着=有人在看"的信号；动态/自动档是**用户显式选择**的常驻，
 * 所以只保留唤醒次数上限这一条兜底线（8 次没人搭理就哑，用户说话才复活）。
 */
export function shouldGoIdle({ wakesSinceUser = 0 } = {}) {
  return wakesSinceUser >= MAX_AUTONOMOUS_WAKES;
}

/**
 * 起一个常驻循环。
 *
 * @param {object} o
 * @param {object} o.ctx 宿主上下文（叫醒要用）
 * @param {string} o.sessionId **起循环时的那个会话**。不能每次现取：多开会话时
 *   session/event 会被任何一个会话更新，现取会把话投给别人。
 * @param {() => string|null} [o.getSessionId] 兜底（起循环时还没拿到 id 的情况）
 * @param {object} o.runner createRunner() 的返回值
 * @param {(m:string)=>void} [o.log]
 * @param {(reason:string)=>void} [o.onStop] 停下来时回调（同步档位状态等）
 * @param {number} [o.wakeMinGapSec] 两张图之间的最小叫醒间隔
 * @param {boolean} [o.scene] 逐帧模式（唤醒文案不同）
 * @param {(now:number)=>void} [o.onTick] 每拍回调（autoMode 心跳驱动用，R24）
 * @returns {{dispose:()=>void, state:()=>object, stopped:()=>boolean}}
 */
export function startLoop({
  ctx, sessionId = null, getSessionId = () => null, runner,
  log = () => {}, onStop = () => {}, wakeMinGapSec = WAKE_MIN_GAP_MS / 1000,
  scene = false,
  onTick = null,
} = {}) {
  let disposed = false;
  let lastWakeAt = 0;
  let wakeFailures = 0;
  let consecutiveFails = 0;
  let wakeCount = 0;
  let stopReason = null;
  const owner = sessionId ?? getSessionId() ?? null;
  /** 上一张已经叫过的图（#序号 / p脉冲 / pull@时间戳），同一张永不重复叫 */
  let lastKey = null;
  let pendingPulse = 0;
  let lastPending = 0;
  /** 采集停掉之后已经过了几拍 —— 给"队列里剩下的图"一个播报窗口，然后收工 */
  let deadTicks = 0;
  let lastWakeOk = null;
  let wakesSinceUser = 0;

  const stop = (reason) => {
    if (stopReason) return;
    stopReason = reason;
    log(`循环停了：${reason}`);
    try { onStop(reason); } catch { /* 停不下来也要停 */ }
    dispose();
  };

  async function wake(text, { cooldownMs = WAKE_MIN_GAP_MS } = {}) {
    lastWakeAt = Date.now();
    const r = await wakeWithRetry({ ctx, sessionId: owner, text, log });
    lastWakeOk = Boolean(r?.ok);
    if (r?.ok) {
      wakeCount += 1;
      consecutiveFails = 0;
      return true;
    }
    wakeFailures += 1;
    consecutiveFails += 1;
    if (consecutiveFails >= WAKE_FAILS_MAX) {
      // 会话可能已经关了：再叫下去只是每 8 秒白烧一次模型
      stop('wake-failed');
    }
    return false;
  }

  const ticker = startTicker({
    everyMs: TICK_MS,
    tick: async (now = Date.now()) => {
      if (disposed) return;
      // R24：autoMode 心跳驱动（静止降档是时间统计，每拍喂一次）
      try { onTick?.(now); } catch { /* 决策器坏了不影响循环 */ }

      // ① 采集自己停了（源断了、ffmpeg 挂了）。
      //    **续命放在这之前**：静态画面下 60 秒不出图，宽限期会把采集收走，
      //    那时 !running 是"没人来取"而不是"坏了"，不能当成停。
      const st = runner.status();
      const alive = runner.touch?.() ?? st.running;
      if (!alive) {
        deadTicks += 1;
        if (!st.pending && !st.pull || deadTicks > 2) { stop('capture-stopped'); return; }
      } else if (deadTicks) deadTicks = 0;

      // ② 没人搭理就收工（防读图循环的止血线）
      if (shouldGoIdle({ wakesSinceUser })) { stop('idle'); return; }

      // ③ 攒够一张**新的**图了 —— 这才是常态唤醒。
      // 拉取模式（B3/R20）：出图序号不再增长，用 peekAvailable() 判"有没有新帧"。
      // 推送模式（ultra/显式来源）：按出图序号判重（pending 只说明"队列里有一张"，不说明"是新的"）。
      let key = null;
      if (st.pull) {
        key = runner.peekAvailable?.() ? `pull@${Math.floor(now / 1000)}` : null;
      } else {
        const pending = Number(st.pending) || 0;
        if (pending > 0 && lastPending === 0) pendingPulse += 1;
        lastPending = pending;
        const sheetSeq = Number(st.sheets ?? st.stats?.sheets ?? 0);
        key = pending > 0 ? (sheetSeq > 0 ? `#${sheetSeq}` : `p${pendingPulse}`) : null;
      }
      if (!key || key === lastKey) return;
      if (Date.now() - lastWakeAt < Math.max(0, wakeMinGapSec) * 1000) return;   // 下一拍再来

      // 叫醒了才算"这张已经叫过"。**失败不能记账**：记了的话下一拍看到 key 没变
      // 就不再重试，连续失败计数永远到不了上限。
      const text = scene
        ? '[看屏幕·逐场景] 换画面了。\n'
          + '调 `vision({action:"peek"})` 拿这一张（逐帧模式下它只有一帧、铺满整张图），'
          + '然后**一句话**说清现在是什么场景 —— 用户要的就是"换一次说一次"，别省略。'
        : `[看屏幕] 有新画面了（这一张攒了 ${st.secondsSinceWake ?? '?'} 秒）。\n`
          + '调 `vision({action:"peek"})` 拿图看一眼，然后：值得说就在对话里正常回复，'
          + '不值得说就什么都别做（沉默是允许的，别为了刷存在感而说话）。';
      const ok = await wake(text);
      if (ok) { lastKey = key; wakesSinceUser += 1; }
    },
  });

  function dispose() {
    if (disposed) return;
    disposed = true;
    ticker.dispose();
  }

  return {
    dispose,
    stopped: () => stopReason !== null,
    state: () => ({
      stopped: stopReason !== null,
      reason: stopReason,
      session: owner,
      wakes: wakeCount,
      wakeFailures,
      lastWakeAt: lastWakeAt || null,
      lastWakeOk,
      lastSheet: lastKey,
    }),
  };
}
