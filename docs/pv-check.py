#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CDP headless Edge 目检：方寸项目视图（task-20260905-005）
独立临时 profile + 非默认端口，不碰用户浏览器；只 terminate 自身 PID。
"""
import asyncio, json, os, socket, subprocess, sys, tempfile, time, urllib.request
import websockets

PORT = 9300
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PROFILE = os.path.join(tempfile.gettempdir(), f"cdp-tegula-pv-{PORT}")
BASE = "http://127.0.0.1:8753"
OUT = os.path.dirname(os.path.abspath(__file__))

def wait_port(p, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        try:
            s = socket.socket(); s.settimeout(1); s.connect(("127.0.0.1", p)); s.close(); return True
        except OSError:
            time.sleep(0.4)
    return False

def start_edge():
    cmd = [EDGE, "--headless=new", f"--remote-debugging-port={PORT}",
           f"--user-data-dir={PROFILE}", "--window-size=1440,900",
           "--disable-gpu", "--no-first-run", "--no-default-browser-check", "about:blank"]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"[EDGE] PID={proc.pid} port={PORT}")
    return proc if wait_port(PORT) else (proc.terminate(), None)[1]

async def send(ws, mid, method, params=None):
    await ws.send(json.dumps({"id": mid, "method": method, **({"params": params} if params else {})}))
    while True:
        r = json.loads(await ws.recv())
        if r.get("id") == mid:
            return r

async def eval_js(ws, expr, mid=100):
    r = await send(ws, mid, "Runtime.evaluate",
                   {"expression": expr, "returnByValue": True, "awaitPromise": True})
    v = r.get("result", {}).get("result", {})
    if v.get("subtype") == "error":
        return {"__error__": v.get("description", "")}
    return v.get("value")

async def main():
    proc = start_edge()
    if not proc:
        print("[FAIL] Edge headless 未启动"); sys.exit(1)
    lines = []
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json") as r:
            pages = json.loads(r.read())
        ws_url = next(p["webSocketDebuggerUrl"] for p in pages if p.get("type") == "page")
        async with websockets.connect(ws_url, max_size=50 * 1024 * 1024) as ws:
            await send(ws, 1, "Page.enable")
            await send(ws, 2, "Runtime.enable")

            # 1) 深链直达项目视图
            await send(ws, 3, "Page.navigate", {"url": f"{BASE}/#view=projects"})
            await asyncio.sleep(2.0)
            state = await eval_js(ws, "({view:curView, pvBtn:document.querySelector('#views .vbtn[data-view=projects]').classList.contains('on'), cards:document.querySelectorAll('.projcard').length, sugs:document.querySelectorAll('.sugrow').length, releasedSec:!!Array.from(document.querySelectorAll('.pvpanel .sughead')).find(h=>h.textContent.includes('已发布')), count:document.getElementById('count').textContent})")
            lines.append(("深链进入项目视图", state))
            print("STEP1", json.dumps(state, ensure_ascii=False))

            # 2) 建议面板文本
            sugs = await eval_js(ws, "Array.from(document.querySelectorAll('.sugrow')).map(r=>r.textContent.trim())")
            print("STEP2", json.dumps(sugs, ensure_ascii=False))
            lines.append(("建议行数", len(sugs or [])))

            # 3) 健康度徽章分布
            badges = await eval_js(ws, "Array.from(document.querySelectorAll('.hbadge')).map(b=>b.textContent.trim())")
            print("STEP3", json.dumps(badges, ensure_ascii=False))
            lines.append(("徽章分布", badges))

            # 4) released 卡片独立分区且置底
            rel_card = await eval_js(ws, "(()=>{const cards=Array.from(document.querySelectorAll('.projcard'));const rel=cards.find(c=>c.classList.contains('released'));const last=cards[cards.length-1];return rel?({isLast:rel===last,name:rel.querySelector('.pcname').textContent,badge:rel.querySelector('.hbadge').textContent.trim()}):null;})()")
            print("STEP4", json.dumps(rel_card, ensure_ascii=False))

            # 5) 写后失效：POST new 任务 → /status.json 时间戳应变
            ts_before = await eval_js(ws, "PV?PV.ts:0")
            import urllib.request as _u
            req = _u.Request(BASE + "/api", data=json.dumps({"action": "new", "fields": {
                "标题": "PV失效探针-可删", "项目": ["fangcun-base"], "状态": "草稿",
                "来源": "pv-check", "指派": "hermes", "验收": "暮雨", "优先级": "", "截止": "", "批次": ""}}).encode(), headers={"Content-Type": "application/json"})
            resp = json.loads(_u.urlopen(req).read())
            print("POST new:", resp)
            await asyncio.sleep(2.5)  # 前端 2s 轮询应拉到失效后的新扫
            ts_after = await eval_js(ws, "PV?PV.ts:0")
            new_cnt = await eval_js(ws, "PV?PV.statuses.find(s=>s.id==='fangcun-base').tasks.total:-1")
            print("STEP5", json.dumps({"ts_before": ts_before, "ts_after": ts_after,
                                        "invalidated": ts_after != ts_before,
                                        "fangcun_tasks_total": new_cnt}, ensure_ascii=False))
            lines.append(("写后失效", {"before": ts_before, "after": ts_after, "changed": ts_after != ts_before}))

            # 6) 切回看板再切回项目（视图往返 + pv class 管理）
            await eval_js(ws, "setView('active')")
            await asyncio.sleep(1.0)
            back = await eval_js(ws, "({pvOn:document.getElementById('board').classList.contains('pv'), taskCards:document.querySelectorAll('#board .tcard').length})")
            await eval_js(ws, "setView('projects')")
            await asyncio.sleep(1.2)
            again = await eval_js(ws, "({pvOn:document.getElementById('board').classList.contains('pv'), cards:document.querySelectorAll('.projcard').length})")
            print("STEP6", json.dumps({"back_to_active": back, "re_enter_projects": again}, ensure_ascii=False))
            lines.append(("视图往返", {"active": back, "projects": again}))

            # 7) 截图留证
            shot = await send(ws, 900, "Page.captureScreenshot", {"format": "png"})
            with open(os.path.join(OUT, "pv-check-1440x900.png"), "wb") as f:
                f.write(__import__("base64").b64decode(shot["result"]["data"]))
            print("[SHOT] pv-check-1440x900.png")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
    with open(os.path.join(OUT, "pv-check-result.json"), "w", encoding="utf-8") as f:
        json.dump(lines, f, ensure_ascii=False, indent=2)

asyncio.run(main())
