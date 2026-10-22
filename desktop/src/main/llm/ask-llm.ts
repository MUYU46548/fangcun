/**
 * 模糊问答（2026-10-22 · 施工单包 03 任务一的后半句）
 *
 * 用户原话：「模糊问题（结构化答不了的）才走 LLM，回答限定引用结构化数据，不自由发挥。」
 *
 * 这段代码存在的唯一理由就是**把"不自由发挥"变成结构约束**，而不是提示词里的一句祈使句：
 *   · 先把方寸手里能拿到的全部事实压成【事实】区块（`services/ask.buildContext()`）；
 *   · 模型只在这段事实里找答案 —— 它没有别的输入，编也只能编事实里有的；
 *   · 缺的就说缺（提示词第 1 条），不许拿"一般来说"填补。
 *
 * 成本口径（03 单红线）：
 *   · 全应用只有**这里**和 `writeback`（批次出单）两处会为"问答/规划"花 token；
 *   · 每次调用的 usage 原样回传给界面（`usage` 字段），界面 toast 里透传花销；
 *   · `trigger: 'desktop.ask'` 会落进 ai-trace，月度报表能按触发点分开算。
 */
import { chatDetailed, ChatUsage, emptyUsage } from './chat'
import { buildContext } from '../services/ask'

const ASK_SYSTEM = [
  '你是方寸看板的问答助手。用户给了你一份【事实】区块，那是刚从方寸数据库里取出来的。',
  '硬规则：',
  '1. 只能引用【事实】里的内容。事实里没有的，直接说「数据里没有」——不许推测、不许编数字、不许拿常识补齐。',
  '2. 回答控制在 6 行以内，纯文本，不要 markdown 标题、不要堆列表符号。',
  '3. 要先复述关键事实，再给一句话判断。判断必须能指回事实，不许给"应该怎么做"的长篇方案。',
  '4. 如果【事实】末尾写了"被截断"，回答时必须说明「数据不完整」。',
].join('\n')

export interface AskLlmResult {
  ok: boolean
  text?: string
  error?: string
  usage: ChatUsage
  /** 这一问塞了多少字的事实（让用户能看出"钱花在多大的上下文上"） */
  facts_chars: number
}

export async function askWithLlm(question: string, model?: string): Promise<AskLlmResult> {
  const q = String(question || '').trim()
  if (!q) return { ok: false, error: '问题为空', usage: emptyUsage, facts_chars: 0 }

  const facts = buildContext()
  let usage: ChatUsage = emptyUsage
  try {
    const r = await chatDetailed(`【事实】\n${facts}\n\n【问题】\n${q}`, {
      model,
      system: ASK_SYSTEM,
      trigger: 'desktop.ask',
      temperature: 0.2,
      maxTokens: 800,
    })
    usage = r.usage
    const text = String(r.text || '').trim()
    if (!text) return { ok: false, error: '模型返回了空内容', usage, facts_chars: facts.length }
    return { ok: true, text, usage, facts_chars: facts.length }
  } catch (e: any) {
    return { ok: false, error: `调用失败：${e?.message || e}`, usage, facts_chars: facts.length }
  }
}
