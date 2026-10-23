<!--
  待办视图（2026-10-23 · 拆分第 1 批第 10 块：模板搬成组件）

  **为什么这一块最后搬**：`todos` 这一个 ref 在 App.vue 里被 60 处共用（日历、在途一屏、
  日志转待办、快速记、项目统计都读它），所以第 9 块先把数据与动作抽进
  `composables/useTodos.ts`，这一步才只搬模板 —— 两步分开，红了能分清是哪一步坏的。

  **组件边界**：只「显示 + 收集意图」，一个副作用都不留在这里。
  父组件把 `useTodos()` 的返回值、项目列表、以及五个既有能力
  （右键菜单 / 撤销已转出 / 转日志确认 / 指派日期 / 拖入导入 / 拖拽高亮）
  打包成一个 reactive 对象，作为唯一 prop `ctl` 传进来。

  ⚠ **为什么是单个 reactive prop、而不是 40 个 props**：
    · 这一块要 14 个状态 + 17 个动作 + 6 个能力，逐个绑会在 App.vue 挤成一大片，
      漏一个的后果是点了没反应（与 2026-09-22「启动台 + 添加应用」那个 bug 同型）；
    · `useTodos()` 返回的是**一堆 ref**，直接当 prop 传进子组件时模板**不会自动解包**
      （解包只对 `<script setup>` 顶层绑定生效）—— 所以父组件用 `reactive()` 包一层，
      属性访问即解包，子组件里写 `ctl.todoFilter` 就是值。
    · 代价：类型是 `any`（组合式函数的返回值本身没有导出的类型）。
      真正吃类型的那一层（筛选 / 排序 / 逾期判据）在 `useTodos.ts` 里，它照样有类型。

  ⚠ `<main id="board" class="todos-view">` 这层壳必须留着：视图互斥与几何断言
    （`#board.todos-view`）都按它选，换成 div 就得同步改一堆断言。

  ⚠ 这里**不许**用 Tailwind 工具类：`tailwind.config.js` 的 content 只覆盖
    `src/renderer/components/`（`check-ui-base` 守着），views/ 下写的 utility 不会生成 CSS。
-->
<template>
  <main id="board" class="todos-view"
    @dragenter.prevent="ctl.dragEnter('todo')"
    @dragover.prevent="ctl.dragPulse()"
    @dragleave="ctl.dragLeave('todo')"
    @drop="ctl.onTodoDrop"
    :class="{ 'drop-target': ctl.todoDragOver }"
  >
    <div class="todos-header">
      <h3>待办</h3>
      <div class="todos-ctrls">
        <!-- 2026-09-29 用户第 1 条：小框（+ 添加）与「大框新建」并排 = 两个入口，
             小框长得像搜索框，纯误导；新建待办是慎重举动，只留一个入口 → 标准编辑大框。 -->
        <button class="ghost todo-new" title="新建待办（可一次填项目 / 优先级 / 到期日）；也可直接拖入 txt/md" @click="ctl.openTodoCreator()">＋ 新建待办</button>
        <select v-model="ctl.todoProjectFilter" class="todo-filter" title="按项目筛选（只影响显示）">
          <option value="__all__">全部项目</option>
          <option value="__none__">（不归属任何项目）</option>
          <option v-for="p in ctl.projects" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
        </select>
        <select v-model="ctl.todoSort" class="todo-filter" title="排序方式">
          <option value="default">默认：未完成 → 优先级 → 新的在前</option>
          <option value="due">到期日近的在前</option>
          <option value="created">最新创建在前</option>
          <!-- 2026-10-01 用户第 2 条：优先级/更新时间这两种最常被要的排法补上 -->
          <option value="priority">优先级从高到低</option>
          <option value="updated">最近更新在前</option>
        </select>
        <select v-model="ctl.todoFilter" class="todo-filter">
          <option value="all">全部</option>
          <option value="active">未完成</option>
          <option value="done">已完成</option>
        </select>
        <button class="ghost batch-mode-btn" :class="{ active: ctl.todoBatchMode }" @click="ctl.toggleTodoBatchMode"
          title="开启批量选择，点击卡片即勾选/取消">
          <span v-if="!ctl.todoBatchMode">☑ 多选</span>
          <span v-else>☑ <i style="color:#fff">{{ ctl.selectedTodoBatch.length || 0 }}</i></span>
        </button>
      </div>
    </div>
    <div v-if="ctl.todoBatchMode" class="batch-bar">
      <span class="batch-count">已选 {{ ctl.selectedTodoBatch.length }}</span>
      <button class="ghost" @click="ctl.toggleSelectAllTodos">{{ ctl.selectedTodoBatch.length === ctl.filteredTodos.length ? '取消全选' : '全选' }}</button>
      <button class="ghost" title="批量标为已完成" @click="ctl.executeBatchTodoDone(true)">批量完成</button>
      <button class="ghost" title="批量标为未完成（勾错了批量改回来）" @click="ctl.executeBatchTodoDone(false)">取消完成</button>
      <button class="danger" title="批量删除（会二次确认，不可恢复）" @click="ctl.executeBatchTodoDelete">批量删除</button>
      <button class="ghost" title="退出多选模式并清空选择" @click="ctl.exitTodoBatch">取消</button>
    </div>
    <div class="todos-stats">
      共 {{ ctl.todos.length }} 条 · 未完成 {{ ctl.todoStats.active }} · 已完成 {{ ctl.todos.length - ctl.todoStats.active }}
      <span v-if="ctl.todoStats.overdue" class="todos-overdue-count">· 逾期 {{ ctl.todoStats.overdue }}</span>
      <span v-if="ctl.todoStats.hidden" class="todos-hidden">· 当前筛选遮住 {{ ctl.todoStats.hidden }} 条</span>
      <button v-if="ctl.todoStats.hidden" class="todos-clear" @click="ctl.clearTodoFilters()">清除筛选</button>
    </div>
    <div v-if="ctl.todoHealthIssue" class="todos-health">
      ⚠ 上次读取待办数据失败，坏文件已隔离保留（{{ ctl.todoHealthIssue.quarantined || ctl.todoHealthIssue.file }}）——
      原文件没有被覆盖，可以人工救回。错误：{{ ctl.todoHealthIssue.error }}
    </div>
    <div class="todos-note">您可以在此添加临时便签，仅供个人备忘使用。需要暂存或传递提示词的，请走「日志」页签。</div>
    <div v-if="ctl.todoDragOver" class="todo-drop-hint">松手导入：txt/md 每行一条待办</div>
    <div class="todos-list" :class="{ 'as-grid': ctl.todoView === 'grid', batching: ctl.todoBatchMode }">
      <div v-if="!ctl.filteredTodos.length" class="empty-state">
        <div class="empty-icon">{{ ctl.todos.length ? '🔍' : '✓' }}</div>
        <div class="empty-text">{{ ctl.todos.length ? '没有符合当前筛选的待办' : '暂无待办' }}</div>
        <button v-if="ctl.todos.length" class="todos-clear" @click="ctl.clearTodoFilters()">清除筛选</button>
      </div>
      <!-- 待办行＝**两行卡**（2026-09-29 用户拍板：「待办行改成两行卡」）——
           上行：置顶徽标 + 标题（标题占满整行，不再和一堆按钮抢宽度）
           下行：优先级 / 项目 / 到期 · 右侧动作按钮
           勾选框跨两行。卡片网格视图**共用这一份 DOM**，只换 grid 模板（不重写第二遍卡片）。 -->
      <div
        v-for="todo in ctl.filteredTodos"
        :key="todo.id"
        class="todo-item"
        :class="{ done: todo.done, prio: localPriority(todo.priority) === '高', pinned: todo.pinned, selected: ctl.todoBatchMode && ctl.selectedTodoBatch.includes(todo.id) }"
        @click="ctl.onTodoItemClick(todo)"
        @contextmenu.prevent="ctl.openTodoMenu($event, todo)"
      >
        <input
          type="checkbox"
          class="todo-chk"
          :checked="ctl.todoBatchMode ? ctl.selectedTodoBatch.includes(todo.id) : todo.done"
          @click.stop
          @change="ctl.todoBatchMode ? ctl.toggleTodoBatchSelect(todo.id) : ctl.toggleTodo(todo.id)"
        />
        <div class="todo-body">
          <div class="todo-line">
            <span v-if="todo.pinned" class="todo-pin" title="已置顶">📌</span>
            <span class="todo-title" @click.stop="ctl.todoBatchMode ? ctl.toggleTodoBatchSelect(todo.id) : ctl.openTodoEditor(todo)" title="点击编辑：内容 / 项目 / 优先级 / 到期日（多选模式下 = 勾选）">{{ todo.title }}</span>
          </div>
          <div class="todo-line metas">
            <span class="todo-prio" :class="'prio-' + ctl.prioClass(todo.priority)">{{ localPriority(todo.priority) }}</span>
            <span v-if="todo.project" class="todo-project">{{ (ctl.projects.find(p => p.id === todo.project)?.name) || todo.project }}</span>
            <!-- 卡 004：由日志转来的待办标出来源（与日志侧 ⤴ 待办 徽章成对，prev 范式） -->
            <span v-if="todo.fromLog" class="todo-from"
              :title="'由日志 ' + todo.fromLog + ' 转来（源日志保留）'">⤴ 日志</span>
            <!-- 已转出（转换时勾了「顺手标已转出」）：折叠的源展开后在这里，可一键撤销 -->
            <span v-if="todo.converted" class="todo-converted"
              :title="'已转成日志 ' + todo.converted + ' —— 折叠只是藏起来，不是删除'">⤴ 已转出</span>
            <button v-if="todo.converted" class="todo-conv-undo" type="button"
              title="撤销「已转出」标记，恢复到常规列表" @click.stop="ctl.undoConverted(todo)">↩</button>
            <!-- 到期：日期 + 可选时间（2026-10-12）—— 有时分就显示到分钟，
                 这样「21:39」这种"某刻截止"（如额度重置后抢跑）一眼能读出。 -->
            <span v-if="todo.due || todo.dueTime" class="todo-due" :class="{ overdue: isOverdue(todo) }"
                  :title="ctl.todoDueTitle(todo)">
              📅 {{ todo.due || '今天' }}<template v-if="todo.dueTime"> {{ todo.dueTime }}</template><template v-if="isOverdue(todo)"> · 逾期 {{ ctl.overdueDays(todo) }} 天</template>
            </span>
          </div>
        </div>
        <div class="todo-acts" v-show="!ctl.todoBatchMode">
          <button class="todo-assign" title="指派到期日（会显示在日历上）" @click.stop="ctl.openCalAssignTodo(todo.id)">📅</button>
          <button class="todo-edit" title="编辑（已完成也能改）" @click.stop="ctl.openTodoEditor(todo)">✏️</button>
          <!-- 卡 004（拍板=双向）：待办 → 日志。先开确认框（2026-10-09 用户第 1 条：
               里面可以顺手勾「标已转出」折叠源）；同一条只转一次（日志记 fromTodo 防重）。 -->
          <button class="todo-conv" title="转成执行日志：先确认（可顺手把源标「已转出」折叠）—— 同一条只转一次"
            @click.stop="ctl.askConvertTodo(todo)">⤴</button>
          <button class="todo-del" title="删除这条待办" @click.stop="ctl.deleteTodo(todo.id)">×</button>
        </div>
      </div>
    </div>
    <!-- 已转出折叠入口：默认把重复源藏起来（不是删除），一键展开/收起 -->
    <div v-if="ctl.convertedTodosCount" class="todos-converted-fold">
      <button class="ghost" @click="ctl.showConvertedTodos = !ctl.showConvertedTodos">
        {{ ctl.showConvertedTodos ? '收起已转出' : `已转出 ${ctl.convertedTodosCount} 条 · 展开` }}
      </button>
      <span class="hint" v-if="!ctl.showConvertedTodos">转日志时勾了「顺手标已转出」的源折叠在这里 —— 不是删除</span>
    </div>
  </main>
</template>

<script setup lang="ts">
import { localPriority } from '../../shared/priority'
import { isOverdue } from '../../shared/time'

/**
 * 唯一 prop：待办控制器（`useTodos()` 的返回值 + 几个父组件能力，父侧 `reactive()` 包过）。
 * 每个字段的语义见 `composables/useTodos.ts`；这里不重复解释，免得两处说法打架。
 */
const props = defineProps<{ ctl: any }>()

// 直接取引用：`props.ctl` 是 reactive 代理，属性访问即解包 ref，模板里 `ctl.todoFilter` 就是值。
// （不做 computed 包一层：那会让 `v-model="ctl.todoFilter"` 落到只读的 computed 上。）
const ctl = props.ctl
</script>
