#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""组合视图 · 反例自证：把本轮真栽过的两个错装回去，看守卫精确变红。

为什么必须做：`scripts/project-portfolio.py` 写的过程中连栽两次，
两次输出都长得完全正常（"全池 0 条"、"已决定 11 条"）。
若守卫只是"读起来更严了"，那和没加的唯一区别是多一份虚假安全感。
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join(ROOT, "scripts", "project-portfolio.py")
GUARD = os.path.join(ROOT, "scripts", "test", "e2e-portfolio.cjs")


def run_guard():
    p = subprocess.run(["node", GUARD], cwd=ROOT, capture_output=True, timeout=300)
    out = (p.stdout or b"").decode("utf-8", "replace") + (p.stderr or b"").decode("utf-8", "replace")
    return p.returncode, out


def with_mutation(desc, old, new, expect):
    src = open(SCRIPT, encoding="utf-8").read()
    if old not in src:
        print("SETUP-FAIL  %s：找不到要注入的原文" % desc)
        return False
    try:
        open(SCRIPT, "w", encoding="utf-8").write(src.replace(old, new, 1))
        code, out = run_guard()
        reds = [l for l in out.split("\n") if l.startswith("FAIL")]
        hit = any(expect in l for l in reds)
        ok = code != 0 and hit
        print(("PASS  " if ok else "FAIL  ") + desc)
        if ok:
            print("        红在：" + [l for l in reds if expect in l][0][:150])
        else:
            print("        exit=%s 命中=%s 实际红 %d 条" % (code, hit, len(reds)))
            for l in reds[:3]:
                print("        " + l)
        return ok
    finally:
        open(SCRIPT, "w", encoding="utf-8").write(src)


def main():
    r = []

    # 反例①：需求池的**块切分**读错（真身用 `^## ` 分块）。
    # ⚠ 这条换过三次注入，前两次都"注入成功但没制造出错误"，记下来：
    #   ① `.lower()` —— 中文没有大小写，什么也没改；
    #   ② 只收 ASCII 键名 —— `eid` 来自**标题行**不依赖中文键，
    #      所以「条数一致」照过、「已决定」仍是 0（也和真身一致），零红。
    #   真正会让输出出错的是**块切分**：切成 0 块 → 全池 0 条，
    #   而"0 条"正是本轮第一次真栽的那个假象。
    r.append(with_mutation(
        "反例①：需求池块切分读错（全池 0 条）→ 守卫必须在「不为 0 / 与真身一致」上红",
        r're.split(r"(?m)^##\s+", txt)[1:]',
        r're.split(r"(?m)^###\s+", txt)[1:]',
        "需求池",
    ))

    # 反例②：把"已决定"判定放宽（任何条目都算已决定）
    r.append(with_mutation(
        "反例②：已决定判定放宽（空值也算）→ 守卫必须在「已决定条数与真身一致」上红",
        'row["_decided"] = bool(str(row.get("拍板") or "").strip())',
        'row["_decided"] = True',
        "已决定",
    ))

    # 反例③：需求池列**拿不到时写 0**（真身规则：拿不到只能写 `—`）
    # ⚠ 这条也换过一次注入：第一版替换表头模板里的 `—`，但需求池列现在
    #   已经能算出真实值（`9/0已定`），模板里那个 `—` 早就不在了。
    #   现在直接注入"拿不到时返回 0"。
    r.append(with_mutation(
        "反例③：需求池拿不到时写 0 → 守卫必须在「不许写 0」上红",
        '        if r.get("riceTotal") is None:\n            rd = "—"',
        '        if r.get("riceTotal") is None:\n            rd = "0"',
        "需求池",
    ))

    # 反例④：层级表漏掉项目（模拟 tiers 里有的项目没出现在表里）
    r.append(with_mutation(
        "反例④：tiers 里的项目不出现在表里 → 守卫必须在「每个项目都出现」上红",
        "for pid in allpids:",
        "for pid in list(allpids)[:3]:",
        "project-tiers",
    ))

    # 反例⑤：块式列表读不出来（模拟 `项目:\n  - x` 只抓同行 → 空串）
    r.append(with_mutation(
        "反例⑤：frontmatter 块式列表读不出 → 守卫必须在「能归因条数与真身一致」上红",
        '        if v == "":\n            seq = []',
        '        if False:\n            seq = []',
        "能归因",
    ))

    # 反例⑥：索引键全部错位（`id:` 前缀 + 不写裸 id）
    # ⚠ 这条换过两次注入，两次都假绿，记下来：
    #   ① 只删 `c2p[stem] = proj` —— 没用：大量卡的 frontmatter **本来就写着 `id:`**，
    #      少了文件名兜底仍能归到 9 条，只有没写 id 的那一张会掉；
    #   ② 只把文件名键改成 `"id:"+stem` —— 也没用，同上。
    #   真正能制造错误的是：**连 frontmatter 的 id 键也错位**。
    r.append(with_mutation(
        "反例⑥：索引键全部错位 → 守卫必须在「能归因条数」上红",
        '        if d.get("id"):\n            c2p[str(d["id"])] = proj\n        c2p[stem] = proj',
        '        if d.get("id"):\n            c2p["id:" + str(d["id"])] = proj\n        c2p["id:" + stem] = proj',
        "能归因",
    ))

    # 反例⑦：**按卡归因读错键**（2026-11-17 真发生过的那次，卡 46834830）。
    # 起因：`_card_index()` 读的是中文 `项目`，改成英文 `project` 后索引全空、
    # 按卡归因整段失效，而 11-15 那版产物把「核心项目 0 token」当成了「零调用」。
    # ⚠ 这个反例必须存在：①–⑧ + 反例①–⑥ 全绿也抓不到它，因为**没有一条断言
    #   检查归因的非零性**。注入后必须精确红在「按卡归因真的能归」上。
    r.append(with_mutation(
        "反例⑦：按卡归因读错键（中文 `项目` → 英文 `project`）→ 守卫必须在「按卡归因真的能归」上红",
        '        proj = str(d.get("项目") or d.get("project") or "").strip()',
        '        proj = str(d.get("project") or "").strip()',
        "按卡归因真的能归",
    ))

    # 反例⑧：主指标退回 total（暮雨 2026-11-17 明确定的新输入/输出口径）
    # ⚠ 第一版注入改的是公式模板（`| 新输入 | 输出 |` 那行），断言**没红**：
    #   因为 §1 里还有一句说明文字「同层内**新输入多的在前**」，
    #   `sec1.includes('新输入')` 照样命中 → 永远绿。
    #   现在断言只读**表头行本身**，注入才真正能被抓住。
    r.append(with_mutation(
        "反例⑧：表头把「新输入」改成「token」→ 守卫必须在「总表有新输入与输出两列」上红",
        '| 近 %d 天调用 | 没用量 | 新输入 | 输出 | total（副列）',
        '| 近 %d 天调用 | 没用量 | token | 输出 | total（副列）',
        "总表有「新输入」",
    ))

    # 反例⑩：把「没用量」这个计数整个丢掉（`_has_usage` 的结果不再往下传）。
    # 后果：那 14 条没有用量的记录被静默当成 0 并进合计，
    #   `fangcun-base` 的「90 次调用 / 8 次没用量」变成「90 次调用 / 全都有用量」。
    #
    # ⚠ 这里**没有**去注入「有调用但全没用量 → 新输入写 0」那条渲染分支：
    #   真数据里没有任何项目的调用全部缺用量（最差是 fangcun-base 90 次里 8 次），
    #   那条分支今天**永远不会被执行**。给一条永远不红的断言不如不留 ——
    #   它只提供虚假安全感。该分支保留在渲染里等未来数据，但不拿它来自证。
    r.append(with_mutation(
        "反例⑩：丢掉「没用量」计数（缺用量被当成 0 并进合计）→ 守卫必须在「确实存在没用量行」上红",
        '            "nou": tk.get("nou") or 0,',
        '            "nou": 0,',
        "确实存在「有调用但没用量」的行",
    ))

    # 反例⑪：产物里偷偷加回一个「超标」判定（暮雨 2026-11-17 已否掉"限额"这个需求本身）
    #   基准不存在（单轮全距 23.9 万倍、日全距 10 倍），加回判定就是把长会话判成烧多了。
    r.append(with_mutation(
        "反例⑪：用量分布节偷加「超标」字样 → 守卫必须在「不许有判定」上红",
        'A("> **这一节只回答',
        'A("> **超标的部分已标红。这一节只回答',
        "不许有任何",
    ))

    # 反例⑫：把「相对平常一天」的倍数换成绝对数（用户失去基准感，又得自己拍一个数）
    r.append(with_mutation(
        "反例⑫：删掉「相对平常一天」倍数列 → 守卫必须在「必须有倍数」上红",
        'A("| 日期 | 新输入 | 相对平常一天 |")',
        'A("| 日期 | 新输入 | 备注 |")',
        "必须有「相对平常一天」",
    ))

    print()
    print("RESULT %d / %d" % (sum(1 for x in r if x), sum(1 for x in r if not x)))
    return 0 if all(r) else 1


if __name__ == "__main__":
    sys.exit(main())
