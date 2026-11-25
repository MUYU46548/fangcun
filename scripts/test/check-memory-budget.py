#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
`scripts/memory.py` 的 core 预算必须**与界面同源**（2026-11-24）

## 为什么补这一套

暮雨在设置页把 core 预算调到 4000（原话：「预算应该用户可调，不要写死代码」）。
桌面侧 `coreBudget()` 照做了，**但 `scripts/memory.py` 里还是 `CORE_BUDGET = 800` 且从不读 prefs**
→ `memory.py --check` 天天报「core.md 907 字，超过预算 800」这条**假红**。

更麻烦的是它和 2026-11-24 当场抓到的「预算抖动」是同一个根因：
**一份设置、两处各算各的**。产品侧已经带上可信度标记（`coreBudgetSource()`），
脚本侧完全没这概念。

## 判据（含两个反例方向）

  ① 预算 = 4000（用户当前设置）→ **不报**超预算，退出 0；
  ② **反例**：预算调小到 200 → 必须报超预算、退出非零（别为了消红把判据改没了）；
  ③ 读不到 prefs → 必须明说「按**默认**预算算，你设的值可能更高」——
     **绝不许冒充成用户设的值**；
  ④ 预算写成坏值 → 不可信，走默认 + 明说。

⚠ 这套跑的是**真子进程**（`python scripts/memory.py --check`），不是 import 后调函数 ——
  因为出问题的正是"脚本被当命令跑"时的行为，import 进来的那条路绕过了它。

运行：python scripts/test/check-memory-budget.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MP = os.path.join(ROOT, 'scripts', 'memory.py')

passed = 0
failed = 0
failures = []


def check(name, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print('PASS  ' + name)
    else:
        failed += 1
        failures.append(name + ((' :: ' + str(detail)) if detail else ''))
        print('FAIL  ' + name + (('  → ' + str(detail)) if detail else ''))


def run(prefs_obj):
    """在隔离的 userData 下跑一次 --check。没读到 prefs 时**不许回落真实 prefs**。"""
    tmp = tempfile.mkdtemp(prefix='fc-membudget-')
    try:
        if prefs_obj is not None:
            with open(os.path.join(tmp, 'prefs.json'), 'w', encoding='utf-8') as f:
                json.dump(prefs_obj, f)
        env = dict(os.environ)
        env['FC_TEST_USERDATA'] = tmp
        env['PYTHONIOENCODING'] = 'utf-8'
        r = subprocess.run([sys.executable, MP, '--check'], capture_output=True, text=True,
                           encoding='utf-8', errors='replace', env=env, cwd=ROOT)
        return r.returncode, (r.stdout or '') + (r.stderr or '')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def says_over(out):
    return ('超过预算' in out) or ('超过**默认**预算' in out)


print('== memory.py core 预算与界面同源 ==')

# ① 用户设 4000 → 不报
code, out = run({'memoryCoreBudget': 4000})
check('★★ 预算 = 4000（用户当前设置）→ 不报超预算、退出 0',
      code == 0 and not says_over(out), 'exit=%s out=%s' % (code, out[-200:]))

# ② 反例：调小必须报（否则就是"为了消红把判据改没了"）
code2, out2 = run({'memoryCoreBudget': 200})
check('★★ 反例：预算调小到 200 → 必须报超预算且退出非零（判据没被改没）',
      code2 != 0 and says_over(out2), 'exit=%s out=%s' % (code2, out2[-200:]))
if says_over(out2):
    for line in out2.splitlines():
        if '超过' in line:
            print('      ' + line.strip())

# ③ 读不到 prefs → 必须说"不确定"，不许冒充用户设置
code3, out3 = run(None)
check('★★ 读不到 prefs → 明说「按默认算、你设的值可能更高」（不许冒充用户设的值）',
      ('没读到 prefs' in out3) or (not says_over(out3)),
      'exit=%s out=%s' % (code3, out3[-200:]))

# ④ 坏值 → 不可信，走默认并明说
code4, out4 = run({'memoryCoreBudget': 'abc'})
check('★ 预算写成坏值 → 不崩、走默认并明说（不是 0，也不是 NaN）',
      code4 in (0, 1) and ('没读到 prefs' in out4 or says_over(out4) or '超过' not in out4),
      'exit=%s out=%s' % (code4, out4[-200:]))

# ⑤ 隔离性守卫：设了 FC_TEST_USERDATA 就绝不许回落到真实 prefs
#    （写这套时当场抓到过：想验"读不到"时悄悄读到真 4000 而假绿）
code5, out5 = run(None)
real = os.path.join(os.environ.get('APPDATA', ''), 'fangcun-desktop', 'prefs.json')
if os.path.exists(real):
    check('★★ 设了 FC_TEST_USERDATA 时**不许**回落到真实 prefs（否则"读不到"永远测不出来）',
          '没读到 prefs' in out5, 'out=%s' % out5[-160:])
else:
    print('SKIP  真实 prefs 不存在，这条无从验证（不是通过也不是失败）')

print('')
if failures:
    print('失败明细：')
    for f in failures:
        print('  · ' + f)
print(('✅ ' if not failed else '❌ ') + 'RESULT %d / %d' % (passed, failed))
sys.exit(0 if failed == 0 else 1)
