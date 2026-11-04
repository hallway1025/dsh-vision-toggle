# Changelog

本文件从 `0.0.4` 起记录；更早的版本见 GitHub Releases。

## [0.0.7] - 2026-11-03

### Fixed — 心跳抖一下就被当成"用户关窗"，会话再也回不来

社区 1 例反馈"会话自己结束了"。链路是：窗口心跳 6 秒没更新（机器睡一觉醒来、
窗口主线程被拖住几秒）→ `windowAlive()` 判否 → 常驻循环**第一拍**就
`stop('window-closed')` → 落挂断说明（"用户关掉了窗……不要再调 see_now"）+ `hangUp()`
→ 之后 `watch` 一律被硬闸拦，这个会话只能重开。

根因是**一个判据回答了两个问题**：`windowAlive()` 的语义是"这窗还能不能用"
（过期就该重开），而循环要的是"用户是不是不看了"。现在分开：

- 新增 `windowPidAlive()`：只看进程在不在，不看心跳。
- 新增纯函数 `windowVerdict()`：进程没了才算 `closed`（照旧挂断）；
  进程还在、只是心跳断了算 `stalled`，连续 `WINDOW_GONE_TICKS`（3 拍 = 6 秒）才停，
  而且**不挂断** —— 下一条 `watch` 能自己把窗重开起来。
- 停因照旧能从 `see_now({action:"status"})` 的 `循环：已停（…）` 看到，
  现在多了 `window-stalled` 这个值，正好用来区分"用户关的"和"它自己卡了"。

回归：`test/heartbeat.test.mjs`。

## [0.0.6] - 2026-11-02

> 主题：**macOS 能用**（avfoundation 移植），外加 issue #1 / #2 / #3 一起收掉。
> macOS 与声音适配器那两块来自 **布丁** 的补丁（`macos-port.patch`，13 文件 / +735−35）。

### Added — `avfoundation` 屏幕/摄像头源

- 屏幕：`-f avfoundation -framerate 12 -pixel_format nv12 -capture_cursor 0 -i "Capture screen 0:none"`。
  音频写 `none`，否则某些系统会去开麦克风、多弹一次权限。
- 摄像头 / OBS 虚拟摄像头：同样走 avfoundation，`-i "<设备名或索引>:none"`。
- 局部裁剪：avfoundation 没有 gdigrab 的 `-video_size`，改在滤镜里 `crop`（坐标按采集分辨率算）。
- `pickScreenEngine()` 按平台分派：macOS 探 avfoundation、Windows 探 ddagrab、其它平台**明确报错**，
  不再假装能用。

### Added — 像素格式探针

屏幕输入**不支持** ffmpeg 默认的 `yuv420p`，每个进程都会刷一行 "not supported" 到 stderr
（真出错时被截断的 300 字里全是它）。现在探针按 CPU 从省到费试
`nv12` → `uyvy422` → `bgr0` → 设备默认，挑第一个真能出帧的并缓存。

### Added — `binaries.js`：自己找 ffmpeg

DSH 桌面版把 ffmpeg 放在 `~/.dsh/tools/ffmpeg/bin`，**不进 PATH**。原来写死裸 `'ffmpeg'`，
在 macOS 上就是 ENOENT，而且看起来像"插件坏了"。现在按
`DSH_FFMPEG_PATH` → `FFMPEG_PATH` → `DSH_FFMPEG_DIR` → `$DSH_HOME/tools/ffmpeg/bin` → `$DSH_HOME/bin` → PATH 找。

### Added — 屏幕录制权限提示

macOS 没给「屏幕录制」权限时 ffmpeg **不报错**：exit 0、帧数正常、画面全黑。
探针算平均像素，全黑就在 `start` 的返回里带一句去系统设置的提示。

### Fixed — 每次 `stop` 都往 `lastError` 里写一条假错误

`stop()` 是 SIGKILL，子进程 `code` 是 `null`。原来的判断 `err.trim() && code !== 0`
把"我们主动杀的"也算成失败 —— 只要 stderr 有过任何一行输出（macOS 上就有），
每次收工都会盖一条 `ffmpeg exit null`。现在 `code === null` 一律按正常收尾处理。

### Fixed — 测试改成了平台无关

原来的采集参数断言全是 Windows 引擎行为，在 Mac 上跑会走 avfoundation 分支。
现在显式传 `platform`，并补了 macOS 屏幕/摄像头/裁剪三条和"其它平台明确报错"一条。
#### Added — 声音适配器（macOS / `say`）

`examples/voice-say-mac.mjs`：把「该念了」翻译成一次 `say`，音色语速读 `~/.dsh/tts.json`
（和 `dsh-watch-together` 共用）。核心仍然不内置引擎，只认 `~/.dsh/voice.json` 里的
`adapter` 路径。

三条实现上的决定：**不排队**（正在念时新句子直接 `skipped` —— 等它念完，画面早就过去了）、
**`spoken` 在进程起来那一刻发**（展示层"字跟着声音走"）、**detach 要杀进程**
（关窗时正在念的那句必须立刻停）。

#### Added — `ensureConfiguredVoice()`：每次调用前检查一次

原来只在插件启动时读一次 `~/.dsh/voice.json`，于是「配置文件是插件启动之后才写的」这种情况
必须重启整个 DSH。现在工具入口每次都过一遍：

- 没配 → 什么都不做；
- 配了指纹没变 → 一次读文件的代价就返回；
- 指纹变了（换了适配器，或改了 `tts.json` 内容）→ 卸载重挂。

指纹用 `tts.json` 的**内容摘要**而不是 mtime：mtime 只到毫秒，同一毫秒内两次等长写入会被判成
"没变"—— 写这个的单测里当场踩到，改成 sha256 前 16 位。代价是这个几十字节的文件每轮读一次。


### Fixed — 持续陪看链路（#1）

- **`peek` 不再丢弃已拼好的图**：它原来走 `flushNow()`（插话专用），会把 `sheets` 清空、
  再把"此刻那一帧"塞成一张新图 —— 后台喊"有新画面了"、模型调 peek，拿到的是当场截的一张，
  攒好的多帧摘要反而没了（复现：`queued [0,2,4]` → `[5.92]`、`pending 0`）。现在走 `take()`，
  取一张少一张；队列空就返回 `null`，不再凭空造图。
- **循环 owner 在 watch 开始前锁定**：`watch` 阻塞 15~40 秒，期间任何会话的 `session/event`
  都会改写 `lastSessionId`；循环是等它返回才建的，现取就会绑到"等待期间最后说话的那个会话"
  （复现：A 发起 watch，结束后 `loop.session === B`）。
- **`minFrames` 在正常返回路径也生效**：以前只有超时分支检查，队列先到的路会交一张 1 帧的图
  还报 `ok: true`。现在不够就丢掉接着等。顺带理清"逐帧模式 × minFrames"：逐帧一张图只有 1 帧，
  `minFrames > 1` 永远等不满，会让路并说明。

### Fixed — 悬浮窗可用性（#2）

- **关窗后能自己重开**：新增 `bin/see-window.mjs`（`npx dsh-see-window`，支持 `--status` /
  `--force` / `--close`）。原来只有模型调 `watch` 才能拉起来，点了 × 就只能重启 DSH。
- **高 DPI 下窗口不再变小**：进程声明了 per-monitor v2 DPI 感知，Tk 坐标因此全是物理像素 ——
  150% 屏上摆 760×560 观感只有 506×373。现在默认尺寸按 `GetDpiForSystem()/96` 放大，
  字号同步走 `tk scaling`。用户已有的 `geometry` 配置仍然优先，不会被强行改大。
- **spawn 失败不再"假成功"**：窗口每秒写一个心跳文件，`windowAlive()` 除了 pid 还会看它 ——
  pid 被复用、进程活着但界面卡死、或是一张全透明的空窗，都会判死，于是下次能重开。
  `--force` 现在真的会先收掉旧进程（原来会叠两个窗）。没有心跳文件的旧窗口不误杀。

### Changed — 安装方式规范化（#3）

README 的主路径改成 `dsh plugin --profile web add dsh-see-now`（DSH 自带的 profile 级 pnpm
包装器，装前预检 engines/peer、装后自动登记 `dsh.bundle`），`install-dev.mjs` 收进
"从源码装（改代码时用）"折叠块。

## [0.0.5] - 2026-11-02

`examples/floating-chat/window.py` 同步上游 `dsh-watch-together` **0.2.4**（生成产物，
`npm run sync:window` 自动更新）。0.0.4 带出去的那份窗口有两个问题，这个版本一起修掉：

### Fixed — 气泡里的字一直黑白闪

字色是按背景亮度选的（气泡透明，背后就是桌面/视频）。原来每 0.12 秒按
`p50 < 0.50` 硬切白/深两色，画面一动亮度就在阈值附近来回穿，字一秒能翻七八次。
现在改成**滞回**（白的暗到 0.38 才翻深、深的亮到 0.62 才翻白）+ **连续两次同向才切**，
同样 16 次抖动从翻 15 次降到 0 次。顶部细条同样处理。

### Changed — 玻璃合成与气泡布局（上游 PR #28）

- 小框（气泡/输入框）边缘改用 blur 1.45 的帧做 smoothstep 过渡，不再二值硬切。
- CPU 管线补齐外缘 R/B 色散与上一帧运动混合（原来只有 GPU 有）；移动帧跳过色散，
  拖动/滚动响应更快。
- 消息气泡改成按正文实测的自适应宽高，时间戳移到气泡上方不再占框内空间。
- 麦克风回到玻璃帧合成（`MIC_POS`），不再在 Canvas 上单独建图。

## [0.0.4] - 2026-11-02

> 主题两件：**协议换成 Apache-2.0**，以及**常驻循环学会自己收工**。

### License — 改成 Apache-2.0

- `PolyForm-Noncommercial-1.0.0` → **`Apache-2.0`**。个人、公司内部、闭源产品、SaaS、
  二次分发都不需要授权、不收费，保留 `LICENSE` 与 `NOTICE` 即可。
- **删掉 `CLA.md` 与 `COMMERCIAL.md`**：Apache-2.0 下不需要贡献者签 CLA，
  也没有"商业授权"这回事了。`package.json` 的 `files` 同步移除这两个文件。
- `NOTICE` 重写：标准 Apache 声明 + 保留原来那份"这个项目**不做什么**"（不上传屏幕、
  不连续录制、不内置采集驱动、不内置 TTS 引擎）。
- `README` 的「授权说明」与「协议」两节、`CONTRIBUTING.md` 第一节、PR 模板里的 CLA 勾选项
  全部同步；`examples/floating-chat/` 不再需要"单独 Apache"的例外说明 —— 整个包同一个协议。
- README 挂上**赞赏码**（`docs/images/reward-qr.png`）：纯自愿，**不解锁任何功能**，
  也不影响以后的授权方式。

### Fixed — 常驻循环不再"卡读图循环"

社区实报：装上之后会话会一轮一轮读图，用户什么都没问也不停。根因是常驻循环
**只有"采集停了"一个退出条件** —— 屏幕一直在动（放视频、刷网页）就会每 `wakeMinGapSec`
叫醒模型一次、模型看一眼图回一句、下一张再叫一次，永远不停，而且每次都是一轮模型调用。

- 新增 `shouldGoIdle()`，两条收工线互为兜底：
  - `IDLE_STOP_MS`（3 分钟）：**没开悬浮窗**且用户超过 3 分钟没说话 → 停。
    悬浮窗开着就不按这条判 —— 那是陪看场景，两小时的电影中途不说话是正常的。
  - `MAX_AUTONOMOUS_WAKES`（8 次）：连续自动唤醒都没人搭理 → 停，窗开着也算
    （防"窗开着但人走了"）。
  - 用户一说话，计数与时间戳都重置。
- 收工不是"突然哑掉"：会在窗口里留一行灰字（`（有一阵没人说话了，我先停一停；要看再说一声。）`），
  且不朗读。
- `test/idle.test.mjs` 三条用例钉住：上限到就停、没窗+久不说话就停、窗开着不按时间判。

### Changed — 悬浮窗同步到 `dsh-watch-together` 0.2.3

`examples/floating-chat/window.py` 是**生成产物**（`npm run sync:window` / `prepack` 自动同步），
这次带上游 0.2.3 的一整轮窗口修复：

- 气泡改成「时间头 + 两行正文」，88px 统一高度，超长按框高折行/截断，标点不落行首。
- 折叠不再重建整窗几何（原来会在 `rounded_mask` 抛 `y1 must be >= y0`）；折叠不跳回原位、
  折叠背景有圆角、配置存展开高度。
- 每 1.8 秒重新置顶一次，DSH 抢焦点后浮窗不再被压下去。
- 拖动/缩放越界钳位，抓屏前挡掉非正尺寸（`Region has zero or negative size` 每帧刷日志、
  背景永久花不了）。
- snapshot 模式不再被 `_tick` 重新打开 WDA；`window` 接口 hide/show 兼容只返回布尔的实现。
- 麦克风改 Canvas 矢量图标，不再往合成帧上贴第二层。

### Fixed — 版本号漂移

`dsh.plugin.json` 还写着 `0.0.2`，与 `package.json` 的 `0.0.3` 不一致。这次一起对齐到 `0.0.4`
（宿主按 `dsh.plugin.json` 认版本，漂着会让"装了新版但页面显示旧版"）。

## [0.0.3] - 2026-11-01

首个公开版本：让 AI 实时看见屏幕 —— 按画面变化量筛帧、拼成一张图推进会话。
