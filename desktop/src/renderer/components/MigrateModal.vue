<template>
  <div v-if="ctl.migrateTarget" class="overlay" @mousedown.self="ctl.migrateTarget = null">
  <div id="migrate-modal">
    <h3>切换数据目录</h3>
    <div class="mg-row"><span class="k">当前</span><span class="v">{{ ctl.dataDir }}</span></div>
    <div class="mg-row"><span class="k">目标</span><span class="v">{{ ctl.migrateTarget.dir }}</span></div>
    <div class="mg-row">
      <span class="k">目标现状</span>
      <span class="v" :class="{ warn: !ctl.migrateTarget.empty }">
        <template v-if="ctl.migrateTarget.empty">空目录，可安全迁入</template>
        <template v-else>
          已有 {{ ctl.migrateTarget.taskCount }} 个任务文件<template v-if="ctl.migrateTarget.archivedCount">（含 {{ ctl.migrateTarget.archivedCount }} 个归档）</template>
        </template>
      </span>
    </div>

    <div class="mg-notice">
      <b>将按顺序执行</b>
      <ul>
        <li>先把当前数据<b>完整备份</b>一份；备份失败则中止，不会动手</li>
        <li>把 <code>task-data/</code> · <code>registry.yaml</code> · <code>docs/</code> <b>复制</b>到目标目录</li>
        <li>切换方寸的数据指向并重新加载</li>
        <li>原目录<b>保留不删</b>，确认无误后你可自行清理</li>
      </ul>
      <div class="mg-hint">回收站（<code>.trash</code>）与本地备份（<code>backups/</code>）不随迁。</div>
      <div class="mg-hint" v-if="!ctl.migrateTarget.empty">
        目标目录已有数据，迁入后同名文件将被覆盖（源目录仍完整保留）。
      </div>
    </div>

    <div class="acts">
      <button class="ghost" @click="ctl.migrateTarget = null">取消</button>
      <button class="pri" :disabled="ctl.migrateBusy" @click="ctl.confirmMigrate">
        {{ ctl.migrateBusy ? '迁移中…' : (ctl.migrateTarget.empty ? '开始迁移' : '覆盖式迁入') }}
      </button>
    </div>
  </div>
</div>
</template>

<script setup lang="ts">
/** 切换数据目录（2026-11-02 · 后三刀第一刀「浮层」）：只搬模板，状态与动作仍住 App.vue */
defineProps<{ ctl: any }>()
</script>
