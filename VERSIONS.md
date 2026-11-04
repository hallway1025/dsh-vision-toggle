# VERSIONS.md — 版本台账（随包走 · 防记忆漂移）

> 本文件是版本唯一速查，随发布包分发。审查人/接手者只看这里即可对齐，不依赖任何外部会话记忆。
> 更新纪律：每次重打包前更新「现行」节；历史版本只追加不改写。

## 现行（对包即对真）

| 项 | 值 |
|---|---|
| 插件版本 | 0.3.0（package.json / dsh.plugin.json / ERRORS.md / CHANGELOG 四处一致） |
| 发布包 | dsh-vision-toggle-0.3.0-六档版-<短哈希>.zip —— **包名带 git 短哈希，对哈希即对代次** |
| 本版提交 | 见包内 .git 无——用 zip 文件名里的短哈希对照 fork git log；本轮=fa8c3e1 之后的下一提交 |
| 形式规格 | **v4.4 六档重定义版**（不在包内；路径 memory/vision/vision_modes_spec.md，仓库 回音/memory/） |
| 上游 | dsh-see-now 0.0.7（Apache-2.0，LICENSE/NOTICE 原样保留） |
| 档位 | 六档：off / low(门槛20) / high(门槛12) / max(门槛7) / ultra / custom；拉取档 wakeGapSec=∞ 零投递 |
| 默认档 | off（DEFAULT_MODE，进程重启必回 off） |

## 版本声明分布（哪里有版本号，改版本改哪里）

1. package.json:3 `version`
2. dsh.plugin.json:4 `version`
3. ERRORS.md:1 标题 `（v0.3.0）`
4. CHANGELOG.md 段头（`## 0.3.0 —`）
5. src 注释里的版本行（runner.js:76 / index.js:195 / config.js:21 / dialog.js:6 / client.js:12）——历史语义注记，不随小版本改

## 审查轨迹（七轮收敛，第七轮=可发）

| 轮 | 对象 | 结果 |
|---|---|---|
| 一 | 规格 v3.9 | 修完再开工 |
| 二 | 规格 v4.0 | R1-R11，修 3 条再开工 |
| 三 | 规格 v4.2 | R12-R18，可开工 |
| 四 | 0.1.0 实物 | R19-R29 骨架 |
| 五 | 0.2.0 主动看版 | R30-R33 修 2 条可发 |
| 六 | 0.3.0 六档版 | R34-R38 文档面 |
| 七 | 0.3.0-fa8c3e1 | **无新发现，可发** |

## 上游遗留物处置（版本统一巡检 2026-11-04）

| 文件 | 处置 | 理由 |
|---|---|---|
| scripts/install-dev.mjs | **已改** PKG_NAME=dsh-vision-toggle | fork 遗留装错对象（会装/卸 see-now） |
| scripts/sync-window.mjs | **已删** | 拷贝目标 src/window.js 在 B3 丢弃清单里；跑了反而复活已删子系统 |
| scripts/mac-live-smoke.mjs | 保留原样 | 上游 mac 平台冒烟脚本，本机（Windows）不跑；见此说明即可 |
| src/timer.js `source:{kind:'see-now'}` | 保留 | 帧元数据内部标签，无消费方；改动无收益 |
| package.json repository/homepage/bugs | **已删** | 原指上游 SAOS-3624/dsh-see-now 仓库，错误暗示本包源在那 |

## 版本链（规格侧）

v4.0 旗舰审查融合 → v4.1 二轮 → v4.2 宽兼容三层 → v4.3 三轮收口 → **v4.4 六档重定义（m08525 主人拍板 + R34-R38）**。历史版 archive 在 memory/vision/_archive/。
