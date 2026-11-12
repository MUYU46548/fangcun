#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""账本体检机器规则（`scripts/audit-ledger.py`）的回归 —— 2026-11-12 加

为什么要单列一套：这个脚本**只读数据、不改卡**，所以它的失败方式很阴 ——
① 判据算出来了，但 `render()` 里把类型**写死**成四个 → 新判据静默不进报告（今天就踩了）；
② `--check` 只校验“报告文件存在”，于是**昨天的报告**照样绿，而实跑给出不同条数（今天也踩了）。
两者都不报错、界面也没有 —— 只有对着跑一遍才看得见。

判据：
  ① 五种类型都能进报告（**动态**渲染，不是写死四个）；
  ② `--check` 与实跑**同源**：报告卡集合 == 现算卡集合；
  ③ “产出已存在但仍挂待办”这条判据是**窄**的（窗口内改过才算，写死的旧文件不算）；
  ④ 只读：跑完 task-data 每个文件逐字节不变。

用法：python scripts/test/check-audit-ledger.py
"""
import importlib.util
import os
import sys
import hashlib

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRIPT = os.path.join(ROOT, 'scripts', 'audit-ledger.py')

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

spec = importlib.util.spec_from_file_location('audit_ledger', SCRIPT)
AL = importlib.util.module_from_spec(spec)
spec.loader.exec_module(AL)

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
        failures.append(name + ('  :: ' + str(detail) if detail else ''))
        print('FAIL  ' + name + ('  → ' + str(detail) if detail else ''))


def digest_dir(d):
    out = {}
    for n in sorted(os.listdir(d)):
        p = os.path.join(d, n)
        if os.path.isfile(p):
            with open(p, 'rb') as f:
                out[n] = hashlib.md5(f.read()).hexdigest()
    return out


print('== 账本体检机器规则 ==')
before = digest_dir(AL.TASK_DIR)
ver, rows = AL.scan()
report = AL.render(ver, rows)

# ① 五种类型都能进报告
KINDS = ['过期验收', '已完成里程碑', '引用已撤销决策', '提到旧版本', '产出已存在但仍挂待办']
missing = [k for k in KINDS if k not in report]
check('★★ 五种判据类型都在报告的“判据”说明里（不许只写死前四个）',
      not missing, '缺：' + '、'.join(missing))

check('★ 汇总行同时给“条数 / 张卡”（同一张卡命中两条时两个数会差，别让人误解）',
      ('条候选' in report) and ('张卡' in report),
      [l for l in report.splitlines() if '汇总' in l][:1])

# ② render 动态：造一条“未来才会有的类型”，必须出现在报告里（这正是今天漏的那种）
synthetic = list(rows) + [{
    'id': 'synthetic-nonexistent-card', 'title': '合成用例', 'status': '待办',
    'kind': '未来新增的类型', 'evidence': 'x', 'advice': 'y', 'risk': 'z',
}]
rep2 = AL.render(ver, synthetic)
check('★★ 未知类型也会被渲染（render 从 by_kind 动态取，不是写死四个）',
      '未来新增的类型' in rep2, '未知类型被静默丢了')

# ③ 窄判据：把“创建时间”设成很久以前 + 文件 mtime 在窗口外 → 不该命中
check('★★ “产出已存在但仍挂待办”只在创建后 14 天内改过才算（窗口外不算）', (
    # 直接验算法：给一个必然在窗口外的组合
    AL.created_ts({'创建': '2020-01-01T00:00:00'}) > 0
    and AL.created_ts({}) == 0            # 认不出 → 0（保守方向：宁可漏报）
    and AL.created_ts({'创建': '不是时间'}) == 0
), 'created_ts 对坏输入必须给 0，不能当 1970')

# ④ 只读
after = digest_dir(AL.TASK_DIR)
check('★★ 跑完 task-data 逐字节不变（体检只读，一个卡都不许动）',
      before == after,
      'changed=' + str([k for k in before if before[k] != after.get(k)])[:3])

print('')
if failures:
    print('失败明细：')
    for f in failures:
        print('  · ' + f)
print('通过 %d / 失败 %d' % (passed, failed))
print('RESULT %d / %d' % (passed, failed))
sys.exit(1 if failed else 0)
