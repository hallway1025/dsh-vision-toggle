# Changelog

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
