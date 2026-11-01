/**
 * 投入产出账（0.6.0 P5）—— 渲染层取数
 *
 * 一个只读口 `waste:get`；三格的算法与"它证明不了什么"全在主进程/shared，
 * 这里只保留原样，不做二次加工（否则口径会在界面里长出第二份）。
 */
import { ref } from 'vue'
import { sanitizeWasteLedger, type WasteLedger } from '../../shared/waste'

export function useWasteLedger() {
  const wasteLedger = ref<WasteLedger | null>(null)
  const wasteLoading = ref(false)
  const wasteError = ref('')

  async function loadWasteLedger(days = 30): Promise<void> {
    wasteLoading.value = true
    wasteError.value = ''
    try {
      const api: any = (window as any).tegula
      if (!api || typeof api.wasteGet !== 'function') {
        // 旧主进程：没有这个读口 —— 不渲染，也不报"0"
        wasteLedger.value = null
        return
      }
      const r: any = await api.wasteGet({ days })
      if (!r?.ok) {
        wasteLedger.value = null
        wasteError.value = String(r?.error || '读取投入产出账失败')
        return
      }
      wasteLedger.value = sanitizeWasteLedger((r.ledger || null) as WasteLedger | null)
    } catch (e: any) {
      wasteLedger.value = null
      wasteError.value = String(e?.message || e)
    } finally {
      wasteLoading.value = false
    }
  }

  return { wasteLedger, wasteLoading, wasteError, loadWasteLedger }
}
