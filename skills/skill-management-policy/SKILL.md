---
name: skill-management-policy
description: Hermes skill 管理纪律——分类、写权限、分区策略、建议通道。所有会话开工必读。
version: 1.1.0
author: muyu
license: MIT
metadata:
  hermes:
    tags: [skill, 管理, 纪律, policy]
    category: policy
---

# Hermes Skill 管理纪律

## 三类 Skill 区分

| 类别 | 目录特征 | 拥有者 | Hermes 侧写权限 | 备份策略 |
|---|---|---|---|---|
| **接线卡** | manifest.json 登记的 skill id 目录 | 项目仓库 | **只读**（装卡即覆盖） | 不需要（仓库即备份） |
| **开发端自用** | `*-development/` 前缀 | 暮雨本地开发工具 | **双向均可**（开发态本地 git 化） | 本地 git 防丢 |
| **Hermes 自产** | `skills/` 下其余 | Hermes 学习机制 | Hermes 写 | 需单独 git 化 |

## 接线卡纪律（硬闸）

1. **只读**：接线卡目录，Hermes 侧**不允许任何写入**
2. **改进走建议通道**：学习机制/agent 发现卡有误或可以改进时：
   - 在当前会话内产出建议（「第 X 行写了 Y，建议改成 Z」）
   - **不动 Hermes 侧文件**
   - 等暮雨审
3. **装卡覆盖不是事故**：仓库新版覆盖 Hermes 侧旧卡 = 部署动作本身
4. **建议回流路径**：agent 产出建议 → 暮雨审 → 过了 → agent 改仓库真源 + commit → 下次装卡自然带走

## 开发端自用纪律

1. `tegcun-development/`、`sitian-development/` 等是**开发态工具**，不跟产品一起发布
2. 本地 git 化防丢，但**不需要**接线卡的「只读」约束（开发态本来就要改）
3. 与接线卡目录**不混**——开发态和部署态物理隔离

## Hermes 自产纪律

1. 学习机制写的通用技能，真源在 Hermes 侧，与项目仓库无涉
2. 同样代表「token→资产」的成果，丢了是损失
3. 需定期 git 化防丢

## 分区物理约定

- 接线卡：`skills/` 下 manifest.json 中登记的 id 目录（如 `fangcun-hermes-bridge/`）
- 开发端自用：`skills/` 下 `*-development/` 前缀
- 其余：Hermes 自产技能

三类内容写权限不交叉，覆盖问题物理上不发生。

## 场景对表

| 场景 | 处置 |
|---|---|
| agent 用接线卡时发现卡错/可改进 | 不动文件，会话内产出建议，等暮雨审 |
| 建议被暮雨判"过" | agent 改仓库 + commit → 下次装卡带走 |
| 学习机制写自产技能 | 落在 `skills/` 下非接线卡区，git 化防丢 |
| 学习机制误写接线卡 | 接线卡是可焚毁区，重装即净，损失 = 零 |

## 纪律执行

- **开工读**：新会话涉及 skill 管理时，先加载本 skill
- **判定类别**：遇到具体 skill 时，按 manifest.json / 目录名前缀判定属于哪一类
- **接线卡误写**：立即停止，报告暮雨，从仓库重新装卡
