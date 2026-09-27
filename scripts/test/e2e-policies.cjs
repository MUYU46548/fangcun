/**
 * 回归：方针卡未知节保留 + 项目事实注入链路（2026-09-25 六字段派工单）
 *
 * 背景：savePolicy 原本从 interface 四字段整体重建 policies/<id>.md ——
 *   手写加的「项目事实」「结构地图」节会在 UI 保存时被静默吃掉。
 *   同时 Python 侧 read_policy/_build_prompt 新增「项目事实」读取与任务书注入。
 *
 * 断言：
 *  A 保留 —— savePolicy 后未知节原样存活；已知四节内容更新正常；无节时零残留
 *  B 注入 —— core.py read_policy 读到「项目事实」；_build_prompt 含项目事实节+
 *     开工纪律（先搜后写/抽象档位/兜底报备）；无方针卡时任务书无噪音节
 *  C 接线 —— TS/Python 两侧节名约定一致（「## 项目事实」）
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')
const Module = require('module')

// ── 1. electron 桩注入（必须在业务模块之前；getDataDir 走 app.getPath） ──
const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const REPO = path.resolve(__dirname, '../..')
const PY = process.env.FC_PY || 'python'

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; return }
  fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
}

function main() {
  // ══ A. TS 侧：未知节保留（直接测 dist 编译产物） ════════════════════
  const DIST_SVC = path.join(REPO, 'desktop/dist/main/services/policies.js')
  const hasDist = fs.existsSync(DIST_SVC)
  check('A0 dist 产物存在（先 npm run build）', hasDist, DIST_SVC)
  if (hasDist) {
    const TEST_ROOT = path.join(os.tmpdir(), 'fc-policies-' + Date.now())
    process.env.FC_TEST_USERDATA = TEST_ROOT
    const pol = require(DIST_SVC)
    // getDataDir 走 app.getPath 探测链，测试环境须显式 initPaths（桩的 userData 已指 TEST_ROOT）
    const data = require(path.join(REPO, 'desktop/dist/main/data'))
    data.initPaths()
    // 显式 setDataDir 需要目录里有 registry/task-data——直接造一个，隔离真实数据
    fs.mkdirSync(path.join(TEST_ROOT, 'task-data'), { recursive: true })
    fs.writeFileSync(path.join(TEST_ROOT, 'registry.yaml'), 'members: {}\nprojects: []\n', 'utf-8')
    data.setDataDir(TEST_ROOT)

    // A1 未知节存活：先手写一张含「项目事实」节的方针卡
    const pid = 'testproj'
    const dir = path.join(TEST_ROOT, 'policies')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, pid + '.md'), [
      `# 项目方针：${pid}`, ``, `> 更新: 2026-01-01T00:00:00.000Z`,
      `> 用途: 派活时随任务书下发，或直接粘给 agent 作为项目背景。`, ``,
      `## 使命`, `旧使命`, ``,
      `## 项目事实`, `- 异常统一在 guarded-ipc 处理，业务代码禁止 try-catch 吞`,
      `- 参数校验只在入口层`, ``,
      `## 方针边界`, `不得改坏数据`, ``,
    ].join('\n'), 'utf-8')

    // A2 通过 savePolicy 改四字段（模拟 UI 保存）
    pol.savePolicy({ projectId: pid, mission: '新使命', goal: '新目标', scenario: '自用', boundary: '红线不动', updatedAt: '' })

    const after = fs.readFileSync(path.join(dir, pid + '.md'), 'utf-8')
    check('A2 未知节「项目事实」在 UI 保存后存活', after.includes('## 项目事实') && after.includes('guarded-ipc'),
      after.slice(0, 200))
    check('A3 已知四节内容更新生效', after.includes('新使命') && after.includes('新目标'))
    // A4 未知节未知标题也保留（现场笔记 —— 手写追加的任意节）
    fs.writeFileSync(path.join(dir, pid + '.md'),
      after + '\n## 现场笔记\n- 手写的东西\n', 'utf-8')
    pol.savePolicy({ projectId: pid, mission: '再改', goal: '', scenario: '', boundary: '', updatedAt: '' })
    const a2 = fs.readFileSync(path.join(dir, pid + '.md'), 'utf-8')
    check('A4 未知节未知标题也保留（现场笔记）',
      a2.includes('## 现场笔记') && a2.includes('手写的东西') && a2.includes('## 项目事实'), a2.slice(-300))
    // A4b（029）：结构地图骨架已在卡上（A2 那次保存落的）→ 不得再追加第二份
    check('A4b 已有「结构地图」节不被重复追加（节标题恰好 1 个）',
      (a2.match(/^##\s*结构地图\s*$/gm) || []).length === 1,
      String((a2.match(/^##\s*结构地图\s*$/gm) || []).length))
    // A4c（029）：agent 起草好的地图内容（骨架被换成真内容）在 UI 保存后必须存活
    check('A4c 起草好的结构地图内容不被 UI 保存吃掉', (() => {
      const cur = fs.readFileSync(path.join(dir, pid + '.md'), 'utf-8')
      const filled = cur
        .replace('（待填 —— 填完写日期；烂地图比没地图危险，因为读者不知道它烂）', '2026-09-27')
        .replace('- 模块清单：待填（每模块一句话职责）', '- `core.py` 数据层')
      fs.writeFileSync(path.join(dir, pid + '.md'), filled, 'utf-8')
      pol.savePolicy({ projectId: pid, mission: '再改一次', goal: '', scenario: '', boundary: '', updatedAt: '' })
      const a3 = fs.readFileSync(path.join(dir, pid + '.md'), 'utf-8')
      return a3.includes('- `core.py` 数据层') && a3.includes('最后核实')
        && (a3.match(/^##\s*结构地图\s*$/gm) || []).length === 1
    })())

    // A5（029 改）：全新骨架**必须带**「结构地图」节标题 —— 缺口可见（与章程缺口同一机制）；
    //   同时「项目事实」仍不得凭空冒出（它只走保留，不靠生成）。
    pol.savePolicy({ projectId: 'fresh-proj', mission: 'm', goal: 'g', scenario: 's', boundary: 'b', updatedAt: '' })
    const fresh = fs.readFileSync(path.join(dir, 'fresh-proj.md'), 'utf-8')
    check('A5 全新骨架带「结构地图」节标题 + 最后核实占位（缺口可见）',
      fresh.includes('## 结构地图') && /最后核实/.test(fresh), fresh.slice(-200))
    check('A5b 骨架不带「项目事实」（只保留、不生成）', !fresh.includes('## 项目事实'))
    check('A5c 再保存一次仍只有一个「结构地图」节', (() => {
      pol.savePolicy({ projectId: 'fresh-proj', mission: 'm2', goal: 'g', scenario: 's', boundary: 'b', updatedAt: '' })
      const f2 = fs.readFileSync(path.join(dir, 'fresh-proj.md'), 'utf-8')
      return (f2.match(/^##\s*结构地图\s*$/gm) || []).length === 1
    })())
    check('A6 getPolicy 读四节不受影响', pol.getPolicy(pid)?.mission === '再改一次')
    // A7（029 顺手修的真 bug）：原 section() 的 `$` 在 m 标志下匹配每个换行前 → 多行节只返回第一行，
    //   编辑框回读被截断、再保存就把余下内容写没了。这条断言在旧实现上必红。
    check('A7 多行小节读取不再被截断（section 修复）', (() => {
      pol.savePolicy({ projectId: 'ml-proj', mission: '第一行\n第二行\n第三行', goal: 'g', scenario: '', boundary: '', updatedAt: '' })
      const got = pol.getPolicy('ml-proj')
      return !!got && got.mission === '第一行\n第二行\n第三行'
    })(), JSON.stringify(pol.getPolicy('ml-proj')?.mission))
    // A8（029）：结构地图节可被读出（渲染层用它判断「缺口」），且多行内容完整
    check('A8 getPolicy 读到「结构地图」节（多行完整）', (() => {
      const g = pol.getPolicy(pid)
      const s = String(g?.structureMap || '')
      return s.includes('core.py') && s.includes('最后核实：2026-09-27') && s.includes('主数据流')
    })(), JSON.stringify(pol.getPolicy(pid)?.structureMap))
  }

  // ══ B. Python 侧：read_policy + _build_prompt 注入 ══════════════════
  const pyCode = `
import sys, os, json
sys.path.insert(0, ${JSON.stringify(REPO.replace(/\\/g, '/'))})
os.environ['FC_TEST_USERDATA'] = ''  # 不覆盖——直接用真实 DATA_DIR 读
from tegula import core

# B1: read_policy 读「项目事实」节（真实 bianjishi 卡先补一节到临时文件测试）
import tempfile, shutil
# 用临时项目 id 隔离：直接测 section 逻辑（造一张临时卡在真实 policies 目录，测完删）
pid = 'zz-e2e-test-proj'
fn = os.path.join(core.DATA_DIR, 'policies', pid + '.md')
os.makedirs(os.path.dirname(fn), exist_ok=True)
with open(fn, 'w', encoding='utf-8') as f:
    f.write('# 项目方针：' + pid + '\\n\\n## 使命\\n测试使命\\n\\n## 项目事实\\n- 异常统一处理点：guarded-ipc\\n- 配置缺失直接报错\\n\\n## 结构地图\\n> 最后核实：2026-09-27\\n\\n- 模块清单：MAP_BODY_MARKER\\n\\n## 方针边界\\n测试边界\\n')
try:
    pol = core.read_policy(pid)
    assert pol and pol.get('项目事实') and 'guarded-ipc' in pol['项目事实'], 'read_policy 未读到项目事实: %r' % (pol,)
    assert pol.get('使命') == '测试使命'
    assert pol.get('结构地图') and 'MAP_BODY_MARKER' in pol['结构地图'], 'read_policy 未读到结构地图: %r' % (pol,)
    print('B1_OK')
    # B2: _build_prompt 注入（伪任务 dict）
    d = {'项目': [pid], '标题': '注入测试', '方案': ['- [ ] 步骤一'], '资源': {}}
    prompt = core._build_prompt(d, 'task-x', 'E:/tmp/repo', 'python done', 'E:/tmp/card.md')
    assert '## 项目事实' in prompt and 'guarded-ipc' in prompt, '任务书未注入项目事实'
    assert '## 开工纪律' in prompt and '先搜后写' in prompt, '任务书缺开工纪律'
    assert '报备' in prompt, '任务书缺兜底报备'
    assert '数据流五句话' in prompt, '任务书缺「数据流五句话」纪律（029）'
    print('B2_OK')
    # B4（029）：结构地图只指路、不整段内联（否则每份任务书灌一屏地图）
    assert '结构地图' in prompt, '任务书未指路方针卡的结构地图'
    assert 'MAP_BODY_MARKER' not in prompt, '结构地图被整段内联进任务书（应只指路）'
    print('B4_OK')
    # B3: 无方针卡项目 → 任务书无噪音节
    d2 = {'项目': ['no-such-proj-xyz'], '标题': '无卡测试', '方案': ['- [ ] 步骤'], '资源': {}}
    p2 = core._build_prompt(d2, 'task-y', 'E:/tmp/repo', 'python done', 'E:/tmp/card.md')
    assert '## 项目事实' not in p2, '无卡却出现项目事实节'
    assert '结构地图' not in p2, '无卡却出现结构地图指路'
    assert '## 开工纪律' in p2, '开工纪律应固定下发'
    print('B3_OK')
finally:
    if os.path.exists(fn): os.remove(fn)
`
  try {
    const out = execFileSync(PY, ['-c', pyCode], { encoding: 'utf-8', cwd: REPO })
    check('B1 read_policy 读到项目事实/结构地图节', out.includes('B1_OK'), out.slice(-300))
    check('B2 任务书注入项目事实+开工纪律（含数据流五句话）', out.includes('B2_OK'))
    check('B3 无方针卡时零噪音（无项目事实/无结构地图指路）', out.includes('B3_OK'))
    check('B4 结构地图只指路不整段内联', out.includes('B4_OK'))
  } catch (e) {
    check('B 组 Python 注入链路', false, String(e.message).slice(0, 300))
  }

  // ══ C. 两侧节名约定一致（源码静态守卫，防漂移） ═════════════════════
  const pySrc = fs.readFileSync(path.join(REPO, 'tegula/core.py'), 'utf-8')
  const tsSrc = fs.readFileSync(path.join(REPO, 'desktop/src/main/services/policies.ts'), 'utf-8')
  check('C1 Python 侧读「项目事实」', pySrc.includes('section("项目事实")') || pySrc.includes("section('项目事实')"))
  check('C2 TS 侧保留列表不含「项目事实」（它走保留而非重建）',
    tsSrc.includes("known.includes(h.name)") && !tsSrc.includes("'项目事实'"))
  check('C3 TS 侧结构地图同样受保护（通用保留，非白名单）', tsSrc.includes('preserveSections'))
  // C4/C5（029）：结构地图两侧都认得 + 骨架必须带节标题（缺口可见）
  check('C4 TS 侧会读「结构地图」节（section(\'结构地图\')）', /section\('结构地图'\)/.test(tsSrc))
  check('C5 骨架生成器带「结构地图」节标题（缺口可见）',
    tsSrc.includes('SKELETON_STRUCTURE_MAP') && tsSrc.includes("'## 结构地图'"))
  check('C6 Python 侧会读「结构地图」节', /section\("结构地图"\)/.test(pySrc))
  check('C7 任务书含「数据流五句话」纪律（卡 029 配套）', pySrc.includes('数据流五句话'))

  console.log(`\n${fail === 0 ? 'RESULT PASS' : 'RESULT FAIL'} — ${pass}/${pass + fail}`)
  if (failures.length) { console.log('失败项:'); failures.forEach(f => console.log('  ✗ ' + f)) }
  process.exit(fail === 0 ? 0 : 1)
}

main()
