/**
 * 「整段被一对括号包住 = 模板占位，不是内容」—— **TS 侧的单一来源**。
 *
 * 这条规则现在有三个使用点，判据必须一致（历史上正是各写一遍才出的错）：
 *
 *  1. **契约读取**（`main/services/tripBoard.ts`）：`（一句话：我一开始想要的就是 ___。）`
 *     这类骨架**不算填了** —— 司天的空表曾被显示成"已填"，就是因为它把骨架当正文。
 *  2. **日志 → 待办**（`renderer/App.vue`）：日志的「下一步」常常是 `（待填写）`，
 *     **不能当成真内容取来做待办标题**。2026-10-11 用户实测：整条待办只剩「（待填写）」，
 *     日志正文一个字没带过来 —— 他原话「内容全丢，变成空待办，本以为文本会留住的」。
 *  3. **Python 侧** `tegula/core.py` 的 `is_placeholder_body()` —— **同一规则的另一语言实现**。
 *     改这里必须同步改那边；`verify.py` 有跨语言守卫盯着（别名表就是这么盯的）。
 *
 * 判据刻意**极简**：真填的正文不会整段用一对括号包起来。宁可漏判成"有内容"，
 * 也不要过度识别把用户写的括号说明吃掉 —— 后者是**删内容**，前者只是少省一点事。
 */
export function isPlaceholderText(text: unknown): boolean {
  const s = String(text ?? '').trim()
  if (!s) return true
  for (const [a, b] of [['（', '）'], ['(', ')']] as const) {
    if (s.startsWith(a) && s.endsWith(b)
      && s.split(a).length - 1 === 1 && s.split(b).length - 1 === 1) return true
  }
  return false
}

/** 取第一行"像要点"的文字（去列表符 / 勾选框 / 序号）—— 日志的下一步与待办摘要共用 */
export function firstBulletLine(text: unknown): string {
  return String(text ?? '')
    .split('\n')
    .map(x => x.trim()
      .replace(/^[-*]\s*/, '')
      .replace(/^\[[ xX]\]\s*/, '')
      .replace(/^\d+[.)]\s*/, '')
      .trim())
    .filter(Boolean)[0] || ''
}
