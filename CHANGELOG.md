# Changelog

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
