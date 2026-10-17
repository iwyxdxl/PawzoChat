# PawzoChat 自定义主题编写指南

自定义 CSS 主题可调整 PawzoChat 的颜色、圆角、阴影和组件样式。

## 1. 基本原理

PawzoChat 使用 CSS 变量统一界面配色和控件样式。编写主题时，先覆盖变量；需要调整具体组件时，再添加选择器。

自定义主题的 CSS 会以 `<style>` 标签注入到默认样式之后；在选择器优先级相同的情况下会覆盖默认值。你可以同时启用多个主题，按列表顺序依次叠加，后面的覆盖前面的。

每个主题实际保存为 `data/theme/<主题名>/style.css`，启用顺序记录在 `data/config/config.yaml` 的 `theme.active` 列表中。设置页支持直接新建/编辑 CSS，也支持导入 `.css` 或 PawzoChat 主题包 `.zip`，以及把一个或多个主题导出为 `.zip`。

---

## 2. 快速上手

### 最小示例：改主色调

```css
:root {
  --primary: #E91E63;
  --primary-light: #FCE4EC;
  --primary-dark: #AD1457;
  --bubble-user: #E91E63;
}
```

保存并启用后，浅色模式下的按钮、高亮、用户气泡等会变成粉色。若也要覆盖深色模式，请继续使用下一节的写法。

### 同时适配浅色和深色模式

如果用户可能切换深浅模式，建议同时写两套：

```css
/* 浅色模式 */
:root {
  --primary: #1E88E5;
  --primary-light: #E3F2FD;
  --bg: #F0F7FF;
}

/* 深色模式 */
:root[data-theme='dark'] {
  --primary: #64B5F6;
  --primary-light: #1A2A3A;
  --bg: #0F1A24;
}
```

`:root[data-theme='dark']` 的优先级高于 `:root`。深色配色使用前者覆盖；圆角等未在深色样式中重定义的变量会继承 `:root`。

---

## 3. 可覆盖的 CSS 变量一览

### 主色与状态色

| 变量 | 默认值（浅色） | 说明 |
|------|---------------|------|
| `--primary` | `#B08968` | 主色调，用于按钮、链接和高亮；用户气泡由 `--bubble-user` 单独设置 |
| `--primary-light` | `#F4E7DA` | 主色淡底，用于选中态背景、图标底色 |
| `--primary-dark` | `#765538` | 主色深态，用于按下效果 |
| `--success` | `#6AA87A` | 成功/在线状态色 |
| `--danger` | `#C96B5C` | 危险/删除操作色 |

### 背景与卡片

| 变量 | 默认值（浅色） | 说明 |
|------|---------------|------|
| `--bg` | `#F7F1E8` | 页面主背景 |
| `--bg-outer` | `#E8DED1` | 外层容器背景 |
| `--card` | `#FFFDF8` | 卡片/面板背景 |
| `--bg-hover` | `#F8EFE4` | 悬停/按下时的背景 |
| `--search-bg` | `#F1E7DA` | 搜索框、聊天输入框背景 |
| `--tab-bar-bg` | `rgba(255,253,248,0.92)` | 底部导航栏背景（半透明） |

### 文字与分割线

| 变量 | 默认值（浅色） | 说明 |
|------|---------------|------|
| `--text-1` | `#4E3A2E` | 正文/标题（最深） |
| `--text-2` | `#7A6252` | 次要文字 |
| `--text-3` | `#A58D79` | 提示/辅助文字（最浅） |
| `--divider` | `#EDE2D6` | 分割线、边框 |

### 聊天气泡

| 变量 | 默认值（浅色） | 说明 |
|------|---------------|------|
| `--bubble-user` | `#B08968` | 用户消息气泡背景 |
| `--bubble-ai` | `#FFFDF8` | AI 消息气泡背景 |
| `--bubble-ai-border` | `#E8DED1` | AI 消息气泡边框 |

### 圆角与阴影

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `--radius-card` | `12px` | 卡片圆角 |
| `--radius-btn` | `10px` | 按钮圆角 |
| `--radius-bubble` | `12px` | 气泡圆角 |
| `--shadow-card` | `0 1px 3px rgba(0,0,0,0.06)` | 卡片阴影 |
| `--shadow-float` | `0 -4px 24px rgba(0,0,0,0.12)` | 浮层阴影 |

### 统一控件

按钮、表单、复选框与开关共用以下变量：

| 变量 | 默认值（浅色） | 说明 |
|------|---------------|------|
| `--control-height` | `44px` | 常规控件高度 |
| `--control-height-sm` | `32px` | 小按钮高度 |
| `--control-font-size` | `14px` | 控件字号 |
| `--control-gap` | `8px` | 控件组间距 |
| `--control-on-primary` | `#fff` | 主色底上的文字或图标；深色默认为 `var(--bg)` |
| `--radius-check` | `4px` | 复选框圆角 |
| `--switch-width` / `--switch-height` | `38px` / `22px` | 开关尺寸 |
| `--switch-off` | `#D9D9D9` | 开关关闭态背景；深色为 `#494949` |

提示词输入框由脚本自动调整高度。主题可修改字体、配色和间距，高度交给脚本计算。

### 其他

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `--font` | 系统字体栈 | 全局字体 |
| `--bar-h-top` | `48px` | 顶栏高度；桌面布局默认覆盖为 `52px` |
| `--bar-h-bottom` | `56px` | 底栏高度；桌面布局默认覆盖为 `52px` |
| `--ease` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | 部分过渡动画曲线 |

源码还定义了几个兼容别名：`--border` → `--divider`、`--text` → `--text-1`、`--radius` → `--radius-card`。通常覆盖主变量即可；但默认深色块单独设置了 `--border`，若修改深色分割线并希望边框同步，请同时覆盖 `--divider` 和 `--border`。

### 设置列表图标色板

如果你希望连设置页面的图标颜色也一起调整：

| 变量 | 说明 |
|------|------|
| `--icon-bg-green` / `--icon-fg-green` | 账号（绿） |
| `--icon-bg-orange` / `--icon-fg-orange` | 服务商（橙） |
| `--icon-bg-blue` / `--icon-fg-blue` | MCP（蓝） |
| `--icon-bg-red` / `--icon-fg-red` | 插件（红） |
| `--icon-bg-indigo` / `--icon-fg-indigo` | 回复设置（靛蓝） |
| `--icon-bg-yellow` / `--icon-fg-yellow` | 表情包（黄） |
| `--icon-bg-cyan` / `--icon-fg-cyan` | 网络（青） |
| `--icon-bg-purple` / `--icon-fg-purple` | 主题（紫） |
| `--icon-bg-peach` / `--icon-fg-peach` | 浅色模式（桃） |
| `--icon-bg-neutral` / `--icon-fg-neutral` | 中性图标 |
| `--icon-bg-primary` / `--icon-fg-primary` | 主色图标 |

---

## 4. 进阶：直接覆盖选择器

如果变量覆盖不够用，你也可以直接写选择器来覆盖具体组件的样式。

### 聊天界面

```css
/* 聊天背景图 */
.chat-container {
  background-image: url('https://example.com/bg.jpg');
  background-size: cover;
  background-position: center;
}

/* 更圆的气泡 */
.msg-bubble {
  border-radius: 20px;
}

/* 用户气泡渐变 */
.msg-row.user .msg-bubble {
  background: linear-gradient(135deg, #E91E63, #9C27B0);
}
```

### 导航与布局

```css
/* 顶栏加投影 */
#top-bar {
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

/* 底栏完全不透明 */
#tab-bar {
  backdrop-filter: none;
  background: var(--card);
}
```

### 卡片与列表

```css
/* 卡片加边框 */
.card {
  border: 1px solid var(--divider);
  box-shadow: none;
}

/* 设置行悬停效果 */
.card-row:hover {
  background: var(--primary-light);
}
```

### 桌面端专属

桌面端通过媒体查询 `@media (min-width: 768px)` 激活侧栏布局。桌面端专属样式可以这样写：

```css
@media (min-width: 768px) {
  /* 自定义侧栏宽度 */
  #sidebar {
    width: 320px;
  }

  /* 窗口圆角 */
  #phone-shell {
    border-radius: 20px;
  }
}
```

---

## 5. 常用组件选择器速查

| 选择器 | 对应界面元素 |
|--------|-------------|
| `#phone-shell` | 最外层容器 |
| `#top-bar` | 顶部标题栏 |
| `#tab-bar` | 底部导航栏 |
| `#sidebar` | 桌面端侧栏 |
| `#content-area` | 主内容区域 |
| `.card` | 设置/信息卡片 |
| `.card-row` | 卡片内的行条目 |
| `.row-icon` | 行条目前的图标 |
| `.conv-item` | 私聊与群聊的会话列表条目 |
| `.conv-draft-label` | 会话预览中的“草稿”标记 |
| `.group-avatar` | 群头像或成员组合头像 |
| `.group-member-prompt` | 群成员专属提示词折叠区 |
| `.chat-container` | 聊天窗口容器 |
| `.chat-messages` | 消息列表区域 |
| `.msg-bubble` | 消息气泡 |
| `.msg-row.user .msg-bubble` | 用户消息气泡 |
| `.msg-row.assistant .msg-bubble` | AI 消息气泡 |
| `.chat-input-bar` | 聊天输入栏容器 |
| `.chat-input` | 聊天输入框 |
| `.send-btn` | 发送按钮 |
| `.avatar` | 头像 |
| `.search-bar` | 搜索框 |
| `.btn-primary` | 主操作按钮 |
| `.btn-secondary` / `.btn-outline` / `.btn-text` | 次要、描边和文字按钮 |
| `.btn-sm` | 小尺寸按钮修饰类 |
| `.form-input` | 统一表单输入控件 |
| `.prompt-input` | 自动高度提示词输入框 |
| `.switch-wrap` / `.switch-track` | 开关容器与轨道 |
| `.form-actions` | 表单操作按钮组 |
| `#overlay` | 遮罩层 |
| `#action-sheet` | 底部弹出菜单 |
| `#confirm-dialog` | 确认对话框 |
| `#toast` | 轻提示 |

---

## 6. 完整示例：樱花粉主题

```css
/* 浅色模式 */
:root {
  --primary: #E91E63;
  --primary-light: #FCE4EC;
  --primary-dark: #AD1457;
  --bg: #FFF5F8;
  --bg-outer: #FCE4EC;
  --card: #FFFFFF;
  --bubble-user: #F48FB1;
  --bubble-ai: #FFFFFF;
  --bubble-ai-border: #FCE4EC;
  --text-1: #4A2C3A;
  --text-2: #7A5868;
  --text-3: #B58A9A;
  --divider: #F8DCE4;
  --bg-hover: #FFEEF3;
  --search-bg: #FCE4EC;
  --tab-bar-bg: rgba(255, 245, 248, 0.92);
}

/* 深色模式 */
:root[data-theme='dark'] {
  --primary: #F48FB1;
  --primary-light: #3A1E2A;
  --primary-dark: #FCE4EC;
  --bg: #241319;
  --bg-outer: #180A0F;
  --card: #2E1A22;
  --bubble-user: #C2185B;
  --bubble-ai: #2E1A22;
  --bubble-ai-border: #3A1E2A;
  --text-1: #FCE4EC;
  --text-2: #D8B0C0;
  --text-3: #9E7786;
  --divider: #3A1E2A;
  --border: var(--divider);
  --bg-hover: #341820;
  --search-bg: #341820;
  --tab-bar-bg: rgba(36, 19, 25, 0.92);
}
```

---

## 7. 导入、分享与维护

- **CSS 大小限制**：单个主题的 CSS 不超过 200 KB。
- **主题名称**：最长 50 个字符，支持中文；不能包含 `\ / : * ? " < > |`，不能使用 Windows 保留名，也不能以空格或句点开头/结尾。
- **导入导出**：原始 `.css` 和 PawzoChat 原生 `.zip` 主题包都可导入；重名主题会自动追加 `_2`、`_3`。单个主题 CSS 上限同样是 200 KB；zip 包最大 30 MB、最多 100 个主题，全部解压内容合计最大 25 MB。
- **外部图片**：CSS 中可以使用 `url()` 引用外部图片。公网面板为 HTTPS 时应使用 HTTPS 资源，否则浏览器可能按混合内容阻止加载。
- **多主题叠加**：同等选择器优先级下，启用列表中靠后的主题覆盖前面的同名属性，可组合使用配色主题和聊天背景主题。
- **导入来源**：主题 CSS 会直接应用到页面，并可加载外部资源。导入前可在编辑器中查看样式与资源地址。
- **插件自定义面板**：主题作用于宿主页面和自动生成的插件配置表单；沙箱 iframe 内的自定义 HTML 不继承宿主 CSS，需要插件自行提供样式。
- **维护性**：CSS 变量是相对稳定的入口；直接覆盖组件选择器可能随前端重构失效。
- **参考源码**：完整默认样式见 `pawzochat/web/static/style.css` 和 `pawzochat/web/static/desktop.css`。
