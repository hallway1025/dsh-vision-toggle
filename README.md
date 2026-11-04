# dsh-vision-toggle

DSH 视觉插件（`dsh-see-now` 0.0.7 的 fork，Apache-2.0，LICENSE/NOTICE 保留）。

给会话一个 `vision` 工具：按画面变化量给帧打分，重要的帧拼成多格图；**拉取模式**下帧先进 48MB 内存环形缓冲，模型 `vision({action:"peek"})` 按需取图，不主动刷屏。

## 六档

| 档位 | 行为 | 帧去向 |
|---|---|---|
| off | 采集停止 | peek 报 102 |
| low | 常驻采集，大动作预筛（过线门槛 20），不唤醒 | 拉取缓冲 |
| high | 常驻采集（门槛 12），零投递 | 拉取缓冲 |
| max | 最灵敏（门槛 7），零打扰 | 拉取缓冲 |
| ultra | 满幅单帧即时投递（每次开启需确认，约 872 token/帧；弹窗按切换频率给每分钟 token 预估） | 推送 |
| 自定义 | 清晰度（4 档）× 节奏（省静/日常/灵敏）自由组合的拉取档 | 拉取缓冲 |

通信面：`GET/POST /api/vision-toggle/{status,mode,snapshot,dialog}` + SSE `/events`（换档广播）。
错误码表见 [ERRORS.md](ERRORS.md)。

## 隐私（务必读）

- **画面只进本机会话上下文**：帧经 ffmpeg → 内存 → 拼图 → 模型，全程不出本机（识图模型跟随当前聊天模型，见规格 §九）。
- **帧默认不落盘**：拉取缓冲是纯内存（上限 48MB，进程退出即消失）；截图键走 blob URL 预览，不写文件。
- **黑名单**（v1 接缝，`src/privacy.js`）：本地窗口标题匹配、中英双语初始词表、支持 `regex:` 前缀；**零留痕**（不写匹配记录）。v1 没有窗口标题数据源，接缝保留；**不做内容级 OCR 过滤**——黑名单管「开哪个源」，不管「画面里有什么」。
- 截屏会进模型上下文：看敏感页面（密码、私照）时切「关」档。

## 与 dsh-see-now 互斥

同屏只启用一个。两个插件的工具名/路由/槽位完全独立，但都会拉 ffmpeg 采集——同时开会双份开销。安装本插件后建议停用 `dsh-see-now`。

## 开发

```bash
node scripts/smoke.mjs          # stub harness 冒烟（不依赖宿主）
node scripts/build.mjs          # esbuild 双入口 → dist/{server,client}.js
node scripts/sim.mjs <video>    # 回放等价性（ kept 帧序列对比）
```

模块地图：`index.js`（组装+通信面）→ `runner.js`（采集生命周期+六档 MODES）→ `loop.js`（监护循环：只攒帧+心跳，**零投递**）→ `pipeline.js`（打分/拼图/编码）→ `buffer.js`（48MB 拉取缓冲）→ `capture.js`（ffmpeg 参数）→ `sentinel.js`（**v2 预留接口，当前未接线**：每 6 帧评 1 次的预筛接缝）→ `dialog.js`（成本确认弹窗文案）→ `client.js`（对话页胶囊）。

数据目录：`~/.dsh/vision-toggle/config.json`（原子写 + .bak；只存 mode/pace/quality/updatedAt）。
