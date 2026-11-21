#!/usr/bin/env node
/**
 * 项目开工前安全闸（2026-11-21 · 绒花墨坊插件开工前）
 *
 * 为什么要有：接下来会有真实项目（小说库、插件仓库）被 agent 改。最常见的两种事故：
 *   ① 工作区里还有别人的未提交改动，agent 直接 `git add -A` / 覆盖，把别人的活带走；
 *   ② 改错仓库/改到数据目录，事后才发现。
 *
 * 本脚本只做**只读检查**，不写任何文件：
 *   · 路径存在、是目录、是真的 git 仓库；
 *   · 工作区是否干净（脏了默认拒绝，列出前 20 个文件；确认要一起改才加 --allow-dirty）；
 *   · 当前分支 / HEAD / 是否 detached；
 *   · 是否在项目自己的 git root 内（不让 ../ 跑到别的仓）。
 *
 * 用法：
 *   node scripts/preflight-project.cjs <路径>
 *   node scripts/preflight-project.cjs <路径> --allow-dirty
 *   node scripts/preflight-project.cjs <路径> --json
 *
 * 退出码：0 = 可开工；1 = 不安全（有未提交改动 / 不是 git / 路径不对）。
 * 注意：这是“开工前闸”，不是“写完后的测试”；它不替代备份、不替代 code review。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim()
}

function preflight(inputPath, opts = {}) {
  const allowDirty = !!opts.allowDirty
  const abs = path.resolve(String(inputPath || ''))
  const out = {
    ok: false,
    path: abs,
    gitRoot: '',
    branch: '',
    head: '',
    dirty: [],
    reason: '',
  }
  if (!fs.existsSync(abs)) { out.reason = '路径不存在：' + abs; return out }
  if (!fs.statSync(abs).isDirectory()) { out.reason = '不是目录：' + abs; return out }
  let root = ''
  try {
    root = git(abs, ['rev-parse', '--show-toplevel'])
  } catch (e) {
    out.reason = '不是 git 仓库（或 git 不可用）：' + abs
    return out
  }
  const realRoot = fs.realpathSync(root)
  const realAbs = fs.realpathSync(abs)
  const inside = realAbs === realRoot || realAbs.startsWith(realRoot + path.sep)
  if (!inside) { out.reason = `路径不在自己的 git root 内：${realAbs} 不在 ${realRoot}`; return out }
  out.gitRoot = realRoot
  try { out.branch = git(abs, ['rev-parse', '--abbrev-ref', 'HEAD']) } catch { out.branch = '(读不到)' }
  try { out.head = git(abs, ['rev-parse', '--short', 'HEAD']) } catch { out.head = '' }
  let status = ''
  try { status = git(abs, ['status', '--porcelain']) } catch { status = '' }
  out.dirty = status.split(/\r?\n/).filter(Boolean)
  if (out.dirty.length && !allowDirty) {
    out.reason = `工作区有 ${out.dirty.length} 个未提交改动 —— 先提交/备份，或确认要一起改再加 --allow-dirty`
    return out
  }
  if (out.branch === 'HEAD') {
    out.reason = '当前是 detached HEAD（不在任何分支上）—— 换回分支或新建分支再开工'
    return out
  }
  out.ok = true
  out.reason = out.dirty.length
    ? `可开工，但工作区有 ${out.dirty.length} 个未提交改动（已用 --allow-dirty 放行）`
    : '可开工：git 工作区干净'
  return out
}

function main() {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const allowDirty = args.includes('--allow-dirty')
  const input = args.find((a) => !a.startsWith('--'))
  if (!input) {
    console.log('用法：node scripts/preflight-project.cjs <项目路径> [--allow-dirty] [--json]')
    process.exit(1)
  }
  const r = preflight(input, { allowDirty })
  if (json) {
    console.log(JSON.stringify(r, null, 2))
  } else {
    console.log((r.ok ? '✅ ' : '⛔ ') + r.reason)
    if (r.gitRoot) {
      console.log(`仓库：${r.gitRoot}`)
      console.log(`分支：${r.branch}${r.head ? ' @ ' + r.head : ''}`)
    }
    if (r.dirty.length) {
      console.log(`未提交（前 20）：`)
      for (const line of r.dirty.slice(0, 20)) console.log('  ' + line)
      if (r.dirty.length > 20) console.log(`  …还有 ${r.dirty.length - 20} 个`)
    }
    if (!r.ok) console.log('先处理上面的问题，再让 agent 开工。')
  }
  process.exit(r.ok ? 0 : 1)
}

if (require.main === module) main()
module.exports = { preflight }
