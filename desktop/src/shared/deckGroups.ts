/**
 * 问卷列表分组（2026-11-11 · 卡《问卷管理跟不上出卷速度》）
 *
 * 判据原文：「40 卷时打开问卷页，**首屏只出现待答卷**（已批准默认不占位）」
 * 「被取代的卷不许再出现在待答里（哪怕它还有未答题）」。
 *
 * 为什么抽成纯函数：这两条是**口径**，写在组件里就只能靠“看一眼界面对不对”。
 * 抽出来以后 e2e 可以拿 40 个假卷直接断言“谁是待答”，组件只负责渲染。
 */
export interface DeckLike {
  deck: string
  approved?: boolean
  voided?: boolean
  /** 本卷被谁取代（非空 = 已被取代，不再进待答） */
  replacedBy?: string
  /** 已归档（历史卷：不占列表，仍参与裁决） */
  archived?: boolean
}

/** 待答：没批准、没作废、没被取代、没归档 —— 四条缺一不可 */
export function isPendingDeck(d: DeckLike | null | undefined): boolean {
  if (!d) return false
  return !d.approved && !d.voided && !d.replacedBy && !d.archived
}

/** 已处理：批准 / 作废 / 被取代（历史卷单列，因为它只是“不占位”） */
export function isDoneDeck(d: DeckLike | null | undefined): boolean {
  if (!d) return false
  if (d.archived) return false
  return !!(d.approved || d.voided || d.replacedBy)
}

export function groupDecks<T extends DeckLike>(decks: T[]): { pending: T[]; done: T[]; archived: T[] } {
  const list = Array.isArray(decks) ? decks : []
  const byNameAsc = (a: DeckLike, b: DeckLike) => String(a.deck).localeCompare(String(b.deck))
  const byNameDesc = (a: DeckLike, b: DeckLike) => String(b.deck).localeCompare(String(a.deck))
  return {
    pending: list.filter(isPendingDeck).slice().sort(byNameAsc),
    done: list.filter(isDoneDeck).slice().sort(byNameDesc),
    archived: list.filter((d) => !!d.archived).slice().sort(byNameDesc),
  }
}
