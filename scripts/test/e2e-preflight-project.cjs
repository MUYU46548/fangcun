#!/usr/bin/env node
/**
 * 项目开工前安全闸（2026-11-21）
 *
 * 判据（防的是两类真实事故）：
 *   ① 工作区脏（别人的未提交改动）→ 默认拒绝；--allow-dirty 才放行，但结果要如实说脏；
 *   ② 不是 git / detached HEAD / 路径不在自己的 git root 内 → 拒绝。
 * 只读：跑完仓库状态不变。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { mkTmp } = require('./_tmp.cjs')
const { preflight } = require('../preflight-project.cjs')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}  → ${detail}`) }
}
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim()

const TMP = mkTmp('preflight-')
const REPO = path.join(TMP, 'repo')
fs.mkdirSync(REPO, { recursive: true })
git(REPO, ['init', '-q'])
git(REPO, ['config', 'user.email', 'e2e@example.invalid'])
git(REPO, ['config', 'user.name', 'e2e'])
fs.writeFileSync(path.join(REPO, 'a.md'), 'a\n')
git(REPO, ['add', '.'])
git(REPO, ['commit', '-qm', 'init'])

const clean = preflight(REPO)
check('★★ 干净仓库 → 可开工', clean.ok === true && !!clean.gitRoot && clean.branch !== 'HEAD', JSON.stringify(clean))
check('★ 干净时的理由说清楚', /干净/.test(clean.reason), clean.reason)

fs.writeFileSync(path.join(REPO, 'b.md'), 'b\n')
const dirty = preflight(REPO)
check('★★ 有未提交改动 → 默认拒绝（防把别人的活一起提交/覆盖）',
  dirty.ok === false && dirty.dirty.length === 1 && /未提交/.test(dirty.reason), JSON.stringify(dirty))
const dirtyOk = preflight(REPO, { allowDirty: true })
check('★ --allow-dirty 才放行，且仍如实报脏', dirtyOk.ok === true && /1 个未提交/.test(dirtyOk.reason), dirtyOk.reason)

const notGit = preflight(TMP)
check('★★ 不是 git 仓库 → 拒绝', notGit.ok === false && /不是 git/.test(notGit.reason), notGit.reason)
const missing = preflight(path.join(TMP, 'nope'))
check('★ 路径不存在 → 拒绝', missing.ok === false && /路径不存在/.test(missing.reason), missing.reason)

fs.unlinkSync(path.join(REPO, 'b.md'))
git(REPO, ['checkout', '-q', '--detach'])
const detached = preflight(REPO)
check('★★ detached HEAD → 拒绝（避免在无分支上改）', detached.ok === false && /detached/.test(detached.reason), detached.reason)

// 只读：跑这么多遍，文件内容一个字节没变
const before = fs.readFileSync(path.join(REPO, 'a.md'), 'utf-8')
preflight(REPO); preflight(REPO, { allowDirty: true })
check('★ 只读：检查前后项目文件不变', fs.readFileSync(path.join(REPO, 'a.md'), 'utf-8') === before)

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) { console.log('失败明细：'); failures.forEach((f) => console.log('  · ' + f)) }
process.exit(fail === 0 ? 0 : 1)
