# 方寸 (Tegula)

**本地优先的多 Agent 任务收口台。** 把任务、执行日志、项目方针对齐到同一个入口，
让「派活 → 执行 → 验收」这条链有明确的落点，不再散落在各个对话窗口里。

本项目**使用 AI 辅助开发**。

如果喜欢本项目，欢迎到[爱发电](https://afdian.com/a/muyu46548B?utm_source=copylink&utm_medium=link)支持我们！

## 下载安装

到 [Releases](https://github.com/MUYU46548/fangcun/releases) 下载最新版 `Fangcun-Setup.<版本>.exe`（NSIS 安装包，Windows x64），双击安装即可。同 appId 覆盖安装，无需先卸载。

安装包未做代码签名，Windows SmartScreen 可能提示"未知发布者"，选「仍要运行」即可。为了设备安全，请只从官方渠道下载并核对哈希值。

首次启动会引导选择数据目录：可以新建空白看板，也可以指向已有的 Python CLI 数据目录（`registry.yaml` + `task-data/`）。

> 安装版默认数据目录是 `%APPDATA%\fangcun-desktop`。如果你同时用本仓库的 Python CLI / dev 模式（数据在仓库根），请在 设置 → 数据与归档 → 修改目录 里指向仓库根，两边数据即可统一。

## 它解决什么

| 问题 | 方寸的做法 |
|---|---|
| 任务散落在会话里，换个窗口就忘了 | 任务只在**一处**登记；agent 通过 CLI / MCP 取活与回写 |
| 新会话从零开始，上次干到哪不知道 | **执行日志跨会话接力**：承接上一次的「下一步」与执行 Agent |
| 每个项目的要求靠口头交代 | **项目方针卡**（使命/目标/场景/边界），派活时随任务下发 |
| 装完就忘，看不出做过什么 | 看板 / 待办 / 日志 / 项目 / 阻塞 / 路线图 / 日历 / 归档 / 回收站 / 启动台 / 技能 / 服务，**12 个视图** |
| 删错就没了 | 删除进**回收站**可还原；归档按文件路径判定；备份包可校验、可还原 |

定位很明确：**任务收口 + 方针载体**。不追"全周期管理平台"，也不在应用内塞 LLM 智能层 ——
智能交给 agent，方寸负责把上下文收住、把状态说清。

## 功能一览

- **看板**：7 个状态列，拖拽切换；列视图 / 列表视图两种摆法；按状态 / 项目 / 优先级分组，终态列默认收起
- **待办**：清单 / 卡片网格两种摆法；设了到期日会出现在日历上
- **执行日志**：跨会话接力、归档分区、批量归档与删除、按项目 / 执行 Agent 筛选、一键复制成提示词
- **项目**：健康度总览（活跃 / 停滞 / 休眠 / 空闲）+ 每个项目的**方针卡**
- **阻塞 / 路线图 / 日历**：依赖链追踪、跨天时间段、四处指派入口
- **归档 / 回收站**：归档以**文件路径**为唯一判定标准；删除先进回收站，可还原、可彻底删除
- **启动台**：登记并一键启动本地应用；**服务与端口只读监控 + 冲突预警**（刻意不提供"杀进程"能力）
- **技能安装专区**：把方寸的接线卡装给任意 agent —— Hermes / DSH 可**直装并自动跟随版本更新**；
  WorkBuddy 这类落点不可知的，给真源文件 + 真源指纹，由你手动导入或让它自装
- **MCP 接入材料**：按各家官方格式生成配置段（Claude Code / Cursor / Codex / OpenCode / Hermes / DSH / WorkBuddy），
  并支持生成「自装指令」让对面的 agent 自己动手 —— 方寸**不写任何外部应用的文件**
- **备份与恢复**：一键打包（zip + `.sha256` + manifest + 说明 + 恢复脚本）、校验、WebDAV 定时备份；
  **密钥永不入包**，恢复前必做 sha256 + 结构双校验
- **通知中心 / 多主题 / 应用日志**：提醒不漏、六套浅色主题（全部过 WCAG AA）、出错有日志可查

## 项目结构

```
fangcun/                     # 单一 monorepo
├── desktop/                 # Electron 桌面版（主产品）
│   ├── src/
│   │   ├── index.ts         #     主进程真入口 → dist/index.js
│   │   ├── main/            #     数据层 / MCP / 启动台 / 服务 / 备份 / 技能安装
│   │   ├── renderer/        #     Vue 3 看板 UI + 纯逻辑模块（calendar / timefmt / logdedupe）
│   │   └── preload/         #     IPC 桥接
│   └── package.json         #     Node 依赖 + electron-builder（NSIS）
│
├── skills/                  # 方寸自带的 agent 技能（随包分发）+ manifest.json
├── tegula.py                # Python CLI 薄入口（agent 集成 / Web 看板）
├── tegula/                  #   核心模块（core / cli / web）
├── templates/               #   Web 看板模板
│
├── scripts/test/            # 回归与守卫（27 套 e2e + 5 个守卫 + verify.py）
├── docs/                    # 架构图 / 发布说明 / 备份说明
├── registry.yaml            # 项目注册表（改这里即加项目，无需改代码）
└── task-data/               # 任务数据（Markdown + YAML frontmatter，不入 git）
```

## 快速开始

### 桌面版（推荐）

```bash
cd desktop
npm install
npm run dev            # 热更新调试
npm run build          # 构建
npm run electron:build # 打包 NSIS 安装包 → release/
```

> 开发调试注意：改主进程 / preload 后必须重启 Electron（渲染层热更、主进程只在启动时读一次）。
> `npm run dev` 的 `dev:electron` 已带 dist 监听自动重启。

### CLI（可选）

```bash
python tegula.py serve   # 启动 Web 看板（默认 127.0.0.1:8753）
python tegula.py next    # agent 取活（带出项目方针卡）
python tegula.py list    # 列出任务
```

零外部依赖，纯 Python 标准库。

## 数据与隐私

- 所有数据存储在**用户本地目录**（Markdown 文件即数据，可被 git / 网盘直接管理）
- 不向任何服务器发送数据
- 备份包默认不含任何密钥（API Key / 密码走系统加密存储，只回传"是否已设置"）
- 自动更新检查会访问 GitHub Releases（可在设置里手动触发）

## 开发者

| 层 | 命令 | 作用 |
|---|---|---|
| 数据层 | `python verify.py` | 解析 / 渲染 / 乐观锁 / 备份 / 老 YAML 写法（242 项） |
| 主进程 e2e | `node scripts/test/e2e-*.cjs` | 备份、字段、通知、数据根、日志、启动台、技能、回收站、MCP 契约… |
| 渲染层 DOM | `node scripts/test/e2e-renderer-web.cjs` | 无头浏览器跑真实构建产物（多视图、设置页、技能页…） |
| 静态守卫 | `node scripts/test/check-*.cjs` | 僵尸按钮 / 未声明标识符 / 按钮样式 / 主题对比度 / 技能版本漂移 |

改完必跑：`verify.py` + 相关 e2e + 四个 `check-*` 守卫。

## 许可证

[MIT](LICENSE) © 2026 暮雨 (MUYU46548)
