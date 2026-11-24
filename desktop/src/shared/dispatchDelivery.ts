/**
 * 「派单到底有没有人接」的口径（2026-11-24 · 暮雨第 8 条）
 *
 * 原话：「如果 DSH 未启动，方寸的 DSH 联动功能（各种派单类）是否会有智能的处理方式？
 * 还是卡着骗用户已成功？」
 *
 * ## 改之前是什么样（诚实的答案：会骗）
 *
 * 方寸这一侧只做一件事：把任务书写进 `<数据根>/.dispatch-dsh/`。
 * 真正开会话的是 **DSH 里的插件**（8 秒一拍去取）。所以：
 *
 *   DSH 没开 → 没人来取 → 文件一直躺着；
 *   而界面弹的是**绿色**的「已发送给 DSH：「X」的上下文包（12345 字）—— DSH 那边会冒出一个新会话」。
 *
 * 用户看到的每个字都在说"成了"，实际什么都不会发生 —— 这就是"卡着骗用户已成功"。
 *
 * ## 现在怎么分（**只认能核实的东西**）
 *
 * | 观察到 | delivery | 话怎么说 |
 * |---|---|---|
 * | 探测到消费方（DSH 在跑 + 插件装着） | `will-consume` | 已排队，约 8 秒内会被取走 |
 * | 只是文件落了盘 | `queued` | **已排队，等 DSH 打开后才会开工** |
 * | 宿主回报真的开了会话 | `sent` | 已发送 |
 *
 * ⚠ 三条硬规矩：
 *   ① 探测**失败**不等于探到了"没人"：读不到就说读不到，但结论仍归到 `queued`
 *      （宁可说得保守，也不能说成成功）；
 *   ② `queued` 的文案**不许**出现"已发送 / 已开工 / 会冒出一个新会话"这类既成事实的说法；
 *   ③ 判定只在这一个函数里，界面不许自己再编一套 —— 两份口径迟早说成两件事。
 */

/** 消费方是否在场（由主进程探测后传入，**不是**界面猜的） */
export interface DispatchConsumerProbe {
  /** 探测跑了没有（没跑 = unknown，不许当成"没有"） */
  checked: boolean
  /** DSH 进程在不在跑 */
  running: boolean
  /** 方寸插件装没装进那个 profile */
  pluginInstalled: boolean
  /** 探测怎么得出结论的（一句话，给 title 用） */
  evidence?: string
}

export type DispatchDelivery = 'queued' | 'will-consume' | 'sent'

export interface DispatchDeliveryVerdict {
  delivery: DispatchDelivery
  /** 界面可直接显示的一句话 */
  hint: string
  /** 用户此刻**该不该**去 DSH 看（queued 且没人接 = 去了也看不到） */
  consumerPresent: boolean
}

/**
 * 消费方在场吗。`checked:false`（探测没跑）**不算在场** ——
 * "不知道"永远不能当"在"用。
 */
export function consumerPresent(probe: DispatchConsumerProbe | undefined | null): boolean {
  if (!probe || !probe.checked) return false
  return !!probe.running && !!probe.pluginInstalled
}

/**
 * 派单落盘之后，这句话该怎么说。
 *
 * @param probe 消费方探测结果（可缺：缺了按"没核实到"处理）
 * @param chars 派单正文长度（只用于把话说具体）
 */
export function describeDispatchDelivery(
  probe: DispatchConsumerProbe | undefined | null,
  chars = 0,
): DispatchDeliveryVerdict {
  const size = chars > 0 ? `（${chars} 字）` : ''
  if (consumerPresent(probe)) {
    return {
      delivery: 'will-consume',
      consumerPresent: true,
      hint: `已排队${size}，DSH 那边几秒内会取走并开一个新会话`,
    }
  }
  // ⚠ 这里是本文件存在的理由：没有证据表明有人来接，就**不能说已经发出去了**。
  const why = !probe || !probe.checked
    ? '没核实到 DSH 是否在运行'
    : (!probe.running
      ? 'DSH 现在没在运行'
      : 'DSH 在运行，但没检测到方寸插件')
  return {
    delivery: 'queued',
    consumerPresent: false,
    hint: `已排队${size}，但${why} —— 现在**不会**有人来取；打开 DSH 后它会自动开工（文件已在 .dispatch-dsh/ 里等着）`,
  }
}
