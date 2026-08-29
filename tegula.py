#!/usr/bin/env python3
# 方寸 (tegula) — 本地优先多 agent 任务地图
# 零依赖：仅用 Python 标准库。视图服务用 http.server + 轮询 + 编辑 API。
import argparse, os, re, json, shutil, datetime, subprocess
from urllib.parse import parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
TASK_DIR = os.path.join(ROOT, "task-data")
REGISTRY_PATH = os.path.join(ROOT, "registry.yaml")
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
    for k in ["标题", "状态", "批次", "来源", "指派", "验收"]:
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
        print(f"任务 {args.id} 的项目 {proj_id} 在 registry 中无 repo 路径，无法定位仓库。")
        return
    prompt = f'执行方寸任务 {args.id}：{d.get("标题","")}'
    cmd = f'hermes chat --in "{repo}" -z "{prompt}"'
    print("# 在仓库上下文中派活给 Hermes：")
    print(cmd)
    if args.go:
        print("\n>>> 正在拉起 hermes chat（退出后回到此处）...")
        os.system(cmd)


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/tasks.json"):
            self._json()
        else:
            self._html()

    def do_POST(self):
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
            else:
                ok, msg = False, "unknown action"
        except Exception as e:
            ok, msg = False, str(e)
        self._send_json({"ok": ok, "msg": msg})

    def _html(self):
        # 仅加载一次；之后由前端 fetch /tasks.json 原地重绘，不整页 reload，
        # 因此不会触发桌面端把焦点抢回预览页。
        reg_map = {p["id"]: {"name": p.get("name", p["id"]), "repo": p.get("repo", "")}
                   for p in load_registry()}
        reg_js = json.dumps(reg_map, ensure_ascii=False)
        page = (
            '<!doctype html><meta charset=utf-8>\n'
            '<title>方寸 tegula</title>\n'
            '<style>'
            'body{font-family:system-ui;margin:0;background:#f5f5f5;color:#222}'
            '#bar{padding:8px 14px;background:#222;color:#eee;font-weight:600;'
            'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px}'
            '#bar button{font-size:12px;cursor:pointer;padding:3px 10px;border:0;border-radius:4px;'
            'background:#3b82f6;color:#fff;margin-left:6px}'
            '#projFilter,#groupMode{padding:3px 6px;border-radius:4px;border:0;font-size:12px;margin-right:6px}'
            '#search{padding:3px 6px;border:0;border-radius:4px;font-size:12px;width:130px;margin-right:6px}'
            '#views{padding:5px 14px;background:#333;display:flex;gap:6px}'
            '.vbtn{font-size:12px;cursor:pointer;padding:3px 12px;border:0;border-radius:4px;'
            'background:#555;color:#eee}'
            '.vbtn.on{background:#3b82f6;color:#fff}'
            '#board{display:flex;gap:10px;padding:10px;align-items:flex-start;'
            'overflow-x:auto;min-height:58vh}'
            '.col{background:#fff;border-radius:8px;min-width:230px;padding:8px;flex:1}'
            '.col h3{margin:4px 0 8px;font-size:14px}'
            '.card{border:1px solid #ddd;border-radius:6px;padding:6px;'
            'margin-bottom:6px;background:#fafafa;cursor:pointer}'
            '.card:hover{background:#eef4ff}'
            '.card.dragover{outline:2px dashed #3b82f6;background:#eef4ff}'
            '.card .batch{display:inline-block;background:#e8f0fe;color:#1a56db;'
            'border-radius:4px;font-size:11px;padding:0 5px;margin-right:4px}'
            '.ptags{margin-top:3px}'
            '.ptag{display:inline-block;background:#eef2ff;color:#4338ca;'
            'border-radius:4px;font-size:10px;padding:0 5px;margin:0 3px 2px 0}'
            '.card small{color:#888;display:block;margin-top:3px}'
            '#overlay,#roverlay{position:fixed;inset:0;background:rgba(0,0,0,.4);display:none;'
            'align-items:center;justify-content:center;z-index:50}'
            '#modal,#rmodal{background:#fff;border-radius:10px;padding:16px;width:440px;max-height:86vh;overflow:auto}'
            '#modal h3,#rmodal h3{margin:0 0 10px}'
            '#modal label{display:block;font-size:12px;color:#555;margin:8px 0 2px}'
            '#modal input,#modal select,#modal textarea{width:100%;box-sizing:border-box;'
            'padding:5px;border:1px solid #ccc;border-radius:5px;font-size:13px}'
            '#modal textarea{height:64px;resize:vertical}'
            '.acts{margin-top:14px;display:flex;gap:6px;justify-content:flex-end}'
            '.acts button{padding:5px 12px;border:0;border-radius:5px;cursor:pointer;font-size:13px}'
            '.acts .pri{background:#3b82f6;color:#fff}'
            '.acts .warn{background:#f59e0b;color:#fff}'
            '.acts .danger{background:#ef4444;color:#fff}'
            '.acts .ghost{background:#eee;color:#333}'
            '</style>\n'
            '<div id=bar><span>方寸 tegula · <span id=count>0</span> 任务</span>'
            '<span style="font-weight:400">'
            '<select id=projFilter></select>'
            '<select id=groupMode>'
            '<option value="status">按状态</option>'
            '<option value="batch">按批次</option>'
            '<option value="project">按项目</option>'
            '</select>'
            '<input id=search placeholder="搜索标题/编号">'
            '<button onclick="openNew()">+ 新建</button>'
            '<button onclick="load()">刷新</button></span></div>\n'
            '<div id=views>'
            '<button class="vbtn on" data-view="active" onclick="setView(\'active\')">看板</button>'
            '<button class="vbtn" data-view="archive" onclick="setView(\'archive\')">归档</button>'
            '<button class="vbtn" data-view="trash" onclick="setView(\'trash\')">回收站</button>'
            '</div>\n'
            '<div id=board></div>\n'
            '<div id=overlay onclick="if(event.target===this)closeModal()">'
            '<div id=modal>'
            '<h3 id=mTitle>编辑</h3>'
            '<label>标题<input id=f_title></label>'
            '<label>状态<select id=f_status></select></label>'
            '<label>批次<input id=f_batch></label>'
            '<label>项目（逗号分隔）<input id=f_project></label>'
            '<label>指派<input id=f_assignee></label>'
            '<label>验收<input id=f_accept></label>'
            '<label>资源 · 资料（路径）<input id=f_resdoc></label>'
            '<label>资源 · 工具（逗号分隔）<input id=f_restool></label>'
            '<label>方案（每行一项，支持 - [ ] / - [x]）<textarea id=f_plan></textarea></label>'
            '<label>结果记录<textarea id=f_result></textarea></label>'
            '<div class=acts>'
            '<button class=ghost onclick="closeModal()">取消</button>'
            '<button class=danger onclick="doDelete()">删除</button>'
            '<button class=warn onclick="doArchive()">归档</button>'
            '<button class=pri onclick="save()">保存</button>'
            '</div></div></div>\n'
            '<div id=roverlay onclick="if(event.target===this)closeR()">'
            '<div id=rmodal>'
            '<h3 id=rTitle>还原</h3>'
            '<div id=rInfo style="font-size:13px;color:#444"></div>'
            '<div class=acts>'
            '<button class=ghost onclick="closeR()">取消</button>'
            '<button class=pri onclick="doRestore()">还原到看板</button>'
            '</div></div></div>\n'
            '<script>\n'
            'const STATUSES=["草稿","待审批","待办","进行中","待验收","完成","驳回"];\n'
            'const REGISTRY=' + reg_js + ';\n'
            'let TASKS=[]; let curId=null; let curProj="__all__"; let curView="active";\n'
            'function pname(id){return REGISTRY[id]?REGISTRY[id].name:id;}\n'
            'function el(id){return document.getElementById(id);}\n'
            '(function init(){\n'
            '  const pf=el("projFilter");\n'
            '  let h=\'<option value="__all__">全部项目</option>\';\n'
            '  Object.entries(REGISTRY).forEach(([id,p])=>{h+=\'<option value="\'+id+\'">\'+p.name+\'</option>\';});\n'
            '  pf.innerHTML=h; pf.onchange=()=>{curProj=pf.value; load();};\n'
            '  el("f_status").innerHTML=STATUSES.map(s=>"<option>"+s+"</option>").join("");\n'
            '  el("search").oninput=render; el("groupMode").onchange=render;\n'
            '  // 事件委托：在 board 上监听点击，避免轮询重建丢失绑定\n'
            '  el("board").addEventListener("click",e=>{\n'
            '    const c=e.target.closest(".card"); if(!c) return;\n'
            '    openCard(c.dataset.id);\n'
            '  });\n'
            '  // 拖拽：卡片拖到另一列即改该列状态\n'
            '  let dragId=null;\n'
            '  el("board").addEventListener("dragstart",e=>{const c=e.target.closest(".card"); if(!c)return; dragId=c.dataset.id; e.dataTransfer.setData("text/plain",dragId);});\n'
            '  el("board").addEventListener("dragover",e=>{const col=e.target.closest(".col"); if(col){e.preventDefault();}});\n'
            '  el("board").addEventListener("drop",e=>{\n'
            '    const col=e.target.closest(".col"); if(!col||!dragId) return;\n'
            '    e.preventDefault(); const st=col.dataset.status; if(st&&curView==="active"){ moveStatus(dragId,st); }\n'
            '  });\n'
            '})();\n'
            'function setView(v){curView=v;'
            'document.querySelectorAll("#views .vbtn").forEach(b=>b.classList.toggle("on",b.dataset.view===v));'
            'load();}\n'
            'async function load(){\n'
            '  try{\n'
            '    const url="/tasks.json?view="+encodeURIComponent(curView)'
            '+(curProj!=="__all__"?("&project="+encodeURIComponent(curProj)):"");\n'
            '    const r=await fetch(url);const d=await r.json();TASKS=d;\n'
            '    el("count").textContent=d.length;\n'
            '    render();\n'
            '  }catch(err){console.error("load failed",err);}\n'
            '}\n'
            'function render(){\n'
            '  const q=(el("search").value||"").trim().toLowerCase();\n'
            '  const mode=el("groupMode").value;\n'
            '  const filtered=TASKS.filter(t=>!q || (t.标题||"").toLowerCase().includes(q)'
            ' || (t.id||"").toLowerCase().includes(q) || (t.项目||[]).join(" ").toLowerCase().includes(q));\n'
            '  const cols={}; const order=[];\n'
            '  function push(gv,t){if(!(gv in cols)){cols[gv]=[];order.push(gv);}cols[gv].push(t);}\n'
            '  filtered.forEach(t=>{\n'
            '    let keys;\n'
            '    if(mode==="batch")keys=[t.批次||"未分批次"];\n'
            '    else if(mode==="project")keys=(t.项目&&t.项目.length)?t.项目:["未归属"];\n'
            '    else keys=[t.状态||"草稿"];\n'
            '    keys.forEach(k=>push(k,t));\n'
            '  });\n'
            '  let colOrder = (mode==="status") ? STATUSES.filter(s=>s in cols) : order.slice().sort();\n'
            '  const board=el("board");board.innerHTML="";\n'
            '  colOrder.forEach(gv=>{\n'
            '    const items=cols[gv]||[];\n'
            '    const col=document.createElement("div");col.className="col";\n'
            '    if(mode==="status")col.dataset.status=gv;\n'
            '    const h3=document.createElement("h3");h3.textContent=gv+" ("+items.length+")";col.appendChild(h3);\n'
            '    items.forEach(t=>{\n'
            '      const c=document.createElement("div");c.className="card";c.dataset.id=t.id;c.draggable=true;\n'
            '      const b=document.createElement("b");\n'
            '      const bt=document.createElement("span");bt.className="batch";bt.textContent="批"+(t.批次||"?");\n'
            '      b.appendChild(bt);b.appendChild(document.createTextNode(" "+t.标题));\n'
            '      const tags=document.createElement("div");tags.className="ptags";\n'
            '      (t.项目||[]).forEach(id=>{const sp=document.createElement("span");sp.className="ptag";sp.textContent=pname(id);tags.appendChild(sp);});\n'
            '      const sm=document.createElement("small");sm.textContent=t.id+" · 指派 "+t.指派;\n'
            '      c.appendChild(b);c.appendChild(tags);c.appendChild(sm);col.appendChild(c);\n'
            '    });\n'
            '    board.appendChild(col);\n'
            '  });\n'
            '}\n'
            'function openCard(id){const t=TASKS.find(x=>x.id===id);if(!t)return;curId=id;\n'
            '  if(curView==="active")openEdit(t);else openRestore(t);}\n'
            'function openEdit(t){curId=t.id;\n'
            '  el("mTitle").textContent="编辑 "+t.id;\n'
            '  f_title.value=t.标题||"";f_status.value=t.状态||"草稿";f_batch.value=t.批次||"";\n'
            '  f_project.value=(t.项目||[]).join(", ");f_assignee.value=t.指派||"";f_accept.value=t.验收||"";\n'
            '  const res=t.资源||{};f_resdoc.value=res.资料||"";f_restool.value=(res.工具||[]).join(", ");\n'
            '  f_plan.value=(t.方案||[]).join("\\n");f_result.value=t.结果记录||"";\n'
            '  el("overlay").style.display="flex";}\n'
            'function openNew(){curId=null;\n'
            '  el("mTitle").textContent="新建任务";\n'
            '  f_title.value="";f_status.value="草稿";f_batch.value="";\n'
            '  f_project.value="rosa-chuangzuo";f_assignee.value="hermes";f_accept.value="human";\n'
            '  f_resdoc.value="";f_restool.value="";f_plan.value="- [ ] ";f_result.value="";\n'
            '  el("overlay").style.display="flex";}\n'
            'function closeModal(){el("overlay").style.display="none";}\n'
            'function openRestore(t){el("rTitle").textContent="还原 "+t.id;\n'
            '  el("rInfo").innerHTML="<b>"+(t.标题||"")+"</b><br>当前位于："+(curView==="archive"?"归档":"回收站")+"<br><small>"+t.id+"</small>";\n'
            '  el("roverlay").style.display="flex";}\n'
            'function closeR(){el("roverlay").style.display="none";}\n'
            'function sv(v){return (v||"").split(",").map(s=>s.trim()).filter(Boolean);}\n'
            'async function post(body){const r=await fetch("/api",{method:"POST",'
            'headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});\n'
            '  const j=await r.json();if(!j.ok)alert("失败："+j.msg);return j;}\n'
            'async function save(){const fields={\n'
            '  标题:f_title.value,状态:f_status.value,批次:f_batch.value,\n'
            '  项目:sv(f_project.value),指派:f_assignee.value,验收:f_accept.value,\n'
            '  资源资料:f_resdoc.value,资源工具:sv(f_restool.value),\n'
            '  方案:f_plan.value.split("\\n").map(s=>s.trim()).filter(Boolean),\n'
            '  结果记录:f_result.value};\n'
            '  const body=curId?{action:"edit",id:curId,fields}:{action:"new",fields};\n'
            '  await post(body);closeModal();load();}\n'
            'async function doArchive(){if(!curId)return;await post({action:"archive",id:curId});closeModal();load();}\n'
            'async function doDelete(){if(!curId)return;if(!confirm("删除（移入回收站，可恢复）？"))return;'
            '  await post({action:"delete",id:curId});closeModal();load();}\n'
            'async function doRestore(){if(!curId)return;'
            '  await post({action:"restore",id:curId,from:curView==="archive"?"archive":"trash"});'
            '  closeR();load();}\n'
            'async function moveStatus(id,status){await post({action:"edit",id:id,fields:{状态:status}});load();}\n'
            'load();setInterval(load,2000);\n'
            '</script>'
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(page.encode("utf-8"))

    def log_message(self, *a):
        pass


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
    hs = sub.add_parser("hermes-sync", help="把 registry.yaml 里的项目注册进 Hermes（幂等）")
    hs.set_defaults(func=cmd_hermes_sync)
    ho = sub.add_parser("hermes-open", help="为某任务生成在仓库里派活给 Hermes 的命令")
    ho.add_argument("id", help="任务 id，如 task-20260828-003")
    ho.add_argument("--go", action="store_true", help="真正拉起 hermes chat")
    ho.set_defaults(func=cmd_hermes_open)
    args = p.parse_args()
    if not getattr(args, "func", None):
        p.print_help()
        return
    args.func(args)


if __name__ == "__main__":
    main()
