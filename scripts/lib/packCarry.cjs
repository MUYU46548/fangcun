/**
 * 打包搬运的纯逻辑（2026-11-11）
 *
 * 为什么单独一个文件：这两件事（挑哪些旧安装包要带走、带过去以后**核对真带到了**）
 * 是纯文件名/文件系统判断，不该埋在 `pack.cjs` 的三百行流程里 —— 埋在里面的后果已经发生过：
 * 0.6.19 那次打包日志写着「已保留 16 个旧版安装包」，可**下一次打包时只剩 6 个**，
 * 0.6.11–0.6.16 六个历史安装包就这样没了（它们从没发布过 GitHub，本地是唯一副本）。
 * 所以现在把“挑”和“核对”都抽出来，并单独上测试。
 */

/** 历史安装包：`Fangcun-Setup.<x.y.z>.exe` 与其 `.blockmap`（`pkg` 永不清理的那批） */
const INSTALLER_RE = /^Fangcun-Setup\.\d+\.\d+\.\d+\.exe(\.blockmap)?$/

/**
 * 挑出要带到新产物目录里的旧安装包：只留安装包/块图，**排除当前版本**（它刚要生成）。
 * @param {string[]} names 旧产物目录里的文件名
 * @param {string} ver 当前版本号，如 `0.6.20`
 */
function pickCarried(names, ver) {
  const v = String(ver || '').trim()
  return (Array.isArray(names) ? names : [])
    .filter((n) => INSTALLER_RE.test(String(n)))
    .filter((n) => !v || !String(n).includes(v))
    .sort()
}

/**
 * 带过去以后**核对真的在了**（同名同字节数）。
 * 返回 { ok, missing:[{name, why}] } —— 调用方必须据此决定“能不能删旧目录”：
 * 只要有一个没带过去，旧目录就必须留着（宁可多占一份，也不能像 0.6.19 那样静默丢）。
 */
function verifyCarried(fs, path, oldDir, outDir, carried) {
  const missing = []
  for (const name of Array.isArray(carried) ? carried : []) {
    const src = path.join(oldDir, name)
    const dst = path.join(outDir, name)
    try {
      const a = fs.statSync(src)
      const b = fs.statSync(dst)
      if (a.size !== b.size) missing.push({ name, why: `大小不一致（旧 ${a.size} / 新 ${b.size}）` })
    } catch (e) {
      missing.push({ name, why: `核对读不到：${e && e.code ? e.code : 'unknown'}` })
    }
  }
  return { ok: missing.length === 0, missing }
}

module.exports = { INSTALLER_RE, pickCarried, verifyCarried }
