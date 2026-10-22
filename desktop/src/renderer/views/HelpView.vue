<!--
  帮助手册视图（从 App.vue 抽出，2026-10-22 · 拆分计划第 1 批第 1 块）

  **为什么先拆它**：这一块纯静态 —— 零请求、零状态、只有一个「回看板」按钮。
  拆错了看一眼就知道（计划里就是这么排的：从耦合最低的开始）。
  抽离时**一个字都没改文案**：拆分的红线是"不许顺带改功能/改内容"，
  要改文案另开一笔。

  依赖只有一个事件：点「⌂ 回看板」→ emit('home') → App.vue 的 goHome()。
  样式仍在 App.vue 的全局 `<style>` 里（非 scoped）—— 本组件不带自己的样式，
  所以拆分不会改变任何像素。
-->
<template>
  <main id="board" class="help-view">
    <div class="help-head">
      <h3>帮助手册</h3>
      <span class="help-sub">方寸怎么用 —— 每个页签干什么、怎么筛、怎么备份恢复</span>
      <span class="views-grow"></span>
      <button class="ghost" @click="$emit('home')">⌂ 回看板</button>
    </div>

    <div class="help-body">
      <section class="help-sec">
        <h4>一、方寸是什么</h4>
        <p>
          本地优先的 agent 任务调度台。任务就是 <code>task-data/</code> 目录里的 Markdown 文件，
          用 YAML 头记录字段、正文记录内容 —— <b>不锁在你自己的数据库里</b>，随时能用记事本打开。
          定位是「任务收口 + 方针载体」：让"哪些事定了、哪些还悬着"有地方挂。
        </p>
      </section>

      <section class="help-sec">
        <h4>二、每个页签干什么</h4>
        <table class="help-table">
          <tbody>
          <tr><th>页签</th><th>用途</th></tr>
          <tr><td>看板</td><td>主视图。按状态分列，拖卡片即可改状态。搜索、筛选、分组、排序都在顶上。</td></tr>
          <tr><td>问答</td><td>问一句就能看实况：到哪了 / 欠着什么 / 谁在等谁。答不了会明说，不编。</td></tr>
          <tr><td>待办</td><td>轻量清单。可以先记一句，之后再转成任务卡或执行日志。</td></tr>
          <tr><td>日志</td><td>执行记录。一次会话/一段工作结束了写一条，可关联任务、带附件、写下「下一步」。</td></tr>
          <tr><td>项目</td><td>按项目聚合：该项目有多少任务、卡在哪儿、契约填了没。</td></tr>
          <tr><td>阻塞</td><td>谁挡着谁 —— 从任务卡的依赖关系里算出来的阻塞链。</td></tr>
          <tr><td>路线图</td><td>跨项目的时间线，看哪几件事能并行。</td></tr>
          <tr><td>日历</td><td>按日期铺开任务，看哪天最挤。</td></tr>
          <tr><td>归档</td><td>已完成/已归档的任务。归档只是"先别看了"，不是删除。</td></tr>
          <tr><td>回收站</td><td>删除的东西先来这里，可以还原。彻底删除才真没了。</td></tr>
          <tr><td>启动台</td><td>登记常用应用/命令，一键拉起。</td></tr>
          <tr><td>决策</td><td>决策卡：定了什么、哪天定的、出处、现在还算不算数。</td></tr>
          <tr><td>技能</td><td>把方寸的技能包装到 Hermes / DSH 等 agent 上。</td></tr>
          <tr><td>服务</td><td>只读监控端口占用 —— 只看不杀。</td></tr>
                    </tbody>
        </table>
      </section>

      <section class="help-sec">
        <h4>三、搜索框怎么用</h4>
        <p>直接在搜索框里敲，回车生效。支持的写法（可组合）：</p>
        <table class="help-table">
          <tbody>
          <tr><th>写法</th><th>意思</th><th>例子</th></tr>
          <tr><td><code>#标签</code></td><td>按标签筛</td><td><code>#紧急</code></td></tr>
          <tr><td><code>@项目</code></td><td>按项目筛</td><td><code>@司天</code></td></tr>
          <tr><td><code>due:MM-DD</code></td><td>按到期日筛</td><td><code>due:10-15</code></td></tr>
          <tr><td>一整句话</td><td>当作自然语言查询解析</td><td><code>本周到期的紧急任务</code></td></tr>
                    </tbody>
        </table>
        <p class="help-tip">
          顶上「＋ 筛选」里的条件会变成可点 ✕ 的小标签 —— 筛了什么一眼可见，撤销不用回头翻下拉。
        </p>
      </section>

      <section class="help-sec">
        <h4>四、顶栏那几个按钮</h4>
        <table class="help-table">
          <tbody>
          <tr><th>按钮</th><th>作用</th></tr>
          <tr><td>← 返回</td><td>回上一个看过的视图。没有可回退的视图时会置灰。</td></tr>
          <tr><td>⌂ 首页</td><td>回看板，并清掉当前的搜索与筛选 —— 一记干净的复位。</td></tr>
          <tr><td>? 帮助</td><td>就是这一页。</td></tr>
          <tr><td>⟳ 同步</td><td>把数据一键推送到你配好的 Git 仓库。跑的时候图标会转，结果在按钮上直接报。</td></tr>
          <tr><td>⊟ 折叠 / ⊞ 展开</td><td>长单子时只留分组名和数量，一屏看完。</td></tr>
          <tr><td>⌗ / ⇅</td><td>怎么分组、怎么排序。点开的是同一个面板，选项本身即按钮，一次点击生效。</td></tr>
          <tr><td>💾</td><td>备份：本地打包 + 云端（WebDAV 或 Git），可校验、可恢复。</td></tr>
          <tr><td>🔔</td><td>通知中心：逾期、卡住、待审批这些提醒。</td></tr>
          <tr><td>📋</td><td>诊断日志：出错时打开看尾部、打开日志目录。</td></tr>
          <tr><td>⚙</td><td>设置：数据目录、备份、外观、LLM 配置等。</td></tr>
                    </tbody>
        </table>
      </section>

      <section class="help-sec">
        <h4>五、备份与恢复</h4>
        <p>
          数据是你的，所以方寸把"怎么带走、怎么找回"放在明面上。备份包是五件套：
          ZIP + 校验文件 + 清单 + 说明 + 一键恢复脚本 —— <b>没有方寸也能用它恢复</b>。
        </p>
        <p class="help-tip">
          密钥永不进备份包（含密钥的文件名在打包时被排除）。恢复前会先校验，
          校验不过绝不动你现有的数据。
        </p>
      </section>

      <section class="help-sec">
        <h4>六、按错了怎么办</h4>
        <p>
          删除只移入 <code>task-data/.trash/</code>，回收站里能还原；
          归档只是从主视图挪走；批量操作前都有确认。
          <b>没有"一键清空"这类按钮</b>，破坏性操作一律先快照。
        </p>
      </section>

      <!-- 2026-10-16（暮雨第 1 条）：「你说在方寸里真跑一遍 AI 起草，我根本找不到入口在哪里，
           也没找到配置模型的地方」。入口与配置一直都在，缺的是**一条把它们说出来的路径** ——
           这一节就是那条路径，写清两步怎么走、结果落哪、钱怎么算。 -->
      <section class="help-sec">
        <h4>七、AI 规划（可选；要花钱，先看清）</h4>
        <p>
          让方寸替你起草任务卡或项目说明 —— 它用的是<b>你自己那份模型 API</b>（BYOK）：
          方寸不预置任何端点、不代理任何模型服务、也不代收费用。
        </p>
        <table class="help-table">
          <tbody>
          <tr><th>第 1 步 · 配通道</th>
            <td>设置（⚙）→ 左侧「Agent」→「✨ 模型通道」：填 Base URL、模型名、API Key，
              点「测试连接」确认通了。密钥只存本机、回显只有掩码。</td></tr>
          <tr><th>第 2 步 · 用它</th>
            <td>「项目」页点开一个项目 → 右侧「✨ AI 规划」→ 写一句话目标 →
              点「✨ 拆成任务卡草稿」（或「📄 起草项目说明」）。没配通道时弹窗里会当场指路。</td></tr>
          <tr><th>结果落哪</th>
            <td>每次都落成<b>「待审批」卡</b> —— 你过目、改完、点头之后才进待办。
              AI 不能背着你往方寸里塞东西。</td></tr>
                    </tbody>
        </table>
        <p class="help-tip">
          涉及花钱：界面上的 token 用量与花销<b>只是估算、不是计费依据</b>；
          调用费用由你与模型服务方按其实时价格结算，<b>下单前请以服务方官网实时价为准</b>。
          完整条款在 设置 → 诊断 →「⚖ 免责与知情声明」里。
        </p>
      </section>
    </div>
  </main>
</template>

<script setup lang="ts">
// 纯静态视图：无状态、无请求。唯一交互是「回看板」，交给父组件处理
// （goHome 要清搜索与筛选，那是 App.vue 的事，不该搬到这里）。
defineEmits<{ (e: 'home'): void }>()
</script>
