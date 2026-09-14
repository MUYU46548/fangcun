"""tegula.web — HTTP 服务 + Handler + 托盘"""
import json, os, shutil, subprocess, sys, threading, time, webbrowser, zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

from tegula.core import (
    ROOT, TASK_DIR, REGISTRY_PATH, REGISTRY_BAK, BACKUP_DIR, BACKUP_KEEP,
    ACTIVITY_LOG, STATUSES, _NOWIN, MANAGED_KEYS, TASKFN, _GATES,
    ALLOWED_SYNC_PROFILE, AGENT_RUNS_LOG, _AGENT_CMD_MAP, RULES_PATH,
    DEFAULT_RULES, LAST_REQUEST, _STATUS_CACHE, STATUS_TTL, WRITE_ACTIONS,
    _STATUS_SCAN_LOCK, QUICK_PRIO, PORT_FILE, _NOTES_DIR, _NOTES_INDEX,
    _PERSONAL_PROJECT, _INBOX_TAG, _RECURRING_FIELD, _ROADMAP_CACHE,
    ROADMAP_TTL, _ROADMAP_HISTORY, ROADMAP_HISTORY_MAX, MCP_METHODS,
    _init_data_dir, _coerce, parse_registry, load_all_projects,
    scan_services, _port_in_use, start_service, stop_service,
    load_members, save_registry_block, _split_body, parse_task,
    render_task, write_task_file, parse_natural_query, load_tasks,
    _all_task_dirs, locate_task, blockers_of, find_blockers, gen_id,
    _now_ts, _bump_version, _task_version, _mtime_guard, api_edit,
    api_review, gate_open, gate_check, gate_list, gate_close,
    load_template, api_new, _parse_decision_points, _render_decision_points,
    api_plan_new, api_plan_decide, api_plan_list, api_plan_get,
    _move_to, api_archive, api_delete, api_restore, api_reg_save,
    api_batch_edit, api_batch_archive, api_batch_delete, api_backup,
    _active_hermes_profile, log_activity, read_activity, _gen_run_id,
    log_agent_run, read_agent_runs, _hermes_cmd, _claude_cmd, _codex_cmd,
    _kun_cmd, _agent_cmd, _build_prompt, prepare_dispatch, dispatch_task,
    api_dispatch, allowed_roots, validate_open_path, api_open_file,
    _rules_path, load_rules, save_rules, _plan_all_checked, evaluate_rules,
    esc, _status_snapshot_path, _load_status_snapshot, _read_port_file,
    _clear_port_file, _diagnose_port_conflict, tegula_alive, find_edge,
    check_registry_consistency, _relative_time, _scan_git_remote,
    scan_project_status, suggest_actions, suggest_cross_project,
    find_timeout_tasks, _ensure_notes_dir, _load_notes_index,
    _save_notes_index, _gen_note_id, api_note_create, api_note_get,
    api_note_update, api_note_delete, api_note_attach, api_note_detach,
    api_notes_for_task, api_note_import_file, _parse_cron,
    _should_fire_cron, check_recurring_tasks, _match_context,
    api_inbox_add, api_inbox_dismiss, api_inbox_promote, api_inbox_import_file, _batch_status,
    aggregate_roadmap, get_roadmap_cached, mcp_get_roadmap,
    _record_roadmap_snapshot, get_roadmap_trend,
    _detect_parallel_opportunities, _suggest_milestones, get_roadmap_full,
    mcp_get_roadmap_full, _mcp_task_view, mcp_list_tasks, mcp_get_task,
    mcp_get_project_status, mcp_list_projects, mcp_search_tasks,
    mcp_handle, mcp_gate_open, mcp_gate_check, mcp_gate_list,
    mcp_gate_close, mcp_plan_list, mcp_plan_get, mcp_plan_pending_decisions,
    _detect_events, api_quick_add, api_rules, api_agent_runs,
    project_status_payload, _create_tray_icon,
)


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
            elif action == "inbox_add":
                ok, msg = api_inbox_add(req.get("text", ""))
                if not ok:
                    self._send_json({"ok": False, "error": msg})
                    return
                self._send_json({"ok": True, "id": msg})
                return
            elif action == "inbox_dismiss":
                ok, msg = api_inbox_dismiss(req.get("id"))
                self._send_json({"ok": ok, "msg": msg})
                return
            elif action == "inbox_promote":
                ok, msg = api_inbox_promote(req.get("id"))
                self._send_json({"ok": ok, "msg": msg})
                return
            elif action == "inbox_import_file":
                ok, msg = api_inbox_import_file(req.get("path", ""))
                if not ok:
                    self._send_json({"ok": False, "error": msg})
                    return
                self._send_json({"ok": True, "id": msg})
                return
            elif action == "cron_check":
                reactivated = check_recurring_tasks()
                self._send_json({"ok": True, "reactivated": reactivated})
                return
            elif action == "inbox_list":
                inbox_tasks = []
                for t in load_tasks(view="active"):
                    tags = t.get("标签") or []
                    if "inbox" in tags:
                        inbox_tasks.append(t)
                self._send_json({"ok": True, "inbox": inbox_tasks})
                return
            elif action == "note_create":
                ok, msg = api_note_create(
                    req.get("title", ""),
                    req.get("content", ""),
                    req.get("task_id")
                )
                if not ok:
                    self._send_json({"ok": False, "error": msg})
                    return
                self._send_json({"ok": True, "id": msg})
                return
            elif action == "note_get":
                note = api_note_get(req.get("id"))
                if not note:
                    self._send_json({"ok": False, "error": "not found"})
                    return
                self._send_json({"ok": True, "note": note})
                return
            elif action == "note_update":
                ok, msg = api_note_update(
                    req.get("id"),
                    req.get("title"),
                    req.get("content")
                )
                self._send_json({"ok": ok, "msg": msg})
                return
            elif action == "note_delete":
                ok, msg = api_note_delete(req.get("id"))
                self._send_json({"ok": ok, "msg": msg})
                return
            elif action == "note_attach":
                ok, msg = api_note_attach(req.get("id"), req.get("task_id"))
                self._send_json({"ok": ok, "msg": msg})
                return
            elif action == "note_detach":
                ok, msg = api_note_detach(req.get("id"), req.get("task_id"))
                self._send_json({"ok": ok, "msg": msg})
                return
            elif action == "notes_for_task":
                notes = api_notes_for_task(req.get("task_id"))
                self._send_json({"ok": True, "notes": notes})
                return
            elif action == "note_import_file":
                ok, msg = api_note_import_file(req.get("path"), req.get("task_id"))
                if not ok:
                    self._send_json({"ok": False, "error": msg})
                    return
                self._send_json({"ok": True, "id": msg})
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

            status = p.get("状态", "")
            roadmap = p.get("路线图", "")
            status_html = f'<span class="status">{esc(status)}</span>' if status else ""
            roadmap_html = f'<span class="roadmap">{esc(roadmap)}</span>' if roadmap else ""

            cards.append(f"""
            <a class="tool" href="http://127.0.0.1:{port}/?project={esc(pid)}" target="_blank" rel="noopener">
                <div class="ico">📁</div>
                <div class="body">
                    <h2>{esc(name)}</h2>
                    <p>{esc(repo)}</p>
                    {roadmap_html}
                </div>
                <span class="port">{esc(tools_str)}</span>
                <span class="status-tag">{status_html}</span>
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
.tool .status-tag{{flex:none}}
.tool .status{{display:inline-block;font-size:10px;font-weight:600;padding:2px 7px;border-radius:6px;background:#eef0fb;color:#5b5478;margin-left:6px}}
.tool .roadmap{{display:block;font-size:11px;color:var(--muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
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


