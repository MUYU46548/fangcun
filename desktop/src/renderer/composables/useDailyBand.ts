/**
 * 日志页顶部那条「每日推进面」（0.6.0 P2）
 *
 * 取数与选格都收在这里：`plansGet()` 是 P1 已有的读口（**不新增 IPC**），
 * 选格规则全在 `shared/dailyBand.ts`（纯函数，Node 可直跑），这里只做字段收敛。
 *
 * 什么时候重读：日志页挂载时（`LogsView` 的 onMounted 调 `loadDailyBand`）。
 * 裁决动作发生在项目页，不共享状态也没关系 —— 切回日志页就是新的一次读取。
 */
import { ref } from 'vue'
import {
  buildDailyBand,
  type DailyBandResult,
  type DailyPlanInput,
} from '../../shared/dailyBand'

interface RawDoc {
  file?: string
  title?: string
  stages?: Array<{
    id?: string
    title?: string
    status?: string
    criteria?: string[]
    verdict?: string
    missing?: string[]
  }>
}

export function useDailyBand() {
  const dailyBand = ref<DailyBandResult | null>(null)
  const dailyBandLoading = ref(false)
  /** 读取失败时的原因（读不到就说读不到，不渲染"空的计划"冒充"没有计划"） */
  const dailyBandError = ref('')

  async function loadDailyBand(): Promise<void> {
    dailyBandLoading.value = true
    dailyBandError.value = ''
    try {
      const api: any = (window as any).tegula
      if (!api || typeof api.plansGet !== 'function') {
        // 旧主进程：没有计划卡读口。不报错、不渲染 —— 这条带是增量能力。
        dailyBand.value = null
        return
      }
      const r: any = await api.plansGet()
      if (!r?.ok) {
        dailyBand.value = null
        dailyBandError.value = String(r?.error || '读取计划卡失败')
        return
      }
      const plans: DailyPlanInput[] = (Array.isArray(r.docs) ? r.docs : [])
        .filter((d: RawDoc) => d && typeof d.file === 'string')
        .map((d: RawDoc) => ({
          file: String(d.file || ''),
          title: String(d.title || ''),
          stages: (Array.isArray(d.stages) ? d.stages : []).map((s) => ({
            id: String(s?.id || ''),
            title: String(s?.title || ''),
            status: String(s?.status || ''),
            criteria: (Array.isArray(s?.criteria) ? s.criteria : []).map((c) => String(c ?? '')),
            verdict: String(s?.verdict || ''),
            missing: (Array.isArray(s?.missing) ? s.missing : []).map((m) => String(m ?? '')),
          })),
        }))
      // 目前没有执行器（P3）→ 不传 results：所有已冻结格子都算"未跑过"（fail-closed）。
      // P3/P4 落地后在这里把结果传进去即可，选格规则不用动。
      dailyBand.value = buildDailyBand(plans)
    } catch (e: any) {
      dailyBand.value = null
      dailyBandError.value = String(e?.message || e)
    } finally {
      dailyBandLoading.value = false
    }
  }

  return { dailyBand, dailyBandLoading, dailyBandError, loadDailyBand }
}
