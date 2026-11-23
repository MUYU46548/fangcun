#!/usr/bin/env node
/**
 * 项目结构图断言（2026-10-29 修正版）
 *
 * 背景（必须留在文件头，防止有人又把它改回"画一张分层图"）：
 *   第一版是错的 —— 拿“项目 → 在途 → 已完成 → 执行日志”画了张分层图，还叫它"项目结构图"。
 *   暮雨原话：“你是不是根本他妈不知道 archify 的结构图产物长什么样？这结构图有问题啊。”
 *   archify 的产物是**一份可交互的架构图 HTML**；方寸自绘架构图是目标（卡 task-20261030-002），
 *   但这一版**还没有**那个能力，所以只负责打开仓库里已有的产物。
 *
 * 现在的判据只有四条：
 *   ① 认得出哪些文件名是 archify 产物（架构图 / architecture / archify + .html）；
 *   ② 多份时挑**最新**那份（按 mtime），不挑字母序；
 *   ③ 只在该项目仓库的 docs/ 里找（不扫全仓、不猜别的目录）；
 *   ④ 找不到就说清**怎么生成**，不许静默、不许退化成"我给你画一张"。
 */

const fs = require('fs')
const { mkTmp, mkTmpPath } = require('./_tmp.cjs')
const os = require('os')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'main', 'services', 'projectDiagram.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

if (!fs.existsSync(ART)) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ' + ART)
  console.log('RESULT 0 / 1')
  process.exit(1)
}
const P = require(ART)

console.log('== ① 认得出 archify 产物 ==')
check('“架构图-方寸-20261029.html”认', P.isArchifyArtifactName('架构图-方寸-20261029.html'))
check('“architecture.html”认', P.isArchifyArtifactName('architecture.html'))
check('“tegula-architecture.html”认', P.isArchifyArtifactName('tegula-architecture.html'))
check('“archify-fangcun.html”认', P.isArchifyArtifactName('archify-fangcun.html'))
check('日报 html 不认', !P.isArchifyArtifactName('日报-20261029.html'))
check('架构图 .docx 不认（必须是 HTML，archify 交付物形态）', !P.isArchifyArtifactName('架构图.docx'))
check('README.md 不认', !P.isArchifyArtifactName('README.md'))

console.log('\n== ② 多份时挑最新 ==')
{
  const hit = P.pickNewestArtifact([
    { path: '/r/docs/architecture-old.html', mtime: 1000 },
    { path: '/r/docs/架构图-新.html', mtime: 3000 },
    { path: '/r/docs/日报.html', mtime: 5000 },
  ])
  check('★ 按 mtime 挑最新（不是字母序、也不是第一个）', hit && hit.path === '/r/docs/架构图-新.html', JSON.stringify(hit))
  check('  不匹配的文件名直接排除', !hit || hit.path.indexOf('日报') < 0)
  check('  空清单 → null（不许编一个路径出来）', P.pickNewestArtifact([]) === null)
}

console.log('\n== ③ 只在 repo/docs 里找 ==')
{
  const tmp = mkTmp('arch-find-')
  const docs = path.join(tmp, 'docs')
  fs.mkdirSync(docs, { recursive: true })
  fs.writeFileSync(path.join(docs, 'architecture-a.html'), 'a')
  fs.writeFileSync(path.join(docs, '架构图-b.html'), 'b')
  const old = new Date(Date.now() - 60000)
  fs.utimesSync(path.join(docs, '架构图-b.html'), old, old)
  fs.mkdirSync(path.join(docs, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(docs, 'node_modules', 'architecture-x.html'), 'x')
  fs.writeFileSync(path.join(tmp, '架构图-root.html'), 'r')

  const hit = P.findProjectArchitectureArtifact(tmp)
  check('★★ 找到最新那份（架构图-b 反而更旧 → 应选 architecture-a）',
    hit && /architecture-a\.html$/.test(hit.path), JSON.stringify(hit))
  check('  rel 是相对仓库根的路径（界面要给人看）', hit && hit.rel === 'docs/architecture-a.html', hit && hit.rel)
  check('  不扫 node_modules（那里面的同名文件不算产物）', hit && hit.path.indexOf('node_modules') < 0)
  check('  不碰仓库根的散落文件（只看 docs/）', hit && hit.path.indexOf('架构图-root') < 0)

  const empty = mkTmp('arch-empty-')
  check('  没有 docs/ 且根目录没有产物 → null', P.findProjectArchitectureArtifact(empty) === null)
  check('  路径不存在 → null（不抛）', P.findProjectArchitectureArtifact(path.join(empty, 'nope')) === null)
}

console.log('\n== ④ 找不到要说清怎么生成 ==')
{
  const r0 = P.findArtifactForProject('')
  check('空 id → 明确报错', r0.ok === false && /没给项目 id/.test(r0.error), r0.error)

  const r1 = P.findArtifactForProject('项目-根本不存在')
  check('★ registry 里没有 → 明说没有这个项目', r1.ok === false && /registry 里没有/.test(r1.error), r1.error)
}

console.log('\n== ⑤ 真实仓库：方寸自己那张图找得到 ==')
{
  const data = require(path.join(REPO, 'desktop', 'dist', 'main', 'data', 'index.js'))
  data.setDataDir(REPO)
  const r = P.findArtifactForProject('fangcun-base')
  check('★★ fangcun-base 能找到 archify 产物（2026-10-29 生成的那张）',
    r.ok === true && /架构图-方寸/.test(String(r.hit && r.hit.path)),
    JSON.stringify({ ok: r.ok, err: r.error, hit: r.hit && r.hit.rel }))
  check('  产物文件真的在盘上', r.ok === true && fs.existsSync(r.hit.path))
}

console.log('\n== ⑦ 打开副本的稳定性补丁（卡 ff9476ff）==')
{
  // 120 帧实测结论（2026-11-21 无头 Edge，125% / 150% 缩放）：
  //   · 原图：clientWidth 1497↔1512、SVG 宽 1097.4↔1114.4、scrollHeight 772↔778，3 帧一循环；
  //   · 只加 scrollbar-gutter：clientWidth 稳定，但 SVG 仍抖（header 换行 → 高度 → 宽度反馈环）；
  //   · 再加固定 --archify-reader-width：120 帧全部 0 变化。
  // 这里钉的是"补丁真的注入了"，几何判据由 scripts/test 的 120 帧探针单独复核。
  const base = 'file:///E:/repo/docs/'
  const html = '<!DOCTYPE html><html><head><title>x</title></head><body>chart</body></html>'
  const patched = P.patchArtifactHtml(html, base)
  check('★★ 注入 <base>（副本在临时目录，相对资源仍从原目录取）',
    patched.indexOf('<base href="file:///E:/repo/docs/">') >= 0)
  check('★★ 注入 scrollbar-gutter（滚动条进出不再改内容宽度）',
    /html\{scrollbar-gutter:stable;overflow-y:scroll\}/.test(patched))
  check('★★ 钉死 --archify-reader-width（剪断 宽度↔换行↔高度 反馈环）',
    /--archify-reader-width:1440px !important/.test(patched))
  check('  样式带 id，便于幂等判据', patched.indexOf('id="fangcun-stable-open"') >= 0)
  check('  注入点在 </head> 之前（先于页面自身的脚本/样式）',
    patched.indexOf('fangcun-stable-open') < patched.indexOf('</head>'))
  const twice = P.patchArtifactHtml(patched, 'file:///other/')
  check('★ 幂等：重复打开不会叠第二层补丁',
    (twice.match(/id="fangcun-stable-open"/g) || []).length === 1 && twice === patched)
  const noHead = P.patchArtifactHtml('<div>bare</div>', base)
  check('  没有 <head> 也能注入（不因结构不规范而静默不补）',
    noHead.indexOf('fangcun-stable-open') >= 0 && noHead.indexOf('bare') > 0)
  const escaped = P.patchArtifactHtml(html, 'file:///E:/a&b/')
  check('  base href 做属性转义（& → &amp;）', escaped.indexOf('file:///E:/a&amp;b/') >= 0)
}

console.log('\n== ⑧ 真写一份副本：只读源文件、副本带补丁 ==')
{
  const tmp = mkTmp('arch-stable-')
  const srcDir = path.join(tmp, 'repo', 'docs')
  fs.mkdirSync(srcDir, { recursive: true })
  const src = path.join(srcDir, '架构图-测试.html')
  const original = '<!DOCTYPE html><html><head><title>t</title></head><body>原图</body></html>'
  fs.writeFileSync(src, original, 'utf8')
  const before = fs.statSync(src)

  const a = P.prepareStableArtifactCopy(src, path.join(tmp, 'out'))
  check('★ 副本生成成功', a.ok === true && !!a.path, a.error)
  check('★ 副本不在项目仓库里（写在临时目录）', a.ok && a.path.indexOf(path.join(tmp, 'out')) === 0, a.path)
  check('★ 源文件逐字节没变（方寸对 repo 只读）', fs.readFileSync(src, 'utf8') === original)
  check('  源文件 mtime 没变', fs.statSync(src).mtimeMs === before.mtimeMs)
  const copy = a.ok ? fs.readFileSync(a.path, 'utf8') : ''
  check('  副本里面有稳定样式', copy.indexOf('fangcun-stable-open') >= 0)
  check('  副本的 base 指回原目录（相对资源不丢）',
    copy.indexOf('file:///' + srcDir.replace(/\\/g, '/').replace(/^\//, '')) >= 0)
  const b = P.prepareStableArtifactCopy(src, path.join(tmp, 'out'))
  check('★ 同一张图反复打开 → 同一份副本路径（不堆垃圾）', a.ok && b.ok && a.path === b.path)
  check('  重写后仍只有一层补丁', (fs.readFileSync(b.path, 'utf8').match(/fangcun-stable-open/g) || []).length === 1)
  const other = path.join(srcDir, 'architecture-b.html')
  fs.writeFileSync(other, original)
  const c = P.prepareStableArtifactCopy(other, path.join(tmp, 'out'))
  check('  不同产物 → 不同副本目录', c.ok && c.path !== a.path)
}

console.log('\n== ⑨ 打开链路真的走稳定副本（不是又开原图）==')
{
  const ipc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'ipc.ts'), 'utf-8')
  check('★★ project:diagram 生成并打开副本', /prepareStableArtifactCopy\(r\.hit\.path\)/.test(ipc) &&
    /shell\.openPath\(target\)/.test(ipc))
  check('★★ 不再直接打开仓库原件', !/shell\.openPath\(r\.hit\.path\)/.test(ipc))
  check('  副本失败时如实标 stabilized:false（不假装补过）', /stabilized: stable\.ok === true/.test(ipc))
  const svc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'services', 'projectDiagram.ts'), 'utf-8')
  check('  两行稳定样式都在唯一真源里（测试别另抄一份）',
    /scrollbar-gutter:stable/.test(svc) && /--archify-reader-width:1440px !important/.test(svc))
}

console.log('\n== ⑥ 源码守卫：不许再"自己画一张" ==')
{
  const svc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'services', 'projectDiagram.ts'), 'utf-8')
  check('★★ 主进程侧不再有 buildProjectDiagram / 分层图生成（那就是编）',
    !/buildProjectDiagram/.test(svc) && !/lanes:/.test(svc))
  const oldShared = path.join(REPO, 'desktop', 'src', 'shared', 'projectDiagram.ts')
  check('★★ 那个"用任务数据画图"的纯函数文件已删除', !fs.existsSync(oldShared))
  const app = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'renderer', 'App.vue'), 'utf-8')
  // 2026-11-21：项目页已拆到 views/ProjectsView.vue（渲染层拆分第二批），
  // 入口按钮的文案在那份文件里，不再在 App.vue —— 判据不变，只跟真身走。
  const projectsView = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'renderer', 'views', 'ProjectsView.vue'), 'utf-8')
  check('  项目卡按钮文案不再承诺"出一张图"', !/出一张结构图/.test(app) && !/出一张结构图/.test(projectsView))
  // 2026-10-30（暮雨第 2 条）：世界地图 Emoji 让入口看不懂，而且画出来的根本不是架构图。
  check('★★ 入口不再叫“结构图”、也不再带 🗺 Emoji（它打开的是架构图）',
    !/🗺\s*结构图/.test(projectsView) && /架构图<\/button>/.test(projectsView))
  check('  找不到时的提示不许再说“方寸不自己画架构图”（自绘是目标，卡 20261030-002）',
    !/方寸不自己画架构图/.test(fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'services', 'projectDiagram.ts'), 'utf-8')))
}

console.log(`\nRESULT ${pass} / ${fail ? pass + fail : pass}` + (fail ? `  (${fail} 条失败)` : ''))
if (fail) { console.log('\n失败项：'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1) }
