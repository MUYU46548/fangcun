#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
竞品界面 · 反例自证（2026-11-17）

## 为什么这个反例特别重要

竞品能力 2026-10-17 拍板、11-07 做完**数据层 + CLI**，但桌面端
`desktop/src` 下 **0 个文件**提到 competitor —— 链路做了一半、入口没做。
后果是它整整一个月是空的：`tegula competitor list` → 「还没有登记任何竞品」。

而当时的判据（`check-competitors.py` 31/0）**全绿** —— 因为它测的是 CLI，
测不到「用户能不能发现它」。**这是本仓最典型的一类假绿：判据全绿、东西不存在。**

所以这一套断言必须证明自己真的会红。把下面四件逐个改坏：

  ① 界面不写「方寸不联网」 → 用户会以为它会自己去采（这一页最容易被误解的点）
  ② 没有「生成采集任务单」按钮 → 这页退化成纯展示
  ③ 没填关注点时留空 → 用户以为没有这一栏
  ④ 竞品视图没接进项目页 → 做了但点不到（就是这次要治的病本身）

⚠ 每条都会跑一次**完整 renderer-web 断言**（约 3-5 分钟），所以本脚本慢。
   慢是应该的：它验的是"界面真的在、且真的能用"，没有更便宜的验法。

跑法：python scripts/test/check-competitor-ui-mutations.py
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VIEW = os.path.join(ROOT, 'desktop', 'src', 'renderer', 'views', 'CompetitorView.vue')
ASSIGN = os.path.join(ROOT, 'desktop', 'src', 'renderer', 'views', 'ProjectsView.vue')
BUILD = os.path.join(ROOT, 'desktop')
RUNNER = os.path.join(ROOT, 'scripts', 'test', 'e2e-renderer-web.cjs')

CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'


def build():
    p = subprocess.run(['npm', 'run', 'build'], cwd=BUILD, capture_output=True,
                       text=True, encoding='utf-8', errors='replace', shell=True)
    return p.returncode == 0, (p.stdout or '') + (p.stderr or '')


def run_assert():
    env = dict(os.environ)
    env['FC_WEB_BROWSER'] = CHROME
    p = subprocess.run(['node', RUNNER], cwd=ROOT, capture_output=True, text=True,
                       encoding='utf-8', errors='replace', env=env)
    return p.returncode, (p.stdout or '') + (p.stderr or '')


def main():
    if not os.path.exists(VIEW):
        print('FAIL  找不到 CompetitorView.vue')
        return 2
    orig_view = open(VIEW, encoding='utf-8').read()
    orig_assign = open(ASSIGN, encoding='utf-8').read()

    cases = [
        (
            '反例①：界面不写「方寸不联网」（用户会以为它会自己去采）',
            lambda: open(VIEW, 'w', encoding='utf-8', newline='').write(
                orig_view.replace('方寸<b>不联网、不自建爬虫</b>', '方寸只管登记')),
            lambda: open(VIEW, 'w', encoding='utf-8', newline='').write(orig_view),
            '不联网',
        ),
        (
            '反例②：没有「生成采集任务单」按钮（这页成了纯展示）',
            lambda: open(VIEW, 'w', encoding='utf-8', newline='').write(
                orig_view.replace('📋 生成采集任务单', '（无动作）')),
            lambda: open(VIEW, 'w', encoding='utf-8', newline='').write(orig_view),
            '生成采集任务单',
        ),
        (
            '反例③：没填关注点时留空（用户以为没这一栏）',
            lambda: open(VIEW, 'w', encoding='utf-8', newline='').write(
                orig_view.replace("{{ c.focus || '—' }}", '{{ c.focus }}')),
            lambda: open(VIEW, 'w', encoding='utf-8', newline='').write(orig_view),
            '占位符',
        ),
        (
            '反例④：竞品视图没接进项目页（做了但用户点不到 = 这次要治的病）',
            lambda: open(ASSIGN, 'w', encoding='utf-8', newline='').write(
                orig_assign.replace(
                    '<CompetitorView v-else-if="ctl.pvView === \'competitor\'" />', '')),
            lambda: open(ASSIGN, 'w', encoding='utf-8', newline='').write(orig_assign),
            '竞品',
        ),
    ]

    ok = bad = 0
    for name, mutate, restore, expect in cases:
        mutate()
        try:
            built, bout = build()
            if not built:
                print('SKIP  %s —— 注入后构建失败（反例不成立，需更新反例）' % name)
                bad += 1
                continue
            code, out = run_assert()
        finally:
            restore()

        fails = [l.strip() for l in out.splitlines() if l.startswith('FAIL')]
        hits = [f for f in fails if expect in f]
        if code != 0 and hits:
            print('PASS  %s' % name)
            print('      精确红 %d 条：%s' % (len(hits), hits[0][:110]))
            ok += 1
        else:
            print('FAIL  %s —— 守卫没抓住（exit=%s，红 %d 条）' % (name, code, len(fails)))
            for x in fails[:3]:
                print('        ' + x[:110])
            bad += 1

    # 还原校验
    same_v = open(VIEW, encoding='utf-8').read() == orig_view
    same_a = open(ASSIGN, encoding='utf-8').read() == orig_assign
    print('\n还原校验：View=%s Assign=%s' % (same_v, same_a))
    if not (same_v and same_a):
        bad += 1

    built, _ = build()
    code, out = run_assert()
    m = re.search(r'RESULT (\d+) / (\d+)', out)
    green = code == 0 and built and m and m.group(2) == '0'
    print('还原后：%s（%s）' % ('PASS 全绿' if green else 'FAIL 仍红',
                            m.group(0) if m else 'no result'))
    if not green:
        bad += 1

    print('\n反例自证 %d/%d 通过%s' % (ok, len(cases), '' if not bad else '，%d 项有问题' % bad))
    return 0 if bad == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
