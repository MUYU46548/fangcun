<template>
    <main id="board" class="launchpad">
      <div class="lp-header">
        <h3>启动台</h3>
        <div class="lp-ctrls">
          <button @click="ctl.openAddApp">+ 添加应用</button>
          <button class="ghost" @click="ctl.openConfigPath">打开配置</button>
          <button class="ghost" @click="ctl.refreshApps">⟳ 刷新</button>
        </div>
      </div>
      <!-- 2026-10-16 用户第 2 条：这里是**快捷入口**，不是服务管理。
           用户原话给的类比就是“steam 启动非 steam 游戏”——你登记一个你常用的东西，
           点一下就开；方寸不提供它、不监控它、更不关心它内部开了什么端口。
           ⚠ 所以卡片上**没有端口那一行**：那是“服务/端口”页的事，见那边。 -->
      <div class="lp-note">
        这就是快捷入口：登记一个你常用的应用或命令，<b>点一下就开</b>。
        方寸只管把它拉起来，不管它内部怎么跑。
      </div>
      <div class="lp-grid" v-if="ctl.launchpadApps.length">
        <!-- 右键菜单（2026-10-17 暮雨：“不能右键卡片进行编辑和删除”）：编辑原先只能从卡片上的
             ✏️ 进、删除更藏在编辑弹窗里，两条路都要先点开一层。右键是直达。
             ⚠ 菜单组件不产生包裹元素（ContextMenuRoot），`.lp-grid` 的网格布局一个像素不动。 -->
        <AppCardMenu
          v-for="app in ctl.launchpadApps"
          :key="app.id"
          :app="app"
          @pick="ctl.onAppMenuPick"
        >
          <div
            class="lp-card"
            :title="'点卡片启动：' + (app.cmd || app.path)"
            @click="ctl.launchAppClick(app)"
          >
            <div class="lp-icon">{{ app.name.charAt(0) }}</div>
            <div class="lp-info">
              <div class="lp-name">{{ app.name }}</div>
              <div class="lp-desc">{{ app.description || app.path }}</div>
            </div>
            <div class="lp-actions">
              <button class="ghost lp-edit" title="编辑这条登记（名称 / 路径 / 参数 / 备注）" @click.stop="ctl.openEditApp(app)">✏️ 编辑</button>
              <button class="ghost lp-open" title="在资源管理器里打开它所在的文件夹" @click.stop="ctl.openAppFolder(app)">📁</button>
              <button class="ghost lp-del" title="只删掉这条登记，磁盘上的应用文件不受影响" @click.stop="ctl.askRemoveApp(app)">🗑</button>
            </div>
          </div>
        </AppCardMenu>
      </div>
      <div class="empty-state" v-else>
        <div class="empty-icon">🚀</div>
        <div class="empty-text">还没有登记任何应用 —— 点右上角“+ 添加应用”，
          填上名字和一个程序/脚本的路径就行（想做启动台里的那个"快捷方式"）。</div>
      </div>
    </main>
</template>

<script setup lang="ts">
import AppCardMenu from '../components/AppCardMenu.vue'

/**
 * 启动台（2026-11-03 · App.vue 拆分「视图刀」）
 *
 * 只搬模板：登记 / 启动 / 右键菜单动作仍在 App.vue。
 * 边界不变：这是快捷入口，不是服务管理，卡片上没有端口那一行。
 */
const props = defineProps<{ ctl: any }>()
const ctl = props.ctl
/** 拆分守卫反查锚点 */
const launchpadCtl = ctl
</script>
