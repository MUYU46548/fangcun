<template>
  <div v-if="ctl.aboutOpen" class="overlay" @mousedown.self="ctl.aboutOpen = false">
    <div id="about-modal">
      <h3>关于方寸</h3>
      <div class="about-brand">
        <span class="about-logo">方</span>
        <div>
          <b>方寸 tegula</b><span class="about-ver">v{{ ctl.appVersion || '…' }}</span>
          <div class="about-sub">本地优先的 agent 任务调度台 · 零依赖 · 数据在你自己手里</div>
        </div>
      </div>
      <p class="about-intro">
        把“任务收口 + 方针载体”做在一处：任务卡、执行日志、项目方针、决策记录都是本机 Markdown 明文，
        agent 通过 MCP 读写同一份台账 —— <b>你点头才算数</b>，AI 不能背着你往里塞东西。
        会花钱的只有 AI 问答与出单，且必须走你自己的 API（BYOK），不配就一分不花。
      </p>
      <div class="about-rows">
        <div><span class="k">版本</span><span class="v">{{ ctl.appVersion || '读取中…' }}</span></div>
        <div><span class="k">作者</span><span class="v">MUYU46548</span></div>
        <div><span class="k">许可证</span><span class="v">MIT · 免费开源，按“现状”提供</span></div>
        <div><span class="k">数据目录</span><span class="v about-path" :title="ctl.dataDir">{{ ctl.dataDir || '—' }}</span></div>
        <div><span class="k">当前视图</span><span class="v">{{ ctl.curViewLabel }} · {{ ctl.countText }}</span></div>
      </div>
      <div class="about-links">
        <button class="ghost" @click="ctl.aboutGoHelp">📖 使用手册</button>
        <button class="ghost" @click="ctl.aboutGoDisclaimer">📄 免责声明与用户协议</button>
        <button class="ghost" @click="ctl.aboutGoSettings">⚙ 设置</button>
        <button class="ghost" @click="ctl.bkOpenDir">打开备份目录</button>
        <button class="ghost" @click="ctl.openAppLogDir">打开日志目录</button>
      </div>
      <p class="about-note">
        数据是你的：任务就是 <code>task-data/</code> 里的 Markdown 文件，不进 git；
        删除只移入 <code>.trash/</code>；本地备份在 <code>backups/</code>。
        <br />
        © 2026 MUYU46548 · MIT License。使用前请读一遍免责声明：AI 会产生费用、
        备份可能失败、最终的数据保管责任在你自己。
      </p>
      <div class="acts">
        <button class="pri" @click="ctl.aboutOpen = false">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 关于方寸（2026-11-02 · App.vue 后三刀的第一刀「浮层」）
 *
 * 切分口径：只搬模板，不动任何逻辑 —— 状态与动作仍住在 App.vue，
 * 通过 `ctl` 传进来（照 `LogPurgeModal` / `TaskPreview` 已有的做法）。
 * 样式没动：`#about-modal` 这些 id 选择器还在 app.css 里，组件内保留同一组 id。
 */
defineProps<{ ctl: any }>()
</script>
