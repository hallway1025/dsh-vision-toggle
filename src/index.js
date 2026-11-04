/**
 * index.js — 插件入口。只做三件事：注册工具、路由 action、把图交成附件。
 *
 * **唯一的取图方式是 `watch`**：它阻塞到「攒够一张」或超时，然后把图作为**工具返回值**
 * 交给宿主。不要用 `sessionController.prompt` 往会话里推 —— 那样模型看到图又去调工具、
 * 自己唤醒自己，停不下来（0.0.1 就是死在这儿）。
 */

import { createRunner, SCENE_OPTS, PACES, DEFAULT_PACE, MODES, DEFAULT_MODE } from './runner.js';
import { resolveFfmpeg } from './binaries.js';
import { screenshotFlow } from './screenshot.js';
import { visionToolSpec, TOOL_TIMEOUT_MS, DEFAULT_BLOCK_SEC } from './tool-spec.js';
import { startLoop } from './loop.js';
import { loadConfig, saveConfig } from './config.js';
import { createPrivacy } from './privacy.js';
import { modelInfoOf } from './model-info.js';
import { ultraDialogText } from './dialog.js';

export const name = 'dsh-vision-toggle';

/**
 * `watch` 最多阻塞多久。
 *
 * **必须比宿主的 timeoutMs 早收工**：工具自己挂得比宿主的死线还久，到点就不是
 * "返回一张图"，而是整条调用被 abort（`signal` 一起 abort，模型看到的是超时错误）。
 * 留 40 秒给建图/交附件/模型想一想。
 */
const MAX_BLOCK_SEC = Math.max(30, Math.floor(TOOL_TIMEOUT_MS / 1000) - 40);

// 三个都在 inject 里声明：cordis 的属性访问只沿 fiber 父链找**已注册**的服务，
// 不声明时 `ctx.attachments` 是 undefined，而且 `?.` 挡不住（get 陷阱直接 throw）。
export const inject = ['tools', 'attachments', 'sessionController'];

/** 可选服务：优先 `ctx.get()`，老宿主退回属性访问且包 try。 */
function serviceOf(ctx, key) {
  try {
    if (typeof ctx?.get === 'function') {
      const v = ctx.get(key);
      if (v) return v;
    }
  } catch { /* 没声明 inject 时 get 陷阱会 throw */ }
  try { return ctx?.[key] ?? null; } catch { return null; }
}

/**
 * 把返回值洗成**无损 JSON**。宿主会校验 `JSON.parse(JSON.stringify(v))` 与原值等价，
 * 只要对象里有 `undefined`（哪怕只是某个可选字段没赋值）就判
 * `tool returned invalid output: value is not lossless JSON`，整条调用作废。
 */
function toLosslessJson(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(toLosslessJson);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = toLosslessJson(v);
  return out;
}

async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (mod?.defineTool) return mod.defineTool;
  } catch { /* 落到环境变量 —— 本地开发/测试时用 */ }
  const override = process.env.DSH_TOOLS_PATH;
  if (override) {
    const { pathToFileURL } = await import('node:url');
    const mod = await import(pathToFileURL(override).href);
    if (mod?.defineTool) return mod.defineTool;
  }
  throw new Error('cannot resolve @deepseek-ai/dsh-tools (set DSH_TOOLS_PATH for local dev)');
}

/** 一张图 → 模型看得懂的清单。数字都是「这张图里第几格」，不是抽象指标。 */
function sheetText(sheet, { waited = 0, partial = false, looping = false } = {}) {
  const { frames, from, to, why } = sheet;
  // 单帧时首尾相等，写成区间会变成"过去 24.1–24.1 秒"，读起来像出错了
  const span = frames.length === 1
    ? `此刻（第 ${frames[0].t.toFixed(1)} 秒）的 1 个画面`
    : `过去 ${from.toFixed(1)}–${to.toFixed(1)} 秒的 ${frames.length} 个画面`;
  const head = `${span} · ${sheet.w}×${sheet.h}`
    + `${partial ? '，还没攒满就截断了' : ''}`
    + `${waited ? ` · 等了 ${waited.toFixed(0)}s` : ''}`;
  const lines = frames.map((f, i) => {
    const cell = sheet.cells?.[i];
    const size = cell ? `${cell.pw}×${cell.ph}` : '—';
    // 档位要报**两件事**：算法给的档位，和它实际占多少画布。
    // 两者不一致是因为排布器为了把这一批塞进一张图，把格子压小了 —— 只报档位会让
    // 人以为"1 档 = 整幅"，而实际是 400×225（踩过：用户看到"1 档"配 400×225 以为算错了）。
    const k = cell ? Math.max(1, Math.round(sheet.w / Math.max(1, cell.pw))) : null;
    const tierText = k && k !== f.tier ? `${f.tier}档→1/${k}` : `${f.tier} 档`;
    return `  ${i + 1}. ${f.t.toFixed(1)}s · ${size} · ${f.via} · ${tierText}`;
  });
  const whyText = why === 'user' ? '用户插话截断的'
    : why === 'timeout' ? '等满了先给你'
      : why === 'time' ? '攒到这个点先给你'
        : why === 'full' ? '这张装满了'
          : why === 'first' ? '刚打开，先给你此刻'
            : why === 'oneshot' ? '换了清晰度，先给你此刻'
              : '流结束';
  // 常驻模式要**明说**，否则模型会以为"还得我自己再调一次"，或者以为"看一眼就完事了"
  const loopNote = looping
    ? '\n**已经进入常驻模式**：下一张攒够我会再叫你，不用你现在就调下一次。'
      + '你现在只要做一件事 —— 值得说就在对话里正常回复，不值得说就别出声。'
      + '用户关掉悬浮窗我就停。'
    : '';
  return `${head}\n${lines.join('\n')}${loopNote}\n（${whyText}；想看下一段就再调一次 \`vision({action:"peek"})\`。）`;
}

/**
 * 提交成宿主附件，并组装工具返回值。
 *
 * **`saveImage` 必须 `.call(svc, …)`**：它内部读 `this.compression`，方法取下来裸调会丢 this，
 * 报 `Cannot read properties of undefined (reading 'compression')` —— 所有出图工具一起挂。
 */
async function attachAndReturn(ctx, sheet, extra = {}) {
  const svc = serviceOf(ctx, 'attachments');
  if (!svc?.saveImage) {
    return { text: '拿到图了，但宿主没有 attachments 服务，交不上去。', meta: { ok: false, ...extra } };
  }
  const ref = await svc.saveImage.call(svc, {
    data: sheet.png,
    mediaType: 'image/png',
    name: `vision-${Date.now()}.png`,
  });
  return {
    images: [ref],
    text: sheetText(sheet, extra),
    meta: {
      ...extra,
      frames: sheet.frames.length,
      from: +sheet.from.toFixed(2),
      to: +sheet.to.toFixed(2),
      fill: +sheet.fill.toFixed(3),
      why: sheet.why,
      bytes: sheet.png.length,
    },
  };
}

export async function apply(ctx) {
  try {
    return await registerAll(ctx);
  } catch (e) {
    // 最坏的情况是插件不能用，不是应用起不来
    try { ctx?.logger?.error?.(`[vision-toggle] failed to load: ${e?.stack ?? e}`); } catch { /* ignore */ }
    if (process.env.DSH_SEE_DEBUG) throw e;
    return () => {};
  }
}

async function registerAll(ctx) {
  const defineTool = await loadDefineTool();
  const disposers = [];
  const log = (m) => { try { ctx?.logger?.info?.(`[vision-toggle] ${m}`); } catch { /* ignore */ } };

  // DSH 桌面版把 ffmpeg 放在 `~/.dsh/tools/ffmpeg/bin`，**不进 PATH**。
  // 写裸 'ffmpeg' 在 macOS 上就是 ENOENT，而且会伪装成"插件坏了"。
  const ffmpeg = resolveFfmpeg();
  log(`ffmpeg: ${ffmpeg.path}（${ffmpeg.source}）`);
  const runner = createRunner({
    ffmpegPath: ffmpeg.path,
    log,
  });
  disposers.push(() => runner.stop());

  /**
   * 当前会话 id：从 `session/event` 钩子里拿（`session.header.id`）。
   *
   * 必须有它才能叫醒模型 —— 没有就退化成"看完一张就停"，那正是要修的病。
   * 用**函数**而不是快照：会话 id 由钩子随时更新，闭包里存值会让第一次之后全用旧的。
   */
  let lastSessionId = null;
  // R23 数据源：会话模型信息（inject 声明里有 sessionController；拿不到时 modelInfoOf 返 null → 静态文案兜底）
  const sc = serviceOf(ctx, 'sessionController') ?? null;

  /**
   * **逐帧 / 逐场景模式**（默认关）。
   *
   * 开了之后：每留下 1 帧就单独出一张满幅图 → 每换一次场景模型就收到一张图 + 一次唤醒。
   * 这是给演示用的（"每换一个场景就告诉我这是什么"），**平时别开**：
   * 2 秒换一张画面就是每分钟 30 次唤醒，每次一张图（233 token）+ 一轮模型往返。
   *
   * 之所以做成"会话级粘性开关"而不是每次 watch 传参：模型很容易忘，
   * 忘一次就退回多帧拼图，演示当场露馅。所以开一次管到 `scene:false` 或 `stop` 为止。
   */
  let sceneMode = false;
  /** 节奏：calm / normal / dense（粘性）。**这是"省点钱"唯一能真的生效的旋钮。** */
  /** 循环是按哪个模式起的 —— 模式变了要重建，不然唤醒节奏还是旧的 */
  let loopScene = null;
  /** 切模式时那一句说明：下一次工具结果里带给模型，然后清掉 */
  let pendingModeNote = '';

  /**
   * **六档状态（0.3.0 重定义 · 主人拍板）**：off / low / high / max / ultra / custom（自定义）。
   *
   * 胶囊点击 → `applyMode`（这里说了算）；模型在会话里改 scene/pace/stop 参数 →
   * `currentMode` 归 null（胶囊显示"自定义"）。档位只决定初始参数，之后模型仍可微调。
   */
  // 进程重启一律回关档（规格 §四）；config 只恢复用户的节奏/清晰度微调（工程规范 §二）
  let currentMode = DEFAULT_MODE;
  const cfg0 = loadConfig({ log });
  let paceMode = cfg0.pace ?? DEFAULT_PACE;
  let modeSeq = 0;
  /** R21 黑名单（v1 无窗口标题源=接缝保留；status 暴露词条数供验证） */
  const privacy = createPrivacy();
  const sseClients = new Set();
  const broadcastMode = () => {
    const line = 'data: ' + JSON.stringify({ type: 'mode', seq: ++modeSeq, mode: currentMode, at: Date.now() }) + '\n\n';
    for (const res of sseClients) { try { res.write(line); } catch { /* 掉线由 close 清理 */ } }
  };

  /**
   * 换档：stop（teardown，running=false）→ start（新参数立刻生效）→ 按档位决定起不起循环。
   *
   * runner.start 撞 `already:true` 只发生在宽限期内（running 仍 true）；而 `stop()`
   * 就是 teardown，已把 running 置 false —— 所以 stop→start 直接吃到新参数，
   * 不需要仿 watch 的 optsSig 重启路（那条路是给**阻塞 watch** 中途换参用的）。
   * 原画每次开启需确认（规格 §四）；关 = 采集停止，缓冲随 teardown 排空。
   */
  const applyMode = async (modeId, { confirmed = false, quality = null, pace = null } = {}) => {
    const m = MODES[modeId];
    if (!m) return { ok: false, code: 101, error: `未知档位：${modeId}` };
    if (modeId === 'ultra' && currentMode !== 'ultra' && confirmed !== true) {
      // 401=需要确认 / 402=用户拒绝（规格 §七 错误码表，ERRORS.md 同源）
      return { ok: false, code: 401, error: 'confirm-needed', hint: 'ultra 参数拉满（1600×900 采集 + 最高灵敏度），peek 单帧约 872 token' };
    }
    currentMode = modeId;
    sceneMode = Boolean(m.scene);
    paceMode = modeId === 'custom'
      ? (pace && PACES[pace] ? pace : paceMode)   // 自定义：用面板传入的节奏，没传就保持现状
      : (m.pace ?? paceMode);                      // 固定档：档位自带节奏
    loopScene = null;
    stopLoop('换档');
    try { runner.stop(); } catch { /* 没在跑 */ }
    if (!m.enabled) {
      log(`档位 → ${m.label}（采集停止）`);
      broadcastMode();
      saveConfig({ mode: modeId, pace: paceMode, quality: m.quality }, { log });
      return { ok: true, mode: modeId, label: m.label };
    }
    const opts = m.scene ? { ...SCENE_OPTS, cutAbs: PACES.dense.cutAbs } : { cutAbs: PACES[paceMode].cutAbs };
    if (m.pullMode) opts.pullMode = true;   // B3/R20：拉取档位帧进环形缓冲
    // 清晰度覆盖（0.3.0）：low/high/max/custom 四档接受；off 无采集，ultra 固定满幅不降
    const effQ = ['low', 'standard', 'high'].includes(quality) && modeId !== 'off' && modeId !== 'ultra' ? quality : m.quality;
    const st = await runner.start({ src: { kind: 'screen' }, quality: effQ, opts });
    // 主动看改造（0.4.0 六档全拉取）：所有采集档统一起**监护循环**（只攒帧+心跳，零投递）。
    ensureLoop();
    log(`档位 → ${m.label}（quality=${effQ} pace=${paceMode}${m.scene ? ' scene' : ''}${m.pullMode ? ' pull' : ''}${effQ !== m.quality ? ' 自定义' : ''}）`);
    broadcastMode();
    saveConfig({ mode: modeId, pace: paceMode, quality: effQ }, { log });
    return { ok: true, mode: modeId, label: m.label, quality: effQ, running: true, started: st };
  };

  if (typeof ctx.on === 'function') {
    try {
      const off = ctx.on('session/event', (session) => {
        const id = session?.header?.id ?? session?.id;
        if (id) lastSessionId = id;
      });
      if (typeof off === 'function') disposers.push(off);
    } catch (e) {
      // 拿不到就退化成"只能手动调"，但要说出来 —— 静默失败是这类 bug 的温床
      log(`session/event 钩子失败：${e?.message ?? e}`);
    }
  }

  /** 正在跑的常驻循环（同一时刻只有一个） */
  let loop = null;
  const stopLoop = (reason = '手动') => {
    if (!loop) return;
    const wasStopped = loop.stopped();
    loop.dispose();
    loop = null;
    if (!wasStopped) log(`循环停了（${reason}）`);
  };
  disposers.push(() => stopLoop('插件卸载'));

  /**
   * 起循环（幂等，按会话）。
   *
   * **这是"看完一张就停"和"一直看下去"的分界线**：以前 `watch` 返回一张图就结束了，
   * 模型回完话自然收工。现在 watch 返回第一张图之后，插件自己接着跑，
   * 攒够下一张就叫醒模型 —— 直到用户关窗。
   *
   * **不接 `run.signal`**：那是单次调用的取消通知，挂上去等于"这一轮结束循环就死"
   * （实测表现就是"它答一句就没下文了"）。取消/超时在 `runner.watch()` 里自己判。
   *
   * **换会话要换循环**：`lastSessionId` 会被任何一个会话的 `session/event` 顶掉，
   * 沿用旧循环就会把话投到别的会话里（"我在这个窗口说话，另一个窗口回答"）。
   *
   * **owner 由调用方传入的优先**：`watch` 是阻塞的（15~40 秒），等它返回时
   * `lastSessionId` 可能已经被另一个会话的事件顶掉了。所以 `watch` 会在**开始等待前**
   * 把当时的会话 id 记下来传进来，而不是让这里现取（issue #1 的归属竞争）。
   */
  const ensureLoop = (owner = null) => {
    /**
     * **非实时的文件回放不起常驻循环。**
     *
     * 循环的意义是"实时源一直在产帧，攒够一张就叫你"。而 `source:"file"` 是调试用的：
     * 有限、放完就停，模型自己调 `watch` 就能一段段取完。给它起循环的后果是
     * 24 秒解出 1955 帧、刷出几十张图、把模型反复叫醒（社区实报）。
     */
    const st0 = runner.status();
    const finiteFile = st0?.lastSource?.kind === 'file' && st0?.lastSource?.realtime !== true;
    if (finiteFile) {
      if (loop) stopLoop('文件回放（有限，不需要循环）');
      loopScene = null;
      return null;
    }
    if (loop && !loop.stopped()) return loop;
    if (loop) stopLoop('重建');
    loop = startLoop({
      runner,
      log,
      onStop: (reason) => {
        try { runner.stop(); } catch { /* 已经停了 */ }
      },
    });
    log('采集监护已启动（攒帧+心跳，零投递）');
    return loop;
  };

  /**
   * 把"待领的说明"（挂断那一条）贴到工具结果最前面。
   *
   * 取完就没了 —— 同一句话不该每一轮都念一遍。这也解释了为什么不能写进 chat.jsonl：
   * 窗关掉之后那条流没人看，模型也拿不到（实测它继续调 watch，还说"我还在看"）。
   */
  const withPendingNote = (value) => {
    let note = null;
    try { note = runner.takeNote(); } catch { note = null; }
    if (!note || !value || typeof value !== 'object') return value;
    const text = typeof value.text === 'string' ? value.text : '';
    return { ...value, text: text ? `${note}\n\n${text}` : note };
  };

  const toolObj = {
    ...visionToolSpec(),
    async execute(args = {}, run = {}) {
      // 第二个参数是宿主的 `ToolRunContext`：`signal` 是"这一轮被取消了"的唯一通知。
      // 它只交给**阻塞等待**（watch）；常驻循环不挂它，理由见 ensureLoop。
      const out = await toolObj.route(args, run);
      // 切模式那句话只带一次：模型要立刻知道"从现在起一张图一个画面"，
      // 但下一轮还念一遍就变成噪音了。
      const noted = pendingModeNote && out && typeof out.text === 'string'
        ? { ...out, text: `${pendingModeNote}\n\n${out.text}` }
        : out;
      pendingModeNote = '';
      return toLosslessJson(withPendingNote(noted));
    },

    async route(args = {}, run = {}) {
      const action = String(args.action ?? 'watch').toLowerCase();

      /**
       * 模式开关（粘性）。
       *
       * 变了就必须**把管线拆掉重开**：`maxFrames` / `strategy` 是建管线时定死的参数，
       * 运行中改不了。同时把循环也重建一次 —— 唤醒间隔跟着模式走
       * （逐帧 4 秒 / 常规 8 秒），不重建的话切过去还是旧节奏。
       */
      let modeNote = '';
      if (typeof args.scene === 'boolean' && args.scene !== sceneMode) {
        sceneMode = args.scene;
        currentMode = null; // 模型手动改参 → 胶囊显示"自定义"
        try { runner.stop(); } catch { /* 没在跑 */ }
        stopLoop('换模式');
        loopScene = null;
        modeNote = sceneMode
          ? '已切到**逐帧模式**：每换一次场景给你一张满幅图（一张图 = 一个画面）。'
            + '只在演示/逐场景播报时用；说完话接着调 watch，换场景时我会叫你。'
          : '已切回**常规模式**：一张图装几帧、攒够才发。';
        log(modeNote.replace(/\*\*/g, ''));
        pendingModeNote = modeNote;
      }

      /**
       * 节奏（粘性）。**这是"太密了 / 省点钱"唯一真正生效的入口。**
       *
       * 光靠模型在 `say` 里答应没用 —— 出图频率和唤醒间隔都是插件参数，
       * 不改参数就是不改行为。所以听到"慢一点 / 省点钱"就传 `pace:"calm"`。
       */
      const wantPace = args.pace ? String(args.pace).toLowerCase() : null;
      if (wantPace && PACES[wantPace] && wantPace !== paceMode) {
        paceMode = wantPace;
        currentMode = null; // 同上：模型手动改参 → "自定义"
        try { runner.stop(); } catch { /* 没在跑 */ }
        stopLoop('换节奏');
        loopScene = null;
        const t = {
          calm: '已切到**省电节奏**：20 分以上才算换画面，最多 30 秒叫你一次。',
          normal: '已切回**默认节奏**：12 分算换画面，最多 15 秒叫一次。',
          dense: '已切到**灵敏节奏**：7 分就算换画面，最多 8 秒叫一次（费钱，只在演示/逐帧时用）。',
        }[wantPace];
        pendingModeNote = [t, pendingModeNote].filter(Boolean).join('\n\n');
        log(t.replace(/\*\*/g, ''));
      }

      if (action === 'watch') {
        const src = args.source ? {
          kind: String(args.source).toLowerCase(), path: args.path, realtime: args.realtime === true,
        } : null;
        // **封顶必须小于宿主给这个工具的 timeoutMs**（见 tool-spec）：工具自己挂得比
        // 宿主的死线还久，到点就不是"返回一张图"，而是整条调用被 abort（还会顺带 abort signal）。
        const seconds = Math.min(
          Number(args.seconds) > 0 ? Number(args.seconds) : DEFAULT_BLOCK_SEC,
          MAX_BLOCK_SEC,
        );
        const requestedMinFrames = Number(args.minFrames) > 0 ? Number(args.minFrames) : 1;
        // **逐帧模式和 minFrames 互斥**：逐帧一张图就 1 帧，`minFrames > 1` 永远等不满，
        // 会一路等到超时再报"画面没变"——那是假故障。让 minFrames 让路（它只是
        // "别给我太碎的图"，而逐帧本来就要碎），并把这句说出去，别让人以为设了 5 就真有 5。
        const minFrames = sceneMode ? 1 : requestedMinFrames;
        if (sceneMode && requestedMinFrames > 1) {
          pendingModeNote = [
            `逐帧模式下每张图只有 1 帧，\`minFrames: ${requestedMinFrames}\` 这条路上不生效（已按 1 处理）。`
            + '要按帧数攒图，先 `vision({scene:false})`。',
            pendingModeNote,
          ].filter(Boolean).join('\n\n');
        }
        const r = await runner.watch({
          seconds,
          minFrames,
          src,
          quality: args.quality ? String(args.quality).toLowerCase() : null,
          // 逐帧模式：一张图一帧 + 档位固定 1（铺满）；常规按节奏定切点门槛。
          // 参数变了 runner 会自己重开管线。
          opts: {
            ...(sceneMode ? SCENE_OPTS : {}),
            cutAbs: (sceneMode ? PACES.dense : PACES[paceMode]).cutAbs,
          },
          signal: run?.signal ?? null,
        });
        if (!r.ok) {
          // 用户关过窗：**只有他重新要求看，才允许再开**。这一条以前只靠工具描述
          // 里的一句"别再调了"，模型不照做就会把窗重新弹出来。
          if (r.reason === 'hung-up') {
            return {
              text: '用户已经关掉了悬浮窗，这一轮看屏幕结束了。\n'
                + '**不要再调 `vision`**。等用户明确说要看再开始（胶囊或让他调 `vision`）。',
              meta: { ok: false, reason: 'hung-up' },
            };
          }
          // 文件回放放完了：不能自动从头重播，必须显式再传一次来源。
          if (r.reason === 'file-ended') {
            return {
              text: `这个文件已经放完了（${r.path ?? ''}）。\n`
                + '**不会自动重播**。要再看一遍就显式传 `source:"file"` + `path`，'
                + '要接着看屏幕就传 `source:"screen"`。',
              meta: { ok: false, reason: 'file-ended', path: r.path ?? null },
            };
          }
          if (r.reason === 'cancelled') {
            return {
              text: '这一轮被取消了（用户按了停止，或者调用超时），等待已经结束。\n'
                + '他想接着看时说一声，再调 `vision({action:"peek"})`。',
              meta: { ok: false, reason: 'cancelled', waited: +r.waited.toFixed(1) },
            };
          }
          if (r.userText) {
            return {
              text: `用户刚说话：「${r.userText}」——但这一刻还没收到画面（刚开或刚发完）。\n`
                + '先回答他，需要看图就再调一次 `vision({action:"peek"})`。',
              meta: { ok: false, reason: r.reason, userText: r.userText, waited: +r.waited.toFixed(1) },
            };
          }
          return {
            text: r.reason === 'no-change'
              ? `看了 ${r.waited.toFixed(0)} 秒，画面基本没变（不够 ${minFrames} 帧就不发）。`
                + '\n再等一会儿，或者直接问用户想让你看什么。'
              : `没看成（${r.reason}）${r.error ? `：${r.error}` : ''}。`,
            meta: { ok: false, reason: r.reason, waited: +r.waited.toFixed(1) },
          };
        }
        // **拿到图后确保监护在跑** —— 帧继续攒进环形缓冲，模型之后自己 peek。
        // （主动看改造：循环只监护不叫人，watch 是"取一张"，取完帧继续攒。）
        const lp = ensureLoop();
        const sb = runner.status();
        return await attachAndReturn(ctx, r.sheet, {
          waited: r.waited, partial: r.partial, quality: r.quality,
          userText: r.userText ?? null,
          buffered: sb.bufferedNew ?? null,
        });
      }

      if (action === 'peek') {
        const s = runner.peek();
        const st = runner.status();
        // 主动看改造：peek 永不消费帧（拉取层保证）；有采集就确保监护在跑。
        if (st.running) ensureLoop();
        if (!s) {
          return {
            text: '手上还没有画面（刚开或刚发完，下一张还在攒）。\n'
              + `缓冲 ${st.mbUsed ?? 0}MB/${st.mbMax ?? 48}MB，新帧 ${st.bufferedNew ?? 0} 张 —— 我在自己的回合里主动看，循环不会叫人。`,
            meta: { ok: false, reason: 'no-sheet', mode: currentMode, bufferedNew: st.bufferedNew ?? 0 },
          };
        }
        return await attachAndReturn(ctx, s, {
          bufferedNew: st.bufferedNew ?? 0,
          bufferedMb: st.mbUsed ?? null,
        });
      }

      if (action === 'start') {
        currentMode = null; // 模型手动拉起 → "自定义"（无循环，除非后续 watch 接管）
        const src = args.source ? { kind: String(args.source).toLowerCase() } : { kind: 'screen' };
        const r = await runner.start({ src });
        return {
          text: r.already ? '已经在看了。'
            : `开始看 ${r.source.kind}（引擎 ${r.engine}）${r.warning ? `。⚠️ ${r.warning}` : '。'}`,
          meta: r,
        };
      }

      if (action === 'stop') {
        currentMode = 'off'; // 模型显式停 → 等价关档
        stopLoop('手动 stop');
        runner.stop();
        return { text: '停了。窗口还开着，想再看得重新调 watch。', meta: { ok: true } };
      }

      if (action === 'status') {
        const s = runner.status();
        const lp = loop?.state() ?? null;
        return {
          text: (s.running
            ? `在看 ${s.source?.kind} @${s.size?.[0]}×${s.size?.[1]}（${s.quality}，${s.since}s，收到 ${s.frames} 帧，留帧 ${s.stats?.kept ?? 0}，出图 ${s.stats?.sheets ?? 0}）`
              + `${s.lastError ? `\n⚠ ${s.lastError}` : ''}`
            : `没在采集（${s.idleSec}s 前停的）${s.lastError ? `\n⚠ ${s.lastError}` : ''}`)
            // 循环=纯采集监护（主动看改造）：只攒帧，零投递（喂决策器的接缝已随 autoMode 删除而闲置）
            + `\n监护：${lp && !lp.stopped
              ? `在跑（${lp.ticks} 拍，攒帧不叫人）`
              : lp?.reason ? `已停（${lp.reason}）` : '没起'}`
            // 新帧计数：模型回合里看 bufferedNew>0 就 peek，不看也不会被催
            + `\n缓冲：${s.pull
              ? `${s.bufferedNew ?? 0} 帧新 / 共 ${s.buffered?.count ?? 0} 帧 / ${s.buffered?.mb ?? 0}MB（上限 ${s.buffered?.mbMax ?? 48}MB）`
              : (s.pending ? `有 ${s.pending} 张没取走（出图序号 ${s.sheets}）` : '空')}`
            + `\n隐私：黑名单 ${privacy.size} 词条（本地匹配 · 零留痕）`
            // 模式：逐帧时一张图只有一帧、铺满；常规是多帧拼格
            + `\n模式：${sceneMode ? '逐帧（一张图 = 一个场景，铺满）' : '常规（多帧拼一张）'}`
            + ` · 节奏：${sceneMode ? 'dense（跟逐帧走）' : paceMode}`
            + `（切点门槛 ${(sceneMode ? PACES.dense : PACES[paceMode]).cutAbs}）`
            // 档位单独一行：胶囊/模型侧改参后**实际生效的是哪一档**，以这里为准
            + `\n档位：${MODES[currentMode]?.label ?? `自定义（scene=${sceneMode ? '开' : '关'} · pace=${paceMode}）`}`,
          meta: { ...s, mode: currentMode, loop: lp },
        };
      }

      return { text: `未知 action: ${action}（可用 watch / peek / start / stop / status）`, meta: { action } };
    },
  };

  // ── 通信面（B1 冻结）：/api/vision-toggle/* ──────────────────────────────
  const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  const readBody = (req) => new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 8192) { try { req.destroy(); } catch { /* ignore */ } resolve(null); } });
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(null));
  });

  const apiHandler = async (req, res) => {
    // prefix 注册：req.url 可能是完整路径也可能是 remainder，两种都兼容
    const p = String(req.url ?? '').replace(/^.*\/api\/vision-toggle/, '') || '/';
    try {
      if (req.method === 'GET' && p === '/status') {
        const s = runner.status();
        return json(res, 200, {
          mode: currentMode,
          label: MODES[currentMode]?.label ?? null,
          running: Boolean(s.running),
          quality: s.quality ?? null,
          pending: s.pending ?? 0,
          sheets: s.sheets ?? 0,
          // 主动看改造：新帧计数与缓冲占用（模型回合里查 bufferedNew 决定看不看）
          pull: Boolean(s.pull),
          bufferedNew: s.bufferedNew ?? 0,
          buffered: s.buffered ?? null,
          scene: sceneMode,
          pace: paceMode,
          loop: loop?.state() ?? null,
        });
      }
      if (req.method === 'GET' && p === '/dialog') {
        // R23：客户端弹窗直接拿文案（token 估算集中在 dialog.js，client 不复算）
        const info = modelInfoOf(sc, lastSessionId ?? null);
        return json(res, 200, {
          ok: true,
          model: info?.name ?? null,
          contextTokens: info?.contextTokens ?? null,
          text: ultraDialogText(info),
        });
      }
      if (req.method === 'POST' && p === '/mode') {
        const body = await readBody(req);
        let args = {};
        try { args = body ? JSON.parse(body) : {}; } catch { return json(res, 400, { error: 'body 不是合法 JSON' }); }
        const r = await applyMode(String(args.mode ?? ''), {
          confirmed: args.confirmed === true,
          quality: typeof args.quality === 'string' ? args.quality : null,
          pace: typeof args.pace === 'string' ? args.pace : null,
        });
        return json(res, r.ok ? 200 : 400, r);
      }
      if (req.method === 'POST' && p === '/screenshot') {
        // 截图键 v2（0.5.0 基座）：gdigrab 全屏原生分辨率，隐藏-恢复宿主窗，
        // A 路 = Electron 剪贴板 + webContents.paste() 直进聊天框。
        // A 路不可达时把 base64 PNG 交回前端走 B 路（写剪贴板 → Ctrl+V）。
        const body = await readBody(req);
        let args = {};
        try { args = body ? JSON.parse(body) : {}; } catch { return json(res, 400, { error: 'body 不是合法 JSON' }); }
        const r = await screenshotFlow({ ffmpegPath: ffmpeg.path, hide: args.hide !== false });
        if (!r.png) return json(res, 504, { error: '抓屏失败（gdigrab 无输出）' });
        if (r.delivered === 'unavailable') {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          return res.end(JSON.stringify({ ok: true, delivered: 'unavailable', png: r.png.toString('base64') }));
        }
        return json(res, 200, { ok: true, delivered: r.delivered, hidden: r.hidden });
      }
      if (req.method === 'POST' && p === '/snapshot') {
        // 0.3.0 全档可截图：pull 档走 peekSheet（**不消费帧**，不抢模型的图）；
        // 非拉取状态（关档 / 迁移前 config / 文件回放）走 flush 队列兜底（旧路径）。
        const stSnap = runner.status();
        if (stSnap.pull && stSnap.running) {
          let sheetB = null;
          for (let i = 0; !sheetB && i < 20; i++) {
            try { sheetB = runner.peekSheet?.(1, 0) ?? null; } catch { sheetB = null; }
            if (!sheetB) await new Promise((r2) => setTimeout(r2, 150));
          }
          if (!sheetB) return json(res, 504, { error: '缓冲还没攒出帧，稍等一两秒再截' });
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
          res.end(sheetB.png);
          return;
        }
        const wasRunning = Boolean(runner.status().running);
        if (!wasRunning) {
          // 关档临时拉起（0.5~1s 抓 1 帧，规格 §四"截图键"）；抓完立即停
          await runner.start({ src: { kind: 'screen' }, quality: 'standard', opts: { cutAbs: PACES.normal.cutAbs } });
        }
        // 等第一张图落进队列（管线首帧 'first'，通常 1~3 秒）
        let sheet = runner.peek();
        for (let i = 0; !sheet && i < 30; i++) {
          await new Promise((r2) => setTimeout(r2, 150));
          sheet = runner.peek();
        }
        if (!wasRunning) { try { runner.stop(); } catch { /* 已停 */ } }
        if (!sheet) {
          return json(res, 504, { error: wasRunning ? '静默档下一张还在攒，稍后再试' : '临时拉起采集没抓到帧' });
        }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        return res.end(Buffer.from(sheet.png));
      }
      return json(res, 404, { error: `未知路由 ${req.method} ${p}` });
    } catch (e) {
      log(`api ${req.method} ${p} 失败：${e?.stack ?? e}`);
      try { return json(res, 500, { error: String(e?.message ?? e) }); } catch { /* res 已坏 */ }
    }
  };

  const eventsHandler = (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', seq: modeSeq, mode: currentMode, at: Date.now() })}\n\n`);
    sseClients.add(res);
    const cleanup = () => {
      if (hb) clearInterval(hb);
      sseClients.delete(res);
    };
    // L-242：客户端断开时 res 会异步 emit 'error'（ECONNRESET/EPIPE）——无人监听=uncaughtException=崩宿主。
    // try/catch 只能抓同步 throw，抓不住事件；必须显式 on('error') 吞掉。
    const hb = setInterval(() => {
      if (res.destroyed || res.writableEnded) return cleanup();
      try { res.write(': hb\n\n'); } catch { cleanup(); }
    }, 15000);
    res.on('error', cleanup);
    res.on('close', cleanup);
    req.on('close', cleanup);
  };

  // webServer 必须走 inject（插件加载时服务未发布，ctx.get 拿到 undefined —— ofm :1404-1410 实证）
  try {
    ctx.inject(['webServer'], (scoped) => {
      scoped.effect(() => scoped.webServer.register({ kind: 'prefix', path: '/api/vision-toggle', handler: apiHandler }), 'vision-toggle: api routes');
      scoped.effect(() => scoped.webServer.register({ kind: 'exact', path: '/api/vision-toggle/events', handler: eventsHandler }), 'vision-toggle: sse');
    });
  } catch (e) {
    log(`webServer 注入失败（client 胶囊不可用，工具不受影响）：${e?.message ?? e}`);
  }
  disposers.push(() => {
    for (const res of sseClients) { try { res.end(); } catch { /* ignore */ } }
    sseClients.clear();
  });

  disposers.push(ctx.tools.register(defineTool(toolObj)));

  return () => { for (const d of disposers.reverse()) d?.(); };
}
