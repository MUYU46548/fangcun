/**
 * 备份 / Git 通道 / 导出 —— 从 App.vue 切出来的第一块「领域逻辑」（2026-10-30 拆分第四刀）。
 *
 * 为什么先切它：App.vue 里它是一整块**连续、只依赖 window.tegula 与 toast** 的代码
 * （备份 v2 + 导出 + Git 通道 + 校验/恢复/选目录），边界清楚、能一次搬完。
 *
 * ⚠ 纪律：
 *  · 状态仍由这里持有（ref），App 只解构使用 —— 不引入第二份备份状态；
 *  · toast 由调用方注入（同一套提示条，不另造 UI）；
 *  · 备份状态推送的订阅在卸载时退订（与原来 App 里的清理时机一致）。
 */
import { computed, onUnmounted, ref } from 'vue'
import { formatDateTime } from '../../shared/time'

export interface UseBackupOptions {
  toast: (msg: string, type?: 'success' | 'error' | 'info') => void
}

export function useBackup(opts: UseBackupOptions) {
  const toast = opts.toast
  // ── 备份 v2（WebDAV + 静默调度 + 可验证恢复） ────────────────────────

  interface BkForm {
    url: string
    username: string
    password: string
    hasPassword: boolean
    enabled: boolean
    intervalHours: number
    firstDelayMinutes: number
    localKeep: number
    remoteKeep: number
    allowSelfSigned: boolean
    localDir: string
    /** 备份瘦身（2026-10-11 用户第 2 条） */
    excludeLogAttachments: boolean
    maxFileMB: number
  }

  const bkForm = ref<BkForm>({
    url: '', username: '', password: '', hasPassword: false,
    enabled: true, intervalHours: 6, firstDelayMinutes: 5,
    localKeep: 10, remoteKeep: 10, allowSelfSigned: false, localDir: '',
    excludeLogAttachments: false, maxFileMB: 10,
  })
  /** 备份体积报告（进门时拉一次；改瘦身旋钮后重拉）*/
  const bkSize = ref<any>(null)
  const bkMsg = ref('')
  const bkMsgType = ref('info')
  const bkBusy = ref(false)
  const bkTesting = ref(false)
  const bkTab = ref<'local' | 'remote'>('local')
  const bkLocal = ref<any[]>([])
  const bkRemote = ref<any[]>([])
  const bkStatus = ref<any>({ enabled: false, running: false, nextRunAt: null, state: {} })
  const bkState = computed<any>(() => bkStatus.value.state || {})
  const bkShowLog = ref(false)
  const bkLogLines = ref<string[]>([])
  const bkVerifyResult = ref<any>(null)
  let bkUnsub: (() => void) | null = null

  const bkCurrentList = computed(() => (bkTab.value === 'local' ? bkLocal.value : bkRemote.value))
  const bkAlert = computed(() => !bkStatus.value.running && (bkState.value.failStreak || 0) > 0)

  const bkDotClass = computed(() => {
    if (bkStatus.value.running) return 'bk-running'
    if ((bkState.value.failStreak || 0) > 0) return 'bk-bad'
    if (bkState.value.lastSuccessAt) return 'bk-ok'
    return 'bk-idle'
  })

  const bkStatusText = computed(() => {
    const st = bkState.value
    if (bkStatus.value.running) return '正在备份…'
    if ((st.failStreak || 0) > 0) return `连续失败 ${st.failStreak} 次`
    if (st.lastSuccessAt) return `上次成功 ${bkFmt(st.lastSuccessAt)} · ${st.lastFiles || 0} 个文件`
    return bkStatus.value.enabled || bkStatus.value.intervalHours ? '尚未执行过备份' : '自动备份已关闭'
  })

  const bkTooltip = computed(() => {
    const parts = ['备份：' + bkStatusText.value]
    if (bkState.value.lastRemotePath) parts.push('云端：已同步')
    else if (bkForm.value.url) parts.push('云端：未同步')
    return parts.join(' · ')
  })

  function bkFmt(ts: string | null | undefined): string {
    if (!ts) return '—'
    return formatDateTime(ts)
  }

  async function bkInitBackup() {
    await bkRefreshStatus()
    try {
      bkUnsub = window.tegula.onBackupStatus((s: any) => { bkStatus.value = s })
    } catch { /* 订阅失败不影响手动操作 */ }
  }

  async function bkRefreshStatus() {
    const r = await window.tegula.backupStatus()
    if (r.ok) bkStatus.value = r.status
  }

  async function bkLoadConfig() {
    const r = await window.tegula.backupGetConfig()
    if (!r.ok) return
    const c = r.config
    bkForm.value = {
      url: c.remote.url || '',
      username: c.remote.username || '',
      password: '',
      hasPassword: !!c.remote.hasPassword,
      enabled: !!c.enabled,
      intervalHours: c.intervalHours,
      firstDelayMinutes: c.firstDelayMinutes,
      localKeep: c.localKeep,
      remoteKeep: c.remoteKeep,
      allowSelfSigned: !!c.remote.allowSelfSigned,
      localDir: c.localDir || '',
      excludeLogAttachments: !!(c.slim && c.slim.excludeLogAttachments),
      maxFileMB: (c.slim && typeof c.slim.maxFileMB === 'number') ? c.slim.maxFileMB : 10,
    }
  }

  /**
   * 体积报告（2026-10-11 用户第 2 条）。
   * 「包怎么这么大」此前是**答不上来的** —— 界面只给一个 62.6MB 的结果。
   * 这里把构成摊开：谁最占地方、当前的瘦身旋钮会跳过什么、跳过多少。
   */
  async function bkLoadSizeReport(): Promise<void> {
    try {
      const r: any = await (window as any).tegula.backupSizeReport()
      bkSize.value = r?.ok ? r.report : null
    } catch { bkSize.value = null }
  }

  /** 人类可读体积 */
  function bkMB(bytes: number | null | undefined): string {
    const n = Number(bytes) || 0
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
    return (n / 1024 / 1024).toFixed(1) + ' MB'
  }

  async function bkLoadList() {
    const l = await window.tegula.backupListLocal()
    if (l.ok) bkLocal.value = l.items
    if (bkTab.value === 'remote') {
      const rr = await window.tegula.backupListRemote()
      bkRemote.value = rr.ok ? rr.items : []
    }
  }

  // ── 导出备份（2026-09-26 用户第 1、2 条：一次点击、只落一个 zip）────────
  // 用户原话：「导出又是导出四个文件，我只认识压缩包…只应该存在一样东西」＋
  //          「导出的备份文件要手动选下拉列表…必须逐字核对，很难受」。
  // 因此这里没有下拉了：直接取**最新一份已有备份**，点一下就导出（主进程只落一个 zip）；
  // 一份备份都没有时才让主进程现打一份全量包。
  /** 已有备份按**最后更新**倒序（2026-09-25 第 5 条：用户要的是"最后更新的排前面"） */
  const bkExportCandidates = computed(() =>
    [...(bkLocal.value || [])].sort((a: any, b: any) =>
      (Date.parse(b.mtime || '') || 0) - (Date.parse(a.mtime || '') || 0)
      || String(b.name || '').localeCompare(String(a.name || '')))
  )

  /** 最新一份已有备份的路径；没有备份时返回空串（= 让主进程现打一份） */
  function bkLatestPackagePath(): string {
    return bkExportCandidates.value.length ? String(bkExportCandidates.value[0].path || '') : ''
  }


  function bkSwitchTab(t: 'local' | 'remote') {
    bkTab.value = t
    bkLoadList()
  }

  /** 刷新备份列表 + 状态 + 体积报告（用户 2026-10-11：设置页缺一个刷新按钮） */
  async function bkRefreshList(): Promise<void> {
    await bkLoadList()
    await bkRefreshStatus()
    void bkLoadSizeReport()
  }

  async function bkSaveConfig(silent = false): Promise<boolean> {
    const f = bkForm.value
    const patch: any = {
      enabled: f.enabled,
      intervalHours: f.intervalHours,
      firstDelayMinutes: f.firstDelayMinutes,
      localKeep: f.localKeep,
      remoteKeep: f.remoteKeep,
      localDir: f.localDir.trim(),
      remote: {
        url: f.url.trim(),
        username: f.username.trim(),
        allowSelfSigned: f.allowSelfSigned,
      },
      slim: { excludeLogAttachments: f.excludeLogAttachments, maxFileMB: f.maxFileMB },
    }
    // 留空 = 沿用已保存密文；只有真输入了新密码才提交
    if (f.password.trim()) patch.remote.password = f.password.trim()

    const r = await window.tegula.backupSetConfig(patch)
    if (!r.ok) {
      bkMsg.value = '保存失败：' + (r.error || '未知错误')
      bkMsgType.value = 'error'
      return false
    }
    bkForm.value.password = ''
    bkForm.value.hasPassword = !!r.config.remote.hasPassword
    if (!silent) {
      bkMsg.value = '配置已保存'
      bkMsgType.value = 'success'
    }
    await bkRefreshStatus()
    return true
  }

  /**
   * 只保存「备份瘦身」两项，并立刻重算体积报告 —— 勾一下就能看到"能省多少"。
   * 单开一个函数是为了让勾选**立即生效**，不用先滚到下面点「保存配置」。
   */
  async function bkSaveSlim(): Promise<void> {
    const r: any = await (window as any).tegula.backupSetConfig({
      slim: { excludeLogAttachments: bkForm.value.excludeLogAttachments, maxFileMB: bkForm.value.maxFileMB },
    })
    if (!r?.ok) {
      bkMsg.value = '瘦身设置保存失败：' + (r?.error || '未知错误')
      bkMsgType.value = 'error'
      return
    }
    bkMsg.value = '瘦身设置已保存'
    bkMsgType.value = 'success'
    await bkLoadSizeReport()
  }

  function bkReportResult(r: any, label: string) {
    const res = r.result
    if (r.ok && res) {
      // 2026-10-11 用户第 2 条：报**包的大小**（localBytes = zip 实际体积），别只报原始字节数 ——
      // 用户关心的是"网盘要传多大"，不是"文本加起来多少"。
      const zipMB = res.localBytes ? (res.localBytes / 1024 / 1024).toFixed(1) + ' MB' : ''
      const om = (res.omittedFiles && res.omittedFiles.length)
        ? ` · 瘦身跳过 ${res.omittedFiles.length} 个（省 ${bkMB(res.omittedBytes)}，见包内 manifest）`
        : ''
      bkMsg.value = `${label}成功 · ${res.files} 个文件${zipMB ? ' · 包 ' + zipMB : ''}` +
        (res.remotePath ? ' · 已上云' : ' · 仅本地') + om
      bkMsgType.value = res.remotePath ? 'success' : 'info'
      void bkLoadSizeReport()
    } else {
      const first = (res && res.errors && res.errors[0]) || r.error || '未知错误'
      const extra = res && res.warnings && res.warnings.length ? `（${res.warnings[0]}）` : ''
      bkMsg.value = `${label}失败：${first}${extra}`
      bkMsgType.value = 'error'
    }
  }

  async function bkSaveAndRun() {
    if (bkBusy.value) return
    if (!(await bkSaveConfig(true))) return
    bkBusy.value = true
    bkMsg.value = ''
    try {
      bkReportResult(await window.tegula.backupRun(), '备份')
    } finally {
      bkBusy.value = false
      await bkLoadList()
      await bkRefreshStatus()
    }
  }

  async function bkRunLocalOnly() {
    if (bkBusy.value) return
    bkBusy.value = true
    bkMsg.value = ''
    try {
      bkReportResult(await window.tegula.backupRunLocalOnly(), '本地备份')
    } finally {
      bkBusy.value = false
      await bkLoadList()
      await bkRefreshStatus()
    }
  }

  async function bkTestRemote() {
    if (bkTesting.value) return
    bkTesting.value = true
    bkMsg.value = ''
    try {
      const r = await window.tegula.backupTestRemote({
        url: bkForm.value.url.trim(),
        username: bkForm.value.username.trim(),
        password: bkForm.value.password.trim(),
        allowSelfSigned: bkForm.value.allowSelfSigned,
      })
      bkMsg.value = (r.ok ? '✅ ' : '❌ ') + (r.detail || r.error || '测试失败')
      bkMsgType.value = r.ok ? 'success' : 'error'
    } finally {
      bkTesting.value = false
    }
  }

  async function bkRestore(b: any) {
    if (bkBusy.value) return
    const where = bkTab.value === 'local' ? '本地' : '远端'
    if (!confirm(`确认从${where}备份恢复？\n\n${b.name}\n\n当前数据会先做快照，恢复失败将自动回滚。`)) return
    bkBusy.value = true
    try {
      const source = bkTab.value === 'local'
        ? { kind: 'local', path: b.path }
        : { kind: 'remote', name: b.name }
      const r = await window.tegula.backupRestore(source)
      if (r.ok) {
        bkMsg.value = `已恢复 ${r.restoredFiles} 个文件；恢复前快照：${r.snapshotDir || '(无)'}`
        bkMsgType.value = 'success'
        await loadAll()
      } else {
        bkMsg.value = '恢复失败：' + ((r.errors && r.errors[0]) || r.error || '未知错误')
        bkMsgType.value = 'error'
      }
    } finally {
      bkBusy.value = false
      await bkLoadList()
    }
  }

  async function bkOpenDir() {
    const r = await window.tegula.backupOpenDir()
    if (!r.ok) bkMsg.value = '打开目录失败：' + (r.error || '')
  }

  async function bkToggleLog() {
    bkShowLog.value = !bkShowLog.value
    if (bkShowLog.value) {
      const r = await window.tegula.backupLog(150)
      if (r.ok) bkLogLines.value = r.lines
    }
  }

  async function bkPickDir() {
    const r = await window.tegula.backupPickDir()
    if (r.ok && r.dir) bkForm.value.localDir = r.dir
  }

  // ── Git 通道（2026-10-11，卡 20261002-003）──────────────────────────────
  // 把备份 zip 推到一个 git 仓库。方寸的数据本身不入 git（既定决策）→ **只推不拉、没有冲突**。
  // ⚠ 令牌只在这里出现**一次**（用户填进来那一瞬），保存后立刻清空输入框；
  //   主进程只回 `hasToken` 布尔，从不回传令牌本身。
  const gitRemote = ref('')
  const gitBranch = ref('main')
  const gitToken = ref('')
  const gitHasToken = ref(false)
  const gitBusy = ref(false)
  const gitMsg = ref('')
  const gitMsgType = ref<'success' | 'info' | 'error'>('info')

  async function loadGitStatus(): Promise<void> {
    try {
      const r: any = await (window as any).tegula.backupGitStatus()
      if (r?.ok) {
        gitRemote.value = r.config?.remote || ''
        gitBranch.value = r.config?.branch || 'main'
        gitHasToken.value = !!r.hasToken
      }
    } catch { /* 读不到就留空 —— 不编默认值 */ }
  }

  /**
   * 把当前表单里的仓库地址 / 分支 / 令牌落盘。
   * ⚠ 2026-10-11 真机教训：主进程只读**已保存**的配置，而用户很自然的是
   *   「填完地址直接点测试连接」→ 于是被回一句「还没填仓库地址」，看着像软件坏了。
   *   所以测试 / 推送前一律先跑一次这个，把输入框里的东西先存住。
   * 返回 false = 地址是空的（真没填），调用方直接提示即可。
   */
  async function gitCommitForm(): Promise<boolean> {
    const remote = gitRemote.value.trim()
    if (!remote) { gitMsg.value = '请先填仓库地址'; gitMsgType.value = 'error'; return false }
    const r: any = await (window as any).tegula.backupGitSave({ remote, branch: gitBranch.value })
    if (!r?.ok) { gitMsg.value = '保存失败：' + (r?.error || '未知错误'); gitMsgType.value = 'error'; return false }
    if (r.extractedTokenSaved) { gitHasToken.value = true; gitToken.value = '' }
    else if (gitToken.value.trim()) {
      const t: any = await (window as any).tegula.backupGitSaveToken(gitToken.value.trim())
      if (t?.ok) { gitToken.value = ''; gitHasToken.value = true }
    }
    return true
  }

  async function gitSaveConfig(): Promise<void> {
    if (gitBusy.value) return
    gitBusy.value = true
    gitMsg.value = ''
    try {
      if (!(await gitCommitForm())) return
      gitMsg.value = '仓库地址已保存'
      gitMsgType.value = 'success'
      await loadGitStatus()
    } catch (e: any) { gitMsg.value = '保存异常：' + (e?.message || e); gitMsgType.value = 'error' }
    finally { gitBusy.value = false }
  }

  async function gitForgetToken(): Promise<void> {
    try {
      await (window as any).tegula.backupGitClearToken()
      gitHasToken.value = false
      gitMsg.value = '已清除本机保存的令牌（仓库地址保留）'
      gitMsgType.value = 'info'
    } catch (e: any) { gitMsg.value = '清除失败：' + (e?.message || e); gitMsgType.value = 'error' }
  }

  async function gitTest(): Promise<void> {
    if (gitBusy.value) return
    gitBusy.value = true
    gitMsg.value = '测试中…'
    gitMsgType.value = 'info'
    try {
      // 先把输入框里的地址/令牌存住 —— 否则主进程读到的是旧配置，会回一句"还没填仓库地址"
      if (!(await gitCommitForm())) return
      const r: any = await (window as any).tegula.backupGitTest()
      // ⚠ 主进程有两条失败形状：业务失败回 `message`，异常被 guardedHandle 兜住时回 `error`
      //   （backup-ipc 的 fail() 就是这个形状）。只认 message 的话，异常会显示成
      //   "测试没有返回结果" —— 典型的静默失败。两个都读，实在没有才说没返回。
      gitMsg.value = r?.message || r?.error || '测试没有返回结果'
      gitMsgType.value = r?.ok ? 'success' : 'error'
    } catch (e: any) { gitMsg.value = '测试异常：' + (e?.message || e); gitMsgType.value = 'error' }
    finally { gitBusy.value = false }
  }

  async function gitPushNow(): Promise<void> {
    if (gitBusy.value) return
    gitBusy.value = true
    gitMsg.value = '同步中…（把真实文件铺进仓库再提交推送）'
    gitMsgType.value = 'info'
    try {
      if (!(await gitCommitForm())) return
      // 2026-10-11 用户第 1 条：同步**真实文件**（不是压缩包）—— 参数已无意义，不再传路径。
      const r: any = await (window as any).tegula.backupGitPush()
      gitMsg.value = r?.message || r?.error || '同步没有返回结果'
      gitMsgType.value = r?.ok ? 'success' : 'error'
      if (r?.ok) gitHasToken.value = true
    } catch (e: any) { gitMsg.value = '同步异常：' + (e?.message || e); gitMsgType.value = 'error' }
    finally { gitBusy.value = false }
  }

  /**
   * restic 增量备份脚本（2026-10-11 用户拍板「方案 A」）。
   * 方寸只**生成脚本 + 说明**并复制走 —— 定时你自己挂，仓库密码也只在你自己环境里。
   * 为什么不做成方寸内建：那要方寸管仓库密码（进 safeStorage）+ 随包分发 restic 二进制，包会变大。
   */
  async function bkCopyResticScript(): Promise<void> {
    try {
      const r: any = await (window as any).tegula.backupResticScript('win')
      if (!r?.ok) { toast('生成 restic 脚本失败：' + (r?.error || '未知错误'), 'error'); return }
      const ok = await copyWithToast(r.script, 'restic 脚本已复制')
      if (ok) toast('粘进一个 .ps1 文件：脚本开头写了三步准备（装 restic / 设两个环境变量 / init），照做后挂到任务计划程序', 'info')
    } catch (e: any) {
      toast('生成 restic 脚本异常：' + (e?.message || e), 'error')
    }
  }

  /** 导出到任意目录（典型用途：网盘同步文件夹，由客户端负责上传） */
  async function bkExportTo() {
    if (bkBusy.value) return
    bkBusy.value = true
    bkMsg.value = ''
    try {
      // 2026-09-26 用户第 1、2 条：不再让用户挑包，直接导最新那份（没有才现打）；
      // 主进程只落一个 zip，所以这里报的就是「那一个文件」。
      const latest = bkLatestPackagePath()
      const r = await window.tegula.backupExportTo(latest ? { package: latest } : {})
      if (r.canceled) return
      if (r.ok) {
        const res = r.result
        const name = String(res.zipPath || '').split(/[\\/]/).pop() || 'zip'
        bkMsg.value = `已导出 ${name}（1 个文件 · ${(res.bytes / 1024).toFixed(0)} KB）→ ${res.dir}`
        bkMsgType.value = 'success'
        if (res.errors && res.errors.length) {
          bkMsg.value += ' ｜ 提醒：' + res.errors[0]
          bkMsgType.value = 'info'
        }
      } else {
        bkMsg.value = '导出失败：' + ((r.result && r.result.errors && r.result.errors[0]) || r.error || '未知错误')
        bkMsgType.value = 'error'
      }
    } finally {
      bkBusy.value = false
    }
  }

  /** 被点开查看的那一行（只做视觉标记，避免"点了好像没反应"） */
  const bkInspected = ref('')

  /**
   * 点某一行备份 = **看这一份里到底有什么**（2026-09-28 卡 026-001 的验收驳回）。
   *
   * 用户原话：「依然不能手动点来选中备份，回收站都能点了，备份不能点，无语。」
   * 真因：`.bk-item` 是一个**没有 @click 的死 div**，行上只有「恢复」按钮；
   * 想确认内容只能另点「🔍 校验备份包…」——那会弹文件选择器，让人从零开始找那个 zip，
   * 而这一份明明就在眼前。
   *
   * 复用现成的 `backup:verifyPackage`（它本来就支持直接传路径）。
   * 远端行不下载就不校验 —— 说实话告诉用户，不假装能看。
   */
  async function bkInspectRow(b: any) {
    if (bkBusy.value) return
    if (bkTab.value === 'remote') {
      toast('远端备份要先下载到本地才能看内容；点「恢复」会自动下载并校验', 'info')
      return
    }
    const p = String(b?.path || '')
    if (!p) { toast('这一行没有可用路径', 'error'); return }
    bkBusy.value = true
    try {
      const r = await window.tegula.backupVerifyPackage(p)
      if (r && r.canceled) return
      bkInspected.value = String(b.name || '')
      bkVerifyResult.value = {
        ok: !!(r && r.ok),
        name: String((r && r.path) || p).split(/[\\/]/).pop() || '',
        errors: (r && r.errors) || [],
        manifest: (r && r.manifest) || null,
        entries: (r && r.entries) || 0,
      }
    } catch (e: any) {
      toast('查看失败：' + (e?.message || e), 'error')
    } finally {
      bkBusy.value = false
    }
  }

  /** 校验任意位置的备份包（含从网盘下载回来的副本） */
  async function bkVerifyPackage() {
    if (bkBusy.value) return
    bkBusy.value = true
    bkVerifyResult.value = null
    try {
      const r = await window.tegula.backupVerifyPackage()
      if (r.canceled) return
      bkVerifyResult.value = {
        ok: !!r.ok,
        name: String(r.path || '').split(/[\\/]/).pop() || '',
        errors: r.errors || [],
        manifest: r.manifest || null,
        entries: r.entries || 0,
      }
    } finally {
      bkBusy.value = false
    }
  }

  /** 从任意 zip 文件恢复（先校验，校验不过不动数据） */
  async function bkRestoreFromFile() {  if (bkBusy.value) return
    const pick = await window.tegula.backupPickRestoreFile()
    if (!pick.ok || !pick.path) return
    const name = String(pick.path).split(/[\\/]/).pop()
    if (!confirm(
      `确认从该文件恢复？\n\n${name}\n\n` +
      `恢复前会先做完整性校验；校验不通过则不会改动任何数据。\n` +
      `现有数据会自动打快照，替换失败会回滚。`
    )) return
    bkBusy.value = true
    try {
      const r = await window.tegula.backupRestore({ kind: 'local', path: pick.path })
      if (r.ok) {
        bkMsg.value = `已恢复 ${r.restoredFiles} 个文件；恢复前快照：${r.snapshotDir || '(无)'}`
        bkMsgType.value = 'success'
        await loadAll()
      } else {
        bkMsg.value = '恢复失败：' + ((r.errors && r.errors[0]) || r.error || '未知错误')
        bkMsgType.value = 'error'
      }
    } finally {
      bkBusy.value = false
      await bkLoadList()
    }
  }

  onUnmounted(() => {
    if (bkUnsub) { try { bkUnsub() } catch { /* ignore */ } ; bkUnsub = null }
  })

  return {
    bkForm, bkSize, bkMsg, bkMsgType, bkBusy, bkTesting, bkTab, bkLocal, bkRemote, bkStatus, bkState, bkShowLog, bkLogLines, bkVerifyResult, bkCurrentList, bkAlert, bkDotClass, bkStatusText, bkTooltip, bkFmt, bkInitBackup, bkRefreshStatus, bkLoadConfig, bkLoadSizeReport, bkMB, bkLoadList, bkExportCandidates, bkLatestPackagePath, bkSwitchTab, bkRefreshList, bkSaveConfig, bkSaveSlim, bkReportResult, bkSaveAndRun, bkRunLocalOnly, bkTestRemote, bkRestore, bkOpenDir, bkToggleLog, bkPickDir, gitRemote, gitBranch, gitToken, gitHasToken, gitBusy, gitMsg, gitMsgType, loadGitStatus, gitCommitForm, gitSaveConfig, gitForgetToken, gitTest, gitPushNow, bkCopyResticScript, bkExportTo, bkInspected, bkInspectRow, bkVerifyPackage, bkRestoreFromFile
  }
}
