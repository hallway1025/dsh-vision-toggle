/**
 * runner.js — 常驻采集会话：start / watch / peek / stop。
 *
 * 和 pipeline.js 的分工：pipeline 只管「帧进、图出」，不碰进程；这里管**进程生命周期**
 * 和**取图语义**（阻塞到有图 / 立刻要 / 保持温热）。
 *
 * ## 三条刻意的设计
 *
 * ① **出图由采集侧自己攒、自己截**（pipeline 里做），`watch` 只是"取队列里那一张"。
 *    所以模型思考三秒不是延迟，只是让队列多一张。
 *
 * ② **停采集要留宽限期**。冷启动一次 400ms（屏幕）/ 1.7s（摄像头硬件唤醒），
 *    每次 watch 都停掉的话，连续看就是每次重付这笔钱。所以看完留 `graceSec` 秒，
 *    期间再来 watch 立刻就有帧；超时没人来才自己收工。
 *
 * ③ **取图永远走队列，不新建**。两张图同时在飞的时候，`take()` 给的是最早那张
 *    （时间顺序不能乱），新图挤掉旧图由 pipeline 的 queueDepth 负责。
 *
 * ## B3 拉取模式（R20 接线）
 *
 * 档位表 MODES 里 silent/dynamic/auto 带 `pullMode:true`：采集回调只打分+帧进环形
 * 缓冲（buffer.js，48MB 上限），**组图延迟到 peek/watch 按需做**（pipeline.peekSheet）。
 * 悬浮窗/插话/语音机制已随 B3 丢弃清单移除 —— 视觉的交互面只有对话页胶囊。
 * ultra 档保留推送形态（scene 满幅单帧天然是 maxFrames:1 推送）。
 */

import { spawnFrames, pickScreenEngine, screenEngineWarning } from './capture.js';
import { createPipeline } from './pipeline.js';
import { createBuffer } from './buffer.js';

/** 三档清晰度。数字是画布像素，token 约等于 像素÷1650（见调参报告）。 */
export const SIZES = Object.freeze({
  low: [800, 450],        // 218 token/张 · 4 帧时每格 400×225 —— 看视频/场景够
  standard: [1066, 600],  // 388 token/张 · 每格 533×300 —— 屏幕上的中号字能认
  high: [1280, 720],      // 559 token/张 · 每格 640×360 —— 文件名/小字能认
  ultra: [1600, 900],     // 872 token/张 · 单帧时几乎等于原屏 —— 真要读字才用（仍低于 1024 封顶）
});
export const DEFAULT_QUALITY = 'low';

/**
 * 「逐帧 / 逐场景」模式的管线参数。
 *
 * - `maxFrames: 1` —— 留下 1 帧就立刻封箱（`checkFlush` 的 `frames.length >= maxFrames`），
 *   所以一张图永远只有一个画面。
 * - `strategy: 'single'` —— 档位固定压到 1，让这一帧**铺满整张画布**。
 *   不压的话，场景密集时密度档位会升到 2/3，一格只占 1/4、1/9，中间全是灰条。
 *
 * 这两个必须成对出现：只改 maxFrames 会得到"小格子 + 大片留白"，只改 strategy
 * 会得到"一张图里好几幅满幅图，装不下就被切开"。
 */
export const SCENE_OPTS = Object.freeze({ maxFrames: 1, strategy: 'single' });

/**
 * 三档节奏。**只影响"多久算一次画面变了"和"多久叫醒一次"**，不改出图口径。
 *
 * 为什么要有它：`cutAbs` 是全局常量，模型听见"省点钱"也只能嘴上答应 ——
 * 频率完全由插件定。用户实报"回复太密集"，说明缺一个能让这句话生效的旋钮。
 *
 * | 档 | cutAbs | 唤醒间隔 | 适合 |
 * |---|---|---|---|
 * | calm | 20 | 30s | 日常挂着看，只想知道"大场面变了没" |
 * | normal | 12 | 15s | 默认。滚网页/切窗口不会每下都留帧 |
 * | dense | 7 | 8s | 幻灯片、逐帧播报这种"每一刀都要"的 |
 *
 * 7 是能给的最低值（再低只有"只改亮度"那种肉眼都看不出的变化），
 * 但它对日常屏幕太敏感 —— 光标一停、窗口一换都能过线，所以不做默认。
 */
export const PACES = Object.freeze({
  calm: { cutAbs: 20, wakeGapSec: 30 },
  normal: { cutAbs: 12, wakeGapSec: 15 },
  dense: { cutAbs: 7, wakeGapSec: 8 },
});
export const DEFAULT_PACE = 'normal';

/**
 * 五档模式表（S2 · 规格 §四 C2；S4 起行为接线）。
 *
 * 每档是一组参数组合；createRunner 消费本表：`pullMode:true` 的档位（silent/dynamic/auto）
 * 走 B3 拉取模式（采集→环形缓冲，出图按需组）；ultra 保留推送（scene 满幅单帧）。
 *
 * | 档 | 语义 | 成本形态 |
 * |---|---|---|
 * | off     | 采集进程停止、缓冲清空、peek 返回 102 | 零 |
 * | silent  | 常驻采集，不主动唤醒；仅模型 peek 时出图 | floor 帧底价 |
 * | dynamic | 自动升降 quality（密度驱动 tiers）+pace 适配 | 按屏幕活动 |
 * | ultra   | 满幅单帧 + 每次开启弹窗警告确认 | 872tok/张按需 |
 * | auto    | 按屏幕活动度与内容价值自适应选档，参数级自主 | 自适应 |
 *
 * 字段约定：
 * - enabled:false 表示采集进程应停止（关档语义）。
 * - wakeGapSec:null = 跟随 PACES[pace].wakeGapSec；Infinity = 不主动唤醒。
 * - scene:true 时走 SCENE_OPTS（满幅单帧），唤醒间隔硬编码 4s（规格 §三 R1）。
 * - auto 档参数同 dynamic 起步，自适应升降由 autoMode.js 决策器驱动（S4，O9 纯代码层）。
 */
export const MODES = Object.freeze({
  off: Object.freeze({
    label: '关',
    enabled: false,
    quality: null,
    pace: null,
    minFrames: 0,
    scene: false,
    wakeGapSec: null,
  }),
  silent: Object.freeze({
    label: '静默',
    enabled: true,
    quality: 'low',
    pace: 'calm',
    minFrames: 2,
    scene: false,
    wakeGapSec: Infinity,
    pullMode: true,
  }),
  dynamic: Object.freeze({
    label: '动态',
    enabled: true,
    quality: 'standard',
    pace: 'normal',
    minFrames: 1,
    scene: false,
    wakeGapSec: null,
    pullMode: true,
  }),
  ultra: Object.freeze({
    label: '原画',
    enabled: true,
    quality: 'ultra',
    pace: 'normal',
    minFrames: 1,
    scene: true,
    wakeGapSec: 4,
  }),
  auto: Object.freeze({
    label: '自动',
    enabled: true,
    quality: 'standard',
    pace: 'normal',
    minFrames: 1,
    scene: false,
    wakeGapSec: null,
    pullMode: true,
  }),
});
/** 默认关档（规格 §四：进程重启一律回关档）。上次选择记 config.js，仅供对照。 */
export const DEFAULT_MODE = 'off';

/** 参数签名：key 排序后拼串，`{a:1,b:2}` 与 `{b:2,a:1}` 视为同一个。 */
function optsSig(o) {
  return Object.keys(o ?? {}).sort().map((k) => `${k}=${JSON.stringify(o[k])}`).join('|');
}

/**
 * 「这一条 watch 该不该被硬闸拦下」的**纯函数**（好测，也好读）。
 *
 * 三条规矩：
 * - 用户关过窗（`hungUp`）→ 除非他显式说了要看什么，否则不重开。
 * - 文件放完了（`fileEnded`）→ 同上，文件回放是一次性的，不能自动重播。
 * - 显式传了来源 = 用户明确要求 → 一律放行。
 */
export function guardReason({ hungUp = false, fileEnded = false, explicitSrc = false } = {}) {
  if (explicitSrc) return null;
  if (hungUp) return 'hung-up';
  if (fileEnded) return 'file-ended';
  return null;
}

export function createRunner({ ffmpegPath = 'ffmpeg', log = () => {}, graceSec = 60 } = {}) {
  let pipeline = null;   // 当前（或刚停的）引擎 —— 停采集后仍留着，好把队列里剩的图发完
  let running = false;
  let run = null;
  let source = null;
  let startedAt = 0;
  let frames = 0;
  let lastError = null;
  let stoppedAt = 0;
  let graceTimer = null;
  let busy = false;
  let quality = DEFAULT_QUALITY;
  /** B3 拉取模式：非 null 时采集回调只进缓冲，出图走 peekSheet（R20） */
  let buffer = null;
  /** 已 peek 过的帧最大 t —— loop 用它判断「有没有新帧」防重复唤醒 */
  let lastPeekedT = 0;
  /**
   * 建当前管线时用的**调用方参数**（不含 oneShot）。
   *
   * 为什么需要：分辨率换了可以看 `quality`，但"逐帧模式"换的是管线参数
   * （`maxFrames` / `strategy`）—— 那些是建管线时定死的，运行中改不了。
   * 于是 watch 每次比一下签名，变了就重开：`{}` 和 `{maxFrames:1,strategy:'single'}`
   * 是两套完全不同的出图口径，不能在同一根管线上混着跑。
   */
  let runOpts = {};
  /**
   * 待领的说明（挂断那一条）。
   *
   * **为什么不写进 chat.jsonl**：窗被关掉之后，写进那条流的字没有任何人会看到；
   * 模型也拿不到，于是它继续调 `watch` —— 实测会连写两条挂断说明（相隔 96ms），
   * 模型却在说"我还在看"。
   *
   * 正确的路子和陪看一样：落在这里，下一次工具结果把它带走。
   */
  let pendingNote = null;
  /**
   * 用户"关窗挂断"过没有。
   *
   * 关窗之后再被叫醒一次，`watch` 会**重新把窗开起来**、把采集重启 ——
   * 用户看到的是"关不掉，只能卸载插件"（社区实报）。所以这里是个硬闸：
   * 挂断之后只有**显式指定来源**（用户说了要看什么）才允许重新开始。
   */
  let hungUp = false;
  /** 最近一次的采集源（teardown 会把 `source` 清空，但事后判断还需要它） */
  let lastSource = null;
  /**
   * 已经放完的文件源。**文件回放是一次性的**：放完就结束，不能自动重播。
   *
   * 以前 `watch` 会在 `stopped` 时用 `prevSrc` 自动重启，而文件源重启就是
   * "从头再放一遍"，于是 24 秒解 1955 帧、出一堆图、把模型反复叫醒，
   * 关窗也停不下来（社区实报的那条）。
   */
  let endedSource = null;

  function teardown(why) {
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    run?.stop();
    run = null;
    running = false;
    source = null;
    buffer = null;
    stoppedAt = Date.now();
    if (why) log(`收工：${why}`);
  }

  /** 停采集，但留一个宽限期 —— 这期间再来 watch 不用重新热启动 */
  function armGrace() {
    if (graceTimer) clearTimeout(graceTimer);
    if (graceSec <= 0) { teardown('grace=0'); return; }
    graceTimer = setTimeout(() => teardown(`${graceSec}s 没人来`), graceSec * 1000);
    graceTimer.unref?.();
  }

  /**
   * 续命（常驻循环每拍调一次）。
   *
   * **不加这个，循环会被宽限期饿死**：一次 `watch` 结束后留 60 秒宽限，时间一到采集收工，
   * 而静止屏幕上 60 秒内又不会出新图 —— 循环下一拍看到 `!running && !pending`，
   * 就判定"采集自己停了"并自杀。用户安安静静看文档时，这个"常驻循环"最多活 60 秒。
   *
   * 只续"还在跑"的采集：ffmpeg 真死了不能靠它诈尸。
   */
  function touch() {
    if (!running) return false;
    armGrace();
    return true;
  }

  async function start({ src = { kind: 'screen' }, opts = {}, quality: q = null } = {}) {
    if (running) return { already: true, source };
    // 走到这里就是"明确要开始看"（watch 的自动重启已经在前面被硬闸挡住了）。
    hungUp = false;
    endedSource = null;
    let engine = src.engine ?? 'auto';
    if (src.kind === 'screen' && engine === 'auto') engine = await pickScreenEngine({ ffmpegPath });
    const size = SIZES[q] ?? SIZES[DEFAULT_QUALITY];
    // B3 拉取模式（R20）：pullMode 档位采集回调只打分+帧进环形缓冲（48MB 上限），
    // 组图延迟到 peek/watch 按需做 —— 静止屏零组图成本，peek 才付 PNG 编码。
    if (opts.pullMode) buffer = createBuffer();
    const p = createPipeline({ ...opts, width: size[0], height: size[1], buffer });
    // 记下"这次建管线用的调用方参数"（不含 oneShot）——watch 靠它发现"模式变了"。
    runOpts = { ...opts };
    delete runOpts.oneShot;
    const s = { ...src, engine };
    quality = q ?? DEFAULT_QUALITY;
    frames = 0;
    lastError = null;
    pipeline = p;
    running = true;
    source = s;
    lastSource = s;
    startedAt = Date.now();
    run = spawnFrames({
      source: s,
      width: p.constants.width,
      height: p.constants.height,
      fps: p.constants.fps,
      ffmpegPath,
      engine,
      onFrame: (f) => {
        frames += 1;
        // 一帧解码就抛 = 整条管线停摆，这里必须兜住：宁可少一帧，不能让采集线程炸掉
        try { p.push(f); } catch (e) { lastError = `push: ${e?.message ?? e}`; }
      },
      onStderr: (s2) => { if (process.env.DSH_SEE_NOW_DEBUG) log(s2.trim()); },
    });
    run.done.then((r) => {
      if (pipeline === p) {
        lastError ??= `ffmpeg 退出（${r.frames} 帧 / ${Math.round(r.ms / 1000)}s）`;
        // 文件源放完 = 这一次看完了。记下来，别让下一条 watch 又从头放一遍。
        if (s.kind === 'file') endedSource = s;
        teardown('ffmpeg-exit');
      }
    }).catch((e) => {
      lastError = `ffmpeg: ${e?.message ?? e}`;
      if (pipeline === p) teardown('ffmpeg-error');
    });
    log(`开始看 ${s.kind}${engine && engine !== 'auto' ? `/${engine}` : ''} @${size[0]}×${size[1]}`);
    // macOS 没给屏幕录制权限时，采集本身是"成功"的，只是画面全黑 ——
    // 探针已经试出来了，这里把它带回去，让模型（和用户）知道该去系统设置，而不是以为插件坏了。
    const warning = s.kind === 'screen' ? screenEngineWarning() : null;
    if (warning) log(`⚠️ ${warning}`);
    return { started: true, source: s, engine, quality, params: p.constants, warning };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


  return {
    start,
    stop() { teardown('手动'); return { stopped: true }; },
    /**
     * 用户关掉了悬浮窗 = 明确表示"不看了"。
     *
     * 只 `stop()` 不够：下一条 `watch` 看到 `stopped` 会立刻重启采集并把窗**重新开起来**，
     * 用户体感就是"关掉又弹出来，除非卸载插件"（社区实报）。这里立一个硬闸，
     * 直到有人显式指定来源为止。
     */
    hangUp() { hungUp = true; teardown('用户关窗'); return { hungUp: true }; },
    /** 挂断状态（测试和状态页用） */
    isHungUp() { return hungUp; },
    /** 有没有一个"已经放完、不能自动重播"的文件源 */
    endedFile() { return endedSource ? { ...endedSource } : null; },
    /** 这一轮开过窗没有（循环判"用户关窗"用） */
    windowWasOpen() { return false; }, // B3：悬浮窗机制已移除，恒 false（loop 兼容位）

    /**
     * 阻塞等一张图。
     *
     * `quality` 换了就**重启采集**（分辨率是采集侧定死的，改不了）：
     * 分辨率在采集那一层就定死了，所以换清晰度 = 换一根管道。重启一次 ~400ms，
     * 但换完只发一帧就把"现在是什么"给出去，不用再等攒满一张。
     *
     * @param {{seconds?:number, minFrames?:number, src?:object, quality?:string, opts?:object,
     *          signal?:AbortSignal|null, eagerMs?:number}} o
     * @returns {Promise<{ok:boolean, reason?:string, sheet?:object, waited:number}>}
     */
    async watch({
      seconds = 300, minFrames = 1, src = null, quality: q = null, opts = {},
      // 宿主给的取消信号。**必须在这里看**：不看的话用户按了停止，这个调用还要挂到封顶。
      signal = null,
      // 冷启动时"先给此刻"的宽限：等第一帧最多这么久，等到就立刻出图。
      eagerMs = 3000,
    } = {}) {
      const explicitSrc = Boolean(src && src.kind);
      const blocked = guardReason({ hungUp, fileEnded: Boolean(endedSource), explicitSrc });
      if (blocked === 'hung-up') return { ok: false, reason: 'hung-up', waited: 0 };
      if (blocked === 'file-ended') {
        return { ok: false, reason: 'file-ended', waited: 0, path: endedSource?.path };
      }
      if (explicitSrc) { hungUp = false; endedSource = null; }

      if (busy) return { ok: false, reason: 'busy', waited: 0 };
      busy = true;
      const t0 = Date.now();
      try {
        const prevSrc = source ?? lastSource;
        const switching = Boolean(pipeline) && q && SIZES[q] && q !== quality;
        const modeChanged = Boolean(pipeline) && optsSig(runOpts) !== optsSig(opts);
        const stopped = Boolean(pipeline) && !running;
        // **冷启动**（手上没有管线，或采集已经停了）才 eager。换清晰度不算 —— 那条路已经用 oneShot 了。
        const cold = !pipeline || stopped;
        if (!pipeline || stopped || switching || modeChanged) {
          if (pipeline) {
            teardown(stopped ? '采集已停，重开'
              : switching ? `换清晰度 ${quality} → ${q}` : '换模式（逐帧 / 常规）');
          }
          if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
          await start({
            src: src ?? prevSrc ?? { kind: 'screen' },
            // 只有**换清晰度**才 oneShot：那一下缓冲区刚被扔掉，等攒满一张就等于白等一整个窗口。
            opts: { ...opts, oneShot: switching },
            quality: q,
          });
        } else if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }

        const deadline = t0 + Math.max(2, seconds) * 1000;

        // ── 拉取模式（B3/R20）：帧在环形缓冲里，等到「新帧够数」再按需组图 ──
        if (buffer) {
          const need = Math.max(1, minFrames);
          while (Date.now() < deadline) {
            if (signal?.aborted) {
              return { ok: false, reason: 'cancelled', waited: (Date.now() - t0) / 1000 };
            }
            if (buffer.count >= need) {
              const sheet = pipeline.peekSheet(need, 15);
              if (sheet) {
                const newest = sheet.frames[sheet.frames.length - 1]?.t ?? 0;
                if (newest > lastPeekedT) lastPeekedT = newest;
                return { ok: true, sheet, waited: (Date.now() - t0) / 1000, quality, pull: true };
              }
            }
            if (!running) break;
            await sleep(120);
          }
          // 到点：手上攒的也算数（partial），一张都没有才报 no-change
          const partial = buffer.count > 0 ? pipeline.peekSheet(1, 0) : null;
          if (partial) {
            const newest = partial.frames[partial.frames.length - 1]?.t ?? 0;
            if (newest > lastPeekedT) lastPeekedT = newest;
            return { ok: true, sheet: partial, waited: (Date.now() - t0) / 1000, partial: true, quality, pull: true };
          }
          return {
            ok: false,
            reason: signal?.aborted ? 'cancelled' : (frames ? 'no-change' : 'capture-stopped'),
            waited: (Date.now() - t0) / 1000,
            error: lastError,
          };
        }

        // ── 推送模式（ultra / 显式来源）：队列语义，保留 eager 首帧 ──
        while (Date.now() < deadline) {
          if (signal?.aborted) {
            return { ok: false, reason: 'cancelled', waited: (Date.now() - t0) / 1000 };
          }
          // **冷启动先给此刻**：静止屏第一条要等 30~60s，用户刚开口就等一分钟，体感是"没反应"。
          if (cold && minFrames <= 1 && eagerMs > 0) {
            const eagerUntil = Date.now() + eagerMs;
            while (Date.now() < eagerUntil && !signal?.aborted) {
              if (pipeline?.hasFrame) {
                const first = pipeline.flushNow(null, 'first');
                if (first) {
                  return {
                    ok: true, sheet: first, waited: (Date.now() - t0) / 1000,
                    quality, first: true,
                  };
                }
              }
              await sleep(60);
            }
          }
          const s = pipeline?.take();
          if (s) {
            if (s.frames.length >= minFrames) {
              return { ok: true, sheet: s, waited: (Date.now() - t0) / 1000, quality };
            }
          }
          if (!running && !pipeline?.pending) break;
          await sleep(120);
        }
        const last = pipeline?.flushNow(null, 'timeout');
        if (last && last.frames.length >= minFrames) {
          return { ok: true, sheet: last, waited: (Date.now() - t0) / 1000, partial: true, quality };
        }
        return {
          ok: false,
          reason: signal?.aborted ? 'cancelled' : (frames ? 'no-change' : 'capture-stopped'),
          waited: (Date.now() - t0) / 1000,
          error: lastError,
        };
      } finally {
        busy = false;
        if (pipeline) armGrace();
      }
    },

    /**
     * 取走**已经拼好的那一张**（后台唤醒走这条）。
     *
     * 语义是 "grab the sheet that already piled up" —— 模型被"有新画面了"叫醒时，
     * 要的就是那张攒好的图，不该再等、也不该换一张。
     *
     * **不能走 `flushNow()`**：那是插话用的，会把 `sheets` 整个清空、再把"此刻那一帧"
     * 塞成一张新图。结果是队列里攒好的多帧摘要被一张单帧替换掉 —— 复现见 issue #1：
     * `queued [0,2,4]` → 调完 peek 变成 `[5.92]`、`pending 0`。
     * 队列空就老实返回 null（调用方会提示"下一张还在攒"），
     * 想看"此刻"请走 `watch`。
     *
     * 顺便支窗（**不等它**）：走 peek 路线的会话没有 watch 的阻塞点，
     * 不在这里开窗的话，用户永远没有可以打字的入口，也就没有"关窗 = 不看了"。
     */
    peek() {
      // 拉取模式（B3/R20）：按需组图。peekSheet **不消费**缓冲 —— 同一批帧可重复 peek，
      // 画面随新帧自然更新；loop 用 peekAvailable() 判「有新帧」防重复唤醒。
      if (buffer) {
        const sheet = running ? pipeline.peekSheet(4, 15) : null;
        if (sheet) {
          const newest = sheet.frames[sheet.frames.length - 1]?.t ?? 0;
          if (newest > lastPeekedT) lastPeekedT = newest;
        }
        if (running) armGrace();
        return sheet;
      }
      const queued = pipeline?.take() ?? null;
      if (running) armGrace();
      return queued;
    },

    /** 拉取模式下「有没有没 peek 过的新帧」（loop 防重复唤醒用） */
    peekAvailable() {
      if (!buffer || !running) return false;
      const newest = buffer.peek(1, 0)[0]?.t ?? 0;
      return newest > lastPeekedT;
    },

    /** 常驻循环每拍续命（见 touch 的注释） */
    touch,

    /** 落一条说明，等下一次工具结果带走（挂断那一条走这里） */
    note(text) {
      const t = String(text ?? '').trim();
      if (t) pendingNote = t;
      return pendingNote;
    },

    /** 取走说明（取完就没了：同一句话不该每一轮都念一遍） */
    takeNote() {
      const n = pendingNote;
      pendingNote = null;
      return n;
    },

    status() {
      return {
        running,
        source,
        lastSource,
        hungUp,
        endedFile: endedSource?.path ?? null,
        quality,
        size: SIZES[quality],
        frames,
        since: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
        lastError,
        idleSec: stoppedAt ? Math.round((Date.now() - stoppedAt) / 1000) : 0,
        stats: pipeline?.stats ?? null,
        pending: pipeline?.pending ?? 0,
        // 拉取模式状态（B3/R20）：buffer 在跑=pull 档位；buffered 给计数与字节占用
        pull: Boolean(buffer),
        buffered: buffer ? { count: buffer.count, mb: +buffer.mbUsed.toFixed(1), mbMax: buffer.mbMax } : null,
        // 出图序号（单调递增）：常驻循环靠它保证"同一张图只叫醒一次"。
        // `pending` 只说明"队列里有"，不说明"是不是新的一张"—— 模型不取的话它一直是 1。
        sheets: pipeline?.stats?.sheets ?? 0,
        // 本批第一帧到现在多久：唤醒文案里要说"攒了多久"，不然模型不知道这段时间有多长
        secondsSinceWake: pipeline?.secondsSinceWake ?? null,
        // 这一轮开过窗没有（循环靠它区分"用户关了窗" 和 "窗压根没开起来"）
        // 有没有待领的说明（挂断那条）—— status 里看得见，才不会"明明写了没人读"
        notePending: Boolean(pendingNote),
      };
    },
  };
}
