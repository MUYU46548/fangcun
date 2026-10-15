import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * shadcn 惯例的类名合并器：`clsx` 拼条件类 + `tailwind-merge` 去掉**同组冲突**
 * （`w-full` 与 `w-[150px]` 只留后者）。
 *
 * ⚠ 为什么必须用它而不是直接拼字符串：组件自带默认类，使用方想覆盖时，
 *   两边都会落在 `<input class="… w-full … w-[150px]">` 里 —— 谁赢取决于
 *   **Tailwind 产物里的规则顺序**，而不是 class 书写顺序。那是不确定的，
 *   属于「静默错版」。过一层 twMerge 就变成确定行为。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
