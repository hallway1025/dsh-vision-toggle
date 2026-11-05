# VERSIONS.md — 版本台账（随包走 · 防记忆漂移）

> 本文件是版本唯一速查，随发布包分发。审查人/接手者只看这里即可对齐，不依赖任何外部会话记忆。
> 更新纪律：每次重打包前更新「现行」节；历史版本只追加不改写。

## 发布包台账（发布名固定 <pkg>-<ver>.zip，不带哈希）

| 发布名 | 打包自提交 | 日期 |
|---|---|---|
| dsh-vision-toggle-0.7.0.zip | 930edab | 2026-11-05 |
| dsh-vision-toggle-0.8.0.zip | bcff5eb（R42 修订打包自 d47cc2b） | 2026-11-05 |
| dsh-vision-toggle-0.8.1.zip | f3b6eea（0.8.1 发布物瘦身） | 2026-11-05 |

## 现行（对包即对真）

| 项 | 值 |
|---|---|
| 插件版本 | 0.8.1（package.json / dsh.plugin.json / ERRORS.md / CHANGELOG 四处一致） |
| 发布包 | dsh-vision-toggle-0.8.1.zip（正式发布名固定无哈希；内部代次包才带 git 短哈希） |
| 本版提交 | 0.8.0：8afe798 实时读取正交开关 + m11675/m11771 UI 收敛 → 0.8.1：f3b6eea 发布物瘦身（P1 testdata 出包 / P3 sentinel 出包+exports 删行 / P2 推送路径标注） |
| 形式规格 | **v4.6 实时读取正交开关**（不在包内；`vision_modes_spec.md` 与源码同仓维护，位于 fork 所在仓库的 `memory/vision/` 目录） |
| 上游 | dsh-see-now 0.0.7（Apache-2.0，LICENSE/NOTICE 原样保留） |
| 档位 | 主菜单五挡：off / low(门槛20) / high(门槛12) / max(门槛7) / ultra；底部「⚙ 读取速度」设置（默认/实时，正交开关）；拉取档 wakeGapSec=∞ 零投递（custom 挡后端定义保留兼容旧 config，UI 不可达） |
| 默认档 | off（DEFAULT_MODE，进程重启必回 off） |
| 0.8.0 发布包 | 已被 0.8.1 取代，历史包在 fork/_archive/ |

## 版本声明分布（哪里有版本号，改版本改哪里）

1. package.json:3 `version`
2. dsh.plugin.json:4 `version`
3. ERRORS.md:1 标题 `（v0.8.1）`
4. CHANGELOG.md 段头（`## 0.8.1 —`）
5. src 注释里的版本行（runner.js:76 / index.js:195 / config.js:21 / dialog.js:6 / client.js:12）——历史语义注记，不随小版本改

## 审查轨迹（七轮收敛 + 0.6.0 自查）

| 轮 | 对象 | 结果 |
|---|---|---|
| 一 | 规格 v3.9 | 修完再开工 |
| 二 | 规格 v4.0 | R1-R11，修 3 条再开工 |
| 三 | 规格 v4.2 | R12-R18，可开工 |
| 四 | 0.1.0 实物 | R19-R29 骨架 |
| 五 | 0.2.0 主动看版 | R30-R33 修 2 条可发 |
| 六 | 0.3.0 六档版 | R34-R38 文档面 |
| 七 | 0.3.0-fa8c3e1 | 无新发现，可发 |
| 终审 | 0.3.0-fa8c3e1（发布级逐行） | T1 契约文本/T2 autoMode 注释已修；T3 证伪（zip 实测 43 entries 无 .tmp，审查人测试区解包后跑 smoke 自造 stub 污染，git archive 不可能带 untracked）；代码行为级 0 bug，定档 |
| 0.6.0 自查 | 063a12a（微信式直插） | 实测驱动：D 路 paste-keys 报成功但剪贴板 EMPTY（OLE 进程退出丢失）→ 服务端投递全删；/diag 实锤 import('electron') 空对象 → editor.js BrowserWindow 版废，编辑层整体移植 client 页面内；16 断言+22 文件语法+smoke 全过 |
| 0.6.1 | b2dd58e | 编辑层锁死事故（m09567，body 孤儿层无销毁路径）→ React 条件渲染化+四道保底闸；主人验收通过 |
| 0.6.2 | 34454f3 | 主人反馈框选+流畅度 → crop 框选阶段+离屏缓存性能层（拖动帧 2 次 drawImage） |
| 0.6.3 | 81400ad | 主人反馈黑斑+多余 Enter → ddagrab 优先（GPU 桌面复制）+拖选松手即确认；1920×1200 实测零黑斑 |
| 0.7.0 | 见 git log 0.7.0 段 | 主人六条反馈（黑方块光标/缩放/生涩/切不回/颜色/先调研）→ 调研 Flameshot/QQ/Snipaste 后五项改造；工具 ref 化根治闭包陈旧 |
| 0.8.0 | 8afe798 + bcff5eb | 实时读取正交开关（主人 m10952 半分钟延迟反馈）；两次重启 API 级验证；m11675 子面板只留速度、m11771 自定义降级为设置项；闸门 0/0 |
| 十 | 0.8.0（bcff5eb 包） | R42：VERSIONS.md 失修（本文件停留 0.7.0）→ 已补 0.8.0 段；代码本体无硬伤，实时开关五处落点全对 |
| 十一 | 0.8.0-d47cc2b（回验+性能/体积专项） | R42 修复成立；P1 testdata 出包（-67%）/P3 sentinel 出包/P2 推送残留标注已做（0.8.1）；P4 编辑器拆 bundle 排 0.9.0 |
| 十二 | 0.8.1-a1d5fe7（算法专项） | P1/P2/P3 回验全采纳；热路径实测 scorer 0.9ms/s CPU 极省、算法零 bug、可发；A1 tiers 环形计数器/A3 hsv 池化记 v1.0 顺手做，A2/A4 仅记录不阻塞 |

## 上游遗留物处置（版本统一巡检 2026-11-04）

> 防复审踩坑：smoke.mjs 运行会在**当前目录**生成 .tmp/stub-dsh-tools.mjs（git 忽略、从不入包）。审查人解包后在其测试区跑 smoke 会自造此文件——那不是包内容，T3 类误报以此条为准。

**T3 证伪证据**：fa8c3e1 与 b1d4ffb 两包 zipfile 逐条目核验均 43 entries、无 .tmp（2026-11-04）。

| 文件 | 处置 | 理由 |
|---|---|---|
| scripts/install-dev.mjs | **已改** PKG_NAME=dsh-vision-toggle | fork 遗留装错对象（会装/卸 see-now） |
| scripts/sync-window.mjs | **已删** | 拷贝目标 src/window.js 在 B3 丢弃清单里；跑了反而复活已删子系统 |
| scripts/mac-live-smoke.mjs | 保留原样 | 上游 mac 平台冒烟脚本，本机（Windows）不跑；见此说明即可 |
| src/timer.js `source:{kind:'see-now'}` | 保留 | 帧元数据内部标签，无消费方；改动无收益 |
| package.json repository/homepage/bugs | **已删** | 原指上游 SAOS-3624/dsh-see-now 仓库，错误暗示本包源在那 |
| src/sentinel.js | **已移出发布物**（0.8.1，仓库保留） | v2 预留接口零调用；npm files 否定 + .gitattributes export-ignore + exports 删 ./sentinel 三处同步；v2 实装时一起加回 |
| src/editor.js | **已删**（0.6.0） | BrowserWindow 前提架构性不成立（插件进程拿不到 electron API，/diag 实锤）；编辑层已移植 client.js 页面内 |
| 服务端投递路径（A 路 deliverViaElectron / D 路 deliverViaPowerShell+CLIP_PS） | **已删**（0.6.0） | D 路实测 SetImage 后进程退出剪贴板 EMPTY（OLE 延迟渲染）+ SendKeys 焦点不可控；投递统一 client 页面内合成 paste |

## 版本链（规格侧）

v4.0 旗舰审查融合 → v4.1 二轮 → v4.2 宽兼容三层 → v4.3 三轮收口 → v4.4 六档重定义（m08525 主人拍板 + R34-R38）→ **v4.5 ultra 拉取化（m09062 主人定位：ultra=参数拉满，0.4.0）** → **v4.6 实时读取正交开关（0.8.0：speed 全局开关，REALTIME_OPTS fps30/cutAbs2/512MB/mouse，挡位定清晰度+基础节奏不动）**。历史版 archive 在 memory/vision/_archive/。
