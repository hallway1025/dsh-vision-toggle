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
| ultra | 满幅 1600×900 采集 + 最高灵敏度（开启需确认，弹窗给 peek 单帧/每分钟 token 预估），零投递 | 拉取缓冲 |
| 自定义 | 清晰度（4 档）× 节奏（省静/日常/灵敏）自由组合的拉取档 | 拉取缓冲 |

通信面：`GET/POST /api/vision-toggle/{status,mode,snapshot,dialog,screenshot,diag}` + SSE `/events`（换档广播）。

## 截图键

微信式截图：点胶囊旁的截图键 → 服务端隐藏 DSH 窗口 → ffmpeg **ddagrab（GPU 桌面复制，gdigrab 连抓兜底）** 抓全屏**原生分辨率** → 恢复窗口 → 页面内编辑层弹出 → 标注后 ✓ 直接进聊天框（作为输入框图片附件），✗ 重截，Esc 取消。

- 框选：拖动框选（亮窗 + 四周暗化 + 实时尺寸标签），松手即进入标注；不拖直接标注=全屏。
- 标注工具：矩形框选 / 箭头 / 文字 / 马赛克（永远从原图取样，越涂不越乱）/ 6 色色板 / 线条粗细三档（2/4/8）/ 撤销重做（Ctrl+Z / Ctrl+Y）。
- 视图：滚轮缩放（鼠标锚点 25%~400%）·「适合」「1:1」· Space 或中键拖动平移；工具条贴图片下方（QQ 同款）。
- **投递是页面内合成的 paste 事件**：client 与聊天输入框同进程（与微信「截图组件与聊天框同进程直插」同构），不经剪贴板、不模拟按键、不依赖窗口焦点。
- 服务端只负责抓屏：POST `/screenshot` 返回 base64 PNG；抓屏失败 504。
- 截图不带鼠标指针（ddagrab draw_mouse=0）。
- 抓屏前可自动最小化 DSH 窗口（截图里没有本插件界面），完成后自动恢复。
错误码表见 [ERRORS.md](ERRORS.md)。

## 隐私（务必读）

- **画面只进本机会话上下文**：帧经 ffmpeg → 内存 → 拼图 → 模型，全程不出本机（识图模型跟随当前聊天模型，见规格 §九）。
- **帧默认不落盘**：拉取缓冲是纯内存（上限 48MB，进程退出即消失）；截图键只在页面内传 base64（编辑层/输入框附件），不写临时文件。
- **黑名单**（v1 接缝，`src/privacy.js`）：本地窗口标题匹配、中英双语初始词表、支持 `regex:` 前缀；**零留痕**（不写匹配记录）。v1 没有窗口标题数据源，接缝保留；**不做内容级 OCR 过滤**——黑名单管「开哪个源」，不管「画面里有什么」。
- 截屏会进模型上下文：看敏感页面（密码、私照）时切「关」档。

## 与 dsh-see-now 互斥

同屏只启用一个。两个插件的工具名/路由/槽位完全独立，但都会拉 ffmpeg 采集——同时开会双份开销。安装本插件后建议停用 `dsh-see-now`。

## 安装

前置：DSH 宿主 + Node ≥ 20（插件内建 ffmpeg 解析顺序见 `src/binaries.js`：环境变量 → `~/.dsh/tools/ffmpeg` → `~/.dsh/bin/ffmpeg` → PATH）。

1. 在 DSH 会话中调用插件管理：`install_bundle`，目标指向本 zip 或解包后的目录；
2. 安装后在「设置 → 插件」确认 `dsh-vision-toggle` 已启用，对话页输入区出现挡位胶囊即成功；
3. 卸载：设置 → 插件 → 移除；或直接删除 `~/.dsh/profiles/<profile>/node_modules/dsh-vision-toggle` 并重启宿主。
4. 与 `dsh-see-now` 互斥：同屏只启用一个（见上节）。

## 开发

```bash
node scripts/smoke.mjs          # stub harness 冒烟（不依赖宿主）
node scripts/build.mjs          # esbuild 双入口 → dist/{server,client}.js
node scripts/sim.mjs <video>    # 回放等价性（ kept 帧序列对比）
```

模块地图：`index.js`（组装+通信面）→ `runner.js`（采集生命周期+六档 MODES）→ `loop.js`（监护循环：只攒帧+心跳，**零投递**）→ `pipeline.js`（打分/拼图/编码）→ `buffer.js`（48MB 拉取缓冲）→ `capture.js`（ffmpeg 参数）→ `sentinel.js`（**v2 预留接口，当前未接线**：每 6 帧评 1 次的预筛接缝）→ `dialog.js`（成本确认弹窗文案）→ `screenshot.js`（截图键抓屏：gdigrab + 隐藏/恢复宿主窗，投递不在这里）→ `client.js`（对话页胶囊 + 截图编辑层 + 页面内合成 paste 投递）。

数据目录：`~/.dsh/vision-toggle/config.json`（原子写 + .bak；只存 mode/pace/quality/updatedAt）。
