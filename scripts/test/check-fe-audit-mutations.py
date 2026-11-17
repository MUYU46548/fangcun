#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
跨项目前端体检 · 反例自证（2026-11-17）

## 为什么需要它

`scripts/fe-audit.cjs` 是只读统计器。这类脚本最典型的坏法**不是崩溃，是静默给出错数字**：
它在写出来的第一个小时里就犯了三次，且**报告看起来完全正常**：

  ① 按"目录集合大小"数基座 → 方寸扁平摆法数成 1、司天分目录摆法数成 3
  ② Quartz 有 63 个 .tsx + package.json，却因 `deps.react` 不在被判成
     「Python 为主（1 个 .py，无前端构建）」—— 认不出就当没有
  ③ 引用基座的路径只认一种写法，把司天的 `./ui/button` 漏掉 → "0 引用"

`check-fe-audit.cjs` 钉的是这几条的机器判据；本脚本证明**那些判据真的会红**
（把错装回去 → 必须精确变红 → 逐字节还原）。

## 它还当场抓到了守卫自己的两处空洞（这才是它的价值）

- 反例② 首版只注入兜底分支 → **守卫没红**。查下来是反例过期（后来加的
  `deps.preact` 已经先命中），不是守卫漏。反例本身也要跟着源码演进，否则是假自信。
- 反例④ 首版守卫只断言报告里出现「判据/基座使用率/lint」三个词 —— 而这三个词
  **在表格头里也有**，于是删掉阈值打印照样 PASS。**那是真空洞**，已改成钉
  「逐条编号 + 阈值原文」。

跑法：python scripts/test/check-fe-audit-mutations.py
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.path.join(ROOT, 'scripts', 'fe-audit.cjs')
GUARD = os.path.join(ROOT, 'scripts', 'test', 'check-fe-audit.cjs')


def run_guard():
    p = subprocess.run([sys.executable and 'node', GUARD], cwd=ROOT,
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    return p.returncode, (p.stdout or '') + (p.stderr or '')


def failures(out):
    return [l.strip() for l in out.splitlines() if l.startswith('FAIL')]


CASES = [
    (
        '反例①：基座按目录集合数（方寸扁平摆法被数成 1）',
        lambda s: s.replace(
            'const baseComponents = baseFiles.length',
            'const baseComponents = new Set(baseFiles.map((f) => require("path").dirname(f))).size'),
        '基座组件数可复算',
    ),
    (
        # ⚠ 首版只注入兜底分支 → 守卫没红。反例自己过期了（preact 已先命中），
        #   要复现"认不出就当没有"必须同时去掉框架识别与兜底。
        '反例②：认不出就当没有（Quartz 判成 Python 为主）',
        lambda s: s.replace(
            "if (deps.preact) feats.push('preact@' + deps.preact)", '// removed'
        ).replace('if (!feats.length && (jsxCount || pkg)) {', 'if (false) {'),
        'Quartz 不许被认成',
    ),
    (
        '反例③：不剥注释数 button（TaskCardMenu 注释被算进手搓）',
        lambda s: s.replace(
            'const bareBtn = countIn(uiOwner, /<button\\b/g, { stripComments: true })',
            'const bareBtn = countIn(uiOwner, /<button\\b/g, { stripComments: false })'),
        '裸 <button> 数可复算',
    ),
    (
        '反例④：丢掉阈值打印（掉队项变黑箱）',
        lambda s: s.replace('RULES.forEach((r, i) => console.log(`  ${i + 1}. ${r}`))', '// removed'),
        '逐条编号',
    ),
    (
        '反例⑤：无匹配时静默退出 0（零产出假装通过）',
        lambda s: s.replace(
            "process.exit(2)\n    }\n  }\n\n  const results",
            "return\n    }\n  }\n\n  const results"),
        '退出码非 0',
    ),
]


def main():
    if not os.path.exists(TARGET):
        print('FAIL  找不到 scripts/fe-audit.cjs')
        return 2
    orig = open(TARGET, encoding='utf-8').read()
    ok = bad = 0

    for name, mutate, expect in CASES:
        mutated = mutate(orig)
        if mutated == orig:
            print('SKIP  %s —— 注入没生效（源码变了，反例已过期，必须更新反例）' % name)
            bad += 1
            continue
        with open(TARGET, 'w', encoding='utf-8', newline='') as f:
            f.write(mutated)
        try:
            code, out = run_guard()
        finally:
            with open(TARGET, 'w', encoding='utf-8', newline='') as f:
                f.write(orig)
        hits = [x for x in failures(out) if expect in x]
        if code != 0 and hits:
            print('PASS  %s' % name)
            print('      精确红 %d 条：%s' % (len(hits), hits[0][:120]))
            ok += 1
        else:
            print('FAIL  %s —— 守卫没抓住（exit=%s，红 %d 条）' % (name, code, len(failures(out))))
            for x in failures(out)[:3]:
                print('        ' + x[:120])
            bad += 1

    # 逐字节还原校验
    same = open(TARGET, encoding='utf-8').read() == orig
    print('\n还原校验：%s' % ('PASS 逐字节一致' if same else 'FAIL 文件与原文不一致'))
    if not same:
        bad += 1

    code, out = run_guard()
    m = re.search(r'RESULT (\d+) / (\d+)', out)
    green = code == 0 and m and m.group(2) == '0'
    print('还原后：%s（%s）' % ('PASS 全绿' if green else 'FAIL 仍红', m.group(0) if m else 'no result'))
    if not green:
        bad += 1

    print('\n反例自证 %d/%d 通过%s' % (ok, len(CASES), '' if not bad else '，%d 项有问题' % bad))
    return 0 if bad == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
