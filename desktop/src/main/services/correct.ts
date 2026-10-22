/**
 * 「随纠」—— 一句话纠偏（2026-10-22 · 施工单包 03 任务二）
 *
 * 用户原话：「从查询结果直接纠偏：改任务/改方向/否决/挂起，一次点击或一句话完成，
 * 决策卡自动留痕（谁/何时/改了什么）。纠偏后相关视图即时刷新。」
 *
 * ## 只做「改方向」，不顺手把任务那摊子也搬过来
 *
 * 任务状态在看板上已经有好几条顺手的路（拖拽、右键、批量）。再给一个"一句话改任务状态"
 * 只是在同一个动作上加第二个入口 —— 而**项目三字段**此前只能去手改 registry.yaml。
 * 所以这一版只管：状态 / 路线图 / 说明（说明就是「欠着」那一栏）。
 *
 * ## 为什么要有明确语法，而不是"懂自然语言"
 *
 * 03 单的成本红线是「绝不滚成自研 agent」。要"懂"任意一句话就必须调模型（花钱、还可能猜错）。
 * 所以这里只认**三种固定句式**，认不出就明说认不出、把语法摆出来 ——
 * 猜错一个方向比拒绝执行糟得多（改的是用户的方针，不是搜索词）。
 *
 *   `改 路线图 为 <新内容>`        项目名可省（从查询结果带进来）
 *   `把 方寸 的 状态 改成 已挂起`  带项目名也行
 *   `改 说明 为 欠着：①……`        值里可以有空格、标点、冒号
 *
 * ## 留痕与退路（两条都在，缺一个都不算"纠得动"）
 *
 *   · **决策卡**：每次纠偏写一条 `有效` 决策（内容=谁改成什么，出处=方寸随纠）；
 *   · **撤销**：返回 `before`，界面挂撤销条；撤回时把决策卡一并标成 `已撤销`
 *     —— 只改回字段却留着"已定案"的决策卡，等于在台账上写了假话。
 */
import * as data from '../data'
import * as decisions from '../data/decisions'

/** 用户嘴里的字段名 → registry 里的真字段名（问「进度」「目标」「欠着」都该认） */
const FIELD_ALIASES: Record<string, data.ProjectTextField> = {
  状态: '状态',
  进度: '状态',
  路线图: '路线图',
  路线: '路线图',
  目标: '路线图',
  方向: '路线图',
  说明: '说明',
  欠着: '说明',
  欠账: '说明',
  欠什么: '说明',
}

const FIELD_RE = Object.keys(FIELD_ALIASES).sort((a, b) => b.length - a.length).join('|')
/** 值前面的连接词 —— 中英文都收（用户会打 `=` 也会打「改成」） */
const SEPS = ['改成', '改为', '调整成', '调整到', '变成', '＝', '=', '为', '成']

export interface CorrectIntent {
  ok: boolean
  error?: string
  projectId?: string
  projectName?: string
  field?: data.ProjectTextField
  /** 用户嘴里的字段名（回执里说人话） */
  fieldLabel?: string
  from?: string
  to?: string
  /** 人话回执：「把「方寸」的路线图：A → B」 */
  echo?: string
}

/** 项目清单（名字最长匹配；认不出就靠调用方传进来的 projectId 兜底） */
function projects(): any[] {
  try {
    return data.parseRegistry(true) as any[]
  } catch {
    return []
  }
}

function matchProject(text: string): { p: any | null; rest: string } {
  let best: any = null
  let bestLen = 0
  for (const p of projects()) {
    for (const key of [String(p?.name || ''), String(p?.id || '')]) {
      if (!key) continue
      const idx = text.indexOf(key)
      if (idx >= 0 && key.length > bestLen) { best = p; bestLen = key.length }
    }
  }
  if (!best) return { p: null, rest: text }
  const key = String(best.name || best.id)
  return { p: best, rest: text.replace(key, '').replace(String(best.id), '') }
}

/**
 * 解析一句话（**不写盘** —— 界面可以先拿它显示"将要改成什么"，再由用户点头）。
 * @param text 用户原话
 * @param fallbackProjectId 查询结果带进来的项目（一句话里没点名时用它）
 */
export function parseCorrection(text: string, fallbackProjectId?: string): CorrectIntent {
  const raw = String(text || '').trim()
  if (!raw) return { ok: false, error: '还没说改什么' }

  // 剥前导动词：「把 / 改 / 将 / 请 / 帮我」都不带语义，只是语气
  let s = raw.replace(/^(请|帮我|麻烦)?\s*(把|改|将|修改|调整)?\s*/u, '').trim()
  const { p: named, rest } = matchProject(s)
  // 「把 项目 的 状态」剥掉项目名后剩 ' 的 状态 …' —— 前导空格与「的」都要吃掉，
  // 只写 `^的` 会漏掉那种带空格的写法（2026-10-22 实测：认不出字段，用户只会以为坏
  s = rest.replace(/^[\s的]+/u, '').trim()

  const proj = named
    || (fallbackProjectId ? projects().find((x) => String(x?.id) === String(fallbackProjectId)) : null)
  if (!proj) {
    return { ok: false, error: '没认出是哪个项目 —— 在句子里写上项目名，或先问一句那个项目再改' }
  }

  // 转义只做真·正则元字符：`=` 不是元字符，转成 `\=` 在 u 模式下会直接抛 Invalid escape
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = s.match(new RegExp(`^(${FIELD_RE})\\s*(?:${SEPS.map(esc).join('|')})\\s*([\\s\\S]+)$`, 'u'))
  if (!m) {
    const hitField = s.match(new RegExp(`^(${FIELD_RE})`, 'u'))
    if (hitField) {
      return {
        ok: false,
        error: `认出了字段「${hitField[1]}」，但没看出要改成什么 —— 说成「改 ${hitField[1]} 为 …」`,
        projectId: String(proj.id),
        projectName: String(proj.name || proj.id),
      }
    }
    return {
      ok: false,
      error: '没认出要改哪个字段。能改的就三个：状态 / 路线图 / 说明。比如「改 路线图 为 跑通第一单」',
      projectId: String(proj.id),
      projectName: String(proj.name || proj.id),
    }
  }

  const fieldLabel = m[1]
  const field = FIELD_ALIASES[fieldLabel]
  const to = String(m[2] || '').trim()
  if (!to) {
    return { ok: false, error: '要改成的内容是空的 —— 清空字段不算纠偏（真要清就直说「清空」）', projectId: String(proj.id) }
  }

  const read = data.readProjectFields(String(proj.id))
  if (!read.ok) return { ok: false, error: read.error }

  return {
    ok: true,
    projectId: String(proj.id),
    projectName: String(proj.name || proj.id),
    field,
    fieldLabel,
    from: String(read.fields?.[field!] || ''),
    to,
    echo: `「${String(proj.name || proj.id)}」的${field}：${String(read.fields?.[field!] || '（空）')} → ${to}`,
  }
}

export interface CorrectResult {
  ok: boolean
  error?: string
  echo?: string
  projectId?: string
  field?: data.ProjectTextField
  /** 改之前的旧值（撤销条用它反推；不在前端猜） */
  before?: string
  /** 这一笔留痕的决策卡 id（撤销时连同它一起标「已撤销」） */
  decisionId?: string
  /** 决策卡是不是没写成（字段改了但留痕失败 —— 必须让用户知道，不许静默） */
  decisionError?: string
}

/**
 * 执行一句话纠偏：改字段 + 写决策卡 + 回传撤销所需的一切。
 *
 * ⚠ 顺序是刻意的：**先改字段，再写决策卡**。
 *   反过来的话，字段改失败会留下一条"已定案"的假决策 —— 台账上写着改了，实际没改。
 */
export function applyCorrection(text: string, fallbackProjectId?: string): CorrectResult {
  const it = parseCorrection(text, fallbackProjectId)
  if (!it.ok) return { ok: false, error: it.error }

  // 与目标值相同 → 不算一笔改动（别产生一堆"改成原值"的决策卡）
  if (String(it.from || '') === String(it.to || '')) {
    return {
      ok: false,
      error: `「${it.field}」现在就是这句内容，没有可改的`,
      projectId: it.projectId,
    }
  }

  const patch: Record<string, string> = {}
  patch[it.field!] = String(it.to || '')
  const w = data.updateProjectFields(String(it.projectId), patch as any)
  if (!w.ok) return { ok: false, error: `字段没改成：${w.error || '未知原因'}` }

  // 留痕：内容写清"谁改成什么"，出处标明是随纠进来的（不是群里拍板的）
  const content = `${it.projectName}｜${it.field}：${String(it.from || '（空）')} → ${String(it.to || '')}`
  let decisionId = ''
  let decisionError = ''
  try {
    const d = decisions.addDecision({
      内容: content,
      项目: String(it.projectId),
      出处: '方寸随纠',
      状态: '有效',
      备注: '一句话纠偏自动留痕',
    })
    if (d.ok) decisionId = d.id
    else decisionError = (d as { ok: false; error: string }).error
  } catch (e: any) {
    decisionError = String(e?.message || e)
  }

  return {
    ok: true,
    echo: `已改${it.echo}`,
    projectId: it.projectId,
    field: it.field,
    before: String(it.from || ''),
    decisionId,
    decisionError: decisionError || undefined,
  }
}

/**
 * 撤回一笔随纠：字段写回旧值 + 决策卡标「已撤销」。
 *
 * 为什么参数是明文 pin（projectId/field/before/decisionId）而不是"读上一个状态"：
 * 撤销条可能在 60 秒后才被点，中间用户可能又改了别的东西 ——
 * 只认**当时那一笔**的旧值，才不会把后来的改动一起抹掉。
 */
export function undoCorrection(args: {
  projectId: string
  field: data.ProjectTextField
  before: string
  decisionId?: string
}): { ok: boolean; error?: string; decisionError?: string } {
  const pid = String(args?.projectId || '')
  const field = args?.field
  if (!pid || !field) return { ok: false, error: '撤销参数不全' }
  if (!(data.PROJECT_TEXT_FIELDS as readonly string[]).includes(field)) {
    return { ok: false, error: `不认识的字段：${String(field)}` }
  }
  const patch: Record<string, string> = {}
  patch[field] = String(args.before ?? '')
  const w = data.updateProjectFields(pid, patch as any)
  if (!w.ok) return { ok: false, error: `字段没改回去：${w.error || '未知原因'}` }

  let decisionError: string | undefined
  if (args.decisionId) {
    try {
      const r = decisions.setDecisionStatus(args.decisionId, '已撤销', '由撤销条撤回（随纠）')
      if (!r.ok) decisionError = (r as any).error
    } catch (e: any) {
      decisionError = String(e?.message || e)
    }
  }
  return { ok: true, decisionError }
}
