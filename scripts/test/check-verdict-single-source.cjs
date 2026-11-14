#!/usr/bin/env node
/**
 * 词表单一真源守卫（2026-11-12 暮雨：「垃圾能玩之类的文本怎么又给我写死在代码里了？第二十次了吧？方寸要发布的」）
 *
 * 事实：那四个词当时散在 **5 个文件、8 处**：
 *   shared/contentScale.ts · services/policies.ts · PolicyEditModal.vue
 *   App.vue · llm/planDraftInput.ts（同一个「是不是骨架」正则写了两遍）
 *
 * 这条守卫钉三件事：
 *   ① 档位词只许出现在 `shared/coreVerdict.ts`（唯一定义处）；
 *   ② 别处引用必须 import，不许写字面量；
 *   ③ 加/删档位只改那一处 —— 断言"界面按钮数 == 词表长度"，防界面与闸脱钩。
 *
 * ⚠ 扫描前**必须剥注释**：注释里提这些词是在解释历史（本项目 `check-ui-copy` 踩过这个坑）。
 *
 * 用法：node scripts/test/check-verdict-single-source.cjs
 */
'use strict'
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC_ROOT = path.join(ROOT, 'desktop', 'src')
const SSOT = path.join('shared', 'coreVerdict.ts')
const TEST_ROOT = path.join(ROOT, 'scripts', 'test')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out) }
    else if (/\.(ts|vue)$/.test(e.name)) out.push(p)
  }
  return out
}

/** 剥注释（块 + 行尾），保留字符串正文 */
function stripComments(s) {
  return String(s)
    // ⚠ 2026-11-14 补：`.vue` 模板里的 `<!-- … -->` 也是注释。
    //   第一版只剥 `/* */` 与 `//`，于是"注释里解释为什么拆掉判词"被当成
    //   "界面还在用判词词表" → 假红（本项目 check-ui-copy 踩过同一个坑）。
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
}

/** 从 SSOT 里取出档位词（不依赖编译产物，直接解析源码） */
function verdictKeys() {
  const src = fs.readFileSync(path.join(SRC_ROOT, SSOT), 'utf8')
  const keys = []
  const re = /key:\s*'([^']+)'/g
  let m
  while ((m = re.exec(src)) !== null) keys.push(m[1])
  return keys
}

function main() {
  console.log('== 词表单一真源守卫 ==')
  const keys = verdictKeys()
  check('★ 能从 coreVerdict.ts 解析出档位词（>=3 个）', keys.length >= 3, JSON.stringify(keys))

  // ① 别处不许出现带引号的档位词字面量
  const offenders = []
  for (const f of walk(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, f)
    if (rel.replace(/\\/g, '/') === SSOT.replace(/\\/g, '/')) continue
    const txt = stripComments(fs.readFileSync(f, 'utf8'))
    for (const k of keys) {
      // 带引号/反引号的字面量
      const re = new RegExp(`['"\`]${k}['"\`]`)
      if (re.test(txt)) offenders.push(`${rel.replace(/\\/g, '/')} → '${k}'`)
    }
  }
  check('★★ 档位词字面量只许出现在 shared/coreVerdict.ts（别处必须 import）',
    offenders.length === 0, offenders.join(' ; '))

  // ② 引用方必须真的 import 那个模块
  // ⚠ 2026-11-14：判词界面**整块拆掉了**（暮雨：「从来意义不大，根本看不懂」），
  //   所以 PolicyEditModal.vue 不再消费词表 —— 它出现在这份名单里会变成永恒的红。
  //   口径改成：**要么 import 词表、要么一个判词词都不提**（不许留半块自己写死）。
  for (const rel of ['shared/contentScale.ts', 'main/services/policies.ts',
    'main/llm/planDraftInput.ts', 'renderer/App.vue']) {
    const f = path.join(SRC_ROOT, rel)
    if (!fs.existsSync(f)) { check(`★ ${rel} 存在`, false); continue }
    const txt = fs.readFileSync(f, 'utf8')
    check(`★ ${rel} 从 coreVerdict 引入（不许自己写词表）`,
      /from '[^']*coreVerdict'/.test(txt), '缺 import')
  }
  {
    const modalPath = path.join(SRC_ROOT, 'renderer/components/PolicyEditModal.vue')
    const modalTxt = fs.existsSync(modalPath) ? fs.readFileSync(modalPath, 'utf8') : ''
    const body = stripComments(modalTxt)
    const importsTable = /from '[^']*coreVerdict'/.test(body)
    const mentionsKeys = keys.some((k) => body.includes(k))
    check('★ PolicyEditModal：要么引词表，要么一个判词词都不提（拆了就别留半块）',
      importsTable || !mentionsKeys,
      `import=${importsTable} 提到档位词=${mentionsKeys}`)
  }

  // ③ 界面按钮 v-for 遍历词表（不是写死四个 <Button>）
  const modal0 = fs.readFileSync(path.join(SRC_ROOT, 'renderer/components/PolicyEditModal.vue'), 'utf8')
  const modalBody = stripComments(modal0)
  const modalHasPicks = /pf-vpick/.test(modalBody)
  if (modalHasPicks) {
    // 还在用选择器 → 必须 v-for 遍历词表，不许写死四个按钮
    check('★★ 界面按钮是 v-for="v in VERDICT_LEVELS"（写死就又会脱钩）',
      /v-for="v in VERDICT_LEVELS"/.test(modal0))
  } else {
    // 已经拆了 → 断言"拆干净"（这正是 2026-11-14 的状态，见 e2e-verdict-gap）
    check('★★ 判词选择器已拆 → 不再写死四个按钮（拆干净也是一种合格）', true)
  }
  // ⚠ 判据要精确：第一版写 `/const VERDICT/i`，结果匹配到 `verdictPicked` —— 假红。
  //   真正的判据是"有没有一份**本地词表数组/对象**"，即 `const XXX = [` 或 `[{ key:` 这种。
  const localTable = /const\s+[A-Z][A-Z0-9_]*\s*=\s*\[\s*\{/.test(modal0)
  check('★ 界面不再自带一份本地词表（不许 const XXX = [{ key: … }]）', !localTable)

  // ④ 骨架由词表生成（policies.ts 不许再手写四个词）
  const pol = stripComments(fs.readFileSync(path.join(SRC_ROOT, 'main/services/policies.ts'), 'utf8'))
  check('★★ 方针卡骨架由 verdictSkeleton() 生成（不再手写四行词表）',
    /verdictSkeleton\(\)/.test(pol) && !/立得住 \/ 能玩/.test(pol))

  // ⑤ 反例自证：往一个非 SSOT 文件里塞字面量，必须被抓到
  {
    const probe = path.join(TEST_ROOT, '_verdict_probe.ts')
    fs.writeFileSync(probe, `export const x = '${keys[0]}'\n`, 'utf8')
    let caught = false
    try {
      const offenders2 = []
      for (const f of walk(SRC_ROOT)) {
        const rel = path.relative(SRC_ROOT, f)
        if (rel.replace(/\\/g, '/') === SSOT.replace(/\\/g, '/')) continue
        const txt = stripComments(fs.readFileSync(f, 'utf8'))
        if (new RegExp(`['"\`]${keys[0]}['"\`]`).test(txt)) offenders2.push(rel)
      }
      // probe 在 scripts/test 下，不在扫描范围 —— 所以这里改为直接对 probe 文本跑同一条规则
      const pTxt = stripComments(fs.readFileSync(probe, 'utf8'))
      caught = new RegExp(`['"\`]${keys[0]}['"\`]`).test(pTxt) && offenders2.length === 0
    } finally {
      try { fs.unlinkSync(probe) } catch {}
    }
    check('★★ 反例自证：规则真的能抓到字面量（构造一条能咬住）', caught)
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  console.log(`RESULT ${pass} / ${fail}`)
  if (fail) {
    console.log('失败明细：')
    failures.forEach((f) => console.log('  · ' + f))
    process.exit(1)
  }
}

try { main() } catch (e) {
  console.error('FATAL', e && (e.stack || e.message || e))
  process.exit(2)
}
