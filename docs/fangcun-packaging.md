# 方寸打包路径分析与方案

> 分析日期：2026-09-11
> 核心问题：如何打包为独立 exe，同时保证用户数据与源码分离？

---

## 一、当前架构的路径依赖

### 1.1 现有路径解析

```python
# tegula.py 第 8 行
ROOT = os.path.dirname(os.path.abspath(__file__))

# 所有路径从 ROOT 派生
TASK_DIR      = os.path.join(ROOT, "task-data")
REGISTRY_PATH = os.path.join(ROOT, "registry.yaml")
BACKUP_DIR    = os.path.join(ROOT, "backups")
```

**问题**：`__file__` 在 PyInstaller 打包后指向临时解压目录（`C:\Users\xxx\AppData\Local\Temp\_MEI123456\`），不是 exe 所在位置。

### 1.2 当前目录结构

```
fangcun/
├── tegula.py              ← 代码（118.8 KB）
├── templates/board.html   ← 代码（94.3 KB）
├── verify.py              ← 代码（39.6 KB）
├── AGENTS.md              ← 文档
├── registry.yaml          ← 用户数据（项目注册表）
├── task-data/             ← 用户数据（33 个任务文件）
├── backups/               ← 用户数据（备份 zip）
├── project-status.md      ← 运行期生成
└── .rules.json            ← 运行期生成
```

**问题**：代码和数据混在一起，打包时无法区分。

---

## 二、打包方案对比

### 方案 A：PyInstaller 单文件 + AppData 数据分离（推荐）

**用户体验**：
```
下载 方寸_v0.1.0.exe → 双击 → 自动创建 %APPDATA%\Fangcun\ → 启动浏览器
```

**目录结构**：
```
C:\Users\暮雨\AppData\Roaming\Fangcun\       ← 用户数据
├── task-data\                                  ← 任务文件
├── registry.yaml                               ← 项目注册表
├── backups\                                    ← 备份
├── project-status.md                           ← 运行期生成
├── .rules.json                                 ← 自动化规则
└── .status-cache.json                          ← 状态缓存

E:\Program Files\方寸\                          ← 程序文件（可选安装位置）
└── 方寸_v0.1.0.exe                             ← 单文件（~15 MB）
```

**优点**：
- 代码与数据完全分离
- 卸载干净（删除 exe 不影响用户数据）
- 符合 Windows 应用规范
- 支持多用户（每个用户有自己的 AppData）

**缺点**：
- 需要修改路径解析逻辑
- 首次启动需要初始化数据目录

---

### 方案 B：便携模式（当前 .bat 的打包版）

**用户体验**：
```
解压 方寸_v0.1.0_portable.zip → 任意文件夹 → 双击 方寸.exe → 启动浏览器
```

**目录结构**：
```
E:\Tools\方寸\
├── 方寸.exe              ← 程序
├── task-data\             ← 用户数据（与程序同目录）
├── registry.yaml          ← 用户数据
├── backups\               ← 用户数据
└── ...
```

**优点**：
- 零安装，解压即用
- U 盘可携带
- 路径改动最小

**缺点**：
- 数据与程序混在一起（删除程序会丢失数据）
- 不符合 Windows 应用规范

---

### 方案 C：pip 包分发

**用户体验**：
```
pip install tegula
tegula open
```

**优点**：
- Python 用户零学习成本
- `pip update` 更新

**缺点**：
- 用户必须装 Python
- 不是"开箱即用桌面应用"
- 排除此方案

---

## 三、推荐方案：PyInstaller + 双模式数据目录

### 3.1 设计思路

```
启动时检测：
  1. 命令行有 --data-dir → 用指定路径
  2. exe 同级有 task-data/ 或 registry.yaml → 便携模式（兼容当前行为）
  3. 否则 → AppData 模式（默认）
```

**好处**：
- 当前用户不受影响（便携模式兼容）
- 新安装用户获得规范体验（AppData 模式）
- 高级用户可指定数据目录

### 3.2 代码修改

```python
import sys, os

def _resolve_dirs():
    """解析代码目录和数据目录，支持 PyInstaller 打包。"""
    # ── 代码目录 ──
    if getattr(sys, 'frozen', False):
        # PyInstaller 打包后：exe 所在目录
        app_dir = os.path.dirname(sys.executable)
    else:
        # 源码运行：tegula.py 所在目录
        app_dir = os.path.dirname(os.path.abspath(__file__))

    # ── 数据目录 ──
    # 优先级：--data-dir 参数 > 便携检测 > AppData 默认
    data_dir = None
    if len(sys.argv) > 2 and sys.argv[1] == '--data-dir':
        data_dir = os.path.abspath(sys.argv[2])
    else:
        # 便携检测：exe/py 同级有 task-data 或 registry.yaml
        legacy_task = os.path.join(app_dir, "task-data")
        legacy_reg = os.path.join(app_dir, "registry.yaml")
        if os.path.isdir(legacy_task) or os.path.exists(legacy_reg):
            data_dir = app_dir
        else:
            # 默认：AppData
            appdata = os.environ.get("APPDATA", os.path.expanduser("~"))
            data_dir = os.path.join(appdata, "Fangcun")

    os.makedirs(data_dir, exist_ok=True)
    return app_dir, data_dir

APP_DIR, DATA_DIR = _resolve_dirs()
TASK_DIR      = os.path.join(DATA_DIR, "task-data")
REGISTRY_PATH = os.path.join(DATA_DIR, "registry.yaml")
BACKUP_DIR    = os.path.join(DATA_DIR, "backups")
```

### 3.3 模板嵌入

PyInstaller 打包时需要把 `templates/board.html` 嵌入 exe：

```bash
pyinstaller --onefile --console ^
    --add-data "templates;templates" ^
    --name "方寸" ^
    tegula.py
```

代码中模板路径：

```python
def _template_path(name):
    """获取模板路径，兼容 PyInstaller 打包。"""
    if getattr(sys, 'frozen', False):
        # PyInstaller 临时解压目录
        base = sys._MEIPASS
    else:
        base = APP_DIR
    return os.path.join(base, "templates", name)
```

### 3.4 首次启动初始化

```python
def _init_data_dir():
    """首次启动时创建默认数据文件。"""
    # 默认 registry.yaml（空项目列表）
    if not os.path.exists(REGISTRY_PATH):
        shutil.copy(os.path.join(APP_DIR, "templates", "registry-default.yaml"),
                     REGISTRY_PATH)
    # 默认 task-data/
    os.makedirs(TASK_DIR, exist_ok=True)
```

---

## 四、PyInstaller 打包实操

### 4.1 安装 PyInstaller

```bash
pip install pyinstaller
```

### 4.2 打包命令

```bash
# 单文件模式（推荐）
pyinstaller --onefile --console ^
    --add-data "templates;templates" ^
    --add-data "registry-default.yaml;." ^
    --name "方寸_v0.1.0" ^
    --icon=fangcun.ico ^
    tegula.py

# 单目录模式（调试用，启动更快）
pyinstaller --onedir --console ^
    --add-data "templates;templates" ^
    --name "方寸" ^
    tegula.py
```

### 4.3 输出

```
dist/
└── 方寸_v0.1.0.exe    ← ~15 MB（含 Python 解释器 + 代码 + 模板）
```

### 4.4 测试清单

- [ ] 双击 exe 启动，浏览器自动打开
- [ ] 任务创建/编辑/删除正常
- [ ] 项目注册表读写正常
- [ ] 备份/还原正常
- [ ] 数据文件生成在正确位置
- [ ] 卸载（删除 exe）不影响已有数据

---

## 五、用户数据与源码分离的完整策略

### 5.1 分类清单

| 类别 | 文件 | 打包时处理 |
|------|------|------------|
| **代码** | tegula.py | 嵌入 exe |
| **代码** | templates/board.html | 嵌入 exe |
| **代码** | templates/registry-default.yaml | 嵌入 exe（首次初始化用） |
| **用户数据** | task-data/ | 运行时创建在数据目录 |
| **用户数据** | registry.yaml | 运行时创建在数据目录 |
| **用户数据** | backups/ | 运行时创建在数据目录 |
| **运行期** | project-status.md | 运行时创建在数据目录 |
| **运行期** | .rules.json | 运行时创建在数据目录 |
| **运行期** | .status-cache.json | 运行时创建在数据目录 |

### 5.2 数据迁移（针对当前用户）

如果用户已经在用便携模式（数据在代码目录），启动时：

```python
def _migrate_check():
    """检测旧版便携数据，提示迁移。"""
    legacy_task = os.path.join(APP_DIR, "task-data")
    if os.path.isdir(legacy_task) and APP_DIR != DATA_DIR:
        print(f"[提示] 检测到旧版数据目录：{legacy_task}")
        print(f"      当前数据目录：{DATA_DIR}")
        print(f"      如需迁移，请将 {legacy_task} 复制到 {DATA_DIR}")
```

---

## 六、版本升级与数据兼容

### 6.1 升级流程

```
用户下载 方寸_v0.2.0.exe
    ↓ 替换旧 exe
    ↓ 启动
    ↓ 检测到数据目录已存在 → 直接使用
    ↓ 数据结构变化 → 自动迁移（如有）
```

### 6.2 数据版本标记

```yaml
# registry.yaml 顶部增加版本标记
version: 1
projects: [...]
```

```python
def _migrate_data():
    """数据结构版本迁移。"""
    reg = parse_registry(REGISTRY_PATH)
    ver = 0
    # 检测版本...
    if ver < 1:
        # 执行迁移
        pass
```

---

## 七、总结

| 维度 | 方案 A（AppData） | 方案 B（便携） | 推荐 |
|------|-------------------|----------------|------|
| 代码/数据分离 | ✓ 完全分离 | ✗ 混合 | A |
| 开箱即用 | ✓ 双击即用 | ✓ 双击即用 | 平手 |
| 多用户支持 | ✓ 每用户独立 | ✗ 共享 | A |
| 路径改动量 | 中 | 小 | B |
| 符合 Windows 规范 | ✓ | ✗ | A |
| 兼容当前用户 | ✓ 便携检测兼容 | ✓ 无需改动 | A |

**最终选择**：方案 A（AppInstaller + AppData），通过便携检测兼容当前用户。

**关键改动**：
1. `ROOT` → `APP_DIR` + `DATA_DIR` 双目录
2. PyInstaller 嵌入模板
3. 首次启动初始化默认数据
4. 便携检测（legacy 兼容）

---

*报告生成：Hermes Agent*
