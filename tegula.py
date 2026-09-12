#!/usr/bin/env python3
# 方寸 (tegula) — 本地优先多 agent 任务地图
# 零依赖：仅用 Python 标准库。视图服务用 http.server + 轮询 + 编辑 API。
import argparse, os, re, json, shutil, datetime, subprocess, time, threading, urllib.request, zipfile, sys
from urllib.parse import parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ── 双目录分离：代码目录 vs 用户数据目录 ──
# 支持 PyInstaller 打包（sys.frozen）和便携模式（exe 同级有 registry.yaml）
if getattr(sys, "frozen", False):
    APP_DIR = os.path.dirname(sys.executable)      # PyInstaller → exe 所在目录
else:
    APP_DIR = os.path.dirname(os.path.abspath(__file__))  # 源码运行 → .py 所在目录

# 数据目录：便携检测 > AppData 默认
_legacy_reg = os.path.join(APP_DIR, "registry.yaml")
_legacy_task = os.path.join(APP_DIR, "task-data")
if os.path.exists(_legacy_reg) or os.path.isdir(_legacy_task):
    DATA_DIR = APP_DIR                              # 便携模式（兼容当前用户）
else:
    _appdata = os.environ.get("APPDATA", os.path.expanduser("~"))
    DATA_DIR = os.path.join(_appdata, "Fangcun")    # 规范模式（%APPDATA%\Fangcun）

os.makedirs(DATA_DIR, exist_ok=True)

# 兼容旧引用（内部代码统一用新名，但 ROOT 仍指向代码目录供模板加载）
ROOT = APP_DIR
TASK_DIR = os.path.join(DATA_DIR, "task-data")
REGISTRY_PATH = os.path.join(DATA_DIR, "registry.yaml")
REGISTRY_BAK = os.path.join(DATA_DIR, "registry.yaml.bak")
BACKUP_DIR = os.path.join(DATA_DIR, "backups")
BACKUP_KEEP = 10
ACTIVITY_LOG = os.path.join(TASK_DIR, ".activity.log")
STATUSES = ["草稿", "待审批", "待办", "进行中", "待验收", "完成", "驳回"]


# ── 首次启动初始化 ──
def _init_data_dir():
    """首次启动时创建默认数据文件。"""
    # 默认 registry.yaml
    if not os.path.exists(REGISTRY_PATH):
        default_src = os.path.join(APP_DIR, "registry-default.yaml")
        if not os.path.exists(default_src) and getattr(sys, "frozen", False):
            default_src = os.path.join(sys._MEIPASS, "registry-default.yaml")
        if os.path.exists(default_src):
            shutil.copy(default_src, REGISTRY_PATH)
        else:
            # 没有模板则写入空注册表
            with open(REGISTRY_PATH, "w", encoding="utf-8") as f:
                f.write("members: []\nprojects: []\nreleased: []\n")
    # 默认 task-data/
    os.makedirs(TASK_DIR, exist_ok=True)

_init_data_dir()
# pythonw（无控制台）拉起子进程时，Windows 会为每个子进程新建控制台窗口 → 黑窗风暴。
# 所有服务端/后台子进程必须带 creationflags=_NOWIN；仅交互式 CLI 拉起（dispatch --go）除外。
_NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)


# ---------- 注册表（让 registry.yaml 真正生效）----------
def _coerce(v):
    v = v.strip()
    if v.startswith("[") and v.endswith("]"):
        inner = v[1:-1].strip()
        return [x.strip().strip("'\"") for x in inner.split(",") if x.strip()] if inner else []
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    return v


def parse_registry(path, include_released=True):
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except Exception:
        return []
    projects = []
    cur = None
    in_section = None
    want = {"projects"}
    if include_released:
        want.add("released")
    i = 0
    n = len(lines)
    while i < n:
        raw = lines[i]
        line = raw.rstrip()
        if not line.strip():
            i += 1
            continue
        if not raw.startswith(" "):
            m = re.match(r"^([A-Za-z_]+):\s*$", line)
            in_section = m.group(1) if m and m.group(1) in want else None
            cur = None
            i += 1
            continue
        if in_section is None:
            i += 1
            continue
        if line.strip().startswith("- "):
            rest = line.strip()[2:].strip()
            cur = {"id": "", "name": "", "tasks": "", "repo": "", "tools": [], "sources": []}
            if in_section == "released":
                cur["_released"] = True
            projects.append(cur)
            kv = re.match(r"^([^:]+):\s*(.*)$", rest)
            if kv:
                cur[kv.group(1).strip()] = _coerce(kv.group(2))
            i += 1
            continue
        if cur is not None:
            kv = re.match(r"^([^:]+):\s*(.*)$", line.strip())
            if kv:
                key = kv.group(1).strip()
                val = kv.group(2).strip()
                # Special handling for services: nested list of dicts
                if key == "services" and val == "":
                    services = []
                    i += 1
                    current_svc = None
                    # 记录 services 键的缩进级别，只解析更深层的行
                    services_indent = len(raw) - len(raw.lstrip())
                    while i < n:
                        ln = lines[i]
                        ln_stripped = ln.rstrip()
                        if not ln_stripped.strip():
                            i += 1
                            continue
                        # 当前行缩进
                        ln_indent = len(ln) - len(ln.lstrip())
                        # 如果缩进 <= services 缩进，说明已离开 services 段
                        if ln_indent <= services_indent:
                            break
                        # 列表项开始：创建新服务字典
                        if ln_stripped.strip().startswith("- "):
                            svc_rest = ln_stripped.strip()[2:].strip()
                            current_svc = {}
                            svc_kv = re.match(r"^([^:]+):\s*(.*)$", svc_rest)
                            if svc_kv:
                                current_svc[svc_kv.group(1).strip()] = _coerce(svc_kv.group(2))
                            services.append(current_svc)
                        # 属性行：添加到当前服务字典
                        elif current_svc is not None:
                            svc_kv = re.match(r"^([^:]+):\s*(.*)$", ln_stripped.strip())
                            if svc_kv:
                                current_svc[svc_kv.group(1).strip()] = _coerce(svc_kv.group(2))
                        i += 1
                    cur["services"] = services
                    continue
                cur[key] = _coerce(val)
        i += 1
    return projects


def load_all_projects():
    """返回全部项目（含 released 段），供 status / report / workbench 使用。"""
    return parse_registry(REGISTRY_PATH, include_released=True)


# ---------- 工作台：统一管理所有项目的本地服务端口 ----------

def scan_services():
    """扫描所有项目声明的 services，返回 [{project, name, port, url, start_cmd, running}]"""
    reg = load_all_projects()
    services = []
    for p in reg:
        pid = p.get("id", "")
        pname = p.get("name", pid)
        for svc in p.get("services", []):
            # Handle both flat dict and nested structure from YAML parser
            if isinstance(svc, dict):
                # Direct dict: {name: ..., port: ..., ...}
                port = svc.get("port")
                url = svc.get("url", "")
                start_cmd = svc.get("start_cmd", "")
                stop_cmd = svc.get("stop_cmd", "")
                name = svc.get("name", "未命名服务")
            else:
                # Nested structure from parser - find the actual service dict
                # The parser may nest under the first key
                port = p.get("port")
                url = p.get("url", "")
                start_cmd = p.get("start_cmd", "")
                stop_cmd = p.get("stop_cmd", "")
                name = svc if isinstance(svc, str) else "未命名服务"
            # YAML 解析可能返回字符串，统一转整数
            try:
                port = int(port) if port is not None else None
            except (ValueError, TypeError):
                port = None
            if not url and port:
                url = f"http://127.0.0.1:{port}"
            services.append({
                "project": pname,
                "project_id": pid,
                "name": name,
                "port": port,
                "url": url,
                "start_cmd": start_cmd,
                "stop_cmd": stop_cmd,
                "repo": p.get("repo", ""),
                "running": False,
            })
    # 检测存活
    for s in services:
        if s["port"]:
            s["running"] = _port_in_use(s["port"])
    return services


def _port_in_use(port):
    """检测端口是否被占用"""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return False
        except OSError:
            return True


def start_service(port, cmd, cwd=None):
    """启动服务：后台执行 start_cmd。返回 (ok, msg)。"""
    if _port_in_use(port):
        return False, f"端口 {port} 已被占用"
    if not cmd:
        return False, f"未配置启动命令"
    try:
        import os
        if cwd and not os.path.isdir(cwd):
            cwd = None
        # 用 shell=False + CREATE_NO_WINDOW 避免 UnicodeDecodeError
        subprocess.Popen(
            cmd,
            shell=False,
            cwd=cwd,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        # 等待端口就绪（最多 10 秒）
        import time
        for _ in range(20):
            time.sleep(0.5)
            if _port_in_use(port):
                return True, f"服务已启动 (端口 {port})"
        return False, f"启动超时 (端口 {port} 未就绪)"
    except Exception as e:
        return False, f"启动失败: {e}"


def stop_service(port, cmd=""):
    """停止服务：优先用 stop_cmd，否则找占用端口的进程并 kill。返回 (ok, msg)。"""
    if cmd:
        try:
            subprocess.run(cmd, shell=True, capture_output=True, timeout=10,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            return True, f"服务已停止 (执行 stop_cmd)"
        except Exception as e:
            return False, f"执行 stop_cmd 失败: {e}"
    # 无 stop_cmd：尝试找占用端口的进程
    try:
        result = subprocess.run(
            ["netstat", "-ano"],
            capture_output=True, timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        # Windows 上 netstat 输出是 GBK 编码
        output = result.stdout.decode("gbk", errors="replace")
        pid = None
        for line in output.splitlines():
            if f":{port}" in line and "LISTENING" in line:
                pid = line.strip().split()[-1]
                break
        if pid:
            subprocess.run(
                ["taskkill", "/F", "/PID", pid],
                capture_output=True, timeout=10,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            return True, f"服务已停止 (PID {pid})"
        return False, f"端口 {port} 未被占用"
    except Exception as e:
        return False, f"停止失败: {e}"


def cmd_workbench(args):
    """工作台：查看所有服务状态 / 启停服务。
    
    用法：
      python tegula.py workbench          # 列出所有服务状态
      python tegula.py workbench --start 8765  # 启动端口 8765 的服务
      python tegula.py workbench --stop 8765   # 停止端口 8765 的服务
    """
    services = scan_services()
    if not services:
        print("暂无服务声明。在 registry.yaml 中添加 services 字段来声明服务。")
        return
    
    action = getattr(args, "action", "list")
    port = getattr(args, "port", None)
    
    if action == "list":
        print(f"\n{'='*60}")
        print(f"工作台 · 共 {len(services)} 个服务")
        print(f"{'='*60}")
        for s in [s for s in services if s["running"]] + [s for s in services if not s["running"]]:
            icon = "🟢" if s["running"] else "🔴"
            print(f"  {icon} {s['name']:<20} {s['project']:<12} :{s['port']}")
            if s["url"]:
                print(f"     {s['url']}")
        print()
    elif action == "start":
        target = next((s for s in services if s["port"] == port), None)
        if not target:
            print(f"未找到端口 {port} 对应的服务声明")
            return
        cwd = target.get("repo", "")
        cmd = target["start_cmd"]
        # 如果 cmd 是字符串且 shell=False，需要转成列表
        if isinstance(cmd, str):
            import shlex
            try:
                cmd = shlex.split(cmd)
            except ValueError:
                pass
        ok, msg = start_service(port, cmd, cwd=cwd if cwd and cwd != "." else None)
        print(f"{'✓' if ok else '✗'} {msg}")
    elif action == "stop":
        target = next((s for s in services if s["port"] == port), None)
        if not target:
            print(f"未找到端口 {port} 对应的服务声明")
            return
        ok, msg = stop_service(port, target["stop_cmd"])
        print(f"{'✓' if ok else '✗'} {msg}")


def load_members():
    """读取 members 段（纯字符串列表），零依赖。"""
    if not os.path.exists(REGISTRY_PATH):
        return []
    try:
        with open(REGISTRY_PATH, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except Exception:
        return []
    members = []
    in_members = False
    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            continue
        if not raw.startswith(" "):
            m = re.match(r"^([A-Za-z_]+):\s*$", line)
            in_members = bool(m and m.group(1) == "members")
            continue
        if not in_members:
            continue
        if line.strip().startswith("- "):
            members.append(line.strip()[2:].strip())
    return members


def save_registry_block(section, block_text):
    """纯文本块替换 registry.yaml 的某个顶层段（section: ...），保留其它注释。
    写前备份为 registry.yaml.bak。block_text 为段体（不含 'section:' 行）。"""
    try:
        with open(REGISTRY_PATH, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except Exception as e:
        return False, f"读取失败: {e}"
    if os.path.exists(REGISTRY_PATH):
        shutil.copy(REGISTRY_PATH, REGISTRY_BAK)
    out = []
    i = 0
    n = len(lines)
    replaced = False
    while i < n:
        raw = lines[i]
        stripped = raw.strip()
        # 命中顶层段标题
        m = re.match(r"^([A-Za-z_]+):\s*$", stripped)
        if m and m.group(1) == section and not raw.startswith(" "):
            out.append(raw)
            replaced = True
            i += 1
            # 跳过原段体（缩进行/列表项），直到下一个顶层键或文件结束
            while i < n and (lines[i].startswith(" ") or lines[i].strip().startswith("- ") or lines[i].strip() == ""):
                # 跳过空行直到遇到非缩进内容也算段外？保守：仅跳过缩进行与列表项
                if lines[i].strip() == "":
                    # 空行：看下一个顶层键则停止
                    if i + 1 < n and not lines[i + 1].startswith(" ") and not lines[i + 1].strip().startswith("- "):
                        break
                if not (lines[i].startswith(" ") or lines[i].strip().startswith("- ")):
                    break
                i += 1
            # 写入新段体
            for bl in block_text.splitlines():
                out.append(bl)
            # 段间补一个空行
            out.append("")
            continue
        out.append(raw)
        i += 1
    if not replaced:
        # 段不存在则追加到末尾
        if out and out[-1].strip():
            out.append("")
        out.append(f"{section}:")
        for bl in block_text.splitlines():
            out.append(bl)
    try:
        with open(REGISTRY_PATH, "w", encoding="utf-8") as f:
            f.write("\n".join(out).rstrip() + "\n")
        return True, ""
    except Exception as e:
        return False, f"写入失败: {e}"


# ---------- 解析 / 序列化 ----------
def _split_body(body):
    """把正文拆成受管的 方案/结果记录 与需原样保留的其余内容（P0-2）。
    返回 (plan_lines, result_text, extra_body_text)。"""
    matches = list(re.finditer(r"^##\s*(.+?)\s*$", body, re.M))
    plan, result, extra = [], "", []
    lead = body[:matches[0].start()] if matches else body   # 首个标题前的散文字样，也保留
    if lead.strip():
        extra.append(lead.strip("\n"))
    secs = []
    for i, m in enumerate(matches):
        name = m.group(1).strip()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        secs.append((name, body[m.end():end].strip("\n")))
    first_plan = first_result = True
    for name, c in secs:
        if name == "方案" and first_plan:
            plan = [ln.rstrip() for ln in c.splitlines() if ln.strip()]
            first_plan = False
        elif name == "结果记录" and first_result:
            result = c
            first_result = False
        else:
            extra.append(f"## {name}\n{c}")
    return plan, result.strip("\n"), ("\n\n".join(extra).rstrip() if extra else "")


def parse_task(path):
    """完整解析：frontmatter 标量 + 列表 + 资源子项 + 正文 方案/结果记录。无第三方依赖。"""
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except Exception:
        return None
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", text, re.S)
    if not m:
        return None
    fm_raw, body = m.group(1), m.group(2)
    d = {"_body": body, "_file": os.path.basename(path)}
    in_resource = False
    for line in fm_raw.splitlines():
        if not line.strip():
            continue
        if line.startswith(" "):
            kv = re.match(r"^\s+([^:]+):\s*(.*)$", line)
            if kv and in_resource:
                k = kv.group(1).strip()
                v = kv.group(2).strip()
                if v.startswith("[") and v.endswith("]"):
                    inner = v[1:-1].strip()
                    d.setdefault("资源", {})[k] = [x.strip().strip("'\"") for x in inner.split(",") if x.strip()] if inner else []
                else:
                    d.setdefault("资源", {})[k] = v.strip("'\"")
            continue
        kv = re.match(r"^([^:]+):\s*(.*)$", line)
        if not kv:
            continue
        k, v = kv.group(1).strip(), kv.group(2).strip()
        if k == "资源":
            in_resource = True
            continue
        in_resource = False
        if v.startswith("[") and v.endswith("]"):
            inner = v[1:-1].strip()
            d[k] = [x.strip().strip("'\"") for x in inner.split(",") if x.strip()] if inner else []
        else:
            d[k] = v.strip("'\"")
    plan, result, extra = _split_body(body)
    d["方案"] = plan
    d["结果记录"] = result
    d["_extra"] = extra          # 正文非受管内容原样保留（P0-2）
    d["_unknown"] = {            # frontmatter 未知标量/列表字段原样保留（P0-1）
        k: v for k, v in d.items()
        if k not in MANAGED_KEYS and not k.startswith("_")
    }
    return d


MANAGED_KEYS = {"id", "标题", "项目", "状态", "批次", "截止", "优先级", "创建", "更新", "来源", "指派", "验收", "阻塞", "附言", "资源", "方案", "结果记录", "派活时间", "标签"}


def render_task(d):
    proj = "[" + ", ".join(d.get("项目", [])) + "]"
    res = d.get("资源", {}) if isinstance(d.get("资源"), dict) else {}
    ziliao = res.get("资料", "")
    tools = "[" + ", ".join(res.get("工具", [])) + "]"
    plan = "\n".join(d.get("方案", [])) or "- [ ] "
    result = d.get("结果记录", "") or ""
    extra = d.get("_extra", "") or ""
    unknown = d.get("_unknown", {}) or {}
    lines = [
        "---",
        f"id: {d.get('id','')}",
        f"标题: {d.get('标题','')}",
        f"项目: {proj}",
        f"状态: {d.get('状态','草稿')}",
        f"批次: {d.get('批次','')}",
        f"截止: {d.get('截止','')}",
        f"优先级: {d.get('优先级','')}",
        f"创建: {d.get('创建','')}",
        f"更新: {d.get('更新','')}",
        f"来源: {d.get('来源','human')}",
        f"指派: {d.get('指派','hermes')}",
        f"验收: {d.get('验收','human')}",
    ]
    tg = d.get("标签") or []
    if tg:                                 # 标签受管：非空才渲染，空值不留残迹
        lines.append(f"标签: [{', '.join(str(x) for x in tg)}]")
    blk = d.get("阻塞") or []
    if blk:                               # 依赖受管：非空才渲染，空值不留残迹
        lines.append(f"阻塞: [{', '.join(str(x) for x in blk)}]")
    fy = str(d.get("附言") or "").strip()
    if fy:                                # 本次派单的精确指令；done 归档后清空，非空才渲染
        lines.append(f"附言: {fy}")
    pd = str(d.get("派活时间") or "").strip()
    if pd:
        lines.append(f"派活时间: {pd}")
    for k, v in unknown.items():          # 未知字段透传，键序稳定（P0-1）
        if isinstance(v, list):
            lines.append(f"{k}: [{', '.join(str(x) for x in v)}]")
        else:
            lines.append(f"{k}: {v}")
    lines += [
        "资源:",
        f"  资料: {ziliao}",
        f"  工具: {tools}",
        "---",
        f"## 方案\n{plan}",
        f"## 结果记录\n{result}",
    ]
    if extra:
        lines.append(extra)               # 非受管正文小节原样回插（P0-2）
    return "\n".join(lines) + "\n"


def write_task_file(path, d):
    """原子写：临时文件 + os.replace。"""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(render_task(d))
    os.replace(tmp, path)


def load_tasks(project=None, view="active"):
    if view == "archive":
        base = os.path.join(TASK_DIR, "archive")
    elif view == "trash":
        base = os.path.join(TASK_DIR, ".trash")
    else:
        base = TASK_DIR
    tasks = []
    if not os.path.isdir(base):
        return tasks
    for fn in sorted(os.listdir(base)):
        if not fn.endswith(".md") or fn.startswith("_"):
            continue
        full = os.path.join(base, fn)
        if os.path.isfile(full):
            d = parse_task(full)
            if d:
                if project and project not in (d.get("项目") or []):
                    continue
                # 最近更新时间：取自文件 mtime，不改 md 数据格式。
                try:
                    d["mtime"] = int(os.path.getmtime(full))
                except Exception:
                    d["mtime"] = 0
                # 乐观锁版本号：frontmatter 更新 优先，旧文件回退 mtime
                if not str(d.get("更新") or "").strip():
                    d["更新"] = str(d["mtime"])
                # 超时徽章（自动化规则 rule-2）：进行中超阈值未回写，下发实际小时数供卡片告警
                _th = timeout_badge_hours(d)
                if _th is not None:
                    try:
                        d["stale"] = int((time.time() - float(d.get("派活时间"))) / 3600)
                    except (TypeError, ValueError):
                        d["stale"] = int(_th)
                # 派单任务书随 payload 下发：GUI 确认弹窗展示真实指令（仅未终态任务）
                if str(d.get("状态") or "") not in ("完成", "驳回"):
                    try:
                        info_p, _errp = prepare_dispatch(d.get("id", ""))
                        d["prompt"] = (info_p or {}).get("prompt", "")
                    except Exception:
                        d["prompt"] = ""
                tasks.append(d)
    return tasks


def _all_task_dirs():
    return [TASK_DIR,
            os.path.join(TASK_DIR, "archive"),
            os.path.join(TASK_DIR, ".trash")]


# ---------- 依赖/阻塞（文件即数据：只扫文件，零新状态、零双向索引）----------
def locate_task(tid):
    """跨 活跃/归档/回收站 定位任务文件；找不到返回 None。"""
    for base in _all_task_dirs():
        fn = os.path.join(base, tid + ".md")
        if os.path.exists(fn):
            return fn
    return None


def blockers_of(tid):
    """谁阻塞了 tid：读 tid 的 阻塞 列表，过滤掉已终态（完成/驳回）或已归档的前置。
    返回 [{id, 状态, 标题}, ...]，空列表 = 无阻塞。"""
    fn = locate_task(tid)
    d = parse_task(fn) if fn else None
    if not d:
        return []
    out, seen = [], set()
    for dep in [str(x).strip() for x in (d.get("阻塞") or []) if str(x).strip()]:
        if dep in seen:
            continue
        dep_fn = locate_task(dep)
        dd = parse_task(dep_fn) if dep_fn else None
        if dd is None:
            continue
        if (dd.get("状态") in ("完成", "驳回")
                or os.path.dirname(dep_fn) in (os.path.join(TASK_DIR, "archive"),
                                               os.path.join(TASK_DIR, ".trash"))):
            continue
        seen.add(dep)
        out.append({"id": dep, "状态": dd.get("状态") or "?", "标题": (dd.get("标题") or "")[:40]})
    return out


TASKFN = re.compile(r"^task-\d{8}-\d{3}\.md$")   # task-data 根目录还住着简报/清单等非任务 md


def find_blockers(tid):
    """谁引用了 tid（下游）：跨 活跃/归档/回收站 扫描各任务的 阻塞 字段。
    用于 done 回写后的解锁提示。返回 [{id, 状态, 标题}, ...]。"""
    out = []
    for base in _all_task_dirs():
        if not os.path.isdir(base):
            continue
        for fn0 in sorted(os.listdir(base)):
            if not TASKFN.match(fn0) or fn0[:-3] == tid:
                continue
            dd = parse_task(os.path.join(base, fn0))
            if dd and tid in [str(x).strip() for x in (dd.get("阻塞") or [])]:
                out.append({"id": dd.get("id") or fn0[:-3], "状态": dd.get("状态") or "?",
                            "标题": (dd.get("标题") or "")[:40]})
    return out


def gen_id():
    """取当日最大序号 +1，且跨 活跃/归档/回收站 三个目录查重（防还原/复用后碰撞覆盖）。"""
    today = datetime.date.today().strftime("%Y%m%d")
    prefix = f"task-{today}-"
    n = 0
    pat = re.compile(r"^task-%s-(\d{3,})\.md$" % today)
    for base in _all_task_dirs():
        if not os.path.isdir(base):
            continue
        for fn in os.listdir(base):
            m = pat.match(fn)
            if m:
                n = max(n, int(m.group(1)))
    tid = f"{prefix}{n + 1:03d}"
    # 极端兜底：理论上不会触发，万一仍撞则跳号
    while any(os.path.exists(os.path.join(b, tid + ".md")) for b in _all_task_dirs()):
        n += 1
        tid = f"{prefix}{n + 1:03d}"
    return tid


# ---------- 编辑 API 后端 ----------
def _now_ts():
    """秒级 unix 时间戳（人类可读，用于 创建/更新 展示）。
    注意：秒级精度不足以做乐观锁版本——同一秒内两次写入会撞成同值，
    锁会形同虚设。版本号请用 _bump_version()。"""
    return str(int(time.time()))


def _bump_version(prev):
    """乐观锁版本号：单调递增的秒级时间戳。

    同秒内连续写入时 +1，保证「每次写入都产生新版本」。
    这是同秒并发下版本不撞车的唯一防线（历史缺陷：两次勾选落在同一秒，
    版本相同 → 第二次写入被误判为"版本匹配"而静默覆盖）。
    """
    try:
        p = int(str(prev or "").strip() or 0)
    except (TypeError, ValueError):
        p = 0
    now = int(time.time())
    return str(now if now > p else p + 1)


def _task_version(d, path=None):
    """任务版本号：frontmatter 更新 字段优先，为空回退文件 mtime。
    载入（tasks.json payload）与写前校验必须同源，否则会出现假冲突。"""
    v = ((d or {}).get("更新") or "").strip()
    if v:
        return v
    if path:
        try:
            return str(int(os.path.getmtime(path)))
        except Exception:
            pass
    return "0"


def _mtime_guard(fn, fields):
    """乐观锁：expected_update（版本字段，优先）或 expected_mtime（mtime 兑底）
    与当前不符则拒绝写入。返回 None=通过；字符串=拒绝原因。"""
    eu = fields.get("expected_update")
    if eu not in (None, ""):
        d_now = parse_task(fn)
        cur = _task_version(d_now, fn)
        if str(eu) != cur:
            return "update-conflict：任务已被其他方更新（版本不符），请刷新后重试"
        return None
    em = fields.get("expected_mtime")
    if em in (None, ""):
        return None
    try:
        cur = int(os.path.getmtime(fn))
    except Exception:
        cur = 0
    try:
        em = int(em)
    except (TypeError, ValueError):
        return "bad expected_mtime"
    if cur != em:
        return "mtime-conflict：文件已被其他方更新，请刷新后重试"
    return None


def api_edit(id, fields):
    fn = os.path.join(TASK_DIR, id + ".md")
    if not os.path.exists(fn):
        return False, "not found"
    guard = _mtime_guard(fn, fields)
    if guard:
        return False, guard
    d = parse_task(fn)
    if d is None:
        return False, "parse fail"
    for k in ["标题", "状态", "批次", "截止", "优先级", "阻塞", "附言", "来源", "指派", "验收"]:
        if k in fields and fields[k] is not None:
            d[k] = fields[k]
    if isinstance(fields.get("项目"), list):
        d["项目"] = fields["项目"]
    if isinstance(fields.get("标签"), list):
        d["标签"] = [str(x).strip() for x in fields["标签"] if str(x).strip()]
    if isinstance(fields.get("方案"), list):
        d["方案"] = fields["方案"]
    if "结果记录" in fields:
        d["结果记录"] = fields["结果记录"]
    res = d.get("资源", {}) if isinstance(d.get("资源"), dict) else {}
    if "资源资料" in fields:
        res["资料"] = fields["资源资料"]
    if isinstance(fields.get("资源工具"), list):
        res["工具"] = fields["资源工具"]
    d["资源"] = res
    # 时间戳：创建 只补缺，更新 每次写入都打（乐观锁版本源，同秒递增防撞车）
    if not str(d.get("创建") or "").strip():
        d["创建"] = _now_ts()
    d["更新"] = _bump_version(d.get("更新"))
    # 自动化规则（P2）：仅在方案被改动时评估「方案全完成 → 待验收」
    fired = []
    if isinstance(fields.get("方案"), list):
        fired = evaluate_rules(d, "field_change", {"id": id})
    write_task_file(fn, d)
    if fired:
        log_activity("rule", id, "、".join(fired))
    return True, ("ok|已触发规则：" + "、".join(fired)) if fired else "ok"


def api_review(id, verdict, reason=""):
    """验收裁决（看板验收按钮 / CLI 共用）：仅「待验收」任务可操作。
    accept → 完成；reject → 驳回，理由必填并追加进结果记录留痕（验收可追溯）。
    乐观锁同 api_edit：调用方带 expected_update / expected_mtime 则先校验。"""
    fn = os.path.join(TASK_DIR, id + ".md")
    if not os.path.exists(fn):
        return False, "not found"
    d = parse_task(fn)
    if d is None:
        return False, "parse fail"
    if d.get("状态") != "待验收":
        return False, f"当前状态为「{d.get('状态') or '未知'}」，仅「待验收」可验收"
    verdict = (verdict or "").strip()
    if verdict == "accept":
        d["状态"] = "完成"
    elif verdict == "reject":
        reason = (reason or "").strip()
        if not reason:
            return False, "驳回理由必填（写入结果记录，留痕可追溯）"
        d["状态"] = "驳回"
        prev = (d.get("结果记录") or "").strip()
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
        line = f"[{ts}] 验收驳回：{reason}"
        d["结果记录"] = (prev + "\n" + line).strip() if prev else line
    else:
        return False, "verdict 必须是 accept 或 reject"
    d["更新"] = _bump_version(d.get("更新"))
    write_task_file(fn, d)
    log_activity("验收" + ("通过" if verdict == "accept" else "驳回"), id,
                 reason if verdict == "reject" else "")
    return True, "ok"


def load_template():
    """读 _template.md 的 frontmatter 作为新任务底稿；不存在则返回空 dict。"""
    tp = os.path.join(TASK_DIR, "_template.md")
    d = parse_task(tp) if os.path.exists(tp) else None
    return d or {}


def api_new(fields):
    os.makedirs(TASK_DIR, exist_ok=True)
    tid = gen_id()
    tpl = load_template()
    tres = tpl.get("资源", {}) if isinstance(tpl.get("资源"), dict) else {}

    def val(key, fallback):
        """字段默认值链：调用方显式值 > _template.md 有效值 > 内置兜底。
        模板占位文字（全角括号开头，如『（执行后由执行方填写）』）不算有效值。
        空「状态」按内置默认走（调用方传 "" 是"没填"，不是"要空状态"）。"""
        v = fields.get(key)
        if v not in (None, "", []):
            return v
        if key == "状态":
            return fallback
        tv = tpl.get(key)
        if tv not in (None, "", []):
            if isinstance(tv, str) and tv.strip().startswith("（"):
                return fallback
            return tv
        return fallback

    d = {
        "id": tid,
        "标题": fields.get("标题") or "新任务",
        "项目": val("项目", ["fangcun-base"]),
        "状态": val("状态", "草稿"),
        "批次": val("批次", ""),
        "截止": val("截止", ""),
        "优先级": val("优先级", ""),
        "标签": val("标签", []),
        "阻塞": fields.get("阻塞") or [],
        "附言": fields.get("附言") or "",
        "来源": val("来源", "human"),
        "指派": val("指派", "hermes"),
        "验收": val("验收", "human"),
        "资源": {
            "资料": fields.get("资源资料") or (tres.get("资料") or ""),
            "工具": fields.get("资源工具") or [],
        },
        "方案": val("方案", ["- [ ] "]),
        "结果记录": val("结果记录", ""),
        "创建": _now_ts(),
        "更新": _now_ts(),
    }
    write_task_file(os.path.join(TASK_DIR, tid + ".md"), d)
    return True, tid


def _move_to(id, subdir, label):
    fn = os.path.join(TASK_DIR, id + ".md")
    if not os.path.exists(fn):
        return False, "not found"
    dest = os.path.join(TASK_DIR, subdir)
    os.makedirs(dest, exist_ok=True)
    shutil.move(fn, os.path.join(dest, id + ".md"))
    return True, label


def api_archive(id):
    return _move_to(id, "archive", "archived")


def api_delete(id):
    return _move_to(id, ".trash", "deleted")


def api_restore(id, subdir):
    """从 archive/.trash 还原回看板根目录。接受 'archive' 或 'trash'/'.trash'。"""
    if subdir == "trash":
        subdir = ".trash"
    if subdir not in ("archive", ".trash"):
        return False, "invalid source"
    src = os.path.join(TASK_DIR, subdir, id + ".md")
    if not os.path.exists(src):
        return False, "not found"
    dest = os.path.join(TASK_DIR, id + ".md")
    if os.path.exists(dest):
        return False, "看板中已存在同名任务，无法还原"
    shutil.move(src, dest)
    return True, "restored"


def api_reg_save(req):
    """保存注册表变更：成员整块替换；项目按 id 精细增删（保留注释）。"""
    # --- 成员：整块替换（members 段无重要注释）---
    if "members" in req:
        members = req["members"]
        if not isinstance(members, list):
            return False, "members 需为列表"
        cleaned = [str(m).strip() for m in members if str(m).strip()]
        block = "\n".join(f"  - {m}" for m in cleaned)
        ok, err = save_registry_block("members", block)
        if not ok:
            return False, f"成员保存失败: {err}"

    # --- 项目：精细增删（保留段内注释）---
    if "del_projects" in req or "add_projects" in req:
        try:
            with open(REGISTRY_PATH, encoding="utf-8") as f:
                lines = f.read().splitlines()
        except Exception as e:
            return False, f"读取失败: {e}"
        shutil.copy(REGISTRY_PATH, REGISTRY_BAK)
        out = []
        i = 0
        n = len(lines)
        in_projects = False
        del_ids = set(req.get("del_projects", []))
        skip_block = False
        while i < n:
            raw = lines[i]
            stripped = raw.strip()
            m = re.match(r"^([A-Za-z_]+):\s*$", stripped) if not raw.startswith(" ") else None
            if m and m.group(1) == "projects":
                in_projects = True
                out.append(raw)
                i += 1
                continue
            if in_projects:
                if stripped.startswith("- ") and re.match(r"^id:\s*", stripped[2:].strip()):
                    # 一个项目条目起始
                    pid = _coerce(stripped[2:].strip()[3:].strip()) if stripped[2:].strip().startswith("id:") else ""
                    if pid in del_ids:
                        skip_block = True
                        i += 1
                        continue
                    else:
                        skip_block = False
                        out.append(raw)
                        i += 1
                        continue
                if skip_block:
                    # 跳过该项目条目的后续属性行（缩进且非顶层键）
                    i += 1
                    continue
                # 顶层键出现 -> 离开 projects 段
                if m and not raw.startswith(" "):
                    in_projects = False
            out.append(raw)
            i += 1
        # 追加新增项目
        for p in req.get("add_projects", []):
            pid = str(p.get("id", "")).strip()
            if not pid or " " in pid:
                return False, f"项目 id 非法: '{pid}'"
            name = str(p.get("name", pid)).strip()
            repo = str(p.get("repo", "")).strip()
            tools = p.get("tools", [])
            if isinstance(tools, str):
                tools = [t.strip() for t in tools.split(",") if t.strip()]
            out.append(f"  - id: {pid}")
            out.append(f"    name: {name}")
            out.append(f"    tasks: \"\"")
            out.append(f"    repo: {repo}")
            out.append(f"    tools: [{', '.join(tools)}]")
            out.append(f"    sources: []")
        try:
            with open(REGISTRY_PATH, "w", encoding="utf-8") as f:
                f.write("\n".join(out).rstrip() + "\n")
        except Exception as e:
            return False, f"项目保存失败: {e}"

    return True, "saved"


def api_export():
    """导出所有任务为 JSON 数据（供前端下载）。返回 (ok, msg, data)。"""
    tasks = load_tasks(None, "active") + load_tasks(None, "archive") + load_tasks(None, "trash")
    reg = load_all_projects()
    members = load_members()
    data = {
        "version": 1,
        "exported_at": _now_ts(),
        "registry": {p["id"]: p.get("name", p["id"]) for p in reg},
        "members": members,
        "tasks": tasks,
    }
    return True, "ok", data


def api_backup():
    """在 HTTP 处理流程中调用 cmd_backup，返回 (ok, msg)。"""
    try:
        cmd_backup(argparse.Namespace())
        return True, "backup done"
    except Exception as e:
        return False, str(e)


# ---------- Hermes 联动（单向：方寸 -> Hermes 注册/派活；不做反向同步）----------
def _active_hermes_profile():
    """返回当前激活的 Hermes profile id（无覆盖时）；无法判定时返回 None。"""
    # 显式覆盖优先
    for env in ("HERMES_PROFILE", "HERMES_PROFILE_NAME"):
        v = os.environ.get(env, "").strip()
        if v:
            return v
    # 解析 `hermes profile list`：当前 profile 行以 ◆ 标记
    try:
        out = subprocess.run(["hermes", "profile", "list"],
                             capture_output=True, text=True, timeout=30,
                             creationflags=_NOWIN)
    except Exception:
        return None
    for line in out.stdout.splitlines():
        if "◆" in line:
            # 行形如： ◆default   hy3  ...  取首个非空白 token（去 ◆）
            tok = line.replace("◆", "").split()[0]
            return tok
    return None


# 方寸的全部仓库只注册到 default profile；禁止在其它 profile（如 game-developer）
# 下全量注册，避免污染其隔离的项目空间。
ALLOWED_SYNC_PROFILE = "default"


def cmd_hermes_sync(args):
    """把 registry.yaml 里的项目注册进 Hermes（幂等，仅限 default profile）。"""
    active = _active_hermes_profile()
    if active is None:
        print("无法判定当前 Hermes profile，中止 hermes-sync（安全优先）。")
        return
    if active != ALLOWED_SYNC_PROFILE:
        print(f"[拒绝] hermes-sync 只能在 '{ALLOWED_SYNC_PROFILE}' profile 下执行，"
              f"当前激活的是 '{active}'。\n"
              f"        若确需在 '{active}' 下注册，请改 ALLOWED_SYNC_PROFILE 或切换 profile："
              f"hermes profile use {ALLOWED_SYNC_PROFILE}")
        return
    reg = load_all_projects()
    if not reg:
        print("registry.yaml 为空或不存在，跳过。")
        return
    try:
        out = subprocess.run(["hermes", "project", "list"],
                             capture_output=True, text=True, timeout=30,
                             creationflags=_NOWIN)
    except Exception as e:
        print(f"调用 hermes 失败: {e}")
        return
    existing = set()
    for line in out.stdout.splitlines():
        s = line.strip()
        if s.startswith("*"):  # 当前项目带 * 前缀
            s = s[1:].strip()
        parts = s.split()
        if parts:
            existing.add(parts[0])
    for p in reg:
        pid = p.get("id")
        if not pid:
            continue
        if pid in existing:
            print(f"[skip] 已存在: {pid}")
            continue
        repo = p.get("repo") or "."
        name = p.get("name") or pid
        r = subprocess.run(
            ["hermes", "project", "create", name, repo, "--slug", pid],
            capture_output=True, text=True, timeout=30, creationflags=_NOWIN)
        if r.returncode == 0:
            print(f"[ok]   注册 {pid} -> {name} ({repo})")
        else:
            print(f"[fail] {pid}: {r.stderr.strip() or r.stdout.strip()}")


# ---------- 派活/回写活动日志（审计可回溯） ----------
def log_activity(kind, tid, detail=""):
    """追加一行活动记录：ISO时间 | 动作 | 任务id | 详情。纯审计用，读失败不影响主流程。"""
    try:
        os.makedirs(TASK_DIR, exist_ok=True)
        ts = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        with open(ACTIVITY_LOG, "a", encoding="utf-8") as f:
            f.write(f"{ts} | {kind} | {tid} | {detail}\n")
    except Exception:
        pass


def read_activity(tid=None, limit=200):
    """读活动日志（倒序）。tid 给定则只筛该任务。"""
    if not os.path.exists(ACTIVITY_LOG):
        return []
    rows = []
    try:
        with open(ACTIVITY_LOG, encoding="utf-8") as f:
            for ln in f:
                ln = ln.strip()
                if not ln:
                    continue
                parts = [p.strip() for p in ln.split("|", 3)]
                if len(parts) < 3:
                    continue
                if tid and parts[2] != tid:
                    continue
                rows.append({"ts": parts[0], "kind": parts[1], "id": parts[2],
                             "detail": parts[3] if len(parts) > 3 else ""})
    except Exception:
        return []
    rows.reverse()
    return rows[:limit]


# ---------- 派活（看板一键 / CLI 共用） ----------
def _hermes_cmd(extra_args):
    """解析 hermes 可执行文件真实路径，返回可直接 Popen 的命令列表。
    Windows 上 npm shim 常是 .cmd，CreateProcess 不认，需经 cmd.exe /c 包装。"""
    exe = shutil.which("hermes")
    if not exe:
        return None
    if exe.lower().endswith((".cmd", ".bat")):
        return ["cmd.exe", "/c", exe] + extra_args
    return [exe] + extra_args


def _build_prompt(d, tid, repo, done_cmd, fn):
    """完整任务书：agent 收到的是可独立执行的指令，不是一个标题。
    输入精确化的核心——方案原文、资源指路、附言、回写命令全部内联。"""
    proj_id = (d.get("项目") or [None])[0]
    p = {q["id"]: q for q in load_all_projects()}.get(proj_id) if proj_id else None
    proj_name = (p or {}).get("name") or proj_id or "?"
    plan = "\n".join(d.get("方案") or []) or "- [ ]（方案为空）"
    res = d.get("资源", {}) if isinstance(d.get("资源"), dict) else {}
    ziliao = str(res.get("资料") or "").strip()
    tools = res.get("工具") or []
    fy = str(d.get("附言") or "").strip()
    lines = [
        f"执行方寸任务 {tid}：{d.get('标题','')}",
        f"项目：{proj_name}（{proj_id}）· 仓库：{repo}",
        f"任务卡：{fn}（先完整阅读再动手）",
        "## 方案（验收对照表，完成后逐项核销）",
        plan,
    ]
    if ziliao:
        lines.append(f"资料：{ziliao}")
    if tools:
        lines.append(f"工具提示：{', '.join(tools)}")
    if fy:
        lines.append(f"## 本次附言（优先级最高；与本任务既往记录冲突时以本条为准）\n{fy}")
    lines.append(
        "## 回写（必须，自包含闭环）\n"
        f'完成后执行：{done_cmd} --结果 "<一句话结果>" [--证据 "<改动清单/验证输出路径>"]\n'
        "证据路径让验收人能顺着看到实物；回写后任务置为待验收，由人验收。")
    return "\n".join(lines)


def prepare_dispatch(tid):
    """解析任务并组装派活要素。返回 (info, err)：info 为 dict，err 非空即失败。"""
    fn = locate_task(tid) or os.path.join(TASK_DIR, tid + ".md")   # 归档任务也可回看任务书
    if not os.path.exists(fn):
        return None, f"任务不存在: {tid}"
    d = parse_task(fn)
    if d is None:
        return None, "解析失败"
    proj_id = (d.get("项目") or [None])[0]
    reg = {p["id"]: p for p in load_all_projects()}
    p = reg.get(proj_id) if proj_id else None
    repo = p.get("repo") if p else None
    if not repo:
        return None, f"任务 {tid} 的项目 {proj_id} 在 registry 中无 repo 路径"
    done_cmd = f'python "{ROOT}/tegula.py" done {tid}'
    prompt = _build_prompt(d, tid, repo, done_cmd, fn)
    return {"d": d, "fn": fn, "repo": repo, "prompt": prompt, "done_cmd": done_cmd,
            "snapshot": os.path.join(TASK_DIR, f".dispatch-{tid}-{_now_ts()}.txt")}, ""


def dispatch_task(tid, launch=True, force=False, dry_run=False):
    """派活：生成完整任务书及 hermes 启动命令。

    launch=True 时后台静默拉起 hermes chat（旧行为，保留给 --go 用）；
    dry_run=True 时不拉起、不改变状态，只返回命令字符串供用户复制。
    """
    info, err = prepare_dispatch(tid)
    if err:
        return False, err, None
    d, fn = info["d"], info["fn"]
    if d.get("状态") in ("完成", "驳回"):
        return False, "任务已终态，不派活", None
    blk = blockers_of(tid)
    if blk:
        who = "、".join(f"{b['id']}《{b['标题']}》{b['状态']}" for b in blk)
        return False, f"被阻塞：前置 {who} 未完成（前置完成并验收后自动解锁）", None
    plan_ok = [s for s in (d.get("方案") or []) if str(s).strip() and str(s).strip() != "- [ ]"]
    if not plan_ok:
        return False, "方案为空（只剩占位符）：空白任务书会让执行方自行猜测目标，先补方案再派", None
    if d.get("状态") == "进行中" and not force and (launch or dry_run):
        return False, ("任务已在进行中（上次派活可能未闭环）：重复派活会开出第二个并发会话，"
                       "存在同时写同一仓库的风险。确认上次已中断需重派：CLI 加 --force，看板在弹窗确认"), None
    cmd = _hermes_cmd(["-z", info["prompt"], "chat", "--in", info["repo"]])
    if cmd is None:
        return False, "未找到 hermes 命令（PATH 里没有 hermes）", None
    if dry_run:
        return True, "dry-run", cmd
    if launch:
        # CREATE_NO_WINDOW：后台静默运行，不弹黑窗口；用户可在 Hermes 桌面端会话列表里直接查看进度
        try:
            subprocess.Popen(
                cmd,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception as e:
            return False, f"拉起失败: {e}", None
        # 派单快照：本次实际下发的完整指令留底（使用数据不入 git），审计可回放
        try:
            with open(info["snapshot"], "w", encoding="utf-8") as f:
                f.write(info["prompt"])
        except Exception:
            pass
    if d.get("状态") != "进行中":
        d["状态"] = "进行中"
        d["派活时间"] = _now_ts()  # 记录派活时间戳（用于超时预警）
    if launch and str(d.get("附言") or "").strip():
        d["附言"] = ""            # 附言随真实派单下发并消费；dry-run/preview 不消费（预览即所得）
    if not str(d.get("创建") or "").strip():
        d["创建"] = _now_ts()
    d["更新"] = _bump_version(d.get("更新"))
    write_task_file(fn, d)
    log_activity("dispatch" if launch else "dry-dispatch", tid,
                 f"{os.path.basename(info['snapshot'])} · {(d.get('标题') or '')[:40]}")
    return True, ("已静默派活（桌面端会话列表可追踪）" if launch else "已生成派活命令"), cmd


def api_dispatch(id, force=False, dry_run=False):
    ok, msg, cmd = dispatch_task(id, force=force, dry_run=dry_run)
    if ok and dry_run and cmd:
        return ok, msg, cmd
    return ok, msg, None


def cmd_dispatch(args):
    """CLI 派活：默认模式 B（只生成命令，不拉起），--go 保留旧自动拉起行为。

    --msg  先写附言再派；
    --preview 打印完整任务书不拉起；
    --go 自动拉起 hermes chat（旧行为）；
    指定 id 派单个，无 id 自动挑待办，--all 全派。
    """
    if args.msg:
        if not args.id:
            print("[fail] --msg 需要指定任务 id")
            return
        okw, mw = api_edit(args.id, {"附言": args.msg})
        if not okw:
            print(f"[fail] 附言写入失败: {mw}")
            return
        print(f"[ok] 附言已写入 {args.id}（随本次任务书下发）")
    if args.preview and args.id:
        info, err = prepare_dispatch(args.id)
        if err:
            print(f"[fail] {err}")
            return
        print(info["prompt"])
        return
    if args.id:
        ok, msg, cmd = dispatch_task(args.id, launch=args.go, force=args.force,
                                     dry_run=not args.go)
        if ok and not args.go:
            # 模式 B：只输出命令，不拉起
            print(f"[task] {args.id}")
            print(f"# 复制以下命令在终端执行：")
            print(" ".join(f'"{c}"' if " " in c else c for c in cmd))
            print(f"# 回写命令：python \"{ROOT}/tegula.py\" done {args.id} --结果 \"<一句话结果>\"")
        else:
            print(("[ok] " if ok else "[fail] ") + f"{args.id}: {msg}")
        return
    tasks = load_tasks(None, "active")
    cands = [t for t in tasks if t.get("状态") == "待办" and (t.get("指派") or "hermes") == "hermes"
             and not blockers_of(t.get("id", ""))]
    def pv(t):
        pr = t.get("优先级") or ""
        return 2 if pr == "高" else (1 if pr == "中" else 0)
    cands.sort(key=lambda t: (-pv(t), t.get("id", "")))
    if not cands:
        print("没有「待办 + 指派 hermes」的任务可派。")
        return
    picks = cands if args.all else cands[:1]
    for t in picks:
        ok, msg, cmd = dispatch_task(t["id"], launch=args.go, force=args.force,
                                      dry_run=not args.go)
        if ok and not args.go:
            print(f"[task] {t['id']} {t.get('标题','')}")
            print(" ".join(f'"{c}"' if " " in c else c for c in cmd))
            print(f"# 回写：python \"{ROOT}/tegula.py\" done {t['id']} --结果 \"<结果>\"")
        else:
            print(("[ok] " if ok else "[fail] ") + f"{t['id']} {t.get('标题','')}: {msg}")
    if not args.all and len(cands) > 1:
        print(f"（还有 {len(cands) - 1} 个待办未派，加 --all 全派）")


def cmd_hermes_open(args):
    """为某任务生成『在对应仓库里派活给 Hermes』的命令；--go 才真正拉起（前台）。"""
    info, err = prepare_dispatch(args.id)
    if err:
        print(err)
        return
    cmd = ["hermes", "-z", info["prompt"], "chat", "--in", info["repo"]]
    print("# 在仓库上下文中派活给 Hermes：")
    print(" \n".join(cmd[:4]) + " …")
    print(f"# 回写命令：{info['done_cmd']} --结果 \"<一句话结果>\"")
    if args.go:
        print("\n>>> 正在拉起 hermes chat（退出后回到此处）...")
        subprocess.run(cmd)


def cmd_backup(args):
    """把 task-data/ 打 zip 到 backups/，按 KEEP 轮换，防手滑防盘坏（git 永久排除使用数据）。"""
    if not os.path.isdir(TASK_DIR):
        print("task-data/ 不存在，无事可备。")
        return
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = os.path.join(BACKUP_DIR, f"task-data-{stamp}.zip")
    n = 0
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(TASK_DIR):
            dirs[:] = [d for d in dirs if d != ".trash"]   # 回收站不入备份
            for f in files:
                if f.endswith(".tmp"):                     # 原子写临时文件不入备份
                    continue
                p = os.path.join(root, f)
                arc = os.path.relpath(p, TASK_DIR)
                z.write(p, arc)
                n += 1
    keep = sorted(os.listdir(BACKUP_DIR))
    removed = 0
    while len(keep) > BACKUP_KEEP:
        old = os.path.join(BACKUP_DIR, keep.pop(0))
        try:
            os.remove(old)
            removed += 1
        except OSError:
            break
    size = os.path.getsize(dest) / 1024
    print(f"OK: {dest}（{n} 个文件，{size:.1f} KB）" + (f"，轮换删除 {removed} 个旧备份" if removed else ""))
    log_activity("backup", "-", f"{os.path.basename(dest)} {n} files")


def cmd_done(args):
    """执行方（Hermes 等）完工回写：填结果记录 + 置待验收。幂等、异常不中断。"""
    fn = os.path.join(TASK_DIR, args.id + ".md")
    if not os.path.exists(fn):
        print(f"任务不存在: {args.id}")
        return
    guard = _mtime_guard(fn, {"expected_mtime": args.expected_mtime})
    if guard:
        print(f"[拒绝] {guard}")
        return
    d = parse_task(fn)
    if d is None:
        print("解析失败")
        return
    if args.结果:
        old = (d.get("结果记录") or "").strip()
        d["结果记录"] = (old + "\n" if old else "") + args.结果.strip()
    if args.证据:
        old = (d.get("结果记录") or "").strip()
        d["结果记录"] = (old + "\n" if old else "") + f"证据：{args.证据.strip()}"
    fy = str(d.get("附言") or "").strip()
    if fy:
        old = (d.get("结果记录") or "").strip()
        d["结果记录"] = (old + "\n" if old else "") + f"附言归档：{fy}"
        d["附言"] = ""            # 附言随 done 归档清空，下次派单是干净状态
    d["状态"] = "待验收"
    if not str(d.get("创建") or "").strip():
        d["创建"] = _now_ts()
    d["更新"] = _bump_version(d.get("更新"))
    write_task_file(fn, d)
    log_activity("done", args.id, (args.结果 or "")[:80])
    print(f"OK: {args.id} 已回写结果并置为待验收")
    down = find_blockers(args.id)
    if down:
        print(f"提示：{len(down)} 个任务引用了本任务（当前仍被阻塞，验收置「完成」后自动解锁）：")
        for t in down:
            print(f"  - {t['id']}《{t['标题']}》[{t['状态']}]")
    else:
        print("提示：无下游任务引用本任务。")


# ---------- 资料路径：白名单校验 + 系统默认程序打开（看板可点击） ----------

def allowed_roots():
    """打开文件的白名单根：registry 中全部项目的 repo 路径。
    这是唯一授权面——看板/浏览器来的任意路径都必须落在这些根之内。"""
    roots = []
    for p in load_all_projects():
        r = str(p.get("repo") or "").strip()
        if r:
            roots.append(os.path.normcase(os.path.abspath(r)))
    return roots


def validate_open_path(path):
    """校验待打开路径是否在白名单内，返回 (abs_path, err)。err 非空即拒绝。

    拒绝面（安全优先，任何一条命中即拒）：
      1. 空路径 / 非法类型
      2. 含 NUL 或换行等控制字符（防命令拼接）
      3. 路径回溯：raw 含 .. 片段，或 realpath 后逃出所有白名单根
      4. 不在任何 registry 项目 repo 之内
    """
    raw = str(path or "").strip().strip('"').strip("'")
    if not raw:
        return None, "路径为空"
    if any(c in raw for c in ("\x00", "\n", "\r", "\t")):
        return None, "路径含非法控制字符"
    # 环境变量/变量展开一律不认：`%WINDIR%`、`${HOME}` 会被当成普通文件名，
    # abspath 后"恰好"落在项目根内 —— 是误放行，不是真包含。直接拒绝，
    # 避免将来有同名文件时被打开（当前数据用的是 ~，见下方展开）。
    if re.search(r"%[^/\\]*%|\$\{?[A-Za-z_]+\}?", raw):
        return None, "路径含环境变量或变量引用，不支持（请写展开后的绝对/相对路径）"
    if raw == "~" or raw.startswith("~/") or raw.startswith("~\\"):
        raw = os.path.join(os.path.expanduser("~"), raw[2:]) if len(raw) > 1 else os.path.expanduser("~")
    # 统一分隔符后按片段查回溯（兼容 / 与 \）
    if ".." in re.split(r"[/\\]+", raw):
        return None, "路径回溯（..）被拦截"
    ap = os.path.abspath(os.path.join(ROOT, raw)) if not os.path.isabs(raw) else os.path.abspath(raw)
    real = os.path.normcase(os.path.realpath(ap))
    roots = allowed_roots()
    if not roots:
        return None, "registry 中没有可用项目路径"
    for root in roots:
        rreal = os.path.normcase(os.path.realpath(root))
        if real == rreal or real.startswith(rreal + os.sep):
            return ap, ""
    return None, "路径不在允许范围内（仅限已注册项目的仓库内文件）"


def api_open_file(path):
    """用系统默认程序打开资料路径。先用白名单校验，再交给系统。
    目录用 explorer 打开（保持资源管理器窗口），文件用 cmd start（走默认关联程序）。"""
    ap, err = validate_open_path(path)
    if err:
        return False, err
    if not os.path.exists(ap):
        return False, f"路径不存在: {ap}"
    try:
        if os.path.isdir(ap):
            subprocess.Popen(["explorer", os.path.normpath(ap)],
                             creationflags=_NOWIN)
        else:
            # cmd start：第一个 "" 是窗口标题占位，避免带空格路径被当成标题
            subprocess.Popen(["cmd", "/c", "start", "", os.path.normpath(ap)],
                             shell=False, creationflags=_NOWIN)
        return True, "opened"
    except Exception as e:
        return False, f"打开失败: {e}"


# ---------- 自动化规则（P2：.rules.json + 内置两条，零依赖） ----------
RULES_PATH = os.path.join(TASK_DIR, ".rules.json")
DEFAULT_RULES = [
    {
        "id": "rule-1",
        "name": "方案全完成自动推进",
        "trigger": "field_change",
        "condition": {"field": "方案", "all_checked": True, "status": "进行中"},
        "action": {"type": "set_status", "value": "待验收"},
        "enabled": True,
    },
    {
        "id": "rule-2",
        "name": "超时任务提醒（48h 未回写）",
        "trigger": "timeout_check",
        "condition": {"status": "进行中", "hours_since_dispatch": 48},
        "action": {"type": "warn_badge"},
        "enabled": True,
    },
]


def _rules_path():
    """规则文件路径随 task-data/ 走（verify.py 会改 TASK_DIR，需动态取）。"""
    return os.path.join(TASK_DIR, ".rules.json")


def load_rules():
    """读规则；文件不存在则落盘默认规则；损坏则安全回退默认（不影响主流程）。"""
    p = _rules_path()
    if not os.path.exists(p):
        save_rules(DEFAULT_RULES)
        return [dict(r) for r in DEFAULT_RULES]
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return [r for r in data if isinstance(r, dict)]
    except Exception:
        pass
    return [dict(r) for r in DEFAULT_RULES]


def save_rules(rules):
    """原子写规则文件（临时文件 + os.replace）。失败静默：规则不是主流程的硬依赖。"""
    try:
        os.makedirs(TASK_DIR, exist_ok=True)
        p = _rules_path()
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(rules, f, ensure_ascii=False, indent=2)
        os.replace(tmp, p)
        return True, ""
    except Exception as e:
        return False, str(e)


def _plan_all_checked(plan):
    """方案是否"全勾选"：至少有一项，且不存在未勾选项。"""
    items = [str(s) for s in (plan or []) if str(s).strip()]
    if not items:
        return False
    return all(re.search(r"\[x\]", s, re.I) for s in items)


def evaluate_rules(task, trigger, context=None):
    """按触发器执行匹配的启用规则，返回已执行规则名的列表。

    仅支持内置两种动作（任务书红线：不做复杂规则引擎）：
      - set_status：满足条件时改状态（写回文件的调用方负责落盘）
      - warn_badge：只做标记，不改状态
    规则文件损坏不影响主流程（load_rules 已兜底）。
    """
    ctx = context or {}
    fired = []
    for r in load_rules():
        if not r.get("enabled", True):
            continue
        if r.get("trigger") != trigger:
            continue
        cond = r.get("condition") or {}
        act = r.get("action") or {}
        if cond.get("all_checked"):
            if not _plan_all_checked(task.get("方案")):
                continue
            # 状态门：condition.status 显式声明才比对；未声明则默认只允许「进行中」
            # （自动推进的本质是「执行方干完了」，草稿/待办/已终态都不该被推走）
            want_status = cond.get("status", "进行中")
            if want_status and task.get("状态") != want_status:
                continue
            if act.get("type") == "set_status" and act.get("value"):
                task["状态"] = act["value"]
                fired.append(r.get("name") or r.get("id") or "未命名规则")
    return fired


# ---------- HTML 工具 ----------
def esc(s):
    """HTML 实体转义"""
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


# ---------- HTTP ----------
LAST_REQUEST = time.time()   # 最近一次请求时刻：open 模式靠它判定窗口是否还开着

# 项目视图缓存（/status.json）：TTL 内复用扫描结果；任何写操作后立即失效。
# scan 全 registry 要跑十几条 git 子进程（每个项目 4 条），不能跟着看板 2s 轮询走。
_STATUS_CACHE = {"data": None, "ts": 0.0}
STATUS_TTL = 20.0            # 秒：项目状态 freshness 粒度，非实时要求
WRITE_ACTIONS = {"edit", "new", "archive", "delete", "restore", "dispatch", "reg_save", "review"}


def _status_snapshot_path():
    """扫描快照落盘路径（task-data/ 使用数据，不入 git）。"""
    return os.path.join(TASK_DIR, ".status-cache.json")


def _load_status_snapshot():
    """读上次扫描快照；损坏/不存在返回 None。用 mtime 当缓存时间戳。"""
    try:
        with open(_status_snapshot_path(), encoding="utf-8") as f:
            snap = json.load(f)
        ts = os.path.getmtime(_status_snapshot_path())
        if isinstance(snap.get("statuses"), list) and snap["statuses"]:
            snap["ts"] = int(ts)
            return snap
    except Exception:
        pass
    return None


def _save_status_snapshot(payload):
    """扫描完成落盘（原子写）；失败静默（快照只是加速，不兜底不报错）。"""
    try:
        os.makedirs(TASK_DIR, exist_ok=True)
        tmp = _status_snapshot_path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp, _status_snapshot_path())
    except Exception:
        pass


def project_status_payload(force=False):
    """供 /status.json 的项目状态负载（含建议层），带 TTL 缓存 + SWR + 快照。

    released 项目排到末尾；活跃区按 stuck > active > idle > dormant > unknown 排序，
    让有卡点、有动静的项目先出现在看板上。
    冷启动三级数据源（消除首进等待）：
      ① 内存 TTL 缓存（20s 内）→ ② 磁盘快照（上次扫描结果，读盘 <10ms 秒显）
      → ③ 同步全扫（并行，~0.7s）。命中 ② 时后台自动重扫换新（SWR）。
    """
    now = time.time()
    has_cache = _STATUS_CACHE["data"] is not None
    if has_cache and now - _STATUS_CACHE["ts"] < STATUS_TTL:
        return _STATUS_CACHE["data"]
    if has_cache and not force:
        # 过期但有旧数据：先给旧数据（标 stale），后台重扫，不阻塞响应
        threading.Thread(target=_rescan_status_bg, daemon=True).start()
        out = dict(_STATUS_CACHE["data"])
        out["stale"] = True
        return out
    # 冷启动：先试磁盘快照（秒显），后台重扫；无快照才同步扫
    if not force:
        snap = _load_status_snapshot()
        if snap:
            _STATUS_CACHE["data"] = snap
            _STATUS_CACHE["ts"] = now   # 快照视为"当前已知数据"，随后台重扫更新
            threading.Thread(target=_rescan_status_bg, daemon=True).start()
            snap["stale"] = True
            return snap
    return _scan_status_now()


_STATUS_SCAN_LOCK = threading.Lock()   # 防止 SWR 后台重扫重复起线程


def _rescan_status_bg():
    """后台重扫 /status.json 数据；持锁判定，完成前再来的请求拿旧缓存。"""
    if not _STATUS_SCAN_LOCK.acquire(blocking=False):
        return   # 已有线程在扫
    try:
        _scan_status_now()
    finally:
        _STATUS_CACHE["scanning"] = False
        _STATUS_SCAN_LOCK.release()


def _scan_status_now():
    """同步全量扫描：并行跑 git（每项目一个线程，IO 等待为主，12 项目×4 线程级提速）。"""
    reg = load_all_projects()
    results = [None] * len(reg)
    workers = []
    def _one(i, p):
        results[i] = scan_project_status(p)
    for i, p in enumerate(reg):
        th = threading.Thread(target=_one, args=(i, p), daemon=True)
        th.start(); workers.append(th)
    for th in workers:
        th.join()
    statuses = [s for s in results if s is not None]
    order = {"stuck": 0, "active": 1, "idle": 2, "dormant": 3, "unknown": 4, "released": 5}
    statuses.sort(key=lambda s: (order.get(s["health"], 9), (s["git"]["last_commit_days"] or 9999)))
    all_sugs = []
    for s in statuses:
        for u in suggest_actions(s):
            all_sugs.append({"project": s["name"], "text": u})
    if len(statuses) > 1:
        for u in suggest_cross_project(statuses):
            all_sugs.append({"project": None, "text": u})
    now = time.time()
    payload = {"statuses": statuses, "suggestions": all_sugs, "ts": int(now),
               "timeouts": find_timeout_tasks()}
    _STATUS_CACHE["data"] = payload
    _STATUS_CACHE["ts"] = now
    _save_status_snapshot(payload)   # 快照落盘：下次冷启动秒显
    return payload


# ---------- 快速添加语法（P1）：一行解析 优先级/标签/指派/截止/状态 ----------
QUICK_PRIO = {"p0": "高", "p1": "中", "p2": "低", "p3": "低"}


def parse_quick_add(text):
    """解析快速添加语法，返回 (fields, err)。

    语法示例：`Fix login p1 #backend @hermes due:09-10 to:待办`
      - p0/p1/p2/p3 → 优先级（高/中/低）
      - #tag        → 标签（可多个，自动去重）
      - @user       → 指派
      - due:MM-DD   → 截止（当年）
      - to:状态      → 初始状态（必须是合法状态值）
    未被识别的 token 原样拼回标题。
    """
    raw = str(text or "").strip()
    if not raw:
        return None, "内容为空"
    fields = {"标题": "", "状态": "待办", "优先级": "", "标签": [], "指派": "", "截止": ""}
    title_tokens, tags = [], []
    toks = raw.split()
    for tk in toks:
        low = tk.lower()
        if low in QUICK_PRIO and not fields["优先级"]:
            fields["优先级"] = QUICK_PRIO[low]
        elif tk.startswith("#") and len(tk) > 1:
            t = tk[1:].strip()
            if t and t not in tags:
                tags.append(t)
        elif tk.startswith("@") and len(tk) > 1:
            fields["指派"] = tk[1:].strip()
        elif low.startswith("due:") and len(tk) > 4:
            fields["截止"] = tk[4:].strip()
        elif low.startswith("to:") and len(tk) > 3:
            sv_ = tk[3:].strip()
            if sv_ in STATUSES:
                fields["状态"] = sv_
            else:
                return None, f"未知状态「{sv_}」（可选：{'/'.join(STATUSES)}）"
        else:
            title_tokens.append(tk)
    fields["标签"] = tags
    fields["标题"] = " ".join(title_tokens).strip()
    if not fields["标题"]:
        return None, "标题为空：语法 token 之外还要有任务标题"
    return fields, ""


def api_quick_add(text):
    fields, err = parse_quick_add(text)
    if err:
        return False, err
    return api_new(fields)


def api_rules(req):
    """规则读写：无 op 时返回当前规则列表；op=save 时整表替换。"""
    if req.get("op") == "save":
        rules = req.get("rules")
        if not isinstance(rules, list):
            return False, "rules 需为列表", None
        ok, err = save_rules(rules)
        return (ok, "saved" if ok else err, rules if ok else None)
    return True, "ok", load_rules()


def timeout_badge_hours(task, rules=None):
    """该任务是否命中「超时未回写」规则；命中返回阈值小时数，否则 None。"""
    if str(task.get("状态") or "") != "进行中":
        return None
    pd = task.get("派活时间")
    if not pd:
        return None
    try:
        hours = (time.time() - float(pd)) / 3600
    except (TypeError, ValueError):
        return None
    for r in (rules if rules is not None else load_rules()):
        if not r.get("enabled", True) or r.get("trigger") != "timeout_check":
            continue
        cond = r.get("condition") or {}
        if str(cond.get("status") or "进行中") != str(task.get("状态") or ""):
            continue
        try:
            th = float(cond.get("hours_since_dispatch") or 48)
        except (TypeError, ValueError):
            th = 48.0
        if hours >= th:
            return th
    return None


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        global LAST_REQUEST
        LAST_REQUEST = time.time()
        if self.path.startswith("/tasks.json"):
            self._json()
        elif self.path.startswith("/status.json"):
            self._status_json()
        elif self.path.startswith("/startpage"):
            self._startpage()
        elif self.path.startswith("/ping"):
            self._send_json({"ok": True, "app": "tegula"})
        else:
            self._html()

    def do_POST(self):
        global LAST_REQUEST
        LAST_REQUEST = time.time()
        if self.path == "/api":
            self._api()
        else:
            self.send_error(404)

    def _send_json(self, obj):
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _status_json(self):
        """项目视图数据（GET /status.json）。携带 ?refresh=1 时绕过缓存重扫。"""
        force = "refresh=1" in self.path
        self._send_json(project_status_payload(force=force))

    def _json(self):
        proj = None
        view = "active"
        if "?" in self.path:
            qs = parse_qs(self.path.split("?", 1)[1])
            proj = qs.get("project", [""])[0] or None
            view = qs.get("view", ["active"])[0]
            if "tid" in qs:
                self._send_json(read_activity(qs["tid"][0]))
                return
        self._send_json(load_tasks(proj, view))

    def _api(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b""
            req = json.loads(raw.decode("utf-8"))
        except Exception:
            self._send_json({"ok": False, "error": "bad json"})
            return
        action = req.get("action")
        cmd = None
        try:
            if action == "edit":
                ok, msg = api_edit(req.get("id"), req.get("fields", {}))
            elif action == "review":
                ok, msg = api_review(req.get("id"), req.get("verdict"),
                                     req.get("reason", ""))
            elif action == "new":
                ok, msg = api_new(req.get("fields", {}))
            elif action == "quick_add":
                ok, msg = api_quick_add(req.get("text", ""))
            elif action == "archive":
                ok, msg = api_archive(req.get("id"))
            elif action == "delete":
                ok, msg = api_delete(req.get("id"))
            elif action == "restore":
                ok, msg = api_restore(req.get("id"), req.get("from", "trash"))
            elif action == "dispatch":
                ok, msg, cmd = api_dispatch(req.get("id"), bool(req.get("force")),
                                            bool(req.get("dry_run")))
            elif action == "reg_save":
                ok, msg = api_reg_save(req)
            elif action == "export":
                ok, msg, data = api_export()
                if ok:
                    self._send_json({"ok": True, "data": data})
                    return
            elif action == "backup":
                ok, msg = api_backup()
            elif action == "open_file":
                ok, msg = api_open_file(req.get("path"))
            elif action == "rules":
                ok, msg, data = api_rules(req)
                if ok:
                    self._send_json({"ok": True, "msg": msg, "data": data})
                    return
            elif action == "launch":
                app_path = req.get("app", "")
                if app_path and os.path.exists(app_path):
                    try:
                        subprocess.Popen([app_path], cwd=os.path.dirname(app_path))
                        ok, msg = True, "launched"
                    except Exception as e:
                        ok, msg = False, f"启动失败: {e}"
                else:
                    ok, msg = False, f"应用路径不存在: {app_path}"
            else:
                ok, msg = False, "unknown action"
        except Exception as e:
            ok, msg = False, str(e)
        if ok and action in WRITE_ACTIONS:
            _STATUS_CACHE["data"] = None   # 写后失效：下次 /status.json 重扫，项目视图立即反映
        resp = {"ok": ok, "msg": msg}
        if action == "dispatch" and cmd:
            resp["cmd"] = cmd
        self._send_json(resp)

    def _html(self):
        # 看板页面从独立模板渲染，便于维护与主题重涂；
        # 仅注册表需动态注入（registry.yaml 的项目列表）。
        reg_map = {p["id"]: {"name": p.get("name", p["id"]), "repo": p.get("repo", "")}
                   for p in load_all_projects() if not p.get("_released")}
        reg_js = json.dumps(reg_map, ensure_ascii=False)
        mem_js = json.dumps(load_members(), ensure_ascii=False)
        # PyInstaller 打包后模板在 sys._MEIPASS 临时目录
        if getattr(sys, "frozen", False):
            tpl_base = sys._MEIPASS
        else:
            tpl_base = ROOT
        tpl_path = os.path.join(tpl_base, "templates", "board.html")
        try:
            with open(tpl_path, encoding="utf-8") as f:
                page = f.read()
        except Exception:
            page = "<h1>模板缺失：templates/board.html</h1>"
        page = page.replace("__REGISTRY__", reg_js)
        page = page.replace("__MEMBERS__", mem_js)
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(page.encode("utf-8"))


    def log_message(self, *a):
        pass

    def _startpage(self):
        """全项目统一启动台：动态读取 registry.yaml 生成入口页面"""
        reg = load_all_projects()
        projects = [p for p in reg if not p.get("_released")]
        released = [p for p in reg if p.get("_released")]

        cards = []
        for p in projects:
            pid = p["id"]
            name = p.get("name", pid)
            repo = p.get("repo", "")
            tools = p.get("tools", [])
            app = p.get("app", "")
            link = p.get("link", "")
            tools_str = "、".join(tools) if tools else "通用"

            action_btns = ""
            if app:
                action_btns += f'<button class="app-btn" onclick="event.stopPropagation();launchApp(\'{esc(app)}\')" title="启动应用">▶</button>'
            if link:
                action_btns += f'<a class="app-btn" href="{esc(link)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="打开链接">🔗</a>'

            cards.append(f"""
            <a class="tool" href="http://127.0.0.1:8753/?project={esc(pid)}" target="_blank" rel="noopener">
                <div class="ico">📁</div>
                <div class="body">
                    <h2>{esc(name)}</h2>
                    <p>{esc(repo)}</p>
                </div>
                <span class="port">{esc(tools_str)}</span>
                <span class="app-btns">{action_btns}</span>
            </a>""")

        rel_html = ""
        if released:
            rel_names = " · ".join(esc(p.get("name", p["id"])) for p in released)
            rel_html = f'<div class="relrow"><span class="ln"></span><span>已发布：{rel_names}</span><span class="ln"></span></div>'

        html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>工作台 · 方寸</title>
<style>
:root{{--bg:#eef0f4;--ink:#3c4150;--muted:#6b7180;--accent:#9b8fc4;--accent-soft:#c3bce0;--card:#ffffff;--border:#e4e2ee;--shadow:0 8px 32px rgba(90,90,130,.12);--radius:18px}}
*{{margin:0;padding:0;box-sizing:border-box}}
html,body{{height:100%}}
body{{background:var(--bg);color:var(--ink);min-height:100vh;min-width:480px;font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;font-weight:500;line-height:1.55}}
body::before,body::after{{content:"";position:fixed;border-radius:50%;filter:blur(70px);opacity:.38;z-index:0;pointer-events:none}}
body::before{{width:420px;height:420px;background:#cfc6ec;top:-120px;left:-100px}}
body::after{{width:380px;height:380px;background:#cdd9ee;bottom:-120px;right:-80px}}
.wrap{{position:relative;z-index:1;max-width:640px;min-width:460px;margin:0 auto;padding:42px 20px}}
.head{{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:22px}}
h1{{font-size:20px;font-weight:700;letter-spacing:.5px}}
.sub{{color:var(--muted);font-size:12.5px;margin-bottom:24px}}
.grid{{display:grid;gap:12px}}
.tool{{background:var(--card);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow);padding:16px 18px;display:flex;align-items:center;gap:14px;text-decoration:none;color:inherit;transition:transform .12s,box-shadow .15s;cursor:pointer;position:relative}}
.tool:hover{{transform:translateY(-2px);box-shadow:0 12px 36px rgba(90,90,130,.16)}}
.tool .ico{{width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex:none;background:#eef0fb;color:#5b5478}}
.tool .body{{flex:1;min-width:0;overflow:hidden}}
.tool h2{{font-size:14.5px;font-weight:700;margin-bottom:2px;white-space:nowrap}}
.tool p{{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
.tool .port{{font-family:Consolas,monospace;font-size:11px;color:var(--muted);margin-left:auto;flex:none}}
.tool .app-btns{{display:flex;gap:4px;flex:none}}
.app-btn{{background:#eef0fb;color:#5b5478;border:1px solid var(--border);border-radius:8px;padding:4px 8px;font-size:12px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;line-height:1;transition:all .12s}}
.app-btn:hover{{background:var(--accent);color:#fff;border-color:var(--accent)}}
.relrow{{margin:12px 2px 4px;font-size:11px;color:var(--muted);display:flex;gap:8px;align-items:center}}
.relrow .ln{{flex:1;height:1px;background:var(--border)}}
.foot{{margin-top:22px;color:var(--muted);font-size:11.5px;text-align:center}}
</style>
</head>
<body>
<div class="wrap">
    <div class="head"><h1>工作台</h1></div>
    <div class="sub">方寸管理 · 点击项目直达看板筛选 · ▶ 启动应用 · 🔗 打开链接</div>
    <div class="grid">
        <a class="tool" href="http://127.0.0.1:8753/" target="_blank" rel="noopener">
            <div class="ico">📋</div>
            <div class="body"><h2>方寸 看板</h2><p>全部项目 · 任务总览</p></div>
            <span class="port">8753</span>
        </a>
        {"".join(cards)}
    </div>
    {rel_html}
    <div class="foot">共 {len(projects)} 个活跃项目 · 由 tegula.py 动态生成</div>
</div>
<script>
async function launchApp(appPath){{
    const r=await fetch("/api",{{method:"POST",headers:{{"Content-Type":"application/json"}},body:JSON.stringify({{action:"launch",app:appPath}})}});
    const d=await r.json();
    if(!d.ok)alert("启动失败："+(d.msg||"未知错误"));
}}
</script>
</body>
</html>"""
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(html.encode("utf-8"))


# ---------- open：一键打开，随关随停 ----------
class QServer(ThreadingHTTPServer):
    # Windows 上 SO_REUSEADDR 允许两个进程同时绑同一端口（HTTP 请求随机落到旧进程，
    # 新端点 /status.json 静默 404→回落 HTML）。关掉复用：第二个绑定直接 EADDRINUSE 失败。
    allow_reuse_address = False
    daemon_threads = True

    def shutdown(self):
        """停止服务。"""
        self.server_close()
        super().shutdown()


def find_free_port(start, end=8790):
    for p in range(start, end + 1):
        import socket
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    return None


def tegula_alive(port):
    """该端口上是否已是一个活着的方寸看板（防止多开、也避免误杀别人的服务）。"""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/ping", timeout=1.5) as r:
            return r.status == 200
    except Exception:
        return False


def find_edge():
    for p in (
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ):
        if os.path.exists(p):
            return p
    return None


def cmd_open(args):
    """双击入口：服务随进程起，pywebview 原生窗口打开，窗口全关服务自退。"""
    port = args.port
    reuse = False
    if tegula_alive(port):
        reuse = True
    else:
        free = find_free_port(port)
        if free is None:
            print(f"[错误] {port}-8790 端口均被占用。")
            return
        port = free

    if reuse:
        # 已有看板在跑：直接唤窗（新建一个 webview 窗口连到同一端口）
        import webview
        webview.create_window("方寸 tegula", f"http://127.0.0.1:{port}/",
                              width=1280, height=860, min_size=(1024, 640))
        webview.start()
        return

    # 后台启动 HTTP 服务
    srv = QServer(("127.0.0.1", port), Handler)
    server_thread = threading.Thread(target=srv.serve_forever, daemon=True)
    server_thread.start()
    # 等待服务就绪
    for _ in range(20):
        time.sleep(0.5)
        if tegula_alive(port):
            break

    import webview
    webview.create_window("方寸 tegula", f"http://127.0.0.1:{port}/",
                          width=1280, height=860, min_size=(1024, 640))
    webview.start()
    # 窗口关闭后停止服务
    srv.shutdown()


# ---------- doctor：文件健康自检 ----------
def check_registry_consistency():
    """检查 registry.yaml 与 Hermes 侧项目的一致性。只报告，不自动修复。

    三项检查：
    1. 路径有效性：每个 registry 条目的 repo 是否存在
    2. 待注册项：registry 中有但 Hermes 中没有
    3. 漂移项：Hermes 中有但 registry 中没有（手动创建/已删除残留）
    """
    issues = []
    reg = load_all_projects()

    # 1. 路径有效性
    for p in reg:
        repo = p.get("repo", "")
        if repo and not os.path.isdir(repo):
            issues.append(f"[路径失效] {p.get('id', '?')} 的 repo 不存在：{repo}")

    # 2 & 3. 与 Hermes 侧对比
    try:
        out = subprocess.run(["hermes", "project", "list"],
                             capture_output=True, text=True, timeout=30,
                             creationflags=_NOWIN)
    except Exception as e:
        issues.append(f"[hermes 不可达] 无法获取 Hermes 项目列表：{e}")
        return issues

    hermes_ids = set()
    for line in out.stdout.splitlines():
        s = line.strip()
        if s.startswith("*"):
            s = s[1:].strip()
        parts = s.split()
        if parts:
            hermes_ids.add(parts[0])

    # registry → Hermes：缺少
    for p in reg:
        pid = p.get("id", "")
        if pid and pid not in hermes_ids:
            issues.append(f"[待注册] {pid} 在 registry 中但未注册到 Hermes（ tegula hermes-sync 可注册）")

    # Hermes → registry：漂移
    reg_ids = {p.get("id", "") for p in reg}
    for hpid in hermes_ids:
        if hpid not in reg_ids:
            issues.append(f"[漂移] {hpid} 在 Hermes 中存在但不在 registry 中（可能手动创建或已删除残留）")

    return issues


def cmd_doctor(args):
    """只读体检：frontmatter 可解析性 / 锁版本字段 / 阻塞引用完整性 / registry 一致性。0 error 才算健康。"""
    errs, warns, n_active, n_meta = [], [], 0, 0
    ids = set()
    for base in _all_task_dirs():
        if not os.path.isdir(base):
            continue
        for fn0 in sorted(os.listdir(base)):
            if not TASKFN.match(fn0):
                if fn0.endswith(".md") and not fn0.startswith("_"):
                    n_meta += 1          # 简报/清单等非任务文件，不体检也不算错
                continue
            tid = fn0[:-3]
            d = parse_task(os.path.join(base, fn0))
            if d is None:
                errs.append(f"{tid}: frontmatter 无法解析")
                continue
            ids.add(tid)
            if base == TASK_DIR:
                n_active += 1
            if not str(d.get("创建") or "").strip():
                warns.append(f"{tid}: 缺 创建 时间戳")
            if not str(d.get("更新") or "").strip():
                warns.append(f"{tid}: 缺 更新 时间戳（乐观锁回退 mtime）")
            for dep in [str(x).strip() for x in (d.get("阻塞") or []) if str(x).strip()]:
                if dep == tid:
                    errs.append(f"{tid}: 阻塞自己（自环）")
                elif dep not in ids and locate_task(dep) is None:
                    errs.append(f"{tid}: 阻塞引用不存在的任务 {dep}")

    # --- registry 一致性检查 ---
    reg_issues = check_registry_consistency()
    for ri in reg_issues:
        if ri.startswith("[hermes 不可达]"):
            errs.append(ri)
        else:
            warns.append(ri)

    print(f"doctor：扫描 {len(ids)} 个任务（活跃 {n_active}，含归档/回收站）"
          + (f"，跳过 {n_meta} 个非任务 md" if n_meta else ""))
    for e in errs:
        print(f"[error] {e}")
    for w in warns:
        print(f"[warn]  {w}")
    if not errs and not warns:
        print("全部健康。")
    return 2 if errs else 0


# ---------- 项目状态感知（P0）----------

def _relative_time(days):
    """将天数差转成人类可读的相对时间。"""
    if days is None:
        return "无"
    if days == 0:
        return "今天"
    if days == 1:
        return "昨天"
    if days < 7:
        return f"{days}天前"
    if days < 30:
        return f"{days // 7}周前"
    return f"{days // 30}月前"


def _scan_git_remote(repo):
    """扫描远程仓库状态。返回 dict，无 git/无远程时返回最小信息。"""
    remote = {
        "has_git": False,
        "has_remote": False,
        "remote_url": None,
        "upstream_branch": None,
        "ahead": 0,
        "behind": 0,
        "last_push_days": None,
        "unpushed_commits": 0,
    }

    if not repo or not os.path.isdir(os.path.join(repo, ".git")):
        return remote

    remote["has_git"] = True

    # 检查是否有远程
    try:
        r = subprocess.run(["git", "remote", "get-url", "origin"],
                            capture_output=True, text=True, timeout=10, cwd=repo,
                            creationflags=_NOWIN)
        if r.returncode != 0 or not r.stdout.strip():
            return remote
        remote["has_remote"] = True
        remote["remote_url"] = r.stdout.strip()
    except Exception:
        return remote

    # 检查上游分支
    try:
        r = subprocess.run(["git", "rev-parse", "--abbrev-ref", "@{u}"],
                            capture_output=True, text=True, timeout=10, cwd=repo,
                            creationflags=_NOWIN)
        if r.returncode == 0 and r.stdout.strip():
            remote["upstream_branch"] = r.stdout.strip()
    except Exception:
        pass

    # ahead/behind
    try:
        r = subprocess.run(["git", "rev-list", "--left-right", "--count", "@{u}...HEAD"],
                            capture_output=True, text=True, timeout=10, cwd=repo,
                            creationflags=_NOWIN)
        if r.returncode == 0 and r.stdout.strip():
            parts = r.stdout.strip().split()
            if len(parts) == 2:
                remote["behind"] = int(parts[0])
                remote["ahead"] = int(parts[1])
                remote["unpushed_commits"] = int(parts[1])
    except Exception:
        pass

    # 最后推送时间（通过 reflog 或 push 引用）
    try:
        r = subprocess.run(
            ["git", "for-each-ref", "--format=%(push:committerdate:unix)",
             "refs/heads"],
            capture_output=True, text=True, timeout=10, cwd=repo,
            creationflags=_NOWIN)
        if r.returncode == 0 and r.stdout.strip() and r.stdout.strip() != "0":
            push_ts = int(r.stdout.strip())
            remote["last_push_days"] = int((time.time() - push_ts) / 86400)
    except Exception:
        pass

    return remote


def scan_project_status(p):
    """扫描单个项目，返回结构化状态 dict。

    released 段的项目直接跳过扫描，健康度标 released。
    感知层（仅非 released）：
    - git 活动：近 7 天提交数、最后提交天数、未提交改动数、当前分支
    - 任务关联：活跃任务数、进行中/待办/阻塞数、阻塞任务标题
    - 增强信息：进行中任务详情、阻塞详情、卡片建议
    - 远程仓库：是否关联远程、分支跟踪、ahead/behind、最后推送时间
    """
    pid = p.get("id", "")
    repo = p.get("repo", "")
    name = p.get("name", pid)
    is_released = p.get("_released", False)

    s = {
        "id": pid,
        "name": name,
        "repo": repo,
        "released": is_released,
        "git": {"recent_commits": 0, "last_commit_days": None, "uncommitted": 0, "active_branch": None},
        "tasks": {"total": 0, "active": 0, "blocked": 0, "blocked_names": [], "pending": 0, "done": 0},
        "health": "released" if is_released else "unknown",
        "summary": "已发布 / 无后续计划" if is_released else "",
        # 增强字段
        "active_tasks": [],       # 进行中任务列表 [{id, title, plan_done, plan_total}]
        "blocked_detail": [],     # 阻塞详情 [{id, title, blocker_title}]
        "suggestions": [],        # 卡片内嵌建议
        "remote": None,           # 远程仓库状态
    }

    if is_released:
        return s

    # --- git 活动 ---
    if repo and os.path.isdir(os.path.join(repo, ".git")):
        try:
            r = subprocess.run(["git", "log", "--since=7 days ago", "--oneline"],
                                capture_output=True, text=True, timeout=10, cwd=repo,
                                creationflags=_NOWIN)
            commits = [l for l in r.stdout.strip().splitlines() if l.strip()]
            s["git"]["recent_commits"] = len(commits)

            r = subprocess.run(["git", "log", "-1", "--format=%ct"],
                                capture_output=True, text=True, timeout=10, cwd=repo,
                                creationflags=_NOWIN)
            if r.stdout.strip():
                days_ago = int((time.time() - int(r.stdout.strip())) / 86400)
                s["git"]["last_commit_days"] = days_ago

            r = subprocess.run(["git", "status", "--porcelain"],
                                capture_output=True, text=True, timeout=10, cwd=repo,
                                creationflags=_NOWIN)
            changes = [l for l in r.stdout.strip().splitlines() if l.strip()]
            s["git"]["uncommitted"] = len(changes)

            r = subprocess.run(["git", "branch", "--show-current"],
                                capture_output=True, text=True, timeout=10, cwd=repo,
                                creationflags=_NOWIN)
            s["git"]["active_branch"] = r.stdout.strip()
        except Exception:
            pass

    # --- 远程仓库状态 ---
    s["remote"] = _scan_git_remote(repo)

    # --- 任务关联 ---
    for t in load_tasks(project=pid, view="active"):
        s["tasks"]["total"] += 1
        st = t.get("状态", "")
        tid = t.get("id", "")
        title = t.get("标题", tid)

        if st == "进行中":
            s["tasks"]["active"] += 1
            # 计算方案进度
            plan = t.get("方案", [])
            plan_total = len(plan)
            plan_done = sum(1 for p in plan if re.search(r'\[x\]', p, re.I))
            s["active_tasks"].append({
                "id": tid,
                "title": title,
                "plan_done": plan_done,
                "plan_total": plan_total,
            })
        elif st == "待办":
            s["tasks"]["pending"] += 1
        elif st in ("完成", "驳回"):
            s["tasks"]["done"] += 1

        blk = blockers_of(tid)
        if blk:
            s["tasks"]["blocked"] += 1
            for b in blk:
                btitle = b.get("标题") or b.get("id", "")
                s["tasks"]["blocked_names"].append(btitle)
                s["blocked_detail"].append({
                    "id": tid,
                    "title": title,
                    "blocker_title": btitle,
                })

    # --- 健康度判定 ---
    git, tasks = s["git"], s["tasks"]
    if tasks["blocked"] > 0:
        s["health"] = "stuck"
    elif git["recent_commits"] > 0 or tasks["active"] > 0:
        s["health"] = "active"
    elif tasks["total"] == 0 and (git["last_commit_days"] is None or git["last_commit_days"] > 30):
        s["health"] = "dormant"
    elif tasks["total"] > 0:
        s["health"] = "idle"
    else:
        s["health"] = "unknown"

    # --- 摘要 ---
    parts = [f"最近提交: {_relative_time(git['last_commit_days'])}"]
    parts.append(f"未提交改动: {git['uncommitted']}文件" if git["uncommitted"] else "未提交改动: 0")

    if tasks["blocked"] > 0:
        bn = "、".join(tasks["blocked_names"][:3])
        if len(tasks["blocked_names"]) > 3:
            bn += f" 等{len(tasks['blocked_names'])}项"
        parts.append(f"阻塞: {bn}")
    else:
        parts.append("阻塞: 无")

    s["summary"] = "  ".join(parts)

    # --- 卡片内嵌建议 ---
    s["suggestions"] = suggest_actions(s)

    return s


def suggest_actions(s):
    """从单个项目状态推导出可执行建议（被动展示，不主动派活）。"""
    git, tasks = s["git"], s["tasks"]
    sugs = []

    if s["health"] == "stuck" and tasks["blocked_names"]:
        bn = tasks["blocked_names"][0]
        sugs.append(f"解除阻塞：「{bn}」完成后可解锁下游任务")

    if git["uncommitted"] > 5 and tasks["active"] == 0 and s["health"] != "released":
        sugs.append(f"整理 {git['uncommitted']} 个未提交改动：建「整理并提交」任务？")

    if s["health"] == "dormant" and tasks["total"] == 0:
        sugs.append("停滞 >30 天且无任务：建议标记 released 或建激活任务")

    if tasks["total"] > 0 and tasks["active"] == 0 and tasks["blocked"] == 0 and tasks["pending"] > 0:
        sugs.append(f"有 {tasks['pending']} 个待办但无进行中：可激活一项")

    return sugs


def suggest_cross_project(statuses):
    """跨项目建议：哪些该关注、哪些该激活。"""
    sugs = []
    stuck = [s for s in statuses if s["health"] == "stuck"]
    dormant = [s for s in statuses if s["health"] == "dormant"]
    uncommitted_heavy = [s for s in statuses
                         if s["git"]["uncommitted"] > 10 and s["health"] != "released"]

    if stuck:
        names = "、".join(s["name"] for s in stuck)
        sugs.append(f"优先处理卡住项目：{names}")

    if dormant:
        names = "、".join(s["name"] for s in dormant)
        sugs.append(f"长期停滞项目需决策（继续/挂起）：{names}")

    if uncommitted_heavy:
        names = "、".join(s["name"] for s in uncommitted_heavy)
        sugs.append(f"大量未提交改动需关注：{names}")

    return sugs


def find_timeout_tasks(threshold_hours=24):
    """查找进行中但超过 threshold_hours 未回写的任务。"""
    timeouts = []
    for t in load_tasks(view="active"):
        if t.get("状态") != "进行中":
            continue
        dispatched = t.get("派活时间")
        if not dispatched:
            continue
        try:
            ts = float(dispatched)
        except (ValueError, TypeError):
            continue
        hours = (time.time() - ts) / 3600
        if hours >= threshold_hours:
            timeouts.append({
                "id": t["id"],
                "title": t.get("标题", ""),
                "project": (t.get("项目") or ["?"])[0],
                "hours": int(hours),
            })
    timeouts.sort(key=lambda x: -x["hours"])
    return timeouts


def cmd_status(args):
    """显示项目健康状态：全部或指定项目。"""
    reg = load_all_projects()
    if not reg:
        print("registry.yaml 为空或不存在。")
        return

    target = getattr(args, "id", None)
    if target:
        reg = [p for p in reg if p.get("id") == target]
        if not reg:
            print(f"项目不存在: {target}")
            return

    statuses = [scan_project_status(p) for p in reg]

    if getattr(args, "format", "text") == "json":
        print(json.dumps(statuses, ensure_ascii=False, indent=2))
        return

    icons = {"active": "●", "stuck": "◎", "dormant": "○", "idle": "△", "unknown": "?", "released": "✅"}
    for s in statuses:
        print(f"{icons.get(s['health'], '?')} {s['name']:<14} {s['summary']}")

    # --- 超时预警 ---
    timeouts = find_timeout_tasks()
    if timeouts:
        print(f"\n⚠️ 超时未回写（>{24}h）：")
        for t in timeouts:
            print(f"  - {t['id']}《{t['title']}》{t['hours']}h")

    # --- 建议层 ---
    all_sugs = []
    for s in statuses:
        sugs = suggest_actions(s)
        for u in sugs:
            all_sugs.append(f"- {s['name']}：{u}")

    if len(statuses) > 1:
        cross = suggest_cross_project(statuses)
        for u in cross:
            all_sugs.append(f"- {u}")

    if all_sugs:
        print(f"\n💡 建议：")
        for u in all_sugs:
            print(f"  {u}")


def cmd_report(args):
    """生成项目状态报告文件（project-status.md）。"""
    reg = load_all_projects()
    if not reg:
        print("registry.yaml 为空或不存在。")
        return

    statuses = [scan_project_status(p) for p in reg]
    health_order = {"active": 0, "stuck": 1, "idle": 2, "dormant": 3, "unknown": 4}
    released = [s for s in statuses if s["health"] == "released"]
    active = [s for s in statuses if s["health"] != "released"]
    active.sort(key=lambda s: (health_order.get(s["health"], 5), s["name"]))

    brief = getattr(args, "brief", False)
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    lines = ["# 方寸项目状态报告", f"- 生成时间: {now}", f"- 活跃项目: {len(active)}", ""]

    if not brief and released:
        lines += [f"- 已发布: {len(released)}", ""]

    if not brief:
        lines += ["## 概览", "", "| 项目 | 健康度 | 最近提交 | 未提交改动 | 任务 | 阻塞 |",
                  "|------|--------|----------|------------|------|------|"]
        labels = {"active": "🟢 活跃", "stuck": "🔴 卡住", "dormant": "⚪ 停滞",
                  "idle": "🟡 空闲", "unknown": "❓ 未知", "released": "✅ 已发布"}
        for s in active:
            g, t = s["git"], s["tasks"]
            lc = _relative_time(g["last_commit_days"])
            lines.append(f"| {s['name']} | {labels.get(s['health'], '❓')} | {lc} | "
                         f"{g['uncommitted']}文件 | {t['total']}个 | {t['blocked']} |")
        lines.append("")

    if not brief:
        lines.append("## 详情")
    lines.append("")

    for s in active:
        if brief:
            icons = {"active": "🟢", "stuck": "🔴", "dormant": "⚪", "idle": "🟡", "unknown": "❓"}
            parts = [f"{icons.get(s['health'], '❓')} {s['name']}"]
            g, t = s["git"], s["tasks"]
            if g["last_commit_days"] is not None:
                parts.append(f"最近提交: {_relative_time(g['last_commit_days'])}")
            if g["uncommitted"]:
                parts.append(f"未提交: {g['uncommitted']}文件")
            if t["total"]:
                tp = []
                if t["active"]: tp.append(f"{t['active']}进行中")
                if t["pending"]: tp.append(f"{t['pending']}待办")
                if t["blocked"]: tp.append(f"{t['blocked']}阻塞")
                if t["done"]: tp.append(f"{t['done']}待验收")
                if tp:
                    parts.append(f"任务: {', '.join(tp)}")
            lines.append("- " + " | ".join(parts))
        else:
            lines += [f"### {s['name']} (`{s['id']}`)",
                      f"- 仓库: `{s['repo']}`",
                      f"- 分支: `{s['git']['active_branch'] or 'N/A'}`",
                      f"- 健康度: **{s['health']}**",
                      f"- {s['summary']}", ""]

    # --- 已发布项目（折叠/隔离）---
    if released:
        if brief:
            lines.append("")
            lines.append("---")
            lines.append("")
            for s in released:
                lines.append(f"✅ {s['name']} — {s['summary']}")
        else:
            lines += ["", "---", "", "## 已发布", ""]
            for s in released:
                lines.append(f"- **{s['name']}** — 已发布 / 无后续计划")

    out = os.path.join(ROOT, "project-status.md")
    if getattr(args, "output", None):
        out = args.output

    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"报告已生成: {out}")


# ---------- CLI ----------
def cmd_new(args):
    ok, tid = api_new({
        "标题": args.title,
        "项目": args.项目 or ["fangcun-base"],
        "状态": args.状态,
        "批次": args.批次,
        "截止": args.截止,
        "优先级": args.优先级,
        "来源": args.来源,
        "指派": args.指派,
        "验收": args.验收,
    })
    print(f"已创建任务: {tid}")


# ---------- MCP 只读接口（P3）：零依赖手写 JSON-RPC 2.0 over stdio ----------
MCP_PROTOCOL_VERSION = "2024-11-05"
# 安全红线：只读。edit/delete/dispatch/new 一律不暴露。
MCP_TOOLS = [
    {"name": "list_tasks", "description": "列出方寸任务（可按状态/项目/标签过滤）",
     "inputSchema": {"type": "object", "properties": {
         "status": {"type": "string", "description": "任务状态，如 待办/进行中/待验收/完成"},
         "project": {"type": "string", "description": "项目 id，如 fangcun-base"},
         "tag": {"type": "string", "description": "标签名"},
         "view": {"type": "string", "description": "active(默认)/archive/trash"}},
         "required": []}},
    {"name": "get_task", "description": "按 id 获取任务详情",
     "inputSchema": {"type": "object", "properties": {
         "id": {"type": "string", "description": "任务 id，如 task-20260911-001"}},
         "required": ["id"]}},
    {"name": "get_project_status", "description": "获取项目健康度（git 活动 + 任务关联 + 阻塞）",
     "inputSchema": {"type": "object", "properties": {
         "id": {"type": "string", "description": "项目 id，留空返回全部"}},
         "required": []}},
    {"name": "list_projects", "description": "列出 registry 中所有项目",
     "inputSchema": {"type": "object", "properties": {}, "required": []}},
    {"name": "search_tasks", "description": "全文搜索任务（标题/方案/结果记录）",
     "inputSchema": {"type": "object", "properties": {
         "query": {"type": "string", "description": "搜索关键词"}},
         "required": ["query"]}},
]
MCP_HIDDEN_KEYS = {"附言", "_body", "_extra", "_unknown", "_file", "prompt"}


def _mcp_task_view(t):
    """任务对外视图：过滤敏感字段（附言/内部键），只留可公开的只读信息。"""
    out = {}
    for k, v in (t or {}).items():
        if k in MCP_HIDDEN_KEYS or str(k).startswith("_"):
            continue
        out[k] = v
    plan = [str(s) for s in (t.get("方案") or [])]
    total = len([s for s in plan if re.search(r"\[[ xX]\]", s)])
    done = len([s for s in plan if re.search(r"\[x\]", s, re.I)])
    out["方案进度"] = f"{done}/{total}" if total else ""
    return out


def mcp_list_tasks(params):
    p = params or {}
    tid = str(p.get("id") or "").strip()
    if tid:
        return mcp_get_task(p)
    tasks = load_tasks(p.get("project") or None, p.get("view") or "active")
    if p.get("status"):
        tasks = [t for t in tasks if t.get("状态") == p["status"]]
    if p.get("tag"):
        tasks = [t for t in tasks if p["tag"] in (t.get("标签") or [])]
    return [_mcp_task_view(t) for t in tasks]


def mcp_get_task(params):
    tid = str((params or {}).get("id") or "").strip()
    if not tid:
        return {"error": "缺少 id"}
    fn = locate_task(tid)
    if not fn:
        return {"error": f"任务不存在: {tid}"}
    d = parse_task(fn)
    if not d:
        return {"error": f"解析失败: {tid}"}
    return _mcp_task_view(d)


def mcp_get_project_status(params):
    pid = str((params or {}).get("id") or "").strip()
    reg = load_all_projects()
    if pid:
        reg = [p for p in reg if p.get("id") == pid]
        if not reg:
            return {"error": f"项目不存在: {pid}"}
    out = []
    for p in reg:
        s = scan_project_status(p)
        out.append({k: v for k, v in s.items() if k != "suggestions"})
    return out[0] if pid else out


def mcp_list_projects(params):
    return [{"id": p.get("id", ""), "name": p.get("name", ""), "repo": p.get("repo", ""),
             "released": bool(p.get("_released"))} for p in load_all_projects()]


def mcp_search_tasks(params):
    q = str((params or {}).get("query") or "").strip().lower()
    if not q:
        return []
    hits = []
    for t in load_tasks(None, "active") + load_tasks(None, "archive"):
        hay = " ".join([str(t.get("标题") or ""), str(t.get("id") or ""),
                        " ".join(t.get("项目") or []), " ".join(t.get("标签") or []),
                        " ".join(t.get("方案") or []), str(t.get("结果记录") or "")]).lower()
        if q in hay:
            hits.append(_mcp_task_view(t))
    return hits


MCP_METHODS = {"list_tasks": mcp_list_tasks, "get_task": mcp_get_task,
               "get_project_status": mcp_get_project_status,
               "list_projects": mcp_list_projects, "search_tasks": mcp_search_tasks}


def mcp_handle(req):
    """处理一条 JSON-RPC 请求，返回响应 dict（通知类返回 None）。"""
    rid = req.get("id")
    method = req.get("method")
    params = req.get("params") or {}
    def ok(result):   return {"jsonrpc": "2.0", "id": rid, "result": result}
    def err(code, msg): return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": msg}}
    if method == "initialize":
        return ok({"protocolVersion": MCP_PROTOCOL_VERSION,
                   "capabilities": {"tools": {}},
                   "serverInfo": {"name": "tegula", "version": "1.0.0"}})
    if method in ("notifications/initialized", "initialized"):
        return None                       # 通知无响应
    if method == "ping":
        return ok({})
    if method == "tools/list":
        return ok({"tools": MCP_TOOLS})
    if method == "tools/call":
        name = params.get("name")
        fn = MCP_METHODS.get(name)
        if not fn:
            return err(-32602, f"未知工具: {name}（仅支持只读工具：{'/'.join(MCP_METHODS)}）")
        try:
            result = fn(params.get("arguments") or {})
        except Exception as e:
            return err(-32603, f"工具执行失败: {e}")
        return ok({"content": [{"type": "text",
                                "text": json.dumps(result, ensure_ascii=False, indent=2)}]})
    return err(-32601, f"未知方法: {method}")


def cmd_mcp(args):
    """MCP server：从 stdin 逐行读 JSON-RPC，向 stdout 写响应（阻塞式，供外部 AI 工具调用）。
    只读：任何写操作（edit/delete/dispatch/new）都不在此暴露。"""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            print(json.dumps({"jsonrpc": "2.0", "id": None,
                              "error": {"code": -32700, "message": "JSON 解析失败"}},
                             ensure_ascii=False), flush=True)
            continue
        try:
            resp = mcp_handle(req if isinstance(req, dict) else {})
        except Exception as e:
            resp = {"jsonrpc": "2.0", "id": req.get("id") if isinstance(req, dict) else None,
                    "error": {"code": -32603, "message": str(e)}}
        if resp is not None:
            print(json.dumps(resp, ensure_ascii=False), flush=True)


def cmd_startpage(args):
    """打开全项目统一启动台（动态读取 registry.yaml）"""
    port = args.port
    if not tegula_alive(port):
        print(f"[提示] 方寸看板未运行，先启动：python tegula.py serve")
        return
    url = f"http://127.0.0.1:{port}/startpage"
    try:
        subprocess.Popen(["cmd", "/c", "start", url])
        print(f"启动台已打开: {url}")
    except Exception as e:
        print(f"打开失败: {e}")


def cmd_serve(args):
    port = args.port
    if tegula_alive(port):
        print(f"[提示] 方寸看板已在 http://127.0.0.1:{port}/ 运行（单飞保护，不再起第二个）。")
        return
    try:
        srv = QServer(("127.0.0.1", port), Handler)
    except OSError as e:
        print(f"[错误] 端口 {port} 被其他程序占用（非方寸看板）：{e}")
        print("       可指定别的端口：python tegula.py serve --port 8754")
        return
    print(f"方寸看板已启动: http://127.0.0.1:{port}/  (Ctrl+C 退出)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


def main():
    p = argparse.ArgumentParser(prog="tegula", description="方寸 — 本地优先多 agent 任务地图")
    sub = p.add_subparsers(dest="cmd")
    n = sub.add_parser("new", help="新建任务")
    n.add_argument("--title", required=True)
    n.add_argument("--项目", "--project", dest="项目", nargs="*", default=[])
    n.add_argument("--状态", default="")
    n.add_argument("--批次", default="")
    n.add_argument("--截止", default="")
    n.add_argument("--优先级", default="", choices=["", "高", "中", "低"])
    n.add_argument("--来源", default="human")
    n.add_argument("--指派", default="hermes")
    n.add_argument("--验收", default="human")
    n.set_defaults(func=cmd_new)
    s = sub.add_parser("serve", help="启动本地看板视图（零依赖）")
    s.add_argument("--port", type=int, default=8753)
    s.set_defaults(func=cmd_serve)
    sp = sub.add_parser("startpage", help="打开全项目统一启动台（动态读取 registry.yaml）")
    sp.add_argument("--port", type=int, default=8753)
    sp.set_defaults(func=cmd_startpage)
    o = sub.add_parser("open", help="一键打开：服务随进程起，Edge 应用窗口打开，关窗自退")
    o.add_argument("--port", type=int, default=8753)
    o.add_argument("--wait", type=int, default=15, help="窗口端冷静期秒数（首个请求前的宽限）")
    o.set_defaults(func=cmd_open)
    dp = sub.add_parser("dispatch", help="派活：默认模式 B（只生成命令，不拉起），--go 保留旧自动拉起行为")
    dp.add_argument("id", nargs="?", default=None, help="任务 id（可选）")
    dp.add_argument("--all", action="store_true", help="派全部待办（每个一个新终端窗口）")
    dp.add_argument("--preview", action="store_true", help="打印将下发给执行方的完整任务书，不拉起")
    dp.add_argument("--msg", "--附言", dest="msg", default="",
                    help="本次派单的精确指令，先写入附言字段再随任务书下发（需指定 id）")
    dp.add_argument("--force", action="store_true", help="进行中任务确要重派时放行（双会话风险自担）")
    dp.add_argument("--go", action="store_true", help="自动拉起 hermes chat（旧行为，默认只生成命令）")
    dp.set_defaults(func=cmd_dispatch)
    hs = sub.add_parser("hermes-sync", help="把 registry.yaml 里的项目注册进 Hermes（幂等）")
    hs.set_defaults(func=cmd_hermes_sync)
    ho = sub.add_parser("hermes-open", help="为某任务生成在仓库里派活给 Hermes 的命令")
    ho.add_argument("id", help="任务 id，如 task-20260828-003")
    ho.add_argument("--go", action="store_true", help="真正拉起 hermes chat")
    ho.set_defaults(func=cmd_hermes_open)
    wb = sub.add_parser("workbench", help="工作台：统一管理所有项目的本地服务端口")
    wb.add_argument("action", nargs="?", default="list", choices=["list", "start", "stop"],
                      help="操作：list（列出）/ start（启动）/ stop（停止）")
    wb.add_argument("--port", type=int, default=None, help="指定端口号（start/stop 时必填）")
    wb.set_defaults(func=cmd_workbench)
    dn = sub.add_parser("done", help="执行方完工回写：填结果记录并置为待验收")
    dn.add_argument("id", help="任务 id，如 task-20260828-003")
    dn.add_argument("--结果", "--result", dest="结果", default="", help="一句话结果，追加到结果记录")
    dn.add_argument("--证据", "--evidence", dest="证据", default="",
                    help="改动清单/验证输出的路径，追加为「证据：…」行，供验收时查看实物")
    dn.add_argument("--expected-mtime", dest="expected_mtime", default=None,
                    help="可选：期望的文件 mtime（防覆盖并发修改）")
    dn.set_defaults(func=cmd_done)
    bk = sub.add_parser("backup", help="备份 task-data/ 到 backups/（zip，保留最近 10 份）")
    bk.set_defaults(func=cmd_backup)
    dc = sub.add_parser("doctor", help="文件健康自检：frontmatter/锁字段/阻塞引用（只读）")
    dc.set_defaults(func=cmd_doctor)
    st = sub.add_parser("status", help="项目健康状态：git 活动 + 任务关联")
    st.add_argument("id", nargs="?", default=None, help="项目 id（可选，不指定则显示全部）")
    st.add_argument("--format", choices=["text", "json"], default="text", help="输出格式")
    st.set_defaults(func=cmd_status)
    rp = sub.add_parser("report", help="生成项目状态报告（project-status.md）")
    rp.add_argument("--brief", action="store_true", help="简报模式（单文件列表，适合 cron 推送）")
    rp.add_argument("--output", default=None, help="输出文件路径（默认 project-status.md）")
    rp.set_defaults(func=cmd_report)
    mc = sub.add_parser("mcp", help="MCP 只读接口：JSON-RPC 2.0 over stdio（供外部 AI 工具读取）")
    mc.set_defaults(func=cmd_mcp)
    args = p.parse_args()
    if not getattr(args, "func", None):
        p.print_help()
        return
    args.func(args)


if __name__ == "__main__":
    main()
