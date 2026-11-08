/**
 * 结构地图的“提议”格式（2026-11-08 暮雨拍板：“AI 写进去落一张待审批卡”）。
 *
 * 边界（这条是这次拍板的全部意义）：
 *   · AI **不许**直接改 `policies/<id>.md` —— 写口只存在于“用户签过字的卡”这一条路上；
 *   · 提议阶段只落一张**待审批**卡（正文带完整新版地图 + 批准后怎么落地）；
 *   · 用户在卡上把状态改成「完成」= 签字，之后 `smap_apply` 才允许写；没签字就一个字节都不动。
 *
 * 为什么拆成纯函数：判据（有没有日期 / 抽不抽得出来）要能在 Node 里直接断言，
 * 不靠起 Electron。`e2e-smap-proposal.cjs` 真跑这一份。
 */

/** 提议正文里“新版地图”那一节的标题 —— 抽取与 human 阅读都认它 */
export const SMAP_PROPOSAL_HEAD = '## 新版结构地图'
/** 落地说明那一节（让用户知道“批准”到底会做什么） */
export const SMAP_APPLY_HEAD = '## 批准后怎么落地'

/** 结构地图正文必须带的“最后核实”行（没有它，写进去就是一张没人敢用的旧图） */
export const SMAP_VERIFIED_RE = /最后核实[：:]\s*(\d{4})-(\d{2})-(\d{2})/

export interface SmapProposalInput {
  project: string
  /** 新版地图正文（模块清单 + 主数据流） */
  mapText: string
  /** 为什么要改（读到了什么事实让它不一样）—— 空则写“未说明”，不假装有理由 */
  reason?: string
  agent?: string
  /** 生成时间，用于“最后由谁在哪天核过” */
  at?: string
}

/** 提议卡正文。**顺序即语义**：先事实、再地图、最后落地方式（用户是照它判断要不要签字的）。 */
export function buildSmapProposalBody(input: SmapProposalInput): string {
  const at = String(input.at || new Date().toISOString())
  const day = at.slice(0, 10)
  const reason = String(input.reason || '').trim()
  const agent = String(input.agent || '').trim() || '（未署名）'
  const map = String(input.mapText || '').trim()
  return [
    '# 结构地图更新提议',
    '',
    `**项目**：${input.project}`,
    `**提议方**：${agent}`,
    `**时间**：${day}`,
    '',
    '## 为什么要改',
    '',
    reason || '（提议方没写理由 —— 那就等于让你自己从地图里找差异，这条本身就该打回）',
    '',
    SMAP_PROPOSAL_HEAD,
    '',
    map,
    '',
    SMAP_APPLY_HEAD,
    '',
    '把这张卡移到「完成」= 你签字。签字后让 agent 调 `smap_apply { taskId: "<本卡 id>" }`，',
    `它会把上面那节写进 \`policies/${input.project}.md\` 的「## 结构地图」—— 写前自动备份、写后读回自证。`,
    '',
    '**没签字 = 一个字节都不会动。** 不满意就直接打回（写清哪条不对），或归档。',
    '',
  ].join('\n')
}

/** 提议卡的机检判据（交给 checkIntake；过 → 待审批，不过 → 草稿 + 红标） */
export function smapProposalCriteria(): string[] {
  return [
    `str: '${SMAP_PROPOSAL_HEAD}'`,
    `str: '${SMAP_APPLY_HEAD}'`,
    'format: /最后核实：\\d{4}-\\d{2}-\\d{2}/',
  ]
}

/**
 * 从卡片正文里抽出“新版地图”那一节。
 *
 * 失败一律返回 `{ ok: false, error }` 并**说清哪一条不满足** —— 这一步是写文件的入口，
 * 宁可拒绝也不能“抽到半截就写进去”。
 */
/**
 * ⚠ 为什么不是 `{ok:true,...} | {ok:false,error}` 的判别联合：
 *   `tsconfig.main.json` 是 `strict: false`（strictNullChecks 关），字面量 `true/false`
 *   会被拓宽成 `boolean`，判别式收窄直接失效 —— `ex.error` 编译不过。
 *   所以用可选字段，调用方按 `ok` 取。
 */
export interface SmapExtractResult {
  ok: boolean
  mapText?: string
  verifiedAt?: string
  error?: string
}

export function extractSmapProposal(body: string): SmapExtractResult {
  const text = String(body || '').replace(/\r\n/g, '\n')
  const head = text.indexOf(SMAP_PROPOSAL_HEAD)
  if (head < 0) return { ok: false, error: `卡里没有「${SMAP_PROPOSAL_HEAD}」这一节 —— 抽不出来就不写` }
  const rest = text.slice(head + SMAP_PROPOSAL_HEAD.length)
  // 先截到“批准后怎么落地”（正常提议一定有它）；没有才退到下一个 `## `。
  // ⚠ 不能只靠“下一个 ## ”—— 卡正文后面还会接 `## 收卡机检`，但那节在落地说明之后，
  //   真出问题的是“提议方自己把落地说明删了”，那时才需要兜底。
  const applyAt = rest.indexOf(SMAP_APPLY_HEAD)
  const cut = applyAt >= 0 ? applyAt : rest.search(/\n##\s/)
  const mapText = (cut >= 0 ? rest.slice(0, cut) : rest).trim()
  if (!mapText) return { ok: false, error: '「新版结构地图」这一节是空的' }
  const m = SMAP_VERIFIED_RE.exec(mapText)
  if (!m) return { ok: false, error: '这一版没有「最后核实：YYYY-MM-DD」—— 写进去就是一张没人知道新旧的图' }
  // 骨架/占位不许当成品写进去
  if (mapText.indexOf('模块清单：待填') >= 0) {
    return { ok: false, error: '这版还是“待填”骨架 —— 骨架不是地图' }
  }
  return { ok: true, mapText, verifiedAt: `${m[1]}-${m[2]}-${m[3]}` }
}
