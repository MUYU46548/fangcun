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
        elif v.startswith("{") and v.endswith("}"):
            # JSON object (for plan field)
            try:
                d[k] = json.loads(v)
            except:
                d[k] = v.strip("'\"")
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


MANAGED_KEYS = {"id", "标题", "项目", "状态", "批次", "截止", "优先级", "创建", "更新", "来源", "指派", "验收", "阻塞", "附言", "资源", "方案", "结果记录", "派活时间", "标签", "验收清单", "预算", "实际成本", "agent", "type", "plan"}


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
    if tg:
        lines.append(f"标签: [{', '.join(str(x) for x in tg)}]")
    blk = d.get("阻塞") or []
    if blk:
        lines.append(f"阻塞: [{', '.join(str(x) for x in blk)}]")
    fy = str(d.get("附言") or "").strip()
    if fy:
        lines.append(f"附言: {fy}")
    pd = str(d.get("派活时间") or "").strip()
    if pd:
        lines.append(f"派活时间: {pd}")
    # Plan-specific: type and plan fields
    tp = d.get("type", "")
    if tp:
        lines.append(f"type: {tp}")
    plan_data = d.get("plan")
    if plan_data:
        # plan_data 是 dict，序列化为 JSON 字符串
        plan_json = json.dumps(plan_data, ensure_ascii=False)
        lines.append(f"plan: {plan_json}")
    for k, v in unknown.items():
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
        lines.append(extra)
    return "\n".join(lines) + "\n"


def write_task_file(path, d):
    """原子写：临时文件 + os.replace。"""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(render_task(d))
    os.replace(tmp, path)


# ---------- 自然语言查询（搜索框语义解析） ----------
def parse_natural_query(q):
    """解析自然语言查询，返回过滤后的任务列表。

    支持语法：
      - 精确搜索：标题/标签/项目/id 匹配
      - 状态过滤：待办、进行中、待验收、完成、驳回
      - 优先级过滤：高/中/低
      - 标签过滤：#标签名
      - 项目过滤：@项目id
      - 时间：超时的、卡住的
      - 组合：待办 高、#bug 待办
    """
    q = (q or "").strip()
    if not q:
        return None, "查询为空"

    # 提取标签过滤
    tags = re.findall(r'#(\S+)', q)
    # 提取项目过滤
    projects = re.findall(r'@(\S+)', q)
    # 移除标签/项目标记后的剩余文本
    remaining = re.sub(r'[#@]\S+', '', q).strip()

    # 状态关键词
    status_map = {
        "待办": "待办", "进行中": "进行中", "待验收": "待验收",
        "完成": "完成", "驳回": "驳回", "草稿": "草稿", "待审批": "待审批",
    }
    # 优先级关键词
    prio_map = {"高": "高", "中": "中", "低": "低", "高优先级": "高", "中优先级": "中", "低优先级": "低"}

    # 从剩余文本中提取状态和优先级
    target_status = None
    target_prio = None
    for kw, val in status_map.items():
        if kw in remaining:
            target_status = val
            remaining = remaining.replace(kw, "").strip()
            break
    for kw, val in prio_map.items():
        if kw in remaining:
            target_prio = val
            remaining = remaining.replace(kw, "").strip()
            break

    # 特殊查询
    special = None
    if "超时" in remaining or "超期" in remaining:
        special = "timeout"
        remaining = remaining.replace("超时", "").replace("超期", "").strip()
    elif "卡住" in remaining or "阻塞" in remaining:
        special = "blocked"
        remaining = remaining.replace("卡住", "").replace("阻塞", "").strip()

    # 剩余文本作为标题模糊匹配
    title_q = remaining.strip()

    # 执行过滤
    tasks = load_tasks(view="active")

    # 标签过滤
    if tags:
        tasks = [t for t in tasks if all(tag in (t.get("标签") or []) for tag in tags)]

    # 项目过滤
    if projects:
        tasks = [t for t in tasks if all(p in (t.get("项目") or []) for p in projects)]

    # 状态过滤
    if target_status:
        tasks = [t for t in tasks if t.get("状态") == target_status]

    # 优先级过滤
    if target_prio:
        tasks = [t for t in tasks if t.get("优先级") == target_prio]

    # 特殊过滤
    if special == "timeout":
        tasks = [t for t in tasks if t.get("stale")]
    elif special == "blocked":
        tasks = [t for t in tasks if t.get("阻塞") and any(
            b for b in t.get("阻塞", [])
            if locate_task(b) and parse_task(locate_task(b)) and parse_task(locate_task(b)).get("状态") not in ("完成", "驳回")
        )]

    # 标题模糊匹配
    if title_q:
        tasks = [t for t in tasks if title_q.lower() in (t.get("标题") or "").lower()
                 or title_q.lower() in (t.get("id") or "").lower()]

    return tasks, None


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
        # 阶段门控：验收清单检查
        checklist = d.get("验收清单") or []
        if checklist:
            unmet = [item for item in checklist if not str(item).strip().startswith(("[x]", "[X]", "✓", "✅"))]
            if unmet:
                unmet_str = "、".join(str(u) for u in unmet[:5])
                return False, f"验收清单有 {len(unmet)} 项未通过（{unmet_str}），请先完成或更新验收清单"
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


# ---------- 阶段门控（gate）：验收清单管理 ----------
_GATES = {}  # 内存中的门控状态 {gate_id: {title, items, status, conclusion}}


def gate_open(gate_id, title, items=None, stage=None):
    """创建验收门。items 为验收项列表，每项为字符串。"""
    if not gate_id or not isinstance(gate_id, str):
        return False, "gate_id 必须是非空字符串"
    _GATES[gate_id] = {
        "title": title or gate_id,
        "items": items or [],
        "stage": stage,
        "status": "open",
        "conclusion": None,
        "created_at": _now_ts(),
    }
    return True, f"gate {gate_id} opened"


def gate_check(gate_id, items):
    """检查验收门。items 为完整验收项列表，每项为 met/unmet/n/a + evidence。"""
    g = _GATES.get(gate_id)
    if not g:
        return False, f"gate {gate_id} not found", None
    if g["status"] == "closed":
        return False, f"gate {gate_id} is closed", None
    if not items:
        return False, "items 不能为空", None
    unmet = [i for i in items if i.get("status") == "unmet"]
    if unmet:
        g["status"] = "blocked"
        g["conclusion"] = "blocked"
        unmet_names = "、".join(i.get("name", "?") for i in unmet[:5])
        return True, f"BLOCKED: {len(unmet)} 项未通过（{unmet_names}）", g
    g["status"] = "passed"
    g["conclusion"] = "passed"
    return True, "PASSED", g


def gate_list():
    """列出所有验收门。"""
    return list(_GATES.values())


def gate_close(gate_id, reason=""):
    """关闭验收门。"""
    g = _GATES.get(gate_id)
    if not g:
        return False, f"gate {gate_id} not found"
    g["status"] = "closed"
    g["conclusion"] = "closed"
    return True, f"gate {gate_id} closed"


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


# ---------- 规划（Plan）----------

def _parse_decision_points(plan_text):
    """从正文解析决策点（## 决策点 小节）。
    
    格式：
    ## 决策点
    ### dp_001
    - 问题: xxx
    - 选项: A / B / C
    - 状态: pending
    - 已选: 
    - 决策时间: 
    """
    decisions = []
    if not plan_text:
        return decisions
    # 按 ### 分割
    sections = re.split(r'^###\s+', plan_text, flags=re.M)
    for sec in sections[1:]:  # 跳过第一个空段
        lines = sec.strip().splitlines()
        if not lines:
            continue
        dp_id = lines[0].strip()
        dp = {'id': dp_id, 'question': '', 'options': [], 'status': 'pending', 'chosen': '', 'decided_at': ''}
        current_key = None
        for line in lines[1:]:
            m = re.match(r'^-\s+(\w+):\s*(.*)$', line)
            if m:
                key, val = m.group(1), m.group(2).strip()
                current_key = key
                if key == '问题':
                    dp['question'] = val
                elif key == '选项':
                    dp['options'] = [x.strip() for x in val.split('/') if x.strip()]
                elif key == '状态':
                    dp['status'] = val
                elif key == '已选':
                    dp['chosen'] = val
                elif key == '决策时间':
                    dp['decided_at'] = val
            elif current_key == '选项' and line.strip().startswith('-'):
                dp['options'].append(line.strip()[1:].strip())
        decisions.append(dp)
    return decisions


def _render_decision_points(decisions):
    """渲染决策点回正文。"""
    if not decisions:
        return ""
    lines = ["", "## 决策点"]
    for dp in decisions:
        lines.append(f"### {dp.get('id', 'unknown')}")
        lines.append(f"- 问题: {dp.get('question', '')}")
        lines.append(f"- 选项: {' / '.join(dp.get('options', []))}")
        lines.append(f"- 状态: {dp.get('status', 'pending')}")
        lines.append(f"- 已选: {dp.get('chosen', '')}")
        lines.append(f"- 决策时间: {dp.get('decided_at', '')}")
    return "\n".join(lines)


def api_plan_new(fields):
    """创建规划任务。
    
    fields: 标题, 项目, 目标, 里程碑(JSON字符串), 决策点(JSON字符串), etc.
    返回: (ok, tid_or_msg)
    """
    os.makedirs(TASK_DIR, exist_ok=True)
    tid = gen_id()
    
    # 解析里程碑
    milestones_raw = fields.get('里程碑', '[]')
    try:
        if isinstance(milestones_raw, str):
            milestones = json.loads(milestones_raw)
        else:
            milestones = milestones_raw
    except:
        milestones = []
    
    # 解析决策点
    decisions_raw = fields.get('决策点', '[]')
    try:
        if isinstance(decisions_raw, str):
            decisions = json.loads(decisions_raw)
        else:
            decisions = decisions_raw
    except:
        decisions = []
    
    # 确保每个决策点都有必要字段
    for i, dp in enumerate(decisions):
        if 'id' not in dp:
            dp['id'] = f'dp_{i+1:03d}'
        if 'question' not in dp:
            dp['question'] = ''
        if 'options' not in dp:
            dp['options'] = []
        if 'status' not in dp:
            dp['status'] = 'pending'
        if 'chosen' not in dp:
            dp['chosen'] = ''
        if 'decided_at' not in dp:
            dp['decided_at'] = ''
    
    # 解析风险
    risks_raw = fields.get('风险', '[]')
    try:
        if isinstance(risks_raw, str):
            risks = json.loads(risks_raw)
        else:
            risks = risks_raw
    except:
        risks = []
    
    objective = fields.get('目标', '')
    status = fields.get('plan_status', 'draft')
    
    d = {
        "id": tid,
        "标题": fields.get('标题') or "新规划",
        "项目": fields.get('项目', ['fangcun-base']),
        "状态": "草稿",
        "批次": fields.get('批次', ''),
        "截止": fields.get('截止', ''),
        "优先级": fields.get('优先级', ''),
        "标签": fields.get('标签', []),
        "阻塞": [],
        "附言": fields.get('附言', ''),
        "来源": "human",
        "指派": "human",
        "验收": "human",
        "资源": {
            "资料": fields.get('资料', ''),
            "工具": [],
        },
        "方案": [f"- [ ] 确认规划目标与约束", f"- [ ] 完成决策点，明确方向"],
        "结果记录": "",
        "创建": _now_ts(),
        "更新": _now_ts(),
        # Plan-specific fields
        "type": "plan",
        "plan": {
            "objective": objective,
            "status": status,  # draft/active/achieved/abandoned
            "milestones": milestones,
            "decisions": decisions,
            "risks": risks,
        }
    }
    
    # 生成带决策点的正文
    decision_text = _render_decision_points(decisions)
    milestone_lines = []
    if milestones:
        milestone_lines = ["", "## 里程碑"]
        for ms in milestones:
            milestone_lines.append(f"- {ms.get('name', '')} (截止: {ms.get('deadline', '未设定')})")
    risk_lines = []
    if risks:
        risk_lines = ["", "## 风险"]
        for r in risks:
            risk_lines.append(f"- {r}")
    
    extra_parts = [decision_text, "\n".join(milestone_lines) if milestone_lines else "", "\n".join(risk_lines) if risk_lines else ""]
    d["_extra"] = "\n".join(x for x in extra_parts if x).strip()
    
    write_task_file(os.path.join(TASK_DIR, tid + ".md"), d)
    return True, tid


def api_plan_decide(tid, dp_id, choice, note=""):
    """对规划的某个决策点做决策。
    
    返回: (ok, msg)
    """
    fn = locate_task(tid)
    if not fn:
        return False, f"任务不存在: {tid}"
    d = parse_task(fn)
    if not d:
        return False, "解析失败"
    if d.get("type") != "plan":
        return False, f"任务 {tid} 不是规划"
    
    plan = d.get("plan")
    if not plan:
        return False, "规划数据缺失"
    
    decisions = plan.get("decisions", [])
    found = False
    for dp in decisions:
        if dp['id'] == dp_id:
            dp['status'] = 'decided'
            dp['chosen'] = choice
            dp['decided_at'] = _now_ts()
            found = True
            break
    
    if not found:
        return False, f"决策点 {dp_id} 不存在"
    
    # 检查是否所有决策点都已完成
    all_decided = all(dp['status'] in ('decided', 'skipped') for dp in decisions)
    if all_decided and plan.get('status') == 'draft':
        plan['status'] = 'active'
        d["状态"] = "进行中"
    
    d["plan"] = plan
    d["更新"] = _now_ts()
    
    # 更新正文中的决策点
    d["_extra"] = _render_decision_points(decisions)
    # 追加里程碑/风险回来
    milestones = plan.get("milestones", [])
    risks = plan.get("risks", [])
    extra_parts = [d["_extra"]]
    if milestones:
        milestone_lines = ["", "## 里程碑"]
        for ms in milestones:
            milestone_lines.append(f"- {ms.get('name', '')} (截止: {ms.get('deadline', '未设定')})")
        extra_parts.append("\n".join(milestone_lines))
    if risks:
        risk_lines = ["", "## 风险"]
        for r in risks:
            risk_lines.append(f"- {r}")
        extra_parts.append("\n".join(risk_lines))
    d["_extra"] = "\n".join(x for x in extra_parts if x).strip()
    
    write_task_file(fn, d)
    return True, f"决策已记录: {dp_id} = {choice}"


def api_plan_list(view="active"):
    """列出所有规划任务。"""
    tasks = load_tasks(None, view)
    plans = [t for t in tasks if t.get("type") == "plan"]
    return plans


def api_plan_get(tid):
    """获取规划详情（含决策点状态）。"""
    fn = locate_task(tid)
    if not fn:
        return None
    d = parse_task(fn)
    if not d or d.get("type") != "plan":
        return None
    plan = d.get("plan", {})
    decisions = plan.get("decisions", [])
    pending = [dp for dp in decisions if dp.get('status') == 'pending']
    decided = [dp for dp in decisions if dp.get('status') == 'decided']
    return {
        'id': d.get('id'),
        '标题': d.get('标题'),
        '项目': d.get('项目'),
        '状态': d.get('状态'),
        'plan_status': plan.get('status'),
        'objective': plan.get('objective'),
        'milestones': plan.get('milestones', []),
        'decisions': decisions,
        'pending_decisions': pending,
        'decided_count': len(decided),
        'total_decisions': len(decisions),
        'risks': plan.get('risks', []),
    }


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


def api_batch_edit(ids, fields):
    """批量编辑多个任务。返回 (成功数, 失败列表)。

    用于批量状态变更、批量归档、批量标签等。
    每个任务独立写，失败不阻塞其他。
    """
    ok_count = 0
    fails = []
    for tid in ids:
        ok, msg = api_edit(tid, fields)
        if ok:
            ok_count += 1
        else:
            fails.append({"id": tid, "error": msg})
    return ok_count, fails


def api_batch_archive(ids):
    """批量归档。返回 (成功数, 失败列表)。"""
    ok_count = 0
    fails = []
    for tid in ids:
        ok, msg = api_archive(tid)
        if ok:
            ok_count += 1
        else:
            fails.append({"id": tid, "error": msg})
    return ok_count, fails


def api_batch_delete(ids):
    """批量移入回收站。返回 (成功数, 失败列表)。"""
    ok_count = 0
    fails = []
    for tid in ids:
        ok, msg = api_delete(tid)
        if ok:
            ok_count += 1
        else:
            fails.append({"id": tid, "error": msg})
    return ok_count, fails
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


# ---------- Agent 执行日志（可观测性：每次 dispatch → done 的耗时/成本/状态） ----------
AGENT_RUNS_LOG = os.path.join(TASK_DIR, ".agent-runs.jsonl")


def _gen_run_id(tid):
    """生成执行 run_id：run-{tid}-{timestamp}"""
    return f"run-{tid}-{int(time.time())}"


def log_agent_run(run_id, tid, agent, status, cost=None, duration=None, detail=""):
    """记录 agent 一次执行的状态变更。

    status: started / completed / failed
    cost: 字符串，如 "$0.05" 或 "50k tokens"
    duration: 秒数（从 started 到 completed 的耗时）
    """
    try:
        os.makedirs(TASK_DIR, exist_ok=True)
        ts = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        row = {"ts": ts, "run_id": run_id, "tid": tid, "agent": agent,
               "status": status, "cost": cost, "duration": duration, "detail": detail}
        with open(AGENT_RUNS_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception:
        pass


def read_agent_runs(tid=None):
    """读 agent 执行日志（倒序）。tid 给定则只筛该任务。"""
    if not os.path.exists(AGENT_RUNS_LOG):
        return []
    rows = []
    try:
        with open(AGENT_RUNS_LOG, encoding="utf-8") as f:
            for ln in f:
                ln = ln.strip()
                if not ln:
                    continue
                try:
                    row = json.loads(ln)
                except Exception:
                    continue
                if tid and row.get("tid") != tid:
                    continue
                rows.append(row)
    except Exception:
        return []
    rows.reverse()
    return rows


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


def _claude_cmd(extra_args):
    """Claude Code 命令生成。"""
    exe = shutil.which("claude")
    if not exe:
        return None
    if exe.lower().endswith((".cmd", ".bat")):
        return ["cmd.exe", "/c", exe] + extra_args
    return [exe] + extra_args


def _codex_cmd(extra_args):
    """Codex CLI 命令生成。"""
    exe = shutil.which("codex")
    if not exe:
        return None
    if exe.lower().endswith((".cmd", ".bat")):
        return ["cmd.exe", "/c", exe] + extra_args
    return [exe] + extra_args


def _kun_cmd(extra_args):
    """Kun CLI 命令生成。"""
    exe = shutil.which("kun")
    if not exe:
        return None
    if exe.lower().endswith((".cmd", ".bat")):
        return ["cmd.exe", "/c", exe] + extra_args
    return [exe] + extra_args


# agent → 命令生成器映射
_AGENT_CMD_MAP = {
    "hermes": _hermes_cmd,
    "claude": _claude_cmd,
    "codex": _codex_cmd,
    "kun": _kun_cmd,
}


def _agent_cmd(agent, extra_args):
    """根据 agent 选择命令生成器，回退到 hermes。"""
    fn = _AGENT_CMD_MAP.get(agent, _hermes_cmd)
    return fn(extra_args)


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


def dispatch_task(tid, launch=True, force=False, dry_run=False, agent=None):
    """派活：生成完整任务书及 agent 启动命令。

    launch=True 时后台静默拉起 agent（旧行为，保留给 --go 用）；
    dry_run=True 时不拉起、不改变状态，只返回命令字符串供用户复制；
    agent 指定执行后端（hermes/claude/codex/kun），None 时从任务 frontmatter 读取。
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
    # 确定执行后端
    if agent is None:
        agent = (d.get("agent") or "hermes").strip()
    cmd = _agent_cmd(agent, ["-z", info["prompt"], "chat", "--in", info["repo"]])
    if cmd is None:
        return False, f"未找到 {agent} 命令（PATH 里没有 {agent}）", None
    if dry_run:
        return True, "dry-run", cmd
    # 生成 run_id 并记录执行开始
    run_id = _gen_run_id(tid)
    log_agent_run(run_id, tid, agent, "started", detail=d.get("标题", "")[:40])
    if launch:
        # CREATE_NO_WINDOW：后台静默运行，不弹黑窗口；用户可在 Hermes 桌面端会话列表里直接查看进度
        try:
            subprocess.Popen(
                cmd,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception as e:
            log_agent_run(run_id, tid, agent, "failed", detail=f"拉起失败: {e}")
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
        d["_run_id"] = run_id  # 关联执行记录，done 时回写耗时
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
    """执行方（Hermes 等）完工回写：填结果记录 + 置待验收。幂等、异常不中断。

    新增：自动关联 _run_id 计算执行耗时，记录到 agent_runs 日志。
    """
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
    if args.成本:
        cost_str = str(args.成本).strip()
        old = (d.get("结果记录") or "").strip()
        d["结果记录"] = (old + "\n" if old else "") + f"实际成本：{cost_str}"
        try:
            budget = d.get("预算") or {}
            if isinstance(budget, dict):
                budget["actual_cost"] = cost_str
                d["预算"] = budget
        except Exception:
            pass

    # 关联 run_id，计算执行耗时
    run_id = d.get("_run_id")
    if run_id:
        # 查找 started 记录
        runs = read_agent_runs(args.id)
        for r in runs:
            if r.get("run_id") == run_id and r.get("status") == "started":
                try:
                    start_ts = datetime.datetime.strptime(r["ts"], "%Y-%m-%dT%H:%M:%S")
                    duration = (datetime.datetime.now() - start_ts).total_seconds()
                    cost = args.成本 or r.get("cost")
                    log_agent_run(run_id, args.id, r.get("agent", "hermes"), "completed",
                                  cost=cost, duration=duration,
                                  detail=args.结果 or "")
                except Exception:
                    pass
                break
        d.pop("_run_id", None)  # 清理临时字段

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


def api_natural_query(q):
    """自然语言查询接口。返回 (ok, msg, tasks)。"""
    tasks, err = parse_natural_query(q)
    if err:
        return False, err, None
    return True, f"找到 {len(tasks)} 个任务", tasks


def api_agent_runs(tid=None):
    """获取 agent 执行日志。"""
    return True, "ok", read_agent_runs(tid)


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
        elif self.path.startswith("/roadmap.json"):
            self._roadmap_json()
        elif self.path.startswith("/logs.json"):
            self._logs_json()
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

    def _roadmap_json(self):
        """路线图 JSON 端点（GET /roadmap.json）"""
        project = None
        if "?" in self.path:
            qs = parse_qs(self.path.split("?", 1)[1])
            project = qs.get("project", [""])[0] or None
        self._send_json(get_roadmap_cached(project))

    def _logs_json(self):
        """日志 JSON 端点（GET /logs.json）"""
        log_file = os.path.join(TASK_DIR, ".tegula-logs.json")
        logs = []
        if os.path.exists(log_file):
            try:
                with open(log_file, encoding="utf-8") as f:
                    logs = json.loads(f.read())
            except:
                logs = []
        self._send_json({"logs": logs[-200:]})  # 最多返回200条

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
            elif action == "agent_runs":
                ok, msg, data = api_agent_runs(req.get("tid"))
                self._send_json({"ok": ok, "msg": msg, "data": data})
                return
            elif action == "natural_query":
                ok, msg, data = api_natural_query(req.get("q", ""))
                if ok:
                    self._send_json({"ok": True, "msg": msg, "data": data})
                    return
                else:
                    ok, msg = False, msg
            elif action == "notify":
                event = req.get("event")
                msg = _detect_events(event) if event else None
                if msg:
                    # 推送到 hermes
                    hermes_exe = shutil.which("hermes")
                    if hermes_exe:
                        cmd = [hermes_exe, "-z", f"方寸通知：{msg}"]
                        subprocess.Popen(cmd, creationflags=_NOWIN)
                        self._send_json({"ok": True, "msg": msg})
                    else:
                        self._send_json({"ok": True, "msg": msg, "note": "hermes 未找到，仅返回消息"})
                else:
                    self._send_json({"ok": True, "msg": "无事件需要推送"})
                return
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
            elif action == "batch_edit":
                ok_count, fails = api_batch_edit(req.get("ids", []), req.get("fields", {}))
                self._send_json({"ok": True, "ok_count": ok_count, "fails": fails})
                return
            elif action == "batch_archive":
                ok_count, fails = api_batch_archive(req.get("ids", []))
                self._send_json({"ok": True, "ok_count": ok_count, "fails": fails})
                return
            elif action == "batch_delete":
                ok_count, fails = api_batch_delete(req.get("ids", []))
                self._send_json({"ok": True, "ok_count": ok_count, "fails": fails})
                return
            elif action == "plan_new":
                ok, msg = api_plan_new(req.get("fields", {}))
                if not ok:
                    self._send_json({"ok": False, "error": msg})
                    return
                self._send_json({"ok": True, "id": msg})
                return
            elif action == "plan_decide":
                ok, msg = api_plan_decide(req.get("tid"), req.get("dp_id"), req.get("choice"), req.get("note", ""))
                self._send_json({"ok": ok, "msg": msg})
                return
            elif action == "plan_get":
                detail = api_plan_get(req.get("tid"))
                if not detail:
                    self._send_json({"ok": False, "error": "not found"})
                else:
                    self._send_json({"ok": True, "plan": detail})
                return
            elif action == "plan_list":
                plans = api_plan_list(req.get("view", "active"))
                self._send_json({"ok": True, "plans": plans})
                return
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
        # 读端口文件获取实际端口
        port = _read_port_file() or 8753
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
            <a class="tool" href="http://127.0.0.1:{port}/?project={esc(pid)}" target="_blank" rel="noopener">
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
        <a class="tool" href="http://127.0.0.1:{port}/" target="_blank" rel="noopener">
            <div class="ico">📋</div>
            <div class="body"><h2>方寸 看板</h2><p>全部项目 · 任务总览</p></div>
            <span class="port">{port}</span>
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


# ── 系统托盘（pystray）：常驻后台 + 右键菜单 + 最小化到托盘 ──
try:
    import pystray
    from PIL import Image, ImageDraw, ImageFont
    _PYSTRAY_AVAILABLE = True
except ImportError:
    _PYSTRAY_AVAILABLE = False


def _create_tray_icon():
    """生成托盘图标（16x16 PNG 字节）。"""
    img = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([1, 1, 15, 15], radius=3, fill="#9b8fc4")
    draw.text((8, 8), "寸", fill="white", anchor="mm")
    return img


class TrayManager:
    """系统托盘管理器。

    功能：
    - 托盘图标 + 右键菜单
    - 双击打开看板
    - 窗口关闭 → 最小化到托盘（不退出）
    - 退出时清理端口文件 + 停服务
    - 后台自动检查更新（每 30 分钟）
    """

    def __init__(self, srv, port):
        self.srv = srv
        self.port = port
        self.icon = None
        self.window = None
        self.last_commit = None
        self.build_running = False
        self._update_event = threading.Event()
        # 初始提交
        try:
            r = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                capture_output=True, text=True, cwd=ROOT,
                creationflags=_NOWIN
            )
            self.last_commit = r.stdout.strip()[:8] if r.returncode == 0 else "unknown"
        except:
            self.last_commit = "unknown"

    def _open_board(self, *a):
        """打开看板窗口。"""
        if self.window is None:
            self.window = self._create_window()
        # pywebview 窗口重开需要重新 create_window

    def _create_window(self):
        import webview
        return webview.create_window(
            "方寸 tegula",
            f"http://127.0.0.1:{self.port}/",
            width=1280, height=860, min_size=(1024, 640)
        )

    def _open_startpage(self, *a):
        """在浏览器打开启动台。"""
        import webbrowser
        webbrowser.open(f"http://127.0.0.1:{self.port}/startpage")

    def _do_backup(self, *a):
        """执行备份。"""
        try:
            import io, contextlib
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                cmd_backup(type('A', (), {})())
            print(f"[ok] 托盘备份：{buf.getvalue().strip()}")
        except Exception as e:
            print(f"[warn] 备份失败：{e}")

    def _toggle_autostart(self, item):
        """切换开机自启动。"""
        import winreg
        key_path = r"Software\Microsoft\Windows\CurrentVersion\Run"
        try:
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_ALL_ACCESS)
            try:
                winreg.DeleteValue(key, "方寸")
                winreg.CloseKey(key)
                print("[ok] 已取消开机自启动")
            except FileNotFoundError:
                exe = getattr(sys, "executable", os.path.join(ROOT, "方寸.exe"))
                winreg.SetValueEx(key, "方寸", 0, winreg.REG_SZ, f'"{exe}" --tray')
                winreg.CloseKey(key)
                print("[ok] 已设置开机自启动")
        except Exception as e:
            print(f"[warn] 自启动设置失败：{e}")

    def _is_autostart(self):
        """检查是否已设置开机自启动。"""
        import winreg
        try:
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                 r"Software\Microsoft\Windows\CurrentVersion\Run",
                                 0, winreg.KEY_READ)
            winreg.QueryValueEx(key, "方寸")
            winreg.CloseKey(key)
            return True
        except FileNotFoundError:
            return False

    def _check_update_worker(self):
        """后台线程：检查新提交并自动打包。"""
        import time
        CHECK_INTERVAL = 30 * 60  # 30 分钟
        while not self._update_event.is_set():
            try:
                self._check_and_build()
            except Exception as e:
                print(f"[warn] 更新检查失败：{e}")
            self._update_event.wait(timeout=CHECK_INTERVAL)

    def _check_and_build(self):
        """检查是否有新提交，有则自动打包。"""
        # 检查是否有 git 仓库
        if not os.path.isdir(os.path.join(ROOT, ".git")):
            return
        if self.build_running:
            return

        # fetch 最新
        r = subprocess.run(
            ["git", "fetch", "origin", "main"],
            capture_output=True, text=True, cwd=ROOT,
            creationflags=_NOWIN, timeout=30
        )

        # 比较本地 vs 远程
        r = subprocess.run(
            ["git", "log", "HEAD..origin/main", "--oneline"],
            capture_output=True, text=True, cwd=ROOT,
            creationflags=_NOWIN
        )
        if not r.stdout.strip():
            return

        new_commits = r.stdout.strip().splitlines()
        print(f"[更新] 发现 {len(new_commits)} 个新提交")

        # 拉取
        subprocess.run(
            ["git", "pull", "origin", "main"],
            capture_output=True, text=True, cwd=ROOT,
            creationflags=_NOWIN, timeout=30
        )

        # 打包
        self.build_running = True
        try:
            success, info = self._run_build()
            if success:
                msg = f"新构建已就绪（{len(new_commits)} 个更新）\n{info}"
                print(f"[更新] {msg}")
                if self.icon:
                    self.icon.notify(msg, "方寸自动构建")
            else:
                print(f"[warn] 构建失败：{info}")
        finally:
            self.build_running = False

    def _run_build(self):
        """运行 PyInstaller 打包。"""
        import shutil
        dist = os.path.join(ROOT, "dist")
        build = os.path.join(ROOT, "build")
        for d in [dist, build]:
            if os.path.isdir(d):
                shutil.rmtree(d, ignore_errors=True)
        r = subprocess.run(
            [sys.executable, "-m", "PyInstaller", "--noconfirm", "方寸.spec"],
            capture_output=True, text=True, cwd=ROOT,
            creationflags=_NOWIN, timeout=300
        )
        if r.returncode != 0:
            return False, r.stderr[-300:] if r.stderr else "未知错误"
        exe = os.path.join(dist, "方寸", "方寸.exe")
        if not os.path.exists(exe):
            return False, "方寸.exe 未生成"
        size = os.path.getsize(exe) / 1024 / 1024
        return True, f"{size:.1f} MB"

    def _manual_check_update(self, *a):
        """手动检查更新。"""
        threading.Thread(target=self._check_and_build, daemon=True).start()

    def _quit(self, *a):
        """退出：停服务 + 清理 + 退出进程。"""
        self._update_event.set()
        try:
            if self.srv:
                self.srv.shutdown()
            _clear_port_file()
            if self.icon:
                self.icon.stop()
        except Exception:
            pass
        os._exit(0)

    def run(self):
        """启动托盘（阻塞）。"""
        # 启动更新检查线程
        self._update_thread = threading.Thread(target=self._check_update_worker, daemon=True)
        self._update_thread.start()

        menu_items = [
            pystray.MenuItem("打开看板", self._open_board),
            pystray.MenuItem("启动台", self._open_startpage),
            pystray.MenuItem("立即备份", self._do_backup),
            pystray.MenuItem("检查更新", self._manual_check_update),
            pystray.MenuItem(
                "开机自启动",
                self._toggle_autostart,
                checked=self._is_autostart
            ),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("退出", self._quit),
        ]
        menu = pystray.Menu(*menu_items)
        self.icon = pystray.Icon("方寸", _create_tray_icon(), f"方寸 tegula [{self.last_commit}]", menu)
        self.icon.notify("已启动（每 30 分钟自动检查更新）", "方寸 tegula")
        self.icon.run()


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


# ── 端口文件：解决端口冲突 + 客户端自动发现 ──
PORT_FILE = os.path.join(DATA_DIR, ".tegula-port")


def _write_port_file(port):
    """写入端口文件：端口 | PID | 时间戳"""
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        data = f"{port}\n{os.getpid()}\n{int(time.time())}"
        tmp = PORT_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(data)
        os.replace(tmp, PORT_FILE)
    except Exception:
        pass


def _read_port_file():
    """读取端口文件并校验服务是否活着。返回 port 或 None。"""
    try:
        with open(PORT_FILE, encoding="utf-8") as f:
            lines = f.read().strip().splitlines()
        if len(lines) < 2:
            return None
        port = int(lines[0].strip())
        pid = int(lines[1].strip())
        # 校验 PID 是否活着（Windows: tasklist）
        if pid:
            try:
                r = subprocess.run(
                    ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                    capture_output=True, text=True, timeout=5,
                    creationflags=_NOWIN
                )
                # tasklist 找不到进程时输出 "信息: 没有运行的任务匹配指定标准。"
                if "没有运行" in r.stdout or "no task" in r.stdout.lower():
                    _clear_port_file()
                    return None
            except Exception:
                pass
        # 校验端口是否响应
        if tegula_alive(port):
            return port
        else:
            # 端口文件过期
            _clear_port_file()
            return None
    except Exception:
        return None


def _clear_port_file():
    """清理端口文件。"""
    try:
        if os.path.exists(PORT_FILE):
            os.remove(PORT_FILE)
    except Exception:
        pass


def _diagnose_port_conflict(port):
    """诊断端口冲突，返回占用者信息。"""
    try:
        r = subprocess.run(
            ["netstat", "-ano"],
            capture_output=True, timeout=10,
            creationflags=_NOWIN
        )
        output = r.stdout.decode("gbk", errors="replace")
        for line in output.splitlines():
            if f":{port}" in line and "LISTENING" in line:
                parts = line.strip().split()
                pid = parts[-1]
                # 获取进程名
                r2 = subprocess.run(
                    ["tasklist", "/FI", f"PID eq {pid}", "/NH", "/FO", "CSV"],
                    capture_output=True, text=True, timeout=5,
                    creationflags=_NOWIN
                )
                pname = pid
                for l2 in r2.stdout.splitlines():
                    if l2.strip():
                        cols = l2.strip().split(",")
                        if len(cols) >= 2:
                            pname = cols[0].strip('"')
                            break
                return pid, pname
    except Exception:
        pass
    return None, None


def tegula_alive(port):
    """该端口上是否已是一个活着的方寸看板。"""
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
    # 优先读端口文件找已有服务
    existing = _read_port_file()
    if existing and not getattr(args, "tray", False):
        # 已有服务在跑，直接连
        import webview
        webview.create_window("方寸 tegula", f"http://127.0.0.1:{existing}/",
                              width=1280, height=860, min_size=(1024, 640))
        webview.start()
        return

    port = args.port
    tray_mode = getattr(args, "tray", False)
    reuse = False
    if tegula_alive(port):
        reuse = True
    else:
        free = find_free_port(port)
        if free is None:
            print(f"[错误] {port}-8790 端口均被占用。")
            return
        port = free

    if reuse and not tray_mode:
        # 已有看板在跑：直接唤窗
        _write_port_file(port)
        import webview
        webview.create_window("方寸 tegula", f"http://127.0.0.1:{port}/",
                              width=1280, height=860, min_size=(1024, 640))
        webview.start()
        return

    # 后台启动 HTTP 服务
    srv = QServer(("127.0.0.1", port), Handler)
    _write_port_file(port)
    server_thread = threading.Thread(target=srv.serve_forever, daemon=True)
    server_thread.start()
    # 等待服务就绪
    for _ in range(20):
        time.sleep(0.5)
        if tegula_alive(port):
            break

    if tray_mode and _PYSTRAY_AVAILABLE:
        print(f"[托盘] 已进入系统托盘模式")
        tray = TrayManager(srv, port)
        try:
            tray.run()
        except KeyboardInterrupt:
            pass
        finally:
            _clear_port_file()
        return

    import webview
    webview.create_window("方寸 tegula", f"http://127.0.0.1:{port}/",
                          width=1280, height=860, min_size=(1024, 640))
    webview.start()
    # 窗口关闭后停止服务
    srv.shutdown()
    _clear_port_file()


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



# ---------- 路线图（P4）：自动从任务聚合的战略视图 ----------
_ROADMAP_CACHE = {"data": None, "ts": 0.0}
ROADMAP_TTL = 20  # 秒

# 历史趋势：路线图快照环形缓冲区（保留最近 30 个快照）
_ROADMAP_HISTORY = []
ROADMAP_HISTORY_MAX = 30


def _batch_status(tasks_in_batch):
    """根据批次内任务状态分布判定批次状态"""
    total = len(tasks_in_batch)
    done = sum(1 for t in tasks_in_batch if t.get("状态") == "完成")
    in_progress = sum(1 for t in tasks_in_batch if t.get("状态") == "进行中")
    rejected = sum(1 for t in tasks_in_batch if t.get("状态") == "驳回")
    
    # 检查是否有任务被阻塞
    blocked = False
    for t in tasks_in_batch:
        if blockers_of(t.get("id", "")):
            blocked = True
            break
    
    if in_progress > 0:
        return "active"
    elif blocked:
        return "blocked"
    elif done == total:
        return "completed"
    else:
        return "pending"


def aggregate_roadmap(project_id=None):
    """从任务文件聚合路线图。返回结构化 dict。"""
    tasks = load_tasks(view="active")
    
    # 按项目分组
    projects_map = {}
    for t in tasks:
        proj = (t.get("项目") or [None])[0]
        if not proj:
            continue
        if proj not in projects_map:
            projects_map[proj] = []
        projects_map[proj].append(t)
    
    # 获取项目元数据
    reg = {p["id"]: p for p in load_all_projects()}
    
    result_projects = []
    for proj_id, proj_tasks in projects_map.items():
        proj_meta = reg.get(proj_id, {})
        proj_name = proj_meta.get("name", proj_id)
        
        # 按批次分组
        batches = {}
        for t in proj_tasks:
            batch = t.get("批次") or "未分类"
            if batch not in batches:
                batches[batch] = []
            batches[batch].append(t)
        
        batch_list = []
        for bname, btasks in sorted(batches.items()):
            bstatus = _batch_status(btasks)
            btasks_sorted = sorted(btasks, key=lambda x: x.get("状态", ""))
            batch_list.append({
                "name": bname,
                "status": bstatus,
                "total": len(btasks),
                "done": sum(1 for t in btasks if t.get("状态") == "完成"),
                "tasks": [{"id": t.get("id"), "title": t.get("标题", ""), "status": t.get("状态", "")}
                          for t in btasks_sorted]
            })
        
        # 项目健康度
        health = "idle"
        if any(b["status"] == "active" for b in batch_list):
            health = "active"
        elif any(b["status"] == "blocked" for b in batch_list):
            health = "stuck"
        
        # 阻塞详情
        blockers = []
        for t in proj_tasks:
            blks = blockers_of(t.get("id", ""))
            for b in blks:
                blockers.append({
                    "task_id": t.get("id"),
                    "title": t.get("标题", ""),
                    "blocker_id": b["id"],
                    "blocker_title": b["标题"]
                })
        
        # 下一动作：进行中的任务优先
        next_actions = []
        for t in sorted(proj_tasks, key=lambda x: (0 if x.get("状态") == "进行中" else 1)):
            if t.get("状态") in ("进行中", "待办"):
                next_actions.append({
                    "task_id": t.get("id"),
                    "title": t.get("标题", ""),
                    "priority": t.get("优先级", "中"),
                    "batch": t.get("批次", "")
                })
                if len(next_actions) >= 3:
                    break
        
        result_projects.append({
            "id": proj_id,
            "name": proj_name,
            "health": health,
            "batches": batch_list,
            "blockers": blockers,
            "next_actions": next_actions,
            "task_count": len(proj_tasks)
        })
    
    # 过滤指定项目
    if project_id:
        result_projects = [p for p in result_projects if p["id"] == project_id]
    
    # 跨项目建议
    cross_sugs = []
    stuck = [p for p in result_projects if p["health"] == "stuck"]
    idle = [p for p in result_projects if p["health"] == "idle"]
    
    if stuck:
        names = "、".join(p["name"] for p in stuck)
        cross_sugs.append(f"优先处理卡住项目：{names}")
    if idle:
        names = "、".join(p["name"] for p in idle)
        cross_sugs.append(f"空闲项目可激活：{names}")
    
    return {
        "generated_at": int(time.time()),
        "projects": result_projects,
        "cross_project": cross_sugs
    }


def get_roadmap_cached(project_id=None):
    """带 TTL 缓存的路线图获取"""
    global _ROADMAP_CACHE
    now = time.time()
    cache_key = project_id or "__all__"
    
    if _ROADMAP_CACHE["data"] is not None and _ROADMAP_CACHE["key"] == cache_key:
        if now - _ROADMAP_CACHE["ts"] < ROADMAP_TTL:
            return _ROADMAP_CACHE["data"]
    
    data = aggregate_roadmap(project_id)
    _ROADMAP_CACHE["data"] = data
    _ROADMAP_CACHE["ts"] = now
    _ROADMAP_CACHE["key"] = cache_key
    return data


def cmd_roadmap(args):
    """查看路线图：自动从任务聚合的战略视图。"""
    project = getattr(args, "project", None)
    fmt = getattr(args, "format", "text")
    brief = getattr(args, "brief", False)
    
    data = get_roadmap_cached(project)
    
    if fmt == "json":
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return
    
    if brief:
        # 简报模式：每项目一行
        for p in data["projects"]:
            active_batches = [b["name"] for b in p["batches"] if b["status"] == "active"]
            pending = [b["name"] for b in p["batches"] if b["status"] == "pending"]
            blockers = len(p["blockers"])
            print(f"{p['name']:<12} {'🟢' if p['health'] == 'active' else '🟡' if p['health'] == 'stuck' else '⚪'} "
                  f"进行中: {', '.join(active_batches) or '无'} | "
                  f"待办: {', '.join(pending) or '无'} | "
                  f"阻塞: {blockers}")
        if data["cross_project"]:
            print(f"跨项目：{' | '.join(data['cross_project'])}")
        return
    
    # text 模式（详细输出）
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    print(f"方寸路线图 · {now}")
    print("═" * 55)
    
    for p in data["projects"]:
        icon = "🟢" if p["health"] == "active" else "🟡" if p["health"] == "stuck" else "⚪"
        print(f"{icon} {p['name']} ({p['id']}) — {p['health']}")
        
        # 批次列表
        for b in p["batches"]:
            bicon = {"active": "▶", "pending": "○", "blocked": "⛔", "completed": "✓"}.get(b["status"], "?")
            print(f"   {bicon} {b['name']:<12} [{b['status']}] {b['done']}/{b['total']}")
            for t in b["tasks"]:
                print(f"      - [{t['status']}] {t['id']} {t['title']}")
        
        # 阻塞
        if p["blockers"]:
            print(f"   ⛔ 阻塞：")
            for blk in p["blockers"][:3]:
                print(f"      {blk['task_id']}《{blk['title']}」被 {blk['blocker_id']} 阻塞")
        
        # 建议
        if p["next_actions"]:
            print(f"   💡 下一动作：")
            for act in p["next_actions"][:2]:
                print(f"      {act['task_id']}《{act['title']}」[{act['batch']}] P={act['priority']}")
        
        print()
    
    # 跨项目建议
    if data["cross_project"]:
        print("─" * 55)
        print("跨项目建议：")
        for i, s in enumerate(data["cross_project"], 1):
            print(f"  {i}. {s}")
        print()


def mcp_get_roadmap(params):
    """MCP 接口：获取项目路线图"""
    pid = str((params or {}).get("project") or "").strip() or None
    return get_roadmap_cached(pid)


def _record_roadmap_snapshot(data):
    """记录路线图快照（环形缓冲，保留 ROADMAP_HISTORY_MAX 个）。"""
    global _ROADMAP_HISTORY
    # 仅保留轻量摘要（避免内存膨胀）
    snapshot = {
        "ts": data.get("generated_at", int(time.time())),
        "summary": {
            p["id"]: {
                "name": p["name"],
                "health": p["health"],
                "active_batches": sum(1 for b in p["batches"] if b["status"] == "active"),
                "completed_batches": sum(1 for b in p["batches"] if b["status"] == "completed"),
                "blockers": len(p["blockers"]),
            }
            for p in data.get("projects", [])
        },
    }
    _ROADMAP_HISTORY.append(snapshot)
    if len(_ROADMAP_HISTORY) > ROADMAP_HISTORY_MAX:
        _ROADMAP_HISTORY.pop(0)


def get_roadmap_trend(days=7):
    """返回路线图历史趋势（活跃/完成/阻塞的天级序列）。"""
    cutoff = time.time() - days * 86400
    trend = {}
    for snap in _ROADMAP_HISTORY:
        if snap["ts"] < cutoff:
            continue
        for pid, info in snap["summary"].items():
            if pid not in trend:
                trend[pid] = []
            trend[pid].append({
                "ts": snap["ts"],
                "name": info["name"],
                "active": info["active_batches"],
                "completed": info["completed_batches"],
                "blocked": info["blockers"],
            })
    return trend


def _detect_parallel_opportunities(roadmap):
    """识别可并行推进的任务。"""
    sugs = []
    active_projs = [p for p in roadmap["projects"] if p["health"] == "active"]
    if len(active_projs) >= 2:
        names = "、".join(p["name"] for p in active_projs)
        sugs.append({
            "type": "parallel",
            "projects": [p["id"] for p in active_projs],
            "reason": f"{names} 均在活跃推进中，可考虑交替进行防止单项目阻塞",
        })
    for p in roadmap["projects"]:
        pending = [b for b in p["batches"] if b["status"] == "pending"]
        if len(pending) >= 2:
            sugs.append({
                "type": "parallel_batches",
                "project": p["id"],
                "batches": [b["name"] for b in pending],
                "reason": f"{p['name']} 的 {len(pending)} 个待办批次无阻塞，可并行推进",
            })
    return sugs


def _suggest_milestones(roadmap):
    """基于批次模式自动建议里程碑。"""
    milestones = []
    batch_phase_map = {"P0": "核心", "P1": "功能", "P2": "打磨", "P3": "扩展"}
    for p in roadmap["projects"]:
        if p["health"] == "released":
            continue
        batches = p["batches"]
        phase_stats = {}
        for b in batches:
            prefix = b["name"][:2] if b["name"][:1] == "P" else "其他"
            if prefix not in phase_stats:
                phase_stats[prefix] = {"total": 0, "done": 0}
            phase_stats[prefix]["total"] += b["total"]
            phase_stats[prefix]["done"] += b["done"]
        for phase, stats in sorted(phase_stats.items()):
            phase_name = batch_phase_map.get(phase, phase)
            if stats["total"] > 0 and stats["done"] == stats["total"]:
                milestones.append({
                    "project": p["id"], "project_name": p["name"],
                    "phase": phase, "milestone": f"{phase_name}阶段完成",
                    "status": "completed",
                    "tasks_done": stats["done"], "tasks_total": stats["total"],
                })
            elif stats["done"] > 0:
                progress = round(stats["done"] / stats["total"] * 100)
                milestones.append({
                    "project": p["id"], "project_name": p["name"],
                    "phase": phase, "milestone": f"{phase_name}阶段进行中",
                    "status": "in_progress", "progress": progress,
                    "tasks_done": stats["done"], "tasks_total": stats["total"],
                })
        total_tasks = sum(b["total"] for b in batches)
        done_tasks = sum(b["done"] for b in batches)
        if total_tasks > 0 and done_tasks == total_tasks:
            milestones.append({
                "project": p["id"], "project_name": p["name"],
                "phase": "all", "milestone": f"{p['name']} 可发布候选",
                "status": "ready",
                "tasks_done": done_tasks, "tasks_total": total_tasks,
            })
    return milestones


def get_roadmap_full(project_id=None):
    """获取完整路线图（含趋势、里程碑、并行建议）。"""
    base = aggregate_roadmap(project_id)
    _record_roadmap_snapshot(base)
    trend = get_roadmap_trend()
    milestones = _suggest_milestones(base)
    parallel = _detect_parallel_opportunities(base)
    extended_cross = list(base.get("cross_project", []))
    if parallel:
        for pp in parallel:
            extended_cross.append(f"💡 并行建议：{pp['reason']}")
    if milestones:
        completed = [m for m in milestones if m["status"] == "completed"]
        ready = [m for m in milestones if m["status"] == "ready"]
        if completed:
            names = ", ".join(m["project_name"] + " " + m["milestone"] for m in completed[:3])
            extended_cross.append(f"🎯 已完成里程碑：{len(completed)} 个（{names}）")
        if ready:
            extended_cross.append(f"🚀 可发布：{', '.join(m['project_name'] for m in ready)}")
    base["milestones"] = milestones
    base["parallel_suggestions"] = parallel
    base["trend"] = trend
    base["cross_project"] = extended_cross
    return base


def mcp_get_roadmap_full(params):
    """MCP 接口：获取增强路线图"""
    pid = str((params or {}).get("project") or "").strip() or None
    return get_roadmap_full(pid)


def cmd_roadmap_full(args):
    """查看增强路线图：含历史趋势、里程碑追踪、并行建议。"""
    project = getattr(args, "project", None)
    fmt = getattr(args, "format", "text")
    data = get_roadmap_full(project)
    if fmt == "json":
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    print(f"方寸路线图（增强版）· {now}")
    print("═" * 60)
    for p in data["projects"]:
        icon = "🟢" if p["health"] == "active" else "🟡" if p["health"] == "stuck" else "⚪"
        print(f"{icon} {p['name']} ({p['id']}) — {p['health']}")
        for b in p["batches"]:
            bicon = {"active": "▶", "pending": "○", "blocked": "⛔", "completed": "✓"}.get(b["status"], "?")
            bar_len = 10
            filled = round(b["done"] / b["total"] * bar_len) if b["total"] else 0
            bar = "█" * filled + "░" * (bar_len - filled)
            pct = round(b["done"] / b["total"] * 100) if b["total"] else 0
            print(f"   {bicon} {b['name']:<12} [{b['status']}] {bar} {b['done']}/{b['total']} ({pct}%)")
        if p["blockers"]:
            print(f"   ⛔ 阻塞：")
            for blk in p["blockers"][:2]:
                print(f"      {blk['task_id']}《{blk['title']}」被 {blk['blocker_id']} 阻塞")
        if p["next_actions"]:
            print(f"   💡 下一动作：")
            for act in p["next_actions"][:2]:
                print(f"      {act['task_id']}《{act['title']}」[{act.get('batch', '')}] P={act.get('priority', '')}")
        print()
    if data["milestones"]:
        print("─" * 60)
        print("🎯 里程碑追踪：")
        for m in data["milestones"][:10]:
            if m["status"] == "completed":
                print(f"   ✅ {m['project_name']} · {m['milestone']}（{m['tasks_done']}/{m['tasks_total']}）")
            elif m["status"] == "in_progress":
                print(f"   ▶ {m['project_name']} · {m['milestone']}（{m['progress']}%）")
            elif m["status"] == "ready":
                print(f"   🚀 {m['project_name']} · {m['milestone']}（{m['tasks_done']}/{m['tasks_total']}）")
    if data["parallel_suggestions"]:
        print()
        print("💡 并行建议：")
        for s in data["parallel_suggestions"]:
            print(f"   · {s['reason']}")
    if data["trend"]:
        print()
        print("📈 历史趋势（近 7 天快照）：")
        for pid, snaps in data["trend"].items():
            if snaps:
                latest = snaps[-1]
                print(f"   {latest['name']}：活跃={latest['active']} 完成={latest['completed']} 阻塞={latest['blocked']}（{len(snaps)} 个快照）")
    if data["cross_project"]:
        print()
        print("─" * 60)
        print("跨项目建议：")
        for s in data["cross_project"]:
            print(f"   {s}")
    print()


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
    {"name": "get_roadmap", "description": "获取项目路线图（自动从任务聚合，含批次/阻塞/建议）",
     "inputSchema": {"type": "object", "properties": {
         "project": {"type": "string", "description": "项目 id，留空返回全部"},
         "format": {"type": "string", "description": "text 或 json", "enum": ["text", "json"]}},
         "required": []}},
    {"name": "get_roadmap_full", "description": "获取增强路线图（含历史趋势、里程碑追踪、并行建议）",
     "inputSchema": {"type": "object", "properties": {
         "project": {"type": "string", "description": "项目 id，留空返回全部"}},
         "required": []}},
    {"name": "gate_open", "description": "创建验收门（定义验收清单）",
     "inputSchema": {"type": "object", "properties": {
         "gate_id": {"type": "string", "description": "门控 id"},
         "title": {"type": "string", "description": "门控标题"},
         "items": {"type": "array", "items": {"type": "string"}, "description": "验收项列表"},
         "stage": {"type": "string", "description": "阶段名（可选）"}},
         "required": ["gate_id"]}},
    {"name": "gate_check", "description": "检查验收门（逐项验证）",
     "inputSchema": {"type": "object", "properties": {
         "gate_id": {"type": "string", "description": "门控 id"},
         "items": {"type": "array", "items": {"type": "object"}, "description": "验收项状态列表"}},
         "required": ["gate_id", "items"]}},
    {"name": "gate_list", "description": "列出所有验收门",
     "inputSchema": {"type": "object", "properties": {}, "required": []}},
    {"name": "gate_close", "description": "关闭验收门",
     "inputSchema": {"type": "object", "properties": {
         "gate_id": {"type": "string", "description": "门控 id"},
         "reason": {"type": "string", "description": "关闭原因"}},
         "required": ["gate_id"]}},
    {"name": "plan_list", "description": "列出所有规划（含决策点状态）",
     "inputSchema": {"type": "object", "properties": {
         "view": {"type": "string", "description": "视图：active(默认)/archive/trash"}},
         "required": []}},
    {"name": "plan_get", "description": "获取规划详情（含决策点、里程碑、风险）",
     "inputSchema": {"type": "object", "properties": {
         "id": {"type": "string", "description": "规划任务 id"}},
         "required": ["id"]}},
    {"name": "plan_pending_decisions", "description": "列出所有待决策的规划决策点",
     "inputSchema": {"type": "object", "properties": {}, "required": []}},
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


def mcp_gate_open(params):
    ok, msg = gate_open(params.get("gate_id"), params.get("title"),
                        params.get("items"), params.get("stage"))
    return {"ok": ok, "message": msg}


def mcp_gate_check(params):
    ok, msg, g = gate_check(params.get("gate_id"), params.get("items"))
    return {"ok": ok, "message": msg, "gate": g}


def mcp_gate_list(params):
    return {"gates": gate_list()}


def mcp_gate_close(params):
    ok, msg = gate_close(params.get("gate_id"), params.get("reason", ""))
    return {"ok": ok, "message": msg}


def mcp_plan_list(params):
    plans = api_plan_list(params.get("view", "active"))
    return {"plans": [_mcp_task_view(t) for t in plans]}


def mcp_plan_get(params):
    tid = str((params or {}).get("id") or "").strip()
    if not tid:
        return {"error": "缺少 id"}
    detail = api_plan_get(tid)
    if not detail:
        return {"error": f"规划不存在: {tid}"}
    return detail


def mcp_plan_pending_decisions(params):
    plans = api_plan_list()
    results = []
    for t in plans:
        plan = t.get("plan", {})
        decisions = plan.get("decisions", [])
        pending = [dp for dp in decisions if dp.get('status') == 'pending']
        if pending:
            results.append({
                "id": t["id"],
                "标题": t["标题"],
                "项目": t.get("项目", []),
                "pending_decisions": pending,
            })
    return {"pending_decisions": results}


MCP_METHODS = {"list_tasks": mcp_list_tasks, "get_task": mcp_get_task,
               "get_project_status": mcp_get_project_status,
               "list_projects": mcp_list_projects, "search_tasks": mcp_search_tasks,
               "get_roadmap": mcp_get_roadmap,
               "get_roadmap_full": mcp_get_roadmap_full,
               "gate_open": mcp_gate_open, "gate_check": mcp_gate_check,
               "gate_list": mcp_gate_list, "gate_close": mcp_gate_close,
               "plan_list": mcp_plan_list, "plan_get": mcp_plan_get,
               "plan_pending_decisions": mcp_plan_pending_decisions}


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


def cmd_notify(args):
    """推送通知到 Hermes（进而推送到 QQ）。

    用法：
      python tegula.py notify "任务 task-xxx 已超时 24h"
      python tegula.py notify --event timeout
      python tegula.py notify --event stuck

    事件类型：
      timeout  — 进行中任务超时未回写
      stuck    — 项目卡住（有阻塞任务）
      all      — 检查所有事件并推送摘要
    """
    event = getattr(args, "event", None)
    msg = getattr(args, "message", None)

    if event:
        msg = _detect_events(event)
        if not msg:
            print("无事件需要推送。")
            return

    if not msg:
        print("请提供消息内容或事件类型。")
        return

    # 通过 hermes 推送
    try:
        hermes_exe = shutil.which("hermes")
        if hermes_exe:
            cmd = [hermes_exe, "-z", f"方寸通知：{msg}"]
            subprocess.Popen(cmd, creationflags=_NOWIN)
            print(f"已推送: {msg}")
        else:
            # 无 hermes，直接打印
            print(f"[通知] {msg}")
    except Exception as e:
        print(f"推送失败: {e}")


def _detect_events(event_type):
    """检测事件，返回通知消息字符串。无事件返回 None。"""
    if event_type == "timeout":
        timeouts = find_timeout_tasks()
        if not timeouts:
            return None
        parts = [f"《{t['title']}》{t['hours']}h" for t in timeouts[:5]]
        return f"⚠️ {len(timeouts)} 个任务超时未回写：{'、'.join(parts)}"

    if event_type == "stuck":
        statuses = [scan_project_status(p) for p in load_all_projects()]
        stuck = [s for s in statuses if s["health"] == "stuck"]
        if not stuck:
            return None
        names = "、".join(s["name"] for s in stuck)
        return f"⛔ {len(stuck)} 个项目卡住：{names}"

    if event_type == "all":
        parts = []
        timeouts = find_timeout_tasks()
        if timeouts:
            parts.append(f"{len(timeouts)} 个超时任务")
        statuses = [scan_project_status(p) for p in load_all_projects()]
        stuck = [s for s in statuses if s["health"] == "stuck"]
        if stuck:
            parts.append(f"{len(stuck)} 个卡住项目")
        if not parts:
            return None
        return "方寸日报：" + "、".join(parts)

    return None


# ---------- Plan CLI handlers ----------

def cmd_plan_new(args):
    """创建规划。"""
    if not args.title:
        print("错误：请提供 --title 或使用交互式输入")
        return
    ok, result = api_plan_new({
        "标题": args.title,
        "项目": args.项目,
        "目标": args.目标,
        "里程碑": args.里程碑,
        "决策点": args.决策点,
        "风险": args.风险,
        "批次": args.批次,
        "截止": args.截止,
        "优先级": args.优先级,
        "资料": args.资料,
        "附言": args.附言,
    })
    if ok:
        print(f"已创建规划: {result}")
    else:
        print(f"创建失败: {result}")


def cmd_plan_decide(args):
    """对决策点做决策。"""
    ok, msg = api_plan_decide(args.tid, args.dp_id, args.choice, getattr(args, "note", ""))
    if ok:
        print(f"✓ {msg}")
    else:
        print(f"✗ {msg}")


def cmd_plan_decisions(args):
    """列出待决策项。"""
    if args.tid:
        detail = api_plan_get(args.tid)
        if not detail:
            print(f"规划不存在: {args.tid}")
            return
        print(f"规划: {detail['标题']} ({detail['plan_status']})")
        if detail['pending_decisions']:
            print(f"待决策 ({len(detail['pending_decisions'])}/{detail['total_decisions']}):")
            for dp in detail['pending_decisions']:
                print(f"  - {dp['id']}: {dp['question']}")
                print(f"    选项: {' / '.join(dp['options'])}")
        else:
            print("所有决策点已完成。")
    else:
        plans = api_plan_list()
        found = False
        for t in plans:
            plan = t.get("plan", {})
            decisions = plan.get("decisions", [])
            pending = [dp for dp in decisions if dp.get('status') == 'pending']
            if pending:
                found = True
                print(f"\n{t['id']}: {t['标题']}")
                for dp in pending:
                    print(f"  - {dp['id']}: {dp['question']}")
        if not found:
            print("无待决策项。")


def cmd_plan_list(args):
    """列出所有规划。"""
    plans = api_plan_list(args.view)
    if not plans:
        print("无规划。")
        return
    print(f"共 {len(plans)} 个规划：\n")
    for t in plans:
        plan = t.get("plan", {})
        decisions = plan.get("decisions", [])
        pending = len([dp for dp in decisions if dp.get('status') == 'pending'])
        total = len(decisions)
        ms_count = len(plan.get("milestones", []))
        status_mark = {"draft": "✏️", "active": "▶", "achieved": "✅", "abandoned": "⛔"}.get(plan.get("status", ""), "?")
        print(f"{status_mark} {t['id']}: {t['标题']}")
        print(f"   状态: {t['状态']} | 决策: {total - pending}/{total} | 里程碑: {ms_count}")
        if plan.get("objective"):
            print(f"   目标: {plan['objective']}")


def cmd_plan_get(args):
    """获取规划详情。"""
    detail = api_plan_get(args.tid)
    if not detail:
        print(f"规划不存在: {args.tid}")
        return
    print(f"{'='*50}")
    print(f"规划: {detail['标题']} ({detail['id']})")
    print(f"{'='*50}")
    print(f"状态: {detail['状态']} | 规划状态: {detail['plan_status']}")
    print(f"项目: {', '.join(detail['项目'])}")
    print(f"目标: {detail['objective']}")
    if detail['milestones']:
        print(f"\n里程碑 ({len(detail['milestones'])}):")
        for ms in detail['milestones']:
            print(f"  - {ms.get('name', '')} (截止: {ms.get('deadline', '未设定')})")
    if detail['decisions']:
        print(f"\n决策点 ({detail['decided_count']}/{detail['total_decisions']}):")
        for dp in detail['decisions']:
            mark = "✓" if dp.get('status') == 'decided' else "○"
            print(f"  {mark} {dp['id']}: {dp['question']}")
            if dp.get('options'):
                print(f"    选项: {' / '.join(dp['options'])}")
            if dp.get('chosen'):
                print(f"    已选: {dp['chosen']} ({dp.get('decided_at', '')})")
    if detail['risks']:
        print(f"\n风险 ({len(detail['risks'])}):")
        for r in detail['risks']:
            print(f"  ⚠️ {r}")
    print(f"{'='*50}")
    return None


def cmd_startpage(args):
    """打开全项目统一启动台（动态读取 registry.yaml）"""
    # 优先读端口文件找已有服务
    existing = _read_port_file()
    port = existing or args.port
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
    """启动本地看板视图。自动处理端口冲突。"""
    port = args.port
    tray_mode = getattr(args, "tray", False)

    # 检查已有服务
    existing = _read_port_file()
    if existing:
        print(f"[提示] 方寸看板已在 http://127.0.0.1:{existing}/ 运行（单飞保护，不再起第二个）。")
        return

    # 尝试绑定首选端口
    if tegula_alive(port):
        print(f"[提示] 方寸看板已在 http://127.0.0.1:{port}/ 运行（单飞保护，不再起第二个）。")
        _write_port_file(port)
        return

    # 首选端口被占，诊断并自动换
    actual_port = port
    test_sock = __import__("socket").socket(__import__("socket").AF_INET, __import__("socket").SOCK_STREAM)
    try:
        test_sock.bind(("127.0.0.1", port))
        test_sock.close()
    except OSError:
        test_sock.close()
        # 诊断冲突
        pid, pname = _diagnose_port_conflict(port)
        if pid:
            print(f"[warn] 端口 {port} 被 {pname} (PID {pid}) 占用")
        else:
            print(f"[warn] 端口 {port} 被占用（无法识别占用者）")
        # 自动找端口
        free = find_free_port(port + 1)
        if free is None:
            print(f"[错误] {port}-8790 端口均被占用。")
            print("       可手动指定：python tegula.py serve --port 9999")
            return
        actual_port = free
        print(f"[warn] 已自动改用端口 {actual_port}")

    # 起服务
    try:
        srv = QServer(("127.0.0.1", actual_port), Handler)
    except OSError as e:
        print(f"[错误] 绑定端口 {actual_port} 失败: {e}")
        return

    _write_port_file(actual_port)
    print(f"方寸看板已启动: http://127.0.0.1:{actual_port}/  (Ctrl+C 退出)")

    if tray_mode and _PYSTRAY_AVAILABLE:
        print(f"[托盘] 已进入系统托盘模式")
        # 托盘阻塞运行
        tray = TrayManager(srv, actual_port)
        try:
            tray.run()
        except KeyboardInterrupt:
            pass
        finally:
            _clear_port_file()
        return

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        _clear_port_file()


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
    s.add_argument("--tray", action="store_true", help="系统托盘模式（常驻后台）")
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
    dp.add_argument("--go", action="store_true", help="自动拉起 agent（旧行为，默认只生成命令）")
    dp.add_argument("--agent", default=None, help="执行后端（hermes/claude/codex/kun），覆盖任务默认值")
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
    rm = sub.add_parser("roadmap", help="路线图：自动从任务聚合的战略视图")
    rm.add_argument("project", nargs="?", default=None, help="项目 id（可选，不指定则显示全部）")
    rm.add_argument("--format", choices=["text", "json"], default="text", help="输出格式")
    rm.add_argument("--brief", action="store_true", help="简报模式（单行摘要）")
    rm.set_defaults(func=cmd_roadmap)
    rmf = sub.add_parser("roadmap-full", help="增强路线图：含历史趋势、里程碑追踪、并行建议")
    rmf.add_argument("project", nargs="?", default=None, help="项目 id（可选，不指定则显示全部）")
    rmf.add_argument("--format", choices=["text", "json"], default="text", help="输出格式")
    rmf.set_defaults(func=cmd_roadmap_full)
    dn = sub.add_parser("done", help="执行方完工回写：填结果记录并置为待验收")
    dn.add_argument("id", help="任务 id，如 task-20260828-003")
    dn.add_argument("--结果", "--result", dest="结果", default="", help="一句话结果，追加到结果记录")
    dn.add_argument("--证据", "--evidence", dest="证据", default="",
                    help="改动清单/验证输出的路径，追加为「证据：…」行，供验收时查看实物")
    dn.add_argument("--成本", "--cost", dest="成本", default="",
                    help="实际成本（如 $0.05 或 50k tokens），追加到结果记录")
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
    nf = sub.add_parser("notify", help="推送事件通知到 Hermes（进而推送到 QQ）")
    nf.add_argument("message", nargs="?", default=None, help="通知消息（省略时用 --event 自动检测）")
    nf.add_argument("--event", choices=["timeout", "stuck", "all"], default=None, help="事件类型：自动检测并推送")
    nf.set_defaults(func=cmd_notify)
    pl = sub.add_parser("plan", help="规划管理：创建规划、做决策、查看决策点")
    pl_sub = pl.add_subparsers(dest="plan_cmd")
    pl_new = pl_sub.add_parser("new", help="创建规划（交互式或参数式）")
    pl_new.add_argument("--title", default="", help="规划标题")
    pl_new.add_argument("--目标", default="", help="规划目标")
    pl_new.add_argument("--项目", nargs="*", default=[], help="项目 id")
    pl_new.add_argument("--里程碑", default="[]", help='JSON 数组，如 \'[{"name":"M1","deadline":"2026-10-01"}]\'')
    pl_new.add_argument("--决策点", default="[]", help='JSON 数组，如 \'[{"id":"dp_001","question":"...","options":["A","B"]}]\'')
    pl_new.add_argument("--风险", default="[]", help='JSON 数组，如 \'["风险1","风险2"]\'')
    pl_new.add_argument("--批次", default="", help="批次")
    pl_new.add_argument("--截止", default="", help="截止日期")
    pl_new.add_argument("--优先级", default="", choices=["", "高", "中", "低"], help="优先级")
    pl_new.add_argument("--资料", default="", help="资料路径")
    pl_new.add_argument("--附言", default="", help="附言")
    pl_new.set_defaults(func=cmd_plan_new)
    pl_decide = pl_sub.add_parser("decide", help="对规划的决策点做决策")
    pl_decide.add_argument("tid", help="规划任务 id")
    pl_decide.add_argument("dp_id", help="决策点 id")
    pl_decide.add_argument("choice", help="选择的选项")
    pl_decide.add_argument("--note", default="", help="决策备注")
    pl_decide.set_defaults(func=cmd_plan_decide)
    pl_decisions = pl_sub.add_parser("decisions", help="列出待决策项")
    pl_decisions.add_argument("tid", nargs="?", default=None, help="规划 id（省略则列出全部）")
    pl_decisions.set_defaults(func=cmd_plan_decisions)
    pl_list = pl_sub.add_parser("list", help="列出所有规划")
    pl_list.add_argument("--view", default="active", help="视图：active/archive/trash")
    pl_list.set_defaults(func=cmd_plan_list)
    pl_get = pl_sub.add_parser("get", help="获取规划详情")
    pl_get.add_argument("tid", help="规划任务 id")
    pl_get.set_defaults(func=cmd_plan_get)
    args = p.parse_args()
    if not getattr(args, "func", None):
        p.print_help()
        return
    args.func(args)


if __name__ == "__main__":
    main()