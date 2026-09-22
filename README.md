# 方寸 (Tegula)

本地优先的多 Agent 任务调度台。管理多项目任务、启动本地应用、对接 LLM。

本项目**使用 AI 辅助开发**。

如果喜欢本项目，欢迎到[爱发电](https://afdian.com/a/muyu46548B?utm_source=copylink&utm_medium=link)支持我们！

## 下载安装

到 [Releases](https://github.com/MUYU46548/fangcun/releases) 下载最新版 `Fangcun-Setup.<版本>.exe`（NSIS 安装包，Windows x64），双击安装即可。同 appId 覆盖安装，无需先卸载。

首次启动会引导选择数据目录：可以新建空白看板，也可以指向已有的 Python CLI 数据目录（`registry.yaml` + `task-data/`）。

> 安装版默认数据目录是 `%APPDATA%\fangcun-desktop`。如果你同时用本仓库的 Python CLI / dev 模式（数据在仓库根），请在 设置 → 数据目录 → 修改目录 里指向仓库根，两边数据即可统一。

## 项目结构

```
fangcun/                     # 单一 monorepo
├── desktop/                 # Electron 桌面版（主产品）
│   ├── src/                 #   源码（Vue 3 + TypeScript）
│   │   ├── index.ts         #     Electron 主进程入口
│   │   ├── main/            #     数据层 / LLM 内核 / MCP / 启动台 / 服务
│   │   ├── renderer/        #     Vue 3 看板 UI
│   │   └── preload/         #     IPC 桥接
│   ├── public/              #   静态资源
│   └── package.json         #   Node 依赖 + electron-builder
│
├── tegula.py                # Python CLI 薄入口（Agent 集成 / Web 看板）
├── tegula/                  #   核心模块（core / cli / web）
├── tegula_llm.py            #   LLM 内核（零依赖，可选）
├── tegula_planning.py       #   规划模块（audit/decompose/review 等）
├── templates/               #   Web 看板模板
│
├── verify.py                # 数据层回归基线（改解析/渲染必跑）
├── registry.yaml            # 项目注册表
├── openspec/                # 规格驱动开发的变更提案（OpenSpec）
└── task-data/               # 共享任务数据（不入 git）
```

## 快速开始

### 桌面版（推荐）

```bash
cd desktop
npm install
npm run dev            # 热更新调试模式
npm run build          # 构建
npm run electron:build # 打包 NSIS 安装包 → release/
```

> 开发调试注意：改主进程 / preload 代码后必须重启 Electron（渲染层热更、主进程不热更）。`npm run dev` 的 `dev:electron` 已带 dist 监听自动重启。

### CLI（可选）

```bash
python tegula.py serve   # 启动 Web 看板
python tegula.py list    # 列出任务
```

## 特性

- **看板**: 7 列状态看板，彩色边线 + 拖拽切换状态
- **项目**: 项目健康度总览（活跃/停滞/休眠/空闲）
- **启动台**: 快速启动本地应用（司天/墨坊/明鉴/ROSA 等）
- **执行日志**: 会话上下文中转站，跨会话接力（`tegula log` / 桌面版日志视图）
- **LLM 集成**: 支持多种 AI 提供商（OpenAI/DeepSeek 兼容），含成本审计
- **MCP 工具**: 通过 stdio 为外部 Agent 暴露任务操作接口
- **数据本地**: 所有数据存储在本地目录，不上传任何服务器
- **自动更新**: 检查 GitHub Releases 新版本，下载后退出时自动安装

## 隐私

- 所有数据存储在用户本地目录
- 不会向任何服务器发送数据
- LLM 调用直接发往用户配置的 API，不经过中间服务器
- 自动更新检查会访问 GitHub Releases（可在设置中手动触发）

## 许可证

[MIT](LICENSE) © 2026 暮雨 (MUYU46548)
