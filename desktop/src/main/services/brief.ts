/**
 * 开工简报（2026-11-16 · 治病①「没有记忆」的入口）
 *
 * ## 这个服务治的是什么
 *
 * 卡 `最高优先级ai-施工的五种病…` 的病①：
 *   每个 agent 隔天开工都从 `git log` + `开发日志.md` 重新拼上下文，
 *   而 `开发日志.md` 实测 **297 KB** —— 塞进去也没用（他自己说
 *   「累计几千 M 上下文，依然什么有用的东西都做不出来」）。
 *
 * ## 为什么是"调 Python 算"，不是"在这边重算一遍"
 *
 * 口径必须只有**一处**。`scripts/brief.py` 是唯一真源（四格口径都在那里，
 * 且能被人一条条复核）；这里只负责"跑它 + 把结果交回去"。
 * 在 TS 里重写一遍 = 两份口径迟早分叉（本仓已踩过：层厚度 / 未完成清单都是这个病）。
 *
 * ## 纪律
 *
 * · **只读**：脚本本身只读，这里也不写任何文件；
 * · **不编**：脚本算不出就写「算不出，因为 X」，这里原样透传，不补默认值；
 * · **透传超预算**：>8KB 时把 overBudget 一起交回去 —— 界面要能说"这次塞太多了"。
 */
import { execFile } from 'node:child_process'
import path from 'node:path'

const ROOT = path.resolve(process.env.FC_REPO_ROOT || path.join(__dirname, '..', '..', '..', '..'))
const SCRIPT = path.join(ROOT, 'scripts', 'brief.py')

export interface BriefResult {
  ok: boolean
  project?: string
  markdown?: string
  bytes?: number
  budget?: number
  overBudget?: boolean
  raw?: any
  error?: string
}

/**
 * 跑 `scripts/brief.py --json`。
 *
 * ⚠ 这里**不设小 buffer**：简报上限 8KB，但 JSON 还带原始字段，
 * 留 4MB 余量（2026-11-16 在 `judge-harvested` 上吃过默认 1MB 爆掉的亏）。
 */
export function buildBrief(project: string): Promise<BriefResult> {
  return new Promise((resolve) => {
    const p = String(project || '').trim()
    if (!p) { resolve({ ok: false, error: '没给项目 id' }); return }
    execFile(
      'python',
      ['-X', 'utf8', SCRIPT, '--project', p],
      {
        cwd: ROOT,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      },
      (err, stdout, stderr) => {
        if (err) {
          // ⚠ 不许把"脚本没跑起来"翻成"没有活" —— 那是本仓最忌讳的"界面说假话"
          const msg = (stderr || err.message || '').toString().trim()
          resolve({ ok: false, error: '简报脚本没跑起来：' + (msg.slice(0, 400) || '未知原因') })
          return
        }
        const md = String(stdout || '')
        // 末尾那行「体积 N / 8192 字节（OK）」由脚本打印，解析出来给界面用
        const m = md.match(/体积 (\d+) \/ (\d+) 字节（(OK|\*\*超预算\*\*)）/)
        resolve({
          ok: true,
          project: p,
          markdown: md,
          bytes: m ? Number(m[1]) : md.length,
          budget: m ? Number(m[2]) : 8 * 1024,
          overBudget: m ? /超预算/.test(m[3]) : false,
        })
      },
    )
  })
}

/** 落一份到 `docs/开工简报-<project>.md`（可选；给人看、也能进 git 对比） */
export async function writeBriefFile(project: string): Promise<BriefResult & { path?: string }> {
  const r = await buildBrief(project)
  if (!r.ok) return r
  const fs = await import('node:fs')
  const out = path.join(ROOT, 'docs', `开工简报-${project}.md`)
  try {
    fs.writeFileSync(out, r.markdown || '', 'utf-8')
    return { ...r, path: out }
  } catch (e: any) {
    return { ...r, ok: false, error: '写文件失败：' + (e?.message || String(e)) }
  }
}
