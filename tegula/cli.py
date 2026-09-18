"""tegula.cli — 命令行入口 + 所有 cmd_* 函数"""
import argparse, os, sys, json, shutil, datetime, subprocess, time, threading, zipfile
from urllib.parse import parse_qs

from tegula.core import (
    ROOT, TASK_DIR, REGISTRY_PATH, REGISTRY_BAK, BACKUP_DIR, BACKUP_KEEP,
    ACTIVITY_LOG, STATUSES, _NOWIN, MANAGED_KEYS, TASKFN, _GATES,
    ALLOWED_SYNC_PROFILE, AGENT_RUNS_LOG, _AGENT_CMD_MAP, RULES_PATH,
    DEFAULT_RULES, LAST_REQUEST, _STATUS_CACHE, STATUS_TTL, WRITE_ACTIONS,
    _STATUS_SCAN_LOCK, QUICK_PRIO, PORT_FILE, _NOTES_DIR, _NOTES_INDEX,
    _ROADMAP_CACHE,
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
    _write_port_file, _clear_port_file, _diagnose_port_conflict, tegula_alive, find_edge,
    PORT_POOL_START, PORT_POOL_END, find_free_port,
    check_registry_consistency, _relative_time, _scan_git_remote,
    scan_project_status, suggest_actions, suggest_cross_project,
    find_timeout_tasks, _ensure_notes_dir, _load_notes_index,
    _save_notes_index, _gen_note_id, api_note_create, api_note_get,
    api_note_update, api_note_delete, api_note_attach, api_note_detach,
    api_notes_for_task, api_note_import_file,
    _LOGS_DIR, _ensure_logs_dir, _gen_log_id, _parse_log, _render_log,
    _log_path, _read_log, _write_log,
    api_log_create, api_log_get, api_log_list, api_log_update,
    api_log_complete, api_log_archive, api_log_destroy,
    api_log_search, api_log_link_task, api_log_unlink_task,
    api_log_inject, api_log_cleanup,
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
from tegula.web import Handler, QServer, TrayManager


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
    """备份所有数据文件到 backups/ 目录（zip，保留 10 份）。"""
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = os.path.join(BACKUP_DIR, f"fangcun-data-{stamp}.zip")
    
    # 推导 ROOT（兼容 verify.py 等测试环境只设 TASK_DIR 的场景）
    root = os.path.dirname(TASK_DIR) if TASK_DIR else ROOT
    
    n = 0
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        # 1. task-data/（排除 .trash, .tmp, .backup）
        if os.path.isdir(TASK_DIR):
            for root_dir, dirs, files in os.walk(TASK_DIR):
                dirs[:] = [d for d in dirs if d != ".trash" and d != ".backup"]
                for f in files:
                    if f.endswith(".tmp") or f.endswith(".bak"):
                        continue
                    p = os.path.join(root_dir, f)
                    arc = "task-data/" + os.path.relpath(p, TASK_DIR)
                    z.write(p, arc)
                    n += 1

        # 2. docs/执行日志/
        logs_dir = os.path.join(root, "docs", "执行日志")
        if os.path.isdir(logs_dir):
            for root_dir, dirs, files in os.walk(logs_dir):
                dirs[:] = [d for d in dirs if d != ".backup"]
                for f in files:
                    if f.endswith(".tmp") or f.endswith(".bak"):
                        continue
                    p = os.path.join(root_dir, f)
                    arc = "docs/执行日志/" + os.path.relpath(p, logs_dir)
                    z.write(p, arc)
                    n += 1

        # 3. registry.yaml
        reg_path = os.path.join(root, "registry.yaml")
        if os.path.exists(reg_path):
            z.write(reg_path, "registry.yaml")
            n += 1

        # 4. 桌面版数据（如果存在）
        desktop_data = os.path.join(root, "desktop", "userdata")
        if os.path.isdir(desktop_data):
            for root_dir, dirs, files in os.walk(desktop_data):
                for f in files:
                    if f.endswith(".tmp"):
                        continue
                    p = os.path.join(root_dir, f)
                    arc = "desktop/userdata/" + os.path.relpath(p, desktop_data)
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
    print(f"✓ 备份完成: {os.path.basename(dest)}")
    print(f"  共 {n} 个文件，{size:.1f} KB")
    print(f"  范围: task-data/ + docs/执行日志/ + registry.yaml")
    if removed:
        print(f"  轮换删除 {removed} 个旧备份")
    log_activity("backup", "-", f"{os.path.basename(dest)} {n} files {size:.1f}KB")


def cmd_restore(args):
    """从备份 zip 恢复数据。"""
    if not args.path:
        print("请指定备份文件路径: tegula restore <备份文件.zip>")
        return
    if not os.path.exists(args.path):
        print(f"备份文件不存在: {args.path}")
        return

    # 校验备份文件
    try:
        with zipfile.ZipFile(args.path, "r") as z:
            names = z.namelist()
            print(f"备份内容: {len(names)} 个文件")
            
            # 恢复
            restored = 0
            for name in names:
                # 确定目标路径
                if name.startswith("task-data/"):
                    dest_path = os.path.join(TASK_DIR, name[len("task-data/"):])
                elif name.startswith("docs/执行日志/"):
                    dest_path = os.path.join(ROOT, "docs", "执行日志", name[len("docs/执行日志/"):])
                elif name == "registry.yaml":
                    dest_path = REGISTRY_PATH
                elif name.startswith("desktop/userdata/"):
                    dest_path = os.path.join(ROOT, "desktop", "userdata", name[len("desktop/userdata/"):])
                else:
                    continue  # 未知路径，跳过
                
                # 确保目录存在
                os.makedirs(os.path.dirname(dest_path), exist_ok=True)
                
                # 读取并写入
                data = z.read(name)
                with open(dest_path, "wb") as f:
                    f.write(data)
                restored += 1
            
            print(f"✓ 恢复完成: {restored} 个文件")
            print(f"  已恢复到: {ROOT}")
            log_activity("restore", "-", f"{os.path.basename(args.path)} {restored} files")
    except zipfile.BadZipFile:
        print("备份文件损坏")
    except Exception as e:
        print(f"恢复失败: {e}")


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
        free = find_free_port(PORT_POOL_START, PORT_POOL_END)
        if free is None:
            print(f"[错误] 端口池 [{PORT_POOL_START}-{PORT_POOL_END}] 全部占满。")
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
# MCP 常量定义在 tegula.core 中（mcp_handle 在 core.py）。
# 此处不再重复定义，直接从 core 导入供本模块引用。
from tegula.core import MCP_PROTOCOL_VERSION, MCP_TOOLS, MCP_METHODS, MCP_HIDDEN_KEYS  # noqa: F401
# 安全红线：只读。edit/delete/dispatch/new 一律不暴露。
_MCP_TOOLS_LOCAL = [
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





def cmd_cron_check(args):
    """检查并触发周期任务。"""
    reactivated = check_recurring_tasks()
    if reactivated:
        print(f"已重新激活 {len(reactivated)} 个周期任务:")
        for tid in reactivated:
            print(f"  {tid}")
    else:
        print("无周期任务需要触发")


def cmd_note(args):
    """笔记管理 CLI。"""
    if args.note_cmd == "create":
        ok, msg = api_note_create(args.title or "", args.content or "", args.task_id)
        if ok:
            print(f"已创建笔记: {msg}")
        else:
            print(f"创建失败: {msg}")
    elif args.note_cmd == "get":
        note = api_note_get(args.id)
        if note:
            print(f"标题: {note['title']}")
            print(f"文件: {note['file']}")
            print(f"内容:\n{note['content']}")
        else:
            print("笔记不存在")
    elif args.note_cmd == "list":
        notes = api_notes_for_task(args.task_id)
        if not notes:
            print("无关联笔记")
            return
        print(f"关联笔记 ({len(notes)}):")
        for n in notes:
            print(f"  {n['id']} | {n['title']}")
    elif args.note_cmd == "delete":
        ok, msg = api_note_delete(args.id)
        if ok:
            print(f"已删除 {args.id}")
        else:
            print(f"删除失败: {msg}")
    elif args.note_cmd == "attach":
        ok, msg = api_note_attach(args.id, args.task_id)
        if ok:
            print(f"已关联 {args.id} -> {args.task_id}")
        else:
            print(f"关联失败: {msg}")
    elif args.note_cmd == "detach":
        ok, msg = api_note_detach(args.id, args.task_id)
        if ok:
            print(f"已取消关联 {args.id} <- {args.task_id}")
        else:
            print(f"取消关联失败: {msg}")
    elif args.note_cmd == "import":
        ok, msg = api_note_import_file(args.path, args.task_id)
        if ok:
            print(f"已导入: {msg}")
        else:
            print(f"导入失败: {msg}")


def cmd_log(args):
    """执行日志管理 CLI。"""
    if args.log_cmd == "create":
        ok, msg = api_log_create(args.project, args.title, args.content or "", args.task)
        if ok:
            print(f"已创建执行日志: {msg}")
        else:
            print(f"创建失败: {msg}")
    elif args.log_cmd == "get":
        entry = api_log_get(args.id)
        if entry:
            fm = entry["fm"]
            print(f"ID: {fm.get('id', '')}")
            print(f"标题: {fm.get('title', '')}")
            print(f"项目: {fm.get('project', '')}")
            print(f"状态: {fm.get('status', '')}")
            print(f"创建: {fm.get('created', '')}")
            print(f"完成: {fm.get('completed', '未完成')}")
            print(f"保留天数: {fm.get('retain_days', '默认7')}")
            print(f"保留至: {fm.get('retain_until', '未设置')}")
            print(f"关联任务: {', '.join(fm.get('tasks', []) or [])}")
            print(f"标签: {', '.join(fm.get('tags', []) or [])}")
            print(f"\n正文:\n{entry['body']}")
        else:
            print("日志不存在")
    elif args.log_cmd == "list":
        logs = api_log_list(args.project, args.status, args.limit or 20)
        if not logs:
            print("无执行日志")
            return
        print(f"执行日志 ({len(logs)}):")
        for l in logs:
            print(f"  {l['id']} | {l['status']:<8} | {l['project']:<16} | {l['title']}")
    elif args.log_cmd == "edit":
        ok, msg = api_log_update(args.id, args.title, args.content, args.next_steps)
        if ok:
            print(f"已更新 {args.id}")
        else:
            print(f"更新失败: {msg}")
    elif args.log_cmd == "complete":
        ok, msg = api_log_complete(args.id, args.retain_days, args.note)
        if ok:
            print(f"已完成 {args.id}（保留 {args.retain_days or '默认7'} 天）")
        else:
            print(f"完成失败: {msg}")
    elif args.log_cmd == "archive":
        ok, msg = api_log_archive(args.id, args.note)
        if ok:
            print(f"已归档 {args.id}")
        else:
            print(f"归档失败: {msg}")
    elif args.log_cmd == "destroy":
        ok, msg = api_log_destroy(args.id)
        if ok:
            print(f"已销毁 {args.id}")
        else:
            print(f"销毁失败: {msg}")
    elif args.log_cmd == "search":
        results = api_log_search(args.query)
        if not results:
            print("无匹配结果")
            return
        print(f"搜索结果 ({len(results)}):")
        for r in results:
            print(f"  {r['id']} | {r['status']:<8} | {r['project']:<16} | {r['title']}")
    elif args.log_cmd == "link":
        ok, msg = api_log_link_task(args.id, args.task_id)
        if ok:
            print(f"已关联 {args.id} -> {args.task_id}")
        else:
            print(f"关联失败: {msg}")
    elif args.log_cmd == "unlink":
        ok, msg = api_log_unlink_task(args.id, args.task_id)
        if ok:
            print(f"已取消关联 {args.id} <- {args.task_id}")
        else:
            print(f"取消关联失败: {msg}")
    elif args.log_cmd == "inject":
        text = api_log_inject(args.id)
        if text:
            print(text)
        else:
            print("日志不存在")
    elif args.log_cmd == "cleanup":
        archived = api_log_cleanup()
        if archived:
            print(f"已归档 {len(archived)} 条超期日志:")
            for aid in archived:
                print(f"  {aid}")
        else:
            print("无超期日志")


def cmd_export_tasks(args):
    """导出任务到 JSON 文件。"""
    import json
    project_id = getattr(args, "project", None)
    result = api_export_tasks(project_id)
    if not result.get("ok"):
        print(f"导出失败: {result.get('msg')}")
        return
    output = args.output or f"tasks-export-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    with open(output, "w", encoding="utf-8") as f:
        json.dump(result["data"], f, ensure_ascii=False, indent=2)
    print(f"已导出 {result['count']} 个任务到: {output}")


def cmd_import_tasks(args):
    """从 JSON 文件导入任务。"""
    import json
    if not os.path.exists(args.path):
        print(f"文件不存在: {args.path}")
        return
    with open(args.path, encoding="utf-8") as f:
        data = json.load(f)
    result = api_import_tasks(data)
    if result.get("ok"):
        print(f"已导入 {result['imported']} 个任务")
    else:
        print(f"导入失败: {result.get('msg')}")


def cmd_export_notes(args):
    """导出笔记到 JSON 文件。"""
    import json
    result = api_export_notes()
    if not result.get("ok"):
        print(f"导出失败: {result.get('msg')}")
        return
    output = args.output or f"notes-export-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    with open(output, "w", encoding="utf-8") as f:
        json.dump(result["data"], f, ensure_ascii=False, indent=2)
    print(f"已导出 {result['count']} 条笔记到: {output}")


def cmd_import_notes(args):
    """从 JSON 文件导入笔记。"""
    import json
    if not os.path.exists(args.path):
        print(f"文件不存在: {args.path}")
        return
    with open(args.path, encoding="utf-8") as f:
        data = json.load(f)
    result = api_import_notes(data)
    if result.get("ok"):
        print(f"已导入 {result['imported']} 条笔记")
    else:
        print(f"导入失败: {result.get('msg')}")


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


def cmd_launch(args):
    """一键启动所有该在的服务（auto_start=true）。
    崩溃后重建命令：python tegula.py launch all
    """
    import json
    apps_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "apps.json")
    if not os.path.exists(apps_path):
        print(f"未找到 apps.json，先在项目根目录创建应用注册表。")
        print(f"模板：{apps_path}.example")
        return
    
    with open(apps_path, encoding="utf-8") as f:
        registry = json.load(f)
    
    apps = registry.get("apps", [])
    if not apps:
        print("apps.json 中无应用声明。")
        return
    
    action = getattr(args, "action", "all")
    
    if action == "all":
        # 启动所有 auto_start=true 的服务
        started = []
        skipped = []
        failed = []
        
        for app in apps:
            if not app.get("auto_start", False):
                continue
            
            name = app.get("name", "未命名")
            port = app.get("port")
            
            if not port:
                skipped.append(f"{name}（无端口声明）")
                continue
            
            if _port_in_use(port):
                skipped.append(f"{name}（端口 {port} 已运行）")
                continue
            
            cmd = app.get("start_cmd", [])
            if not cmd:
                skipped.append(f"{name}（无启动命令）")
                continue
            
            cwd = app.get("cwd", None)
            if cwd and not os.path.isdir(cwd):
                cwd = None
            
            ok, msg = start_service(port, cmd, cwd=cwd)
            if ok:
                started.append(f"{name} (:{port})")
            else:
                failed.append(f"{name} - {msg}")
        
        print(f"\n{'='*60}")
        print(f"启动台 · 共 {len([a for a in apps if a.get('auto_start')])} 个自动启动应用")
        print(f"{'='*60}")
        
        if started:
            print(f"\n✓ 已启动 ({len(started)}):")
            for s in started:
                print(f"  ✓ {s}")
        
        if skipped:
            print(f"\n○ 跳过 ({len(skipped)}):")
            for s in skipped:
                print(f"  ○ {s}")
        
        if failed:
            print(f"\n✗ 失败 ({len(failed)}):")
            for s in failed:
                print(f"  ✗ {s}")
        
        print()
    
    elif action == "status":
        # 显示所有应用状态
        print(f"\n{'='*60}")
        print(f"启动台 · 共 {len(apps)} 个应用")
        print(f"{'='*60}")
        
        for app in apps:
            name = app.get("name", "未命名")
            port = app.get("port")
            auto = "自动" if app.get("auto_start") else "手动"
            
            if port:
                running = _port_in_use(port)
                icon = "🟢" if running else "🔴"
                print(f"  {icon} {name:<20} :{port:<6} [{auto}]")
                health = app.get("health_url")
                if health and running:
                    print(f"     {health}")
            else:
                print(f"  ⚪ {name:<20} [无端口] [{auto}]")
        print()


def cmd_serve(args):
    """启动本地看板视图。自动处理端口冲突。

    端口分配策略：
      1. 读端口文件 → 已有活着的服务就直接复用
      2. 尝试 --port（默认 8753）→ 空闲就用它
      3. 被占 → 从端口池 [8753, 8853] 顺序扫描第一个空闲端口
      4. 全满 → 报错并提示手动指定 --port
    """
    port = args.port
    tray_mode = getattr(args, "tray", False)

    # 检查已有服务
    existing = _read_port_file()
    if existing:
        print(f"[提示] 方寸看板已在 http://127.0.0.1:{existing}/ 运行（单飞保护，不再起第二个）。")
        return

    actual_port = port
    # 尝试绑定首选端口
    if tegula_alive(port):
        actual_port = port
        print(f"[提示] 方寸看板已在 http://127.0.0.1:{port}/ 运行（单飞保护，不再起第二个）。")
        _write_port_file(port)
        return
    else:
        # 首选端口是否被其他进程占用？
        import socket
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            probe.bind(("127.0.0.1", port))
            probe.close()
            # 空闲，直接用
            actual_port = port
        except OSError:
            probe.close()
            # 被占 → 从端口池自动找
            pid, pname = _diagnose_port_conflict(port)
            if pid:
                print(f"[warn] 端口 {port} 被 {pname} (PID {pid}) 占用，正在自动分配...")
            else:
                print(f"[warn] 端口 {port} 被占用（无法识别占用者），正在自动分配...")
            free = find_free_port(PORT_POOL_START, PORT_POOL_END)
            if free is None:
                print(f"[错误] 端口池 [{PORT_POOL_START}-{PORT_POOL_END}] 全部占满。")
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
    la = sub.add_parser("launch", help="启动台：一键拉起所有该在的应用（auto_start=true）")
    la.add_argument("action", nargs="?", default="all", choices=["all", "status"],
                     help="all=启动所有 | status=仅查看状态")
    la.set_defaults(func=cmd_launch)
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
    bk = sub.add_parser("backup", help="备份所有数据文件（zip，保留最近 10 份）")
    bk.set_defaults(func=cmd_backup)
    rs = sub.add_parser("restore", help="从备份 zip 恢复数据")
    rs.add_argument("path", help="备份文件路径 (.zip)")
    rs.set_defaults(func=cmd_restore)
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
    

    ck = sub.add_parser("cron", help="检查并触发周期任务")
    ck.set_defaults(func=cmd_cron_check)
    
    # 笔记模块 CLI
    nt = sub.add_parser("note", help="笔记管理：创建/查看/关联/导入")
    nt_sub = nt.add_subparsers(dest="note_cmd")
    nt_create = nt_sub.add_parser("create", help="创建新笔记")
    nt_create.add_argument("--title", default="", help="笔记标题")
    nt_create.add_argument("--content", default="", help="笔记内容")
    nt_create.add_argument("--task", default=None, help="关联的任务 ID")
    nt_create.set_defaults(func=cmd_note)
    nt_get = nt_sub.add_parser("get", help="查看笔记详情")
    nt_get.add_argument("id", help="笔记 ID")
    nt_get.set_defaults(func=cmd_note)
    nt_list = nt_sub.add_parser("list", help="列出任务关联的笔记")
    nt_list.add_argument("task_id", help="任务 ID")
    nt_list.set_defaults(func=cmd_note)
    nt_delete = nt_sub.add_parser("delete", help="删除笔记")
    nt_delete.add_argument("id", help="笔记 ID")
    nt_delete.set_defaults(func=cmd_note)
    nt_attach = nt_sub.add_parser("attach", help="关联笔记到任务")
    nt_attach.add_argument("id", help="笔记 ID")
    nt_attach.add_argument("task_id", help="任务 ID")
    nt_attach.set_defaults(func=cmd_note)
    nt_detach = nt_sub.add_parser("detach", help="取消笔记与任务的关联")
    nt_detach.add_argument("id", help="笔记 ID")
    nt_detach.add_argument("task_id", help="任务 ID")
    nt_detach.set_defaults(func=cmd_note)
    nt_import = nt_sub.add_parser("import", help="从文件导入笔记")
    nt_import.add_argument("path", help="文件路径")
    nt_import.add_argument("--task", default=None, help="关联的任务 ID")
    nt_import.set_defaults(func=cmd_note)

    # 执行日志 CLI
    lg = sub.add_parser("log", help="执行日志：高频工作记录/暂存/销毁")
    lg_sub = lg.add_subparsers(dest="log_cmd")
    lg_create = lg_sub.add_parser("create", help="创建执行日志")
    lg_create.add_argument("--project", required=True, help="项目 id")
    lg_create.add_argument("--title", required=True, help="日志标题")
    lg_create.add_argument("--content", default="", help="执行内容（正文）")
    lg_create.add_argument("--task", default=None, help="关联的任务 ID")
    lg_create.set_defaults(func=cmd_log)
    lg_get = lg_sub.add_parser("get", help="查看日志详情")
    lg_get.add_argument("id", help="日志 ID")
    lg_get.set_defaults(func=cmd_log)
    lg_list = lg_sub.add_parser("list", help="列出执行日志")
    lg_list.add_argument("--project", default=None, help="按项目筛选")
    lg_list.add_argument("--status", default=None, choices=["active", "completed", "archived"], help="按状态筛选")
    lg_list.add_argument("--limit", default=20, type=int, help="最多显示条数")
    lg_list.set_defaults(func=cmd_log)
    lg_edit = lg_sub.add_parser("edit", help="编辑日志（仅 active）")
    lg_edit.add_argument("id", help="日志 ID")
    lg_edit.add_argument("--title", default=None, help="新标题")
    lg_edit.add_argument("--content", default=None, help="执行内容（整段替换）")
    lg_edit.add_argument("--next-steps", default=None, help="下一步（整段替换）")
    lg_edit.set_defaults(func=cmd_log)
    lg_complete = lg_sub.add_parser("complete", help="手动确认完成")
    lg_complete.add_argument("id", help="日志 ID")
    lg_complete.add_argument("--retain-days", default=None, help="保留天数：7/14/0或never/具体数字")
    lg_complete.add_argument("--note", default="", help="完成备注")
    lg_complete.set_defaults(func=cmd_log)
    lg_archive = lg_sub.add_parser("archive", help="手动归档（进暂存区）")
    lg_archive.add_argument("id", help="日志 ID")
    lg_archive.add_argument("--note", default="", help="归档备注")
    lg_archive.set_defaults(func=cmd_log)
    lg_destroy = lg_sub.add_parser("destroy", help="手动销毁")
    lg_destroy.add_argument("id", help="日志 ID")
    lg_destroy.set_defaults(func=cmd_log)
    lg_search = lg_sub.add_parser("search", help="搜索日志")
    lg_search.add_argument("query", help="搜索关键词")
    lg_search.set_defaults(func=cmd_log)
    lg_link = lg_sub.add_parser("link", help="关联任务")
    lg_link.add_argument("id", help="日志 ID")
    lg_link.add_argument("task_id", help="任务 ID")
    lg_link.set_defaults(func=cmd_log)
    lg_unlink = lg_sub.add_parser("unlink", help="取消关联任务")
    lg_unlink.add_argument("id", help="日志 ID")
    lg_unlink.add_argument("task_id", help="任务 ID")
    lg_unlink.set_defaults(func=cmd_log)
    lg_inject = lg_sub.add_parser("inject", help="生成注入文本（新会话提示词）")
    lg_inject.add_argument("id", help="日志 ID")
    lg_inject.set_defaults(func=cmd_log)
    lg_cleanup = lg_sub.add_parser("cleanup", help="检查超期日志，标记归档（不自动删）")
    lg_cleanup.set_defaults(func=cmd_log)

    # 数据导出/导入
    ex = sub.add_parser("export", help="导出数据（JSON）")
    ex_sub = ex.add_subparsers(dest="ex_cmd")
    ex_tasks = ex_sub.add_parser("tasks", help="导出任务")
    ex_tasks.add_argument("--project", default=None, help="按项目过滤")
    ex_tasks.add_argument("--output", default=None, help="输出文件路径")
    ex_tasks.set_defaults(func=cmd_export_tasks)
    ex_notes = ex_sub.add_parser("notes", help="导出笔记")
    ex_notes.add_argument("--output", default=None, help="输出文件路径")
    ex_notes.set_defaults(func=cmd_export_notes)
    
    im = sub.add_parser("import", help="导入数据（JSON）")
    im_sub = im.add_subparsers(dest="im_cmd")
    im_tasks = im_sub.add_parser("tasks", help="导入任务")
    im_tasks.add_argument("path", help="JSON 文件路径")
    im_tasks.set_defaults(func=cmd_import_tasks)
    im_notes = im_sub.add_parser("notes", help="导入笔记")
    im_notes.add_argument("path", help="JSON 文件路径")
    im_notes.set_defaults(func=cmd_import_notes)
    
    args = p.parse_args()
    if not getattr(args, "func", None):
        p.print_help()
        return
    args.func(args)


if __name__ == "__main__":
    main()