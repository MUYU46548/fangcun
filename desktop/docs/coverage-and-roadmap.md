# 方寸桌面版 功能覆盖分析 & 开发计划

> 基于 2026-09-17 对 Python 版 `tegula.py` (~5500行) 和 Electron 桌面版 `src/` (~3500行) 的全面对比。

---

## 一、已迁移功能清单 ✅

### 任务核心 (12/14)
- [x] 任务 CRUD（加载/创建/编辑/删除/归档/还原）
- [x] 状态流转（7 态 + 拖拽切换）
- [x] 批量操作（编辑/归档）
- [x] 快速添加（#tag @user p0-p3 to:状态）
- [x] 自然语言查询（#tag @proj 状态 超时/卡住）
- [x] 复制任务
- [x] 项目健康度扫描（active/stuck/dormant/idle）
- [x] 项目进度条
- [x] 超时任务检测

### 规划与路线图 (6/6)
- [x] 规划系统（Plan: 目标/里程碑/决策点/风险）
- [x] 决策点决定
- [x] 路线图聚合（批次/阻塞/下一步）
- [x] 跨项目建议
- [x] 单项目建议
- [x] 里程碑推导

### 笔记模块 (8/12)
- [x] 笔记 CRUD（创建/读取/更新/删除）
- [x] 笔记任务关联
- [x] 笔记列表
- [x] 笔记 JSON 导出
- [x] 笔记 JSON 导入

### 导入导出 (7/8)
- [x] 任务 JSON 导出
- [x] 任务 JSON 导入
- [x] 笔记 JSON 导出 UI
- [x] 笔记 JSON 导入 UI
- [x] 备份（zip）
- [x] 恢复（含回滚）
- [x] 备份列表

### MCP 服务 (7/16)
- [x] JSON-RPC 2.0 服务
- [x] list_tasks / get_task
- [x] create_task / update_task / move_status / delete_task
- [x] list_projects / get_project_status / get_roadmap
- [x] find_blockers / scan_services / get_data_dir

### LLM 集成 (6/6)
- [x] 聊天调用（非流式 + 流式）
- [x] 项目审计 (audit)
- [x] 目标拆解 (decompose)
- [x] 决策支持 (decide-dp)
- [x] 季度复盘 (review)
- [x] 路线图生成 (roadmap-gen)

### UI/UX (10/10)
- [x] 看板视图（7 列 + 彩色边线 + 拖拽）
- [x] 项目视图（健康度 + 进度 + 建议）
- [x] 阻塞链视图
- [x] 规划视图
- [x] 笔记视图
- [x] 路线图视图
- [x] 归档视图
- [x] 启动台视图
- [x] 首次启动引导
- [x] 系统托盘

### 其他 (5/5)
- [x] js-yaml 解析
- [x] sha256 备份校验
- [x] marked + DOMPurify 渲染
- [x] electron-updater 自动更新框架
- [x] NSIS 打包配置

---

## 二、部分迁移功能 ⚠️ (需补完)

| 功能 | 当前状态 | 待补完 | 优先级 |
|------|---------|--------|:------:|
| **乐观锁冲突** | `expected_update` 字段存在 | 冲突检测 + UI 重试提示 | P1 |
| **笔记 attach/detach** | `Note.taskId` 字段 | 独立 API + UI 按钮 | P1 |
| **备份校验 UI** | sha256 sidecar 写入 | 恢复前 UI 显示校验状态 | P2 |
| **快速添加 due 语法** | 缺失 `due:MM-DD` 解析 | quickAdd 函数增加截止日 | P1 |
| **Doctor 健康检查** | 基础版 frontmatter 检查 | 阻塞链 + registry 一致性 | P2 |
| **周期任务 cron** | 空实现 | cronCheck + UI 触发器 | P2 |

---

## 三、未迁移功能 ❌ (需新建)

### P0 阻塞用户使用的缺失

| 功能 | Python 版位置 | 工作量 | 说明 |
|------|:---:|:---:|------|
| **待办模块** | `06_板块/待办/` | 大 | 独立的 TodoView，管理个人待办事项（与任务不同：轻量、快速、无项目归属） |
| **派活/Dispatch** | `dispatch_task()` | 中 | 生成任务书 + 拉起 Hermes agent + 超时检测 |
| **验收裁决** | `api_review()` | 中 | accept→完成 / reject→驳回 + 理由留痕 |
| **验收门控 MCP** | `gate_open/check/list/close` | 中 | 阶段门控工具 |
| **MCP 搜索工具** | `search_tasks` | 小 | 全文搜索接口 |
| **MCP 规划工具** | `plan_list/get/pending` | 小 | 规划查询接口 |

### P1 体验提升

| 功能 | 工作量 | 说明 |
|------|:------:|------|
| **笔记文件导入** (拖拽/选择 .md) | 中 | 按钮存在但无 IPC 实现 |
| **笔记内容导入** (直接粘贴) | 小 | |
| **视图历史栈** | 中 | 前进/后退导航 |
| **Agent 执行时间线** | 大 | `.agent-runs.jsonl` + 详情面板展示 |
| **通知系统增强** | 中 | 分类/跳转/优先级/规则设置 |
| **工作台/服务启停** | 中 | `cmd_workbench` 实现 |
| **项目注册表编辑** | 中 | `regSave` 空实现 |

### P2 锦上添花

| 功能 | 工作量 | 说明 |
|------|:------:|------|
| **远程仓库扫描** | 小 | `_scan_git_remote` 迁移 |
| **自动化规则引擎** | 大 | `.rules.json` + evaluate_rules |
| **Hermes 同步** | 小 | `cmd_hermes_sync` |
| **项目状态报告** | 小 | `cmd_report` |
| **路径白名单校验** | 小 | `validate_open_path` |
| **系统托盘增强** | 小 | 备份/更新菜单 |

---

## 四、开发路线图

### 第一批次 (P0 阻塞) — 2-3 天

```
1. 待办模块完整实现
   - 新建 src/main/services/todos.ts（Todo CRUD + index.json）
   - App.vue 新增 views 数组 {id:'todos', label:'待办'}
   - 新增 <main id="board" class="todos-view"> 模板
   - 顶栏 views 中加入待办按钮

2. 派活 Dispatch
   - 任务书生成 _build_prompt（从 tasks.ts 抽取）
   - 详情面板增加「⚡ 派活」按钮
   - 模态框展示任务书 + 回写命令

3. 验收裁决
   - 待验收卡片增加「✅ 通过 / ↩ 驳回」按钮
   - 驳回理由必填弹窗
   - 结果记录追加
```

### 第二批次 (P1 体验) — 2-3 天

```
4. MCP 工具补完（search_tasks, plan_*, gate_*）
5. 笔记文件导入 IPC
6. 视图历史栈
7. Agent 执行时间线
8. 通知增强（跳转任务、优先级、规则）
```

### 第三批次 (P2 稳定) — 1-2 天

```
9. 自动化规则引擎
10. Doctor 完整实现
11. 工作台服务启停
12. 项目注册表编辑
```

### 第四批次 (P3 抛光) — 持续

```
13. 远程仓库扫描
14. 项目状态报告
15. 系统托盘增强
16. 性能优化（扫描缓存）
17. 单元测试覆盖
```

---

## 五、技术债清单

| 债 | 现状 | 偿还方案 |
|---|------|---------|
| **零测试覆盖** | 仅 data/index.ts 有 9 个 node 测试 | 写 verify.ts，覆盖 parse/render/roundtrip |
| **IPC 错误处理** | 部分 handler 静默失败 | 统一 try/catch + 错误码返回 |
| **乐观锁 UI** | 冲突时直接 throw | 弹窗「数据已变更，刷新重试」 |
| **as any 滥用** | 多处 `as any` 绕过类型检查 | 逐步补全类型定义 |
| **Vue SFC 膨胀** | App.vue 2632 行 | 拆分为子组件（Card/Modal/Panel） |

---

## 六、验证清单 (每批次完成后执行)

- [ ] `npx tsc -p tsconfig.main.json --noEmit` 无错误
- [ ] `npx vite build` 通过
- [ ] `npm run dev` 开发模式热更新正常
- [ ] 数据层 node 测试全绿
- [ ] 核心流程手动验证（创建/编辑/归档/还原/导入/导出/备份/恢复）
- [ ] 笔记 CRUD + 关联任务
- [ ] 批量操作（勾选 → 设状态/归档）
- [ ] LLM 规划 5 命令各执行一次
