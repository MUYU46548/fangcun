<!--
  设置 · 备份与恢复（2026-10-30 App.vue 拆分第六刀）

  为什么能整块切：备份状态收在 `composables/useBackup.ts` 的模块级单例里，
  App（顶栏指示灯）与本组件拿的是**同一组 ref** —— 不需要传 50 个 props，也不会出现第二份状态。
  样式是全局的（styles/app.css），模板原样搬，class 一个没改。
-->
<script setup lang="ts">
import { useBackup } from '../../composables/useBackup'

// 单例：拿到的就是 App 里那份状态（toast 已在 App 首次调用时注入）
const {
  backupInfo, openBackupFolder, bkForm, bkSize, bkMsg, bkMsgType, bkBusy, bkTesting, bkTab, bkLocal, bkRemote, bkStatus, bkState, bkShowLog, bkLogLines, bkVerifyResult, bkCurrentList, bkAlert, bkDotClass, bkStatusText, bkTooltip, bkFmt, bkInitBackup, bkRefreshStatus, bkLoadConfig, bkLoadSizeReport, bkMB, bkLoadList, bkExportCandidates, bkLatestPackagePath, bkSwitchTab, bkRefreshList, bkSaveConfig, bkSaveSlim, bkReportResult, bkSaveAndRun, bkRunLocalOnly, bkTestRemote, bkRestore, bkOpenDir, bkToggleLog, bkPickDir, gitRemote, gitBranch, gitToken, gitHasToken, gitBusy, gitMsg, gitMsgType, loadGitStatus, gitCommitForm, gitSaveConfig, gitForgetToken, gitTest, gitPushNow, bkCopyResticScript, bkExportTo, bkInspected, bkInspectRow, bkVerifyPackage, bkRestoreFromFile,
} = useBackup()
</script>

<template>
          <div class="sect backup-sect">
            <h4>🛡️ 备份与恢复</h4>
  
            <div class="bk-status" :class="bkDotClass">
              <span class="bk-dot"></span>
              <span class="bk-status-text">{{ bkStatusText }}</span>
              <span v-if="bkStatus.nextRunAt" class="bk-next">下次 {{ bkFmt(bkStatus.nextRunAt) }}</span>
            </div>
            <div v-if="bkState.lastError" class="bk-err-line">上次失败（{{ bkState.failStreak }} 次连续）：{{ bkState.lastError }}</div>
  
            <!-- 备份教程（2026-10-11 用户要求：「按钮很紧凑很乱，用户可能看不懂怎么用…能不能加一个备份教程」）。
                 放在配置**前面** —— 先讲清"这套东西怎么用"，再让人填表；顺序反了就是让人对着
                 六个输入框猜流程。后期做单 HTML 方寸说明书时，这一段的文案可以整段搬过去。 -->
            <div class="bk-guide">
              <div class="bk-guide-h">怎么用（30 秒读完）</div>
              <ol>
                <li><b>先本地，后云端。</b>点「立即备份」就会在 <code>backups/</code> 里打一个 zip 包 ——
                  这一步不需要任何账号；先确认它可用，再去配云端。</li>
                <li><b>想上云再填下面那张表。</b>填 WebDAV 地址与账号 → 点「测试远端」确认通 →
                  再点「立即备份」，包会同时落到本地和云端。</li>
                <li><b>恢复永远从「备份历史」那一行开始。</b>点任意一行能看这一份里到底有什么，
                  确认无误再点行尾的「恢复」；恢复前会自动给当前数据打快照。</li>
                <li><b>不用网盘也能备份。</b>「手动流转」里点「导出备份」把包复制到你选的目录
                  （OneDrive 这类同步盘就这样用）；「Git 通道」走版本历史；
                  「restic 脚本」给你自己挂计划任务。</li>
              </ol>
              <div class="bk-guide-note">
                一句话：<b>备份包就是一个 zip</b>。它<b>不加密</b>（里面是明文任务数据），
                别往公开可访问的目录放 —— 细节见下方「数据安全须知」。
              </div>
            </div>
  
            <div class="bk-grid">
              <label>WebDAV 地址</label>
              <input class="font-[inherit]" v-model="bkForm.url" placeholder="https://dav.jianguoyun.com/dav/fangcun" />
              <label>账号</label>
              <input class="font-[inherit]" v-model="bkForm.username" placeholder="邮箱 / 用户名" />
              <label>密码</label>
              <input class="font-[inherit]"
                v-model="bkForm.password"
                type="password"
                :placeholder="bkForm.hasPassword ? '已加密保存（留空=不修改）' : '应用密码（坚果云需用应用密码）'"
              />
              <label>自动备份</label>
              <div class="bk-inline">
                <input class="font-[inherit]" id="bk-enabled" type="checkbox" v-model="bkForm.enabled" />
                <label for="bk-enabled" class="bk-cb">启用 · 每</label>
                <input type="number" v-model.number="bkForm.intervalHours" min="0" max="168" class="bk-num font-[inherit]" />
                <span>小时 · 启动后</span>
                <input type="number" v-model.number="bkForm.firstDelayMinutes" min="0" max="1440" class="bk-num font-[inherit]" />
                <span>分钟首次</span>
              </div>
              <label>保留份数</label>
              <div class="bk-inline">
                <span>本地</span>
                <input type="number" v-model.number="bkForm.localKeep" min="1" max="200" class="bk-num font-[inherit]" />
                <span>远端</span>
                <input type="number" v-model.number="bkForm.remoteKeep" min="0" max="200" class="bk-num font-[inherit]" />
                <label class="bk-cb"><input class="font-[inherit]" type="checkbox" v-model="bkForm.allowSelfSigned" /> 允许自签证书（NAS）</label>
              </div>
              <label>存放目录</label>
              <div class="bk-inline">
                <input v-model="bkForm.localDir" class="bk-path font-[inherit]" placeholder="留空 = 数据目录下的 backups/" />
                <button class="ghost bk-mini" @click="bkPickDir">浏览…</button>
                <button class="ghost bk-mini" @click="bkOpenDir">打开</button>
              </div>
            </div>
  
            <!-- 动作按用途分组（2026-10-11 用户：「按钮很紧凑很乱，用户可能看不懂怎么用」）。
                 原先七个按钮挤在一行，主次不分 —— 「立即备份」和「打开备份文件夹」看着一样重要。
                 现在按 **现在备份 / 连接设置 / 文件夹** 三档分开，每组带小标题。 -->
            <div class="bk-actions">
              <div class="bk-act-group">
                <span class="bk-act-label">现在备份</span>
                <button class="pri" :disabled="bkBusy" @click="bkSaveAndRun">{{ bkBusy ? '备份中…' : '立即备份' }}</button>
                <button class="ghost" :disabled="bkBusy" @click="bkRunLocalOnly"
                  title="只在本机打包，不传云端（没配 WebDAV / 只想留个本地快照时用）">仅本地</button>
              </div>
              <div class="bk-act-group">
                <span class="bk-act-label">连接设置</span>
                <button class="ghost" :disabled="bkTesting" @click="bkTestRemote">{{ bkTesting ? '测试中…' : '测试远端' }}</button>
                <button class="ghost" @click="bkSaveConfig" title="把上面那张表写进配置（密码只有保存后才加密留存）">保存配置</button>
              </div>
              <div class="bk-act-group">
                <span class="bk-act-label">文件夹</span>
                <button class="ghost" @click="bkOpenDir">打开备份文件夹</button>
                <!-- 刚做完一次备份后，直接定位到那个文件所在目录（原 openBackupFolder 一直没入口） -->
                <button v-if="backupInfo" class="ghost" :title="'最近一次备份：' + backupInfo.path + '（' + backupInfo.sizeKB + ' KB）'"
                  @click="openBackupFolder">最近备份所在目录</button>
              </div>
            </div>
  
            <!-- 手动流转同样按用途分组（2026-10-11 用户：「按钮很紧凑很乱」）——
                 原来四个按钮排一行，「导出」和「恢复」挨着，误点的代价完全不对称。 -->
            <div class="bk-actions bk-manual">
              <div class="bk-act-group">
                <span class="bk-act-label">不用网盘也能备份</span>
                <!-- 2026-09-26 用户第 1、2 条：不再要人选下拉（「必须逐字核对，很难受」），
                     点一下就导出**最新一份备份**；落盘**只有一个 zip**。 -->
                <button class="ghost" :disabled="bkBusy" @click="bkExportTo"
                  title="把最新一份备份复制到所选目录 —— 落盘只有一个 zip 文件；一份备份都没有时才现打一份">📤 导出备份（一个 zip）</button>
                <!-- restic 脚本（2026-10-11 用户拍板走「方案 A」）：方寸只生成脚本 + 说明，
                     定时你自己挂 —— 零维护、零鉴权、**不经手你的仓库密码**。 -->
                <button class="ghost" :disabled="bkBusy" @click="bkCopyResticScript"
                  title="生成一份 restic 增量备份脚本（复制到剪贴板）—— 自己挂计划任务即可；方寸不接管你的仓库密码">📜 restic 脚本</button>
              </div>
              <div class="bk-act-group">
                <span class="bk-act-label">检查与恢复</span>
                <button class="ghost" :disabled="bkBusy" @click="bkVerifyPackage"
                  title="挑一个备份包做 sha256 + 结构双重校验（从网盘下载回来的副本建议定期抽查）">🔍 校验备份包…</button>
                <button class="ghost" :disabled="bkBusy" @click="bkRestoreFromFile"
                  title="从磁盘上任一备份包恢复；恢复前会自动给当前数据打快照，校验不过不动现有数据">📥 从文件恢复…</button>
              </div>
            </div>
            <div v-if="bkMsg" :class="'llm-config-msg ' + bkMsgType">{{ bkMsg }}</div>
            <div v-if="bkForm.url && !bkForm.hasPassword" class="hint">
              提示：密码只有保存后才会加密留存，重启应用后仍可自动备份。
            </div>
  
            <div class="bk-history">
              <div class="bk-tabs">
                <span :class="{ on: bkTab === 'local' }" @click="bkSwitchTab('local')">本地 ({{ bkLocal.length }})</span>
                <span :class="{ on: bkTab === 'remote' }" @click="bkSwitchTab('remote')">远端 ({{ bkRemote.length }})</span>
                <!-- 刷新（2026-10-11 用户补充）：此前只有「切页签」才会重读列表，
                     别处刚备份完/轮换掉的文件在列表里还是旧的。 -->
                <button class="ghost bk-mini bk-refresh" :disabled="bkBusy" title="重新读取备份列表" @click="bkRefreshList">⟳ 刷新</button>
              </div>
              <div class="bk-list">
                <!-- 2026-09-25 第 5 条：列表按「最后更新」倒序（主进程排好），首行是「最新」。
                     2026-09-28（卡 026-001 验收驳回原话：「依然不能手动点来选中备份，
                     回收站都能点了，备份不能点，无语」）：**整行可点** = 看这一份里到底有什么
                     （校验 + manifest 摘要）。原来这一行是没有 @click 的死 div，
                     想确认内容只能另点「🔍 校验备份包…」再走文件选择器挑一遍 —— 而这一份就在眼前。 -->
                <div v-for="(b, bi) in bkCurrentList" :key="b.name"
                  class="bk-item" :class="{ on: bkInspected === b.name }"
                  :title="bkTab === 'local' ? '点击查看这一份里有什么（校验 + 文件清单）' : '远端备份需先下载到本地才能查看内容'"
                  @click="bkInspectRow(b)">
                  <div class="bk-item-main">
                    <span class="bk-item-name">{{ b.name }}</span>
                    <span v-if="bi === 0" class="bk-newest" title="按最后更新倒序 —— 这就是最新的一份">最新</span>
                    <span class="bk-item-meta">
                      {{ b.bytes != null ? (b.bytes / 1024).toFixed(0) + ' KB' : '—' }} · {{ bkFmt(b.mtime) }}
                    </span>
                  </div>
                  <span v-if="bkInspected === b.name" class="bk-inspecting">已展开 ↓</span>
                  <button class="ghost bk-restore" :disabled="bkBusy" @click.stop="bkRestore(b)">恢复</button>
                </div>
                <div v-if="!bkCurrentList.length" class="hint">暂无备份{{ bkTab === 'remote' ? '（需先配置并测试 WebDAV）' : '' }}</div>
              </div>
            </div>
  
            <div v-if="bkVerifyResult" class="bk-verify" :class="bkVerifyResult.ok ? 'ok' : 'bad'">
              <div class="bk-verify-head">
                {{ bkVerifyResult.ok ? '✅ 备份包完整可用' : '❌ 备份包校验未通过' }}
                <span class="bk-verify-path">{{ bkVerifyResult.name }}</span>
              </div>
              <div v-if="bkVerifyResult.manifest" class="bk-verify-meta">
                备份时间 {{ bkFmt(bkVerifyResult.manifest.createdAt) }} ·
                {{ bkVerifyResult.manifest.totalFiles }} 个文件 ·
                {{ (bkVerifyResult.manifest.totalBytes / 1024).toFixed(1) }} KB
              </div>
              <ul v-if="bkVerifyResult.errors && bkVerifyResult.errors.length" class="bk-verify-errs">
                <li v-for="(e, i) in bkVerifyResult.errors.slice(0, 8)" :key="i">{{ e }}</li>
              </ul>
              <button class="ghost bk-mini" @click="bkVerifyResult = null">关闭</button>
            </div>
  
            <!-- `bk-sect-hint` 这个类名是给 DOM 顺序断言用的锚点（瘦身必须在它下面、Git 通道必须在它下面）：
                 否则那条断言只能靠"文案里有这句话"来间接定位，改一个字就失效。 -->
            <div class="hint bk-sect-hint">
              备份范围：task-data/ + registry.yaml + policies/ + docs/。密钥文件（llm-config.json、backup-config.json 等）永不入包，
              每次备份的 manifest 里会记录被排除项与被瘦身跳过的文件。恢复前必做 sha256 + 结构双重校验，校验不过不动现有数据。
            </div>
  
            <!-- Git 通道（2026-10-11 用户第 1 条）**放在这条「备份范围」说明下面** ——
                 用户原话：「Git 通道放在…下面，防止和手动备份压缩包混在一起」。
                 它确实不是"再打一个包"，而是"把同一批文件按版本历史同步进仓库"，
                 所以贴着说明放，跟上面那排"手动流转（导出 zip）"隔开。 -->
            <div class="sect-btns bk-manual bk-git">
              <span class="bk-manual-label">Git 通道（把任务/日志/方针卡的真实文件同步进仓库，有逐文件历史）</span>
              <input v-model="gitRemote" class="git-in font-[inherit]" spellcheck="false"
                placeholder="仓库地址，如 https://github.com/你/fangcun-backup.git" />
              <input v-model="gitToken" class="git-in font-[inherit]" type="password" spellcheck="false"
                :placeholder="gitHasToken ? '令牌已保存（重填可覆盖）' : '访问令牌（只用于推送，加密存本机）'" />
              <select v-model="gitBranch" class="git-branch font-[inherit]" title="推送到哪个分支">
                <option value="main">main</option>
                <option value="master">master</option>
              </select>
              <button class="ghost" :disabled="gitBusy" @click="gitSaveConfig">保存</button>
              <button class="ghost" :disabled="gitBusy" @click="gitTest">🔌 测试连接</button>
              <button class="ghost" :disabled="gitBusy" @click="gitPushNow"
                title="把数据目录里 task-data / registry.yaml / policies / docs 的真实文件铺进仓库并提交 —— 推的是文件，不是压缩包">⬆ 同步到仓库</button>
              <button class="ghost" v-if="gitHasToken" @click="gitForgetToken" title="清掉本机保存的令牌（不含仓库地址）">清除令牌</button>
            </div>
            <div class="bk-dim">
              同步的是真实文件（不是压缩包）：范围与上面的备份一致（task-data / registry.yaml / policies / docs），
              同样受下面的「备份瘦身」约束；密钥类文件永不进仓库。推送被拒时会自动并回远端再推一次，绝不用 --force。
            </div>
            <div v-if="gitMsg" :class="'llm-config-msg ' + gitMsgType">{{ gitMsg }}</div>
  
            <!-- 备份瘦身（2026-10-11 用户第 1 条）**放在「数据安全须知」上面** ——
                 它跟"数据安全/体积"是同一类事，而上面的配置表讲的是"怎么连、怎么存"。
                 用户原话：「瘦身块应该放在数据安全须知上面」。 -->
            <div class="bk-slim">
              <div class="bk-slim-head">
                <b>备份瘦身</b>
                <span class="bk-slim-hint" v-if="bkSize">当前备份范围 {{ bkSize.files }} 个文件 · {{ bkMB(bkSize.totalBytes) }}；按下面的设置实际入包约 {{ bkMB(bkSize.keptBytes) }}</span>
                <span class="bk-slim-hint" v-else>统计中…</span>
                <button class="ghost bk-mini" @click="bkLoadSizeReport">重算</button>
              </div>
              <label class="bk-cb">
                <input class="font-[inherit]" type="checkbox" v-model="bkForm.excludeLogAttachments" @change="bkSaveSlim" />
                排除执行日志附件目录（docs/执行日志/_attachments）
                <span class="bk-dim" v-if="bkSize && bkSize.logAttachments.files">—— {{ bkSize.logAttachments.files }} 个文件 / {{ bkMB(bkSize.logAttachments.bytes) }}</span>
              </label>
              <div class="bk-inline">
                <span>跳过大于</span>
                <input type="number" v-model.number="bkForm.maxFileMB" min="0" max="10240" class="bk-num font-[inherit]"
                  @change="bkSaveSlim" />
                <span>MB 的单个文件（0 = 不限）</span>
              </div>
              <!-- 最大的几个文件：让"为什么大"当场有答案（此前只能靠猜） -->
              <div v-if="bkSize && bkSize.largest.length" class="bk-slim-top">
                <span class="bk-dim">最占地方的几个文件：</span>
                <div v-for="f in bkSize.largest" :key="f.path" class="bk-slim-file">
                  <span class="bk-slim-size">{{ bkMB(f.bytes) }}</span>
                  <span class="bk-slim-path">{{ f.path }}</span>
                </div>
              </div>
              <div v-if="bkSize && bkSize.omitted.length" class="bk-dim">
                按当前设置会跳过 {{ bkSize.omitted.length }} 个文件（省 {{ bkMB(bkSize.omittedBytes) }}）——
                清单逐条记进备份包的 manifest.json，不静默丢。
              </div>
            </div>
  
            <div class="bk-notice">
              <b>数据安全须知</b>
              <ul>
                <li>备份包内含任务数据<strong>完整明文内容</strong>，未加密。请勿放入公开可访问的目录或公开分享链接。</li>
                <li>API Key 等密钥<strong>永不进入备份包</strong>；从备份恢复后，LLM 与 WebDAV 配置需要重新填写。</li>
                <li>恢复会覆盖当前数据。应用会自动为现有数据打快照并在失败时回滚，但请勿在恢复过程中断电或强制退出。</li>
                <li>云端副本由你所用的网盘客户端负责同步，方寸无法校验远端是否完整。建议定期用「校验备份包」抽查下载回来的副本。</li>
                <li>备份只覆盖数据，<strong>不含代码与 git 历史</strong>。手写的备份包请自行保留校验文件（<code>.sha256</code>），
                    它是判断文件是否损坏的唯一依据。</li>
                <li>备份目录若指向网盘同步文件夹，轮换会同步删除云端旧包，这是预期行为。</li>
              </ul>
            </div>
  
            <button class="ghost bk-log-toggle" @click="bkToggleLog">📋 {{ bkShowLog ? '收起日志' : '查看备份日志' }}</button>
            <pre v-if="bkShowLog" class="bk-log">{{ bkLogLines.length ? bkLogLines.join('\n') : '(暂无日志)' }}</pre>
          </div>
</template>
