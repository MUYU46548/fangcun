/**
 * 关闭防丢的**统一口径**（2026-10-03 卡 004 族1 收敛；2026-10-23 从 App.vue 抽出来）。
 *
 * 打开存快照、关闭逐字节比对、**改过才问**。收编的旧实现：方针卡/项目/应用曾走
 * `hasAnyText`（"有字就弹" = 确认疲劳，只改下拉/勾选反而静默丢），待办此前零防护。
 * 新增编辑类弹窗一律用它，**禁止再长第二种**。
 */
export const snapOf = (o: any): string => JSON.stringify(o ?? null)

/**
 * 关闭防丢统一口径（2026-10-03 卡 task-20261003-004·族1收敛）：
 * 打开存快照、关闭逐字节比对、**改过才问**。
 * 收编的旧实现：方针卡/项目/应用曾走 hasAnyText（「有字就弹」= 确认疲劳，只改下拉/勾选
 * 则静默丢——P0-1 判错一直没迁移）；待办此前零防护（closeTodoEditor 裸置 null）。
 * 任务/日志编辑器已是同口径（taskEditSnap/logSnapNow，注释明写「不另发明」）——
 * 本函数是该口径的可复用形态：新增编辑类弹窗一律 makeDirtyGuard，禁止再长第二种。
 */
export function makeDirtyGuard() {
  let snap: string | null = null
  // 用 const 箭头而非对象方法简写：check-template-bindings 把 `open(v){…}` 这种
  // 简写定义当「调用了未定义的 open()」（collectCalled 只认 function/const 声明）。
  const open = (v: any): void => { snap = snapOf(v) }
  const dirty = (v: any): boolean => snap !== null && snapOf(v) !== snap
  const clear = (): void => { snap = null }
  return { open, dirty, clear }
}
