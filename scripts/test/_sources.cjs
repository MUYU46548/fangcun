/**
 * 渲染层源码聚合（2026-10-23 加，随 App.vue 拆分而来）
 *
 * 为什么需要：App.vue 从 15877 行拆成「App.vue + 11 个视图组件 + 3 个 composable」之后，
 * **一批「源码扫描型」断言集体变红** —— 它们问的是「日志页有排序下拉吗」「进行中开关真挂在
 * 模板上吗」，而代码只是搬了家。断言没坏、产品也没坏，红的是「写死的路径」。
 *
 * 这件事会随每一次拆分重复发生，所以不在每个测试里各补一句 `再读一遍 views/`，
 * 统一从这里取：**扫全部渲染层源码**。
 *
 * ⚠ 扫全量比只扫 App.vue **更严**，不会放松任何判据：
 *   「App.vue 不许出现 X」现在等于「渲染层任何文件都不许出现 X」。
 *
 * ⚠ 唯一要当心的是**跨文件拼接出的假相邻**：若某条判据用 `a[\s\S]{0,N}b` 这类
 *   「必须挨着」的模式，拼接处可能把两个不相干的文件拼成一段。所以文件之间插一行分隔注释，
 *   把相邻关系打断；真正需要「同一段内相邻」的判据请用 perFile() 逐文件跑。
 */
const fs = require('fs')
const path = require('path')

const RENDERER = path.resolve(__dirname, '../../desktop/src/renderer')

/** 渲染层所有源码文件（按路径排序，结果稳定） */
function fileList() {
  const out = []
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (/\.(vue|ts)$/.test(ent.name)) out.push(p)
    }
  }
  walk(RENDERER)
  return out
}

/** 每个文件的源码（归一成 LF —— 本机 core.autocrlf=true，字符数类判据会被 \r 影响） */
function perFile() {
  return fileList().map((p) => ({
    file: path.relative(RENDERER, p).replace(/\\/g, '/'),
    text: fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n'),
  }))
}

/** 全部渲染层源码拼成一份（文件之间带分隔标记，避免假相邻） */
function rendererSource() {
  return perFile()
    .map(({ file, text }) => `\n/* ===== ${file} ===== */\n${text}`)
    .join('\n')
}

/**
 * 只需「界面层」时（App.vue + views/*.vue）用这个，**不含** shared/ 与 *.ts。
 *
 * 为什么还要细分：有些判据是「界面**不许自己算**，必须调共享纯函数」——
 * 比如「不许内联 86400000」。这类判据扫全量会把 `calendar.ts` 里的 `const MS_DAY = 86400000`
 * 也算进去，而那一行**正是**它该在的地方（判据的本意是"界面层别手搓天数"）。
 */
function viewSource() {
  return perFile()
    .filter(({ file }) => file === 'App.vue' || file.startsWith('views/'))
    .map(({ file, text }) => `\n/* ===== ${file} ===== */\n${text}`)
    .join('\n')
}

/**
 * 抹注释（沿用 e2e-self-sync / e2e-timefmt 的口径：块注释整段抹、行注释抹到行尾，
 * 但保留 `http://` 这类"冒号后的 //"）。
 */
function stripComments(src) {
  return String(src)
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

module.exports = {
  RENDERER,
  fileList,
  perFile,
  rendererSource,
  viewSource,
  rendererNoComment: () => stripComments(rendererSource()),
  stripComments,
}
