#!/usr/bin/env python3
# 方寸 (tegula) — 本地优先多 agent 任务地图
# 零依赖：仅用 Python 标准库。视图服务用 http.server + 轮询 + 编辑 API。
import argparse, os, re, json, shutil, datetime, subprocess, time, threading, urllib.request
from urllib.parse import parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
TASK_DIR = os.path.join(ROOT, "task-data")
REGISTRY_PATH = os.path.join(ROOT, "registry.yaml")
REGISTRY_BAK = os.path.join(ROOT, "registry.yaml.bak")
STATUSES = ["草稿", "待审批", "待办", "进行中", "待验收", "完成", "驳回"]


# ---------- 注册表（让 registry.yaml 真正生效）----------
def _coerce(v):
    v = v.strip()
    if v.startswith("[") and v.endswith("]"):
        inner = v[1:-1].strip()
        return [x.strip().strip("'\"") for x in inner.split(",") if x.strip()] if inner else []
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    return v


def parse_registry(path):
    """极简 YAML 解析，仅适配 registry.yaml 的 projects 列表结构（零依赖）。"""
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except Exception:
        return []
    projects = []
    cur = None
    in_projects = False
    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            continue
        if not raw.startswith(" "):
            m = re.match(r"^([A-Za-z_]+):\s*$", line)
            in_projects = bool(m and m.group(1) == "projects")
            cur = None
            continue
        if not in_projects:
            continue
        if line.strip().startswith("- "):
            rest = line.strip()[2:].strip()
            cur = {"id": "", "name": "", "tasks": "", "repo": "", "tools": [], "sources": []}
            projects.append(cur)
            kv = re.match(r"^([^:]+):\s*(.*)$", rest)
            if kv:
                cur[kv.group(1).strip()] = _coerce(kv.group(2))
            continue
        if cur is not None:
            kv = re.match(r"^([^:]+):\s*(.*)$", line.strip())
            if kv:
                cur[kv.group(1).strip()] = _coerce(kv.group(2))
    return projects


def load_registry():
    return parse_registry(REGISTRY_PATH)


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
    plan = []
    mp = re.search(r"##\s*方案\s*\n(.*?)(?:\n##\s*结果记录\s|\Z)", body, re.S)
    if mp:
        plan = [ln.rstrip() for ln in mp.group(1).splitlines() if ln.strip()]
    result = ""
    mr = re.search(r"##\s*结果记录\s*\n(.*)$", body, re.S)
    if mr:
        result = mr.group(1).strip("\n")
    d["方案"] = plan
    d["结果记录"] = result
    return d


def render_task(d):
    proj = "[" + ", ".join(d.get("项目", [])) + "]"
    res = d.get("资源", {}) if isinstance(d.get("资源"), dict) else {}
    ziliao = res.get("资料", "")
    tools = "[" + ", ".join(res.get("工具", [])) + "]"
    plan = "\n".join(d.get("方案", [])) or "- [ ] "
    result = d.get("结果记录", "") or ""
    return (
        f"---\n"
        f"id: {d.get('id','')}\n"
        f"标题: {d.get('标题','')}\n"
        f"项目: {proj}\n"
        f"状态: {d.get('状态','草稿')}\n"
        f"批次: {d.get('批次','')}\n"
        f"截止: {d.get('截止','')}\n"
        f"优先级: {d.get('优先级','')}\n"
        f"来源: {d.get('来源','human')}\n"
        f"指派: {d.get('指派','hermes')}\n"
        f"验收: {d.get('验收','human')}\n"
        f"资源:\n"
        f"  资料: {ziliao}\n"
        f"  工具: {tools}\n"
        f"---\n"
        f"## 方案\n{plan}\n"
        f"## 结果记录\n{result}\n"
    )


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
                tasks.append(d)
    return tasks


def gen_id():
    today = datetime.date.today().strftime("%Y%m%d")
    n = 1
    if os.path.isdir(TASK_DIR):
        for fn in os.listdir(TASK_DIR):
            if fn.startswith(f"task-{today}-"):
                n += 1
    return f"task-{today}-{n:03d}"


# ---------- 编辑 API 后端 ----------
def api_edit(id, fields):
    fn = os.path.join(TASK_DIR, id + ".md")
    if not os.path.exists(fn):
        return False, "not found"
    d = parse_task(fn)
    if d is None:
        return False, "parse fail"
    for k in ["标题", "状态", "批次", "截止", "优先级", "来源", "指派", "验收"]:
        if k in fields and fields[k] is not None:
            d[k] = fields[k]
    if isinstance(fields.get("项目"), list):
        d["项目"] = fields["项目"]
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
    write_task_file(fn, d)
    return True, "ok"


def api_new(fields):
    os.makedirs(TASK_DIR, exist_ok=True)
    tid = gen_id()
    d = {
        "id": tid,
        "标题": fields.get("标题", "新任务"),
        "项目": fields.get("项目") or ["fangcun-base"],
        "状态": fields.get("状态", "草稿"),
        "批次": fields.get("批次", ""),
        "截止": fields.get("截止", ""),
        "优先级": fields.get("优先级", ""),
        "来源": fields.get("来源", "human"),
        "指派": fields.get("指派", "hermes"),
        "验收": fields.get("验收", "human"),
        "资源": {
            "资料": fields.get("资源资料", ""),
            "工具": fields.get("资源工具") or [],
        },
        "方案": fields.get("方案") or ["- [ ] "],
        "结果记录": fields.get("结果记录", ""),
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
                             capture_output=True, text=True, timeout=30)
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
    reg = load_registry()
    if not reg:
        print("registry.yaml 为空或不存在，跳过。")
        return
    try:
        out = subprocess.run(["hermes", "project", "list"],
                             capture_output=True, text=True, timeout=30)
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
            capture_output=True, text=True, timeout=30)
        if r.returncode == 0:
            print(f"[ok]   注册 {pid} -> {name} ({repo})")
        else:
            print(f"[fail] {pid}: {r.stderr.strip() or r.stdout.strip()}")


def cmd_hermes_open(args):
    """为某任务生成『在对应仓库里派活给 Hermes』的命令；--go 才真正拉起。"""
    reg = {p["id"]: p for p in load_registry()}
    fn = os.path.join(TASK_DIR, args.id + ".md")
    if not os.path.exists(fn):
        print(f"任务不存在: {args.id}")
        return
    d = parse_task(fn)
    if d is None:
        print("解析失败")
        return
    proj_id = (d.get("项目") or [None])[0]
    p = reg.get(proj_id) if proj_id else None
    repo = p.get("repo") if p else None
    if not repo:
        print(f"任务 {args.id} 的项目 {proj_id} 在 registry 中无 repo 路径，无法定位干活仓库。")
        return
    # 回写指令自包含在派活 prompt 里：Hermes 干完活调用方寸 done 命令闭环。
    done_cmd = f'python "E:/CODE/CangKu/fangcun/tegula.py" done {args.id}'
    prompt = (f"执行方寸任务 {args.id}：{d.get('标题','')}\n"
              f"完成后必须回写：执行 {done_cmd} --结果 \"<一句话结果>\"，"
              f"结果会写入任务文件的结果记录并置为待验收。")
    # 用 list 参数直调，避开 shell 对中文路径/自特殊字符的转译（os.system 风险）。
    cmd = ["hermes", "chat", "--in", repo, "-z", prompt]
    print("# 在仓库上下文中派活给 Hermes：")
    print(" ".join(cmd))
    print(f"# 回写命令：{done_cmd} --结果 \"<一句话结果>\"")
    if args.go:
        print("\n>>> 正在拉起 hermes chat（退出后回到此处）...")
        subprocess.run(cmd)


def cmd_done(args):
    """执行方（Hermes 等）完工回写：填结果记录 + 置待验收。幂等、异常不中断。"""
    fn = os.path.join(TASK_DIR, args.id + ".md")
    if not os.path.exists(fn):
        print(f"任务不存在: {args.id}")
        return
    d = parse_task(fn)
    if d is None:
        print("解析失败")
        return
    if args.结果:
        old = (d.get("结果记录") or "").strip()
        d["结果记录"] = (old + "\n" if old else "") + args.结果.strip()
    d["状态"] = "待验收"
    write_task_file(fn, d)
    print(f"OK: {args.id} 已回写结果并置为待验收")


# ---------- HTTP ----------
LAST_REQUEST = time.time()   # 最近一次请求时刻：open 模式靠它判定窗口是否还开着


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        global LAST_REQUEST
        LAST_REQUEST = time.time()
        if self.path.startswith("/tasks.json"):
            self._json()
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

    def _json(self):
        proj = None
        view = "active"
        if "?" in self.path:
            qs = parse_qs(self.path.split("?", 1)[1])
            proj = qs.get("project", [""])[0] or None
            view = qs.get("view", ["active"])[0]
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
        try:
            if action == "edit":
                ok, msg = api_edit(req.get("id"), req.get("fields", {}))
            elif action == "new":
                ok, msg = api_new(req.get("fields", {}))
            elif action == "archive":
                ok, msg = api_archive(req.get("id"))
            elif action == "delete":
                ok, msg = api_delete(req.get("id"))
            elif action == "restore":
                ok, msg = api_restore(req.get("id"), req.get("from", "trash"))
            elif action == "reg_save":
                ok, msg = api_reg_save(req)
            else:
                ok, msg = False, "unknown action"
        except Exception as e:
            ok, msg = False, str(e)
        self._send_json({"ok": ok, "msg": msg})

    def _html(self):
        # 看板页面从独立模板渲染，便于维护与主题重涂；
        # 仅注册表需动态注入（registry.yaml 的项目列表）。
        reg_map = {p["id"]: {"name": p.get("name", p["id"]), "repo": p.get("repo", "")}
                   for p in load_registry()}
        reg_js = json.dumps(reg_map, ensure_ascii=False)
        mem_js = json.dumps(load_members(), ensure_ascii=False)
        tpl_path = os.path.join(ROOT, "templates", "board.html")
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


# ---------- open：一键打开，随关随停 ----------
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
    """双击入口：服务随进程起，Edge 应用窗口打开，窗口全关服务自退。"""
    port = args.port
    reuse = False
    if tegula_alive(port):
        reuse = True          # 已有看板在跑：直接聚焦，不再起第二个
    else:
        free = find_free_port(port)
        if free is None:
            print(f"[错误] {port}-{8790} 端口均被占用。")
            return
        port = free

    edge = find_edge()
    if not edge:
        print("[错误] 未找到 Edge，无法打开应用窗口。")
        return
    # --app 模式：无浏览器框的独立窗口；不同 port 用不同 profile 目录，避免多实例互相顶掉
    user_dir = os.path.join(os.environ.get("TEMP", "."), f"tegula_edge_{port}")
    subprocess.Popen([edge, f"--app=http://127.0.0.1:{port}/", f"--user-data-dir={user_dir}",
                      "--window-size=1280,860"],
                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    if reuse:
        return                # 服务已在别处运行，这边只负责唤窗

    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    stop = threading.Event()

    def watch_window():
        # 阶段一：等首请求（Edge 冷启动可能较慢，宽限至少 60s）
        t0 = LAST_REQUEST
        grace = max(args.wait, 60)
        while time.time() - t0 < grace:
            if LAST_REQUEST != t0:
                break
            time.sleep(1)
        # 阶段二：稳态运行中，90s 无任何请求 = 窗口已关，服务自退
        while not stop.is_set():
            if time.time() - LAST_REQUEST > 90:
                stop.set()
                break
            time.sleep(2)

    threading.Thread(target=watch_window, daemon=True).start()
    print(f"方寸看板: http://127.0.0.1:{port}/  （窗口全关后自动退出）")
    try:
        while not stop.is_set():
            srv.timeout = 1
            srv.handle_request()   # 逐个处理请求，同时能秒级响应退出信号
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


# ---------- CLI ----------
def cmd_new(args):
    tid, msg = api_new({
        "标题": args.title,
        "项目": args.项目 or ["fangcun-base"],
        "来源": args.来源,
        "指派": args.指派,
    })
    print(f"已创建任务: {tid}")


def cmd_serve(args):
    port = args.port
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
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
    n.add_argument("--来源", default="human")
    n.add_argument("--指派", default="hermes")
    n.set_defaults(func=cmd_new)
    s = sub.add_parser("serve", help="启动本地看板视图（零依赖）")
    s.add_argument("--port", type=int, default=8753)
    s.set_defaults(func=cmd_serve)
    o = sub.add_parser("open", help="一键打开：服务随进程起，Edge 应用窗口打开，关窗自退")
    o.add_argument("--port", type=int, default=8753)
    o.add_argument("--wait", type=int, default=15, help="窗口端冷静期秒数（首个请求前的宽限）")
    o.set_defaults(func=cmd_open)
    hs = sub.add_parser("hermes-sync", help="把 registry.yaml 里的项目注册进 Hermes（幂等）")
    hs.set_defaults(func=cmd_hermes_sync)
    ho = sub.add_parser("hermes-open", help="为某任务生成在仓库里派活给 Hermes 的命令")
    ho.add_argument("id", help="任务 id，如 task-20260828-003")
    ho.add_argument("--go", action="store_true", help="真正拉起 hermes chat")
    ho.set_defaults(func=cmd_hermes_open)
    dn = sub.add_parser("done", help="执行方完工回写：填结果记录并置为待验收")
    dn.add_argument("id", help="任务 id，如 task-20260828-003")
    dn.add_argument("--结果", "--result", dest="结果", default="", help="一句话结果，追加到结果记录")
    dn.set_defaults(func=cmd_done)
    args = p.parse_args()
    if not getattr(args, "func", None):
        p.print_help()
        return
    args.func(args)


if __name__ == "__main__":
    main()
