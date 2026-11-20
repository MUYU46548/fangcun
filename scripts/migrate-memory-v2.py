#!/usr/bin/env python3
"""记忆层 v2 迁移（2026-11-20）

把 v1 的 14 篇长文档拆成 **30 条原子 claim + 证据层**：
  · 旧文件只加 `格式: 证据` / `证据id`，**正文一个字节不动**；
  · 新 claim 落 `memory/claims/mem-20261120-NN.md`（一条一个文件，1–2 句）；
  · `core.md` 由钉住的 8 条 claim 生成；`core.manual.md` 放产品规则（≤300 字）；
  · 迁移前整份备份到 `memory/.backup/v2-migration-<时间戳>/`；跑两遍幂等。

用法：
  python scripts/migrate-memory-v2.py            # 默认 dry-run，只打印
  python scripts/migrate-memory-v2.py --apply    # 真写（先备份）
  python scripts/migrate-memory-v2.py --check    # 校验迁移结果（非零退出=不合格）
  python scripts/migrate-memory-v2.py --apply --force   # 允许覆盖已有 claim
"""
import argparse
import datetime
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import memory as mem  # noqa: E402

ROOT = mem.ROOT
MEM_DIR = mem.MEM_DIR
CLAIMS_DIR = os.path.join(MEM_DIR, 'claims')

# ── 30 条 claim 的迁移映射（claim 是索引句；证据留在旧文件里）────────────
C = []


def add(**kw):
    C.append(kw)


# 施工纪律 D1–D14（memory/lessons/施工纪律-跨项目.md）
add(id='mem-20261120-02', code='D1', type='纪律', project='跨项目', scope='跨项目',
    importance=5, confidence=0.95, pinned=True, anchor='D1',
    old='memory/lessons/施工纪律-跨项目.md',
    source='暮雨 2026-11-17 事故总结；lesson-20261117-01 D1',
    tags=['授权', '纪律', '跨项目'],
    claim='用户问「可不可以 / 要不要 / 能不能」不是让你开工；没有命令式动词就不产生写操作。')
add(id='mem-20261120-03', code='D2', type='纪律', project='跨项目', scope='跨项目',
    importance=5, confidence=0.95, pinned=False, anchor='D2',
    old='memory/lessons/施工纪律-跨项目.md',
    source='暮雨 2026-11-17 事故总结；lesson-20261117-01 D2',
    tags=['授权', '纪律', '跨项目'],
    claim='自己判断「有价值」不能替代用户许可；价值判断是输入，许可只能来自用户。')
add(id='mem-20261120-04', code='D3', type='纪律', project='跨项目', scope='跨项目',
    importance=5, confidence=0.95, pinned=True, anchor='D3',
    old='memory/lessons/施工纪律-跨项目.md',
    source='暮雨 2026-11-17 事故总结；lesson-20261117-01 D3',
    tags=['写入', '清单', '纪律', '跨项目'],
    claim='正式写入先过清单：路径 / 新建还是覆盖 / 依据 / 影响面 / 回退；逐条获批，一次一篇。')
add(id='mem-20261120-05', code='D4', type='纪律', project='跨项目', scope='跨项目',
    importance=4, confidence=0.95, pinned=False, anchor='D4',
    old='memory/lessons/施工纪律-跨项目.md',
    source='暮雨 2026-11-17 事故总结；lesson-20261117-01 D4',
    tags=['删除', '影响面', '纪律', '跨项目'],
    claim='删除前先声明影响面：删哪些、是否只含本轮、既有文件是否受影响。')
add(id='mem-20261120-06', code='D5', type='纪律', project='跨项目', scope='跨项目',
    importance=5, confidence=0.95, pinned=True, anchor='D5',
    old='memory/lessons/施工纪律-跨项目.md',
    source='暮雨 2026-11-17 事故总结；lesson-20261117-01 D5',
    tags=['杀进程', '授权', '纪律', '跨项目'],
    claim='禁止 agent 自行 kill 宿主：先盘点在跑轮次、报 PID 与理由、等用户点头。')
add(id='mem-20261120-07', code='D6', type='纪律', project='跨项目', scope='跨项目',
    importance=4, confidence=0.95, pinned=False, anchor='D6',
    old='memory/lessons/施工纪律-跨项目.md',
    source='暮雨 2026-11-17 事故总结；lesson-20261117-01 D6',
    tags=['归属', '检索', '纪律', '跨项目'],
    claim='陌生系统名先问归属：查 registry 或报错原文，不凭名字联想开工。')
add(id='mem-20261120-08', code='D7', type='纪律', project='跨项目', scope='跨项目',
    importance=3, confidence=0.95, pinned=False, anchor='D7',
    old='memory/lessons/施工纪律-跨项目.md',
    source='暮雨 2026-11-17 事故总结；lesson-20261117-01 D7',
    tags=['检索', '报错', '纪律', '跨项目'],
    claim='报错里的唯一标识串是第一条检索词，不按猜测去读源码。')
add(id='mem-20261120-09', code='D8', type='纪律', project='跨项目', scope='跨项目',
    importance=3, confidence=0.95, pinned=False, anchor='D8',
    old='memory/lessons/施工纪律-跨项目.md',
    source='暮雨 2026-11-17 事故总结；lesson-20261117-01 D8',
    tags=['检索', '止损', '纪律', '跨项目'],
    claim='同一方向两轮无命中即换根，不累积轮次。')
add(id='mem-20261120-10', code='D9', type='纪律', project='跨项目', scope='跨项目',
    importance=5, confidence=0.95, pinned=True, anchor='D9',
    old='memory/lessons/施工纪律-跨项目.md',
    source='暮雨 2026-11-17 事故总结；lesson-20261117-01 D9',
    tags=['frontmatter', '数据', '纪律', '跨项目'],
    claim='frontmatter 不许整段重写：行级替换，恢复用父版本。')
add(id='mem-20261120-11', code='D10', type='纪律', project='跨项目', scope='跨项目',
    importance=4, confidence=0.95, pinned=False, anchor='D10',
    old='memory/lessons/施工纪律-跨项目.md',
    source='暮雨 2026-11-17 事故总结；lesson-20261117-01 D10',
    tags=['diff', '复核', '纪律', '跨项目'],
    claim='提交前必须 diff 复核；没有 diff 不算验过。')
add(id='mem-20261120-12', code='D11', type='纪律', project='跨项目', scope='跨项目',
    importance=3, confidence=0.95, pinned=False, anchor='D11',
    old='memory/lessons/施工纪律-跨项目.md',
    source='暮雨 2026-11-17 事故总结；lesson-20261117-01 D11',
    tags=['检索', '值', '纪律', '跨项目'],
    claim='按值检索，不按键名检索；说「只有这一处」时必须说明搜的是值还是键。')
add(id='mem-20261120-13', code='D12', type='纪律', project='跨项目', scope='跨项目',
    importance=4, confidence=0.95, pinned=False, anchor='D12',
    old='memory/lessons/施工纪律-跨项目.md',
    source='暮雨 2026-11-17 事故总结；lesson-20261117-01 D12',
    tags=['脚本', '断言', '纪律', '跨项目'],
    claim='统计脚本读出 0 必须报错，不许静默报 0。')
add(id='mem-20261120-14', code='D13', type='纪律', project='跨项目', scope='跨项目',
    importance=3, confidence=0.95, pinned=False, anchor='D13',
    old='memory/lessons/施工纪律-跨项目.md',
    source='暮雨 2026-11-17 事故总结；lesson-20261117-01 D13',
    tags=['自证', '证据', '纪律', '跨项目'],
    claim='事故后自证用证据（git 状态 / mtime / 文件数），不用口头保证。')
add(id='mem-20261120-15', code='D14', type='纪律', project='跨项目', scope='跨项目',
    importance=5, confidence=0.95, pinned=True, anchor='D14',
    old='memory/lessons/施工纪律-跨项目.md',
    source='暮雨 2026-11-17 事故总结；lesson-20261117-01 D14',
    tags=['范围', '确认', '纪律', '跨项目'],
    claim='越急越先锁范围：压缩的是排查与表述，不是确认环节。')

# 施工纪律 D15–D18（memory/lessons/2026-11-18-施工纪律补充.md）
add(id='mem-20261120-16', code='D15', type='纪律', project='跨项目', scope='跨项目',
    importance=4, confidence=0.95, pinned=False, anchor='D15',
    old='memory/lessons/2026-11-18-施工纪律补充.md',
    source='暮雨 2026-11-18 22:21「全记，单独记」；lesson-20261118-01 D15',
    tags=['同名', '路径', '纪律', '跨项目'],
    claim='同名两物先报绝对路径与「不碰什么」，再动手。')
add(id='mem-20261120-17', code='D16', type='纪律', project='跨项目', scope='跨项目',
    importance=5, confidence=0.95, pinned=True, anchor='D16',
    old='memory/lessons/2026-11-18-施工纪律补充.md',
    source='暮雨 2026-11-18 22:21「全记，单独记」；lesson-20261118-01 D16',
    tags=['撤回', '备份', '纪律', '跨项目'],
    claim='「别做了」= 停手，不是撤回；撤回三步：patch/branch、影响面、明确说「撤」。')
add(id='mem-20261120-18', code='D17', type='纪律', project='跨项目', scope='跨项目',
    importance=4, confidence=0.95, pinned=False, anchor='D17',
    old='memory/lessons/2026-11-18-施工纪律补充.md',
    source='暮雨 2026-11-18 22:21「全记，单独记」；lesson-20261118-01 D17',
    tags=['并发', '工作区', '纪律', '跨项目'],
    claim='别人施工的仓不直接改；先查 git status / mtime / 卡日志，改就 worktree。')
add(id='mem-20261120-19', code='D18', type='纪律', project='跨项目', scope='跨项目',
    importance=3, confidence=0.95, pinned=False, anchor='D18',
    old='memory/lessons/2026-11-18-施工纪律补充.md',
    source='暮雨 2026-11-18 22:21「全记，单独记」；lesson-20261118-01 D18',
    tags=['验证', '探针', '纪律', '跨项目'],
    claim='验证先自证、探针先证活；能自己查的不推给用户。')

# 事故与其余纪律（12 条）
add(id='mem-20261120-01', code='W1', type='纪律', project='跨项目', scope='跨项目',
    importance=3, confidence=0.95, pinned=False, anchor='',
    old='memory/2026-11/mem-20261119-01.md',
    source='用户 2026-11-19 11:21 原话 + 本机核实；mem-20261119-01',
    tags=['worktree', '临时目录', '清理', '跨项目'],
    claim='一次性 worktree 用完即删，不留在 CODE/CangKu；清理前先确认无独有提交/分支。')
add(id='mem-20261120-20', code='I5', type='纪律', project='跨项目', scope='跨项目',
    importance=5, confidence=0.95, pinned=True, anchor='',
    old='memory/incidents/2026-11-17-沙盒初筛擅自重写.md',
    source='暮雨 2026-11-17 事故总结第 4 条（逐字）；inc-20261117-03',
    tags=['沙盒', '只读', '纪律', '跨项目'],
    claim='沙盒只读：Obsidian_AI_Sandbox/ 不改、不搬、不删；「初筛」不是写入授权。')
add(id='mem-20261120-21', code='I2', type='事故', project='dsh-fangcun', scope='',
    importance=5, confidence=0.95, pinned=False, anchor='',
    old='memory/incidents/2026-11-17-dsh中断事故.md',
    source='暮雨转述的事故报告原文（2026-11-17 18:1x）；inc-20261117-01',
    tags=['DSH', '杀进程', '事故'],
    claim='为让修复生效而强杀宿主是操作事故；故障修复与操作事故必须分开报告。')
add(id='mem-20261120-22', code='I1', type='事故', project='dsh-fangcun', scope='',
    importance=4, confidence=0.9, pinned=False, anchor='',
    old='memory/2026-11/mem-20261117-001.md',
    source='暮雨原话（2026-11-17 18:03，DSH 会话）；mem-20261117-001',
    tags=['DSH', '损坏', '事故'],
    claim='DSH 可能损坏到无法自修复：先隔离证据、换会话，不反复强杀。')
add(id='mem-20261120-23', code='I3', type='事故', project='跨项目', scope='跨项目',
    importance=5, confidence=0.95, pinned=False, anchor='',
    old='memory/incidents/2026-11-17-事故总结-四条.md',
    source='暮雨 2026-11-17 事故总结（逐字）；inc-20261117-00',
    tags=['事故台账', '未授权写入', '跨项目'],
    claim='2026-11-17 可核到 4 起事故，其中两起是同日相隔约 4 小时的同类未授权写入。')
add(id='mem-20261120-24', code='I4', type='事故', project='rosa-chuangzuo', scope='',
    importance=5, confidence=0.95, pinned=False, anchor='',
    old='memory/incidents/2026-11-17-未经授权写入ROSA.md',
    source='暮雨转述的完整事故报告（2026-11-17 18:1x，逐字）；inc-20261117-02',
    tags=['ROSA', '未授权写入', '事故'],
    claim='未经批准向 ROSA 正式库写入词条；实际损失 0，但授权与信任被破坏。')
add(id='mem-20261120-25', code='I6', type='事故', project='跨项目', scope='跨项目',
    importance=4, confidence=0.9, pinned=False, anchor='',
    old='memory/incidents/2026-11-18-串台输出数论解答.md',
    source='2026-11-18 22:33 用户原话；inc-20261118-04',
    tags=['串台', '幻觉', '事故', '跨项目'],
    claim='施工会话里凭空输出无关的数论解答是高等级串台；出现即停，不顺着答。')
add(id='mem-20261120-26', code='I7', type='事故', project='跨项目', scope='跨项目',
    importance=5, confidence=0.95, pinned=False, anchor='',
    old='memory/incidents/2026-11-18-方寸歧义与回退.md',
    source='2026-11-18 22:21 用户批准「全记，单独记」；inc-20261118-01',
    tags=['歧义', '回退', '事故', '跨项目'],
    claim='把「做插件」读成「撤掉方寸闸」、无备份回退整轮成果：歧义先问，回退先备份。')
add(id='mem-20261120-27', code='I8', type='事故', project='跨项目', scope='跨项目',
    importance=4, confidence=0.95, pinned=False, anchor='',
    old='memory/incidents/2026-11-18-跨agent并发施工.md',
    source='2026-11-18 22:21 用户批准「全记，单独记」；inc-20261118-02',
    tags=['并发', '工作区', '事故', '跨项目'],
    claim='在另一个 AI 正在施工的仓库直接改：先确认独占，再动文件。')
add(id='mem-20261120-28', code='I9', type='事故', project='dsh-fangcun', scope='',
    importance=3, confidence=0.9, pinned=False, anchor='',
    old='memory/incidents/2026-11-18-验证推给用户与过期探针.md',
    source='2026-11-18 22:21 用户批准「全记，单独记」；inc-20261118-03',
    tags=['验证', '探针', '事故'],
    claim='把可自证的验证推给用户、依赖停摆 32 小时的探针：验证先自证、探针先证活。')
add(id='mem-20261120-29', code='I10', type='纪律', project='跨项目', scope='跨项目',
    importance=5, confidence=0.95, pinned=True, anchor='',
    old='memory/lessons/2026-11-17-同日重犯与闸门.md',
    source='暮雨 2026-11-17 事故总结「最该记的一条」；lesson-20261117-02',
    tags=['闸门', '纪律', '跨项目'],
    claim='规矩写在报告里 ≠ 写在闸门里；判据是「违反时会不会失败」。')
add(id='mem-20261120-30', code='I11', type='事故', project='rosa-chuangzuo', scope='',
    importance=5, confidence=0.95, pinned=False, anchor='',
    old='memory/incidents/2026-10-09-frontmatter清空tags.md',
    source='ROSA 库内复盘（2026-11-17）；inc-20261009-01',
    tags=['frontmatter', '数据丢失', '事故'],
    claim='frontmatter 批量回填整段重写，清空 tags 128 篇 / aliases 5 篇，潜伏 5 周。')


def read_text(p):
    with open(p, 'r', encoding='utf-8-sig', newline='') as f:
        return f.read()


def write_text(p, text):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


def one(s):
    return ' '.join(str(s or '').split())


def section_of(text, anchor):
    """取 `## <anchor> ...` 到下一个二级标题；找不到返回空。"""
    if not anchor:
        return ''
    body = mem.parse_frontmatter(text)[1]
    lines = body.splitlines()
    at = -1
    for i, line in enumerate(lines):
        if line.startswith('## ') and line[3:].strip().startswith(anchor):
            at = i
            break
    if at < 0:
        return ''
    out = [lines[at]]
    for line in lines[at + 1:]:
        if line.startswith('## '):
            break
        out.append(line)
    return '\n'.join(out).strip()


def excerpt_of(text, anchor):
    """证据摘录：锚点节的前几行；没有锚点就用标题 + 第一段。必须是原文切片。"""
    if anchor:
        sec = section_of(text, anchor)
        if sec:
            lines = [x for x in sec.splitlines() if x.strip()]
            return '\n'.join(lines[:6])[:500]
    title, summary = mem.title_summary(mem.parse_frontmatter(text)[1])
    parts = [x for x in (title, summary) if x]
    return '\n'.join(parts)[:500]


def render_claim(c, evidence_excerpt, date_now):
    tags = ', '.join("'%s'" % t.replace("'", "''") for t in c['tags'])
    fm = [
        '---',
        'id: %s' % c['id'],
        '类型: %s' % c['type'],
        '可信度: %s' % c['confidence'],
        '重要度: %s' % c['importance'],
        '项目: %s' % c['project'],
        '适用范围: %s' % c['scope'],
        '状态: 有效',
        '来源: %s' % one(c['source']),
        '时间: %s' % date_now,
        '复核: %s' % date_now[:10],
        '半衰期: %s' % (0 if c['type'] in ('纪律', '决定') else 365),
        '钉住: %s' % ('true' if c['pinned'] else 'false'),
        '召回权重: 1',
        '编号: %s' % c['code'],
        '证据: %s' % c['old'],
    ]
    if c['anchor']:
        fm.append('证据锚点: %s' % c['anchor'])
    fm += ['tags: [%s]' % tags, '格式: 2', '---', '', '## 记忆', '', one(c['claim']), '', '## 证据', '']
    # 证据摘录整体放进 blockquote：否则摘录自带 `## D1` 会被 section() 当成下一节，
    # 读出来是空证据（2026-11-20 迁移时当场抓到，18 条 D 规则全中）。
    ex = evidence_excerpt or '（原文见下方指针）'
    quoted = '\n'.join(('> ' + ln if ln.strip() else '>') for ln in ex.splitlines())
    body = [quoted, '']
    ptr = '完整原文：`%s`' % c['old'] + ((' → %s' % c['anchor']) if c['anchor'] else '')
    body.append(ptr)
    return '\n'.join(fm + body) + '\n'


def insert_evidence_marker(text, old_id):
    """只改 frontmatter：加 `格式: 证据` / `证据id`；正文一个字节不动。"""
    fm, _body = mem.parse_frontmatter(text)
    if str(fm.get('格式', '')).strip() == '证据':
        return text
    m = list(mem.FM_RE.finditer(text))
    if len(m) < 2:
        raise RuntimeError('没有 frontmatter，不敢乱插')
    head = text[:m[1].start()]
    rest = text[m[1].start():]
    extra = ''
    if '格式:' not in head:
        extra += '\n格式: 证据'
    if '证据id:' not in head:
        extra += '\n证据id: %s' % old_id
    return head.rstrip('\n') + extra + '\n' + rest


def core_text(date_now):
    pinned = [c for c in C if c['pinned']]
    pinned.sort(key=lambda c: (-c['importance'], c['id']))
    manual = '> 产品规则：检索只给 claim，正文只在 memory_read 取；待审批必须由用户点通过，agent 不能自批。'
    lines = []
    used = len(manual)
    for c in pinned:
        line = '- [%s] %s → %s' % (c['code'], one(c['claim']), c['id'])
        if used + len(line) + 1 > 720:
            continue
        lines.append(line)
        used += len(line) + 1
    header = [
        '---', 'id: core', '类型: 核心', '预算: 800', "生成: '%s'" % date_now, '---',
        '# 方寸记忆核心（固定注入，≤800 字）', '',
        '> 自动生成，勿手改。改 `memory/claims/` 里的 `钉住` / `重要度`；完整原文用 memory_read。', '',
    ]
    return '\n'.join(header + [manual, ''] + lines) + '\n'


def backup(date_now):
    stamp = date_now.replace(':', '').replace('-', '').replace('T', '-')[:15]
    dest = os.path.join(MEM_DIR, '.backup', 'v2-migration-' + stamp)
    os.makedirs(dest, exist_ok=True)
    for c in C:
        p = os.path.join(ROOT, c['old'])
        if os.path.exists(p):
            rel = c['old'].replace('/', '__')
            shutil.copy2(p, os.path.join(dest, rel))
    for name in ('core.md', 'core.manual.md', 'index.jsonl'):
        p = os.path.join(MEM_DIR, name)
        if os.path.exists(p):
            shutil.copy2(p, os.path.join(dest, name))
    return dest


def do_apply(force):
    date_now = datetime.datetime.now().astimezone().isoformat(timespec='seconds')
    dest = backup(date_now)
    report = ['# v2 迁移报告', '', '- 时间：%s' % date_now, '- 备份：%s' % os.path.relpath(dest, ROOT), '']
    written = skipped = 0
    for c in C:
        old_abs = os.path.join(ROOT, c['old'])
        if not os.path.exists(old_abs):
            report.append('- ❌ 源文件不存在：%s' % c['old'])
            continue
        text = read_text(old_abs)
        excerpt = excerpt_of(text, c['anchor'])
        claim_path = os.path.join(CLAIMS_DIR, c['id'] + '.md')
        if os.path.exists(claim_path) and not force:
            skipped += 1
        else:
            write_text(claim_path, render_claim(c, excerpt, date_now))
            written += 1
        # 旧文件只加标记（幂等）；证据id 用旧文件自己的 id，不是新 claim 的序号
        try:
            old_fm, _ = mem.parse_frontmatter(text)
            old_id = str(old_fm.get('id') or os.path.basename(c['old']).replace('.md', ''))
            marked = insert_evidence_marker(read_text(old_abs), old_id)
            if marked != text:
                write_text(old_abs, marked)
        except Exception as e:  # noqa: BLE001
            report.append('- ❌ 标记证据失败 %s：%s' % (c['old'], e))
    # 人工补充块：只放产品规则，不重复 D1–D14
    manual_path = os.path.join(MEM_DIR, 'core.manual.md')
    if force or not os.path.exists(manual_path):
        write_text(manual_path,
                   '---\nid: core-manual\n类型: 核心\n预算: 300\n---\n'
                   '> 产品规则：检索只给 claim，正文只在 memory_read 取；'
                   '待审批必须由用户点通过，agent 不能自批。\n')
    # 生成 core
    core_path = os.path.join(MEM_DIR, 'core.md')
    write_text(core_path, core_text(date_now))
    # 重建索引（用同一套 scan/build）
    rows = mem.scan_files()
    idx = mem.build_index(rows)
    write_text(mem.INDEX, ''.join(json.dumps(e, ensure_ascii=False) + '\n' for e in idx))
    report += [
        '- 写入 claim：%d 条；跳过已存在：%d 条' % (written, skipped),
        '- 旧文件标记证据：%d 篇' % len({c['old'] for c in C}),
        '- 索引：%d 条（%s）' % (len(idx), mem.INDEX),
        '- core：%s' % core_path,
        '',
        '## 每条 claim 的去向',
    ]
    for c in C:
        report.append('- `%s` [%s] → `%s` ← `%s`%s' % (
            c['id'], c['code'], one(c['claim']), c['old'],
            (' → ' + c['anchor']) if c['anchor'] else ''))
    write_text(os.path.join(dest, 'report.md'), '\n'.join(report) + '\n')
    print('迁移完成。备份与报告：%s' % dest)
    print('  claim %d 条，索引 %d 条，core %s' % (len(C), len(idx), core_path))
    return 0


def do_check():
    issues = []
    if len(C) != 30:
        issues.append('映射不是 30 条：%d' % len(C))
    ids = set()
    for c in C:
        if c['id'] in ids:
            issues.append('id 重复：%s' % c['id'])
        ids.add(c['id'])
        p = os.path.join(CLAIMS_DIR, c['id'] + '.md')
        if not os.path.exists(p):
            issues.append('claim 文件缺失：%s' % p)
        old = os.path.join(ROOT, c['old'])
        if not os.path.exists(old):
            issues.append('证据文件缺失：%s' % c['old'])
        else:
            fm, _ = mem.parse_frontmatter(read_text(old))
            if str(fm.get('格式', '')).strip() != '证据':
                issues.append('证据未标记：%s' % c['old'])
    rows = mem.scan_files()
    issues += mem.check(rows)
    core_path = os.path.join(MEM_DIR, 'core.md')
    if not os.path.exists(core_path):
        issues.append('core.md 不存在')
    else:
        _fm, body = mem.parse_frontmatter(read_text(core_path))
        if len(body.strip()) > 800:
            issues.append('core.md 超过 800 字：%d' % len(body.strip()))
    for s in issues:
        print('FAIL ' + s)
    print('RESULT 一致' if not issues else 'RESULT %d 处不一致' % len(issues))
    return 1 if issues else 0


def main():
    ap = argparse.ArgumentParser(description='记忆层 v1 → v2 迁移')
    ap.add_argument('--apply', action='store_true', help='真写（默认 dry-run，零写入）')
    ap.add_argument('--check', action='store_true', help='校验迁移结果')
    ap.add_argument('--force', action='store_true', help='覆盖已存在的 claim / core.manual.md')
    a = ap.parse_args()
    if a.check:
        return do_check()
    if a.apply:
        return do_apply(a.force)
    print('dry-run：将把 %d 条 v1 文档拆成 %d 条 claim（旧文件只加 格式:证据，正文不动）' % (
        len({c['old'] for c in C}), len(C)))
    for c in C:
        print('  %-18s [%s] %s' % (c['id'], c['code'], one(c['claim'])))
    print('\n确认无误后加 --apply。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
