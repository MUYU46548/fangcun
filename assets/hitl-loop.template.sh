#!/usr/bin/env bash
# hitl-loop.template.sh —— 复现回路模板（2026-11-11 收进方寸 assets）
#
# 由来：卡 task-20261108-013「bug 类卡强制复现命令 + 回路十法进任务书」。
# 原模板来自 diagnosing-bugs 的 hitl-loop（human-in-the-loop）：**先复现，再改**。
# 本文件是本地重写版：不引依赖、不联网，只做三件事 ——
#   ① 一条命令跑一遍，把 stdout/stderr 收到临时文件；
#   ② 与“期望现象”对照，判定“这次是否复现”；
#   ③ 结论写进 echo，供任务书的「复现命令：」一行原样引用。
#
# 用法：
#   1) cp assets/hitl-loop.template.sh scripts/repro-<卡id>.sh
#   2) 改 CMD / EXPECT / EXIT_WANT 三个变量
#   3) bash scripts/repro-<卡id>.sh        # 复现时退出码 0，未复现退出码 1
#   4) 把这一行写进 done 的 --结果：复现命令：bash scripts/repro-<卡id>.sh
#
# ⚠ 纪律（与任务书同一句）：跑不出复现就**停下来要东西**（能复现的环境 / 脱敏产物 /
#   临时埋点授权），不许直接进入“我猜是 X”的假设阶段。

set -u

# ── 改这三个 ────────────────────────────────────────────────────────────────
CMD="echo '把这里换成真正会出错的那条命令'"
EXPECT="把这里换成期望看到的错（子串即可，比如 ECONNRESET / 500 / 白屏）"
# 1 = 命令非零退出才算复现；0 = 命令正常退出但输出里有 EXPECT 才算复现
EXIT_WANT="${EXIT_WANT:-1}"
# ───────────────────────────────────────────────────────────────────────────

OUT="$(mktemp -t hitl-loop-XXXXXX.log 2>/dev/null || echo "./hitl-loop.log")"
{ bash -lc "$CMD"; } >"$OUT" 2>&1
CODE=$?

HIT=0
if grep -q -- "$EXPECT" "$OUT"; then HIT=1; fi
if [ "$EXIT_WANT" = "1" ] && [ "$CODE" -ne 0 ]; then HIT=$((HIT + 1)); fi

echo "命令：$CMD"
echo "退出码：$CODE（期望：$([ "$EXIT_WANT" = "1" ] && echo '非 0' || echo '0')）"
echo "输出文件：$OUT"
if [ -n "$EXPECT" ] && [ "$EXPECT" != "把这里换成期望看到的错（子串即可，比如 ECONNRESET / 500 / 白屏）" ]; then
  echo "期望现象：$EXPECT → $([ "$HIT" -ge 1 ] && echo '命中' || echo '未命中')"
fi
echo "---- 最后 20 行输出 ----"
tail -n 20 "$OUT" || true

if [ "$HIT" -ge 1 ]; then
  echo "RESULT: 已复现（把上面「命令」一行原样写进 done 的 --结果：复现命令：…）"
  exit 0
fi
echo "RESULT: 未复现 —— 不要进入假设阶段。停下来要三样之一：能复现的环境 / 脱敏后的产物 / 临时埋点授权"
exit 1
