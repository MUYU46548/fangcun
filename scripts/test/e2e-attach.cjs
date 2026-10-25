/**
 * 日志附件：粘贴图片 + 新建态先选后挂（2026-10-25 暮雨第 4 / 7 条）
 *
 * 两条病根：
 *   ① 「日志创建后才能挂附件」—— 附件目录是 `_attachments/<logId>/`，没 id 只能禁用按钮，
 *      用户为了加张图要建两次日志；
 *   ② 「附件不能粘贴图片」—— 全仓 `grep paste` 曾经 0 命中。
 *
 * 本测试钉住主进程侧的守门逻辑（`addAttachmentsFromData`）：
 *   data URL 解析 / mime 白名单 / 按内容定扩展名 / 20MB 上限 / 文件名清洗 /
 *   重名递增 / 日志不存在拒绝 / 部分失败逐条记账 —— 全是"渲染层送来任意字节"的边界。
 * 另加源码守卫，钉住渲染层的接线（粘贴监听、新建态不解禁、保存后 flush）。
 *
 * 运行：node scripts/test/e2e-attach.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const TEST_ROOT = path.join(os.tmpdir(), 'fc-attach-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT

const DIST = path.resolve(__dirname, '../../desktop/dist/main')
const REPO = path.resolve(__dirname, '../..')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

// 1x1 透明 PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const pngUrl = (b64 = PNG_B64) => 'data:image/png;base64,' + b64

function main() {
  console.log('== 日志附件（粘贴 / 先选后挂）测试 ==')
  console.log('root:', TEST_ROOT)
  fs.mkdirSync(path.join(TEST_ROOT, 'task-data'), { recursive: true })
  fs.writeFileSync(path.join(TEST_ROOT, 'registry.yaml'),
    'members:\n  - 暮雨\nprojects:\n  - id: demo\n    name: 演示\n', 'utf-8')

  const data = require(path.join(DIST, 'data', 'index.js'))
  const logs = require(path.join(DIST, 'services', 'logs.js'))
  data.setDataDir(TEST_ROOT)

  const mkLog = (title) => {
    const r = logs.createLog(title, 'demo', '正文')
    if (!r.ok) throw new Error('建日志失败: ' + r.error)
    return r.data
  }
  const attachDirOf = (logId) => path.join(TEST_ROOT, 'docs', '执行日志', '_attachments', logId)

  // ── ① 正常路径：data URL → 真文件 + frontmatter 相对路径 ──────────────
  const log1 = mkLog('粘贴图片验收一')
  {
    const r = logs.addAttachmentsFromData(log1.id, [{ name: '截图.png', dataUrl: pngUrl() }])
    check('① 返回 ok 且计数为 1', r.ok === true && r.added === 1, JSON.stringify(r).slice(0, 160))
    const files = fs.existsSync(attachDirOf(log1.id)) ? fs.readdirSync(attachDirOf(log1.id)) : []
    check('① 文件真的落进 _attachments/<logId>/', files.length === 1, JSON.stringify(files))
    check('① 落盘内容与 base64 解码后字节一致',
      files.length === 1 && Buffer.compare(fs.readFileSync(path.join(attachDirOf(log1.id), files[0])), Buffer.from(PNG_B64, 'base64')) === 0)
    const entry = logs.getLog(log1.id)
    const rel = (entry?.attachments || [])[0] || ''
    check('① frontmatter 记了相对路径', !!rel, JSON.stringify(entry?.attachments))
    check('① 相对路径是正斜杠（反斜杠会在另一个解析器里变转义符）', rel.includes('/') && !rel.includes('\\'), rel)
    check('① 相对路径能被 resolveAttachment 认回真文件', !!logs.resolveAttachment(rel), rel)
  }

  // ── ② 扩展名按 mime 推导，不信客户端给的名字 ─────────────────────────
  {
    const r = logs.addAttachmentsFromData(log1.id, [{ name: '伪装成可执行.exe', dataUrl: pngUrl() }])
    const files = fs.readdirSync(attachDirOf(log1.id))
    check('② 客户端叫 .exe 也按内容存成 .png', files.some((f) => f.endsWith('.png')) && !files.some((f) => f.endsWith('.exe')),
      JSON.stringify(files))
    check('② 返回 ok', r.ok === true, JSON.stringify(r).slice(0, 120))
  }

  // ── ③ 文件名清洗 + 重名递增 ──────────────────────────────────────────
  {
    const before = fs.readdirSync(attachDirOf(log1.id)).length
    const r = logs.addAttachmentsFromData(log1.id, [
      { name: '../../逃逸.png', dataUrl: pngUrl() },
      { name: '有,逗号;和[括号].png', dataUrl: pngUrl() },
      { name: '同名.png', dataUrl: pngUrl() },
      { name: '同名.png', dataUrl: pngUrl() },
    ])
    const files = fs.readdirSync(attachDirOf(log1.id))
    check('③ 四个都挂上了', r.ok === true && r.added === 4, JSON.stringify(r).slice(0, 160))
    check('③ 路径穿越前缀被剥掉（落到 logId 目录里，没有上层目录）',
      !fs.existsSync(path.join(TEST_ROOT, 'docs', '执行日志', '逃逸.png')))
    check('③ 逗号/方括号被替换（Python 侧按逗号切内联列表，带逗号会被劈开）',
      !files.some((f) => f.includes(',') || f.includes(';')), JSON.stringify(files))
    check('③ 同名自动递增（同名.png / 同名 (1).png）',
      files.some((f) => f.startsWith('同名')) && files.filter((f) => f.startsWith('同名')).length === 2,
      JSON.stringify(files.filter((f) => f.startsWith('同名'))))
    check('③ 净增 4 个文件', files.length === before + 4, `${before} → ${files.length}`)
  }

  // ── ④ 拒绝路径（反例自证） ───────────────────────────────────────────
  {
    const log2 = mkLog('粘贴图片验收二')
    const dir2 = attachDirOf(log2.id)

    const cases = [
      ['不收的类型（application/x-msdownload = exe）', 'data:application/x-msdownload;base64,SGVsbG8=', /不收/],
      ['不是 data URL', 'https://example.com/a.png', /不是合法的 data URL/],
      ['缺 base64 段', 'data:image/png,abc', /不是合法的 data URL/],
      ['空内容', 'data:image/png;base64,', /不是合法的 data URL|内容是空的/],
    ]
    for (const [name, url, re] of cases) {
      const r = logs.addAttachmentsFromData(log2.id, [{ name: 'x', dataUrl: url }])
      check(`④ 拒绝：${name}`, r.ok === false && re.test(String(r.error)), String(r.error))
    }
    // ⚠ 这条必须排在"接收"用例之前：下面会真落 4 个文件，之后再判"目录空"就永远假红
    check('④ 被拒的都没落盘（此刻目录里 0 个文件）',
      !fs.existsSync(dir2) || fs.readdirSync(dir2).length === 0,
      JSON.stringify(fs.existsSync(dir2) ? fs.readdirSync(dir2) : []))
    // 拖文件进来会用到这些类型（2026-10-25 第 4 条追加），一条条钉住扩展名推导
    const docs = [
      ['data:text/plain;base64,SGVsbG8=', '.txt', '纯文本'],
      ['data:application/pdf;base64,SGVsbG8=', '.pdf', 'PDF'],
      ['data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,SGVsbG8=', '.docx', 'docx'],
      ['data:application/zip;base64,SGVsbG8=', '.zip', 'zip'],
    ]
    for (const [url, ext, label] of docs) {
      const r = logs.addAttachmentsFromData(log2.id, [{ name: '拖进来的' + label, dataUrl: url }])
      check(`④ 接收：${label} → ${ext}`, r.ok === true, JSON.stringify(r).slice(0, 160))
    }
    // 拒绝文案必须给出退路 —— 拖了个不认识的文件时，"请用＋添加文件"比"不支持"有用得多
    const refused = logs.addAttachmentsFromData(log2.id, [{ name: 'x.exe', dataUrl: 'data:application/x-msdownload;base64,SGVsbG8=' }])
    check('④ 拒绝文案指了退路（＋ 添加文件）', /添加文件/.test(String(refused.error)), String(refused.error).slice(0, 200))

    const missing = logs.addAttachmentsFromData('log_不存在的id', [{ name: 'x', dataUrl: pngUrl() }])
    check('④ 日志不存在 → 拒绝（不造孤立目录）',
      missing.ok === false && /日志不存在/.test(String(missing.error)), String(missing.error))

    const empty = logs.addAttachmentsFromData(log2.id, [])
    check('④ 空数组 → 拒绝', empty.ok === false, JSON.stringify(empty))
  }

  // ── ⑤ 20MB 上限 ─────────────────────────────────────────────────────
  {
    const log3 = mkLog('粘贴图片验收三')
    const big = Buffer.alloc(20 * 1024 * 1024 + 1024, 0x41)   // 20MB + 1KB
    const r = logs.addAttachmentsFromData(log3.id, [{ name: '超大.png', dataUrl: 'data:image/png;base64,' + big.toString('base64') }])
    check('⑤ 超过 20MB 被拒', r.ok === false && /超过 20MB/.test(String(r.error)), String(r.error).slice(0, 160))
    check('⑤ 拒绝后没有留下半截文件',
      !fs.existsSync(attachDirOf(log3.id)) || fs.readdirSync(attachDirOf(log3.id)).length === 0)
  }

  // ── ⑥ 部分失败：好的照挂，坏的逐条记账 ──────────────────────────────
  {
    const log4 = mkLog('粘贴图片验收四')
    const r = logs.addAttachmentsFromData(log4.id, [
      { name: '好的.png', dataUrl: pngUrl() },
      { name: '坏的.exe', dataUrl: 'data:application/x-msdownload;base64,SGVsbG8=' },
    ])
    check('⑥ 整批算成功（不因一条坏的全军覆没）', r.ok === true && r.added === 1, JSON.stringify(r).slice(0, 200))
    check('⑥ skipped 里点名了坏的那条', Array.isArray(r.skipped) && r.skipped.length === 1, JSON.stringify(r.skipped))
    check('⑥ 只挂上好的那一个', (logs.getLog(log4.id)?.attachments || []).length === 1)
  }

  // ── ⑦ 源码守卫：渲染层接线 ──────────────────────────────────────────
  {
    const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf-8').replace(/\r\n/g, '\n')
    const app = read('desktop/src/renderer/App.vue')
    const preload = read('desktop/src/preload/index.ts')
    const ipcSrc = read('desktop/src/main/ipc.ts')

    check('⑦ 弹窗挂了 @paste 监听', /@paste="onLogPaste\(\$event\)"/.test(app))
    check('⑦ onLogPaste 只拦图片（粘文字放行）',
      /dt\.files/.test(app) && /\^image\\\//.test(app) && /ev\.preventDefault\(\)/.test(app))
    check('⑦ 新建态附件按钮不再被 disabled 锁死',
      !/:disabled="!logEdit_\.id"/.test(app),
      '又出现了 :disabled="!logEdit_.id" = 又回到"先创建再挂"')
    check('⑦ 新建态走「只选不挂」（logsPickFiles）', /logsPickFiles\(\)/.test(app))
    check('⑦ 保存创建分支真的 flush 待挂附件', /await flushPendingAttach\(newLogId\)/.test(app))
    check('⑦ 拿不到 id 时必须明说附件没挂上（不许静默丢）',
      /没拿到它的 id —— 刚选的附件没挂上/.test(app))
    check('⑦ 新建/编辑入口都清空上一轮待挂',
      (app.match(/resetPendingAttach\(\)/g) || []).length >= 3,
      String((app.match(/resetPendingAttach\(\)/g) || []).length))

    check('⑦ preload 暴露 logsPickFiles', /logsPickFiles:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('logs:pickFiles'\)/.test(preload))
    // ⚠ 不用 `A.*B` 跨行窗口（本机 CRLF + 换行会假红）：先切段再比，见 MEMORY 的教训
    const attachDataHead = (() => {
      const i = preload.indexOf('logsAttachData:')
      return i < 0 ? '' : preload.slice(i, i + 220)
    })()
    check('⑦ preload 暴露 logsAttachData', attachDataHead.includes("'logs:attachData'"),
      attachDataHead.slice(0, 120))
    check('⑦ preload 的 attachFiles 支持传 sources', /logsAttachFiles:\s*\(logId: string, sources\?: string\[\]\)/.test(preload))
    check('⑦ IPC 注册了 logs:pickFiles', /guardedHandle\('logs:pickFiles'/.test(ipcSrc))
    check('⑦ IPC 注册了 logs:attachData', /guardedHandle\('logs:attachData'/.test(ipcSrc))
    check('⑦ IPC attachFiles 传了 sources 就不再弹框',
      /if \(!paths\.length\) \{\n\s+const picked = await pickFilesForAttach/.test(ipcSrc))

    // ── ⑧ 拖文件 + 待挂附件不许静默丢（2026-10-25 第 4 条追加）──────────────
    //    「用户不一定开最大化」→ 拖拽要做；「待挂清单直接清空有害」→ 必须二次确认。
    check('⑧ 弹窗挂了 drop 监听', /@drop\.prevent="onLogAttachDrop\(\$event\)"/.test(app))
    check('⑧ 拖动经过时整块高亮，且写明「松手 = 挂附件」',
      /:class="\{ 'drop-on': logAttachDragOver \}"/.test(app) && /松手 = 挂到这条日志的附件/.test(app))
    check('⑧ dragenter/dragleave 用计数（否则划过子元素高亮会抖）',
      /logAttachDragDepth\+\+/.test(app) && /Math\.max\(0, logAttachDragDepth - 1\)/.test(app))
    check('⑧ octet-stream 按扩展名补 mime（拖进来的 png 不会被白名单误拒）',
      /application\\\/octet-stream/.test(app) && /MIME_BY_EXT/.test(app))
    check('⑧ 待挂附件算进「脏」→ 点 × 一定弹确认',
      /if \(logPendingCount\.value > 0\) return true/.test(app))
    check('⑧ 确认条里点名「待挂的 N 个附件」（用户要知道丢的是什么）',
      app.includes('待挂的 ${logPendingCount.value} 个附件'))

    // 关窗出清路径里才允许清空待挂（切片判据，不用字符窗口 —— 窗口断言会假红）
    const closeNow = (() => {
      const i = app.indexOf('function closeLogNow')
      const j = app.indexOf('function discardLogEdit')
      return i >= 0 && j > i ? app.slice(i, j) : ''
    })()
    check('⑧ 「丢弃并关闭 / 保存成功」这条出清路径里清待挂', closeNow.includes('resetPendingAttach()'))

    // 附件没挂上必须不关窗 + 待挂回填（否则就是"看起来成功了"）
    const createBranch = (() => {
      const i = app.indexOf('const newLogId')
      return i < 0 ? '' : app.slice(i, i + 900)
    })()
    check('⑧ 附件没挂上 → 保留弹窗（return，不往下关窗）', createBranch.includes('if (!attached)'))
    check('⑧ 新建后把 id 写回表单（重试走更新分支，不会再建一条重复卡）',
      createBranch.includes('e.id = newLogId'))
    const flushBody = (() => {
      const i = app.indexOf('async function flushPendingAttach')
      const j = app.indexOf('async function attachAdd(')
      return i >= 0 && j > i ? app.slice(i, j) : ''
    })()
    check('⑧ 挂失败的放回待挂清单（keepPaths / keepData 回填）',
      flushBody.includes('logPendingPaths.value = keepPaths') && flushBody.includes('logPendingData.value = keepData'))
    check('⑧ 更新分支也会 flush（用户重试真的能走通）', app.includes('更新分支也要挂一次'))
  }

  console.log(`\n== 结果：${pass}/${fail} ==`)
  if (fail) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f) }
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }) } catch {}
  process.exit(fail ? 1 : 0)
}

main()
