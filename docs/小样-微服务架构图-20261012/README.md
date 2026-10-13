# SaaS 产品微服务架构图 · 小样

单文件 HTML 架构图（内联 SVG + 纯 CSS 交互 + 零 JS + 零外部依赖），附等效 Mermaid 源码。

## 文件

| 文件 | 说明 |
|---|---|
| `saas-microservices-architecture.html` | **交付物**。单文件、可直接双击打开、可离线分发 |
| `saas-microservices-architecture.mmd` | 等效 Mermaid 源码，供复用（粘贴到 mermaid.live / Obsidian / VS Code） |
| `render-1440.png` | 1440 宽无头静图（成品外观留档） |
| `hover-lane-core.png` / `hover-card-webapp.png` / `hover-conn-client.png` | 强制 `:hover` 后的截图（层 / 节点 / 连线三种交互各一张） |

## 六层结构

自顶向下，层间连线标注协议：

1. **客户端层** Web App · 移动端 · 桌面端 · Open API —— `HTTP / WSS`
2. **网关层** API Gateway · 负载均衡 · 限流器 · 认证网关 —— `gRPC / REST`
3. **核心服务层** 用户 · 订单 · 支付 · 商品 · 通知 · 搜索 六大微服务 + **Event Bus**（异步解耦）—— `TCP / Redis / HTTP / AMQP / S3`
4. **基础设施层** PostgreSQL · Redis · Elasticsearch · RabbitMQ · MinIO
5. **监控层** Prometheus · Grafana · ELK · Sentry · Jaeger —— `Metrics / Logs / Errors / Traces`
6. **部署层** Kubernetes · Docker · Terraform · CI/CD · CDN —— 承载全部工作负载

每层一个「身份证色」：客户端 青 · 网关 紫 · 核心 绿 · 基础设施 琥珀 · 监控 玫红 · 部署 灰蓝 · Event Bus 粉。

## 交互（全部 CSS，无一行 JS）

- **悬停层容器** → 该层底色点亮 + 描边加强 + 右上角英文副标签滑出
- **悬停节点** → 卡片抬起、描边变层色、`drop-shadow` 发光、副标签点亮
- **悬停连线** → 线加粗提亮、协议标签高亮

## 可复跑的验收（不是"看着像对"）

```bash
# 几何：溢出 / 六层不重叠 / 卡片不越层 / 文字不截断 / 文字互不压字 / 投影字号下限
node scripts/check-arch-geometry.cjs docs/小样-微服务架构图-20261012/saas-microservices-architecture.html

# 交互真生效 + 零 JS + 零外部依赖（CDP 强制 :hover 后读计算样式）
node scripts/check-arch-hover.cjs docs/小样-微服务架构图-20261012/saas-microservices-architecture.html

# Mermaid 源码：语法解析 + 真渲染 + 源码↔产物双向对账
node scripts/check-mmd-syntax.mjs docs/小样-微服务架构图-20261012/saas-microservices-architecture.mmd
```

当前：几何 **PASS 0 问题** · 交互 **PASS 8 条 / 0 问题** · Mermaid **PASS（30 节点 / 6 子图 / 28 连线）**。
三组断言各有反例自证（挪卡片出层 · 缩 viewBox · 竖标签压层名 · 掐 hover 发光 · 注入 `<script>`／内联事件／
外链接／`@import`／`url()` · 非法箭头/未闭合 subgraph/悬空节点 id）。

### 四个必须知道的坑

1. **`forcePseudoState` 要作用在规则的选择器主体上**。规则写成 `.lane-group:hover .lane`（后代选择器）时，
   必须强加在 `g.lane-group` 本体；作用在子元素 `rect.lane` 上会得到"点了没反应"的**假红**。
2. **`getBBox()` 给的是本地坐标，不含祖先 `transform`**。旋转过的竖排标签若不换算，包围盒落在错位置
   → 报出**假碰撞**（本图一开始就误报过一次）。包围盒判重必须过 `getCTM()`。
3. **`@import` 反例必须置顶**。写在样式表中间会被 CSS 解析器直接丢弃，于是断言"看不到"它 → 反例假绿。
4. **悬空节点 id 是静默失败**。Mermaid 会把它自动建成节点且**不报错不警告**（实测 30 → 31 个节点、
   退出码仍为 0）→ 必须靠"源码↔产物节点数对账"才抓得住。

### 关于 mermaid 在 Node 侧校验的环境坑

mermaid 是浏览器库，在 Node 里真渲染需要三件事，缺一样都报错且信息不指向真因：

- **`DOMPurify` 得在 `import mermaid` 之前就绪**（mermaid 模块顶层就抓它）→ 报 `DOMPurify.sanitize is not a function`
- **dompurify 默认导出是工厂**，且它读 `globalThis.window` → 必须先建 jsdom 再 import
- **jsdom 没有 `getBBox` / `getComputedTextLength` / `getScreenCTM`** → 要垫片，否则报
  `element.node(...).getBBox is not a function`
- ESM **不认 `NODE_PATH`**，Windows 绝对路径还得转 `file://` URL

都已封在 `scripts/mmd-domsetup.mjs` 里；依赖装在 node 工作区，可用 `FC_NODE_MODULES` 覆盖。

## 收敛到方寸的形状（待定，未落地）

方寸侧要复用它，最小改动是**把 SVG 生成拆成纯函数**，与 `shared/` 下既有模式一致：

```
desktop/src/shared/layerDiagram.ts
  buildLayerDiagram(spec: LayerSpec): string   // 纯函数，返回 <svg> 字符串，零 DOM 依赖
  ├─ 入参：六层定义（层名/色/说明 + 卡片数组 + 连线数组）
  └─ 出参：SVG 文本 → 既有渲染层直接 v-html 或走主进程生成
```

契合方寸既有约束：

- **纯逻辑不埋在组件里** —— 与 `blockers.ts` / `boardCards.ts` 同款布局，可用 `node` 直跑编译产物做断言
- **颜色走语义 token**，不硬编码：层色映射到主进程下发的枚举，避免与 `check-themes` 打架
- **零 JS 交互** 与「不放行假成功 IPC」无冲突（本图不碰 IPC）
- 新增可复用组件类名**必须带模块前缀**（`ldg-*`），别用 `.lane`/`.card` 这类通用名

**未做的事**：没有动 `desktop/`，没有加 IPC 通道，没有写进 `TASK_FIELD_SPECS`。这只是一份小样 ——
按暮雨的规矩，成品布局先看再动手。
