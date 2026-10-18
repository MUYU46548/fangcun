#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
账本导入守卫（2026-10-15）

钉住三件事（每一件都对应一次"内容会丢"的真实风险）：
  ① **解析不漏**：账本里的每一条挂账都必须变出一张卡 —— 条数不许悄悄变少；
  ② **细节不丢**：条目的原文（去掉 markdown 强调后的字面）必须能在卡正文里找到；
  ③ **不重复建卡**：`[账本:<版本>:<key>]` 标记在全库唯一 —— 重跑导入不许产生第二份。

运行：python scripts/test/check-ledger-import.py [账本.md]
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import tegula.core as core  # noqa: E402
import importlib.util  # noqa: E402

spec = importlib.util.spec_from_file_location("imp", os.path.join(ROOT, "scripts", "import-ledger.py"))
imp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(imp)

LEDGER = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "docs", "账本-20261015-终版v2.md")
VERSION = "20261015"

pass_ = 0
fail = 0
fails = []


def check(name, cond, detail=""):
    global pass_, fail
    if cond:
        pass_ += 1
        print("PASS  " + name)
    else:
        fail += 1
        fails.append(name + ((" :: " + str(detail)) if detail else ""))
        print("FAIL  " + name + ("  → " + str(detail) if detail else ""))


def main():
    print("== 账本导入守卫 ==")
    check("账本文件在", os.path.exists(LEDGER), LEDGER)
    if not os.path.exists(LEDGER):
        return 1
    with open(LEDGER, encoding="utf-8") as f:
        ledger = f.read()

    plan = imp.build_plan(ledger, VERSION)
    cards = plan.cards

    # ── ① 条数：每个 B 表条目都要有卡 ──────────────────────────────────
    b_items = imp.parse_b(ledger.split("## B 表：")[1].split("## C 表：")[0])
    check("B 表条目解析数量 >= 45（少了就是解析漏了）", len(b_items) >= 45, len(b_items))
    bkeys = {c["key"] for c in cards if c["key"].startswith("B-")}
    check("★ 每个 B 表条目都产出了一张卡（%d 条 → %d 张卡）" % (len(b_items), len(bkeys)),
          len(bkeys) >= len(b_items), "items=%d cards=%d" % (len(b_items), len(bkeys)))

    for label, prefix in [("A 索引", "A-index"), ("C 回字清单", "C-index"),
                          ("D 欠账", "D-1"), ("E 已死之单", "E-index"),
                          ("未达栏", "P-unreached"), ("总纲", "Z-summary")]:
        check("必有的卡存在：%s（%s）" % (label, prefix), any(c["key"] == prefix for c in cards))

    # ── ② 细节不丢：条目原文能在卡正文里找到 ───────────────────────────
    missing = []
    for sec, num, txt in b_items:
        head = txt[:24]
        if not any(head in "\n".join(c["方案"]) for c in cards if c["key"].startswith("B-")):
            missing.append(head)
    check("★★ 每条 B 表条目的**原文**都能在卡正文里找到（不做摘要式压缩）",
          not missing, "missing=%s" % missing[:3])

    # 划掉的行（~~…~~ → 已修）也算账的一部分，不许丢
    struck = [ln for ln in ledger.splitlines() if ln.strip().startswith("- ~~")]
    bodies = "\n".join("\n".join(c["方案"]) for c in cards)
    miss_struck = [s[:30] for s in struck if imp.clean_md(re.sub(r"^\s*-\s+", "", s)) not in bodies]
    check("★★ 账本里划掉的行（已修/已销，%d 行）也留了档 —— 销账记录也是账" % len(struck),
          not miss_struck, "missing=%s" % miss_struck)

    # ── ③ 卡面卫生：标题/正文不许漏 markdown 标记 ─────────────────────
    dirty = [c["标题"] for c in cards if "**" in c["标题"] or "`" in c["标题"] or "~~" in c["标题"]]
    check("★ 卡标题里没有裸的 ** / ` / ~~（Vue 不解析 Markdown）", not dirty, dirty[:3])

    dup_key = [k for k in {c["key"] for c in cards} if sum(1 for c in cards if c["key"] == k) > 1]
    check("★★ 计划里没有重复 key（重跑不会建两份）", not dup_key, dup_key)

    # ── ④ 已落地的卡：标记在全库唯一，且与计划一一对应 ─────────────────
    seen = {}
    landed_texts = {}
    tdir = core.TASK_DIR
    for sub in ("", "archive", ".trash"):
        d = os.path.join(tdir, sub) if sub else tdir
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            if not fn.endswith(".md"):
                continue
            with open(os.path.join(d, fn), encoding="utf-8") as f:
                txt = f.read()
            for m in re.finditer(r"\[账本:%s:([^\]]+)\]" % VERSION, txt):
                seen.setdefault(m.group(1), []).append(os.path.join(sub, fn))
                landed_texts[os.path.join(sub, fn)] = txt

    dups = {k: v for k, v in seen.items() if len(v) > 1}
    check("★★ 全库里每个账本标记只出现一次（重复建卡 = 账本卡会自我繁殖）", not dups,
          {k: v[:2] for k, v in list(dups.items())[:3]})
    check("★ 计划里的每张卡都真的落盘了（%d 张）" % len(cards),
          all(c["key"] in seen for c in cards),
          "missing=%s" % [c["key"] for c in cards if c["key"] not in seen][:5])
    check("★ 落盘的标记数 == 计划卡数（没有多余/僵尸标记）",
          len(seen) == len(cards), "landed=%d planned=%d" % (len(seen), len(cards)))

    # ── ④b 归属：不该有归属的条目**不许**被兜底成方寸 ─────────────────────
    #   2026-10-15 实测踩到的坑：`api_new` 的字段兜底把**空数组**也当"没填"，
    #   于是账本里"全局 / 订阅 / 游戏四 / A·C·D·E 表"这 23 条被悄悄挂到了 fangcun-base 名下 ——
    #   后果是方寸的项目页/一屏里凭空多出 23 条不属于它的活，而"未归属"那一栏永远是空的。
    no_proj_keys = [c["key"] for c in cards if not c["项目"]]
    check("★ 计划里确实存在「无归属」的条目（%d 条，不是 0 —— 否则这条断言测不到东西）"
          % len(no_proj_keys), len(no_proj_keys) > 0, len(no_proj_keys))

    wrongly_owned = []
    for k in no_proj_keys:
        for f2, txt2 in landed_texts.items():
            if ("[账本:%s:%s]" % (VERSION, k)) in txt2 or ("[账本:%s:%s-" % (VERSION, k)) in txt2:
                m2 = re.search(r"^项目:\s*(.+)$", txt2, re.M)
                raw = (m2.group(1).strip() if m2 else "")
                if raw not in ("[]", "", "null"):
                    wrongly_owned.append((k, raw))
                break
    check("★★ 不该有归属的账本条目**没有**被兜底挂到方寸名下（空数组 ≠ 没填）",
          not wrongly_owned, wrongly_owned[:5])

    # ── ⑤ 已完成的账本条目不许再挂"待办" ───────────────────────────────
    doneish = [c for c in cards if re.search(r"→\s*已|已修（|已落地|已合入|已被你的产线做掉|已交付",
                                            c["标题"])]
    wrong = [c["key"] for c in doneish if c["状态"] != "完成"]
    check("★★ 账本已记「已修/已落地/已合入」的条目必须建成「完成」卡（不许继续冒充欠账）",
          not wrong, wrong)

    # ── ⑥ 标题完整性（2026-10-18 修：原来 txt[:56] 按字符硬切，砍在 commit hash 中间）──
    #
    # 病灶原样：`…你自己派了自己，0b0` —— `0b02e48` 被砍掉一半，且**没有省略号**，
    # 卡面看起来是个完整但读不懂的标题（用户原话「方寸里一堆看不懂的东西」）。
    # 判据三条：放得下逐字保留 / 切了必须带 `…` / 不许切在连续 ASCII 词内部。
    ascii_word = imp._ASCII_WORD

    def title_body(title):
        """从卡标题里剥出「账本原文」那一段（三种前缀：B 表带节名、D 表欠账/销账）"""
        if title.startswith("[账本] "):
            rest = title[len("[账本] "):]
            return rest.split("：", 1)[1] if "：" in rest else rest
        for pre in ("[账本·欠账] ", "[账本·销账] "):
            if title.startswith(pre):
                return title[len(pre):]
        return title

    lossy, no_ellipsis, cut_in_word = [], [], []
    for c in cards:
        if not (c["key"].startswith("B-") or c["key"].startswith("D-")):
            continue
        body = title_body(c["标题"])
        trimmed = body.endswith("…")
        if trimmed:
            if ascii_word.match(body[:-1][-1:] or " "):
                cut_in_word.append((c["key"], body[-14:]))
        else:
            # 未截断 → 必须能在方案/结果记录正文里逐字找到（说明一个字没动）
            joined = "\n".join(c["方案"]) + "\n" + "\n".join(c.get("结果记录") or [])
            if body not in joined:
                lossy.append((c["key"], body[-20:]))

    check("★★ 没被截断的卡标题与账本原文逐字一致（不许「顺手改写」措辞）",
          not lossy, lossy[:3])
    check("★★ 被截断的卡标题必须带 `…`（否则看起来是个完整但读不懂的标题）",
          all(c["标题"].endswith("…") or "…" not in c["标题"] for c in cards),
          [c["标题"][-16:] for c in cards if "…" in c["标题"] and not c["标题"].endswith("…")][:3])
    check("★★ 截断点不许落在 commit hash / 版本号 / 路径中间（砍半个 hash 比不写更糟）",
          not cut_in_word, cut_in_word[:5])

    # 真账本里那条被砍坏的原文，必须**整条**出现在标题里（80 字上限下它放得下）
    buggy = [t for _s, _n, t in b_items if "0b02e48 规划四态" in t]
    if buggy:
        hit = [c for c in cards if buggy[0] in c["标题"]]
        check("★★ 用户实报那条（含 0b02e48）的标题完整保留，不再被砍成 `0b0`",
              bool(hit), buggy[0][-30:])

    # smart_title 单测（纯函数边界，与账本内容无关）
    st = imp.smart_title
    check("  smart_title：放得下 → 一个字不动", st("短标题 abc") == "短标题 abc")
    check("  smart_title：截断 → 必带 …", st("很长" * 60, 20).endswith("…"))
    # 构造：80 位以内只有中文 + 一段 ASCII 词，切点会落在词里
    word_case_in = "前缀" * 30 + "abcdef1234567890 后面还有一段"
    word_case = st(word_case_in, 80)
    # 判据：结尾若是一段 ASCII，它在原文里必须是**完整词**（后面紧跟空格/中文，而不是被砍掉后半截）
    m_tail = re.search(r"([A-Za-z0-9_.\-/]+)…$", word_case)
    tail_word = m_tail.group(1) if m_tail else ""
    check("  smart_title：硬切不许落在 ASCII 词内部",
          word_case.endswith("…") and (not tail_word or (tail_word + " ") in word_case_in),
          "tail=%r in=%r" % (tail_word, word_case[-14:]))
    check("  上一条的反例前提：这段确实超长（否则测不到截断）",
          len(word_case_in) > 80, len(word_case_in))
    # 反向自证：拿用户实报的那条原文，旧写法 txt[:56] 必须复现「砍半个 hash」，新写法必须完整
    old_case = '欠账盘点 v4 的"等你 3"余项：word 模板 / 样例清洗点头（"大件派谁"已销——你自己派了自己，0b02e48 规划四态）'
    old56 = old_case[:56]
    check("  判据有效（旧写法 txt[:56] 在这条上确实砍出半个 hash）",
          old56.endswith("0b0") and "0b02e48" not in old56, old56[-12:])
    check("  新写法在这条上完整保留 hash（%d 字，未超 80 上限）" % len(old_case),
          "0b02e48" in st(old_case) and st(old_case) == old_case)
    check("  smart_title：有标点时优先断在标点后",
          st("第一件事做完了，" + "第二件事很长" * 8, 30)[:-1].endswith("，") or
          "，" in st("第一件事做完了，" + "第二件事很长" * 8, 30), 
          st("第一件事做完了，" + "第二件事很长" * 8, 30))

    # ── ⑥b 存量卡标题必须与当前生成规则一致 ───────────────────────────
    # 幂等是按标记跳过重建，所以**改了截断规则，老卡不会自己变** ——
    # 上一版 txt[:56] 砍出的半截标题会永远留在盘上（用户看到的"看不懂的卡"）。
    # 改完规则必须跑一次：
    #   python scripts/import-ledger.py docs/账本-20261015-终版v2.md --refix-titles --apply
    plan_title_by_key = {}
    for c in cards:
        plan_title_by_key.setdefault(c["key"], c["标题"])
    stale = []
    for relpath, txt in landed_texts.items():
        mk = re.search(r"\[账本:%s:([^\]]+)\]" % VERSION, txt)
        if not mk:
            continue
        key = mk.group(1)
        if key not in plan_title_by_key:
            continue
        mt = re.search(r"^标题:\s*(.+)$", txt, re.M)
        got = (mt.group(1).strip().strip('"').strip("'") if mt else "")
        want = plan_title_by_key[key]
        # 卡里存的是 YAML 标量（可能带转义），比较前把 \\" 归一
        if got.replace('\\"', '"') != want:
            stale.append((key, got[-24:], want[-24:]))
    check("★★ 已落盘卡的标题与当前生成规则一致（否则半截标题会永远留在盘上）",
          not stale, "跑 --refix-titles --apply 修：%s" % stale[:3])

    print("\n通过 %d / 失败 %d" % (pass_, fail))
    if fails:
        print("\n失败项：")
        for f in fails:
            print(" - " + f)
    print("RESULT %d / %d" % (pass_, fail))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
