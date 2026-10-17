# PawzoChat 插件功能介绍

运行时插件使用 Python 扩展消息处理、工具调用和聊天通道。本文介绍安装、配置与管理；接口和完整示例见[插件开发指南](plugin-development-guide.md)。

## 1. 插件功能

插件可在消息接收、上下文构建和回复发送等阶段执行过滤、改写、统计或同步，也可主动推送消息、调用 MCP 工具、向模型提供工具，以及注册新的聊天通道。

在「设置 → 插件管理」中安装和配置插件。配置页面默认由 `config_schema` 生成；插件也可通过 `config_ui` 提供 HTML 面板。插件 Python 代码在主进程运行，可访问文件系统和网络，启用前请确认来源。

将手动安装的插件放入 `data/plugins/` 后，点击插件页右上角刷新即可发现。

### 卸载插件

在本机页面进入「设置 → 插件管理 → 插件详情」，点击底部的「卸载插件」，确认后即可移除。URL 安装和手动安装的插件均支持此操作，公网访问时不显示卸载入口。

卸载会删除该插件文件夹及其中的代码、配置和 `state/` 数据；聊天记录、账号配置及目录外文件保留。若其他插件依赖它（包括已停用的插件），页面会列出名称，需先卸载这些依赖方。插件正忙时待请求结束后重试；停止失败时在日志中查看原因。

接口为本机同源的 `DELETE /api/plugins/{plugin_id}`，无需请求体，成功返回 `{"ok": true}`；存在依赖返回 `409 plugin_in_use` 及 `dependents` 名称和 ID 列表。卸载与安装、更新共用事务恢复机制：提交前中断会恢复原目录，提交后不会恢复已卸载插件；临时清理失败由后台维护或下次启动重试。

---

## 2. 目录与运行模型

所有第三方插件都放在：

```text
data/plugins/{directory_name}/
```

目录名建议与 manifest 的 `id` 一致，但并非强制；发现、依赖和 API 标识都以 `plugin.yaml` 中的 `id` 为准。

一个插件目录就是一个完整工作区。当前约定的常见结构如下：

```text
data/plugins/reply_filter/
├── plugin.yaml
├── plugin.py
├── config.yaml
├── state/
└── ui/                # 可选：自定义 HTML 配置面板的静态资源
    └── index.html
```

说明：

- `plugin.yaml`：插件静态元数据
- `plugin.py`：插件入口代码
- `config.yaml`：插件启停状态和配置
- `state/`：插件运行时持久化数据目录
- `ui/`：可选目录。当 `plugin.yaml` 声明了 `config_ui` 后，宿主会提供该目录下的静态文件给沙箱 iframe 加载；面板入口使用详情 API 的 `config_ui_url`

插件管理器在扫描时自动创建 `data/plugins/`。

---

## 3. 生命周期

插件由 `pawzochat/core/extensions/manager.py` 统一管理，生命周期如下：

1. 启动或刷新时扫描 `data/plugins/*/plugin.yaml`
2. 读取 manifest，校验 `api_version`；若发现重复 `plugin_id`，跳过后发现的目录并记录警告
3. 读取插件目录下的 `config.yaml`
4. 如果 `config.yaml` 不存在，则按 `config_schema` 自动生成默认配置，默认 `enabled: false`
5. 按依赖顺序加载已启用的插件；缺少依赖、依赖未启用或存在循环依赖时标记为 `broken`
6. 检查清单及已保存的平台限制；当前系统支持时才加载 `entrypoint` 指向的 Python 工厂函数
7. 调用 `create_plugin()`，获得 `Plugin` 实例
8. 调用 `plugin.setup(ctx)` 注入上下文；插件在 `setup()` 中自行注册 hook、工具或聊天通道

如果 `setup()` 半途抛错，宿主会尝试调用已创建实例的 `teardown()`，清掉已注册的 hook、工具、通道及插件目录下的模块。`teardown()` 必须容忍初始化尚未完成，并可靠停止插件自己启动的线程或连接；清理失败会阻止在线替换。

卸载或刷新时：

- 自动移除该插件注册的全部 hook
- 调用 `plugin.teardown()`
- 自动注销该插件发布的 LLM 工具
- 停止并注销该插件注册的聊天通道
- 卸载对应模块

---

## 4. Manifest 字段

`plugin.yaml` 当前支持这些字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 插件唯一标识，必须匹配 `[a-z0-9][a-z0-9_-]*` |
| `name` | 否 | 展示名称；缺省时使用 `id` |
| `version` | 否 | 插件版本；缺省时为 `0.0.0` |
| `api_version` | 是 | 当前必须为 `1` |
| `entrypoint` | 启用时是 | 入口工厂，如 `plugin:create_plugin`；缺失时可被发现，但启用会进入 `broken` |
| `description` | 否 | 描述（会展示在前端管理界面） |
| `author` | 否 | 作者（会展示在前端管理界面） |
| `hooks` | 否 | 声明会用到的 hook 列表，仅用于展示；实际注册以 `setup()` 调用为准 |
| `depends_on` | 否 | 依赖的其他插件 `id` |
| `platforms` | 否 | 适用系统的非空、不重复数组，仅 `windows`、`macos`、`linux`；省略表示不限 |
| `permissions` | 否 | 申请使用的受控能力；当前识别 5 种权限，其他值仅展示用于审计（见 §6） |
| `config_schema` | 否 | 用于默认值填充、基本校验和前端配置表单自动渲染 |
| `config_ui` | 否 | 启用自定义 HTML 配置面板，详见 §5.1 |

例如 Windows 专用插件可填 `platforms: [windows]`，同时支持 Windows 和 macOS 则填 `platforms: [windows, macos]`。不能填 `null`、空数组、重复项或未知系统名。平台按 **PawzoChat 后端服务所在系统** 判断，与浏览器所在系统无关，不区分 CPU 架构。不匹配时不执行插件入口，也不允许启用；手动复制的插件同样受限。

示例：

```yaml
id: reply_filter
name: Reply Filter
version: 1.0.0
api_version: 1
entrypoint: plugin:create_plugin
description: Filter blocked words before send
author: acme
hooks:
  - reply.pre_send
permissions:
  - messaging.send
config_schema:
  type: object
  properties:
    blocked_words:
      type: array
      title: 屏蔽词
      description: 每行一个，匹配时阻止发送
      items:
        type: string
      default: []
```

---

## 5. 配置文件

插件配置文件位于：

```text
data/plugins/{directory_name}/config.yaml
```

结构固定为：

```yaml
enabled: false
settings:
  some_key: some_value
```

说明：

- `enabled`：是否启用插件
- `settings`：插件业务配置

`config_schema` 当前支持 JSON Schema 的一个精简子集。

**校验字段：**

- `type`、`properties`、`required`、`default`、`items`

**支持的基础类型：**

- `object`、`string`、`boolean`、`integer`、`number`、`array`

**UI hint 字段（可选）：**

前端管理界面会根据 `config_schema` 自动渲染配置表单。以下字段不影响后端校验，仅供前端展示：

| hint | 说明 | 适用类型 |
| --- | --- | --- |
| `title` | 控件标签，回退为属性 key | 所有 |
| `description` | 控件下方提示文字 | 所有 |
| `placeholder` | 输入框占位文本 | string / number / integer |
| `secret` | 为 `true` 时渲染为密码框 | string |
| `multiline` | 为 `true` 时渲染为多行文本域 | string |
| `enum` | 可选值列表，渲染为下拉框 | string |
| `enum_labels` | `{值: 显示名}` 映射 | string + enum |
| `minimum` / `maximum` | 数字范围约束 | integer / number |
| `order` | 字段排序权重，数字越小越靠前 | 所有 |

后端只校验上面列出的类型、必填项与数组元素；`enum`、`minimum`、`maximum` 等是前端控件提示，不会由后端再次约束。Schema 未声明的额外 `settings` 字段目前也会被保留。

`secret: true` 使用密码输入框，配置值以明文保存到插件 `config.yaml`，可在本地或登录后的公网配置页面读取。

示例：

```yaml
config_schema:
  type: object
  properties:
    api_key:
      type: string
      title: API Key
      secret: true
      placeholder: 输入你的 API Key
    mode:
      type: string
      title: 运行模式
      enum: [strict, relaxed]
      enum_labels:
        strict: 严格模式
        relaxed: 宽松模式
      default: relaxed
    max_retries:
      type: integer
      title: 最大重试次数
      minimum: 0
      maximum: 10
      default: 3
```

---

### 5.1 自定义 HTML 配置面板（`config_ui`）

如果 `config_schema` 自动渲染的表单不能满足需求（例如需要分组、向导、即时预览、自定义控件），可以在 `plugin.yaml` 中声明 `config_ui` 字段，由插件提供 HTML 文件渲染配置面板：

```yaml
config_ui: true               # 简写：入口为 ui/index.html，高度随内容变化
```

或显式形式：

```yaml
config_ui:
  entry: index.html           # 相对 ui/ 目录；旧写法 ui/index.html 会被兼容归一化
```

面板高度由页面内容决定，宿主不设固定最小或最大高度。服务端在插件 HTML 中注入自动高度桥，内容增减、图片或字体加载、窄屏换行时都会重新测量，插件无需手动上报高度。旧插件的 `config_ui.height` 字段仍可保留，但不会再固定面板高度。

面板应采用自然文档流，让内容撑开页面；避免用 `100vh`、百分比 `height` / `min-height` 等依赖 iframe 视口高度的布局，以免与自动高度相互影响。

**渲染机制：**

- 宿主在插件详情页插入 `<iframe sandbox="allow-scripts">`，直接使用详情 API 返回的 `config_ui_url` 作为源地址
- iframe 的源是 **null**（沙箱属性不带 `allow-same-origin`）：拿不到宿主 cookie、localStorage、父窗口 DOM，也不能直接读取宿主管理 API
- 宿主与 iframe 通过 `window.postMessage` 通信，宿主以 `event.source === iframe.contentWindow` 识别消息来源
- 声明 `config_ui` 后，宿主**不再渲染 `config_schema` 表单**和默认的“保存配置”按钮——保存动作完全由 iframe 内部触发
- `config_schema` 仍用于默认值和已声明字段的类型校验；它不会拒绝未声明的额外字段
- 静态资源只对声明了 `config_ui` 的插件开放，并校验目录穿越和符号链接逃逸；响应设置 `X-Frame-Options: SAMEORIGIN` 与 `Content-Security-Policy: frame-ancestors 'self'`
- 本地使用普通 `/ui/` 地址，公网使用带路径前缀的签名 `/ui-assets/{token}/` 地址，让沙箱内不携带登录 Cookie 的相对 JS/CSS、图片请求也能加载。资源令牌仅允许读取对应插件的 UI 文件，24 小时后或应用重启时失效，退出登录不会立即撤销

**postMessage 协议：**

iframe → 宿主：

| `type` | 字段 | 说明 |
| --- | --- | --- |
| `ready` | — | iframe 加载完成，请求初始数据 |
| `save` | `id`, `settings` | 请求保存（宿主调 `PATCH /api/plugins/{id}/config`） |
| `pawzo:config-resize` | `height` | 由宿主注入的自动高度桥发送，插件无需自行发送 |
| `resize` | `height` | 旧面板兼容消息；仅在自动高度桥尚未就绪时接受 |
| `toast` | `level`, `message` | 弹出宿主级 toast（`success` / `error` / `info`） |

宿主 → iframe：

| `type` | 字段 | 说明 |
| --- | --- | --- |
| `init` | `plugin`, `schema`, `settings`, `locale` | 响应 `ready`，下发初始数据 |
| `save-result` | `id`, `ok`, `settings` 或 `error` | 保存结果回执，`id` 与 `save` 请求对应 |

详细的握手代码模板见《PawzoChat 插件开发指南》§14.4。

---

## 6. 权限（`permissions`）

`permissions` 字段声明插件需要的受控能力。宿主当前只对已知权限授予 facade 能力；未知权限会保留在前端详情页中供用户审计，但不会让插件获得额外宿主能力。

支持的权限：

| 权限 | 含义 | 受控 facade |
| --- | --- | --- |
| `messaging.send` | 允许调用 `ctx.messaging.send_message(...)` 主动向会话推送消息（文本 / 图片 / 文件三种内容块都用同一个权限） | `ctx.messaging` |
| `mcp.read` | 允许调用 `ctx.mcp.list_tools()` 和 `ctx.mcp.list_servers()` 枚举当前用户在控制面板配置的 MCP 工具与服务器状态 | `ctx.mcp` 只读方法 |
| `mcp.invoke` | 允许调用 `ctx.mcp.call_tool(name, arguments)` 直接发起 MCP 工具调用（与 LLM 在 tool_use 流程中调用同一底层路径） | `ctx.mcp.call_tool` |
| `mcp.publish` | 允许调用 `ctx.mcp.register_tool(...)` 向 LLM 暴露插件提供的新工具（命名空间 `plugin_<id>__<name>`，由插件代码本地处理） | `ctx.mcp.register_tool` |
| `channel.register` | 允许注册 `plugin:<id>` 聊天通道并提交该通道的入站消息 | `ctx.channels` |

三个 MCP 权限分别对应枚举、调用和发布，按插件使用的接口分别声明。插件停用时，宿主自动注销其发布的工具。

`ctx.llm.chat()` 和 `list_providers()` 可直接调用，无需声明权限。按角色选择模型的方法与可运行示例见[开发指南第 10 节](plugin-development-guide.md#llm-access)。

插件详情的「高级信息」展示所声明的权限。权限检查作用于上述宿主接口。

---

## 7. Hook（hook）列表

当前正式支持 6 个 hook，作用于私聊消息链路。Web 多角色群聊使用独立调度，不触发这些 hook；群聊仍可按角色工具配置调用插件发布的 LLM 工具。`ctx.conversations` 与 `ctx.messaging` 目前只面向角色私聊，不提供群历史读取或群消息推送接口。

| hook | 时机 | 可修改 | 可取消 | 典型用途 |
| --- | --- | --- | --- | --- |
| `message.received` | 收到消息后、入队前 | 是 | 是 | 黑名单、重写 persona、消息过滤 |
| `message.stored` | 用户消息落库后 | 否 | 否 | 审计、统计、外部同步 |
| `context.build` | 调用 LLM 前 | 是 | 否 | 注入上下文、补充 prompt |
| `reply.compose` | LLM 生成回复后 | 是 | 否 | 追加消息、重排消息、补充内容 |
| `reply.pre_send` | 单条消息发送前 | 是 | 是 | 脱敏、替换、拦截 |
| `reply.sent` | 单条消息发送后 | 否 | 否 | 投递日志、通知、统计 |

插件通过修改事件对象生效，取消接收或发送使用 `event.cancel()`。`message.received` 可改写文本、图片、文件、语音和回复目标等字段，完整字段见开发指南。

---

## 8. 运行状态

插件状态有四种：

| 状态 | 含义 | 前端显示 |
| --- | --- | --- |
| `active` | 已成功加载并启用 | 绿色"运行中" |
| `disabled` | 存在但未启用 | 灰色"已停用" |
| `broken` | 发现到了，但加载失败或依赖异常 | 红色"异常" |
| `discovered` | 刚发现、尚未完成本次同步加载流程的内部过渡状态 | 灰色"已发现" |

插件详情会记录：

- `last_error`：最近一次错误信息
- `hooks`：声明的 hook 列表
- `depends_on`：依赖列表

---

## 9. 管理方式

### 前端管理界面

在设置页中点击「插件管理」即可进入插件管理界面：

- **插件列表页**：显示所有已安装插件的名称、描述、版本和状态，条目右侧显示箭头，点击进入插件详情配置页，启停开关仅在详情页提供；右上角提供刷新，顶部小卡片在本地模式下提供检查更新和添加插件，添加插件浮窗包含从链接安装和手动安装说明
- **插件详情页**：显示 manifest 信息、启停开关和重载按钮；本地模式下，来源信息以小字显示在顶部作者信息下方，在线安装的插件提供检查更新，有新版本时显示更新按钮。配置区域根据是否声明 `config_ui` 渲染为自动表单或沙箱 iframe；技术元数据与权限列表位于默认折叠的“高级信息”

### 访问控制

本地和公网设置页均提供插件管理入口。公网登录后可查看、修改配置、启停、重载和重新扫描插件，写请求须通过同源检查。普通 `/ui/` 资源路由在公网仍要求登录；签名资源路由仅凭有效令牌即可执行只读 `GET/HEAD`，不授予配置读取或管理权限。

URL 预览、安装、在线检查更新、升级、卸载及任务查询仅限本地。安装、升级和卸载等写请求会校验本地 Origin 的协议、主机与实际监听端口。

### REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/plugins` | 列出所有插件 |
| GET | `/api/plugins/{plugin_id}` | 获取插件详情 |
| DELETE | `/api/plugins/{plugin_id}` | 本地同源请求，卸载插件并删除其目录 |
| POST | `/api/plugins/refresh` | 重新扫描插件目录 |
| POST | `/api/plugins/{plugin_id}/enable` | 启用插件 |
| POST | `/api/plugins/{plugin_id}/disable` | 停用插件 |
| POST | `/api/plugins/{plugin_id}/reload` | 重载插件 |
| PATCH | `/api/plugins/{plugin_id}/config` | 更新插件配置 |
| GET/HEAD | `/api/plugins/{plugin_id}/ui/{path}` | 读取已声明 `config_ui` 的插件静态资源，公网要求登录 |
| GET/HEAD | `/api/plugins/{plugin_id}/ui-assets/{token}/{path}` | 使用对应插件的有效签名令牌读取静态资源，无效或过期令牌返回 401 |
| POST | `/api/plugins/install/preview` | 本地提交 `{url}`，202 返回预览 task_id |
| GET | `/api/plugins/tasks/{task_id}` | 本地查询下载、预览及提交结果 |
| POST | `/api/plugins/install` | 本地提交 `{task_id}` 确认安装 |
| POST | `/api/plugins/install/cancel` | 本地取消尚未提交的预览 |
| GET | `/api/plugins/updates` | 本地批量检查更新；`?force=1` 绕过缓存 |
| GET | `/api/plugins/{plugin_id}/updates` | 本地检查单个插件 |
| POST | `/api/plugins/{plugin_id}/upgrade` | 本地提交预览 task_id；换公钥时需 trust_token |

详情及 enable、disable、reload、配置 PATCH 返回的 `plugin` 详情包含 `config_ui_url`：无自定义面板时为 `null`，本地为普通 UI 入口，公网为包含公网路径前缀的签名入口。调用方应直接使用该地址；宿主进入详情页时绕过详情缓存，重新获取链接。

refresh、enable、disable、reload 和配置 PATCH 会执行**全量刷新**，卸载并重新加载所有插件。已有 hook、工具或通道调用未结束时，管理操作可能返回 409 `plugin_busy`，待调用结束后再尝试；清理失败则阻止继续替换。

---

## 10. 扩展范围

插件通过 `PluginContext` 使用宿主接口，通过 `config_ui` 提供独立配置页面。内建聊天流程、存储和主页面布局由核心程序实现。插件管理支持本地目录与 JSON 索引 URL 两种安装方式。

插件以 manifest 的 `id` 标识；多个目录使用同一 ID 时，加载目录名排序最前的一个。加载已启用的插件时，若依赖未激活或形成循环，插件进入 `broken` 状态，详情页显示原因。

## 11. 常见扩展

| 需求 | 使用的能力 |
| --- | --- |
| 消息过滤、标签、统计与同步 | 消息 hook |
| 补充上下文或加工回复 | `context.build` / `reply.compose` / `reply.pre_send` |
| 定时提醒、外部通知或文件推送 | 插件调度器与 `ctx.messaging` |
| 摘要、分类等额外模型调用 | `ctx.llm.chat()` |
| 查询外部 MCP 服务并推送结果 | `ctx.mcp.call_tool()` 与 `ctx.messaging` |
| 向模型提供识图、检索等工具 | `ctx.mcp.register_tool()` |
| 接入新的聊天平台 | `ctx.channels` |

## 12. URL 安装、发布与更新

点击本地插件页的「添加插件」，在浮窗中粘贴作者提供的安装链接（技术格式为 **JSON 索引 URL**），获取插件后查看名称、版本、来源和更新内容，再确认安装。浮窗也提供手动安装说明：将插件文件夹放入 `data/plugins/`，然后回到插件页点击右上角刷新。签名及安装包校验由后台自动完成，普通界面不展示公钥或校验参数。不能直接粘贴 zip URL。预览只下载和解析，不执行插件代码；确认新装后插件保持停用，配置有效后可手动启用。预览就绪后保留 30 分钟，重启使未提交预览失效。

在线来源保存于宿主管理的 `.install.json`。启动后检查一次，以后每 24 小时检查；普通结果缓存 1 小时，手动检查绕过缓存。自动检查不下载或安装新版。手动复制的插件显示本地来源，也可通过同 ID、更高版本的索引包升级为在线管理。

安装成功后自动收起进度浮窗并清理临时下载文件，无需手动移除记录。后台保留精简的任务结果及已完成事务记录约 24 小时，用于重复请求和结果查询，随后自动清理。失败时显示原因并可重新获取插件；程序自动保留插件文件、设置、数据及必要的更新来源和事务记录。更新成功并通过加载检查后，旧版快照自动删除，不提供手动恢复旧版本。

插件不支持当前系统时会自动阻止安装或启用，并简短提示原因。请使用作者提供的对应系统版本。

### JSON 索引字段

| 字段 | 类型 | 必填 | 约定 |
|---|---|---|---|
| pawzochat_plugin_index | integer | 是 | 当前必须为整数 1，不接受布尔值；用于识别插件索引和格式版本 |
| id | string | 是 | 与包内 manifest.id 一致，`[a-z0-9][a-z0-9_-]*`，最多 128 字符 |
| version | string | 是 | 与 manifest.version 完全一致的 SemVer，例如 `1.2.0` |
| download_url | string | 是 | http/https zip 直链 |
| sha256 | string | 是 | zip 实际内容的 64 位十六进制 SHA-256 |
| name | string | 否 | 展示名称 |
| description | string | 否 | 简介 |
| author | string | 否 | 作者 |
| min_app_version | string | 否 | 最低宿主 SemVer；不需要限制时省略字段 |
| platforms | string[] | 否 | 非空且不重复，仅 windows/macos/linux；省略表示不限系统 |
| changelog | string | 否 | 本版更新说明 |
| public_key | string | 否 | Ed25519 原始 32 字节公钥的 base64 |
| signature | string | 否 | 64 字节 Ed25519 签名的 base64，必须与 public_key 同时出现 |

版本按 SemVer 比较，例如 `1.10.0 > 1.9.0`、`1.0.0-rc.1 < 1.0.0`。不接受 `v1.2.0` 或仅写 `1.2`。`min_app_version` 不满足时仍可查看预览，但服务端禁止安装或升级到该包。

索引和 `plugin.yaml` 均可填写 `platforms`，当前系统须同时满足两处限制，建议保持一致。索引不匹配时不下载 zip；清单不匹配时在提取后拒绝，提交前还会复验。索引限制由宿主保存，之后启动和启用仍会检查。若各系统使用不同包，请分别提供索引和下载地址；`platforms` 不承担自动选包。发布时可用 `min_app_version` 声明所需宿主版本。

例如，打包好 `reply_filter-1.2.0.zip` 后，用下面脚本生成带真实哈希的完整索引。替换下载域名为实际发布地址，包内 id/version 应与索引一致：

```python
import hashlib, json
from pathlib import Path

archive = Path("reply_filter-1.2.0.zip")
index = {
    "pawzochat_plugin_index": 1,
    "id": "reply_filter",
    "version": "1.2.0",
    "download_url": "https://example.com/plugins/reply_filter-1.2.0.zip",
    "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
    "name": "Reply Filter",
    "description": "过滤发送前的回复",
    "author": "Alice",
    "min_app_version": "0.2.3",
    "platforms": ["windows", "macos"],  # 示例：只支持这两个系统；不限则省略
    "changelog": "修复过滤规则",
}
Path("reply_filter.json").write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
```

索引放在稳定 URL，后续发布更新其版本、直链及哈希；zip 建议使用版本专属 URL。不要给未改变版本号的包替换内容。

### 打包和校验

`plugin.yaml` 必须在 zip 根目录，或唯一顶层目录中；不能包含多个候选插件根。禁止绝对路径、越界路径、符号链接和规范化后重名文件。不要发布 `config.yaml`、`.install.json`、运行时 `state/` 或 Python 字节码，宿主会重新生成/保留这些内容。URL 新装要求配置 schema 的默认值通过校验；必填配置项应有可用默认值，否则先通过手动本地安装完成配置。

macOS/Linux 包中需要执行的脚本或程序应在打包前设置可执行权限，宿主会保留其可执行位，不恢复特殊权限。

三个平台的哈希命令分别为：

```sh
# macOS
shasum -a 256 reply_filter-1.2.0.zip
# Linux
sha256sum reply_filter-1.2.0.zip
```

```powershell
# Windows PowerShell
(Get-FileHash .\reply_filter-1.2.0.zip -Algorithm SHA256).Hash.ToLower()
```

索引固定上限 1 MB。默认包上限 500 MB、解压上限 2048 MB、下载总期限 600 秒；大模型/音色资源可按需修改主配置并重启：

```yaml
plugins:
  max_download_mb: 500
  max_unzipped_mb: 2048
  download_timeout_seconds: 600
```

两个大小限制允许 0 表示不限，超时必须为正数；成员数量及压缩比保护仍有效。精简发行包可减少下载时间和更新期间的磁盘占用。打包版没有 pip，插件依赖应使用宿主已有库或随包携带兼容的纯 Python 代码。

### 签名、升级与自动恢复

签名可选。签名载荷以 `download_url/id/min_app_version/pawzochat_plugin_index/sha256/version` 六字段为基础；存在 `platforms` 时额外纳入原始数组，不改写数组顺序，缺省时保持旧六字段签名兼容。使用规范 JSON：按键排序、无空白、`ensure_ascii=True`，未提供 min_app_version 时使用空字符串。平台声明的添加、删除或修改需重新签名。公钥首次随索引下发不独立证明作者身份；高级用户可通过作者的可信渠道核对。普通界面不显示公钥，后续换公钥或撤销签名时仅简短提醒来源变化，要求针对本次更新再次确认。

升级保留 config/settings、启用状态与 state，停用插件升级后仍停用。新版加载失败时自动恢复提交前完整快照；恢复无法完成则保留现场并阻止继续加载。升级成功后清理旧版快照，后续修复通过发布新版本提供。`teardown()` 必须停止自管线程、定时器和写入操作。

可复制的打包签名脚本、GitHub Actions 发布工作流及升级数据约定见[开发指南第 18 节](plugin-development-guide.md#18-发布索引与自动更新)。
