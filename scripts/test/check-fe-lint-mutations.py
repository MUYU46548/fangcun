#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
ESLint 配置 · 反例自证（A1a · 2026-11-17）

## 为什么
这份配置在写成的头一小时里产生过**三种假绿**，且每一种都"跑成功了"：
  ① 没给 TS parser → 58/59 个 .vue parse error → 违规只剩 23 条（真值 471）
  ② 独立的 .ts 没给 parser → 31 个 .ts 全 parse error → 统计残缺
  ③ `VElement[name="button"]` 把小写化后的 `<Button>` 也算成裸 button
     → 642 条假阳性（`DecisionBoard.vue` 源码 0 个 `<button`、18 个 `<Button>`，被报 20 条）

`check-fe-lint.cjs` 钉这些；本脚本把错装回去，证明它真的会红。

跑法：python scripts/test/check-fe-lint-mutations.py
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CFG = os.path.join(ROOT, 'desktop', 'eslint.config.cjs')
GUARD = os.path.join(ROOT, 'scripts', 'test', 'check-fe-lint.cjs')


def run_guard():
    p = subprocess.run(['node', GUARD], cwd=ROOT, capture_output=True, text=True,
                       encoding='utf-8', errors='replace')
    return p.returncode, (p.stdout or '') + (p.stderr or '')


def fails(out):
    return [l.strip() for l in out.splitlines() if l.startswith('FAIL')]


CASES = [
    (
        '反例①：去掉 rawName（<Button> 组件被误报成裸 button → 642 条假阳性）',
        lambda s: s.replace('VElement[name="button"][rawName="button"]', 'VElement[name="button"]'),
        # 这条的失败形状是**对账不一致**（eslint=642 vs fe-audit=471），
        # 不是 "rawName" 这个词出现在 FAIL 行里 —— 首版反例就是按词匹配才误报 FAIL。
        'eslint 数 == fe-audit',
    ),
    (
        # ⚠ 首版写成"删掉 plugins: { vue }"，实测**守卫没红** —— 因为 flat/base 已带上插件，
        #   删那行根本不影响。真会崩的形状是"两个来源都没有"。
        '反例②：vue 插件两个来源都去掉（规则失去插件，配置崩）',
        lambda s: s.replace("  ...vue.configs['flat/base'],", '  // removed flat/base')
                    .replace('plugins: { vue },', '// no plugins,'),
        '',   # 崩溃会让多条红，下面用"红条数 >= 1"判
    ),
    (
        '反例③：规则改成 error（A1a 就该只出账，不许设门槛）',
        lambda s: s.replace("'vue/no-restricted-syntax': ['warn', {",
                            "'vue/no-restricted-syntax': ['error', {"),
        'warn',
    ),
    (
        '反例④：把 lint 挂进 build（A1a 不该设门槛）',
        lambda s: s.replace('', '') ,  # 这条不改配置，改 package.json（见下特殊处理）
        'lint',
    ),
]


def main():
    orig = open(CFG, encoding='utf-8').read()
    ok = bad = 0

    for name, mutate, expect in CASES:
        # 反例④ 改的是 package.json，不是 eslint.config
        if '挂进 build' in name:
            pkg_path = os.path.join(ROOT, 'desktop', 'package.json')
            pkg_orig = open(pkg_path, encoding='utf-8').read()
            import json
            pkg = json.loads(pkg_orig)
            pkg['scripts']['build'] = 'eslint src/renderer && ' + pkg['scripts']['build']
            with open(pkg_path, 'w', encoding='utf-8', newline='') as f:
                json.dump(pkg, f, ensure_ascii=False, indent=2)
            try:
                code, out = run_guard()
            finally:
                with open(pkg_path, 'w', encoding='utf-8', newline='') as f:
                    f.write(pkg_orig)
            hits = [x for x in fails(out) if 'build' in x or 'lint' in x]
            if code != 0 and hits:
                print('PASS  %s' % name)
                print('      精确红 %d 条：%s' % (len(hits), hits[0][:110]))
                ok += 1
            else:
                print('FAIL  %s —— 守卫没抓住（exit=%s，红 %d 条）' % (name, code, len(fails(out))))
                for x in fails(out)[:3]:
                    print('        ' + x[:110])
                bad += 1
            continue

        mutated = mutate(orig)
        if mutated == orig:
            print('SKIP  %s —— 注入没生效（源码变了，反例过期）' % name)
            bad += 1
            continue
        with open(CFG, 'w', encoding='utf-8', newline='') as f:
            f.write(mutated)
        try:
            code, out = run_guard()
        finally:
            with open(CFG, 'w', encoding='utf-8', newline='') as f:
                f.write(orig)

        fs = fails(out)
        hits = [x for x in fs if expect in x] if expect else fs
        if code != 0 and hits:
            print('PASS  %s' % name)
            print('      精确红 %d 条：%s' % (len(hits), hits[0][:110]))
            ok += 1
        else:
            print('FAIL  %s —— 守卫没抓住（exit=%s，红 %d 条）' % (name, code, len(fs)))
            for x in fs[:3]:
                print('        ' + x[:110])
            bad += 1

    # 还原校验
    same = open(CFG, encoding='utf-8').read() == orig
    print('\n还原校验：%s' % ('PASS 逐字节一致' if same else 'FAIL 与原文不一致'))
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
