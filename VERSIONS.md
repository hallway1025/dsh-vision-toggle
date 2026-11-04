# VERSIONS.md — 版本台账（随包走 · 防记忆漂移）

> 本文件是版本唯一速查，随发布包分发。审查人/接手者只看这里即可对齐，不依赖任何外部会话记忆。
> 更新纪律：每次重打包前更新「现行」节；历史版本只追加不改写。

## 现行（对包即对真）

| 项 | 值 |
|---|---|
| 插件版本 | 0.6.0（package.json / dsh.plugin.json / ERRORS.md / CHANGELOG 四处一致） |
| 发布包 | dsh-vision-toggle-0.6.0.zip（正式发布名固定无哈希；内部代次包才带 git 短哈希） |
| 本版提交 | 063a12a（微信式直插）+ 版本件提交（见 git log 0.6.0 段） |
| 形式规格 | **v4.5 ultra 拉取化**（不在包内；`vision_modes_spec.md` 与源码同仓维护，位于 fork 所在仓库的 `memory/vision/` 目录） |
| 上游 | dsh-see-now 0.0.7（Apache-2.0，LICENSE/NOTICE 原样保留） |
| 档位 | 六档：off / low(门槛20) / high(门槛12) / max(门槛7) / ultra / custom；拉取档 wakeGapSec=∞ 零投递 |
| 默认档 | off（DEFAULT_MODE，进程重启必回 off） |
| 0.3.0 发布包 | 已被 0.6.0 取代，历史包在 fork/_archive/ |

## 版本声明分布（哪里有版本号，改版本改哪里）

1. package.json:3 `version`
2. dsh.plugin.json:4 `version`
3. ERRORS.md:1 标题 `（v0.6.0）`
4. CHANGELOG.md 段头（`## 0.6.0 —`）
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
| src/editor.js | **已删**（0.6.0） | BrowserWindow 前提架构性不成立（插件进程拿不到 electron API，/diag 实锤）；编辑层已移植 client.js 页面内 |
| 服务端投递路径（A 路 deliverViaElectron / D 路 deliverViaPowerShell+CLIP_PS） | **已删**（0.6.0） | D 路实测 SetImage 后进程退出剪贴板 EMPTY（OLE 延迟渲染）+ SendKeys 焦点不可控；投递统一 client 页面内合成 paste |

## 版本链（规格侧）

v4.0 旗舰审查融合 → v4.1 二轮 → v4.2 宽兼容三层 → v4.3 三轮收口 → v4.4 六档重定义（m08525 主人拍板 + R34-R38）→ **v4.5 ultra 拉取化（m09062 主人定位：ultra=参数拉满，0.4.0）**。历史版 archive 在 memory/vision/_archive/。
