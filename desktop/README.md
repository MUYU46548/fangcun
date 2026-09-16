# 方寸 (tegula)

本地优先的多 Agent 任务调度台 — Electron 桌面版。

![方寸](public/icon.ico)

## 特性

- **看板**: 7 列状态看板，彩色边线 + 拖拽切换状态
- **项目**: 项目健康度总览（活跃/停滞/休眠/空闲）
- **启动台**: 快速启动本地应用（司天/墨坊/明鉴/ROSA 等）
- **LLM 集成**: 支持多种 AI 提供商（OpenAI/DeepSeek 兼容），含成本审计
- **MCP 工具**: 通过 stdio 为外部 Agent 暴露任务操作接口
- **笔记**: 任务关联笔记
- **数据本地**: 所有数据存储在本地目录，不上传任何服务器

## 安装

1. 下载 `release/方寸 Setup 0.1.0.exe`
2. 运行安装包，按向导完成安装
3. 桌面快捷方式启动

## 开发

```bash
npm install
npm run dev    # 热更新调试模式
npm run build  # 构建
npm run electron:build  # 打包 NSIS 安装包
```

## 项目结构

```
src/
├── index.ts              # Electron 主进程入口
├── main/
│   ├── data/             # 数据层（任务/项目/注册表）
│   ├── llm/              # LLM 内核（config/chat/planning）
│   ├── mcp/              # MCP 工具（stdio + named pipe）
│   ├── launchpad/        # 启动台（应用配置 + 启动）
│   └── services/         # 服务管理
├── renderer/
│   └── App.vue           # Vue 3 看板 UI
└── preload/
    └── index.ts          # IPC 桥接
```

## 许可证

MIT License © 2026 暮雨 (MUYU46548)

## 隐私

- 所有数据存储在用户本地目录（`%APPDATA%\方寸\`）
- 不会向任何服务器发送数据
- LLM 调用直接发往用户配置的 API，不经过中间服务器
