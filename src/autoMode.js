/**
 * autoMode.js — 自动挡决策器（S4 · 规格 §四 auto 档 + §六 O9 决策分层）。
 *
 * ## O9 决策分层（本模块的存在理由）
 * - **预筛只标 flag**：sentinel 的 worthReading 是 feed() 的输入之一，
 *   绝不直接触发档位变更。
 * - **档位升降归纯代码**：判据主体 = 帧事件流（via/score/时间），全部本地算术。
 *
 * 本模块是**纯决策器**：不起定时器、不碰采集进程、不 import sentinel——
 * 由组装点（index.js）把两者接起来。决策只通过 shift 回调出 condolence，
 * 效果由调用方执行（改 quality/pace/stop）。
 *
 * ## 决策表（v3.9 自动挡 + 规格 §四）
 * | 输入 | 判据 | 动作 |
 * |---|---|---|
 * | 连续 floor | 3 个 floor 信号（静止屏） | 降一档（quality 或 pace 各降一） |
 * | cut | 任何 cut 信号（画面突变） | 立即升回 dynamic 基准档 |
 * | 静止 ≥5min | 距最后活动 300s | 切省流（calm+low） |
 * | 静止 ≥15min | 距最后活动 900s | 建议停止（stop 语义） |
 * | worthReading=true | 预筛 flag（O9） | 只记 flag+计数，**不直接切档**；与 cut 同现时加速升档 |
 *
 * ## 102 三态状态机（P2：v1 定时器探活 300ms 心跳）
 * running（有帧进来）→ suspended（心跳超时=采集挂起/锁屏）→ off。
 * 由调用方定时器驱动 poll(now)，本模块不自起定时器。
 * 三态不是档位：suspended 只冻结决策（锁屏通知预览不触发升降），off 归 runner。
 */

/** 档位阶梯（quality 从低到高；pace 从省到灵） */
const QUALITY_LADDER = ['low', 'standard', 'high', 'ultra'];
const PACE_LADDER = ['calm', 'normal', 'dense'];

/** 动态基准档（cut 恢复目标）：中字可读 + 常规节奏 */
export const AUTO_BASE = { quality: 'standard', pace: 'normal' };
/** 省流档（静止 5min 目标） */
export const AUTO_CALM = { quality: 'low', pace: 'calm' };

const FLOOR_RUN = 3;            // 连续 floor 数 → 降档
const STILL_CALM_MS = 300_000;  // 5min 静止 → 省流
const STILL_STOP_MS = 900_000;  // 15min 静止 → 建议 stop
const HEARTBEAT_MS = 300;       // P2：102 探活心跳

/**
 * @param {object} opts
 * @param {Function} [opts.onShift] 档位变更回调：({quality, pace, why, stop?}) => void
 * @param {Function} [opts.onFlag] 预筛 flag 回调（O9：只报告不切档）：({worthReading, seq, ts}) => void
 */
export function createAutoPilot({ onShift = () => {}, onFlag = () => {} } = {}) {
  let quality = AUTO_BASE.quality;
  let pace = AUTO_BASE.pace;
  let floorRun = 0;
  let lastActivityAt = Date.now();
  let lastFrameAt = 0;
  let lastPollAt = 0;
  /** 102 三态：running | suspended | off */
  let state = 'off';
  let worthCount = 0;
  let shifts = 0;

  function emit(why, extra = {}) {
    onShift({ quality, pace, why, state, ...extra });
  }

  function setQuality(q, why) {
    if (q === quality) return;
    quality = q;
    shifts += 1;
    emit(why);
  }

  function setPace(pc, why) {
    if (pc === pace) return;
    pace = pc;
    shifts += 1;
    emit(why);
  }

  /**
   * 喂一个帧事件（采集回调内，纯同步，~0.001ms）。
   * @param {{via:string, t:number, score?:number, worthReading?:boolean, seq?:number, ts?:number}} ev
   */
  function feed(ev) {
    const now = ev.ts ?? Date.now();
    state = 'running';
    lastFrameAt = now;
    lastPollAt = now;
    if (ev.worthReading) {
      worthCount += 1;
      // O9：预筛 flag 只上报，不切档。与 cut 同时出现才作为加速信号（下方 cut 分支读它）。
      onFlag({ worthReading: true, seq: ev.seq ?? null, ts: now });
    }
    if (ev.via === 'floor') {
      floorRun += 1;
      // floor 只证明心跳活着，不算活动——lastActivityAt 只留 cut/mark/start/user 更新，
      // 否则静止判据（5min/15min）会被 floor 帧永远洗掉
      if (floorRun >= FLOOR_RUN) {
        floorRun = 0;
        // 降档：quality 先降到底，pace 再降；两级都到底=维持（不再降）
        const qi = QUALITY_LADDER.indexOf(quality);
        if (qi > 0) setQuality(QUALITY_LADDER[qi - 1], 'floor-run');
        else {
          const pi = PACE_LADDER.indexOf(pace);
          if (pi > 0) setPace(PACE_LADDER[pi - 1], 'floor-run');
        }
      }
    } else if (ev.via === 'cut') {
      // cut = 画面突变 → 升回基准档。worthReading 同帧出现 → 直接基准（加速路径）
      floorRun = 0;
      lastActivityAt = now;
      const targetQ = ev.worthReading ? AUTO_BASE.quality : quality;
      const qi = QUALITY_LADDER.indexOf(quality);
      const ti = QUALITY_LADDER.indexOf(AUTO_BASE.quality);
      if (qi < ti) setQuality(QUALITY_LADDER[Math.min(qi + 1, ti)], 'cut');
      const pi = PACE_LADDER.indexOf(pace);
      if (pi < PACE_LADDER.indexOf(AUTO_BASE.pace)) setPace(AUTO_BASE.pace, 'cut');
    } else {
      // start / mark / user：算活动，清 floor 连击
      floorRun = 0;
      lastActivityAt = now;
    }
  }

  /**
   * 心跳驱动（P2：调用方每 300ms 调一次；v1 定时器探活形态）。
   * 职责：①帧流断了 → suspended ②静止超时 → 省流/建议停止。
   * @param {number} [now]
   */
  function poll(now = Date.now()) {
    lastPollAt = now;
    // 三态推进：off → running 靠 feed；running → suspended 靠心跳超时。
    // suspended 冻结决策（锁屏通知预览不触发升降），直接返回。
    if (state === 'running' && now - lastFrameAt > 5 * HEARTBEAT_MS) {
      state = 'suspended';
      emit('heartbeat-lost');
      return;
    }
    if (state === 'off' || state === 'suspended') return;
    // 静止判定：5 分钟降费档、15 分钟建议关闭（R28 还原裸块为直排代码）
    const still = now - lastActivityAt;
    if (still >= STILL_STOP_MS) {
      onShift({ quality, pace, why: 'still-15min', stop: true, state });
      state = 'off'; // 建议停止后决策器归零，重启进程回关档（§四）
      return;
    }
    if (still >= STILL_CALM_MS) {
      setQuality(AUTO_CALM.quality, 'still-5min');
      setPace(AUTO_CALM.pace, 'still-5min');
    }
  }

  function reset() {
    quality = AUTO_BASE.quality;
    pace = AUTO_BASE.pace;
    floorRun = 0;
    lastActivityAt = Date.now();
    lastFrameAt = 0;
    state = 'off';
  }

  return {
    feed, poll, reset,
    get state() { return { quality, pace, state, worthCount, shifts, floorRun, stillMs: Math.max(0, Date.now() - lastActivityAt) }; },
  };
}
