# PawzoChat 架构文档

## 1. 项目概览

PawzoChat 是一个多通道、多人设的 LLM 对话系统。当前内建微信 iLink、QQ 开放平台和 Web 预览通道，并允许运行时插件注册新通道。主要能力包括：

- 多账号、通道与 Persona（角色）绑定
- 多轮上下文、世界书、工具调用、记忆和表情增强
- Web 多角色群聊、群内独立提示词与每位成员的群记忆
- LLM、生图与 TTS 服务商管理
- 朋友圈动态、评论、配图与记忆联动
- MCP 工具、能力适配器和运行时插件
- 本地 Web 面板，以及可选的 HTTPS 公网面板

本文描述模块边界和主链路。网络防护与插件协议分别见 [network-security.md](network-security.md) 和 [plugin-development-guide.md](plugin-development-guide.md)。

## 2. 分层与启动编排

系统采用“核心服务 + 通道适配 + 能力扩展”的结构，入口为 `main.py`，主编排对象为 `pawzochat/app.py:App`。

启动顺序的关键点如下：

1. `ConfigManager` 加载 `data/config/config.yaml`，合并默认值并处理损坏配置恢复。
2. 初始化 LLM、生图和语音 Provider。
3. 启动 MCP Server，建立 `CapabilityAdapterRegistry`，注册生图、参考图查看、记忆记录/更新等内置工具。
4. 创建私聊记忆、群记忆、世界书、聊天、群聊、朋友圈、回复分发、消息队列和主动消息服务。
5. 向 `ChannelRegistry` 注册 `web`、`wechat` 和 `qq` 三个内建通道。
6. 加载运行时插件。插件可在此时注册 hook、LLM 工具或 `plugin:<id>` 通道；插件安装器在加载前恢复未完成事务，加载后启动定期更新检查。
7. 启动消息队列、主动消息与朋友圈 worker，再恢复 `data/auth/accounts.json` 中的通道账号。
8. 启动遥测服务（默认关闭）、本地/公网 Web Server 和打包版更新检查。

关闭时停止安装器，通知通道离线，再依次关闭遥测、群聊、Web Server、内建通道、后台服务、插件和 MCP；超过 5 秒仍未完成时强制退出。

## 3. 对话主链路

### 3.1 入站

本节至 3.3 描述私聊链路；Web 群聊使用 3.4 的独立调度与存储。

- 微信：`WeChatChannel` 持有每个账号的 iLink 客户端、发送器和长轮询器，解析文本、图片、文件、语音及引用消息；带转写的入站语音从 CDN 下载，SILK 解码为 WAV 后以结构化 `voice` 块入队。
- QQ：`QQChannel` 通过 WebSocket 网关接收 C2C 私聊，下载图片、视频和文件；兼容 `content_type: "voice"` 等原生语音附件形态，优先下载 `voice_wav_url`，否则解码 SILK，并使用 `asr_refer_text` 作为转写。
- Web：`api_conversations.py` 把面板发送的消息直接交给统一队列。
- 插件通道：插件通过 `ctx.channels.submit_inbound(...)` 提交文本、图片和文件。

外部通道先按账号绑定找到 Persona，然后调用 `MessageQueue.accept_message(...)`。`message.received` hook 在入队前执行，可改写或取消消息。

### 3.2 聚合、持久化与推理

`MessageQueue` 按 Persona 隔离队列，并使用 `chat.queue_wait_seconds` 聚合短时间内连续到达的消息。处理时依次：

1. 把用户消息写入 `ConversationStore`，逐条触发 `message.stored`。
2. `ChatService.process_round(...)` 读取最近若干轮历史并构建上下文；图片、文件及引用附件随各自原消息进入上下文，保留重复发送和引用的位置，并附带发言者与来源信息；失效附件以文字提示代替。
3. 注入角色 Prompt、记忆、世界书、文件/图片提示以及可选主动消息提示；用户和 AI 的语音历史统一表示为 `[语音] 转写内容`。
4. 触发 `context.build`，然后调用角色绑定的 LLM。
5. 按角色工具策略执行内置能力、插件工具和 MCP 工具的循环，收集调用参数、结果和状态；工具返回的图片注册到当轮上下文，可继续识图。
6. 解析文本与 `[语音]`/`[voice]` 段；可用时合成 TTS，否则降级为文本；同时收集工具生成的图片。
7. 可选由 `EmojiService` 追加表情，再触发 `reply.compose`。

对话记忆按角色的 `memory.trigger_mode` 配置：

| 模式 | AI 新增／更新 | 达到 N 轮时 |
| --- | --- | --- |
| `remind`（默认） | 允许 | 提醒 AI，由 AI 决定是否记录 |
| `summarize` | 允许 | 后台总结未处理对话为一条第一人称记忆 |
| `summarize_only` | 禁止 | 同上，不暴露记忆工具或注入工具指引 |

`trigger_rounds = 0` 关闭定期触发；按轮数总结无需模型支持工具调用。私聊计轮沿用用户发言后收到 AI 回复的规则，群记忆计轮见 3.4。总结进度保存在 `memory.json` 的 `last_summarized_timestamp`：两种有效总结模式互切保留进度；从提醒模式开启、重新启用记忆或轮数从 0 改为正数时，从当前会话末尾重新计数。朋友圈仍由独立记忆开关控制，手动管理及超限合并不随触发模式改变。

私聊与群记忆共用一个模型调用信号量，自动总结和超限整理逐个请求模型；排队后会再次检查任务是否已失效。

记忆写入使用同一快照中的条目编号与内容指纹定位目标，写回时在角色锁内校验。目标已变化或内容与其他条目重复时，返回冲突；本轮成功写入后更新快照。自动总结和合并在模型请求完成后重新检查设置与处理范围，再保存结果及进度。

去重按 `summary.strip()` 精确比较。重复自动总结仍推进进度，AI 写入失败、重复或无变化时保留提醒计数。网页编辑与工具更新使用相同的内容去重规则。

网页记忆接口使用 `/api/personas/<id>/memories` 路径：

| 请求 | 校验值 | 结果 |
| --- | --- | --- |
| GET 列表 | 无 | 每条返回临时 `fingerprint`，64 位小写十六进制 |
| POST 新增 | 无 | 重复内容返回 409 |
| PUT `/<index>` | JSON 中必填 `fingerprint` | 缺失／格式错误 400；过期、目标消失或内容重复 409；无变化仍返回 200 |
| DELETE `/<index>` | 查询参数中必填 `fingerprint` | 缺失／格式错误 400；过期或目标消失 409 |

网页和 API 客户端先读取列表获取指纹，再用该值保存或删除条目。编辑冲突时，网页保留草稿并提示重新打开条目。

### 3.3 出站

`ReplyDispatcher` 对每条草稿执行：

1. 触发 `reply.pre_send`，允许改写或取消。
2. 将未取消的 assistant 消息写入会话文件，本轮工具历史附在首条实际保存的助手消息上。
3. 按 `reply_ctx.channel` 从 `ChannelRegistry` 查找通道并投递。
4. 通过 SSE 广播给 Web 面板。
5. 触发带 `delivered` 状态的 `reply.sent`。

通道差异由通道实现负责：

- `web`：只做本地预览节奏控制，实际显示依赖 SSE。
- `wechat`：发送文本、图片、文件；TTS 以音频文件卡片投递。
- `qq`：被动回复及主动发送文本/富媒体，TTS 优先转为 SILK 语音气泡。
- `plugin:<id>`：调用插件注册的 `on_outbound`。

主动消息和插件主动发送复用同一 Persona 互斥锁，并由 `Channel.can_push_now(...)` 判断通道是否允许推送。微信使用 23 小时安全窗口和每条用户消息 10 条回复的配额（发送前本地预判，配额用尽则跳过），QQ 单聊主动发送自动限流，离线、冷却或拒收时跳过生成，Web 和插件通道默认允许。QQ 的平台限流及临时网络错误冷却 30 分钟后自动恢复发送资格，拒收/无权限/无好友关系等待有效 QQ 入站消息后再尝试；这些延期不计入通用失败次数。其他主动消息连续失败 3 次会挂起该 Persona 的主动周期（挂起状态保存在内存中），用户下次回复或重启程序后自动恢复。

### 3.4 Web 群聊与群记忆

`api_groups.py` 将群消息交给 `GroupChatService`，由 `GroupConversationStore` 按群保存历史、成员、提示词和调度状态。群聊不经过私聊的 `MessageQueue` / `ReplyDispatcher`，也不触发六个私聊消息 hook；模型、世界书、语音、生图及工具循环通过 `ChatService.generate_group_reply(...)` 复用。

- **上下文**：按 `turn_id` 选取本群最近若干次发言，同一次发言已发布的多个气泡一起保留，基准数量沿用 `chat.max_context_rounds`；为避免截断交错发言，实际范围可能扩大。保留角色人设与输出示例，以本群 `system_instructions` 替代角色原系统指令，并只注入当前成员的 `group_prompt`；不读取私聊或其他群的聊天记录。
- **接话调度**：成员默认回复概率为 50%，连续回复上限默认为 5。用户新消息重置计数；明确点名优先排队，其他成员按概率参与。用户发言后无人入选且无人正在回复时，按非零概率加权选一位回应；角色发言后按点名和概率继续接话。0% 成员仅在被点名时回应，所有回应仍受上限约束。
- **点名**：用户可通过候选列表或完整名称 `@成员` / `@所有人`；角色可在完整回复结束后邀请其他成员接话。角色点名会去重并排除自身和歧义姓名，不重置回复上限。
- **生命周期**：每群串行生成角色回复；新媒体先写入暂存区，由群服务发布。SSE 使用 `group_message`、`group_updated` 等独立事件，刷新页面不打断后台接话；应用重启后保留历史和计数，等待用户新消息。

`GroupMemoryService` 为每个 `(group_id, persona_id)` 保存独立记忆，沿用角色的触发方式、轮数和容量，群成员另有 `memory_enabled` 生成开关，关闭后仍可读取已有本群记忆。用户消息和完整角色发言都会推进各成员的记忆计数；角色回复中的记忆工具先暂存写入，只有整次回复发布完成后才提交。持久化事件与回执防止重启后重复结算，删除、停用或历史变更会使旧任务失效。

群聊可读取当前成员的本群记忆和只读私聊记忆，不读取其他群记忆；私聊可通过角色的 `memory.group_reads` 按群选择导入只读群记忆，默认读取，且受角色记忆启用与注入开关控制。退群或删除群默认保留群记忆；删除群时可指定 `delete_memories: true` 一并清理，删除角色会清理其全部群记忆及成员配置，保留共享群历史。

群记忆 API 位于 `/api/personas/<id>/group-memories`：GET 列出来源，`/<group_id>` 提供 GET/POST，`/<group_id>/<index>` 提供 PUT/DELETE，条目修改沿用私聊的 `fingerprint` 校验。DELETE `/<group_id>` 在角色仍在群内时只清空条目、保留来源；离群或群已删除时同时删除来源，响应的 `source_deleted` 表示是否已删除来源。

## 4. 关键模块

| 层 | 模块 | 职责 |
| --- | --- | --- |
| 应用 | `pawzochat/app.py` | 生命周期、模块装配、账号恢复、Web Server |
| 配置/路径 | `core/config.py`、`paths.py` | 默认配置、原子保存/恢复、统一运行时路径 |
| 通道 | `channels/base.py`、`registry.py` | 通道抽象与按 `channel_type` 路由 |
| 内建通道 | `channels/web.py`、`wechat.py`、`qq.py` | Web、微信和 QQ 收发 |
| 插件通道 | `channels/plugin.py` | 将插件回调适配为一等通道 |
| 对话 | `services/chat.py` | 上下文、LLM 调用、工具循环、文本/语音草稿 |
| 群聊 | `services/group_chat.py`、`store/group_conversation.py` | 群成员、提示词、接话调度、独立历史与媒体 |
| 队列/回复 | `services/message_queue.py`、`reply_dispatcher.py` | 消息聚合、持久化、投递、SSE 和 hook |
| 记忆/知识 | `services/memory.py`、`group_memory.py`、`worldbook.py` | 私聊与群记忆、总结与合并、世界书匹配 |
| 内容 | `services/emoji.py`、`moments.py` | 表情增强和朋友圈工作流 |
| 主动消息 | `services/proactive.py` | 空闲触发、静默时段、通道推送策略 |
| 存储 | `store/conversation.py`、`store/moments.py` | 会话与朋友圈 JSON 持久化 |
| LLM | `llm/manager.py`、`llm/providers/` | OpenAI Chat Completions / Responses、Anthropic、Gemini |
| 生图 | `image/manager.py`、`image/providers/` | OpenAI、Gemini、NovelAI 等生图后端 |
| 语音 | `voice/manager.py`、`voice/providers/` | MiniMax、MiMo、ElevenLabs、OpenAI 兼容 TTS 与音频转码 |
| MCP | `mcp/manager.py`、`mcp/adapters.py` | Server 生命周期、工具聚合、能力适配 |
| 内置工具 | `mcp/builtin/` | 生图、查看参考图、记录/更新记忆 |
| 插件 | `core/extensions/` | 发现、依赖排序、权限 facade、hook、URL 安装、升级恢复和卸载 |
| 传输 | `transport/`、`transport/qq/` | iLink、QQ 网关、认证、CDN、发送 |
| Web | `web/app.py`、`web/routes/` | Flask/Cheroot、认证、REST API、静态资源 |
| 前端 | `web/static/`、`web/templates/` | 无构建步骤的 Vanilla JS SPA |

## 5. Provider 与工具体系

### 5.1 模型 Provider

- 对话：`openai_compatible`、`openai_responses`、`anthropic`、`gemini` 四类实现。自定义服务商可选择 OpenAI Responses，设置是否拼接 `/responses`，并拉取模型列表。
- 生图：独立于对话 Provider，由 `ImageManager` 管理。
- 语音：独立于对话 Provider，由 `VoiceManager` 管理。

Persona 在配置中分别绑定对话、生图和语音 Provider/模型。Prompt 长文本存于 `data/prompts/<persona_id>.json`，而绑定、开关与数值设置保留在主配置中。

### 5.2 工具来源

送入 LLM 的工具可能来自四类来源：

1. 程序内置工具（owner 为 `builtin`）。
2. `capability_adapters` 配置映射的能力。
3. 插件通过 `ctx.mcp.register_tool(...)` 发布的进程内工具（owner 为 `plugin:<id>`）。
4. MCP Server 提供的远端工具。

最终工具集按模型 `tool_use` 能力、Persona 的 `tool_policy`、生图/记忆开关及参考图可用性过滤。

私聊与群聊将完成的工具调用保存为助手消息的 `tool_history`，后续按调用顺序放回对应回复之前。每条结果文字最多保存 12,000 字符，超出部分标注截断；群聊只恢复当前角色的调用历史。模型缺少工具能力或历史工具已停用时，整组调用转为文字上下文。删除承载记录的回复时，工具历史一起删除。

图片与文件使用当轮 `pending_images` / `pending_files` 映射供工具读取，ID 分别根据角色与图片内容、角色与文件路径生成。生图、截图等工具返回的图片可在同轮继续识别；视觉模型在同批工具结果之后接收原图。后续轮次从正式附件消息加载图片。

`openai_responses` 在当轮工具循环中回传 `responses_output_items`，保存历史时使用统一的调用记录。生图指引根据 OpenAI、Gemini 原生／聊天兼容接口、NovelAI 的尺寸规则提供画幅选择与提示词格式。

## 6. 插件与 hook

插件从 `data/plugins/*/plugin.yaml` 发现，入口工厂返回 `Plugin` 实例。Manifest 的 `hooks` 字段用于声明和展示；真正的 hook 注册由插件在 `setup(ctx)` 中调用 `ctx.hooks.on_*` 完成。

私聊链路的 hook 为（Web 群聊不触发）：

- `message.received`
- `message.stored`
- `context.build`
- `reply.compose`
- `reply.pre_send`
- `reply.sent`

宿主通过 `messaging.send`、`mcp.read`、`mcp.invoke`、`mcp.publish` 和 `channel.register` 控制插件 API 的访问。插件 Python 代码在主进程运行，可使用文件系统和网络。

本地插件页可通过 JSON 索引 URL 预览并确认安装，`PluginInstaller` 校验包哈希、可选签名、版本与系统兼容性，并以文件事务发布。升级保留配置、启用状态与 `state/`，加载失败时恢复旧快照。启动时及之后每 24 小时检查在线来源；自动检查只提示，不下载或安装更新。安装器的详细协议与资源限制见插件文档。

## 7. Web 面板

`pawzochat/web/app.py:create_app(app_instance)` 创建一个 Flask 应用，本地与公网 Cheroot Server 共享它。主要 API 前缀为：

- `/api/conversations`、`/api/groups`、`/api/personas`、`/api/persona-writer`
- `/api/accounts`、`/api/providers`
- `/api/image-providers`、`/api/voice-providers`
- `/api/mcp`、`/api/plugins`
- `/api/moments`、`/api/worldbooks`
- `/api/emoji`、`/api/themes`
- `/api/settings`、`/api/setup`、`/api/telemetry`

此外还有 `/api/events`（SSE）、`/api/profile`、`/api/status`、媒体读取接口和仅打包版可用的更新接口。应用更新接口只允许本地访问。公网登录后可查看、配置、启停和重载插件；插件 URL 预览、安装、检查更新、升级、卸载及任务查询仅限本地，安装、升级和卸载等写请求还要求匹配本地 Origin。

插件自定义配置面板使用 `sandbox="allow-scripts"` iframe，通过 `postMessage` 接收配置并由宿主保存。详情 API 的 `config_ui_url` 在本地指向普通 UI 路由，在公网指向包含路径前缀的 `/api/plugins/{id}/ui-assets/{token}/{entry}`。签名令牌只允许读取对应插件的 UI 静态文件，有效期 24 小时且重启失效，供沙箱内无登录 Cookie 的资源请求使用；退出登录不会立即撤销。普通 UI 路由在公网仍要求登录，资源响应仅允许同源页面嵌入。

聊天页通过 `GET /api/conversations/{persona_id}/messages?limit=60` 加载最新页，用互斥的 `before` / `after` 游标向前翻历史或向后补齐新消息；`limit` 范围为 1–100。返回 `messages`、`before_cursor`、`after_cursor`、`has_more`（请求方向上是否还有消息）。消息附带 `_position` 和 `_page_key`，兼容没有 `local_id` 的旧记录。游标绑定会话、内存版本与数组边界；追加消息保持有效，编辑、删除、清空或重启后返回 409，客户端重新加载。无分页参数时按 `rounds` / `date` 查询。

前端 `chat_history.js` 管理分页请求、会话代次和未读状态，`chat_timeline.js` 合并持久化、SSE 与乐观发送消息，`virtual_messages.js` 通过高度缓存和上下占位仅挂载可视区域附近的消息（最多 200 行）。动态高度由 `ResizeObserver` 校正，滚动按帧处理；消息请求绕过通用 SWR 缓存，SSE 重连后补齐遗漏。离开页面释放请求和观察器，跨桌面／手机布局保留聊天实例与阅读位置。已加载的消息缓存在当前页面内存中，后端使用 JSON 全量缓存和整文件写入。

群聊历史使用 `/api/groups/{group_id}/messages`，复用分页与虚拟列表；群设置、头像、停止接话、历史编辑及媒体读取由 `/api/groups` 下的接口管理。

聊天与朋友圈发布草稿保存在前端内存中，页面内导航后恢复文字、附件及编辑位置，聊天还保留引用和点名绑定；私聊与群聊草稿分开存储，会话列表显示草稿摘要。刷新或关闭页面后草稿清除。无法读取的附件会被移除，异步发送使用会话与编辑状态检查，避免清空后来输入的内容。

## 8. 配置与数据落盘

主配置为 `data/config/config.yaml`，当前默认段包括：

- `llm_providers`、`image_providers`、`voice_providers`
- `personas`
- `mcp_servers`、`capability_adapters`
- `chat`、`reply`
- `web`、`theme`
- `moments`、`telemetry`

另可配置 `plugins.max_download_mb`（默认 500）、`plugins.max_unzipped_mb`（默认 2048）和 `plugins.download_timeout_seconds`（默认 600）；安装器在缺省时使用这些值，修改后重启生效。

主要运行时数据：

```text
data/
├── auth/accounts.json                         # 微信、QQ、插件通道账号与凭据
├── books/*.json                               # 世界书
├── certs/server.crt|server.key                # 公网面板自签名证书
├── chats/<persona_id>/
│   ├── <persona_id>.json                      # 消息与 channel_link
│   ├── memory.json
│   ├── proactive_state.json
│   ├── avatar.png
│   ├── image_refs/ref.png
│   └── images/ | files/ | voice/
├── config/config.yaml                         # 主配置
├── emoji/                                     # 表情包
├── groups/<group_id>/
│   ├── <group_id>.json                      # 群设置、历史与调度状态
│   ├── avatar-<version>.png                 # 可选群头像
│   └── images/ | files/ | voice/
├── group_memories/<group_id>/<persona_id>.json # 独立群记忆与结算状态
├── logs/pawzochat.log
├── mcp_servers/                               # 随应用携带的本地 MCP 实现
├── moments/moments.json                       # 朋友圈主数据
├── moments/images/<moment_id>/                # 朋友圈图片
├── plugins/<directory_name>/                  # 运行时插件；实际标识取 manifest.id
├── plugin_staging/                           # 插件下载与安装暂存
├── plugin_backup/                            # 插件事务日志与恢复快照
├── profile/                                   # 用户资料与头像
├── prompts/<persona_id>.json                  # 对话/生图 Prompt 长文本
├── telemetry_id.txt                           # 便携遥测 ID 副本
└── theme/<name>/style.css                     # 自定义主题
```

在线安装的插件目录内另有宿主管理的 `.install.json`，保存来源、版本和校验信息；成功升级后自动清理旧快照，未完成恢复的现场会保留。遥测 ID 还会按操作系统约定写入用户级应用数据目录，以便升级后保持稳定。

## 9. 运行环境与通道范围

- 会话、配置、朋友圈等以本地 JSON/YAML 文件存储，不使用数据库。
- Web 前端是原生 JS/CSS，无 Node 构建步骤。
- 多角色群聊仅在 Web 面板提供，不接入微信、QQ 或插件通道的外部群聊。
- QQ 支持 C2C 私聊，主动消息使用角色的主动消息设置，并受平台额度限制。
- 公网面板使用自签名 TLS 与随机路径前缀；完整限制见网络安全文档。

## 10. 通道协议参考

- 微信：参照 [openclaw-weixin 2.4.9（24de5c9）](https://github.com/Tencent/openclaw-weixin/tree/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c) 对齐现有能力。
- QQ：参照 [openclaw-qqbot 2.0.4（b9ba494）](https://github.com/tencent-connect/openclaw-qqbot/tree/b9ba494f068959ffc1bd8a790822c613810d9f40) 及其锁定的 `qqbot-nodejs@1.0.4` 对齐现有 C2C 能力。

两个通道均由 Python 实现。
