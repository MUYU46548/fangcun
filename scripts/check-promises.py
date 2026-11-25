#!/usr/bin/env python3
"""方寸 · 「提了没做」收工闸（2026-11-17）

暮雨：「防止东西提了没做的机制，有了吗？」

## 诚实的前提（别假装这是全新发明）

之前**已有**两套清点：
  · `scripts/inventory-unfinished.py --check` → 未完成卡 + 日志下一步 + 问卷 + 计划卡
  · `scripts/audit-log-nextsteps.cjs --check` → 日志「下一步」逐条处置

它们**测过、能用**（日志下一步 780 条里 706 条逐条处置过 = 90%）。
**缺的不是清点，是没人跑。** 本脚本把两者合成**一道闸**，给一个非零退出码，
好让它在「收工 / 发版前」这种真的会被执行的地方挂上去。

## 为什么不做「标题相似度去重」

AGENTS.md 明写：字面相似度这条**试过两次都失败**（真重复的相似度只有 0.15–0.26，
而模板卡字面必然高度重合）。2026-11-17 我又实测一次当前真数据：
**157 张未完成卡里，归一化后标题完全相同的只有 1 组**（`结构地图更新 · fangcun-base` ×2）。
→ 结论不变：**不靠字面抓重复**，靠「处置留痕」。

## 判据（本闸怎么算红）

1. 日志「下一步」里还有**没逐条处置**的 → 红（那正是"提了没做"）
2. 未完成卡里有**正文勾选项一个没勾**的 → 只报数，不单独判红（很多卡确实还没开始）
3. 空库 / 读成 0 → **必须红**（读法是坏的，不是没东西）—— 本仓栽过三次

用法：
  python scripts/check-promises.py            # 人读的报告
  python scripts/check-promises.py --check    # 只有闸：非零退出 = 还有欠账
  python scripts/check-promises.py --json
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _console_safe(text):
    """把控制台打不出的字符降级，别让"闸报了欠账"变成"闸自己崩了"。

    2026-11-25 实测：Windows 默认控制台是 GBK（cp936），而本脚本结尾要打印
    `✗ 有欠账：` / `✓ 没有欠账`，正文里还有 `⚠`。这三个字符 GBK 编不了 →
    `UnicodeEncodeError: 'gbk' codec can't encode character '\\u2717'` →
    **脚本在"该说结论"的那一行崩掉**，退出码虽然还是 1，但用户看到的是
    traceback 而不是"还欠 42 条"。一个没人看得懂的闸等于没有闸。

    只降级**打不出的那几个符号**，其余（包括中文）原样保留；
    输出被重定向到文件/管道时编码是 utf-8，什么都不会变。
    """
    enc = getattr(sys.stdout, 'encoding', None) or 'utf-8'
    try:
        text.encode(enc)
        return text
    except (UnicodeEncodeError, LookupError):
        pass
    # 只换这三个会犯事的符号，别把整份报告 ASCII 化
    for ch, fallback in (('\u2717', 'x'), ('\u2713', 'v'), ('\u26a0', '!')):
        try:
            ch.encode(enc)
        except (UnicodeEncodeError, LookupError):
            text = text.replace(ch, fallback)
    return text


def say(text=''):
    """打印一行，经 `_console_safe` 降级。结论行一律走这里。"""
    print(_console_safe(text))


def run(cmd):
    """跑子命令拿输出与退出码（不看码等于没跑）。"""
    try:
        p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                           encoding='utf-8', errors='replace', timeout=180)
        return p.returncode, (p.stdout or '') + (p.stderr or '')
    except FileNotFoundError:
        return 127, '找不到命令'
    except subprocess.TimeoutExpired:
        return 124, '超时'


def count(pattern, text):
    return len(re.findall(pattern, text or '', re.M))


def main():
    as_json = '--json' in sys.argv
    check_only = '--check' in sys.argv

    # ① 日志「下一步」逐条处置
    rc1, out1 = run([sys.executable, 'scripts/inventory-unfinished.py'])
    rc2, out2 = run(['node', 'scripts/audit-log-nextsteps.cjs', '--check'])

    # 从 inventory 抓四段计数
    inv = {}
    for key, pat in [
        ('未完成卡', r'^\|\s*未完成卡\s*\|\s*\*{0,2}(\d+)'),
        ('日志下一步', r'^\|\s*日志「下一步」没接的\s*\|\s*\*{0,2}(\d+)'),
        ('问卷待办', r'^\|\s*问卷待办\s*\|\s*\*{0,2}(\d+)'),
        ('计划卡待办', r'^\|\s*计划卡待办\s*\|\s*\*{0,2}(\d+)'),
        ('合计', r'^\|\s*\*\*合计\*\*\s*\|\s*\*{0,2}(\d+)'),
    ]:
        m = re.search(pat, out1, re.M)
        if m:
            inv[key] = int(m.group(1))

    # 从 nextsteps 抓计数（⚠ 按**真实输出**抓，不按我以为的格式抓）：
    #   「下一步」条目总数: 780
    #   其中没有卡在接、也没逐条处置: 52
    #   （另有 706 条逐条处置过、2 条被整份标记盖住）
    m = re.search(r'其中没有卡在接、也没逐条处置:\s*(\d+)', out2)
    undisposed = int(m.group(1)) if m else None
    m2 = re.search(r'另有\s*(\d+)\s*条逐条处置过', out2)
    disposed = int(m2.group(1)) if m2 else None
    m3 = re.search(r'「下一步」条目总数:\s*(\d+)', out2)
    total_items = int(m3.group(1)) if m3 else None

    # 闸是"有欠账就红"；但**读成 0 也要红**——那是读法坏了
    problems = []
    if not inv:
        problems.append('INVENTORY 解析失败：一条统计都没抓到（读法坏了，不是没有数据）')
    if total_items is None:
        problems.append('NEXTSTEPS 解析失败：抓不到条目总数（读法坏了）')
    if total_items == 0:
        problems.append('NEXTSTEPS 条目总数为 0：库里明明有 336 份日志，这是读坏了')
    if undisposed is None:
        problems.append('NEXTSTEPS 抓不到「仍未接」数')
    elif undisposed > 0:
        problems.append(f'日志「下一步」还有 {undisposed} 条没逐条处置 —— 这就是“提了没做”')
    if inv.get('合计', 0) == 0:
        problems.append('INVENTORY 合计为 0：158 张未完成卡不可能是 0，读坏了')

    result = {
        'ok': not problems,
        'inventory': inv,
        'nextSteps': {
            '条目总数': total_items,
            '逐条处置过': disposed,
            '仍未接': undisposed,
        },
        'problems': problems,
        'where': {
            '未完成卡来源': 'task-data/*.md（状态 ≠ 完成/驳回）',
            '日志下一步来源': 'docs/执行日志/*.md 的「下一步」节',
        },
    }

    if as_json:
        # ⚠ 机器读的分支也一样会崩：`ensure_ascii=False` 时中文要按控制台编码写出去，
        # 而 GBK 控制台下同样可能 Unsupported。走 say() 降级，别让 --json 变成 traceback。
        say(json.dumps(result, ensure_ascii=False, indent=2))
        return 1 if problems else 0

    if check_only:
        if problems:
            for p in problems:
                print('FAIL  ' + p)
            print(f'\nRESULT 有 {len(problems)} 项欠账')
            return 1
        print('RESULT 没有欠账')
        return 0

    print('== 提了没做 · 收工闸 ==\n')
    print('未完成总账：')
    for k in ('未完成卡', '日志下一步', '问卷待办', '计划卡待办', '合计'):
        if k in inv:
            print(f'  {k:<10} {inv[k]}')
    print('\n日志「下一步」逐条处置：')
    if total_items is not None:
        pct = ((disposed or 0) / total_items * 100) if total_items else 0
        print(f'  条目总数      {total_items}')
        print(f'  逐条处置过    {disposed if disposed is not None else "?"}（{pct:.0f}%）')
        print(f'  仍未接        {undisposed if undisposed is not None else "?"}')
    say('\n' + ('✗ 有欠账：' if problems else '✓ 没有欠账'))
    for p in problems:
        say('  · ' + p)
    if problems:
        print('\n下一步：')
        print('  node scripts/audit-log-nextsteps.cjs --todo 10   # 看还欠哪些')
        print('  node scripts/audit-log-nextsteps.cjs --items <日志id>   # 看某份日志的全部条目')
        print('  处置标记写在日志原文里（@序号 + 已做/已转卡/已放弃/非本项目/已核实）')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
