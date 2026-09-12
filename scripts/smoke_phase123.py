#!/usr/bin/env python3
# Phase 1/2/3 冒烟：在临时 task-data 上起真实 HTTP 服务，打全部新 API，跑完自动清理。
# 用法：python scripts/smoke_phase123.py
import importlib.util, json, os, shutil, sys, tempfile, threading, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("tegula", os.path.join(ROOT, "tegula.py"))
teg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(teg)

tmp = tempfile.mkdtemp(prefix="tegula_smoke_")
teg.TASK_DIR = os.path.join(tmp, "task-data")
os.makedirs(teg.TASK_DIR, exist_ok=True)
teg.REGISTRY_PATH = os.path.join(tmp, "registry.yaml")
with open(teg.REGISTRY_PATH, "w", encoding="utf-8") as f:
    f.write("members:\n  - 暮雨\n  - hermes\nprojects:\n"
            f"  - id: fangcun-base\n    name: 方寸\n    tasks: \"\"\n    repo: {ROOT}\n")
teg._STATUS_CACHE["data"] = None

PORT = 8756
teg.LAST_REQUEST = time.time()
srv = teg.QServer(("127.0.0.1", PORT), teg.Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
time.sleep(0.4)

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS  " if cond else "FAIL  ") + name + (f"  [{detail}]" if detail and not cond else ""))

OP = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # 绕开沙箱 HTTP 代理
def api(body):
    r = OP.open(urllib.request.Request(f"http://127.0.0.1:{PORT}/api",
               data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}))
    return json.loads(r.read())

def get_tasks():
    with OP.open(f"http://127.0.0.1:{PORT}/tasks.json?view=active") as r:
        return json.loads(r.read())

try:
    # ---- 1.1 子任务可勾选：方案往返 ----
    r = api({"action": "new", "fields": {"标题": "冒烟任务", "状态": "进行中",
                                         "项目": ["fangcun-base"], "方案": ["- [ ] 一", "- [ ] 二"]}})
    tid = r["msg"]
    check("new 返回任务 id", r["ok"] and tid.startswith("task-"), str(r))
    r = api({"action": "edit", "id": tid, "fields": {"方案": ["- [x] 一", "- [ ] 二"]}})
    t = [x for x in get_tasks() if x["id"] == tid][0]
    check("方案勾选落盘", r["ok"] and t["方案"] == ["- [x] 一", "- [ ] 二"], str(t.get("方案")))
    # 用已过期的版本号再写一次：必须被乐观锁拒绝（同秒写入也要挡住）
    r = api({"action": "edit", "id": tid,
             "fields": {"方案": ["- [x] 一", "- [x] 二"], "expected_update": "1"}})
    check("过期版本号触发乐观锁冲突", r["ok"] is False and "conflict" in r["msg"], str(r))

    # ---- 1.2 标签系统 ----
    r = api({"action": "edit", "id": tid, "fields": {"标签": ["bug", "紧急"]}})
    t = [x for x in get_tasks() if x["id"] == tid][0]
    check("标签写入", r["ok"] and t["标签"] == ["bug", "紧急"], str(t.get("标签")))
    raw = open(os.path.join(teg.TASK_DIR, tid + ".md"), encoding="utf-8").read()
    check("标签进 frontmatter", "标签: [bug, 紧急]" in raw, raw[:400])
    r = api({"action": "edit", "id": tid, "fields": {"标签": []}})
    raw = open(os.path.join(teg.TASK_DIR, tid + ".md"), encoding="utf-8").read()
    check("空标签不渲染（无残迹）", "标签:" not in raw)
    api({"action": "edit", "id": tid, "fields": {"标签": ["bug"]}})

    # ---- 1.3 open_file 白名单 ----
    r = api({"action": "open_file", "path": "E:/Windows/win.ini"})
    check("越权路径拒绝", r["ok"] is False and "允许范围" in r["msg"], str(r))
    r = api({"action": "open_file", "path": "../../etc/passwd"})
    check("路径回溯拦截", r["ok"] is False and "回溯" in r["msg"], str(r))
    ok, err = teg.validate_open_path(os.path.join(ROOT, "tegula.py"))
    check("白名单内合法路径放行", ok and not err, err)
    ok, err = teg.validate_open_path("tegula.py")
    check("相对路径基于项目根解析", ok and not err, err)
    ok, err = teg.validate_open_path("")
    check("空路径拒绝", ok is None and err, str(err))
    ok, err = teg.validate_open_path("x\x00y")
    check("控制字符拒绝", ok is None and "控制字符" in err, str(err))
    ok, err = teg.validate_open_path("E:/Windows/win.ini")
    check("registry 外绝对路径拒绝", ok is None and "允许范围" in err, str(err))
    # 环境变量类路径不被展开、直接判越界
    ok, err = teg.validate_open_path("%WINDIR%/win.ini")
    check("含 % 变量路径不越权放行", ok is None, str(ok))

    # ---- 2.1 快速添加语法 ----
    r = api({"action": "quick_add", "text": "Fix login p1 #backend @hermes due:09-15"})
    check("quick_add 创建成功", r["ok"] and r["msg"].startswith("task-"), str(r))
    q = teg.parse_task(os.path.join(teg.TASK_DIR, r["msg"] + ".md"))
    check("快速添加解析：标题", q["标题"] == "Fix login", q["标题"])
    check("快速添加解析：优先级 p1→中", q["优先级"] == "中", q["优先级"])
    check("快速添加解析：标签", q["标签"] == ["backend"], str(q["标签"]))
    check("快速添加解析：指派", q["指派"] == "hermes", q["指派"])
    check("快速添加解析：截止", q["截止"] == "09-15", q["截止"])
    check("快速添加解析：默认状态待办", q["状态"] == "待办", q["状态"])
    q2, e2 = teg.parse_quick_add("标题 to:待验收")
    check("快速添加 to: 指定状态", q2 and q2["状态"] == "待验收", str(q2))
    q3, e3 = teg.parse_quick_add("标题 to:乱写")
    check("快速添加 非法状态报错", q3 is None and "未知状态" in e3, str(e3))
    q4, e4 = teg.parse_quick_add("p1 #a")
    check("快速添加 标题为空报错", q4 is None and "标题为空" in e4, str(e4))
    q5, e5 = teg.parse_quick_add("")
    check("快速添加 空输入报错", q5 is None, str(e5))
    q6, e6 = teg.parse_quick_add("p0 p2 #a #a #b 标题")
    check("快速添加 优先级取首个/标签去重", q6["优先级"] == "高" and q6["标签"] == ["a", "b"], str(q6))

    # ---- 3.1 自动化规则：方案全完成 → 待验收 ----
    ok, tid2 = teg.api_new({"标题": "规则任务", "状态": "进行中", "项目": ["fangcun-base"],
                            "方案": ["- [ ] 一", "- [ ] 二"]})
    r = api({"action": "edit", "id": tid2, "fields": {"方案": ["- [x] 一", "- [x] 二"]}})
    d2 = teg.parse_task(os.path.join(teg.TASK_DIR, tid2 + ".md"))
    check("规则触发：全勾选自动推进待验收", r["ok"] and d2["状态"] == "待验收", str(d2["状态"]))
    check("规则触发：msg 回带规则名", "已触发规则" in str(r.get("msg")), str(r.get("msg")))
    # 部分勾选不触发
    ok, tid3 = teg.api_new({"标题": "规则任务2", "状态": "进行中", "项目": ["fangcun-base"],
                            "方案": ["- [ ] 一", "- [ ] 二"]})
    r = api({"action": "edit", "id": tid3, "fields": {"方案": ["- [x] 一", "- [ ] 二"]}})
    d3 = teg.parse_task(os.path.join(teg.TASK_DIR, tid3 + ".md"))
    check("规则不误触发：部分勾选保持进行中", d3["状态"] == "进行中" and "已触发规则" not in str(r.get("msg")), str(d3["状态"]))
    # 非进行中不触发
    ok, tid4 = teg.api_new({"标题": "规则任务3", "状态": "待办", "项目": ["fangcun-base"],
                            "方案": ["- [ ] 一"]})
    api({"action": "edit", "id": tid4, "fields": {"方案": ["- [x] 一"]}})
    d4 = teg.parse_task(os.path.join(teg.TASK_DIR, tid4 + ".md"))
    check("规则条件限定进行中", d4["状态"] == "待办", str(d4["状态"]))
    # 禁用规则后不触发
    api({"action": "rules", "op": "save", "rules": [
        {"id": "rule-1", "name": "方案全完成自动推进", "trigger": "field_change",
         "condition": {"field": "方案", "all_checked": True},
         "action": {"type": "set_status", "value": "待验收"}, "enabled": False}]})
    ok, tid5 = teg.api_new({"标题": "规则任务4", "状态": "进行中", "项目": ["fangcun-base"],
                            "方案": ["- [ ] 一"]})
    api({"action": "edit", "id": tid5, "fields": {"方案": ["- [x] 一"]}})
    d5 = teg.parse_task(os.path.join(teg.TASK_DIR, tid5 + ".md"))
    check("规则禁用后不触发", d5["状态"] == "进行中", str(d5["状态"]))
    api({"action": "rules", "op": "save", "rules": teg.DEFAULT_RULES})

    # 规则文件损坏不影响主流程
    with open(teg._rules_path(), "w", encoding="utf-8") as f:
        f.write("{broken")
    check("规则文件损坏安全回退", len(teg.load_rules()) == 2)
    check("规则损坏后 api_edit 仍可用",
          api({"action": "edit", "id": tid3, "fields": {"标题": "改名后"}})["ok"] is True)

    # 超时徽章阈值
    old = str(time.time() - 50 * 3600)
    check("超时徽章命中（50h>=48h）",
          teg.timeout_badge_hours({"状态": "进行中", "派活时间": old}) == 48)
    check("超时徽章不命中（1h）",
          teg.timeout_badge_hours({"状态": "进行中", "派活时间": str(time.time() - 3600)}) is None)
    check("非进行中不算超时",
          teg.timeout_badge_hours({"状态": "待办", "派活时间": old}) is None)

    # ---- 3.2 MCP 只读接口 ----
    resp = teg.mcp_handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    check("MCP initialize 握手", resp["result"]["serverInfo"]["name"] == "tegula"
          and "tools" in resp["result"]["capabilities"], str(resp))
    resp = teg.mcp_handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
    names = [t["name"] for t in resp["result"]["tools"]]
    check("MCP tools/list 返回 5 个工具", len(names) == 5, str(names))
    check("MCP 工具名齐全", set(names) == {"list_tasks", "get_task", "get_project_status",
                                          "list_projects", "search_tasks"}, str(names))
    resp = teg.mcp_handle({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                           "params": {"name": "list_tasks", "arguments": {}}})
    body = json.loads(resp["result"]["content"][0]["text"])
    check("MCP list_tasks 返回任务", isinstance(body, list) and len(body) > 0, str(type(body)))
    check("MCP list_tasks 带方案进度", "方案进度" in body[0], str(body[0].keys()))
    resp = teg.mcp_handle({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                           "params": {"name": "get_task", "arguments": {"id": tid}}})
    g = json.loads(resp["result"]["content"][0]["text"])
    check("MCP get_task 详情", g.get("id") == tid, str(g.get("id")))
    check("MCP get_task 过滤内部字段", "_body" not in g and "_unknown" not in g and "附言" not in g, str(g.keys()))
    resp = teg.mcp_handle({"jsonrpc": "2.0", "id": 5, "method": "tools/call",
                           "params": {"name": "list_projects", "arguments": {}}})
    pj = json.loads(resp["result"]["content"][0]["text"])
    check("MCP list_projects", any(p["id"] == "fangcun-base" for p in pj), str(pj)[:200])
    resp = teg.mcp_handle({"jsonrpc": "2.0", "id": 6, "method": "tools/call",
                           "params": {"name": "search_tasks", "arguments": {"query": "Fix"}}})
    sr = json.loads(resp["result"]["content"][0]["text"])
    check("MCP search_tasks 命中", len(sr) >= 1, str(len(sr)))
    resp = teg.mcp_handle({"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                           "params": {"name": "delete_task", "arguments": {}}})
    check("MCP 拒绝写操作工具", "error" in resp and "未知工具" in resp["error"]["message"], str(resp))
    resp = teg.mcp_handle({"jsonrpc": "2.0", "id": 8, "method": "tools/call",
                           "params": {"name": "list_tasks", "arguments": {"status": "待验收"}}})
    f2 = json.loads(resp["result"]["content"][0]["text"])
    check("MCP list_tasks 状态过滤", all(t["状态"] == "待验收" for t in f2) and len(f2) > 0, str(len(f2)))
    resp = teg.mcp_handle({"jsonrpc": "2.0", "id": 9, "method": "tools/call",
                           "params": {"name": "list_tasks", "arguments": {"tag": "backend"}}})
    f3 = json.loads(resp["result"]["content"][0]["text"])
    check("MCP list_tasks 标签过滤", len(f3) >= 1 and all("backend" in (t.get("标签") or []) for t in f3), str(len(f3)))
    check("MCP 未知方法报错",
          "error" in teg.mcp_handle({"jsonrpc": "2.0", "id": 10, "method": "nope", "params": {}}))
    check("MCP 通知无响应",
          teg.mcp_handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None)

    # ---- 页面模板可渲染（含三个视图的挂载点） ----
    with OP.open(f"http://127.0.0.1:{PORT}/") as r:
        page = r.read().decode("utf-8")
    check("看板页注入 registry（非占位符）", "__REGISTRY__" not in page and "fangcun-base" in page)
    for need in ['id="tagFilter"', 'id="f_tag"', 'id="f_quick"', 'id="koverlay"',
                 'id="hoverlay"', 'id="moverlay"', 'data-view="calendar"', 'data-view="list"',
                 'id="rulesList"', "renderCalendar", "renderList", "openDoc", "renderQuickPreview"]:
        check("模板含 " + need, need in page)
    check("模板保留 P0 计划勾选", 'onclick="togglePlan(event,' in page)
finally:
    srv.shutdown(); srv.server_close()
    shutil.rmtree(tmp, ignore_errors=True)

print(f"通过 {len(PASS)} / 失败 {len(FAIL)}")
if FAIL:
    print("失败项：", "、".join(FAIL))
    sys.exit(1)
print("全部通过。")
