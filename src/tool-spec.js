/**
 * tool-spec.js — `vision` 的契约（R19 更名：see_now → vision，防与原 see-now 插件撞名）。
 *
 * **注意 `parameters` 的形状**：它是「属性名 → 值 schema」的映射，不是完整的 JSON Schema。
 * 写成 `{ type:'object', properties:{...} }` 会被宿主拒绝：
 * `unsupported JSON schema: parameters.type must be a value schema object`。
 * （`output.schema` 反而是完整 JSON Schema —— 两个形状不一样，别抄错。）
 *
 * 参数**写成什么样，模型就会怎么用**。所以 description 里要把"什么时候调、等多久"说清楚，
 * 而不是罗列字段。
 */

/**
 * 这个工具**最长能被宿主挂多久**（毫秒）。
 *
 * 由宿主的 `dsh-tool-call-timeout-policy` 强制执行：到点不是"返回一张图"，
 * 而是整条调用变成 `tool call timed out after Nms`，并且 `exec.signal` 一起 abort。
 *
 * **必须明显大于 `seconds` 的默认值**：这里曾经写 120_000，而 `seconds` 默认 300 ——
 * 静止屏幕上第 120 秒必定超时（`index.js` 又把超时当"这一轮被取消"）。
 * 陪看那边是 900_000。
 */
export const TOOL_TIMEOUT_MS = 900_000;

/** `seconds` 的默认值：只是**上限**，攒够一张就提前返回。 */
export const DEFAULT_BLOCK_SEC = 300;

export function visionToolSpec() {
  return {
    name: 'vision',
    description:
      'Look at what is on the user\'s screen and get back one image made of several frames. '
      + 'Pull-mode: the capture runs in the background at the quality the user picked on the '
      + 'composer capsule (关/静默/动态/原画/自动); you only pull an image when you need one.\n\n'
      + 'How to use it:\n'
      + '- `vision({action:"peek"})` — take the sheet that already piled up, without waiting. '
      + 'This is the normal way: capture is usually already running, so peek returns immediately '
      + 'with recent frames. If it says nothing is ready yet, wait a moment and peek again.\n'
      + '- `vision({action:"watch"})` — blocking call: waits until a fresh sheet is ready '
      + '(15–40s when the screen is changing, longer when static) or the timeout hits. Use it for '
      + 'the FIRST look of a conversation, or when the user just asked "看看我屏幕".\n'
      + '- `vision({action:"status"})` — is capture running, which mode is active, and **bufferedNew**: '
      + 'how many frames entered the ring buffer since your last peek.\n'
      + '- `vision({action:"stop"})`.\n\n'
      + '**Active viewing, not push.** The guardian loop only keeps the capture alive and feeds frames '
      + 'into the buffer — it NEVER wakes you or injects messages. Frames keep piling up while you do '
      + 'other work (oldest are dropped past 48MB), so in any turn you can check status and, if '
      + 'bufferedNew > 0, peek to see what changed — including a few minutes back, since recent frames '
      + 'stay buffered.\n\n'
      + '**Mode belongs to the user.** The five-mode capsule sits at the composer (关/静默/动态/原画/自动); '
      + 'do not switch modes unless the user explicitly asks ("慢一点"→tell them to pick 静默 or use pace '
      + 'below; "截一张"→use snapshot from the capsule). You may still tune pace/quality per call.\n\n'
      + 'When you cannot read something (small text, filenames, a menu), do NOT guess: call again with '
      + '`quality:"high"` (or `"ultra"` for near-full-resolution) — changing quality returns ONE sharp '
      + 'frame of the current screen in about half a second.\n\n'
      + 'The image is returned as a tool result (not pushed into the chat), so just read it. '
      + 'Frames are numbered 1..n in time order; the text lists each frame\'s timestamp and pixel size. '
      + 'Do NOT poll faster than every ~10 seconds — nothing new arrives that fast, and each image costs tokens.',
    parameters: {
      action: {
        type: 'string',
        description: 'watch (default) | peek | start | stop | status',
      },
      source: {
        type: 'string',
        description: 'Where to capture from: "screen" (whole desktop, default), "obs" (OBS virtual camera), '
          + '"camera" (first webcam). Only matters on the first call of a session. '
          + 'Use "file" together with path to replay a local video instead of a live source (debugging).',
      },
      path: {
        type: 'string',
        description: 'With source:"file": absolute path of a video to replay.',
      },
      realtime: {
        type: 'boolean',
        description: 'With source:"file": replay at 1x speed instead of as fast as ffmpeg can decode.',
      },
      pace: {
        type: 'string',
        description: '"calm" | "normal"（默认）| "dense" —— 控制**多久算换一次画面、多久叫醒你一次**。\n'
          + '用户说**"太密了 / 回复太频繁 / 省点钱 / 慢一点 / 别老说话"**时，立刻传 `pace:"calm"`'
          + '（20 分以上才算换画面，最多 30 秒叫一次）。这是唯一能真的降低开销的旋钮 —— '
          + '口头答应"我少说点"不会改变出图频率。\n'
          + '用户抱怨**"漏了 / 不灵敏 / 太迟钝"**时传 `pace:"dense"`（7 分就算换，最多 8 秒一次，贵）。\n'
          + '粘性，一直生效到下次再改；改它要重开采集（约 0.5 秒）。不传就是保持当前档。',
      },
      scene: {
        type: 'boolean',
        description: '**逐帧 / 逐场景模式**，默认关。'
          + '打开后：每留下一个画面就单独给你一张**满幅**图（一张图 = 一个场景，不再拼格），'
          + '并且每换一次画面就叫你一次，你直接正常回复、说清那是什么。'
          + '`scene:true` 打开，`scene:false` 关掉；**它是粘性的**，一直生效到这轮看完，'
          + '不用每次 watch 都传。\n'
          + '**什么时候才该打开**：用户明确说要"每换一个场景就告诉我"、"每翻一页说一句这是什么"、'
          + '"逐帧播报"、"一个画面一张图"这类要求时。'
          + '**平时一律不要开** —— 每次唤醒 = 一张图 + 一轮模型往返，'
          + '画面每 2 秒换一次就是每分钟 30 次唤醒，很贵，而且用户会嫌你话太多。'
          + '用户没明确这么说，就别传这个参数。',
      },
      seconds: {
        type: 'integer',
        description: 'With action:"watch": the **upper bound** of the blocking wait, in seconds (default 300, '
          + 'capped at 860). You normally do not need to touch this: it returns early the moment a sheet '
          + 'fills up (every 15–40s when the screen is changing) or the user types in the floating window. '
          + 'The ceiling only matters when the screen is static — then you simply stay blocked instead of '
          + 'ending your turn, which is exactly right: the blocking call IS the pause.',
      },
      minFrames: {
        type: 'integer',
        description: 'With action:"watch": do not bother returning an image with fewer frames than this '
          + '(default 1). A 1-frame image costs the same as a 4-frame one, so raising this saves tokens '
          + 'when the screen is mostly static.',
      },
      quality: {
        type: 'string',
        description: 'How sharp the image is. "low" (default, 800×450, ≈218 tokens) — 4 frames are 400×225 each, '
          + 'enough for faces/scenes/video but small text is unreadable. '
          + '"standard" (1066×600, ≈388 tokens) — 533×300 per frame, medium text readable. '
          + '"high" (1280×720, ≈559 tokens) — 640×360 per frame, filenames readable. '
          + '"ultra" (1600×900, ≈872 tokens) — a single frame is nearly the real screen; use it only when '
          + '"high" is still not enough.\n'
          + 'Switch it UP as soon as you cannot read something — do not guess from a blurry image. '
          + 'Changing quality restarts the capture (~0.6s) and immediately returns ONE frame of the current '
          + 'screen, so you get the sharp view right away; the following calls stay at that quality.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          images: { type: 'array', items: { type: 'json' } },
          meta: { type: 'json' },
        },
      },
      render(args, value) {
        return [
          ...(value.images ?? []).map((attachment) => ({ type: 'image', attachment })),
          { type: 'text', text: value.text },
        ];
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe() {
      return false;   // 会话里只有一个采集进程，并发跑会把两张图交错
    },
  };
}
