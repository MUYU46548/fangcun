#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""聚焦复测：STEP6 选择器修正 + 更长等待 + 控制台错误捕获"""
import asyncio, json, os, socket, subprocess, sys, tempfile, time, urllib.request
import websockets

PORT = 9301
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PROFILE = os.path.join(tempfile.gettempdir(), f"cdp-tegula-pv-{PORT}")
BASE = "http://127.0.0.1:8753"

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
        print("[FAIL] Edge 未启动"); sys.exit(1)
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json") as r:
            pages = json.loads(r.read())
        ws_url = next(p["webSocketDebuggerUrl"] for p in pages if p.get("type") == "page")
        async with websockets.connect(ws_url, max_size=50 * 1024 * 1024) as ws:
            await send(ws, 1, "Page.enable")
            await send(ws, 2, "Runtime.enable")
            await send(ws, 5, "Log.enable")
            errs = []
            async def drain():
                try:
                    while True:
                        m = json.loads(await ws.recv())
                        if m.get("method") == "Log.entryAdded" and m["params"]["entry"].get("level") in ("error",):
                            errs.append(m["params"]["entry"]["text"][:160])
                except Exception:
                    pass
            t = asyncio.create_task(drain())
            await send(ws, 3, "Page.navigate", {"url": BASE})
            await asyncio.sleep(2.0)
            # 看板视图（默认 active）任务卡计数（正确选择器 .card）
            active_cards = await eval_js(ws, "document.querySelectorAll('#board .card').length")
            # 切项目视图，给足 refresh 扫描时间
            await eval_js(ws, "setView('projects')")
            await asyncio.sleep(4.0)
            pv = await eval_js(ws, "({pvOn:document.getElementById('board').classList.contains('pv'), cards:document.querySelectorAll('.projcard').length, count:document.getElementById('count').textContent})")
            print("ACTIVE_CARDS", active_cards)
            print("PV_REENTER", json.dumps(pv, ensure_ascii=False))
            print("CONSOLE_ERRORS", json.dumps(errs, ensure_ascii=False))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

asyncio.run(main())
