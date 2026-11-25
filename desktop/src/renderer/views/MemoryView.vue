<template>
  <main id="board" class="memory-view">
    <div class="mem-wrap">
      <!-- 2026-11-20：开关关闭时只影响 agent 自动读写；页面照常可看可管 -->
      <div v-if="!memoryEnabled" class="mem-off">
        <b>记忆已关闭</b>
        <span>agent 不会自动读记忆，开工也不会带；数据还在，随时可以开。</span>
        <Button size="sm" variant="primary" @click="enableMemory">开启记忆</Button>
      </div>

      <div class="mem-head">
        <div class="mem-lead">记忆</div>
        <div class="mem-lead-sub">
          记忆是方寸的可选功能，和其他 agent 的记忆互为补充。推荐用来记各项目的施工教训和通用条目：
          一句话说清是什么，再留一段原文；平时只看那句话，需要细节时再翻原文。
          AI 可以起草，你点头后才算数；也可以自己记。
        </div>
      </div>

      <!-- 检索行 -->
      <div class="mem-search">
        <input class="mem-q" v-model="q" placeholder="搜一句话或一个词，比如：杀进程、授权、误删"
          @keydown.enter="load()" @input="onType()" />
        <select class="mem-sel" v-model="typeFilter" @change="load()">
          <option value="">全部类型</option>
          <option v-for="t in types" :key="t" :value="t">{{ t }}</option>
        </select>
        <!-- 2026-11-20：按项目 / 全局筛；「通用 / 全局」= 没有项目归属 -->
        <select class="mem-sel" v-model="projectFilter" @change="load()" title="按项目筛；「通用 / 全局」= 没有项目归属">
          <option value="">全部项目</option>
          <option value="__global__">通用 / 全局</option>
          <option v-for="p in projectOptions" :key="'mp-' + p" :value="p">{{ p }}</option>
        </select>
        <select class="mem-sel" v-model="statusFilter" @change="load()" title="按状态筛；选「默认」时按下面两个开关走">
          <option value="">默认（有效）</option>
          <option value="待审批">待审批</option>
          <option value="有效">有效</option>
          <option value="已撤销">已撤销</option>
        </select>
        <Button size="tool" variant="ghost" @click="quickType('事故')"
          title="只看事故（最近各项目事故频发；再点「全部类型」恢复）">事故</Button>
        <label class="mem-chk" title="已撤销的记忆默认不显示；打开可以看到它们">
          <input type="checkbox" v-model="includeRevoked" @change="load()" /> 显示已撤销
        </label>
        <label class="mem-chk" title="AI 起草的条目要先经你通过；打开可以看到还没通过的">
          <input type="checkbox" v-model="includePending" @change="load()" /> 显示待审批
          <b v-if="overview && overview.pending" class="mem-pending-count">{{ overview.pending }}</b>
        </label>
        <label class="mem-chk" title="有新待审批记忆时：除了置顶条，还发系统通知（窗口不在前台时）">
          <input type="checkbox" v-model="memoryNotify" @change="saveNotify" /> 待审批提醒
        </label>
        <Button size="tool" variant="ghost" :disabled="busy" @click="load()">{{ busy ? '查…' : '搜索' }}</Button>
        <Button size="tool" variant="ghost" :disabled="busy" @click="rebuild()" title="重新读一遍记忆文件；改了磁盘上的文件后点这里">刷新列表</Button>
        <Button size="tool" variant="ghost" :disabled="busy" @click="openImport()">导入</Button>
        <Button size="tool" variant="ghost" :disabled="busy" @click="organizeAsk = true"
          title="用你在设置里配的模型，从最近日志和已完成任务里提炼待审批草稿">一键整理</Button>
        <Button size="tool" variant="primary" @click="openNew()">＋ 记一条</Button>
      </div>

      <div v-if="notice" class="mem-notice">{{ notice }}</div>

      <div v-if="pendingVisible.length || selectedFiles.length" class="mem-batch">
        <label class="mem-chk" title="勾上后整页条目一起选中；再点取消">
          <input type="checkbox" :checked="allVisibleSelected" @change="toggleAllVisible" /> 全选本页
        </label>
        <span>已选 <b>{{ selectedFiles.length }}</b> 条 · 这一页有 <b>{{ pendingVisible.length }}</b> 条待审批</span>
        <Button size="tool" variant="primary" :disabled="!selectedFiles.length || batchBusy" @click="approveSelected">通过选中</Button>
        <Button size="tool" variant="ghost" :disabled="!selectedFiles.length || batchBusy"
          @click="askReject(selectedFiles, '选中的 ' + selectedFiles.length + ' 条')">驳回选中</Button>
        <Button size="tool" variant="ghost" :disabled="!selectedFiles.length || batchBusy" @click="openBatchEdit">批量改字段</Button>
        <Button size="tool" variant="ghost" :disabled="!selectedFiles.length || batchBusy" @click="selectedFiles = []">清空选择</Button>
        <span class="mem-sep">·</span>
        <Button size="tool" variant="primary" :disabled="batchBusy" @click="batchAsk = '有效'">全部通过</Button>
        <Button size="tool" variant="ghost" :disabled="batchBusy" @click="batchAsk = '已撤销'">全部驳回</Button>
        <template v-if="batchAsk">
          <span class="mem-batch-confirm">确认把 {{ pendingVisible.length }} 条设为「{{ batchAsk }}」？文件不删。</span>
          <Button size="tool" variant="primary" :disabled="batchBusy" @click="runBatch">确认</Button>
          <Button size="tool" variant="ghost" :disabled="batchBusy" @click="batchAsk = ''">取消</Button>
        </template>
      </div>

      <div v-if="organizeAsk" class="mem-organize">
        <div>
          <b>一键整理</b>
          <span>不调模型、不花 key：生成一份给 DSH 的整理包，复制给 DSH 后由它用 memory_write 起草，全部落「待审批」。</span>
        </div>
        <Button size="tool" variant="primary" :disabled="organizeBusy" @click="runOrganize">{{ organizeBusy ? '生成中…' : '生成整理包' }}</Button>
        <Button size="tool" variant="ghost" :disabled="organizeBusy" @click="organizeAsk = false">取消</Button>
      </div>

      <div v-if="organizePrompt" class="mem-pack">
        <div class="mem-pack-head">
          <b>整理包</b>
          <span>复制给 DSH。包里的来源 id 是唯一凭据；DSH 只能写待审批。</span>
        </div>
        <textarea class="mem-ta" rows="12" readonly :value="organizePrompt"></textarea>
        <div class="mem-edit-acts">
          <Button size="tool" variant="primary" @click="copyOrganize">复制整理包</Button>
          <Button size="tool" variant="ghost" @click="organizePrompt = ''">关闭</Button>
        </div>
      </div>

      <!-- 概览 -->
      <div class="mem-stat" v-if="overview">
        <span>共 <b>{{ overview.total }}</b> 条</span>
        <span class="mem-sep">·</span>
        <span>有效 <b>{{ overview.effective }}</b></span>
        <span v-if="overview.pending"> <span class="mem-sep">·</span> 待审批 <b>{{ overview.pending }}</b></span>
        <span v-if="overview.revoked"> <span class="mem-sep">·</span> 已撤销 <b>{{ overview.revoked }}</b></span>
        <span class="mem-sep">·</span>
        <span>一句话 <b>{{ overview.claims }}</b> 条 · 原文 <b>{{ overview.evidence }}</b> 篇 · 开工常读 <b>{{ overview.pinned }}</b> 条</span>
        <span v-if="overview.legacy" class="mem-legacy">旧格式 {{ overview.legacy }} 条</span>
        <span class="mem-sep">·</span>
        <span>开工时会带 <b>{{ overview.coreChars }}</b>/{{ overview.coreBudget }} 字</span>
        <span class="mem-sep">·</span>
        <span class="mem-types">
          <span v-for="(n, t) in overview.byType" :key="t" class="mem-tag">{{ t }} {{ n }}</span>
        </span>
      </div>

      <!-- 空态：必须分清"还没录"与"筛出来没有" -->
      <div class="mem-empty" v-if="!rows.length && !busy">
        <template v-if="overview && overview.total === 0">
          还没有记过任何东西。点「记一条」开始 —— 一句话说清是什么，原文可以很长，但平时只显示那一句。
          <div class="mem-empty-act">
            <Button size="tool" variant="primary" @click="openNew()">＋ 记下第一条</Button>
          </div>
        </template>
        <template v-else>
          没有找到匹配的记忆（库里共有 {{ overview ? overview.total : '?' }} 条）。换个词，或打开「显示已撤销」再试。
          <template v-if="overview && overview.pending && !includePending">
            另有 <b>{{ overview.pending }}</b> 条待审批，打开「显示待审批」查看。
          </template>
        </template>
      </div>

      <!-- 结果 -->
      <div class="mem-item" v-for="r in rows" :key="r.file">
        <div class="mem-i-h">
          <label class="mem-pick" title="选中后可批量通过 / 驳回 / 改项目分类">
            <input type="checkbox" :value="r.file" v-model="selectedFiles" />
          </label>
          <span class="mem-badge" :class="'is-' + badgeKey(r.type)">{{ r.type || '—' }}</span>
          <span class="mem-title">{{ r.claim || r.title || r.file }}</span>
          <span class="mem-impact" v-if="r.importance" :class="'imp-' + impactKey(r.importance)">
            {{ importanceLabel(r.importance) }}
          </span>
          <span v-if="r.pinned" class="mem-pin" title="常读：每次开工都会带上这一条">常读</span>
        </div>
        <div class="mem-i-sub">
          <span v-if="r.time" class="mem-when">{{ fmtTime(r.time) }}</span>
          <span v-if="r.project" class="mem-proj">{{ r.project }}</span>
          <span class="mem-conf" title="可信度：你亲口说的/已核实的高，AI 推断的低">可信 {{ confidencePct(r.confidence) }}</span>
          <span class="mem-imp-num" title="重要度 1–5">重要 {{ r.importance }}/5</span>
          <span v-for="tg in r.tags" :key="tg" class="mem-chip">{{ tg }}</span>
          <span v-if="r.status === '已撤销'" class="mem-revoked">已撤销</span>
          <span v-if="r.status === '待审批'" class="mem-pending">待审批</span>
          <span v-if="r.legacy" class="mem-legacy">旧格式</span>
        </div>
        <div class="mem-i-acts">
          <Button size="sm" variant="ghost" @click="open(r.file)" title="看这句话和原文">{{ opened === r.file ? '收起' : '看原文' }}</Button>
          <Button size="sm" variant="ghost" @click="openEdit(r)" title="改这句话 / 原文 / 参数">✏ 编辑</Button>
          <template v-if="r.status === '待审批'">
            <Button size="sm" variant="primary" @click="setStatus(r, '有效')"
              title="通过后这条才参与默认检索">✓ 通过</Button>
            <Button size="sm" variant="ghost" @click="setStatus(r, '已撤销')"
              title="驳回：文件不删，标为已撤销（撤销≠删除）">✗ 驳回</Button>
          </template>
          <Button v-else-if="r.status !== '已撤销'" size="sm" variant="ghost" @click="setStatus(r, '已撤销')"
            title="标记为已撤销：文件不删，只是不再算数（撤销后可恢复）">∅ 撤销这条</Button>
          <Button v-else size="sm" variant="ghost" @click="setStatus(r, '有效')"
            title="恢复成有效（撤销≠删除，所以能恢复）">↺ 恢复有效</Button>
        </div>
        <div class="mem-detail" v-if="opened === r.file">
          <div v-if="openedClaim" class="mem-detail-claim">{{ openedClaim }}</div>
          <pre class="mem-body">{{ openedEvidence || openedText }}</pre>
        </div>
      </div>
    </div>

    <!-- 新建 / 编辑（2026-11-18 开放写；2026-11-20 改成 claim + 证据） -->
    <div v-if="editing" class="mem-edit-mask" @mousedown.self="cancelEdit">
      <div class="mem-edit" tabindex="-1"
        @keydown.ctrl.enter.prevent="saveEdit(false)" @keydown.esc="cancelEdit">
        <h3>{{ formFile ? '改这一条记忆' : '记一条记忆' }}</h3>
        <div v-if="formFile && formStatus === '待审批'" class="mem-edit-pending">
          待审批 · 通过前可以改；点「保存并通过」= 一次完成修改 + 转正。
        </div>
        <div class="mem-edit-hint">
          <b>一句话</b>：以后搜索和开工提示只看这句，要能单独看懂。
          <b>原文</b>：贴当时的事实或原话，越长越好，不用压缩。
          这不是待办，也不是日志 —— 它记的是“发生过什么、哪条规矩是拿损失换来的”。
        </div>
        <div class="mem-edit-row">
          <label><span class="mem-lb">类型<b>*</b></span>
            <select v-model="form.type" class="mem-sel">
              <option v-for="t in types" :key="'mt-' + t" :value="t">{{ t }}</option>
            </select>
          </label>
          <label><span class="mem-lb">重要度</span>
            <select v-model.number="form.importance" class="mem-sel">
              <option v-for="n in [5, 4, 3, 2, 1]" :key="'mi-' + n" :value="n">{{ importanceLabel(n) }}（{{ n }}）</option>
            </select>
          </label>
          <label><span class="mem-lb">可信度</span>
            <input v-model.number="form.confidence" type="number" min="0" max="1" step="0.05"
              class="mem-inp mem-num" title="0–1：你亲口说的/已核实的高，AI 推断的低" />
          </label>
          <label><span class="mem-lb">项目</span>
            <input v-model="form.project" class="mem-inp" placeholder="例：fangcun-base（不填＝通用）" />
          </label>
        </div>
        <label class="mem-edit-wide"><span class="mem-lb">来源<b>*</b></span>
          <input v-model="form.source" class="mem-inp" placeholder="谁说的 / 哪次事故 / 哪个文件" />
        </label>
        <label class="mem-edit-wide"><span class="mem-lb">一句话（必填，最多 200 字）<b>*</b></span>
          <textarea v-model="form.claim" class="mem-ta mem-ta-claim" rows="2" maxlength="200"
            placeholder="例：动手前先报目标路径，别凭名字猜系统归属。"></textarea>
          <span class="mem-count">{{ form.claim.length }}/200 字（建议 120 字内）</span>
        </label>
        <label class="mem-edit-wide"><span class="mem-lb">原文 / 证据（必填）<b>*</b></span>
          <textarea v-model="form.evidence" class="mem-ta" rows="9"
            placeholder="把当时的原话、报错或经过贴在这里。不用总结，越长越好。"></textarea>
        </label>
        <label class="mem-chk mem-pin-chk">
          <input type="checkbox" v-model="form.pinned" /> 开工时常读（固定放进开工提示，只给最该反复看的几条）
        </label>
        <div v-if="editErr" class="mem-edit-err">{{ editErr }}</div>
        <div class="mem-edit-acts">
          <Button variant="ghost" size="tool" @click="cancelEdit">取消</Button>
          <Button v-if="formFile && formStatus === '待审批'" variant="primary" size="tool" :disabled="editBusy"
            @click="saveEdit(true)">保存并通过</Button>
          <Button variant="primary" size="tool" :disabled="editBusy" @click="saveEdit(false)">
            {{ editBusy ? '存…' : (formFile ? '保存修改' : '存下这一条') }}
          </Button>
        </div>
      </div>
    </div>

    <!-- 批量改字段（2026-11-20）：只改分类/标签/参数，不碰正文与状态 -->
    <div v-if="batchEditAsk" class="mem-edit-mask" @mousedown.self="batchEditAsk = false">
      <div class="mem-edit mem-batch-edit">
        <h3>批量改 {{ selectedFiles.length }} 条</h3>
        <div class="mem-edit-hint">
          只改分类 / 标签 / 参数，<b>不碰一句话和原文</b>，也不改状态。留「不改」的字段保持原样。
        </div>
        <div class="mem-edit-row">
          <label><span class="mem-lb">项目</span>
            <select v-model="batchForm.projectMode" class="mem-sel">
              <option value="keep">不改</option>
              <option value="set">改成…</option>
              <option value="global">清空 → 通用 / 全局</option>
            </select>
          </label>
          <label v-if="batchForm.projectMode === 'set'"><span class="mem-lb">目标项目</span>
            <input v-model="batchForm.project" class="mem-inp" placeholder="例：fangcun-base" />
          </label>
          <label><span class="mem-lb">类型</span>
            <select v-model="batchForm.type" class="mem-sel">
              <option value="">不改</option>
              <option v-for="t in types" :key="'bt-' + t" :value="t">{{ t }}</option>
            </select>
          </label>
          <label><span class="mem-lb">重要度</span>
            <select v-model="batchForm.importance" class="mem-sel">
              <option value="">不改</option>
              <option v-for="n in [5, 4, 3, 2, 1]" :key="'bi-' + n" :value="String(n)">{{ importanceLabel(n) }}（{{ n }}）</option>
            </select>
          </label>
        </div>
        <div class="mem-edit-row">
          <label><span class="mem-lb">标签</span>
            <select v-model="batchForm.tagsMode" class="mem-sel">
              <option value="keep">不改</option>
              <option value="set">改成…</option>
              <option value="clear">清空</option>
            </select>
          </label>
          <label v-if="batchForm.tagsMode === 'set'"><span class="mem-lb">标签（逗号分隔）</span>
            <input v-model="batchForm.tags" class="mem-inp" placeholder="例：事故,强杀进程" />
          </label>
          <label><span class="mem-lb">常读</span>
            <select v-model="batchForm.pinned" class="mem-sel">
              <option value="keep">不改</option>
              <option value="true">设为常读</option>
              <option value="false">取消常读</option>
            </select>
          </label>
        </div>
        <div v-if="batchEditErr" class="mem-edit-err">{{ batchEditErr }}</div>
        <div class="mem-edit-acts">
          <Button variant="ghost" size="tool" :disabled="batchEditBusy" @click="batchEditAsk = false">取消</Button>
          <Button variant="primary" size="tool" :disabled="batchEditBusy" @click="applyBatchEdit">
            {{ batchEditBusy ? '改…' : '应用到选中的 ' + selectedFiles.length + ' 条' }}
          </Button>
        </div>
      </div>
    </div>

    <!-- 驳回（2026-11-20）：理由写进审批备注；文件不删 -->
    <div v-if="rejectAsk" class="mem-edit-mask" @mousedown.self="closeReject">
      <div class="mem-edit mem-reject">
        <h3>驳回 {{ rejectLabel }}</h3>
        <div class="mem-edit-hint">驳回 = 标「已撤销」，文件不删；理由会写进「审批备注」。</div>
        <label class="mem-edit-wide"><span class="mem-lb">理由（可空）</span>
          <textarea v-model="rejectReason" class="mem-ta" rows="3"
            placeholder="例：证据不足 / 这条已经被后来的决定推翻"></textarea>
        </label>
        <div class="mem-edit-acts">
          <Button variant="ghost" size="tool" :disabled="rejectBusy" @click="closeReject">取消</Button>
          <Button variant="primary" size="tool" :disabled="rejectBusy" @click="runReject">
            {{ rejectBusy ? '驳回中…' : '确认驳回' }}
          </Button>
        </div>
      </div>
    </div>

    <!-- 导入（2026-11-20 问卷 M5 A）：全部落待审批，重复跳过 -->
    <div v-if="importAsk" class="mem-edit-mask" @mousedown.self="closeImport">
      <div class="mem-edit mem-import">
        <h3>导入记忆</h3>
        <div class="mem-edit-hint">
          支持 JSON 数组，或一条 v2 Markdown（<code>---</code> frontmatter + <code>## 记忆</code> + <code>## 证据</code>）。
          导入的每一条都会落「待审批」，重复的会跳过，不会覆盖已有记忆。
        </div>
        <div class="mem-edit-row">
          <label><span class="mem-lb">格式</span>
            <select v-model="importFormat" class="mem-sel">
              <option value="auto">自动识别</option>
              <option value="json">JSON</option>
              <option value="md">Markdown</option>
            </select>
          </label>
          <label><span class="mem-lb">项目（可选）</span>
            <input v-model="importProject" class="mem-inp" placeholder="不填＝按内容里的项目" />
          </label>
        </div>
        <label class="mem-edit-wide"><span class="mem-lb">来源（必填）<b>*</b></span>
          <input v-model="importSource" class="mem-inp" placeholder="例：旧笔记 2026-11-20 / 备份文件 ..." />
        </label>
        <label class="mem-edit-wide"><span class="mem-lb">内容</span>
          <textarea v-model="importText" class="mem-ta" rows="12"
            placeholder="粘贴 JSON 数组，或一条 v2 Markdown…"></textarea>
        </label>
        <div v-if="importErr" class="mem-edit-err">{{ importErr }}</div>
        <div class="mem-edit-acts">
          <Button variant="ghost" size="tool" :disabled="importBusy" @click="closeImport">取消</Button>
          <Button variant="primary" size="tool" :disabled="importBusy" @click="runImport">
            {{ importBusy ? '导入中…' : '导入为待审批' }}
          </Button>
        </div>
      </div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import Button from '../components/ui/Button.vue'

/** App 的置顶条「去审批」传进来的非零序号：切到「待审批」筛选 */
const props = defineProps<{ focusPending?: number }>()

/**
 * 记忆页（2026-11-17 建；2026-11-18 开放写；2026-11-20 v2：claim + evidence）
 *
 * ## 写什么、不写什么
 * 开放写 ≠ 允许"随手记一句摘要"。写入**必填四项**（类型 / claim / 证据 / 来源），
 * 少一项当场拒绝并说清缺哪个 —— claim 是索引句，证据是原文；两者缺一都不算记下。
 *
 * ## 撤销 ≠ 删除
 * 改状态只动 frontmatter 的 `状态`，**文件不动**。记忆的价值在于"它曾经发生过"，
 * 删掉就是篡改历史 —— 所以界面上给的是「撤销这条 / 恢复有效」，没有"删除"。
 *
 * ## 两条口径（都栽过）
 * ① 「筛出来 0 条」≠「库里一条都没有」—— 两种空态分开说；
 * ② class 名一处新起（`.mem-*`），不套 `.idea-*` —— 套旧类会让既有断言凭空变红。
 */
const rows = ref<any[]>([])
const overview = ref<any>(null)
const q = ref('')
const typeFilter = ref('')
const includeRevoked = ref(false)
const includePending = ref(false)
const busy = ref(false)
const opened = ref('')
const openedText = ref('')
/** v2：详情里先给人看的一句话，再给原文；不直接把整份 frontmatter 甩出来 */
const openedClaim = ref('')
const openedEvidence = ref('')
const types = ref<string[]>(['事故', '教训', '纪律', '决定', '偏好', '事实'])
/** 2026-11-20：开关关闭时页面顶部横幅；只影响 agent 自动读写，数据照常可管 */
const memoryEnabled = ref(true)
/** 导入 / 整理的结果条（不弹原生 alert，页面里说清） */
const notice = ref('')
const importAsk = ref(false)
const importText = ref('')
const importFormat = ref('auto')
const importSource = ref('')
const importProject = ref('')
const importBusy = ref(false)
const importErr = ref('')
const organizeAsk = ref(false)
const organizeBusy = ref(false)
/** 给 DSH 的整理包：只读文本，不调模型 */
const organizePrompt = ref('')
const pendingVisible = computed(() => rows.value.filter((r) => r.status === '待审批'))
const batchAsk = ref('')
const batchBusy = ref(false)
/** 2026-11-20：项目 / 状态筛选 + 多选 */
const projectFilter = ref('')
const statusFilter = ref('')
const selectedFiles = ref<string[]>([])
const memoryNotify = ref(true)
const projectOptions = computed<string[]>(() => {
  const bp = (overview.value && overview.value.byProject) || {}
  return Object.keys(bp).filter((p) => p !== '通用 / 全局').sort((a, b) => a.localeCompare(b, 'zh'))
})
const allVisibleSelected = computed(() =>
  rows.value.length > 0 && rows.value.every((r) => selectedFiles.value.includes(r.file))
)
/** 批量改字段 */
const batchEditAsk = ref(false)
const batchEditBusy = ref(false)
const batchEditErr = ref('')
const batchForm = ref({
  projectMode: 'keep' as 'keep' | 'set' | 'global',
  project: '',
  type: '',
  tagsMode: 'keep' as 'keep' | 'set' | 'clear',
  tags: '',
  importance: '',
  pinned: 'keep' as 'keep' | 'true' | 'false',
})
/** 驳回理由弹窗 */
const rejectAsk = ref(false)
const rejectFiles = ref<string[]>([])
const rejectLabel = ref('')
const rejectReason = ref('')
const rejectBusy = ref(false)

// ── 写入态 ──────────────────────────────────────────────────────────
const editing = ref(false)
const editBusy = ref(false)
const editErr = ref('')
/** 正在改的那条；空 = 新建 */
const formFile = ref('')
const formId = ref('')
/** 正在改的那条原本的状态：待审批时给「保存并通过」 */
const formStatus = ref('')
const form = ref({
  type: '教训', claim: '', evidence: '', source: '', project: '',
  confidence: 0.7, importance: 3, pinned: false,
})

function resetForm(): void {
  form.value = {
    type: types.value[0] || '教训', claim: '', evidence: '', source: '', project: '',
    confidence: 0.7, importance: 3, pinned: false,
  }
}

function openNew(): void {
  formFile.value = ''
  formStatus.value = ''
  resetForm()
  editErr.value = ''
  editing.value = true
}

function openImport(): void {
  importText.value = ''
  importSource.value = ''
  importProject.value = ''
  importFormat.value = 'auto'
  importErr.value = ''
  importAsk.value = true
}

function closeImport(): void {
  if (importBusy.value) return
  importAsk.value = false
}

async function runImport(): Promise<void> {
  if (!importText.value.trim()) { importErr.value = '先粘贴要导入的内容'; return }
  if (!importSource.value.trim()) { importErr.value = '来源必填 —— 说不清来源的记忆，下次没人敢信'; return }
  importBusy.value = true
  importErr.value = ''
  notice.value = ''
  try {
    const r: any = await (window as any).tegula.memoryImport({
      text: importText.value,
      format: importFormat.value,
      source: importSource.value,
      project: importProject.value,
    })
    if (!r?.ok) { importErr.value = r?.error || '导入失败'; return }
    notice.value = `已导入 ${r.imported || 0} 条待审批记忆` + (r.skipped ? `，跳过 ${r.skipped} 条` : '') + '。'
    if (r.errors?.length) notice.value += ' ' + r.errors.slice(0, 2).join('；')
    importAsk.value = false
    includePending.value = true
    await load()
  } catch (e: any) {
    importErr.value = '导入失败：' + (e?.message || e)
  } finally {
    importBusy.value = false
  }
}

async function runOrganize(): Promise<void> {
  organizeBusy.value = true
  notice.value = ''
  try {
    const r: any = await (window as any).tegula.memoryOrganize({ limit: 24 })
    if (!r?.ok) { notice.value = r?.error || '生成整理包失败'; return }
    organizePrompt.value = String(r.prompt || '')
    organizeAsk.value = false
    notice.value = `已生成 ${r.count || 0} 条候选的整理包；复制给 DSH，不调模型。`
  } catch (e: any) {
    notice.value = '生成整理包失败：' + (e?.message || e)
  } finally {
    organizeBusy.value = false
  }
}

async function copyOrganize(): Promise<void> {
  if (!organizePrompt.value) return
  try {
    await (window as any).tegula.clipboardWriteText(organizePrompt.value)
    notice.value = '整理包已复制；粘给 DSH。'
  } catch (e: any) {
    notice.value = '复制失败：' + (e?.message || e)
  }
}

/** 批量通过 / 驳回：只改状态，不删文件；逐条走同一条 memorySetStatus */
async function runBatch(): Promise<void> {
  const status = batchAsk.value
  const targets = pendingVisible.value.slice()
  if (!status || !targets.length) return
  batchBusy.value = true
  let ok = 0
  try {
    for (const r of targets) {
      try {
        const res: any = await (window as any).tegula.memorySetStatus(r.file, status, '批量' + status)
        if (res?.ok) ok++
      } catch { /* 单条失败不打断整批 */ }
    }
    notice.value = `已把 ${ok}/${targets.length} 条设为「${status}」。`
    batchAsk.value = ''
    await load()
  } finally {
    batchBusy.value = false
  }
}

/** 从整篇文本里剥出正文（v1 legacy 的兜底；v2 直接用 memoryRead 返回的 claim/evidence） */
function legacyBody(text: string): string {
  const m = [...String(text || '').matchAll(/^---\s*$/gm)]
  const afterFm = m.length >= 2 ? String(text).slice(m[1].index! + m[1][0].length) : String(text || '')
  const lines = afterFm.split(/\r?\n/)
  const hAt = lines.findIndex((l) => l.trim().startsWith('#'))
  return (hAt >= 0 ? lines.slice(hAt + 1) : lines).join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '')
}

async function openEdit(r: any): Promise<void> {
  try {
    const res: any = await (window as any).tegula.memoryRead(r.file)
    if (!res?.ok) { editErr.value = '读不到原文：' + (res?.error || '未知原因'); return }
    const text = String(res.text || '')
    const isV2 = !r.legacy && String(res.claim || '').trim()
    formFile.value = r.file
    formId.value = String(r.id || '')
    formStatus.value = String(r.status || '')
    form.value = {
      type: r.type || types.value[0] || '教训',
      claim: isV2 ? String(res.claim || '') : String(r.claim || r.title || ''),
      evidence: isV2 ? String(res.evidence || '') : legacyBody(text),
      source: r.source || '',
      project: r.project || '',
      confidence: Number.isFinite(Number(r.confidence)) ? Number(r.confidence) : 0.7,
      importance: Number(r.importance) || 3,
      pinned: r.pinned === true,
    }
    editErr.value = ''
    editing.value = true
  } catch (e: any) {
    editErr.value = '读不到原文：' + (e?.message || e)
  }
}

function cancelEdit(): void {
  editing.value = false
  editErr.value = ''
  formFile.value = ''
  formId.value = ''
  formStatus.value = ''
}

async function saveEdit(approve = false): Promise<void> {
  const file = formFile.value
  const f = form.value
  const missing: string[] = []
  if (!String(f.type).trim()) missing.push('类型')
  if (!String(f.claim).trim()) missing.push('claim')
  if (!String(f.evidence).trim()) missing.push('证据')
  if (!String(f.source).trim()) missing.push('来源')
  if (missing.length) {
    editErr.value = `还差：${missing.join(' / ')} —— 这四项缺一个都不算记下`
    return
  }
  if (String(f.claim).length > 200) {
    editErr.value = `claim ${String(f.claim).length} 字，超过硬上限 200；请拆成多条或把细节放证据`
    return
  }
  editBusy.value = true
  editErr.value = ''
  try {
    const api: any = (window as any).tegula
    // 已批准 = 只读（2026-11-25 · P16.3）：不原地改，另存新版本（待审批）；
    // 通过后 setMemoryStatus 会把「取代」指向的旧版自动撤销。
    const approved = !!file && formStatus.value === '有效' && !!formId.value
    let targetFile = file
    if (approved) {
      const made: any = await api.memoryCreate({ ...f, supersedes: formId.value })
      if (!made?.ok) {
        editErr.value = '没存进去：' + (made?.error || '未知原因')
          + (made?.duplicate ? `（已有：${made.duplicate.claim}）` : '')
        return
      }
      targetFile = made.file
      if (!approve) {
        notice.value = '已批准的记忆不能原地改：已另存为新版本（待审批），通过后旧版自动撤销。'
      }
    } else if (file) {
      const r: any = await api.memoryUpdate(file, { ...f })
      if (!r?.ok) {
        editErr.value = '没存进去：' + (r?.error || '未知原因')
          + (r?.duplicate ? `（已有：${r.duplicate.claim}）` : '')
        return
      }
    } else {
      const r: any = await api.memoryCreate({ ...f })
      if (!r?.ok) {
        editErr.value = '没存进去：' + (r?.error || '未知原因')
          + (r?.duplicate ? `（已有：${r.duplicate.claim}）` : '')
        return
      }
    }
    // 编辑待审批条目：存完顺手转正（一次点击完成「改 + 通过」）；
    // 已批准条目的新版本也一样 —— 通过的是新文件，旧版随之撤销。
    if (approve && targetFile) {
      const s: any = await api.memorySetStatus(targetFile, '有效', '编辑后通过')
      if (!s?.ok) {
        editErr.value = '改动已保存，但转正失败：' + (s?.error || '未知原因')
        return
      }
    }
    editing.value = false
    formFile.value = ''
    formId.value = ''
    formStatus.value = ''
    await load()
  } catch (e: any) {
    editErr.value = '保存失败：' + (e?.message || e)
  } finally {
    editBusy.value = false
  }
}

/** 撤销 / 恢复：只改状态，文件不动（撤销≠删除，所以能恢复） */
async function setStatus(r: any, status: string): Promise<void> {
  // 驳回待审批：先让他写一句理由（不再用原生 prompt 打断），再统一走 reject 弹窗
  if (r.status === '待审批' && status === '已撤销') {
    askReject([r.file], '这一条')
    return
  }
  try {
    const res: any = await (window as any).tegula.memorySetStatus(r.file, status, '')
    if (!res?.ok) { alert('没改成：' + (res?.error || '未知原因')); return }
    await load()
  } catch (e: any) {
    alert('改状态失败：' + (e?.message || e))
  }
}

let timer: any = null
function onType() {
  clearTimeout(timer)
  timer = setTimeout(() => { load() }, 250)
}

async function loadPrefs() {
  try {
    const p: any = await (window as any).tegula.prefsGet()
    memoryEnabled.value = p?.memoryEnabled !== false
    memoryNotify.value = p?.memoryNotify !== false
  } catch { /* 读不到偏好就按开处理，不挡页面 */ }
}

async function enableMemory() {
  try {
    const r: any = await (window as any).tegula.prefsSetMany({ memoryEnabled: true })
    if (r?.ok === false) { alert('没开成：' + (r?.error || '未知原因')); return }
    memoryEnabled.value = true
  } catch (e: any) {
    alert('开启失败：' + (e?.message || e))
  }
}

async function load() {
  busy.value = true
  try {
    const r: any = await (window as any).tegula.memorySearch({
      q: q.value.trim() || undefined,
      type: typeFilter.value || undefined,
      project: projectFilter.value && projectFilter.value !== '__global__' ? projectFilter.value : undefined,
      global: projectFilter.value === '__global__' || undefined,
      status: statusFilter.value || undefined,
      includeRevoked: includeRevoked.value || !!statusFilter.value,
      includePending: includePending.value || !!statusFilter.value,
    })
    rows.value = r?.rows || []
    overview.value = r?.overview || null
    if (overview.value?.byType) {
      const keys = Object.keys(overview.value.byType)
      if (keys.length) types.value = keys
    }
    // 筛掉已不在当前结果里的选中项（避免"看不见的条目被批量改"）
    const visible = new Set((r?.rows || []).map((x: any) => String(x.file)))
    selectedFiles.value = selectedFiles.value.filter((f) => visible.has(f))
    // 当前项目筛选已不存在（项目被清空/改名）→ 回到全部
    if (projectFilter.value && projectFilter.value !== '__global__'
      && overview.value?.projects && !overview.value.projects.includes(projectFilter.value)) {
      projectFilter.value = ''
    }
  } catch (e: any) {
    rows.value = []
    overview.value = null
    alert('查询失败：' + (e?.message || e))
  } finally {
    busy.value = false
  }
}

/** 事故快捷筛（最近各项目事故频发）：再点一次恢复全部 */
function quickType(t: string): void {
  typeFilter.value = typeFilter.value === t ? '' : t
  void load()
}

/** 全选本页 / 取消全选 */
function toggleAllVisible(): void {
  if (allVisibleSelected.value) {
    const visible = new Set(rows.value.map((r) => String(r.file)))
    selectedFiles.value = selectedFiles.value.filter((f) => !visible.has(f))
  } else {
    const set = new Set(selectedFiles.value)
    for (const r of rows.value) set.add(String(r.file))
    selectedFiles.value = Array.from(set)
  }
}

/** 通过选中的（逐条走 memorySetStatus，不删文件） */
async function approveSelected(): Promise<void> {
  const files = selectedFiles.value.slice()
  if (!files.length || batchBusy.value) return
  batchBusy.value = true
  let ok = 0
  try {
    for (const file of files) {
      try {
        const r: any = await (window as any).tegula.memorySetStatus(file, '有效', '批量通过')
        if (r?.ok) ok++
      } catch { /* 单条失败不打断整批 */ }
    }
    notice.value = `已通过 ${ok}/${files.length} 条（只改状态，文件不删）。`
    selectedFiles.value = []
    await load()
  } finally {
    batchBusy.value = false
  }
}

function openBatchEdit(): void {
  batchEditErr.value = ''
  batchForm.value = {
    projectMode: 'keep', project: '', type: '', tagsMode: 'keep', tags: '', importance: '', pinned: 'keep',
  }
  batchEditAsk.value = true
}

/** 批量改分类/标签/参数：只动 frontmatter，不碰正文/状态 */
async function applyBatchEdit(): Promise<void> {
  const f = batchForm.value
  const patch: any = {}
  if (f.projectMode === 'global') patch.project = ''
  else if (f.projectMode === 'set') {
    if (!f.project.trim()) { batchEditErr.value = '目标项目为空；要清空请选「清空 → 通用 / 全局」'; return }
    patch.project = f.project.trim()
  }
  if (f.type) patch.type = f.type
  if (f.tagsMode === 'clear') patch.tags = []
  else if (f.tagsMode === 'set') patch.tags = f.tags.split(/[,，]/).map((x) => x.trim()).filter(Boolean)
  if (f.importance) patch.importance = Number(f.importance)
  if (f.pinned !== 'keep') patch.pinned = f.pinned === 'true'
  if (!Object.keys(patch).length) { batchEditErr.value = '没有要改的字段'; return }
  batchEditBusy.value = true
  batchEditErr.value = ''
  try {
    const r: any = await (window as any).tegula.memoryBatchUpdate(selectedFiles.value.slice(), patch)
    if (!r?.ok) {
      batchEditErr.value = r?.error || '批量改失败'
      if (r?.updated) await load()
      return
    }
    notice.value = `已改 ${r.updated || 0} 条的字段（正文与状态没动）。`
    batchEditAsk.value = false
    selectedFiles.value = []
    await load()
  } catch (e: any) {
    batchEditErr.value = '批量改失败：' + (e?.message || e)
  } finally {
    batchEditBusy.value = false
  }
}

function askReject(files: string[], label: string): void {
  const list = (files || []).slice()
  if (!list.length) return
  rejectFiles.value = list
  rejectLabel.value = label || `这 ${list.length} 条`
  rejectReason.value = ''
  rejectAsk.value = true
}

function closeReject(): void {
  if (rejectBusy.value) return
  rejectAsk.value = false
}

async function runReject(): Promise<void> {
  const files = rejectFiles.value.slice()
  if (!files.length || rejectBusy.value) return
  rejectBusy.value = true
  let ok = 0
  try {
    for (const file of files) {
      try {
        const r: any = await (window as any).tegula.memorySetStatus(file, '已撤销', rejectReason.value.trim() || '批量驳回')
        if (r?.ok) ok++
      } catch { /* 单条失败不打断整批 */ }
    }
    notice.value = `已驳回 ${ok}/${files.length} 条（标已撤销，文件不删）。`
    rejectAsk.value = false
    selectedFiles.value = []
    await load()
  } finally {
    rejectBusy.value = false
  }
}

async function saveNotify(): Promise<void> {
  try {
    await (window as any).tegula.prefsSet('memoryNotify', memoryNotify.value)
  } catch (e: any) {
    notice.value = '提醒开关没存上：' + (e?.message || e)
  }
}

async function open(file: string) {
  if (opened.value === file) { opened.value = ''; return }
  try {
    const r: any = await (window as any).tegula.memoryRead(file)
    if (!r?.ok) { alert('读不到：' + (r?.error || '未知原因')); return }
    opened.value = file
    openedText.value = String(r.text || '')
    openedClaim.value = String(r.claim || '')
    openedEvidence.value = String(r.evidence || '')
  } catch (e: any) {
    alert('读取失败：' + (e?.message || e))
  }
}

async function rebuild() {
  busy.value = true
  try {
    const r: any = await (window as any).tegula.memoryRebuild()
    if (r && r.count >= 0) await load()
  } catch (e: any) {
    alert('重建失败：' + (e?.message || e))
  } finally { busy.value = false }
}

function fmtTime(t: string) {
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return String(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function badgeKey(t: string) {
  return t === '事故' ? 'incident' : t === '纪律' ? 'rule' : t === '教训' ? 'lesson' : 'other'
}
function importanceLabel(n: number) {
  const v = Number(n) || 3
  return v >= 5 ? '严重' : v >= 4 ? '高' : v >= 3 ? '中' : '低'
}
function impactKey(n: number) {
  const v = Number(n) || 3
  return v >= 5 ? 'critical' : v >= 4 ? 'high' : v >= 3 ? 'mid' : 'low'
}
function confidencePct(v: number) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) + '%' : '—'
}

onMounted(async () => {
  await loadPrefs()
  await load()
})

watch(() => props.focusPending, (v) => {
  if (!v) return
  statusFilter.value = '待审批'
  includePending.value = true
  includeRevoked.value = false
  projectFilter.value = ''
  void load()
}, { immediate: true })
</script>
