# 方寸 (Tegula)

本项目**使用AI辅助开发**。

本地优先的多 Agent 任务调度台。管理多项目任务、启动本地应用、对接 LLM。

如果喜欢本项目，欢迎到[爱发电](https://afdian.com/a/muyu46548B?utm_source=copylink&utm_medium=link)支持我们！

## 项目结构

```
fangcun/
├── README.md            # 本文件
├── task-data/           # 共享任务数据（不入 git）
├── registry.yaml        # 项目注册表
│
├── cli/                 # Python CLI（Agent 集成 / Web 看板）
│   ├── tegula.py        #   主入口
│   ├── tegula/          #   核心模块
│   ├── tegula_llm.py    #   LLM 内核
│   └── tegula_planning.py #  规划模块
│
└── desktop/             # Electron 桌面版（主产品）
    ├── src/             #   源码（Vue 3 + TypeScript）
    ├── public/          #   静态资源
    ├── package.json     #   Node 依赖
    └── README.md        #   桌面版说明
```

## 快速开始

### 桌面版

推荐优先使用桌面版，以下命令仅供开发调试使用：

```bash
cd desktop
npm install
npm run dev            # 调试模式（热更新）
npm run electron:build # 打包 NSIS 安装包 → release/
```

### CLI（可选）

```bash
pip install -e .
tegula serve           # 启动 Web 看板
tegula list            # 列出任务
```

## 许可证

MIT © 2026 暮雨 (MUYU46548)
