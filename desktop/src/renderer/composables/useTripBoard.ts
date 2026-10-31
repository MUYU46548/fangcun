/**
 * 在途一屏（2026-10-31 · 渲染层拆分「项目页刀」第一块）
 *
 * 从 App.vue 整体搬出来的「在途一屏」领域：状态、派生、读取、显示设置、契约建档与打开。
 * 模板同时搬进 `views/TripBoardView.vue` —— 本文件只留状态与动作，**没有第二份状态**：
 * 父组件仍持有唯一实例，偏好同步（syncBoardPrefs）与 `loadViewData` 读的也是这里返回的同一批 ref。
 *
 * 三条红线（暮雨 2026-10-05 拍板，原样保留）：
 *   ① **零硬编码项目清单** —— 由判据推导，用户可手动指定并落 prefs；
 *   ② **缺值显示「未填」**，绝不回退默认值；
 *   ③ 方寸**不写任何项目仓库**（"打开 repo" 只传 projectId，路径由主进程从 registry 取）。
 *
 * ⚠ 依赖注入而不是把 pvView / pvCurrent 的声明搬进来：它们属于「项目页」本身
 *   （主从摆法 / 项目卡都用），在途一屏只是其中一种摆法。搬进来会让项目页反过来依赖这一屏。
 */
import { computed, ref, watch, type Ref } from 'vue'
import { toPlain } from '../../shared/plain'
import { readUiPref, saveUiPref } from '../prefs'

interface Deps {
  pvCurrent: Ref<any>
  pvSelected: Ref<string>
  pvView: Ref<string>
  showToast: (msg: string, type?: 'success' | 'error' | 'info') => void
  copyWithToast: (text: unknown, okMsg: string) => Promise<boolean>
}

const TRIP_CRITERIA_OPTIONS = [
  { v: 'cards', label: '有未完结卡' },
  { v: 'cards_or_commit', label: '有未完结卡 或 30 天内有提交' },
  { v: 'cards_or_log', label: '有未完结卡 或 有执行日志' },
  { v: 'manual', label: '手填清单（手动指定）' },
] as const
const TRIP_COL_OPTIONS = [
  { v: 'end', label: '终态一句话' },
  { v: 'current', label: '当前步骤' },
  { v: 'next', label: '下一步' },
  { v: 'who', label: '卡在谁' },
  // 2026-10-22 · 03 任务三：四栏台账的第四栏「欠着什么」（registry 手写欠账清单）
  { v: 'owe', label: '欠着什么' },
  { v: 'health', label: '健康度' },
  { v: 'counts', label: '卡 / 日志' },
  { v: 'commit', label: '最近提交' },
  { v: 'dirty', label: '未提交文件数' },
] as const
// 健康度点一下换一档（机器给默认，人可覆盖 —— 司天那种「在动但冻结」机器算不出来）
const TRIP_HEALTH_CYCLE = ['active', 'stuck', 'dormant', 'paused', 'idle'] as const
const TRIP_HEALTH_LABEL: Record<string, string> = {
  active: '活跃', stuck: '停滞', dormant: '休眠', paused: '搁置', idle: '空闲',
}

export function useTripBoard(deps: Deps) {
  const { pvCurrent, pvSelected, pvView, showToast, copyWithToast } = deps

  const tripRows = ref<any[]>([])
  /** 登记了但没进这一屏的项目（判据没命中）—— 必须说出来，否则用户以为"我加的项目没了" */
  const tripHidden = ref<{ id: string; name: string; reason: string }[]>([])
  /** 上一次读取失败的原因。**空屏时要说真话**：是"确实没有"还是"根本没读到"（2026-10-05 用户连报三次看不见） */
  const tripError = ref('')
  const tripLoading = ref(false)
  /** 详情页 git 行：在途一屏数据已在内存时按项目取行；没拉过 = null（界面给「拉取」按钮，不编数据） */
  const msGitRow = computed(() => {
    const id = pvCurrent.value?.id
    if (!id || !tripRows.value.length) return null
    return tripRows.value.find((r: any) => r.id === id) || null
  })
  const tripSettingsOpen = ref(false)
  const tripMeta = ref<{ generatedAt: string; mode: string; criteria: string }>(
    { generatedAt: '', mode: 'auto', criteria: 'cards_or_commit' })
  // ⚠ 四个键都从 readUiPref 起手（而不是空值等 syncBoardPrefs 回填）：
  //   否则 syncBoardPrefs 因任何原因没跑到时，界面会拿着空值去覆盖用户已存的选择。
  const tripMode = ref<'auto' | 'manual'>(readUiPref<'auto' | 'manual'>('fc_trip_mode', 'auto'))
  const tripCriteria = ref<string>(readUiPref<string>('fc_trip_criteria', 'cards_or_commit'))
  const tripManualIds = ref<string[]>(readUiPref<string[]>('fc_trip_projects', []))
  const tripCols = ref<string[]>(readUiPref<string[]>('fc_trip_cols', TRIP_COL_OPTIONS.map(o => o.v)))
  const tripHealthOverrides = ref<Record<string, string>>(readUiPref<Record<string, string>>('fc_health_overrides', {}))

  const tripSubtitle = computed(() => {
    const c = TRIP_CRITERIA_OPTIONS.find(o => o.v === tripMeta.value.criteria)?.label || tripMeta.value.criteria
    const mode = tripMeta.value.mode === 'manual' ? '手动指定' : '自动'
    const when = tripMeta.value.generatedAt ? ` · 更新于 ${tripMeta.value.generatedAt}` : ''
    return `${tripRows.value.length} 个项目 · ${mode}（${c}）${when}`
  })

  // 空屏时说什么：要分清「门槛太严」和「你选了手动却还没勾」——后者说成前者就是骗人
  const tripEmptyHint = computed(() => {
    if (tripMode.value === 'manual' && !tripManualIds.value.length) {
      return '你选的是「手动指定」，但还没勾任何项目 —— 点「⚙ 显示设置」勾几个，它们就会出现在这里。'
    }
    return '按现在的规则，没有项目算在途。点「⚙ 显示设置」把规则放宽，或改成「手动指定」自己勾。'
  })

  // 没进这一屏的项目要**按原因分开说**：把"你没勾它"说成"它没有未完结任务"就是假话
  // （2026-10-05：方寸自己有几十张未完结卡，却被那句统一文案说成"没有未完结任务"）。
  const tripHiddenNotPicked = computed(() => tripHidden.value.filter(h => h?.kind === 'not-picked'))
  const tripHiddenNoActivity = computed(() => tripHidden.value.filter(h => h?.kind !== 'not-picked'))

  async function loadTripBoard(): Promise<void> {
    tripLoading.value = true
    try {
      const res: any = await (window as any).tegula.tripBoard()
      if (res?.ok) {
        tripError.value = ''
        tripRows.value = Array.isArray(res.rows) ? res.rows : []
        tripHidden.value = Array.isArray(res.hidden) ? res.hidden : []
        tripMeta.value = {
          generatedAt: res.generatedAt || '',
          mode: res.mode || 'auto',
          criteria: res.criteria || 'cards_or_commit',
        }
        // ⚠ 这里**绝对不能**去"同步" tripManualIds（曾经写过一版：把 rows 的 id 回填给勾选清单）。
        //   后果：用户勾的项目正因为"没进屏"才需要留在清单里，回填等于**当场把他的勾选抹掉** ——
        //   表现为「提示保存了，但重新打开勾选全没了」（2026-10-05 用户实测）。
        //
        // 数据层的**兜底回自动**：prefs 里写着「手动指定」却从没勾过任何项目（旧写法只落了字符串键，
        // 数组键丢了）—— 照字面执行会让这一屏空得像界面坏了。数据层此时按自动走并回传 modeFallback，
        // 界面必须把这件事说出来，并且把面板上的模式同步成"自动"，否则会出现
        // 「面板高亮手动、屏上是自动结果」的自相矛盾。
        if (res.modeFallback) {
          tripMode.value = 'auto'
          tripManualIds.value = []
          showToast('之前选过「手动指定」但从没勾过项目，这次按规则自动显示 —— 要固定就打开「显示设置」勾几个', 'info')
        }
      } else {
        tripRows.value = []
        tripHidden.value = []
        tripError.value = String(res?.error || '未知错误')
        showToast('读取在途一屏失败：' + (res?.error || '未知错误'), 'error')
      }
    } catch (e: any) {
      tripRows.value = []
      tripHidden.value = []
      tripError.value = String(e?.message || e)
      showToast('读取在途一屏异常：' + (e?.message || e), 'error')
    } finally {
      tripLoading.value = false
    }
  }

  function tripColVisible(c: string): boolean {
    return tripCols.value.includes(c)
  }

  function tripHealthLabel(v: string): string {
    return TRIP_HEALTH_LABEL[v] || v || '空闲'
  }

  function tripHealthClass(v: string): string {
    return v === 'active' ? 'g' : v === 'stuck' ? 'y' : v === 'paused' ? 'p' : 'gray'
  }

  /** 点健康度：在档位之间循环一次，并**锁定**（机器不再覆盖）。回到「活跃」以外都可撤销。 */
  function tripCycleHealth(row: any): void {
    const cur = String(row?.health?.value || 'active')
    const i = TRIP_HEALTH_CYCLE.indexOf(cur)
    const next = TRIP_HEALTH_CYCLE[(i + 1) % TRIP_HEALTH_CYCLE.length]
    const overrides = { ...(tripHealthOverrides.value || {}) }
    overrides[row.id] = next
    tripHealthOverrides.value = overrides
    saveUiPref('fc_health_overrides', overrides)
    showToast(`「${row.name}」健康度标为「${tripHealthLabel(next)}」（已锁定，点它可继续切换）`, 'info')
  }

  /** 解除人工锁定：回到机器默认 */
  function tripUnlockHealth(row: any): void {
    const overrides = { ...(tripHealthOverrides.value || {}) }
    delete overrides[row.id]
    tripHealthOverrides.value = overrides
    saveUiPref('fc_health_overrides', overrides)
    void loadTripBoard()
    showToast(`「${row.name}」健康度已恢复自动`, 'info')
  }

  /**
   * 落盘这一屏的四个偏好键 + 立刻重取数据。
   *
   * ⚠ 2026-10-05 用户实测「提示保存了但实际并未保存，每次重新勾选都被取消」：
   *   · 旧写法是**连续四次** saveUiPref（四次 IPC、四次整文件改写），且**不看返回值** ——
   *     prefs.json 里最终只落了两个字符串键，两个数组键丢了，界面却照样说"已保存"。
   *   · 现在改为**一次 IPC 写完四个键**（主进程合并读-改-写 + 回读校验），
   *     并且**校验结果必须传回界面**：写失败就说失败，绝不假成功。
   */
  async function tripApplySettings(): Promise<boolean> {
    const patch = toPlain({
      fc_trip_mode: tripMode.value,
      fc_trip_criteria: tripCriteria.value,
      fc_trip_projects: [...tripManualIds.value],  // 展开成裸数组，别把响应式数组塞进载荷
      fc_trip_cols: [...tripCols.value],
    })
    // localStorage 只当读缓存（真身永远在主进程 prefs.json）
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* 缓存失败无所谓 */ }
    }
    let ok = true
    try {
      const res: any = await (window as any).tegula?.prefsSetMany?.(patch)
      // ⚠ 返回值必须**明确成功**才算成功：`undefined` = 通道根本没通（旧主进程 / preload 缺这个 API），
      //   那也是"没存住"，不能当成成功（2026-10-05 用户「提示保存了但没保存」的老路）。
      if (!res || res.ok !== true) {
        ok = false
        showToast('设置没存住：' + ((res && res.error) || '主进程没回应（可能还是旧代码）') + ' —— 请把这句话告诉开发者', 'error')
      }
    } catch (e: any) {
      ok = false
      showToast('设置写入异常：' + (e?.message || e), 'error')
    }
    await loadTripBoard()
    return ok
  }

  function tripSetMode(m: 'auto' | 'manual'): void {
    tripMode.value = m
    void tripApplySettings()
  }

  function tripSetCriteria(c: string): void {
    tripCriteria.value = c
    void tripApplySettings()
  }

  /**
   * 「保存」= 落盘 + 关面板 + 明确告知存了什么。
   *
   * 2026-10-05 用户口径：「用户不需要理解运行机制，只要看到最终保存了就行」——
   * 所以按钮就叫「保存」，点下去要有一句带**可核对事实**的确认（而不是"已保存"三个字）。
   * 而"存住了没有"以**写盘回读校验**的返回值为准 —— 校验不过就报错，不假成功。
   */
  async function tripCloseAfterSave(): Promise<void> {
    const ok = await tripApplySettings()
    tripSettingsOpen.value = false
    if (!ok) return  // 失败时 tripApplySettings 已经报过错了
    const n = tripRows.value.length
    showToast(tripMode.value === 'manual'
      ? `已保存：这一屏按你勾的项目显示，共 ${n} 个`
      : `已保存：按门槛自动筛，这一屏 ${n} 个项目`, 'success')
  }

  /** 空屏时的出口：从「手动指定」一步走回自动（并落盘） */
  function tripBackToAuto(): void {
    tripMode.value = 'auto'
    tripCriteria.value = 'cards_or_commit'
    tripManualIds.value = []
    void tripApplySettings().then(() => {
      showToast('已改回自动：按规则筛项目，这一屏现在 ' + tripRows.value.length + ' 个', 'success')
    })
  }

  function tripResetSettings(): void {
    tripMode.value = 'auto'
    tripCriteria.value = 'cards_or_commit'
    tripManualIds.value = []
    tripCols.value = TRIP_COL_OPTIONS.map(o => o.v)
    void tripApplySettings()
  }

  /** 复制契约模板 / 查看已有契约原文（方寸只给文本，落盘由用户自己做） */
  async function tripCopyContract(row: any): Promise<void> {
    try {
      const res: any = await (window as any).tegula.contractText(row.id)
      if (!res?.ok) { showToast('读取契约失败：' + (res?.error || '未知错误'), 'error'); return }
      const ok = await copyWithToast(res.text, res.exists ? '契约原文已复制' : '契约模板已复制 —— 去仓库根存成 立项契约.md')
      if (ok && !res.exists) {
        showToast(`建议落点：${row.repo}/立项契约.md`, 'info')
      }
    } catch (e: any) {
      showToast('复制契约异常：' + (e?.message || e), 'error')
    }
  }

  /**
   * 「让 AI 填契约」的可复制提示词（2026-10-10 用户要求）。
   *
   * 用户原话：「契约文件如何完善？之前说让 AI 填，但是不知道怎么弄。」
   * 上一版界面上只有一句「建好后打开它填内容（也可以让 AI 填）」——
   * **没给能粘贴的东西，等于没说**。这里给的是一段可直接贴进「该项目仓库里开的 AI 会话」的话：
   *   · 说清读哪几个文件当依据（不然它凭空编）；
   *   · 六节逐条填 + **找不到证据就写「未填」不许编**（契约自己写着「缺值不得填默认」）；
   *   · **逐节念回签收** —— 那是契约模板五条机制条款之一，不写进去它会一口气填完，你来不及看；
   *   · 圈定改动范围（只碰 立项契约.md）。
   */
  function contractFillPrompt(row: any): string {
    const name = String(row?.name || row?.id || '这个项目').trim()
    const repo = String(row?.repo || '').trim()
    const lines = [
      `请帮我填写「${name}」的立项契约。`,
      ``,
      `1. 先读本仓库根目录的 立项契约.md（目前是骨架，还没填内容）。`,
      `2. 再读 AGENTS.md、README.md 和主要代码目录，作为事实依据。`,
      `3. 按六个小节逐条填：① 终态形态 ② 验收线 ③ 不要什么 ④ 选型定死 ⑤ 现状底数 ⑥ 下一队列。`,
      ``,
      `规矩（这几条必须守）：`,
      `- 只写仓库里找得到证据的内容；找不到就写「未填」并说明缺什么 —— 不要编。`,
      `- 每填完一节，用「原话 + 翻译」念回给我确认，我点头你再填下一节。`,
      `- 除了 立项契约.md，不要修改任何其它文件。`,
    ]
    if (repo) lines.push(`- 这个仓库的路径是：${repo}`)
    return lines.join('\n')
  }

  async function tripCopyContractPrompt(row: any): Promise<void> {
    const ok = await copyWithToast(contractFillPrompt(row),
      '提示词已复制 —— 贴到这个项目仓库里开的 AI 会话即可')
    if (ok) showToast('它会按契约骨架逐节填，并逐节念回给你确认', 'info')
  }

  /** 打开该项目的文件夹（只传 id，路径由主进程从 registry 取 —— 不接任意路径） */
  async function tripOpenRepo(row: any): Promise<void> {
    try {
      const res: any = await (window as any).tegula.tripOpenRepo(row.id)
      if (!res?.ok) { showToast('打开项目文件夹失败：' + (res?.error || '未知错误'), 'error'); return }
      // 打开之后必须有抓手（用户原话：打开之后只能对着资源管理器发呆）——
      // 契约还缺着就把下一步说清；已有契约就不多嘴。
      if (!(row?.contract && row.contract.exists)) {
        showToast('已打开项目文件夹 —— 下一步：在里面新建「立项契约.md」，点「① 复制模板」粘进去就好', 'info')
      }
    } catch (e: any) {
      showToast('打开项目文件夹异常：' + (e?.message || e), 'error')
    }
  }

  /**
   * 「📄 打开契约」（卡 002）：文件建了就总得有地方改它。
   * 走既有 openFile 通道（主进程 validateAndOpenFile：存在性检查 + 系统默认程序打开），
   * 路径来自主进程聚合出来的 contract.path —— 渲染层不自己拼路径。
   */
  async function tripOpenContract(row: any): Promise<void> {
    const p = String(row?.contract?.path || '')
    if (!p) { showToast('这个项目还没登记文件夹路径 —— 先在项目设置里补上', 'error'); return }
    try {
      const res: any = await (window as any).tegula.openFile(p)
      if (res && res.ok === false) showToast('打开契约失败：' + (res.error || '未知错误'), 'error')
    } catch (e: any) {
      showToast('打开契约异常：' + (e?.message || e), 'error')
    }
  }

  /**
   * 点整行 = 进这个项目的详情（卡 002：行此前不可点，只有健康度与🗑两个热点）。
   * 复用主从摆法的 ms-detail，不新造详情页 —— 所以是「切到 master + 选中该项目」。
   * ⚠ 行内按钮一律 .stop，点击不会漏到这里；这里再兜一层（按钮在 span 里时 target 是内层元素）。
   * ⚠ 只切内存状态、不写 prefs：这是一次性浏览动作，用户选好的摆法（在途一屏）不该被顺手改掉。
   */
  function tripOpenRow(row: any, e?: MouseEvent): void {
    const t = (e && (e.target as HTMLElement | null)) || null
    if (t && typeof t.closest === 'function' && t.closest('button')) return
    pvSelected.value = row?.id || ''
    pvView.value = 'master'
  }

  /**
   * 「📝 建契约文件」：让方寸在该项目文件夹里**创建**「立项契约.md」。
   *
   * 2026-10-05 用户口径：「让方寸直接写仓库文件更方便，用户打字输错一个字可能就无法识别。
   * 弹窗让用户确认权限即可，方寸不静默做。」→ 先弹确认框把「写到哪 / 写什么 / 什么情况拒绝」
   * 念清楚，再动手；主进程侧只建不覆盖。
   */
  async function tripInitContract(row: any): Promise<void> {
    const repo = String(row?.repo || '')
    if (!repo) {
      showToast('这个项目还没登记文件夹路径 —— 先在项目设置里补上', 'error')
      return
    }
    const msg = `让方寸在项目文件夹里创建「立项契约.md」？\n\n`
      + `写到哪里：${repo}\\立项契约.md\n`
      + `写什么：一份空白契约（六个小节 + 五条通用条款）—— 里面的内容由你或 AI 之后填\n`
      + `安全：这个文件已经存在的话，方寸会直接拒绝，不会覆盖\n\n`
      + `确认创建吗？`
    if (!confirm(msg)) return
    try {
      const res: any = await (window as any).tegula.tripInitContract(row.id)
      if (!res?.ok) { showToast('创建失败：' + (res?.error || '未知错误'), 'error'); return }
      showToast(`已创建：${res.path} —— 打开它填内容，或者交给 AI 填`, 'success')
      await loadTripBoard()
    } catch (e: any) {
      showToast('创建异常：' + (e?.message || e), 'error')
    }
  }

  /** 契约某一节的正文 → 一行摘要（表格里放不下整节；完整版在仓库文件里，agent 自己去读） */
  function tripFirstLine(text: unknown): string {
    const s = String(text || '').trim()
    if (!s) return ''
    for (const raw of s.split('\n')) {
      const t = raw.trim().replace(/^[#>\-*\s]+/, '').replace(/\*\*/g, '').trim()
      if (t) return t.length > 84 ? t.slice(0, 84) + '…' : t
    }
    return ''
  }

  /**
   * 契约「终态」为空时，**把原因说清楚**（2026-10-11 真机修正）。
   *
   * 触发的真事：绒花墨坊的契约用「① 终态三段 / ② 原料边界 / ⑥ 验收锚点」这套自定义小节名，
   * 方寸只认标准六节名 → 六个字段全空 → 界面写「内容未填」。用户当场反问「已经有内容了啊？」。
   * **把"小节名对不上"说成"未填"，就是界面说假话** —— 比空白更糟，因为它让人以为文件是空的。
   * 三种原因分开说：模板占位 / 小节名对不上（并把文件里实际的小节列出来）/ 真没写。
   */
  function tripContractMissing(r: any): { text: string; title: string } {
    const c = r && r.contract
    if (!c || !c.exists) return { text: '未填', title: '' }
    if ((c.placeholderFields || []).includes('终态形态')) {
      return { text: '还是模板占位（没填）', title: '这一节在文件里只是"该写什么"的说明，不是内容' }
    }
    const unmatched: string[] = c.unmatched || []
    const sections: { name: string; field: string | null }[] = c.sections || []
    if (unmatched.length) {
      return {
        text: '小节名不在标准六节里',
        title: '文件里的小节是：' + sections.map(s => s.name).join(' / ')
          + '\n\n方寸只认名字里含标准字段名（或别名）的小节：\n'
          + '终态形态 · 验收线 · 不要什么 · 选型定死 · 现状底数 · 下一队列\n\n'
          + '（文件不是空的 —— 把小节标题改成上面这类名字，就能被读到了）',
      }
    }
    return { text: '这一节空着', title: c.path || '' }
  }

  /** 手动模式下勾选/取消一个项目（零硬编码：清单只存在于用户的选择里） */
  function tripToggleManual(id: string): void {
    const set = new Set(tripManualIds.value)
    if (set.has(id)) set.delete(id)
    else set.add(id)
    tripManualIds.value = Array.from(set)
    // 勾选就说明"我要自己定" → 自动切到手动模式。
    // （2026-10-05 用户：「收哪些项目里勾选「测试」也看不到」—— 因为他勾完了模式还在「自动」，
    //   勾选根本没生效。两个互相耦合的控件不该指望用户自己悟出先后关系。）
    if (tripManualIds.value.length) tripMode.value = 'manual'
    void tripApplySettings()
  }

  function tripToggleCol(c: string): void {
    const set = new Set(tripCols.value)
    if (set.has(c)) set.delete(c)
    else set.add(c)
    // 至少留一列，否则表格只剩项目名（用户会以为坏了）
    tripCols.value = set.size ? Array.from(set) : ['end']
    void tripApplySettings()
  }

  // 切到「在途一屏」时按需拉一次数据（放在 watch 里而不是 setViewMode 内 —— 后者被 e2e-prefs 的
  // 源码断言盯着「两个 saveUiPref 之间的距离」，塞逻辑进去会把那条断言挤红）。
  watch(pvView, (v) => { if (v === 'trip') void loadTripBoard() })

  return {
    TRIP_CRITERIA_OPTIONS, TRIP_COL_OPTIONS,
    tripRows, tripHidden, tripError, tripLoading, msGitRow,
    tripSettingsOpen, tripMeta, tripMode, tripCriteria, tripManualIds, tripCols, tripHealthOverrides,
    tripSubtitle, tripEmptyHint, tripHiddenNotPicked, tripHiddenNoActivity,
    loadTripBoard, tripColVisible, tripHealthLabel, tripHealthClass,
    tripCycleHealth, tripUnlockHealth, tripApplySettings,
    tripSetMode, tripSetCriteria, tripCloseAfterSave, tripBackToAuto, tripResetSettings,
    tripCopyContract, contractFillPrompt, tripCopyContractPrompt,
    tripOpenRepo, tripOpenContract, tripOpenRow, tripInitContract,
    tripFirstLine, tripContractMissing, tripToggleManual, tripToggleCol,
  }
}
