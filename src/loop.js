/**
 * loop.js — 采集监护：让采集活着、让缓冲攒着、让决策器跳着。
 *
 * ## 为什么这一层什么都不叫醒
 *
 * 旧版（含 fork 原版）攒够一张图就往会话投消息叫醒模型。实测两大问题：
 * 1. **投递时机受限** —— 模型正在输出时消息只能排队，归属还会竞争（issue #1）。
 * 2. **被动且贵** —— 每张图烧一轮唤醒，画面静止时反复空转。
 *
 * 主动看改造（2026-11-04）：循环**只做三件事**——
 *   ① 采集死了就喊停（onStop）；
 *   ② 每拍喂一次 autoMode 决策器（静止降档是时间统计）；
 *   ③ 帧持续入环形缓冲（pipeline 层）。
 * 模型在自己的回合里查 status（bufferedNew>0 即有新画面）→ 主动 peek。
 * 没有任何投递路径：wakeWithRetry 本模块已不引用。
 */

import { startTicker } from './timer.js';

const TICK_MS = 2000;

/**
 * 起一个采集监护循环。
 *
 * @param {object} o
 * @param {object} o.runner createRunner() 的返回值
 * @param {(m:string)=>void} [o.log]
 * @param {(reason:string)=>void} [o.onStop] 采集死亡时回调（同步档位状态）
 * @param {(now:number)=>void} [o.onTick] 每拍回调（autoMode 心跳驱动，R24）
 * @returns {{dispose:()=>void, state:()=>object, stopped:()=>boolean}}
 */
export function startLoop({
  runner, log = () => {}, onStop = () => {}, onTick = null,
} = {}) {
  let disposed = false;
  let tickCount = 0;
  let stopReason = null;

  const stop = (reason) => {
    if (stopReason) return;
    stopReason = reason;
    log(`采集监护停了：${reason}`);
    try { onStop(reason); } catch { /* 停不下来也要停 */ }
    dispose();
  };

  const ticker = startTicker({
    everyMs: TICK_MS,
    tick: async (now = Date.now()) => {
      if (disposed) return;
      tickCount += 1;

      // ① autoMode 心跳（静止降档/建议关档是时间统计，每拍喂一次）
      try { onTick?.(now); } catch { /* 决策器坏了不影响监护 */ }

      // ② 采集死了就收。**续命放在判定之前**：静态画面下 60 秒不出图，
      //    宽限期会把采集收走，那时 !running 是"没人来取"而不是"坏了"。
      const st = runner.status();
      const alive = runner.touch?.() ?? st.running;
      if (!alive) { stop('capture-stopped'); }
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
      ticks: tickCount,
    }),
  };
}
