/**
 * 日志 ⇄ 待办互转（2026-10-31 · 渲染层拆分第二批「日志动作收口」第八刀）
 *
 * 纪律（卡 2026-10-08-004）：**源保留不删**；目标记「由 X 转来」（prev 范式）；
 * 靠来源字段**防重** —— 同一条只转一次，手滑点两下不产出两条。
 *
 * 字段映射：
 *   待办 → 日志：title/project/priority 走 frontmatter；due 压进正文首行；
 *   日志 → 待办：摘要行 + 来源行 + 正文全文 + 下一步全文（占位跳过），一条不丢。
 *
 * 仍在 App 的：转换确认框模板。依赖由调用方传入，不复制状态。
 */
import { ref, type Ref } from 'vue'
import { isPlaceholderText, firstBulletLine } from '../../shared/placeholder'

interface Deps {
  showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void
  loadLogs: () => Promise<void>
  loadTodos: () => Promise<void>
}

export function useLogConvert(deps: Deps) {
  const { showToast, loadLogs, loadTodos } = deps

  /** 转换确认（不自动动源；把「源怎么办」做成勾选项，默认不勾） */
  const convAsk_ = ref<{ kind: 'log2todo' | 'todo2log'; src: any; archive: boolean } | null>(null)

  function askConvertLog(log: any): void {
    convAsk_.value = { kind: 'log2todo', src: log, archive: false }
  }
  function askConvertTodo(todo: any): void {
    convAsk_.value = { kind: 'todo2log', src: todo, archive: false }
  }
  function runConvert(): void {
    const ask = convAsk_.value
    convAsk_.value = null          // 先关框再跑（转换本身有 toast 反馈）
    if (!ask) return
    if (ask.kind === 'log2todo') void convertLogToTodo(ask.src, ask.archive)
    else void convertTodoToLog(ask.src, ask.archive)
  }

  /** 撤销「已转出」：清掉 converted 字段（空串 = 字段从 JSON 消失），源回到常规列表 */
  async function undoConverted(todo: any): Promise<void> {
    try {
      const r: any = await window.tegula.todosUpdate(todo.id, { converted: '' })
      if (r?.ok) { showToast('已撤销「已转出」标记', 'success'); await loadTodos() }
      else showToast(`撤销失败：${r?.error || '未知原因'}`, 'error')
    } catch (e: any) {
      showToast(`撤销异常：${e?.message || e}`, 'error')
    }
  }

  /** 待办 → 日志：源默认保留；勾了「标已转出」才折叠源（不删） */
  async function convertTodoToLog(todo: any, archiveSource = false): Promise<void> {
    try {
      // 防重：读全量日志找来源（与 loadLogs 同一条取数路径，不新造查询）
      const all: any[] = (await window.tegula.logsList({})) || []
      const dup = all.find(l => l && l.fromTodo === todo.id)
      if (dup) {
        showToast(`这条待办已经转过了：${dup.id} —— 源待办保留，不再重复建日志`, 'info')
        return
      }
      const full = String(todo?.title || '').trim()
      if (!full) { showToast('这条待办没有内容，转不了', 'error'); return }
      // 标题 = 首行；正文 = 到期行 + **全文**（多行时才重复全文，单行不重复）
      const titleLines = full.split('\n')
      const title = titleLines.map(x => x.trim()).filter(Boolean)[0] || full
      const bodyParts: string[] = []
      if (todo.due) bodyParts.push(`到期：${todo.due}`)
      if (titleLines.length > 1) bodyParts.push(full)
      const r: any = await window.tegula.logsCreate(
        title,
        todo.project || '',
        bodyParts.join('\n\n'),
        undefined,
        { priority: todo.priority || '', fromTodo: todo.id, logDate: '' },
      )
      if (!r?.ok) { showToast(`转日志失败：${r?.error || '未知原因'}`, 'error'); return }
      let convNote = '源待办保留未删'
      if (archiveSource) {
        const logId = r.data?.id || ''
        const ur: any = logId ? await window.tegula.todosUpdate(todo.id, { converted: logId }) : null
        if (ur?.ok) convNote = '源待办已标「已转出」（默认折叠，展开可撤销）'
      }
      showToast(`已转成日志 ${r.data?.id || ''} —— ${convNote}`, 'success')
      await loadLogs()
      if (archiveSource) await loadTodos()   // 折叠要立刻反映出来
    } catch (e: any) {
      showToast(`转日志异常：${e?.message || e}`, 'error')
    }
  }

  /** 日志 → 待办要搬过去的**全部内容**（摘要行 + 来源行 + 正文全文 + 下一步全文） */
  function logToTodoText(log: any): string {
    const srcTitle = String(log?.title || '').trim()
    const nextSteps = String(log?.nextSteps || '').trim()
    const summary = (!isPlaceholderText(nextSteps) ? firstBulletLine(nextSteps) : '') || srcTitle
    const out: string[] = [summary || '（这条日志没有标题，也没有下一步）']
    out.push(`—— 由日志「${srcTitle || log?.id || ''}」转来${log?.id ? '（' + log.id + '）' : ''}`)
    const body = String(log?.content || '').trim()
    if (body) out.push('', body)
    if (nextSteps && !isPlaceholderText(nextSteps)) out.push('', '下一步：', nextSteps)
    return out.join('\n')
  }

  /** 日志 → 待办：源默认保留；勾了「归档源」才把日志移进已归档分区（可 reopen 找回） */
  async function convertLogToTodo(log: any, archiveSource = false): Promise<void> {
    try {
      const all: any[] = (await window.tegula.todosList()) || []
      const dup = all.find(t => t && t.fromLog === log.id)
      if (dup) {
        showToast(`这条日志已经转过了待办：「${dup.title}」—— 源日志保留，不再重复建`, 'info')
        return
      }
      // 判据是"标题与下一步都没有"才算转不了 —— 不能因为下一步是占位就判成没内容。
      if (!String(log?.title || '').trim() && !String(log?.nextSteps || '').trim()) {
        showToast('这条日志没有标题也没有下一步，转不了', 'error'); return
      }
      const title = logToTodoText(log)
      const r: any = await window.tegula.todosCreate(title, log.priority || '中', undefined, log.project || '', log.id)
      if (!r?.ok) { showToast(`转待办失败：${r?.error || '未知原因'}`, 'error'); return }
      let convNote = '源日志保留未删'
      if (archiveSource) {
        const ar: any = await window.tegula.logsArchive(log.id)
        if (ar?.ok) convNote = '源日志已归档（日志页「已归档」分区可找回）'
      }
      showToast(`已转成待办 —— ${convNote}`, 'success')
      await loadTodos()
      if (archiveSource) await loadLogs()    // 源日志状态变了，列表要刷新
    } catch (e: any) {
      showToast(`转待办异常：${e?.message || e}`, 'error')
    }
  }

  return { convAsk_, askConvertLog, askConvertTodo, runConvert, undoConverted, convertTodoToLog, convertLogToTodo }
}
