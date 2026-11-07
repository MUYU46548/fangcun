#!/usr/bin/env node
/**
 * 版本号只有一个真源：`desktop/package.json` 的 `version`。
 * 其余地方都是**派生**的，这个脚本负责同步与体检。
 *
 * 为什么要有它（2026-11-07）：
 *   盘点工程债 #6「版本号要手工改两处，漏一处就发歪」。实际摸下去是**四处**：
 *     ① `desktop/package.json`        —— 真源
 *     ② `desktop/package-lock.json`   —— 一直停在 0.3.10（没人改过，`npm ci` 会拿它比对）
 *     ③ `skills/manifest.json`        —— 技能清单版本（与 app 同版）
 *     ④ `desktop/src/main/mcp/handler.ts` 的 `serverInfo.version` —— 一直停在 0.3.9，
 *        于是 Hermes 那边看到的 MCP 服务自称 0.3.9，而实装是 0.6.x（"版本对不上"的经典来源）
 *   「记得改」不是工程手段，所以：**改一处，跑一条命令全同步；发版前由 pack.cjs 强制体检**。
 *
 * 用法：
 *   node scripts/version.cjs              # 只体检（等价 check）
 *   node scripts/version.cjs check        # 不一致 → 非零退出，并逐条说清改哪
 *   node scripts/version.cjs set 0.6.7    # 一次写全四处（写后自证：逐处读回比对）
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'desktop', 'package.json')

/** 所有需要跟着真源走的落点；每处都有独立读/写/校验方式 */
const SITES = [
  {
    name: 'desktop/package.json',
    file: 'desktop/package.json',
    kind: 'json',
    keys: ['version'],
    truth: true,
  },
  {
    name: 'desktop/package-lock.json',
    file: 'desktop/package-lock.json',
    kind: 'json',
    // npm 在锁文件里写两份：顶层 version + packages[""].version
    keys: ['version', 'packages[""].version'],
  },
  {
    name: 'skills/manifest.json',
    file: 'skills/manifest.json',
    kind: 'json',
    keys: ['version'],
  },
  {
    name: 'desktop/src/main/mcp/handler.ts',
    file: 'desktop/src/main/mcp/handler.ts',
    kind: 'text',
    // MCP initialize 回的 serverInfo.version —— 客户端（Hermes/DSH）看到的就是它
    pattern: /(serverInfo:\s*\{\s*name:\s*'fangcun',\s*version:\s*')([^']+)(')/,
    label: "serverInfo.version",
  },
]

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf-8'))
}

/** 从某个落点取出它当前版本（任一处读不到就返回 null，由调用方报错） */
function readSite(site) {
  if (site.kind === 'json') {
    const j = readJson(site.file)
    const out = []
    for (const k of site.keys) {
      if (k === 'version') out.push({ key: k, value: String(j.version || '') })
      else if (k === 'packages[""].version') {
        const v = j.packages && j.packages[''] && j.packages[''].version
        out.push({ key: k, value: v == null ? null : String(v) })
      }
    }
    return out
  }
  const t = fs.readFileSync(path.join(ROOT, site.file), 'utf-8')
  const m = t.match(site.pattern)
  return [{ key: site.label, value: m ? m[2] : null }]
}

/** 写某个落点；返回写完读回的值，用来自证 */
function writeSite(site, ver) {
  const abs = path.join(ROOT, site.file)
  if (site.kind === 'json') {
    const j = readJson(site.file)
    for (const k of site.keys) {
      if (k === 'version') j.version = ver
      else if (k === 'packages[""].version') {
        if (j.packages && j.packages['']) j.packages[''].version = ver
      }
    }
    // 保留原文件的结尾换行风格（npm 写的是 2 空格 + 末尾换行）
    const raw = fs.readFileSync(abs, 'utf-8')
    const indent = /^\s*\{\r?\n(\s+)"/.exec(raw)
    const sp = indent ? indent[1].length : 2
    fs.writeFileSync(abs, JSON.stringify(j, null, sp) + (/\r?\n$/.test(raw) ? '\n' : ''), 'utf-8')
  } else {
    const raw = fs.readFileSync(abs, 'utf-8')
    // ⚠ data 里的行尾可能是 CRLF；替换只动引号内那一段，不去重排整个文件
    const out = raw.replace(site.pattern, (_m, a, _old, c) => a + ver + c)
    fs.writeFileSync(abs, out, 'utf-8')
  }
  return readSite(site)
}

function truthVersion() {
  return String(readJson('desktop/package.json').version || '')
}

function cmdCheck() {
  const ver = truthVersion()
  if (!ver) { console.log('✗ desktop/package.json 里没有 version'); process.exit(1) }
  console.log(`真源 desktop/package.json = ${ver}\n`)
  let bad = 0
  for (const site of SITES) {
    let rows
    try { rows = readSite(site) } catch (e) {
      console.log(`✗ ${site.name}：读不了（${e.message}）`)
      bad++
      continue
    }
    for (const r of rows) {
      if (r.value === ver) console.log(`✓ ${site.name}  ${r.key} = ${r.value}`)
      else {
        console.log(`✗ ${site.name}  ${r.key} = ${r.value === null ? '<没有这个字段>' : r.value}  ← 应为 ${ver}`)
        bad++
      }
    }
  }
  if (bad) {
    console.log(`\n${bad} 处不一致。修：node scripts/version.cjs set ${ver}（或 set <新版本>）`)
    process.exit(1)
  }
  console.log('\n四处一致。')
}

function cmdSet(ver) {
  if (!/^\d+\.\d+\.\d+$/.test(ver)) { console.log(`✗ 版本号要写成 x.y.z：${ver}`); process.exit(1) }
  const before = truthVersion()
  console.log(`版本 ${before} → ${ver}\n`)
  let bad = 0
  for (const site of SITES) {
    const back = writeSite(site, ver)
    const okAll = back.every((r) => r.value === ver)
    if (okAll) console.log(`✓ ${site.name}  ${back.map((r) => r.key).join(' / ')}`)
    else { console.log(`✗ ${site.name} 写后读回不符：${JSON.stringify(back)}`); bad++ }
  }
  if (bad) { console.log(`\n${bad} 处没写成，别发版`); process.exit(1) }
  console.log(`\n完成。下一步：cd desktop && npm run build（版本变了要重打，跑 pack.cjs 会自动体检）`)
}

const cmd = (process.argv[2] || 'check').toLowerCase()
if (cmd === 'set') {
  const v = String(process.argv[3] || '').trim()
  if (!v) { console.log('用法: node scripts/version.cjs set <x.y.z>'); process.exit(1) }
  cmdSet(v)
} else if (cmd === 'check') cmdCheck()
else { console.log('用法: node scripts/version.cjs [check | set <x.y.z>]'); process.exit(1) }
