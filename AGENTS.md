# AGENTS.md — 方寸 (tegula)

本地多 agent 任务看板。在此仓库工作的 agent 均受以下约束。

## 派活与闭环

- ⚡派活：新终端拉 `hermes chat`，任务状态置「进行中」。
- done 回写闭环：任务完成必须回写看板，不留悬空状态。
- unknown 字段与正文小节原样透传，不擅自增删结构。

## 数据与并发

- `task-data/` = 使用数据，不入 git。
- mtime 乐观锁：写回前比对 mtime，冲突则重读后再改；frontmatter 更新用 `expected_update` 字段。
- `tegula backup` = 唯一兜底副本；`activity.log` = 派活审计日志。

## 回归基线

- `verify.py` = 数据层回归基线：凡改解析/渲染必跑。
