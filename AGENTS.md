# AGENTS.md — 方寸 (tegula)

本地多 agent 任务看板。在此仓库工作的 agent 均受以下约束。

## 项目感知（硬规则）

涉及暮雨的项目（ROSA、司天、绒花墨坊、弈局残响、明鉴、滞针迟鸣、记忆圣所等）时：
1. 先 `read_file E:/CODE/CangKu/fangcun/project-status.md` 获取当前状态
2. 根据项目 id 在 `E:/CODE/CangKu/fangcun/registry.yaml` 中匹配 repo 路径
3. 不要凭记忆猜测项目状态——以文件为准

## 派活与闭环

- ⚡派活：新终端拉 `hermes chat`，任务状态置「进行中」。
- done 回写闭环：任务完成必须回写看板，不留悬空状态。
- unknown 字段与正文小节原样透传，不擅自增删结构。

## 数据与并发

- `task-data/` = 使用数据，不入 git。
- mtime 乐观锁：写回前比对 mtime，冲突则重读后再改；frontmatter 更新用 `expected_update` 字段。
- `tegula backup` = 唯一兜底副本；`activity.log` = 派活审计日志。

## 项目状态感知

`scan_project_status(p)` = 对 registry 中每个项目扫描 git 活动 + 任务关联，输出结构化状态。
- 感知层：git 近 7 天提交数、最后提交天数、未提交改动数、当前分支、进行中/待办/阻塞任务数
- 健康度：`active`（有提交或进行中）/ `stuck`（有阻塞）/ `dormant`（停滞 > 30 天）/ `idle`（有任务但不活跃）/ `unknown`
- `tegula status` = CLI 查看（text/json 格式）
- `tegula report` = 生成 `project-status.md`（覆盖式更新，供 Hermes 启动时读取）
- `tegula report --brief` = 简报模式（适合 cron 推送）

## 回归基线

- `verify.py` = 数据层回归基线：凡改解析/渲染必跑。
