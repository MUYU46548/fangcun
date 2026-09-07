# 方寸 pythonw 冒烟：用与 方寸看板.bat 完全相同的无控制台方式启动看板，
# 验证 1) /ping 2) /tasks.json 3) /status.json（git 扫描全链路，昨天的黑窗风暴路径）
# 4) /api review action（验收按钮后端）。结果写 JSON；退出码 0=通过 1=失败。
# 用法：scripts/smoke_pythonw.py [port]   （由 run_smoke.bat 以 pythonw 拉起）
import json
import os
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import tegula  # noqa: E402

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
OUT = os.path.join(os.environ.get("TEMP", "."), "tegula_smoke_result.json")
NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
res = {"port": PORT, "started": time.strftime("%H:%M:%S"), "checks": {}}
_t0 = time.time()
proc = None
try:
    tegula.TASK_DIR = tegula.TASK_DIR  # 用真实库
    proc = subprocess.Popen(
        [sys.executable.replace("pythonw.exe", "python.exe"),
         os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "tegula.py"), "serve", "--port", str(PORT)],
        creationflags=NOWIN)
    # 等服务就绪（最多 15s）
    up = False
    for _ in range(30):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/ping", timeout=1.5) as r:
                up = r.status == 200
                break
        except Exception:
            time.sleep(0.5)
    res["checks"]["ping"] = up

    def get(path, timeout=30):
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}", timeout=timeout) as r:
            return r.status, r.read().decode("utf-8")

    # tasks.json
    try:
        st, body = get("/tasks.json")
        tasks = json.loads(body)
        res["checks"]["tasks_json"] = (st == 200 and isinstance(tasks, list)
                                       and len(tasks) >= 1)
    except Exception as e:
        res["checks"]["tasks_json"] = f"ERR {e!r}"
    # status.json（含全 registry git 扫描——黑窗风暴原始路径）
    try:
        st, body = get("/status.json?refresh=1")
        d = json.loads(body)
        res["checks"]["status_json"] = (st == 200 and isinstance(d.get("statuses"), list)
                                        and len(d["statuses"]) >= 1)
    except Exception as e:
        res["checks"]["status_json"] = f"ERR {e!r}"
    # review action：建临时任务→验收→完成→清档（不碰真实 task-data 之外的文件）
    try:
        def post(payload):
            req = urllib.request.Request(
                f"http://127.0.0.1:{PORT}/api",
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=10) as r:
                return json.loads(r.read().decode("utf-8"))

        fields = {"标题": "冒烟-验收链路-可删", "状态": "待验收",
                  "项目": ["fangcun-base"], "方案": ["- [x] 冒烟"]}
        r1 = post({"action": "new", "fields": fields})
        tid = None
        for t in json.loads(get("/tasks.json")[1]):
            if t.get("标题") == "冒烟-验收链路-可删":
                tid = t["id"]
                break
        r2 = post({"action": "review", "id": tid, "verdict": "accept"}) if tid else {"ok": False}
        st2 = next((t.get("状态") for t in json.loads(get("/tasks.json")[1])
                    if t.get("id") == tid), None) if tid else None
        post({"action": "archive", "id": tid}) if tid else None
        res["checks"]["review_api"] = (r1.get("ok") and r2.get("ok") and st2 == "完成")
        res["smoke_task"] = tid
    except Exception as e:
        res["checks"]["review_api"] = f"ERR {e!r}"
finally:
    if proc:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
res["ok"] = all(v is True for v in res["checks"].values())
res["elapsed_s"] = round(time.time() - _t0, 1)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(res, f, ensure_ascii=False, indent=1)
