# Changelog

## 0.8.0 — 实时读取（正交开关，2026-11-05）

- 自定义子面板新增「读取速度」二选一（默认/实时），**正交开关**：任何挡位组合实时生效，清晰度仍跟挡位走（主人 m11030/m10990）。
- 实时参数：30fps 采集 + cutAbs 2（比 dense 7 更灵敏，小操作也留帧）+ 512MB 缓冲（~34s@30fps）+ 鼠标追踪（黑块光标，不遮挡画面）。
- watch 出图判**新帧**：实时档用 countSince(lastPeekedT)（主人一操作、帧一进缓冲、下一拍即出图）；默认档仍判缓冲总数（立即出最近图）——修「半分钟才有反馈」主根因（watch 被调 120ms 内返回旧图）。
- watch 轮询 120ms→50ms（默认/实时档都受益）。
- /status、/mode、/diag 全链带 speed 回显与透传；config 白名单 speed: default|realtime。
- 实测口径：主人操作 → watch 出图 ≈0.1~0.2s；模型回应 2~3s（LLM 推理固有，插件侧已到物理极限）。
- 警告文案终版（满载口径 m11187/m11195）：ultra 开档警告统一「满载 ≈26,160 token/分钟（每次观看 ≈872，不看不耗）」；实时项 desc「每次观看 ≈388，满载 ≈11,640/分钟」——观看频率由主人操作节奏决定，不承诺固定每分钟次数。

## 0.7.0 — 编辑器 QQ 化五项（2026-11-05）

- 工具状态 ref 化：tool/color/width 改 ref 直读（消灭闭包陈旧——「矩形切到箭头后切不回」一类问题从根上消失）；工具/粗细选中态改填充色高亮 + hover 反馈 + box-sizing 固定尺寸（修按钮选中时整排跳动）。
- 色板扩到 6 色（红/黄/绿/蓝/白/黑）+ 新增线条粗细三档（细 2 / 中 4 / 粗 8，此前硬编码 3px）；粗细点跟随当前颜色显示。
- 滚轮缩放：以鼠标位置为锚点 25%~400%（fit 态以当前实际显示比例为基准），工具条内「适合」「1:1」按钮 + 当前缩放百分比显示；Space 或中键拖动平移。
- 工具条从屏幕顶部改贴图片下方（QQ/微信同款），框选提示与「全屏」按钮同样贴图下方。
- 截图鼠标光标修复：ddagrab 加 draw_mouse=0（此前硬件光标层在 GPU 合成下画成大黑方块）；截图不带鼠标指针=微信同款行为。
- 文字工具字号随粗细档缩放；Esc 在文字输入框打开时只关输入框；输入框聚焦时编辑器热键（Space/Ctrl+Z）不再误触发。

**第八轮审查修复（R39/R40/R41）**

- 删 exports["./auto-mode"] 死引用（指向 0.3.0 已删的 src/autoMode.js）
- 删 scripts sync:window / check:window / prepack 三条（指向已删的 scripts/sync-window.mjs，prepack 会让 npm pack 炸）
- README 隐私节措辞修正：服务端临时文件「写后即删」非「不写」

## 0.6.3 — 拖选即确认 + ddagrab 黑斑根治（2026-11-05）

- 框选松手即进入标注（此前需再按 Enter）；无拖选直接标注=全屏。
- 抓屏引擎重写：ddagrab（GPU 桌面复制 + hwdownload）优先，gdigrab 连抓 5 帧取最后兜底——根治 gdigrab 抓 Electron/Chromium GPU 合成层的随机黑斑。
- 0.6.3 代码随 0.7.0 版本件一并发布（0.6.3 未单独出包）。

## 0.6.2 — 框选截图 + 交互流畅化（2026-11-05）

- 新增「先框选再标注」：截图先进入框选阶段，拖动框选范围（亮窗 + 四周暗化 + 实时尺寸标签），Enter 或「全屏」按钮=跳过框选直接全图标注；标注阶段新增「↺ 重新框选」。
- 绘制性能：底图与已定标注预渲染进离屏缓存层，拖动帧只做两次 drawImage（替代全画布逐帧重绘——此前 1920×1200 全图每帧重绘是拖动生涩的主因）。
- 重截后自动回到框选阶段；Esc 语义分层（框选有选区=清选区重拖，否则关闭）。

## 0.6.1 — 编辑层锁死修复（2026-11-05）

- 修复：编辑层由 document.body 命令式孤儿层改为 React 条件渲染组件（卸载即消失，物理无孤儿层）；内部异常不再锁死整个宿主 UI（m09567 事故）。
- 保底闸四件套：Esc（capture）+ 180s watchdog 硬关 + 点容器空白关闭 + 截图加载失败自动关。
- 画布自适应视口（replaced element max 约束）+ getBoundingClientRect 实测坐标映射，修正截图分辨率≠视口时的鼠标错位。

## 0.6.0 — 2026-11-04（微信式截图直插）

- 截图键全链路重构：服务端只管抓屏（gdigrab 原生分辨率 + 隐藏-恢复宿主窗），base64 PNG 回传 client；
- **投递在页面内完成**：client 构造 File 派发 paste 事件直接喂 Lexical 编辑器（宿主粘贴链原生接住 → 附件入库），与微信「截图组件与聊天框同进程直插」同构——不经剪贴板、不模拟按键、不依赖窗口焦点；
- 标注编辑器移到页面内：全屏 canvas 覆盖层（矩形框选 / 箭头 / 文字 / 马赛克（永远从原图取样）/ 三色 / 撤销重做 Ctrl+Z/Ctrl+Y / ✓ 确认贴图 / ✗ 重截 / Esc 取消）；
- 删 `src/editor.js`（BrowserWindow 版）：插件 server 是宿主 fork 的独立 Node 子进程，`import('electron')` 返回空对象（`/diag` 实锤），BrowserWindow 前提架构性不成立；
- 删服务端全部投递路径：A 路 Electron paste / D 路 PowerShell 剪贴板+SendKeys（实测：STA SetImage 后进程退出剪贴板变空、SendKeys 焦点不可控，两坑均复现）；
- `POST /screenshot` 响应统一 `{ok, delivered:'client-paste', png, hidden}`；504=抓屏失败；编辑层取消不再产生 cancelled 响应；
- 新增 `GET /diag` 诊断端点（pid/ppid/ptype/node/electron 探针）。

## 0.5.0 — 2026-11-04（截图基座）

- gdigrab 全屏原生分辨率抓屏；抓屏前 ShowWindow 最小化 DSH 窗口、完成后恢复（450ms 等合成器）；
- `POST /screenshot` 端点；client 截图键改调新端点。

## 0.4.0 — 六档全拉取（ultra 拉取化）

主人 m09062 定 ultra 定位为「参数拉满、不差钱用户的持续高精度观看」。推送形态与该定位矛盾
（投递要排队等模型回合结束，画面过时——正是 0.2.0 改造要杀的病），故 ultra 也改拉取：

- runner.js：ultra 档 quality=ultra + pace=dense（1600×900 采集 + cutAbs 7 最高灵敏度），
  pullMode:true / scene:false / wakeGapSec:Infinity；六档零投递，唤醒路径整体废除。
- index.js：applyMode 所有采集档统一起监护循环；/snapshot 非 pull 分支降级为兜底注释；
  ultra 开档确认保留（401），hint 改拉取语义。
- dialog.js：确认文案改「采集不消耗 token，peek 单帧 ≈872 tok，48MB 缓冲约存 11 帧」。
- scene:true 保留为模型侧临时逐帧参数（args.scene → SCENE_OPTS），不再与档位绑定。
- runner.js:435 非 pull 队列路径降级为兜底（文件回放 watch / 迁移前 config）。


## 0.3.0 — 2026-11-04（六档重定义）

挡位全换：off / low / high / max / ultra / 自定义（主人 m08539/m08564/m08582 拍板）：

- **旧档删除**：silent/dynamic/auto 不再存在；config 旧值静默迁移（silent→low、dynamic→high、auto→high）。
- **零投递口径**：low（门槛 20 大动作预筛）/ high（门槛 12 全进池）/ max（门槛 7 最灵敏持续感知）全部只进缓存池、不叫模型——模型回合自主 peek，聊天框零打扰。
- **ultra**：满幅逐帧保留；确认弹窗文案改「每分钟预估消耗」（2k～26k tok/分钟，有 model-info 时附上下文占比/分钟）。
- **自定义=独立挡位**：子面板两组参数（清晰度 4 档 × 节奏 3 档）自由组合，改动即生效。
- **截图键全档可用**：pull 档走 peekSheet（不消费帧，不抢模型的图）；删除 409「常驻唤醒在跑」拒绝闸（S3 后 peek 不取走，闸已失据）。
- **删 autoPilot / autoMode.js**（auto 档决策器成死代码）；修 applyMode 内 pace 撞名（SyntaxError）与 log 行 ${pace} 陈旧引用（运行时 ReferenceError）。
- **规格同步**：形式规格 v4.4（六档重定义版，memory/vision/vision_modes_spec.md）——拉取档零投递 wakeGapSec=∞、LEGACY 迁移、409 删除、ultra 每分钟口径、sentinel v2 预留。
- **版本统一 + 台账**：install-dev.mjs 改装本包（fork 遗留装错对象）、删 sync-window.mjs（目标 window.js 已丢弃）、package.json 删指向上游仓库的三字段；新增 VERSIONS.md 随包走（版本声明分布/审查轨迹/遗留物处置/命名规则）。
- **定档终审收口**：tool-spec.js 契约文本旧五档中文名→六档（T1，模型读得到）；loop/sentinel/index 注释 autoMode 引用改历史注（T2）；ERRORS.md 201/504 边界精确化；终审 T3（zip 混 .tmp）证伪——两包 zipfile 核验 43 entries 无 .tmp。
## 0.2.0 — 2026-11-04（主动看改造）

核心语义从「被动推送唤醒」改为「主动拉取观看」（Active viewing, not push）：

- **零投递**：loop 重写为纯采集监护（keep-alive + autoMode 心跳），不再向对话页投递唤醒——画面持续进缓冲，模型在自己回合里主动 peek。
- **缓冲回看**：buffer 环形缓冲（上限 48MB）+ `countSince(ts)` 新帧计数；想看几分钟前的画面也行。
- **API /status** 新字段 `pull / bufferedNew / buffered`：模型回合里查 bufferedNew 决定要不要看。
- 五档全部拉取化（静默/动态/自动/关档监护行为统一），原画档保留推送。
- 宿主破坏性适配：`vision({action:"status/peek"})` 语义更新（minor 版本口径，R16）。


## 0.1.0 — 2026-11-04

从 `dsh-see-now` 0.0.7 fork（Apache-2.0，LICENSE/NOTICE 保留）。

### 更名
- 工具名 `see_now` → `vision`（R19）；日志标签 `[dsh-see-now]` → `[vision-toggle]`（R27）。
- 插件 id / 包名 `dsh-vision-toggle`；与 `dsh-see-now` 互斥（同时只启用一个）。

### 架构（B3 丢弃清单）
- 删除：悬浮窗、聊天桥、语音（say）、插话机制 —— 交互面收敛到对话页（R19）。
- 常驻循环的退出条件重写：采集停 / 连续叫不醒 / 连续 8 次自动唤醒无用户搭理（防读图循环）。

### 拉取模式（R20）
- 新增 `src/buffer.js`：48MB 内存环形缓冲（纯内存，不落盘）。
- `silent/dynamic/auto` 档切拉取模式：帧进缓冲，模型 `vision({action:"peek"})` 按需取拼图。
- `ultra` 档保留推送（满幅单帧即时投递）。

### 自动挡（R24）
- 新增 `src/autoMode.js`：纯代码档位升降决策器（静止 5 分钟降费档、15 分钟建议关闭）。
- 新增 `src/sentinel.js`：预筛接口（v1 默认关；决策分层——预筛只标 worthReading，档位升降归纯代码 O9）。

### 交付面
- 新增 `src/config.js`（`~/.dsh/vision-toggle/config.json` 原子写；重启回关档，只恢复节奏/清晰度微调）、
  `src/privacy.js`（本地黑名单、零留痕）、`src/model-info.js` + `src/dialog.js`（弹窗文案 token 动态化，R23）。
- 客户端胶囊：槽位 `conversation.input.model`（R22）、自定义确认弹窗（R23）、五档 + 截图键。
- 通信面：`GET/POST /api/vision-toggle/{status,mode,snapshot,dialog}` + SSE `/events`。
- 修复：SSE 客户端断连 uncaughtException（res.on('error') 双路 cleanup）。
- 新增 `scripts/build.mjs`（esbuild 双入口打包）与 `scripts/smoke.mjs`（stub harness 冒烟）。
- 新增 `ERRORS.md`（错误码表）、`test-dynamic-12s.mp4`（`scripts/testdata/`）。

### 隐私
- 画面只进本机会话上下文；帧默认不落盘；黑名单本地匹配零留痕（详见 README 隐私节）。


