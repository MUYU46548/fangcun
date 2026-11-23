/**
 * 架构图生成 · 提示词与草稿回收（2026-11-22 · 卡 80f271dd）
 *
 * 上一轮的缺口：D4 拍板「全走 DSH」只落地成「不调模型」——方寸不生成，也没派给 DSH。
 * 这里的口径是：
 *   · **方寸出证据 + 出任务书**（本文件）；
 *   · **DSH 会话执行**（另一条链路：`main/services/archDispatch.ts` 写派单文件）；
 *   · 回来的草稿**逐条过证据审计**（`shared/archGenerate.ts`），不过就带着原因重派（≤2 次）；
 *   · 仍不过 → 扫描图，并明标「这是扫描图，不是生成图」。
 *
 * 为什么把提示词抽出来：它是**契约**（模型照着写、审计照着判）。放在 main 里既没法被
 * Node 直接断言，也容易和审计规则分叉。纯字符串函数，零依赖。
 */
import type { ArchScanFacts } from './archGraph'
import { allowedEvidence } from './archGenerate'

/** 派单草稿卡的标题前缀；回收时靠它 + nonce 认卡 */
export const ARCH_DRAFT_TITLE_PREFIX = '[架构图草稿]'

/** 证据条数上限（与原实现一致：清单太长，模型总想多画，输出必然撑爆） */
export const ARCH_EVIDENCE_LIMIT = 80

/** 模型要遵守的硬规矩（审计就是按这些判的） */
export const ARCH_SYSTEM_PROMPT = [
  '你是架构图生成器。你只按证据画图，不按印象画图。',
  '',
  '硬规矩（违反即被审计拒收）：',
  '1) 节点 id 只能写成 dir:<目录> / entry:<文件> / deps:<包名>，且必须在给的清单里；',
  '2) 每条连线必须给 evidence，形状是 import:<源目录>-><目标目录>，且必须在给的清单里；',
  '3) 不许发明目录、模块、包名、端口；清单里没有的东西一个都不许出现；',
  '4) 不许输出数字（文件数 / 条数）；数字一律由系统从扫描事实填；',
  '5) 只输出 JSON，不要解释、不要 Markdown 围栏；',
  '6) **保持精简**：节点最多 12 个、连线最多 20 条 —— 挑最能说明结构的那几块，画全反而看不清；',
  '7) 输出必须**是完整闭合的 JSON**（最后一个字符是 }）。宁少画几个节点，也不许半途停住。',
  '',
  '输出格式：',
  '{"title":"项目名 · 架构图","subtitle":"一句话","nodes":[{"id":"dir:src/main","label":"主进程","evidence":["dir:src/main"]}],"edges":[{"from":"dir:src/main","to":"dir:src/shared","kind":"import","evidence":["import:src/main->src/shared"]}]}',
].join('\n')

/** 扫描事实压成一段摘要（与审计同一份事实，避免"提示词说有、审计说不认"） */
export function archFactBrief(facts: ArchScanFacts): string {
  const f = facts || ({} as ArchScanFacts)
  const dirs = (f.dirs || []).map((d) => `${d.path}（${d.files} 个文件：${(d.exts || []).join('/') || '代码'}）`)
  const imports = (f.imports || []).map((i) => `${i.from} -> ${i.to} ×${i.count}`)
  const entries = (f.entries || []).slice(0, 10)
  const deps = ((f.packageJson && f.packageJson.deps) || []).slice(0, 40)
  const ipc = f.ipc || ({} as ArchScanFacts['ipc'])
  const ports = (f.ports || []).map((p) => `${p.port}（${p.source}）`)
  return [
    `项目：${(f.project && (f.project.name || f.project.id)) || '(未知)'}`,
    `代码目录（${dirs.length}）：${dirs.join('；') || '无'}`,
    `入口文件：${entries.join(', ') || '无'}`,
    `依赖：${deps.join(', ') || '无'}`,
    `目录间 import（${imports.length}）：${imports.slice(0, 60).join('；') || '无'}`,
    `IPC：handle ${ipc.handles || 0} / invoke ${ipc.invokes || 0} / 桥 ${ipc.bridgeUses || 0}`,
    `端口：${ports.join(', ') || '无'}`,
    `扫描文件数：${f.scannedFiles || 0}${f.truncated ? '（已截断）' : ''}`,
  ].join('\n')
}

/** 老口径的提示词（给测试注入的 callLlm 用；生产走 `buildArchDispatchPrompt`） */
export function buildArchPrompt(facts: ArchScanFacts, feedback = ''): string {
  const allowed = allowedEvidence(facts, ARCH_EVIDENCE_LIMIT)
  return [
    '扫描事实：',
    archFactBrief(facts),
    '',
    `只能引用的证据 id（共 ${allowed.length} 条，一个都不许多）：`,
    allowed.join('\n') || '（空 —— 没有可用证据，请输出空 nodes/edges）',
    feedback ? '\n' + feedback : '',
  ].join('\n')
}

/** 草稿卡标题（回收时按 nonce 认，不认项目名 —— 项目名可能被改） */
export function archDraftTitle(nonce: string): string {
  return `${ARCH_DRAFT_TITLE_PREFIX} ${String(nonce || '').trim()}`
}

/**
 * 派给 DSH 的完整任务书。它要回答三件事：
 *   ① 画什么、按什么规矩（和审计同一套）；
 *   ② 只能引用哪些证据（清单与审计同一份事实）；
 *   ③ **怎么交**（唯一交付方式：建一张卡，正文一个 json 代码块）。
 *
 * 「怎么交」必须写死，否则 DSH 会把 JSON 回在聊天里 —— 方寸读不到，等于没交。
 */
export function buildArchDispatchPrompt(input: {
  facts: ArchScanFacts
  projectId: string
  projectName?: string
  nonce: string
  attempt?: number
  maxAttempts?: number
  feedback?: string
}): string {
  const facts = input.facts || ({} as ArchScanFacts)
  const allowed = allowedEvidence(facts, ARCH_EVIDENCE_LIMIT)
  const pid = String(input.projectId || '').trim()
  const name = String(input.projectName || '').trim()
  const nonce = String(input.nonce || '').trim()
  const attempt = Number(input.attempt) || 1
  const max = Number(input.maxAttempts) || 2
  const feedback = String(input.feedback || '').trim()
  return [
    `【方寸派单 · 架构图生成】项目 ${pid}${name ? '（' + name + '）' : ''}`,
    '',
    '## 你要做什么',
    '读下面这份「扫描事实」，画一张架构图。**只按证据画，不按印象画**。',
    '产物只有一样：**一张方寸卡**。不要改任何项目文件、不要 git 提交、不要建第二张卡、不要做别的活。',
    '',
    '## 硬规矩（违反会被逐条审计拒收，退回重画）',
    ...ARCH_SYSTEM_PROMPT.split('\n'),
    '',
    '## 怎么交（唯一交付方式）',
    `调用方寸工具建一张卡（插件工具 \`fangcun_write\`；没有它就退到 MCP \`mcp__fangcun__create_task\`）：`,
    `- project: ${pid}`,
    `- title: ${archDraftTitle(nonce)}`,
    `- body: 只放一个 \`\`\`json 代码块，内容是最终 JSON（再写一句话说明也行，但 JSON 必须在代码块里）`,
    `- tags: ["架构图草稿"]`,
    '',
    `如果你连方寸卡工具都没有：**不要**改项目文件，直接在最终回复里说明「拿不到方寸工具」，方寸会降级成扫描图。`,
    '',
    '## 扫描事实',
    archFactBrief(facts),
    '',
    `## 只能引用的证据 id（共 ${allowed.length} 条，一条都不许多）`,
    allowed.join('\n') || '（空 —— 没有可用证据。这种情况下直接建卡，body 写 {"nodes":[],"edges":[]}）',
    ...(feedback ? ['', '## 上一版为什么被拒（按这个改）', feedback] : []),
    '',
    `（这是第 ${attempt}/${max} 次尝试。建完卡就停。）`,
  ].join('\n')
}

/**
 * 从卡正文里抠出 JSON。认三种写法：
 *   · ```json 围栏（推荐，提示词要求的就是这个）；
 *   · 任意 ``` 围栏；
 *   · 裸 JSON（前后有说明文字也容）。
 * 抠不到就原样返回，交给 `parseArchDraft` 去判失败类型（别在这里猜）。
 */
export function extractDraftText(body: string): string {
  const text = String(body || '')
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const raw = fence ? fence[1] : text
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) return raw.slice(start, end + 1)
  return raw.trim()
}

export interface DraftCardLike {
  fm?: any
  body?: string
}

/**
 * 在任务列表里找「这次派单」的草稿卡，返回正文；没有返回空串。
 * 判据只有 nonce：标题里带这个 nonce 的卡就是这一单的，不看项目名（名字可改）。
 */
export function findDraftBody(tasks: DraftCardLike[], nonce: string): string {
  const n = String(nonce || '').trim()
  if (!n) return ''
  for (const t of tasks || []) {
    const title = String(t?.fm?.title || t?.fm?.标题 || '')
    if (title.includes(n)) return String(t?.body || '')
  }
  return ''
}
