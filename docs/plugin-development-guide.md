# PawzoChat 插件开发指南

本文介绍 Python 运行时插件的接口与示例。安装和日常管理见[插件功能介绍](plugins-overview.md)。

## 1. 适用范围

这份文档面向为 PawzoChat 编写**第三方后端插件**的开发者。

当前插件系统的特点：

- 插件根目录必须是 `data/plugins/` 的直接子目录；目录名建议与 `plugin_id` 一致，但宿主实际以 `plugin.yaml` 的 `id` 为准，两者可以不同
- 插件运行在主进程内
- 插件通过后端 hook 扩展消息处理流程
- 插件配置界面默认由系统根据 `config_schema` 自动渲染；进阶情况下可通过 `config_ui` 在沙箱 iframe 中渲染自定义 HTML
- 插件可在声明 `messaging.send` 权限后，主动通过 `ctx.messaging.send_message(...)` 推送消息
- 插件可注册 LLM 工具，也可提供一个 `plugin:<id>` 聊天通道
- 宿主接口统一由 `PluginContext` 提供

内建通道、主页面、表情包管理和消息队列由核心程序实现。插件通过下文的接口扩展这些流程。

---

## 2. 最小目录结构

新建一个插件目录：

```text
data/plugins/reply_filter/
├── plugin.yaml
└── plugin.py
```

首次扫描后，系统会自动补出：

```text
data/plugins/reply_filter/config.yaml
data/plugins/reply_filter/state/
```

如果计划提供自定义配置面板，再补一个 `ui/` 目录：

```text
data/plugins/reply_filter/
├── plugin.yaml
├── plugin.py
└── ui/
    └── index.html
```

宿主只会在 `plugin.yaml` 中显式声明 `config_ui` 后，才把该目录暴露给前端。

---

## 3. 编写 Manifest

最小可用的 `plugin.yaml`：

```yaml
id: reply_filter
name: Reply Filter
version: 1.0.0
api_version: 1
entrypoint: plugin:create_plugin
hooks:
  - reply.pre_send
```

推荐完整版（含 UI hint）：

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
depends_on: []
permissions:
  - messaging.send       # 仅在需要 ctx.messaging 时声明
config_schema:
  type: object
  properties:
    blocked_words:
      type: array
      title: 屏蔽词
      description: 每行一个，匹配时替换为 ***
      items:
        type: string
      default: []
    enabled_notice:
      type: boolean
      title: 显示替换提示
      description: 替换发生时是否在日志中记录
      default: true
```

要求：

- `id` 必须唯一，格式为 `[a-z0-9][a-z0-9_-]*`（小写字母、数字、下划线、连字符）
- `api_version` 目前必须是 `1`
- 插件启用时，`entrypoint` 必须是 `模块名:函数名`；缺失时仍可被发现，但加载状态会变为 `broken`
- `name` 缺省时回退为 `id`，`version` 缺省时回退为 `0.0.0`
- `hooks` 是供管理界面展示的声明，不会自动注册，也不会与 `setup()` 中的实际注册做一致性校验
- `permissions` 当前被宿主识别为受控能力的有：`messaging.send`、`mcp.read` / `mcp.invoke` / `mcp.publish`、`channel.register`；其他值会保留展示用于审计，但不会授予任何宿主能力

仅支持部分系统的插件可额外声明：

```yaml
platforms:
  - windows
  - macos
```

`platforms` 可省略，表示不限制系统；填写时必须是非空、不重复的数组，只接受小写 `windows`、`macos`、`linux`，不能用 `win`、`darwin`、`null` 或空数组。判断依据是 **PawzoChat 后端服务运行的系统**，与访问面板的浏览器系统无关，也不区分 CPU 架构。系统不匹配时不能安装或启用，启动/刷新也不会执行插件入口；手动复制安装同样检查清单。在线索引若也声明了平台，必须同时满足两处限制。

---

## 4. 编写插件入口

`plugin.py` 最小示例：

```python
from pawzochat.core.extensions.api import Plugin, PluginContext


class ReplyFilterPlugin(Plugin):
    def setup(self, ctx: PluginContext) -> None:
        self.ctx = ctx
        ctx.hooks.on_reply_pre_send(self.on_reply_pre_send, priority=100)

    def teardown(self) -> None:
        pass

    def on_reply_pre_send(self, event) -> None:
        blocked_words = self.ctx.config.get("blocked_words", [])
        message = event.message
        content = message.get("content", [])
        for block in content:
            if block.get("type") != "text":
                continue
            text = block.get("text", "")
            for word in blocked_words:
                text = text.replace(word, "***")
            block["text"] = text


def create_plugin() -> Plugin:
    return ReplyFilterPlugin()
```

要求：

- 插件类必须继承 `Plugin`
- 必须实现 `setup(self, ctx)`
- 入口函数必须返回 `Plugin` 实例
- `teardown()` 必须幂等、快速，并容忍 `setup()` 尚未完成。宿主卸载前暂停新 hook、工具和通道调用，已有调用未结束时拒绝管理操作；插件仍须自行停止并等待自己的线程、定时器和写入。清理抛错会阻止版本切换

---

## 5. PluginContext

`setup()` 中会拿到 `PluginContext`，包含这些能力：

| 字段 | 说明 |
| --- | --- |
| `manifest` | 当前插件的 manifest 数据（`PluginManifest`） |
| `root_dir` | 插件根目录（`pathlib.Path`） |
| `config_path` | 插件配置文件路径（`pathlib.Path`） |
| `state_dir` | 插件状态目录（`pathlib.Path`），写持久化数据请放这里 |
| `logger` | 当前插件专用 `logging.Logger`（名字为 `pawzochat.plugin.<plugin_id>`） |
| `config` | 当前插件 `settings` 段的配置快照（按 `Mapping` 使用） |
| `hooks` | hook 注册器（详见 §6） |
| `conversations` | 只读会话 facade |
| `personas` | 只读角色 facade |
| `llm` | 模型调用与服务商枚举接口（详见 §10） |
| `messaging` | 主动发送消息 facade，支持文本 / 图片 / 文件三种内容块（需声明 `messaging.send` 权限，详见 §11） |
| `mcp` | MCP 工具枚举、调用及插件工具发布 facade（分别需 `mcp.read` / `mcp.invoke` / `mcp.publish`，详见 §12） |
| `channels` | 注册完整聊天通道 facade（自带收发循环 + 出站处理器，需声明 `channel.register` 权限，详见 §13） |

注意：

- `ctx.config` 是配置的深拷贝；保存配置请使用插件管理页或配置 API
- 修改插件配置后，系统会刷新插件，新的配置才会生效

只读数据 facade 当前提供：

```python
ctx.conversations.get_conversation(persona_id) -> dict | None
ctx.conversations.get_recent_rounds(persona_id, count) -> list[dict]
ctx.conversations.list_conversations() -> list[dict]

ctx.personas.get(persona_id) -> Persona | None
ctx.personas.all() -> dict[str, Persona]
```

这些返回值都是深拷贝；修改它们不会更新宿主存储。`ctx.conversations` 只读取角色私聊，不包含 Web 群聊历史；`persona_id` 不能替换为 `group_id`。

---

## 6. 可用 hook

下列 hook 作用于私聊消息链路，Web 多角色群聊不触发这些事件。群聊仍可调用插件发布的 LLM 工具，handler 可通过群聊上下文字段区分作用域（见 §12.6.3）。

### 6.1 `message.received`

时机：

- 收到消息后
- 写入会话前

可做：

- 修改 `event.persona_id`
- 修改 `event.text`
- 修改 `event.images`
- 修改 `event.files`、`event.voices`、`event.reply_ctx` 以及账号/用户元数据
- 调用 `event.cancel()`

典型场景：

- 黑名单
- 消息预处理
- 角色动态路由

### 6.2 `message.stored`

时机：

- 用户消息已落库

可做：

- 审计
- 外部日志
- 数据镜像同步

用户消息位于 `event.message`，其结构与会话存储中的消息一致；事件没有顶层 `role` 或 `text` 字段。

### 6.3 `context.build`

时机：

- 调用 LLM 前

可做：

- 改写 `event.messages`
- 向上下文插入额外系统提示或记忆片段

`event.images` 包含选中历史轮次内的图片及引用图片，并附带来源标记。发言顺序和附件位置以 `event.messages` 为准。

### 6.4 `reply.compose`

时机：

- LLM 已生成一轮回复草稿

可做：

- 改写 `event.messages`
- 追加消息
- 删除消息
- 调整顺序

### 6.5 `reply.pre_send`

时机：

- 单条消息实际发送前

可做：

- 改写 `event.message`
- 调用 `event.cancel()` 阻止发送

### 6.6 `reply.sent`

时机：

- 单条消息发送完成后

可做：

- 发送结果记录
- 统计
- 发送回执通知

---

## 7. 优先级

注册 hook 时可以指定 `priority`：

```python
ctx.hooks.on_reply_pre_send(self.on_reply_pre_send, priority=50)
```

规则：

- 数字越小，执行越早
- 默认值是 `100`
- handler 抛出的异常会被宿主记录并写入该插件的 `last_error`，随后继续执行后面的 handler；异常不会自动停用插件

---

## 8. 事件对象约定

hook 通过**修改事件对象**生效，返回值会被忽略。

当前事件字段如下（`cancelled` 由 `event.cancel()` 设置）：

| hook | 事件字段 |
| --- | --- |
| `message.received` | `channel`、`source`、`persona_id`、`text`、`images`、`files`、`voices`、`account_id`、`user_id`、`context_token`、`reply_ctx`、`raw_message`、`cancelled` |
| `message.stored` | `channel`、`source`、`persona_id`、`message`、`account_id`、`user_id`、`context_token`、`reply_ctx`、`raw_message` |
| `context.build` | `persona_id`、`persona`（`Persona` 实例）、`messages`、`images` |
| `reply.compose` | `channel`、`persona_id`、`messages`、`account_id`、`user_id`、`reply_ctx` |
| `reply.pre_send` | `channel`、`persona_id`、`message`、`is_last`、`account_id`、`user_id`、`reply_ctx`、`cancelled` |
| `reply.sent` | `channel`、`persona_id`、`message`、`delivered`、`is_last`、`account_id`、`user_id`、`reply_ctx` |

例如：

- 改写入站文本：修改 `message.received` 的 `event.text`
- 改写出站消息：修改 `reply.pre_send` 的 `event.message`
- 取消接收：调用 `event.cancel()`
- 追加回复：直接修改 `event.messages`

---

## 9. 配置与默认值

如果插件声明了 `config_schema`，系统会在首次发现插件时：

1. 创建 `config.yaml`
2. 自动写入 `enabled: false`
3. 按 `default` 填充 `settings`

例如：

```yaml
config_schema:
  type: object
  properties:
    blocked_words:
      type: array
      items:
        type: string
      default: []
```

生成后得到：

```yaml
enabled: false
settings:
  blocked_words: []
```

### UI hint

`config_schema` 中可以添加额外字段来控制前端管理界面的配置表单渲染。这些字段不影响后端校验逻辑。

| hint | 说明 | 适用类型 |
| --- | --- | --- |
| `title` | 控件标签（回退为属性 key） | 所有 |
| `description` | 控件下方提示文字 | 所有 |
| `placeholder` | 输入框占位文本 | string / number / integer |
| `secret` | 渲染为密码框 | string |
| `multiline` | 渲染为多行文本域 | string |
| `enum` | 可选值列表，渲染为下拉框 | string |
| `enum_labels` | `{值: 显示名}` 映射 | string + enum |
| `minimum` / `maximum` | 数字范围限制 | integer / number |
| `order` | 排序权重，数字越小越靠前，默认 999 | 所有 |

前端表单的类型映射：

| schema 类型 | 渲染为 |
| --- | --- |
| `boolean` | 开关 |
| `string` | 单行输入框 |
| `string` + `secret: true` | 密码框 |
| `string` + `multiline: true` | 多行文本域 |
| `string` + `enum` | 下拉框 |
| `integer` / `number` | 数字输入框 |
| `array` + `items.type: string` | 多行文本域（每行一项） |

后端当前只检查 `type`、`properties`、`required` 和 `items`，并应用 `default`。`enum`、`minimum`、`maximum` 只影响前端控件，后端不会再次检查取值范围；Schema 未声明的额外 `settings` 字段也会保留。

`secret: true` 使用密码输入框。配置值以明文保存在插件目录的 `config.yaml`，可通过本地或登录后的公网插件详情 API，以及面板 `init` 消息读取。

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
      order: 1
    mode:
      type: string
      title: 运行模式
      enum: [strict, relaxed]
      enum_labels:
        strict: 严格模式
        relaxed: 宽松模式
      default: relaxed
      order: 2
    notes:
      type: string
      title: 备注
      multiline: true
      placeholder: 可选备注信息
      order: 3
```

---

<a id="llm-access"></a>

## 10. LLM 调用（`ctx.llm`）

插件可在 hook 或后台任务中通过 `ctx.llm.chat()` 调用模型，无需声明权限。模型调用使用显式传入的消息；如需人设或其他上下文，由插件加入 `messages`。

当前 `chat_as_persona()` 和 `get_persona_binding()` 对 `Persona` 使用字典式 `.get()`，角色存在时会抛出 `AttributeError`。按角色调用请通过 `ctx.personas.get()` 读取属性，再传给 `chat()`，示例见 §10.4。

调用方式：

| 模式 | 何时用 | 入口 |
| --- | --- | --- |
| 显式 provider | 插件想用某个固定 provider/model（比如内部规则引擎专用一个 mini 模型） | `ctx.llm.chat(provider_name, ...)` |
| 按角色选择 | 复用角色的服务商、模型和生成参数 | `ctx.personas.get(persona_id)` + `ctx.llm.chat(...)` |

### 10.1 接口签名

```python
ctx.llm.chat(
    provider_name: str,
    messages: list[dict],
    *,
    model: str = "",                  # 调用时填写模型 ID；内建 provider 要求非空
    temperature: float = 1.0,
    max_tokens: int = 1000,
    tools: list[dict] | None = None,
) -> LLMResponse
```

```python
ctx.llm.list_providers() -> list[str]
# 返回已配置 API Key 且成功初始化的 provider 名列表
```

### 10.2 异常表

| 方法 | 抛出 | 时机 |
| --- | --- | --- |
| `chat` | `RuntimeError` | `provider_name` 未注册（没配置或 API key 缺失） |
| `chat_as_persona` | `ValueError` | `persona_id` 不存在 |
| `chat` | `ValueError` | 模型 ID 为空 |
| `chat_as_persona` / `get_persona_binding` | `AttributeError` | 角色存在时触发本节开头说明的实现问题 |

### 10.3 `messages` 与 `LLMResponse` 字段

`messages` 使用 PawzoChat 的统一内部格式：每条通常为 `{"role": "system"|"user"|"assistant"|"tool", "content": str | list}`。纯文本场景优先传字符串；多模态内容块应遵循 `pawzochat/llm/converter.py` 接受的内部结构，不要直接混用某一家 SDK 的专有对象。

`LLMResponse` 提供以下字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `.text` | `str \| None` | 模型生成的纯文本（多数场景插件只需要这个） |
| `.tool_calls` | `list[ToolCall] \| None` | 工具调用对象；字段为 `.id`、`.name`、`.arguments`，插件需自行执行并继续多轮对话 |
| `.finish_reason` | `str` | 供应商归一化后的结束原因 |
| `.reasoning_content` | `str \| None` | 思考模式模型在继续工具轮次时可能需要回传的推理内容 |
| `.responses_output_items` | `list[dict] \| None` | Responses API 的当轮输出条目，继续工具循环时放入助手消息的同名字段 |

自行实现工具循环时，将调用与结果追加到 `messages`，并回传对应的推理字段或 Responses 输出条目。

### 10.4 示例：在 `message.stored` hook 内做一句话摘要

`plugin.yaml`

```yaml
id: one_line_summary
name: One-Line Summary
version: 1.0.0
api_version: 1
entrypoint: plugin:create_plugin
hooks:
  - message.stored
# 此示例使用的 LLM 接口无需声明权限
```

`plugin.py`

```python
from pawzochat.core.extensions.api import Plugin, PluginContext


class OneLineSummaryPlugin(Plugin):
    def setup(self, ctx: PluginContext) -> None:
        self.ctx = ctx
        ctx.hooks.on_message_stored(self.on_message_stored)

    def on_message_stored(self, event) -> None:
        # message.stored 的正文位于 event.message，不在 event 顶层
        message = event.message or {}
        if message.get("role") != "user":
            return
        text = "\n".join(
            block.get("text", "")
            for block in message.get("content", [])
            if block.get("type") == "text"
        )
        if not text:
            return

        persona = self.ctx.personas.get(event.persona_id)
        if not persona or not persona.llm_provider or not persona.llm_model:
            return

        try:
            resp = self.ctx.llm.chat(
                persona.llm_provider,
                messages=[
                    {"role": "system", "content": "用一句中文总结用户的最新消息，不超过 30 字。"},
                    {"role": "user", "content": text},
                ],
                model=persona.llm_model,
                temperature=persona.temperature,
                max_tokens=200,
            )
        except Exception:
            self.ctx.logger.exception("摘要失败")
            return

        self.ctx.logger.info("[摘要] persona=%s text=%s",
                             event.persona_id, resp.text)


def create_plugin() -> Plugin:
    return OneLineSummaryPlugin()
```

### 10.5 调用要点

- 按角色选择模型时，每次通过 `ctx.personas.get()` 读取最新配置。
- 调用 `chat()` 时填写非空模型 ID；`list_providers()` 只返回服务商名称。
- 传入 `tools` 后，插件负责执行返回的工具调用并继续对话。一次性文本生成可省略此参数。
- 服务商的网络、配额和请求错误会向调用方抛出；在插件任务中捕获并记录即可。
- hook 同步执行，额外模型调用会延长该条消息的处理时间。

## 11. 主动发送消息（`ctx.messaging`）

`ctx.messaging.send_message(...)` 让插件以“助手身份”向某个角色私聊直接推送一条消息（不经过 LLM），支持文本、图片、文件三种内容块。典型场景：

- 定时提醒（日程、生日、纪念日）
- 外部事件通知（监控告警、消息桥接）
- Webhook / IM 转发
- 报表 / 凭证 / 资料文件下发

此接口不支持 Web 多角色群聊，没有 `group_id` 参数；`channel="web"` 指角色的 Web 私聊。

### 11.1 声明权限

调用 `ctx.messaging.send_message` 前，必须在 `plugin.yaml` 中声明权限：

```yaml
permissions:
  - messaging.send
```

未声明时调用会抛出 `PermissionError`。文本、图片和文件共用此权限。

### 11.2 接口签名

```python
ctx.messaging.send_message(
    persona_id: str,
    *,
    channel: str,                       # "web" 或当前已注册且与 persona 绑定匹配的通道
    text: str = "",
    images: list[dict] | None = None,   # 见 §11.3 字段表
    files:  list[dict] | None = None,   # 见 §11.3 字段表
) -> bool
```

返回值：

- `True`：该条消息被通道报告为已接受
- `False`：Persona 正忙、消息被 `reply.pre_send` 取消，或通道报告投递失败；调用方可结合日志决定是否重试

### 11.3 内容块字段表

至少要提供 `text` / `images` / `files` 之一（三者都为空会抛 `ValueError`）。可以同时混用——它们会按顺序拼成一条消息的 `content` 数组。

`images[i]`（每张图片一个对象）：

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `path` | str | 是 | — | 插件可读的本地图片路径；建议使用绝对路径 |
| `mime` | str | 否 | `image/jpeg` | MIME，用于前端预览展示 |

`files[i]`（每个文件一个对象）：

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `path` | str | 是 | — | 插件可读的本地文件路径；建议使用绝对路径 |
| `name` | str | 否 | `basename(path)` | 接收方看到的文件名（含扩展名） |
| `mime` | str | 否 | `application/octet-stream` | MIME 元数据；内建 Web/微信/QQ 投递主要按路径和文件名处理，插件通道可自行使用 |

**关于路径的语义**：

- 文件在投递前复制到 `data/chats/<persona_id>/files/`，文件名前加随机前缀；已在该目录中的文件直接使用。网页与外部通道均读取保存后的路径。
- 图片直接使用传入路径。需要网页预览时，先将图片保存到 `data/chats/<persona_id>/images/`，再传入该路径。

### 11.4 异常表

| 异常 | 触发条件 |
| --- | --- |
| `PermissionError` | manifest 未声明 `messaging.send` |
| `ValueError` | `channel` 未注册（`web` 除外）；`text` 非字符串；`images` / `files` 不是列表；任意块不是对象或缺少 `path`；三种内容都为空；`persona_id` 为空或会话不存在；文件路径不存在或不可解析 |
| `RuntimeError` | 消息子系统未就绪，或外部通道的会话绑定/主动推送前置条件不满足（详见 §11.5） |
| `OSError` 等 | 文件复制、通道实现或底层 I/O 出现未被通道捕获的异常 |

微信 / QQ 的常规发送失败由通道记录日志并返回 `False`。

### 11.5 通道差异

| `channel` | 主动发送行为 |
| --- | --- |
| `web` | 不要求通道绑定；消息写入历史并通过 SSE 显示。图片需位于 Persona 的 `images/` 才能稳定预览，文件会自动复制到 `files/`。 |
| `wechat` | 要求 Persona 绑定微信账号，处于单聊且已回填远端用户；还必须位于最近用户消息后的 23 小时安全窗口内，且该用户消息后的机器人回复数未达 10 条配额。文本、图片和文件走微信发送器，失败通常返回 `False`。 |
| `qq` | 支持 C2C 私聊主动发送，要求账号在线、绑定接收人且当前未暂停。不携带旧 `msg_id`；与系统主动消息共用自动限流、冷却和拒收恢复，无需 QQ 专属配置。 |
| `plugin:<id>` | 要求 Persona 绑定同一插件通道并已有远端用户。默认允许主动推送，最终调用该通道的 `on_outbound`；插件通道可自行返回 `False` 拒绝。 |

除 `web` 外，facade 会统一校验：

1. Persona 存在 `channel_link`，且 `channel_link.channel` 与参数一致。
2. 不是群聊。
3. `channel_link.peer_id` 已回填。
4. 会话历史中至少有一条用户消息，用作主动推送时间锚点。
5. 目标通道的 `can_push_now(...)` 返回 `True`。

微信额外使用 23 小时窗口和 10 条回复配额；QQ 根据连接及主动发送恢复状态判断；插件通道默认允许。该流程与系统主动消息服务使用同一通道策略。

### 11.6 调度由插件自行管理

定时推送由插件的后台线程或定时器调度。在 `teardown()` 中取消等待，并等待正在执行的任务退出；任务未能停止时抛出异常，宿主会暂停在线替换。

文本提醒最小示例：

```python
import threading
from pawzochat.core.extensions.api import Plugin, PluginContext


class ScheduledNudger(Plugin):
    def setup(self, ctx: PluginContext) -> None:
        self.ctx = ctx
        self._stopped = threading.Event()
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()

    def teardown(self) -> None:
        # setup 可能只完成了一部分；重复清理也应安全。
        stopped = getattr(self, "_stopped", None)
        if stopped is not None:
            stopped.set()
        worker = getattr(self, "_worker", None)
        if worker is not None and worker.is_alive():
            worker.join(timeout=2)
            if worker.is_alive():
                raise RuntimeError("提醒任务尚未停止，请稍后重试")

    def _run(self) -> None:
        while not self._stopped.wait(60 * 60):  # 等待 1 小时，可随时停止
            try:
                self.ctx.messaging.send_message(
                    persona_id=self.ctx.config.get("persona_id", ""),
                    channel="web",
                    text="时间到了，记得喝水。",
                )
            except Exception:
                self.ctx.logger.exception("发送提醒失败")


def create_plugin() -> Plugin:
    return ScheduledNudger()
```

文件投递示例：

```python
# 推送一份 PDF 报表到微信（需要 messaging.send 权限）
self.ctx.messaging.send_message(
    persona_id="alice",
    channel="wechat",
    text="今日数据报表已生成。",
    files=[
        {
            "path": "/Users/me/reports/2026-05-18.pdf",
            "name": "daily-2026-05-18.pdf",
            "mime": "application/pdf",
        },
    ],
)
```

混合发送示例（一条消息含文本 + 图片 + 文件）：

```python
import shutil
from uuid import uuid4
from pawzochat.paths import CHATS_DIR

image_path = CHATS_DIR / "alice" / "images" / f"screenshot_{uuid4().hex}.png"
image_path.parent.mkdir(parents=True, exist_ok=True)
shutil.copyfile("/tmp/screenshot.png", image_path)

self.ctx.messaging.send_message(
    persona_id="alice",
    channel="web",
    text="今日截图 + 原始日志：",
    images=[{"path": str(image_path), "mime": "image/png"}],
    files=[{"path": "/tmp/server.log"}],   # name / mime 用默认值
)
```

### 11.7 投递与文件保存

- `send_message` 与同一角色正在进行的 LLM 轮次共用互斥锁
- 投递经过 `reply.pre_send` / `reply.sent` hook、会话存储与 SSE 广播
- 消息的 `source` 字段为 `plugin:{plugin_id}`，便于在历史中定位来源
- 文件块在 `message.content` 数组中形如 `{"type": "file", "path": "...", "name": "...", "mime": "..."}`，其他订阅了 `reply.pre_send` 的插件可以读到并按需重写或拦截
- facade 当前不预检出站文件大小；微信/QQ 平台可能拒绝超限或不支持的文件，通常会记录日志并让本次调用返回 `False`。插件应按目标平台规则自行预检
- 文件保存在 `data/chats/<persona_id>/files/`；插件可按业务需要清理，删除后对应历史附件将无法下载

---

## 12. MCP 工具访问（`ctx.mcp`）

MCP（Model Context Protocol）是宿主允许用户配置的外部工具网关：用户在 PawzoChat 控制面板上添加 MCP 服务器，比如 `web_search`、文件系统操作、内部 API 桥等。

`ctx.mcp` 让插件：

- 枚举已连接服务器的工具（`list_tools`），查询全部已配置服务器的连接状态（`list_servers`）
- 直接发起一次 MCP 工具调用（`call_tool`），与 LLM 在 tool_use 流程中走的是**同一个底层路径**

典型用途：定时拉外部数据再主动推送、把命令式查询（如 `/search foo`）改成插件自己处理而不进入 LLM、按 hook 触发查询并丰富上下文等。

### 12.1 声明权限

```yaml
permissions:
  - mcp.read     # 仅枚举工具/服务器时
  - mcp.invoke   # 需要直接调用工具时
  - mcp.publish  # 需要注册插件自带工具供 LLM 调用时（详见 §12.6）
```

**三个权限互相独立**：

- 想 `list_tools` / `list_servers` → 必须有 `mcp.read`
- 想 `call_tool` → 必须有 `mcp.invoke`
- 想 `register_tool` → 必须有 `mcp.publish`
- 想做"先枚举再选择性调用"的工作流 → `mcp.read` + `mcp.invoke` 两个都要声明
- 声明 `mcp.invoke` **不**自动获得 `mcp.read`；声明 `mcp.publish` 也**不**自动获得 `mcp.invoke`

未声明对应权限时调用会抛 `PermissionError`。

### 12.2 接口签名

```python
ctx.mcp.list_tools() -> list[dict]
# 返回示例：
# [
#   {
#     "name": "tavily__web_search",     # 命名空间格式：{server}__{tool}
#     "description": "Search the web ...",
#     "inputSchema": {                  # 工具参数的 JSON Schema
#       "type": "object",
#       "properties": {"query": {"type": "string"}},
#       "required": ["query"],
#     },
#     "server": "tavily",
#   },
#   ...
# ]

ctx.mcp.list_servers() -> dict[str, dict]
# 返回示例：
# {
#   "tavily": {"connected": True,  "tool_count": 3},
#   "fs":     {"connected": False, "tool_count": 0},
# }

ctx.mcp.call_tool(name: str, arguments: dict | None = None) -> list[dict]
# 返回 ContentBlock 列表（已序列化为 dict）：
# [
#   {"type": "text",  "text": "结果文本",  "data": None},
#   {"type": "image", "text": "",          "data": "<base64...>"},
#   ...
# ]
```

`list_tools()` 返回工具名、描述、输入 schema 和所属 `server`。需要判断服务器归属时读取 `server` 字段。

### 12.3 异常 / 错误处理

| 方法 | 抛出 / 行为 | 触发条件 |
| --- | --- | --- |
| `list_tools` / `list_servers` | `PermissionError` | 未声明 `mcp.read` |
| `call_tool` | `PermissionError` | 未声明 `mcp.invoke`（即使有 `mcp.read` 也不行） |
| `call_tool` | `ValueError` | `name` 非字符串或为空 |
| `call_tool` | `RuntimeError` | MCP manager 尚未初始化 |
| `call_tool` | **不抛**（工具失败） | 服务器不存在、事件循环未运行、超时或工具执行抛错——都会回填一个 `type="text"` 的内容块，但具体文本分别可能是 `MCP Server ... not found`、`MCP event loop not running`、`工具调用超时...` 或 `工具调用出错...` |

### 12.4 完整示例：MCP WebSearch 桥

`plugin.yaml`

```yaml
id: mcp_websearch_demo
name: MCP WebSearch Demo
version: 1.0.0
api_version: 1
entrypoint: plugin:create_plugin
description: 拦截 Web 对话中以 /search 开头的消息，调用 MCP web_search 直接返回结果
hooks:
  - message.received
permissions:
  - mcp.read
  - mcp.invoke
  - messaging.send       # 用 ctx.messaging 把结果推回会话
```

`plugin.py`

```python
from pawzochat.core.extensions.api import Plugin, PluginContext


class WebSearchPlugin(Plugin):
    def setup(self, ctx: PluginContext) -> None:
        self.ctx = ctx
        ctx.hooks.on_message_received(self.on_message_received)

        # 启动时枚举一遍可用工具，写入日志便于排查配置
        tools = ctx.mcp.list_tools()
        has_search = any(t["name"].endswith("__web_search") for t in tools)
        ctx.logger.info(
            "MCP 工具数: %d，web_search 可用: %s",
            len(tools), has_search,
        )

    def on_message_received(self, event) -> None:
        # 本示例只处理 Web；外部通道的首次入站消息尚未落库，不适合在这里主动回推。
        if event.channel != "web":
            return
        text = event.text or ""
        if not text.startswith("/search "):
            return
        query = text[len("/search "):].strip()
        if not query:
            return

        # 重新查一次，避免启动后用户改了 MCP 配置
        tool = next(
            (t for t in self.ctx.mcp.list_tools()
             if t["name"].endswith("__web_search")),
            None,
        )
        if tool is None:
            return

        # 确认工具仍存在后，再取消原始消息进入 LLM，由插件自己回复
        event.cancel()
        result_blocks = self.ctx.mcp.call_tool(tool["name"], {"query": query})

        # 拼接所有文本块作为结果。注意失败信息也是 type=text，会被拼进去。
        text_out = "\n".join(
            b["text"] for b in result_blocks if b["type"] == "text"
        )

        self.ctx.messaging.send_message(
            event.persona_id,
            channel="web",
            text=f"搜索结果（{query}）：\n{text_out[:1500]}",
        )


def create_plugin() -> Plugin:
    return WebSearchPlugin()
```

### 12.5 调用要点

工具名使用 `{server}__{tool}` 格式，调用前可通过 `list_tools()` 查询。未配置或未连接工具时返回空列表；`list_servers()` 同时列出已连接和未连接服务器的状态。

`call_tool()` 同步等待结果，默认超时为 60 秒，服务器配置的 `timeout_seconds` 优先。角色聊天中的 MCP 调用使用角色工具策略的超时（默认 30 秒），也会被服务器设置覆盖。hook 内的调用会占用消息处理时间。

工具错误通过文本块返回，具体错误见 §12.3；需要程序化处理结果时，按所选工具的返回格式解析。

### 12.6 注册工具供 LLM 调用（`ctx.mcp.register_tool`）

插件可以**反过来**向 LLM 暴露自己的工具——和 MCP 服务器工具、宿主内置工具（如 `generate_image`、`record_memory`）以及用户配置的能力适配器（如 `recognize_image`）走同一个工具栈。典型场景：

- 给纯文本模型补一个"识图工具"（用户配置好图像识别模型 + API Key，文本模型在收到图片时调用插件工具）
- 把外部数据源（私有 KB、内网 API、OCR、TTS）包装成 LLM 直接可调用的工具
- 给特定 persona 提供专属工具，无需用户手动配置 MCP 服务器

注册的工具在主进程内执行。

#### 12.6.1 声明权限

```yaml
permissions:
  - mcp.publish
```

未声明时 `register_tool` 抛 `PermissionError`。该权限会在前端插件详情页显示为「向 LLM 暴露新工具」，方便用户在启用前审计。

#### 12.6.2 接口签名

```python
ctx.mcp.register_tool(
    name: str,
    description: str,
    parameters: dict,
    handler: Callable[[dict, dict], list[dict]],
) -> str
```

- `name`：工具的本地短名，需匹配 `^[a-z0-9][a-z0-9_]*$` 且**不含连续两个下划线** `__`（避免与命名空间分隔符冲突）。
- `description`：给 LLM 看的工具描述，决定模型何时选择调用它。和写 OpenAI / Anthropic tools schema 时的 `description` 字段语义一致。
- `parameters`：JSON-Schema 风格的 `properties` 映射。每项形如 `{"type": "string", "description": "..."}`；带 `"default"` 的字段在暴露给模型的 schema 中视为可选，其余为必填。当前宿主会把它转换为工具 schema，但调用 handler 前**不会**再次校验参数类型或替插件注入默认值，handler 仍须自行校验 `arguments`。
- `handler`：同步 Python 可调用对象，签名 `handler(arguments: dict, context: dict) -> list[dict]`。详见 §12.6.3。
- **返回值**：实际暴露给 LLM 的命名空间工具名，格式 `plugin_<plugin_id>__<name>`。便于日志记录。

#### 12.6.3 handler 契约

```python
def handler(arguments: dict, context: dict) -> list[dict]:
    ...
```

参数：

- `arguments`：模型传入的工具参数，由 handler 校验类型并填充默认值。
- `context`：当前 LLM 轮次的运行时状态，宿主注入。字段：

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `pending_images` | `dict[str, dict]` | `{image_id: {"data": "<base64>", "mime": "image/jpeg"}}`。文本模型收到图片时，宿主在 prompt 里以 `[图片 ID:image_id]` 文本形式暴露给 LLM，handler 通过 `image_id` 反查 base64。**识图工具的核心数据源**。 |
| `pending_files` | `dict[str, dict]` | `{file_id: {"path": str, "name": str, "mime": str}}`，同 image 思路。 |
| `persona` | `Persona` | 当前生成回复的 `pawzochat.transport.models.Persona` 数据类实例，不是字典。 |
| `persona_id` | `str` | 当前回复角色的 ID；群聊中不是群 ID。 |
| `generated_images` | `list[dict]` | 本轮 LLM 之前生成的图片记录（多数工具用不到）。 |

Web 群聊调用时还会提供以下字段；私聊没有这些字段，使用 `context.get(...)` 读取：

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `conversation_type` | `str` | 群聊为 `group` |
| `conversation_id` / `group_id` | `str` | 当前群 ID |
| `media_dir` | `pathlib.Path` | 当前群发言的媒体暂存目录，由群服务提交 |
| `memory_mode` | `str` | 正常群聊为 `group`，内置记忆工具仅写入当前角色的本群记忆 |
| `is_cancelled` | `Callable[[], bool]` | 当前群发言是否已取消，耗时任务可据此提前结束 |

`pending_images` / `pending_files` 每轮重建，包含选中历史范围内的附件及引用附件。图片 ID 根据角色与图片内容生成，文件 ID 根据角色与文件路径生成；相同资源可保持相同 ID，读取时以当轮映射为准。群聊工具若生成图片，优先返回下述标准图片内容块，由宿主保存到正确的群媒体目录；不要仅凭 `persona_id` 把群聊产物写入私聊目录。`memory_context` 等内部记忆状态由宿主管理，插件不应直接修改。

返回值（每项一个内容块）：

```python
[
    {"type": "text",  "text": "工具的文本输出"},
    {"type": "image", "data": "<base64>", "mime_type": "image/png"},  # 可选
]
```

可省略字段：

- `text` 默认为空字符串
- `data` / `mime_type` / `uri` 仅 `type="image"` 等需要时填
- 也允许直接返回 `str`（自动包成单条 text 块）

handler 抛出的异常会作为 `[{"type":"text","text":"工具执行失败: <exc>"}]` 返回给模型。

#### 12.6.4 异常表

| 抛出 | 触发条件 |
| --- | --- |
| `PermissionError` | 未声明 `mcp.publish` |
| `ValueError` | `name` 不合法（含 `__`、首字符非小写字母/数字、含大写或特殊字符）；同一插件内重复注册同名工具；`description` / `parameters` / `handler` 类型不符 |
| `RuntimeError` | 工具注册表尚未初始化 |

#### 12.6.5 生命周期

- 工具应在 `setup(ctx)` 中注册。
- 插件被**禁用 / 重载 / 卸载**时，宿主自动注销该插件注册的所有工具，无需在 `teardown()` 里手动处理。
- 用户修改插件配置时会触发 reload（先 teardown 再重新 setup），工具的 description / parameters 会随之刷新。
- 一个插件可以注册任意多个工具，但同名注册会抛 `ValueError`。

#### 12.6.6 命名空间与 LLM 可见性

注册名 `plugin_<plugin_id>__<name>` 会出现在 LLM 的 tool list 里，与 MCP 服务器工具（`<server>__<tool>`）格式平行。

工具同时出现在：

- 「插件管理」详情页的"该插件提供的 LLM 工具"区块
- 「MCP 扩展」概览页的"插件提供的工具"区块（只读，跳转去插件页管理）

宿主将已完成的调用名称、参数、返回文字和已知错误状态保存到首条实际保存的助手消息的 `tool_history` 中，后续在该回复之前恢复。每条工具文字结果最多保存 12,000 字符，超出部分标注截断；群聊仅恢复当前角色的工具历史。插件返回普通内容块时，结果状态记为未知。

模型缺少工具调用能力，或历史中的工具已停用、卸载时，整组调用转为文字记录。删除承载历史的助手消息时记录一起删除；旧工具结果保留调用当时的内容。

工具返回并保存的图片会注册到当轮 `pending_images`，结果附带图片 ID，文本模型可继续调用识图工具。视觉模型在同批工具结果之后接收图片。后续历史从正式助手图片消息读取原图，`tool_history` 保存文字与图片 ID。

#### 12.6.7 完整示例：识图插件

让纯文本主模型也能"看图"——当用户发图、主模型读到 `[图片 ID:img_xxxx]` 时，模型调用本插件提供的 `recognize_image` 工具，由插件用配置好的视觉模型识别后返回文字描述。

`data/plugins/image_recognition/plugin.yaml`：

```yaml
id: image_recognition
name: 识图工具
version: 1.0.0
api_version: 1
entrypoint: plugin:create_plugin
description: 为纯文本主模型提供基于视觉模型的识图能力
permissions:
  - mcp.publish
config_schema:
  type: object
  properties:
    base_url:
      type: string
      title: 视觉模型 Base URL
      placeholder: https://api.openai.com/v1
      default: https://api.openai.com/v1
      order: 1
    api_key:
      type: string
      title: API Key
      secret: true
      order: 2
    model:
      type: string
      title: 模型名
      placeholder: gpt-4o-mini
      default: gpt-4o-mini
      order: 3
```

`data/plugins/image_recognition/plugin.py`：

```python
import urllib.request
import json

from pawzochat.core.extensions.api import Plugin, PluginContext


class ImageRecognitionPlugin(Plugin):
    def setup(self, ctx: PluginContext) -> None:
        self.ctx = ctx
        # 注册工具，命名空间为 plugin_image_recognition__recognize_image
        ctx.mcp.register_tool(
            name="recognize_image",
            description=(
                "识别图片内容。当用户消息中出现 [图片 ID:xxx] 文本时，"
                "用对应的 image_id 调用此工具获取图片描述。"
            ),
            parameters={
                "image_id": {
                    "type": "string",
                    "description": "[图片 ID:xxx] 中的 xxx 部分",
                },
                "query": {
                    "type": "string",
                    "description": "对该图片的具体提问；不提供则给出整体描述",
                    "default": "请用中文详细描述这张图片的内容",
                },
            },
            handler=self.recognize,
        )

    def recognize(self, arguments: dict, context: dict) -> list[dict]:
        image_id = arguments.get("image_id", "")
        query = arguments.get("query") or "请用中文详细描述这张图片的内容"

        pending = context.get("pending_images") or {}
        info = pending.get(image_id)
        if not info or not info.get("data"):
            return [{"type": "text",
                     "text": f"找不到图片 ID:{image_id}（可能已过期或不属于本轮对话）"}]

        api_key = (self.ctx.config.get("api_key") or "").strip()
        if not api_key:
            return [{"type": "text",
                     "text": "识图插件未配置 API Key，请在插件设置中填写。"}]
        base_url = (self.ctx.config.get("base_url") or "https://api.openai.com/v1").rstrip("/")
        model = self.ctx.config.get("model") or "gpt-4o-mini"

        b64 = info["data"]
        mime = info.get("mime") or "image/jpeg"
        payload = {
            "model": model,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": query},
                    {"type": "image_url",
                     "image_url": {"url": f"data:{mime};base64,{b64}"}},
                ],
            }],
            "max_tokens": 800,
        }

        try:
            req = urllib.request.Request(
                f"{base_url}/chat/completions",
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            text = data["choices"][0]["message"]["content"] or ""
            return [{"type": "text", "text": text or "（视觉模型返回为空）"}]
        except Exception as exc:
            self.ctx.logger.exception("识图调用失败")
            return [{"type": "text", "text": f"识图调用失败: {exc}"}]


def create_plugin() -> Plugin:
    return ImageRecognitionPlugin()
```

把这两份文件放在 `data/plugins/image_recognition/` 下，在「插件管理」中刷新、填写 API Key 并启用。为角色选择支持 `tool_use`、未标记 `vision` 的模型，并在角色工具策略中允许该工具。发送图片后，可在日志中查看识图调用。

#### 12.6.8 实现要点

在 `setup()` 中注册工具；插件重载时宿主会清理旧注册，再执行 `setup()`。handler 使用同步函数，读取当轮 `context` 中的附件映射，并自行校验参数、应用默认值。

业务错误可返回含处理建议的文本块。工具的实际名称以 `register_tool()` 返回值为准。

## 13. 注册聊天通道（`ctx.channels`）

`ctx.channels` 让插件提供一个**完整的聊天通道**：插件自己负责消息收发的传输层（连接、收消息循环、发消息），PawzoChat 负责消息队列、上下文构建与 AI 调用。注册后，该通道会像微信 / QQ 一样出现在「添加账号」的通道选择里，回复也会自动路由回插件。

通道类型固定为 `plugin:<plugin_id>`。

### 13.1 声明权限

```yaml
permissions:
  - channel.register
```

未声明时调用 `ctx.channels.register_channel` / `submit_inbound` 会抛 `PermissionError`。

### 13.2 注册通道

在 `setup(ctx)` 内调用一次：

```python
ctx.channels.register_channel(
    display_name="Telegram",          # 添加账号 UI 显示的名称
    on_outbound=self.on_outbound,     # (persona_id, message, reply_ctx) -> bool|None
    account_fields=[                  # 添加账号的表单字段（宿主渲染）
        {"key": "bot_token", "label": "Bot Token", "secret": True, "required": True},
        {"key": "note", "label": "备注", "required": False},
    ],
    id_field="",                      # 留空则生成不含凭据的账号 id
    on_start_account=self.on_start,   # 可选 (Account) -> None，账号上线时回调
    on_stop_account=self.on_stop,     # 可选 (account_id) -> None，账号下线时回调
    on_validate=self.on_validate,     # 可选 (fields) -> None，校验失败抛 ValueError
    hint="在 BotFather 创建机器人后填入 Token",  # 可选，表单下方提示
)
```

- `account_fields` 定义「添加账号」表单；为空时隐藏该通道的添加入口。
- 字段 `type` 支持 `checkbox`（布尔），其余按文本渲染；`secret: True` 用密码框。
- `required: True` 由自带前端表单检查，直接调用 API 时后端不会自动执行这项约束；必须在 `on_validate(fields)` 中重复完成凭据、必填项和格式校验。
- `id_field` 指定的字段值会直接成为可见的 `Account.bot_id`；不要把 Token、密码等机密字段用作 `id_field`。留空时宿主生成 `plugin:<id>:<随机值>`。
- 提交的 `fields` 以明文保存到 `data/auth/accounts.json` 中账号的 `extra`。

### 13.3 出站投递（`on_outbound`）

宿主把一条助手消息交给插件发送：

```python
def on_outbound(self, persona_id: str, message: dict, reply_ctx: dict) -> bool:
    # message["content"] 是内容块列表：{"type":"text","text":...} /
    #   {"type":"image"|"emoji","path":...} / {"type":"file","path":...,"name":...}
    # reply_ctx 含 account_id / user_id(=peer_id) / reply_target（你 submit_inbound 时传入的）
    text = "".join(b.get("text", "") for b in message["content"] if b.get("type") == "text")
    ok = self.client.send(reply_ctx["user_id"], text)
    return bool(ok)   # 返回 False 表示失败；None 视为成功
```

### 13.4 推入入站消息（`submit_inbound`）

插件在自己的收消息线程里，收到一条用户消息时调用：

```python
ctx.channels.submit_inbound(
    account_id,                 # 哪个账号收到的（= Account.bot_id）
    peer_id="远端用户ID",        # 远端用户标识，回填到 channel_link.peer_id
    text="用户发来的文本",
    images=[{"path": "/abs/x.png", "mime": "image/png"}],   # 可选，本地文件路径
    files=[{"path": "/abs/a.pdf", "name": "a.pdf", "mime": "application/pdf"}],  # 可选
    reply_target="可选的回复锚点",  # 回显在出站 reply_ctx 里（如某些平台的 msg_id）
)
```

返回 `True` 表示已入队（账号已绑定角色且队列接受）。账号未绑定角色、`message.received` 被取消或队列拒绝时返回 `False`。插件**自管**收消息线程（在 `setup` 启动、`teardown` 停止），宿主不提供调度器。

`images` / `files` 只会被规范化后把路径交给消息队列，宿主不会在 `submit_inbound()` 时复制源文件；插件必须保证绝对路径对应的文件在处理期间可读；后续轮次还会读取上下文范围内的历史附件，因此不能在本轮结束后立即删除源文件。需要长期预览的图片应保存在对应角色的 `images/` 等宿主可读取的媒体目录内。

`account_id` 使用 `on_start_account(Account)` 收到的 `Account.bot_id`，插件在接收循环中维护各连接与账号的对应关系。

### 13.5 生命周期与清理

- 宿主在账号上线 / 下线时回调 `on_start_account` / `on_stop_account`，插件据此决定为哪些账号收消息。
- 插件被停用 / 重载 / 卸载时，实际清理顺序是：移除 hook → `plugin.teardown()` → 注销插件工具 → 通道 `shutdown()`（逐个触发 `on_stop_account`）→ 注销通道。因此 `teardown()` 不应提前销毁 `on_stop_account` 仍要使用的资源。
- 应用初次启动时，插件通常先完成 `setup()` 和通道注册，再恢复账号；若运行中启用 / 重载插件，注册通道后还会自动重试此前因通道缺失而延迟启动的已保存账号。
- 如果 `setup()` 半途抛错，宿主会尝试调用已创建实例的 `teardown()`，并移除已注册的 hook、工具、通道及目录下的模块；插件应让清理逻辑兼容初始化未完成的状态，可靠停止已启动的线程和连接。

---

## 14. 自定义 HTML 配置面板（`config_ui`）

如果 `config_schema` 自动渲染的表单无法满足需求（多步骤向导、自定义控件、即时预览、复杂校验），可以让插件自带 HTML 配置面板。

### 14.1 启用

```yaml
config_ui: true                       # 简写：入口为 ui/index.html，高度随内容变化
```

或显式：

```yaml
config_ui:
  entry: index.html                   # 相对 ui/ 目录；旧写法 ui/index.html 也会被兼容归一化
```

并把页面静态资源放到插件目录的 `ui/` 子目录下。声明 `config_ui` 后，宿主**不再渲染** `config_schema` 的自动表单和默认“保存配置”按钮。

面板高度随页面内容自动增减，不设固定最小或最大高度。服务端会在返回的插件 HTML 中注入自动高度桥，跟随内容变化、图片与字体加载、窗口宽度变化重新测量。插件无需编写高度上报代码；旧 `config_ui.height` 字段仍可接受以兼容已有清单，但不再锁定面板高度。

面板布局应采用自然文档流，让内容撑开页面。不要给 `html`、`body` 或页面容器设置依赖 iframe 视口的 `100vh`、百分比 `height` / `min-height`，否则页面与 iframe 高度会相互依赖；长内容直接展开，由宿主页面滚动。窄屏适配请根据可用宽度换行或调整排布。

### 14.2 沙箱模型

宿主把面板放进一个 `<iframe sandbox="allow-scripts">`，**不带** `allow-same-origin`。这意味着：

- iframe 的源是 `null`：拿不到父页面的 cookie / localStorage / DOM
- 不能直接读取宿主管理 API 的响应（受同源策略限制）
- 与宿主只能通过 `window.postMessage` 通信
- 仍然可以执行自己的 JS、加载自己的 CSS、嵌入自己的图片

### 14.3 postMessage 协议

iframe → 宿主：

| `type` | 字段 | 用途 |
| --- | --- | --- |
| `ready` | — | iframe 加载完成，请求初始数据 |
| `save` | `id`, `settings` | 请求保存（宿主调 `PATCH /api/plugins/{id}/config`） |
| `pawzo:config-resize` | `height` | 宿主注入的自动高度桥消息，插件无需自行发送 |
| `resize` | `height` | 旧面板兼容消息；仅在自动高度桥尚未就绪时接受 |
| `toast` | `level`, `message` | 弹出宿主级 toast，`level` 取 `success` / `error` / `info` |

宿主 → iframe：

| `type` | 字段 | 用途 |
| --- | --- | --- |
| `init` | `plugin`, `schema`, `settings`, `locale` | 响应 `ready`，下发初始数据 |
| `save-result` | `id`, `ok`, `settings` 或 `error` | 保存结果回执，`id` 与对应的 `save` 请求一一对应 |

宿主用 `event.source === iframe.contentWindow` 识别消息发送方（沙箱 iframe 的 `event.origin` 一律为 `"null"`，无法用作鉴别）。

自动高度桥发来首条 `pawzo:config-resize` 后，宿主优先使用桥的测量结果，不再接收该页面旧的 `resize` 高度，避免已有插件的固定高度上报覆盖实际内容高度。

### 14.4 最小 HTML 模板

```html
<!DOCTYPE html>
<html>
<body>
<form id="f">
  <input id="key" placeholder="API Key">
  <button id="save" type="button">保存</button>
</form>
<script>
let nextId = 1;
const pending = new Map();

function send(msg) { parent.postMessage(msg, "*"); }

window.addEventListener("message", (e) => {
  if (e.source !== parent) return;
  const data = e.data || {};
  if (data.type === "init") {
    document.getElementById("key").value = (data.settings || {}).api_key || "";
  } else if (data.type === "save-result") {
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok) entry.resolve(data.settings || {});
    else entry.reject(new Error(data.error || "保存失败"));
  }
});

document.getElementById("save").addEventListener("click", async () => {
  const id = String(nextId++);
  const p = new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
  send({ type: "save", id, settings: { api_key: document.getElementById("key").value } });
  try {
    await p;
    send({ type: "toast", level: "success", message: "已保存" });
  } catch (err) {
    send({ type: "toast", level: "error", message: err.message });
  }
});

send({ type: "ready" });
</script>
</body>
</html>
```

在自定义面板内做更复杂的交互（多 tab、即时校验、发送测试按钮等）时，遵循同样的握手模式即可。内容高度变化由宿主自动跟随，无需另行调用 `resize`。

### 14.5 与 `config_schema` 的关系

声明 `config_ui` 后，`config_schema` 仍用于：

- 仍然用于默认值填充（首次创建 `config.yaml` 时）
- 仍然用于保存时的后端校验（PATCH 提交的 `settings` 不符合 schema 会被拒绝）
- 通过 `init` 消息把 schema 发给 iframe，便于面板自己生成提示信息

后端校验范围见第 9 节。自定义面板负责枚举、数值范围及其他业务校验。

### 14.6 静态资源服务

宿主仅在插件声明了 `config_ui` 时才提供 `ui/` 目录的静态资源。插件详情及返回 `plugin` 详情的操作响应包含 `config_ui_url`，宿主直接用它作为 iframe 地址：无自定义面板时为 `null`，本地使用 `/api/plugins/{plugin_id}/ui/{entry}`，公网使用包含公网路径前缀的 `/api/plugins/{plugin_id}/ui-assets/{token}/{entry}`。进入详情页时会重新获取链接，避免复用过期地址。

- 两种资源路由均强制把路径限制在插件根目录的 `ui/` 子目录内，禁止目录穿越及符号链接逃逸
- 关闭浏览器缓存（`Cache-Control: no-store`），插件重载后立刻生效
- 响应设置 `X-Frame-Options: SAMEORIGIN` 与 `Content-Security-Policy: frame-ancestors 'self'`，允许同源宿主嵌入沙箱 iframe
- 普通 `/ui/` 路由在公网要求登录；签名 `/ui-assets/{token}/` 路由支持不携带 Cookie 的 `GET/HEAD` 请求

签名令牌仅允许读取对应插件的 UI 文件，不能读取配置或调用管理 API；有效期 24 小时，应用重启后失效，退出登录不会立即撤销。无效、过期或用于其他插件的令牌返回 401。HTML、CSS 和 JS 中应使用相对资源路径，以保留公网前缀及令牌路径，不要硬编码以 `/` 开头的资源地址。

---

## 15. 启用、刷新与调试

### 前端管理

在 PawzoChat 设置页中点击「插件管理」即可：

- 浏览所有已安装插件的状态
- 启用 / 停用插件
- 点击插件卡片进入详情页，查看 manifest 信息和错误详情
- 编辑由 `config_schema` 自动渲染的配置表单
- 重载插件
- 在本地面板通过安装链接预览并确认安装、检查更新及升级（见第 18 节）
- 在本地插件详情页卸载插件，删除其目录、配置和运行数据

### REST API

也可以通过 API 管理（公网须先登录，写请求须通过同源检查）：

- `GET /api/plugins` — 列出所有插件
- `GET /api/plugins/{plugin_id}` — 查看详情、状态、错误与插件提供的工具
- `DELETE /api/plugins/{plugin_id}` — 本地同源请求，卸载插件
- `POST /api/plugins/refresh` — 重新扫描插件目录
- `POST /api/plugins/{plugin_id}/enable` — 启用
- `POST /api/plugins/{plugin_id}/disable` — 停用
- `POST /api/plugins/{plugin_id}/reload` — 重载
- `PATCH /api/plugins/{plugin_id}/config` — 更新配置
- `GET/HEAD /api/plugins/{plugin_id}/ui/<path>` — 读取已声明 `config_ui` 的静态资源
- `GET/HEAD /api/plugins/{plugin_id}/ui-assets/{token}/<path>` — 凭有效签名令牌读取对应插件的静态资源

列表、详情、启停、重载、配置修改和重新扫描均支持已登录的公网用户。详情以及 enable / disable / reload / 配置 PATCH 返回的 `plugin` 详情包含 `config_ui_url`（见 §14.6）。加载错误的 `last_error` 可能包含本地文件路径。

URL 预览、安装、取消预览、更新检查、升级、卸载和任务查询接口仅允许本地访问，完整路径见[插件概览的 REST API 表](plugins-overview.md#rest-api)。安装相关写请求须带与实际本地监听地址相同的 `Origin`，缺失时才回退检查 `Referer`；协议、主机和端口均须匹配，否则返回 403。安装进度和更新通知 SSE 也只发给本地连接。

`refresh`、任一插件的 enable / disable / reload，以及配置更新，都会卸载并重新发现、加载**全部**插件。已有 hook、工具或通道调用尚未结束时可能返回 409 `plugin_busy`，调用方应待任务结束后再尝试；清理失败返回 `recovery_required`，不继续替换版本。

### 调试建议

- 先写最小插件，只挂一个 hook
- 用 `ctx.logger` 打日志
- 在前端详情页查看 `status` 和错误信息，或通过 `GET /api/plugins/{plugin_id}` 查看 `last_error`
- 把可持久化的调试数据写到 `ctx.state_dir`
- 修改代码后点击“重载”按钮，无需重启应用

---

## 16. 完整示例集合

本节集中收录四个由浅入深的示例，分别覆盖 hook、LLM 调用和 MCP 工具调用：

| 示例 | 关键能力 | 位置 |
| --- | --- | --- |
| A. 屏蔽指定词后取消发送（reply.pre_send hook） | 修改 / 取消事件对象 | 本节下方 |
| B. 在 `message.stored` hook 内做一句话摘要 | 读取角色配置后使用 `ctx.llm.chat()` | 见 §10.4 |
| C. MCP WebSearch 桥（拦截 `/search` 命令直接返回搜索结果） | `ctx.mcp.list_tools` / `call_tool` + `ctx.messaging.send_message` | 见 §12.4 |
| D. 识图插件（给纯文本模型补 OCR / 视觉能力） | `ctx.mcp.register_tool` 注册工具供 LLM 调用 | 见 §12.6.7 |

---

### 示例 A：屏蔽指定词后取消发送

`plugin.yaml`

```yaml
id: deny_reply
name: Deny Reply
version: 1.0.0
api_version: 1
entrypoint: plugin:create_plugin
description: 包含屏蔽词的回复将被阻止发送
author: example
hooks:
  - reply.pre_send
config_schema:
  type: object
  properties:
    blocked_words:
      type: array
      title: 屏蔽词列表
      description: 包含以下任一词语的回复会被拦截
      items:
        type: string
      default: []
```

`plugin.py`

```python
from pawzochat.core.extensions.api import Plugin, PluginContext


class DenyReplyPlugin(Plugin):
    def setup(self, ctx: PluginContext) -> None:
        self.ctx = ctx
        ctx.hooks.on_reply_pre_send(self.on_reply_pre_send)

    def on_reply_pre_send(self, event) -> None:
        blocked_words = self.ctx.config.get("blocked_words", [])
        text = "".join(
            block.get("text", "")
            for block in event.message.get("content", [])
            if block.get("type") == "text"
        )
        for word in blocked_words:
            if word and word in text:
                self.ctx.logger.warning("Reply blocked by word: %s", word)
                event.cancel()
                return


def create_plugin():
    return DenyReplyPlugin()
```

---

## 17. 常见问题

### 如何选择宿主接口？

读取角色与会话使用 `ctx.personas`、`ctx.conversations`；调用模型使用 `ctx.llm`；主动推送使用 `ctx.messaging`；工具访问与发布使用 `ctx.mcp`；接入聊天平台使用 `ctx.channels`。`PluginContext` 汇总了这些接口，见第 5 节。

### 插件可以有自己的前端界面吗？

可以。通过 `config_ui` 声明 HTML 配置面板，或使用 `config_schema` 生成表单，详见第 14 节。

### 插件可以依赖其他插件吗？

在 `depends_on` 中填写依赖的插件 ID。加载已启用的插件时，若依赖缺失、未启用或形成循环，插件进入 `broken` 状态，详情页显示原因。

### 公网访问时能管理插件吗？

登录后可查看、配置、启停、重载和重新扫描插件。URL 预览、安装、升级、卸载、在线检查更新及任务查询使用本地面板，详见第 15 节。

## 18. 发布索引与自动更新

### 18.1 发行包与索引协议

用户粘贴的是稳定的 **http/https JSON 索引 URL**，不是 zip 地址。索引描述一个插件的一个版本，自动检查只读取索引；下载、安装和升级都需要用户确认。索引最多 1 MB，类型可为 application/json 或 text/plain。

zip 的 `plugin.yaml` 位于根目录或唯一顶层子目录，且只允许一个候选插件根。包内 manifest.id/version 必须与索引完全相同。禁止符号链接、路径越界、绝对路径和规范化后同名文件。只发布源代码和静态资源，排除 config.yaml、.install.json、state/、__pycache__/、.pyc/.pyo；宿主安装时强制生成禁用配置。配置 schema 必填项要提供有效默认值，否则 URL 新装会返回 invalid_settings；可先手动安装并配置。

若插件附带 macOS/Linux 脚本或程序，打包前设置其可执行权限；宿主解压时保留普通文件的可执行位，不恢复 setuid/setgid 等特殊权限。

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| pawzochat_plugin_index | integer | 是 | 必须为整数 1；不是布尔值；用于索引识别和协议演进 |
| id | string | 是 | `[a-z0-9][a-z0-9_-]*`，最多 128 字符，与 manifest.id 相同 |
| version | string | 是 | SemVer，与 manifest.version 完全相同 |
| download_url | string | 是 | http/https zip 直链，建议每个版本独立地址 |
| sha256 | string | 是 | zip 实际字节的 64 位十六进制 SHA-256 |
| name | string | 否 | 展示名称 |
| description | string | 否 | 简介 |
| author | string | 否 | 作者 |
| min_app_version | string | 否 | 最低宿主 SemVer；没有要求时省略 |
| platforms | string[] | 否 | 非空、不重复的数组，仅 windows/macos/linux；省略表示不限系统 |
| changelog | string | 否 | 更新说明 |
| public_key | string | 否 | Ed25519 原始 32 字节公钥，base64 编码 |
| signature | string | 否 | Ed25519 64 字节签名，base64 编码；必须与公钥同时提供 |

版本必须写成 `1.2.0` 或 `1.2.0-rc.1` 等 SemVer，不接受 `v1.2.0`、`1.2`、前导零数字段。Git tag 可以用 `v1.2.0`，但 manifest/index 内省略 v。宿主按数值段和预发布顺序比较，升级要求严格更高的版本，不支持手动降级。`min_app_version` 同时用于预览提示及服务端安装/升级资格检查。

例如 Windows 专用包在索引中使用 `"platforms": ["windows"]`，并在包内 `plugin.yaml` 使用 `platforms: [windows]`。两处声明共同限制可用系统，建议保持一致；一处省略不会清除另一处限制。索引平台不匹配时不会下载 zip，清单不匹配时在提取后拒绝，确认安装/升级时再次检查。限制会保存到宿主的 `.install.json`，后续启用和启动仍须满足。缺省的旧插件继续兼容。

若 Windows 与 macOS 的实现需要不同 zip，请分别发布稳定索引 URL 和对应的包，作者在下载说明中区分。此字段只限制包的适用范围，不会自动选择多个包。旧版宿主可能不识别该字段；面向旧版发布时同时用 `min_app_version` 声明所需的宿主版本。

### 18.2 可复制的打包与索引生成脚本

下例假定源码放在仓库 `plugin/`，其中有 plugin.yaml 与入口 Python 文件。把脚本保存为 `scripts/build_release.py`；本地执行前安装作者工具依赖 `python -m pip install PyYAML cryptography`。

```python
import base64
import hashlib
import json
import os
import re
import zipfile
from pathlib import Path
from urllib.parse import quote

import yaml

root = Path("plugin")
manifest = yaml.safe_load((root / "plugin.yaml").read_text(encoding="utf-8"))
if not isinstance(manifest, dict):
    raise ValueError("plugin.yaml 必须是对象")
# 只有省略才表示不限系统；拒绝空值、重复项和不认识的系统名。
if "platforms" in manifest:
    platforms = manifest["platforms"]
    if (not isinstance(platforms, list) or not platforms
            or any(not isinstance(item, str) or item not in {"windows", "macos", "linux"}
                   for item in platforms)
            or len(set(platforms)) != len(platforms)):
        raise ValueError("platforms 必须是不重复的非空数组，可选 windows、macos、linux")
plugin_id, version = manifest["id"], manifest["version"]
assert re.fullmatch(r"[a-z0-9][a-z0-9_-]*", plugin_id)
assert isinstance(version, str), "manifest.version 请使用字符串"
tag = os.environ.get("RELEASE_TAG", "v" + version)
assert tag == "v" + version, "tag 必须与 manifest.version 对应"
base_url = os.environ["DOWNLOAD_BASE_URL"].rstrip("/")
out = Path("dist")
out.mkdir(exist_ok=True)
archive = out / f"{plugin_id}-{version}.zip"
excluded = {"config.yaml", ".install.json", "state", ".git"}
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as package:
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root)
        if rel.parts[0] in excluded or "__pycache__" in rel.parts or path.suffix in {".pyc", ".pyo"}:
            continue
        if path.is_symlink():
            raise ValueError(f"不能发布符号链接: {rel}")
        if path.is_file():
            package.write(path, rel.as_posix())

with archive.open("rb") as stream:
    checksum = hashlib.file_digest(stream, "sha256").hexdigest()
index = {
    "pawzochat_plugin_index": 1,
    "id": plugin_id,
    "version": version,
    "download_url": base_url + "/" + quote(archive.name),
    "sha256": checksum,
    "name": manifest.get("name", plugin_id),
    "description": manifest.get("description", ""),
    "author": manifest.get("author", ""),
    "changelog": Path("RELEASE_NOTES.md").read_text(encoding="utf-8") if Path("RELEASE_NOTES.md").exists() else "",
}
if os.environ.get("MIN_APP_VERSION"):
    index["min_app_version"] = os.environ["MIN_APP_VERSION"]
if "platforms" in manifest:
    index["platforms"] = manifest["platforms"]

# 未配置密钥时发布无签名索引；开始使用签名后应持续保管同一私钥。
if os.environ.get("PLUGIN_SIGNING_KEY"):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    private = Ed25519PrivateKey.from_private_bytes(
        base64.b64decode(os.environ["PLUGIN_SIGNING_KEY"], validate=True)
    )
    index["public_key"] = base64.b64encode(private.public_key().public_bytes_raw()).decode("ascii")
    fields = ("download_url", "id", "min_app_version", "pawzochat_plugin_index", "sha256", "version")
    signed = {k: index.get(k, "") for k in fields}
    if "platforms" in index:
        signed["platforms"] = index["platforms"]
    payload = json.dumps(signed,
                         sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    index["signature"] = base64.b64encode(private.sign(payload)).decode("ascii")

(out / "plugin-index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"已生成 {archive.name} 和 plugin-index.json")
```

脚本使用 Python 3.11+，产出的索引使用实际包哈希，可直接发布。清单的平台限制会复制到索引，省略时表示不限系统；无效声明在打包前报错。一次本地运行示例：

```sh
DOWNLOAD_BASE_URL=https://example.com/plugins/v1.2.0 MIN_APP_VERSION=0.2.3 python scripts/build_release.py
```

Windows PowerShell 可先设置 `$env:DOWNLOAD_BASE_URL` 和 `$env:MIN_APP_VERSION`，再运行脚本。把 zip 和 plugin-index.json 上传到对应地址；给用户提供长期不变的索引 URL。重新发布必须更新 manifest 的版本，不能只覆盖旧 zip。

### 18.3 三个平台的 SHA-256 校验

```sh
# macOS
shasum -a 256 dist/reply_filter-1.2.0.zip
# Linux
sha256sum dist/reply_filter-1.2.0.zip
```

```powershell
# Windows PowerShell
(Get-FileHash .\dist\reply_filter-1.2.0.zip -Algorithm SHA256).Hash.ToLower()
```

哈希针对 zip 原始内容，不是解压目录。上述脚本已自动计算；如手工生成索引，必须在最终打包完成后再填 sha256。

### 18.4 签名与公钥连续性

可选签名的基础六字段为 download_url、id、min_app_version、pawzochat_plugin_index、sha256、version。索引存在 platforms 时，额外把原始数组纳入签名；数组顺序不改写，不排序或去重。缺省时不添加此字段，继续兼容旧六字段签名。键按字母排序，无额外空白，ensure_ascii=True，UTF-8 字节；min_app_version 缺失时载荷用空字符串。平台限制的添加、删除或修改必须重新签名。name、description、author、changelog 用于展示，未包含在签名中。

首次生成 Ed25519 密钥的本地示例（不要在 CI 日志输出私钥）：

```python
import base64, os
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

key = Ed25519PrivateKey.generate()
fd = os.open("plugin-signing-key.txt", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as stream:
    stream.write(base64.b64encode(key.private_bytes_raw()).decode("ascii"))
print("作者公钥:", base64.b64encode(key.public_key().public_bytes_raw()).decode("ascii"))
```

把私钥保存到密码管理器或 GitHub Actions Secret `PLUGIN_SIGNING_KEY`，不要加入索引、zip 或版本库；可将公钥发布在可信 README 渠道供用户首次核对。索引自带公钥只能证明包和该公钥签名一致，不能独立证明身份。宿主安装后固定公钥，后续换钥或撤销签名会阻止直接提交，要求用户针对该次包、版本和安装代次确认。

### 18.5 GitHub Actions 发布示例

先保存 §18.2 的脚本，再将下面内容放到 `.github/workflows/plugin-release.yml`。推送与 manifest.version 对应的 `v*` tag 后，生成 zip/索引并发布 GitHub Release。示例使用 [actions/checkout](https://github.com/actions/checkout) 和 [GitHub CLI 的 release create](https://cli.github.com/manual/gh_release_create)。

```yaml
name: Publish plugin
on:
  push:
    tags: ["v*"]
permissions:
  contents: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - name: Install publisher dependencies
        run: python -m pip install PyYAML cryptography
      - name: Build package and index
        env:
          RELEASE_TAG: ${{ github.ref_name }}
          DOWNLOAD_BASE_URL: https://github.com/${{ github.repository }}/releases/download/${{ github.ref_name }}
          MIN_APP_VERSION: "0.2.3"
          PLUGIN_SIGNING_KEY: ${{ secrets.PLUGIN_SIGNING_KEY }}
        run: python scripts/build_release.py
      - name: Publish release
        env:
          GH_TOKEN: ${{ github.token }}
          RELEASE_TAG: ${{ github.ref_name }}
        run: gh release create "$RELEASE_TAG" dist/* --verify-tag --title "$RELEASE_TAG" --generate-notes
```

常规稳定版的索引地址可使用 `https://github.com/OWNER/REPO/releases/latest/download/plugin-index.json`；下载包地址则固定到具体 tag。发布预发行版时给 gh 加 `--prerelease`，并使用独立的预发行索引地址，避免把测试版本当作稳定版入口。工作流重复运行若 Release 已存在会失败，可核验产物后按 [release upload](https://cli.github.com/manual/gh_release_upload) 文档补传；更改包内容时发布新版本。

### 18.6 安装限制与升级数据

默认索引 1 MB、zip 500 MB、解压 2048 MB，下载总期限 600 秒。带模型、词库、音色的包应尽量精简，主 config.yaml 可调整后重启：

```yaml
plugins:
  max_download_mb: 500
  max_unzipped_mb: 2048
  download_timeout_seconds: 600
```

大小可设 0 表示不限制，超时必须为正；压缩比/成员数量限制仍启用。打包版没有 pip，作者必须使用宿主已有依赖或随包携带可兼容的纯 Python 代码。

`.install.json` 保存真实来源、版本、公钥、安装代次及索引声明的平台限制，完全由宿主生成；插件不要读写它。持久化业务数据放 state/。升级保留 config/settings、state 和启用状态；失败自动恢复提交前的完整快照。更新成功并通过加载检查后自动删除旧版快照，不提供手动降级；后续问题需发布更高版本修复。新版应兼容或迁移现有数据，并在 setup 中检查不支持的数据版本。失败的候选数据先隔离，完整恢复后自动清理；未完成恢复的现场不会自动删除。

teardown 必须停止自管线程、定时器并结束状态写入；宿主不能在后台回调仍运行时安全替换代码。忙碌或无法确认停止的插件会拒绝在线替换。

操作者简明流程见[插件概览第 12 节](plugins-overview.md#12-url-安装发布与更新)。
