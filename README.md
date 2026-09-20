# 方寸 (Tegula)

本项目**使用AI辅助开发**。

本地优先的多 Agent 任务调度台。管理多项目任务、启动本地应用、对接 LLM。

如果喜欢本项目，欢迎到[爱发电](https://afdian.com/a/muyu46548B?utm_source=copylink&utm_medium=link)支持我们！

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
└── task-data/               # 共享任务数据（不入 git）
```

## 快速开始

### 桌面版（推荐）

下载 `release/` 下的最新 NSIS 安装包，运行后按向导完成安装，桌面快捷方式启动。

开发调试：

```bash
cd desktop
npm install
npm run dev            # 热更新调试模式
npm run build          # 构建
npm run electron:build # 打包 NSIS 安装包 → release/
```

### CLI（可选）

```bash
python tegula.py serve   # 启动 Web 看板
python tegula.py list    # 列出任务
```

## 特性

- **看板**: 7 列状态看板，彩色边线 + 拖拽切换状态
- **项目**: 项目健康度总览（活跃/停滞/休眠/空闲）
- **启动台**: 快速启动本地应用（司天/墨坊/明鉴/ROSA 等）
- **LLM 集成**: 支持多种 AI 提供商（OpenAI/DeepSeek 兼容），含成本审计
- **MCP 工具**: 通过 stdio 为外部 Agent 暴露任务操作接口
- **笔记**: 任务关联笔记
- **数据本地**: 所有数据存储在本地目录，不上传任何服务器

## 隐私

- 所有数据存储在用户本地目录
- 不会向任何服务器发送数据
- LLM 调用直接发往用户配置的 API，不经过中间服务器

## 许可证

MIT © 2026 暮雨 (MUYU46548)
