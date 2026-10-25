/**
 * 模型单价表（2026-10-25 卡 005 B 档）—— 存**用户自己填**的价格，不存任何默认值。
 *
 * 为什么单独一个文件、不塞进 `llm-config.json`：那份是"通道配置"（端点/密钥/模型），
 * 这份是"报价假设"。混在一起会让"改单价"看起来像"改通道"，也容易在恢复配置时互相牵连。
 *
 * ⚠ 三条纪律：
 *  ① **绝不预填**：文件不存在 = 没有单价 = 一律未折算。空的比错的好。
 *  ② 坏文件**不覆盖**：先备份成 `.bad-<ts>` 再当空表用，并留日志（单价是人的劳动，不能一删了之）。
 *  ③ 只认 `元 / 1M tokens` 这一种口径：不碰美元、不碰汇率 —— 汇率是另一个账本问题。
 */
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { atomicWrite } from '../data'
import * as appLog from '../services/appLog'
import { cleanPriceRows, type PriceRow } from '../../shared/pricing'

const PRICES_NAME = 'model-prices.json'

interface StoredPrices {
  v: 1
  /** 2026-10-25：单价按"元/1M tokens"填，字符串定点（不存浮点） */
  rows: PriceRow[]
  updatedAt: string
}

function pricesPath(): string {
  return path.join(app.getPath('userData'), PRICES_NAME)
}

/** 读单价表。文件缺失/损坏都返回空表 —— "没有单价"是正常态，不是错误。 */
export function getPrices(): { rows: PriceRow[]; updatedAt: string; warn?: string } {
  const p = pricesPath()
  if (!fs.existsSync(p)) return { rows: [], updatedAt: '' }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
    const rows = cleanPriceRows(raw?.rows)
    return { rows, updatedAt: String(raw?.updatedAt || '') }
  } catch (e: any) {
    // 备份而不是覆盖：单价是人手填的，坏在格式上也别丢内容
    const bad = `${p}.bad-${Date.now()}`
    try { fs.renameSync(p, bad) } catch { /* 备份失败也不覆盖 */ }
    appLog.warn('prices', `单价表读不出来（已备份到 ${path.basename(bad)}），本次按"没有单价"处理`, e?.message || String(e))
    return { rows: [], updatedAt: '', warn: `单价表损坏，已备份到 ${path.basename(bad)}` }
  }
}

/** 保存单价表（整体替换）。返回清洗后的结果 —— 界面显示的必须是**真存下来的那份**。 */
export function setPrices(input: unknown): { ok: boolean; rows: PriceRow[]; error?: string } {
  const rows = cleanPriceRows(input)
  const payload: StoredPrices = { v: 1, rows, updatedAt: new Date().toISOString() }
  try {
    atomicWrite(pricesPath(), JSON.stringify(payload, null, 2))
    appLog.info('prices', `单价表已更新（${rows.length} 个模型）`)
    return { ok: true, rows }
  } catch (e: any) {
    appLog.error('prices', '单价表写盘失败', e?.message || String(e))
    return { ok: false, rows: getPrices().rows, error: `保存失败：${e?.message || e}` }
  }
}
