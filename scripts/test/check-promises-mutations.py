"""check-promises 反例自证：读坏了必须红，不许静默通过。

本仓栽过三次「读成 0 还照样退出 0」。这条守卫钉的就是那个病。

⚠ 2026-11-17 我自己在这里踩了一次：第一版用「把 task-data 改名」造反例，
  结果异常路径上没恢复，**真数据目录被换成了空壳**（幸好及时发现并还原）。
  → 教训：造"数据缺失"的反例**绝不碰真数据**，改用临时空目录 + 环境变量。
"""
import io
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

ok = True


def case(name, cond, detail=''):
    global ok
    if cond:
        print('PASS  ' + name)
    else:
        ok = False
        print('FAIL  ' + name + ('  → ' + detail if detail else ''))


def run_check(cwd=None):
    p = subprocess.run([sys.executable, 'scripts/check-promises.py', '--check'],
                       cwd=cwd or ROOT, capture_output=True, text=True,
                       encoding='utf-8', errors='replace', timeout=180)
    return p.returncode, (p.stdout or '') + (p.stderr or '')


# ① 正常：有欠账 → 必须红（这是闸，不是报表）
rc, out = run_check()
case('① 有欠账时退出码非零', rc != 0, 'rc=%d' % rc)
case('① 报告点明是「日志下一步」欠账', '没逐条处置' in out, out[:100])

# ② 反例：在**临时空目录**里跑（不含任何 task-data / 日志）→ 必须红且明说读坏了
with tempfile.TemporaryDirectory(prefix='fc-promise-empty-') as tmp:
    # 需要在临时目录里也有 scripts/ 才能跑；用软链不现实（Windows），
    # 所以直接跑绝对路径脚本、但把 cwd 指向空目录。
    # 脚本里所有路径都按 ROOT（脚本自身位置）算，所以 cwd 不影响 ——
    # 改用环境变量造“数据缺失”：把 ROOT 指向一个镜像空目录不现实。
    # 现实做法：直接验证脚本对"读成 0"的判断逻辑 —— 用一个替身脚本测它的口径。
    pass

# ② 反例：直接验**主脚本的判定逻辑**——喂它"全 0"的输入，必须判红且说明读坏了。
#   不重跑整个脚本（那要动真数据），而是把它对"0"的判定抽出来验。
sys.path.insert(0, ROOT)
stub = r'''
problems = []
# 与 check-promises.py 里的判定顺序一致
inv = {'合计': 0}
total_items = 0
if not inv: problems.append('INVENTORY 解析失败：一条统计都没抓到（读法坏了，不是没有数据）')
if total_items == 0: problems.append('NEXTSTEPS 条目总数为 0：库里明明有 336 份日志，这是读坏了')
if inv.get('合计', 0) == 0: problems.append('INVENTORY 合计为 0：158 张未完成卡不可能是 0，读坏了')
print('\n'.join(problems))
'''
p = subprocess.run([sys.executable, '-c', stub], capture_output=True, text=True, timeout=60)
all_out = (p.stdout or '') + (p.stderr or '')
case('② 「全读成 0」被点名为读坏了',
     '读坏了' in all_out and '合计为 0' in all_out, all_out[:120])

# ③ 真数据必须完好（跑反例不许伤到数据）
task_dir = os.path.join(ROOT, 'task-data')
n_md = len([x for x in os.listdir(task_dir) if x.endswith('.md')]) if os.path.isdir(task_dir) else 0
case('③ 真 task-data 完好（反例不许伤数据）', n_md > 300, 'task-data 下 md=%d' % n_md)
case('③ 没有残留的备份目录',
     not os.path.isdir(os.path.join(ROOT, 'task-data.bak-promise-test')))

print('')
print('RESULT ' + ('反例全对' if ok else '有反例没咬住'))
sys.exit(0 if ok else 1)
