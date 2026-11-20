/**
 * 问答页的领域逻辑（2026-11-03 · App.vue 拆分「领域刀」）
 *
 * 从 App.vue 原样搬出：结构化问答 / 随纠（一句话改方向）/ 出单 / 月度花销 /
 * 跨渠道 token 对比 / 账户余额口径。**一条口径都没改**：
 *   · 默认零 token：答案由主进程从台账算，`needsLlm` 只有结构化真算不出来才是 true；
 *   · 花销可见：AI 回答头上印事实字数与 token；
 *   · 金额只转述、不折算：单价表留在设置页，这里不内置任何价格。
 *
 * 依赖由 App 传入（projects / loadAll / showToast / offerUndo / aiUsageTail），不复制状态。
 */
import { ref, computed } from 'vue'
import { toPlain } from '../../shared/plain'

interface AskDeps {
  projects: any
  loadAll: () => Promise<void> | void
  showToast: (msg: string, type?: string) => void
  offerUndo: (label: string, fn: () => Promise<void>) => void
  aiUsageTail: (u: any) => string
  /** 花钱动作确认（2026-11-20）：返回 true 才继续；由 App 统一弹窗 */
  costAsk: (opts: { title: string; detail: string; confirmText?: string }) => Promise<boolean>
}

export function useAsk(deps: AskDeps) {
  const { projects, loadAll, showToast, offerUndo, aiUsageTail, costAsk } = deps

  // ── 结构化问答 ────────────────────────────────────────────────────────
  const askQ = ref('')
  const askBusy = ref(false)
  const askAns = ref<any>(null)
  const askPresets = ref<Array<{ label: string; q: string }>>([])

  /** 常用问题由**主进程**给（界面不许自己写一份文案 —— 两边一漂移就成了两套问题集） */
  async function loadAskPresets(): Promise<void> {
    try {
      const r: any = await window.tegula.askPresets()
      askPresets.value = Array.isArray(r?.presets) ? r.presets : []
    } catch {
      askPresets.value = []
    }
  }

  /** 常用问题按 group 归并 —— 九个按钮排一行会挤成两行、还孤零零剩一个（2026-10-22 截图目检） */
  const askGroups = computed(() => {
    const out: Array<{ name: string; items: Array<{ label: string; q: string; hint?: string }> }> = []
    for (const p of askPresets.value) {
      const name = String((p as any).group || '常用')
      let g = out.find((x) => x.name === name)
      if (!g) { g = { name, items: [] }; out.push(g) }
      g.items.push(p)
    }
    return out
  })

  /** 月度报表（03 任务三）：按自然月，最近 3 个月。读不到就空 —— 界面会直说"一次都没走过 AI"。 */
  const usageMonths = ref<any[]>([])
  /** 跨渠道 token 对比（2026-11-02）：只比 token；金额只转述标注 */
  const chanReport = ref<any>(null)
  const chanDays = ref(30)
  const chanPick = ref('')
  const chanReadError = ref('')
  /** 账户口径（2026-10-25 卡 005）：只读状态，真正的余额请求在 refreshBalance 里按需发 */
  const balanceStatus = ref<any>(null)
  const balanceObserving = ref(false)

  async function loadBalanceStatus(): Promise<void> {
    try {
      const r: any = await (window as any).tegula.llmBalanceStatus()
      balanceStatus.value = r || null
    } catch {
      // 旧主进程没有这条通道 → 不显示这块（不报假）
      balanceStatus.value = null
    }
  }

  /** 端点 id → 人话品牌名（界面上别直接摆 `deepseek` 这种内部 id） */
  function providerLabel(p: string): string {
    if (p === 'deepseek') return 'DeepSeek'
    if (p === 'openrouter') return 'OpenRouter'
    return p || '未知端点'
  }

  /**
   * 金额显示：定点字符串（"0.00320000"）→ 人话。
   * ⚠ 只做**截断**不做四舍五入：宁可显示少一点，也不把 0.00349 说成 0.0035 让人以为花了更多。
   */
  function fmtCost(v: unknown): string {
    const raw = String(v ?? '0')
    const dot = raw.indexOf('.')
    if (dot < 0) return raw
    const frac = (raw.slice(dot + 1) + '0000').slice(0, 4).replace(/0+$/, '')
    return frac ? `${raw.slice(0, dot)}.${frac}` : raw.slice(0, dot)
  }

  async function refreshBalance(): Promise<void> {
    if (balanceObserving.value) return
    balanceObserving.value = true
    try {
      const r: any = await (window as any).tegula.llmBalanceObserve()
      if (r?.status) balanceStatus.value = r.status
      showToast(r?.message || (r?.ok ? '已查一次余额' : '查余额失败'), r?.ok ? 'success' : 'error')
    } catch (e: any) {
      showToast('查余额失败：' + (e?.message || e), 'error')
    } finally {
      balanceObserving.value = false
    }
  }

  async function loadUsageMonths(): Promise<void> {
    try {
      const r: any = await window.tegula.llmUsageMonthly(3)
      usageMonths.value = Array.isArray(r?.months) ? r.months : []
    } catch {
      usageMonths.value = []
    }
  }

  /** 跨渠道 token 对比：只读；筛选项变了重读一次（服务端聚合，界面不自己算） */
  async function loadChannels(): Promise<void> {
    chanReadError.value = ''
    try {
      const r: any = await (window as any).tegula.channelsGet({
        days: chanDays.value,
        channels: chanPick.value ? [chanPick.value] : [],
      })
      if (!r?.ok) { chanReport.value = null; chanReadError.value = String(r?.error || '读取失败'); return }
      chanReport.value = r.report || null
      chanReadError.value = String(r?.readError || '')
    } catch (e: any) {
      chanReport.value = null
      chanReadError.value = String(e?.message || e)
    }
  }

  async function runAsk(): Promise<void> {
    const q = askQ.value.trim()
    if (!q || askBusy.value) return
    askBusy.value = true
    try {
      const r: any = await window.tegula.askQuery(q)
      if (!r || r.ok === false) {
        // 失败要说出来，不能留上一题的答案在那儿冒充"这题的答案"
        showToast(`查询失败：${r?.error || '未知原因'}`, 'error')
        askAns.value = null
      } else {
        askAns.value = r
      }
    } catch (e: any) {
      showToast('查询异常：' + (e?.message || e), 'error')
    } finally {
      askBusy.value = false
    }
  }

  function askQuick(q: string): void {
    askQ.value = q
    void runAsk()
  }

  /**
   * 结构化答不了时：**打包给 DSH**，不再调方寸模型（D-151 / 2026-11-20）。
   *
   * 判据：按钮点了只写剪贴板；`llm:ask` 已退役，主进程零调用。
   * 包里必须带：原问题、项目、方寸算出的结构化事实（标明"不是结论"）、来源；
   * 不把"方寸的结构化答案"冒充成 DSH 的答案。
   */
  async function askToDshPackage(): Promise<void> {
    const a = askAns.value
    const q = askQ.value.trim()
    if (!a || !q) return
    const pid = String(a.projectId || '').trim()
    const lines = (Array.isArray(a.lines) ? a.lines : []).map((l: any) => `- ${l}`)
    const rows = (Array.isArray(a.rows) ? a.rows : [])
      .map((r: any) => `- ${r.k}：${r.v}${r.sub ? `（${r.sub}）` : ''}`)
    const md = [
      '【方寸转给 DSH 的问题】',
      `问题：${q}`,
      pid ? `项目：${pid}` : '项目：（未指定）',
      '',
      '方寸按台账算出的结构化事实（**不是结论**，别把它当答案）：',
      a.title ? `- 结论：${a.title}` : '',
      ...lines,
      ...rows,
      a.source ? `- 来源：${a.source}` : '- 来源：方寸结构化查询（未点名项目，按全局台账算）',
      '',
      '请用你在 DSH 里配置的模型回答；方寸不再调用自己的模型（llm:ask 已退役）。',
    ].filter((x) => x !== '').join('\n')
    try {
      const r: any = await (window as any).tegula.clipboardWriteText(md)
      if (!r || r.ok === false) {
        showToast('复制失败：' + (r?.error || '未知原因'), 'error')
        return
      }
      showToast(`已复制给 DSH 的问题包（${md.length} 字）—— 粘到 DSH 会话里即可`, 'success')
    } catch (e: any) {
      showToast('复制失败：' + (e?.message || e), 'error')
    }
  }

  // 随纠（2026-10-22 · 03 任务二）：一句话改方向。不填表单、不猜参数。
  const correctOpen = ref(false)
  const correctText = ref('')
  const correctBusy = ref(false)
  const correctErr = ref('')

  function openCorrect(): void {
    correctOpen.value = true
    correctText.value = ''
    correctErr.value = ''
  }
  function closeCorrect(): void {
    correctOpen.value = false
    correctErr.value = ''
  }

  /**
   * 执行一句话纠偏。三件事必须一起成立，缺一件都不算"纠得动"：
   *   ① 字段真改了（主进程写前自校验）；② 决策卡留痕（没记上要**说出来**，
   *   否则台账上看着"改过"，实际只有字段变了）；③ 撤销条挂上（一步退回去）。
   */
  async function runCorrect(): Promise<void> {
    const txt = correctText.value.trim()
    const pid = askAns.value && askAns.value.projectId
    if (!txt || !pid || correctBusy.value) return
    correctBusy.value = true
    correctErr.value = ''
    try {
      const r: any = await window.tegula.correctApply(txt, pid)
      if (!r || r.ok === false) {
        correctErr.value = String(r?.error || '没改成：未知原因')
        return
      }
      if (r.decisionError) {
        // 字段改了、台账没记上 —— 这种事必须让人看见，不能只报"成功"
        correctErr.value = `字段已经改了，但决策卡没记上：${r.decisionError}`
      }
      closeCorrect()
      // 相关视图即时刷新：项目详情页读的是 loadProjects，答案重查一遍（同一句问题）
      projects.value = await window.tegula.loadProjects()
      await runAsk()
      const before = String(r.before ?? '')
      const args = { projectId: r.projectId, field: r.field, before, decisionId: r.decisionId || '' }
      offerUndo('已改' + String(r.echo || ''), async () => {
        const back: any = await window.tegula.correctUndo(toPlain(args))
        if (!back || back.ok === false) throw new Error(back?.error || '改不回去了')
        projects.value = await window.tegula.loadProjects()
        await runAsk()
        if (back.decisionError) showToast(`字段改回去了，但决策卡没标撤销：${back.decisionError}`, 'error')
      })
    } catch (e: any) {
      correctErr.value = '纠偏异常：' + (e?.message || e)
    } finally {
      correctBusy.value = false
    }
  }

  // 出单（2026-10-22 · 03 任务三；2026-11-20 D-150 改 DSH 派单）：
  // 不再调方寸模型；只写一份任务书 + 上下文包，DSH 里开会话去派生待审批卡。
  const batchBusy = ref(false)
  async function runBatch(): Promise<void> {
    const pid = askAns.value && askAns.value.projectId
    if (!pid || batchBusy.value) return
    if (!(await costAsk({
      title: '出下一批任务卡',
      detail: '这会写一份派单，并在 DSH 里开一个新会话；DSH 会用你配置的模型出卡，可能产生真实费用。',
      confirmText: '继续（会开 DSH 会话）',
    }))) return
    batchBusy.value = true
    try {
      const msg = [
        '【这次要做的事】从下面的项目台账和已拍板决策出发，产出下一批 3-8 张“待审批”任务卡。',
        '每张卡写清：标题、优先级（高/中/低）、标签、方案、结果记录里的验收判据；',
        '不要重复已有未完成卡；写不出判据的条目不要写；',
        '用 fangcun_write 落成“待审批”，不要设完成/驳回。',
      ].join('\n')
      const r: any = await window.tegula.dispatchMessageDsh(pid, 'work', msg)
      if (!r || r.ok === false) {
        showToast(`没出成：${(r && r.error) || '未知原因'}`, 'error')
        return
      }
      showToast(`已把出单任务发给 DSH（${r.chars || 0} 字派单）—— DSH 里会冒出新会话；落卡后筛待审批`, 'success')
    } catch (e: any) {
      showToast('出单异常：' + (e?.message || e), 'error')
    } finally {
      batchBusy.value = false
    }
  }

  /** 进页面时拉一次（原来在 App 的 loadViewData 里，现在由 AskView 自己 onMounted 调） */
  async function initAsk(): Promise<void> {
    if (!askPresets.value.length) await loadAskPresets()
    // 月报表每次都重读：花销是会变的数，界面上的旧数比没有数更误导
    await Promise.all([loadUsageMonths(), loadChannels(), loadBalanceStatus()])
  }

  return {
    askQ, askBusy, askAns, askGroups,
    runAsk, askQuick, askToDshPackage,
    correctOpen, correctText, correctBusy, correctErr, openCorrect, closeCorrect, runCorrect,
    batchBusy, runBatch,
    usageMonths, chanReport, chanDays, chanPick, chanReadError, loadChannels,
    balanceStatus, providerLabel, balanceObserving, refreshBalance, fmtCost,
    initAsk,
  }
}
