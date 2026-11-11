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

/**
 * **集合级**核对（2026-11-11 第二次血账后补）。
 *
 * 为什么 `verifyCarried` 不够：它只核对「我打算搬的那几个」—— 如果我挑的时候就没挑全
 * （`readdirSync` 那一刻少了几份，或者被锁/被杀软吃掉），`carried` 本身是短的，
 * 逐份核对会**全绿**，旧目录照样被删 → 兄弟文件连尸体都找不到。
 * 0.6.17–0.6.22 六个安装包就是这么没的（`pkg` 里只剩一个 0.6.22 的 `.blockmap`）。
 *
 * 判据改成集合关系：**打包前 OUT 里有的安装包/块图，打包后要么还在、要么是“本轮有意清掉的”**。
 * @param {string[]} before 打包前 OUT 的顶层文件名
 * @param {string[]} after  搬运+落新产物之后 OUT 的顶层文件名
 * @param {string[]} [pruned] 本轮**有意清理**的文件名（保留策略挑出来的，见 pickRetention）
 */
function carryAudit(before, after, pruned) {
  const intentional = new Set((Array.isArray(pruned) ? pruned : []).map((n) => String(n)))
  const b = (Array.isArray(before) ? before : []).filter((n) => INSTALLER_RE.test(String(n)))
  const a = new Set((Array.isArray(after) ? after : []).map((n) => String(n)))
  const lost = b.filter((n) => !a.has(String(n)) && !intentional.has(String(n)))
  return { ok: lost.length === 0, lost, before: b.length, after: a.size, pruned: intentional.size }
}

/**
 * 保留策略（2026-11-11 暮雨：「禁止永不清理。我自己也会经常删旧版安装包」）。
 *
 * 口径：按版本号排序，**只留最近 keep 个安装包**（连同它们的 `.blockmap` + `latest.yml`），
 * 更早的 exe 与它们的块图进 `prune`；没有对应 exe 的孤儿块图也一并清掉。
 * 为什么按版本而不是按 mtime：mtime 会被复制/解压打乱，版本号才是真顺序。
 *
 * @param {string[]} names OUT 里的文件名
 * @param {number} keep 保留几个安装包（默认 3；0 = 全清旧版）
 */
function pickRetention(names, keep = 3) {
  const n = Number.isFinite(Number(keep)) ? Math.max(0, Math.floor(Number(keep))) : 3
  const list = (Array.isArray(names) ? names : []).map((x) => String(x))
  const exes = list
    .filter((x) => /^Fangcun-Setup\.\d+\.\d+\.\d+\.exe$/.test(x))
    .map((x) => ({ name: x, ver: x.replace(/^Fangcun-Setup\./, '').replace(/\.exe$/, '') }))
    .sort((a, b) => {
      const pa = a.ver.split('.').map((v) => parseInt(v, 10) || 0)
      const pb = b.ver.split('.').map((v) => parseInt(v, 10) || 0)
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0)
        if (d) return d
      }
      return 0
    })
  const keptExes = exes.slice(Math.max(0, exes.length - n)).map((x) => x.name)
  const keptVers = new Set(keptExes.map((x) => x.replace(/^Fangcun-Setup\./, '').replace(/\.exe$/, '')))
  const keepNames = new Set(keptExes)
  const prune = []
  for (const name of list) {
    if (/^Fangcun-Setup\.\d+\.\d+\.\d+\.exe\.blockmap$/.test(name)) {
      const ver = name.replace(/^Fangcun-Setup\./, '').replace(/\.exe\.blockmap$/, '')
      if (keptVers.has(ver)) keepNames.add(name)
      else prune.push(name)          // 老版本的块图，或孤儿块图
      continue
    }
    if (/^Fangcun-Setup\.\d+\.\d+\.\d+\.exe$/.test(name) && !keepNames.has(name)) prune.push(name)
  }
  return { keep: [...keepNames], prune, keptVersions: [...keptVers] }
}

module.exports = { INSTALLER_RE, pickCarried, verifyCarried, carryAudit, pickRetention }

