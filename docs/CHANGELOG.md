# Changelog

格式基于 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 [Semantic Versioning](https://semver.org/)。

## [0.2.3] - 2026-10-13

### Web 多角色群聊

- 新增多角色群聊，支持文字、图片、文件、引用、表情、语音回复、生图与工具调用，可管理成员、群头像和聊天历史。
- 支持 `@成员`、`@所有人` 和角色互相点名接话；引用角色消息时自动 @ 原发送者，优化角色对发言者与对话对象的识别。
- 可设置成员回复概率、连续回复上限，并手动停止接话；用户发言后无人接话时，从回复概率大于 0 的成员中按权重选择一位回应。
- 支持群共同背景、聊天规则和成员专属提示词，以及后台接话、刷新重连和群设置草稿恢复。

### 群聊记忆

- 每群每角色拥有独立记忆，可单独开关生成、查看、编辑和删除，并按角色设置读取私聊记忆。
- Web、微信和 QQ 私聊可按群选择读取角色的群聊记忆；离群后保留记忆，删除群聊时可选择一并清理。
- 优化记忆总结与整理的调用顺序，修复清空记忆、关闭生成或删除角色后旧任务再次写入的问题。

### 语音

- 新增 ElevenLabs 语音服务商，支持 Eleven v4、MP3 试听、账户音色搜索与分页、手填音色 ID 和已有克隆音色。
- ElevenLabs 支持调节稳定度、音色相似度，以及独立的情绪和声音／语气标签开关；统一角色、模型默认音色与试听页的音色选择器。
- 新增「按概率触发」语音，支持 0–100% 概率设置，适用于私聊、主动消息和群聊。

### 插件管理

- 本地插件页支持通过安装链接预览、下载和安装插件，自动检查更新并提示升级。
- 升级时保留插件配置、启用状态和运行数据，加载失败时自动恢复旧版，支持安装与升级中断恢复。
- 本地插件详情页新增卸载入口，自动检查依赖关系并清理插件文件、配置及目录内的运行数据。
- 公网登录后支持查看、配置、启停和重载插件；优化配置面板的自适应高度、主题显示与编辑草稿保留。

### 聊天与界面

- 消息菜单新增「复制」，支持复制消息正文和语音转写文字。
- 聊天和朋友圈支持切换页面后恢复未发送的文字与附件，聊天草稿同时保留引用和 @成员，会话列表显示草稿摘要。
- 统一按钮、表单、账号卡片和主题控件样式，优化提示词输入框的自动高度与光标跟随、表情分类标签及手机竖屏和深色主题显示。
- 世界书支持在开头或末尾添加小节，展开与折叠时保持阅读位置。

### 修复与优化

- 微信 iLink 对齐 2.4.9，优化扫码登录、网络错误提示、消息轮询和输入状态刷新，修复旧扫码结果干扰新登录流程的问题。
- 修复微信图片与文件上传重复重试、损坏附件被保存的问题，完善扫码与连接诊断日志。
- QQ 对齐 `openclaw-qqbot@2.0.4` 协议处理，修复发送失败被误判成功、凭据重复刷新和错误重试，优化会话恢复、重连、账号停止处理及请求诊断日志。
- 对话上下文保留历史图片、文件和引用附件及其来源，修复后续回复丢失媒体上下文或混淆附件归属的问题。
- 修复角色导出后再导入时空系统指令、参考图模式、世界书顺序和提示词空白发生变化的问题，清理导入导出中的本机群记忆关联。
- 修复快速配置或新建会话后列表未刷新、角色设置部分生效、页面切换后旧请求覆盖内容，以及发送消息覆盖新草稿的问题。
- 精简常规 HTTP 请求与连接日志。

## [0.2.2] - 2026-09-27

### 角色语音控制

- 角色语音页按服务商提供控制选项：MiniMax / PawAPI 支持语言、语速、音量和音调，粤语音色自动匹配粤语；MiMo 支持方言、语速档位和风格描述。
- 新增独立的语气词、情绪和停顿开关，默认关闭，保留已有设置。语气词和停顿用于 MiniMax / PawAPI；语气词注明仅 Speech 2.8 系列支持，不随模型切换自动开关。
- 完善语音提示词，按开关注入声音标签、单条情绪及停顿规则。情绪未指定时自然表达；语音对应的文字及合成失败后的文字回复会清理控制标记。
- 在「设置 → 语音服务商 → 语音测试」中调整参数并试听，与聊天使用相同的合成规则。角色语音配置支持局部更新、导入导出，切换服务商时保留各自参数。
- 完善 PawAPI 参数适配，调用失败时明确报错，不再静默删除参数重试。

### 记忆更新与去重
- 拒绝非对象的记忆写入请求；记忆配置先校验再替换，避免非法参数在返回错误前改变记忆设置。
- 总结／合并写回前再次校验设置，避免关闭功能、切换为提醒模式或调整阈值后，旧后台任务仍写入。统一自动总结启用判断，清理未使用的辅助函数、单次调用包装和重复指纹计算；存储结构不变。
- 修复后台合并／删除后旧编号可能更新错记忆的问题：AI 使用本轮提示词对应的临时内容指纹校验，冲突后停止本轮记忆写入，取消更新失败转为新增的指引。同轮正常新增和连续更新仍可用。
- AI 写入与混合模式的总结游标在同一次加锁保存中提交，游标只覆盖本轮已读取的对话；失败、重复或无变化时不推进提醒计数与工具总结游标。
- AI、网页、朋友圈、自动总结及超限合并统一防止完全相同文本重复写入，仅忽略首尾空白，不做近似匹配或历史批量清理。重复自动总结仍保存处理进度，避免反复总结同一批对话。
- 网页列表返回临时 `fingerprint`，编辑 JSON 和删除查询参数必须携带该值；缺少／格式错误返回 400，目标已变化／消失返回 409，重复新增或改写返回 409。旧页面需刷新，外部调用需先读取列表获取校验值；编辑冲突保留草稿。`memory.json` 结构不变，无数据迁移或额外模型调用。

### 记忆触发方式
- 新增「仅按轮数总结」（`memory.trigger_mode: summarize_only`）：只在累计达到指定轮数后自动总结对话，禁止 AI 通过记忆工具自主新增或改写；已有记忆注入、手动管理、朋友圈记忆写入及超限合并保持原有规则。轮数设为 0 关闭聊天记忆自动写入。
- 原有选项改名为「AI 自主记录＋定期提醒（默认）」和「AI 自主记录＋按轮数总结」，说明 AI 工具权限、计数重置及轮数为 0 的行为；两种总结模式互切保留进度，从提醒模式开启总结时重新计数。配置及角色卡导入导出支持新模式，现有角色与默认值保持兼容。

### 聊天历史
- 修复虚拟列表慢速上滑被反复拉回底部、快速滚动时闪烁移位：向上滚动立即解除底部跟随，程序校正不改变用户滚动意图；节点挂载、测量和位置补偿在同一帧内完成。
- 聊天页支持按 60 条向上加载全部历史，使用动态高度虚拟列表限制页面节点数量；加载历史、图片和语音转写时保持阅读位置。
- 新消息增量更新，查看旧消息时不跳到底部；离底部超过 300px 时在输入区上方居中显示“回到底部”按钮及新消息数量，接近最新消息时隐藏。
- 增加游标分页、断线补齐、发送回执去重与页面退出清理；历史编辑、删除或清空后自动重载，原有按轮次和日期接口保持兼容。

### QQ 主动消息
- 开放 QQ C2C 私聊主动推送，复用角色已有开关、随机间隔、连续上限和静默时段；配置默认值不变，无需新增配置。
- 定时消息、插件主动发送和超出被动回复额度的发送共用自动频控（账号 5 次/秒、30 次/分钟，接收人 20 次/分钟）。平台限流和临时网络错误冷却 30 分钟后恢复发送资格；拒收、无权限或无好友关系等待有效 QQ 入站消息后再尝试。延期不累计通用失败次数。
- 主动上下文不再使用历史消息 ID，增加账号运行代次隔离及可取消等待，防止停止或重启后旧任务继续发送。

### 新增与修复
- 通道复审补充修复：插件改派角色后的引用隔离、QQ 停用与 token 刷新期间的发送拦截、上传读失败及大小变化处理、迟到索引清理、历史编辑保留引用附件，以及过期扫码回调隔离；聊天与历史页共用引用媒体展示。
- 微信 / QQ 共用持久化引用索引，支持平台 ID 回查、微信局部引用校验及已有媒体引用；按账号、对端和角色隔离，保留 30 天、每通道每账号最多 10,000 条。引用附件独立展示，删除或不可访问时提示失效。
- 微信连接按代次隔离，长轮询可取消；停用前已接受的工作继续本地保存，旧回复不会发送到新连接。QQ 在入站副作用前原子去重，失败允许重投。
- 微信扫码使用 POST 携带后端本地 token 列表，兼容已绑定提示及 404/405 的旧接口回退；凭据 `-14` 冷却一小时并跨重启保留，冷却期间阻止外发和主动模型生成。
- QQ 达到 5 MiB 的媒体采用 SDK 1.0.4 分片上传，支持类型大小预检、流式哈希、进度通知、确认重试及停止后的发送拦截。

## [0.2.1] - 2026-08-16

### 新增
- 语音服务商新增 MiMo（小米）预设：走官方 `mimo-v2.5-tts` 模型（`/v1/chat/completions`，`api-key` 头认证），内置 9 个默认音色目录（`mimo_default`/冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean）；情绪经 user 消息风格指令表达（`[语音-happy]` → 「请用开心愉悦的语气朗读」），音频为 WAV（24kHz），微信按 `.wav` 文件卡发送、QQ SILK 转码与 Web 播放均原生兼容
- 角色记忆设置新增「触发方式」（`trigger_mode`，逐角色配置）：
  - `remind`（默认）：沿用现行行为，达到「触发轮数」时仅在 LLM 上下文注入一条提醒，由 AI 自主决定是否记录
  - `summarize`：达到「触发轮数」后后台线程直接把本轮以来未总结的对话调用 LLM 总结为一条第一人称记忆并推进 `last_summarized_timestamp` 游标（持久化在 `data/chats/<persona_id>/memory.json`，重启不丢），不再注入提醒；`record_memory` / `update_memory` 工具仍可用，AI 主动记录后自动总结计数顺延。切换到该模式时游标自动重置到会话最新消息，避免一次性总结整段历史。总结写回后记忆数可能短暂超限，由下一轮结束时的后台合并兜底
- MCP Server 支持按服务器设置工具调用超时：编辑表单与详情页新增「工具超时（秒）」（1–600 秒，留空沿用默认 30 秒，即角色工具策略的 `timeout_seconds`）；设置后对普通 MCP 工具与能力适配器两条调用路径统一生效，JSON 批量导入支持 `timeout_seconds` 字段，已有配置不受影响

### 变更
- `chat.max_context_rounds` 默认值由 10 提升到 20（仅影响新生成的配置，已有 config.yaml 不迁移，可在「对话设置」中手动调整）
- 主动消息失败处理重做：连续 3 次失败不再自动改写 config 关闭该角色的主动消息（此前需手动重新开启），改为挂起主动周期（仅内存状态，不落盘），用户下次回复或重启程序后自动恢复；微信通道推送策略（`can_push_now`）新增 10 条回复配额本地预判——以最近一条微信侧用户消息为锚点（网页端预览消息不重置微信的 context_token，23h 窗口判定同步修正），统计其后已发送的消息条数（文本/图片/表情包/文件/语音各占一条），配额用尽时直接跳过本轮触发，不再空烧 LLM 生成后发送失败。插件主动发送共用同一策略

### 修复
- 更新安装改为原子交换：程序本体（exe / `_internal` 等）先完整复制到 `<名称>.pawzonew` 并逐一校验齐全，再经两阶段 rename 交换到位，任一环节失败自动回滚到旧版本，杜绝覆盖写被锁定文件留下新旧混杂的半成品；若进程在交换间隙被强杀或断电，下次启动（及下次安装前）会先把 `.pawzoold` 旧版本改名还原再清理残留，避免安装目录残缺无法运行。发布包自带的顶层 `data/` 资源目录（默认表情包/主题/内置 MCP 服务器）不参与交换——`data` 内正是更新进程自身的运行位置（`data/update_staging`）与其打开着的 `data/logs/update.log` 句柄，Windows 下对其 rename 必然被拒，Unix 下交换成功还会在残留清理时连带删掉整个用户数据目录——改为安装前先合并进现有数据目录（覆盖式合并 + 锁重试，用户文件不受影响）
- 修复并发重复下载更新：服务端改为原子预留下载槽（重复请求干净返回 409，不再产生注定失败的重复下载线程；工作线程启动失败时释放槽位），网页端快速双击「下载更新」不再发出重复请求
- 修复下载进度条回跳抽搐：前端 `api.get` 的 SWR 缓存命中时立即返回上一轮旧值，更新状态轮询（每秒读 `/api/update/state`）没绕过缓存，旧进度与 SSE 实时进度交替刷进度条导致来回跳动；现更新检查/状态轮询全部绕过缓存（本为实时状态查询）。快速双击「下载并更新」经排查**不会**触发两次下载（前端同步守卫 + 后端原子下载槽 409 双重拦截），抽搐纯属上述缓存旧值所致
- 更新下载接口新增就绪短路：staging 已有待应用的更新包时再次请求下载直接返回 200 `already_ready`（前端轮询随即展示「下载完成」），堵住旧前端状态触发整包重新下载、进度条归零重跑的漏洞
- 更新相关弹窗（启动时「发现新版本」、下载进度/下载完成）一律不再响应点击遮罩关闭，需经弹窗内按钮主动关闭或继续操作：启动弹窗始终保留「稍后再说」，下载完成进度弹窗把原「取消」改为「稍后再说」；仅下载失败后恢复点击遮罩关闭。避免更新弹窗被误触隐藏后更新在后台静默进行
- 更新文件复制重试逻辑修正：`shutil.copytree` 对锁定文件不会中断，而是在最后抛出聚合的 `shutil.Error`，此前捕获 `PermissionError` 永远命中不到、复制半途而废；现捕获聚合错误并按失败条目（区分文件/目录）精确重试

## [0.2.0] - 2026-07-27

### 新增
- QQ 聊天通道：原生接入 QQ 机器人开放平台 API v2（WebSocket 网关接收、access_token 自动刷新与续期、私聊 C2C 收发）。入站支持文本、图片、视频、文件（富媒体按附件 URL 即时下载，图片 ≤20MB / 视频 ≤30MB / 文件 ≤100MB，超限跳过不影响整条消息），以及语音——兼容 QQ 原生语音实际使用的 `content_type: "voice"`（及 `voice_wav_url` / `.amr` / SILK 形态），优先下载平台 WAV，必要时将 SILK 解码为 Web 可播放音频，并读取 `asr_refer_text` 作为转写；未提供转写时不进入对话队列并记录诊断日志。原生语音与普通 `audio/*` 文件分流，MP3/WAV 等附件不会因缺少转写而被丢弃；出站支持文本、图片、文件（base64 富媒体上传，文件受 QQ 平台扩展名限制，被拒时干净落日志而非静默吞掉）。添加账号时填写 AppID / AppSecret 即可，需先在 QQ 开放平台为机器人开通 C2C 私信权限。仅支持私聊，群消息忽略；被动回复绑定收到消息的 `msg_id` 并使用随机 16 位 `msg_seq`，同一入站消息最多使用 4 次被动回复，之后降级为不带 `msg_id` 的即时发送；QQ 主动推送服务仍保持关闭。入站引用上下文支持官方新增的 `message_scene` / `msg_elements` 字段；「正在输入」状态当前未启用
- 第三方插件聊天通道：插件可通过 `ctx.channels.register_channel(...)` 注册完整通道（自带消息收发循环 + 出站处理器），用 `ctx.channels.submit_inbound(...)` 把消息推入队列；PawzoChat 负责消息队列与 AI 调用。需声明 `channel.register` 权限。插件被禁用 / 卸载时自动注销其通道并下线相关账号
- 添加账号支持选择通道类型：微信（扫码）/ QQ（表单）/ 插件自定义通道；账号列表与链接选择器展示所属通道，链接路由按账号自动识别通道类型
- 快速配置支持 QQ / 第三方通道：添加账号步骤按通道类型分流表单，QQ 通道参数弹窗内嵌 OpenClaw 机器人配置页超链接
- 聊天窗口点击角色头像跳转角色详情页，点击自己头像跳转个人资料页；长按/右键头像不再触发引用
- 快速配置增加第四步「隐私说明」：软件声明 + 隐私说明折叠卡片 + 遥测开关（向导内默认开启，完成后立即上报 quick_setup_complete 事件）；桌面端卡片限高 85vh 内部滚动，移动端全屏
- AI 语音消息（TTS）：角色开启「语音选项」后，AI 可在回复里用 `[语音]`/`[voice]` 标记（可选情绪 `[语音-happy]`）把内容合成为语音条，与文字按书写顺序穿插发送；合成失败或未开启时该段自动降级为文字。情绪对 MiniMax 原生与 PawAPI 等 OpenAI 兼容中转均生效（后者经 `metadata.voice_setting` 扩展字段透传，不支持该扩展的端点自动去除后重试）。网页对话以微信风格语音气泡渲染（时长自适应宽度、点击播放、波纹动画）
- 入站语音回放：微信/QQ 用户语音保存为 Web 面板可播放的结构化语音条，语音转写在 AI 上下文中统一表示为 `[语音] 转写内容`；音频下载或转码失败时按该格式降级为普通文本。网页聊天窗口中长按或右键语音条，未展开时显示“转文字”，展开后切换为“收起文字”；展开文本不包含 `[语音]` 标记
- 语音服务商管理：设置页新增「语音服务商」，支持 MiniMax 原生（`/v1/t2a_v2`）、OpenAI 兼容（`/v1/audio/speech`）及 PawAPI 预设与自定义；可增删改服务商/模型、导入预设、按模型指定调用方式与默认音色，并在「语音测试」页试听。音色下拉随模型所属体系（MiniMax / OpenAI）联动
- 语音出站：QQ 转码为 SILK 后发送真正的语音气泡；微信固定发送音频文件卡片——经实测确认 iLink 投递管线会静默丢弃 bot 方向的 voice_item（sendmessage 返回 200 但客户端不渲染，逐字节镜像真实入站语音报文亦然；官方 openclaw-weixin 插件同样从不发送语音）；网页预览直接播放 MP3。转码依赖缺失或发送失败时统一回退文件卡片

### 变更
- 通道协议同步腾讯官方近期实现：微信 iLink 元数据升级至 `@tencent-weixin/openclaw-weixin@2.4.6`（`channel_version=2.4.6`、`client_version=132102`），保存并复用扫码 IDC 线路；QQ 网关优先使用新版 `/gateway`（旧 `/gateway/bot` 仅作 404/405 兼容回退），补齐网关关闭码恢复、5000 字安全分段和文件上传原名
- 记忆机制由「固定轮数自动总结」改为 LLM 工具驱动：新增内置工具 `record_memory` / `update_memory`，角色开启记忆后 AI 在对话中自主决定何时记录新记忆、何时覆盖更新过时记忆；`[历史记忆]` 注入块为每条记忆标注编号 `#N` 作为更新目标（与网页记忆管理的序号同源）。记忆条数超过「最大记忆条数」时仍自动后台合并，改为在每轮对话结束后检查触发（工具/网页/朋友圈写入的记忆统一兜底，且避免合并在本轮中挪动编号）。记忆工具仅在对话中可用，朋友圈生成/评论不暴露（朋友圈记忆仍由独立的「写入记忆」开关控制）。存储格式（`data/chats/<persona_id>/memory.json`）不变，网页面板的手动记忆管理不受影响。注意：工具策略为白名单模式的角色需自行把 `record_memory` / `update_memory` 加入白名单；不支持工具调用的模型不再自动产生记忆（仍可在网页面板手动管理）
- 恢复「提醒轮数」（`trigger_rounds`）配置：代替已移除的固定轮数强制触发，改为每 N 轮未记录记忆后在 LLM 上下文注入一条系统级提醒，提示 AI 回顾本轮是否有值得记录的重要信息（身份/喜好/约定/感受等），无值得记录的内容则跳过。设为 0 禁用提醒，默认 10 轮。同时恢复角色编辑器的对应步进器与 API 校验，「包含在提示词」下方新增「提醒轮数」设置项。旧 config.yaml 中的 `trigger_rounds` 字段不再被自动清除，向后兼容 0.1.9 之前的版本
- 记忆链路加固：记忆文本注入上下文前中和行首 `[` 段落标记（防止诱导 AI 记下伪造的 `[系统指令]` 段劫持系统提示，合并提示同样处理）；工具/网页写入的记忆内容增加长度上限与类型校验；`max_memories` 下限钳位为 1（0/负值会导致每轮空烧 LLM 合并）；记忆保存失败不再向 AI/网页谎报成功
- 统一聊天通道抽象：新增 `Channel` 抽象基类 + 通道注册表，微信 / QQ / 网页 / 插件通道共用同一套生命周期（启停、在线状态、出站投递、主动推送策略）；回复分发不再硬编码 `channel == "wechat"`，改为按通道注册表分发，网页预览的打字延迟并入 `WebChannel`
- 持久化结构泛化：账号模型新增 `channel_type` 与 `extra`（QQ / 插件凭据存于 `extra`，不进 config.yaml）；会话绑定由 `wechat_link` 泛化为 `channel_link`（含 channel / peer_id / reply_target），旧文件在读取时按需迁移，并保留 `wechat_link` 镜像以兼容版本回退
- 主动消息与插件出站改为按通道策略判定（`Channel.can_push_now`）：微信沿用 23h openclaw 上下文窗口与群聊跳过，QQ 为纯被动（不主动推送），网页无限制；插件自定义通道默认允许主动推送，实际平台不支持时由插件的出站处理器返回失败
- 遥测默认关闭（隐私优先），快速配置向导内提供开启选项
- 网页静态资源缓存按公网/本地分流：本地面板改为每次校验（`no-cache`），修复更新后被旧 JS/CSS 缓存钉住；聊天图片/语音改为强不可变长缓存、表情包改用 ETag 协商缓存，修复消息列表重渲染时媒体重复下载、气泡塌缩、滚动位置错乱

### 内部
- 新增模块：`pawzochat/channels/{base,registry,web,qq,plugin}.py`、`pawzochat/transport/qq/{client,gateway,models}.py`；新增依赖 `websocket-client`
- 微信收发迁移进 `WeChatChannel`：每账号的 iLink 客户端 / 发送器 / 长轮询器由 App 收归通道内部；清理 `App.get_sender` 与三个账号字典、`ReplyDispatcher._delay_for_local_preview`、`api_accounts.list_accounts` 的 O(n²) 与未用 `inv_map`
- 账号接口新增 `GET /api/accounts/channels`（可添加的通道及表单元数据）与通用 `POST /api/accounts`（表单通道创建，QQ 通过拉取 access_token 校验凭据）；列表接口补 `channel_type` / `channel_name`，在线状态走通道 `is_online`
- 插件 API 新增 `ChannelsFacade` 与 `channel.register` 权限；`PluginContext` 注入 `channels` 门面，见 `docs/plugin-development-guide.md`
- 新增模块：`pawzochat/mcp/builtin/memory_tools.py`；`MemoryService` 新增轮次计数器与提醒触发逻辑（`on_round_complete` / `on_memory_recorded` / `check_and_ack_reminder`）
- 新增路由：`POST /api/telemetry/send`
- 遥测不再区分开发/打包模式，统一由 `enabled` 开关控制；移除 `sys.frozen` 检查与 `PAWZOCHAT_TELEMETRY_DEV` 环境变量
- 新增语音子系统：`pawzochat/voice/{base,manager,synthesis,transcode}.py` 与 `providers/{minimaxi_tts,openai_tts}.py`；新增路由 `api_voice_providers.py`（`/api/voice-providers` CRUD + `_test`）与 `/api/audio/<persona_id>/<file>`（支持 Range）；`text_splitter` 新增 `parse_voice_reply`/`strip_voice_markers` 并对语音标记正则做防灾难性回溯加固；Persona 全链路贯穿 `voice_generation`
- 新增依赖 `miniaudio`（音频解码/时长探测）、`pysilk-mod`（PCM↔SILK 编解码），均懒加载，缺失不影响启动；PawzoChat.spec 补充对应 hiddenimports

## [0.1.9] - 2026-06-03

### 新增
- 人设编写助手：一句话需求即可生成草稿人设，复用 ChatService 的工具调用循环，生成过程可调用联网搜索等 MCP 工具；提供独立的「发现」页入口与快速配置里的「一键生成人设」按钮。生成接口做了请求体类型校验、限定使用已配置模型、收紧工具循环上限（max_iterations=4 / timeout=30s）
- 微信引用消息回复：被引用的消息文本存入独立的 `quote` 字段（不再把 `[引用: …]` 前缀塞进正文），气泡下方以微信风格引用框渲染；支持长按 / 右键「引用」、输入框引用预览条，以及历史编辑器中引用的查看 / 编辑 / 清除

### 变更
- iLink 协议升级到 2.4.4：与上游 `@tencent-weixin/openclaw-weixin@2.4.4` 对齐（`channel_version` 2.4.1→2.4.4、`client_version` 132100、新增 `bot_agent`）；扫码登录新增配对码流程（need_verifycode / verify_code_blocked）与按需出现的验证码输入框，并补上 notifyStart / notifyStop 在线状态上报（best-effort，不阻塞启停）

### 修复
- 加固扫码状态查询，避免上游返回畸形 / 非 dict / 非 2xx 响应时 `qr_status` 直接 500；设置页取消扫码时停止轮询，过期分支清理残留的验证码输入
- 快速设置「新建角色」加固名称校验与反馈：补齐前端的空 / 超长 / 非法字符 / 尾随空格句点 / 重名校验，名称类错误改为输入框下方的行内红字（修复一键生成后名称为空或重名时「下一步」看似无响应）；其余向导提示原先被全屏覆盖层遮住全局 toast，改用渲染在覆盖层内部的本地浮层提示。另外生成进行中阻止与创建竞争，并在离开第二步后丢弃迟到的生成结果

### 内部
- 新增模块：`pawzochat/web/routes/api_persona_writer.py`、`pawzochat/web/static/modules/persona_writer.js`、`pawzochat/web/static/modules/qr_verify.js`
- `quote` 贯穿消息队列、会话存储、聊天上下文、世界书匹配与记忆摘要；`update_message` 契约新增 quote 处理（None=保留 / ""=清除 / str=设置）
- 清理死代码：移除 `AuthManager.qr_login` / `_print_qr_terminal` 及未用的 `base_url` 构造参数、人设编写助手的工具名白名单（无实际防护且会误伤第三方搜索 MCP）；`placeActionsPop()` 提取到 utils.js 共享
- 角色名称非法字符正则提取为 `utils.js` 的 `ILLEGAL_NAME_RE` 单一来源，quick_setup / contacts / worldbook 共用

## [0.1.8] - 2026-05-20

### 新增
- 朋友圈支持编辑动态正文与评论文本，纯数据修改不会重新触发 LLM 生成与记忆写入，时间戳保留以保证 feed 顺序不变

### 变更
- 公网链接下网页面板 SPA 切 Tab 提速：新增 GET 响应内存级 SWR 缓存与 Tab DOM 快照保留，静态资源改为带 ETag 的短期缓存

### 修复
- 修复公网网页面板下朋友圈刷新 / 发布 / 上传封面 / 评论 / 点赞全部 404
- 修复角色 `tool_policy.timeout_seconds` 未生效：MCP 工具调用现在按角色配置超时，到期会向 LLM 明确返回超时提示，避免对话以「……」静默收场
- 修复工具调用循环跑满迭代上限时返回空回复，现在会抛出明确错误
- 修复 MCP 工具返回的图片在触发 PIL 解压炸弹防护时会中断整轮对话；同时放宽 base64 兼容性（URL-safe / 换行 / 无 padding）并扩展可识别格式
- 修复朋友圈评论「...」菜单贴近屏幕右边时被压成窄条，菜单位置现在自适应视口

## [0.1.7] - 2026-05-18

### 新增
- 朋友圈：新增独立的「朋友圈」模块，UI 入口在主导航；用户与角色可以共用一条 feed 互相发动态、点赞和评论。每个角色可配置「是否可发动态」（publishers）、「是否参与评论」（repliers）、评论概率 0–100、以及是否将本次朋友圈互动写入该角色记忆；动态封面图、`post` / `reply` 提示词模板可在设置中自定义；底层数据按 `moments.json` 原子写入到 `data/moments/`，图片按动态 ID 隔离在 `data/moments/images/<mom_id>/`
- 朋友圈生成与回复链路：单 worker 串行调度，所有 LLM 调用（动态生成 / 评论 / 用户被回复后的 counter-reply）共用一把跨 workflow 互斥锁，避免并发触发上游限流；用户在评论区追问被回复角色时，由后台 FIFO 队列处理，不会与正在进行的对话轮次交错；动态作者已支持调用 `generate_image` 工具自动配图（最多一张），系统会将动态文本和配图作为多模态输入提供给评论角色
- 朋友圈记忆联动：默认开启「写入记忆」时，角色自己发布的动态、对用户朋友圈的评论会以第一人称摘要写入该角色的记忆；用户之间或角色之间的互动则按产品决策刻意不写入
- 角色创建 / 导入 / 删除时同步维护朋友圈名单：新角色默认自动加入 publishers 与 repliers，删除角色时清理 `publishers` / `repliers` / `reply_probabilities` / `memory_enabled`
- 内置工具 `view_reference_image`：让对话中的 LLM 自查当前角色的形象参考图（头像或自定义参考图）。通过 `pending_images` + `[图片 ID:xxx]` 占位符的统一通道注册，再让 LLM 用已有的 `recognize_image` 能力适配器读取图片内容——避开 OpenAI / Gemini 工具结果会把图片摊平为占位文本、以及 Anthropic 通道会把参考图作为新图二次推送给用户的问题；当生图功能关闭或角色无可用参考图时，自动从工具列表中过滤
- `generate_image` 新增 `use_reference_image` 参数：纯风景 / 物品 / 食物等不需要出现人物的画面，AI 可在调用时主动传 `false` 跳过角色形象参考图；用户在角色配置里设为 `ref_mode=none` 时本参数无效（不会被反向打开）
- 插件 MCP 访问（`ctx.mcp`）：新增 `list_servers()` / `list_tools()` / `call_tool(name, arguments)`，按声明的权限分别需要 `mcp.read`（列表）和 `mcp.invoke`（调用）；工具执行失败通常不抛异常，而是以文本内容块返回（服务器不存在、事件循环未运行、超时与执行异常的文案各不相同），与 LLM tool_use 路径同语义
- 插件发布 in-process LLM 工具（`ctx.mcp.register_tool`）：插件可注册命名空间为 `plugin_<id>__<name>` 的工具，与 MCP-server 工具和内置能力并列出现在 LLM 工具列表与 MCP 概览页 / 插件详情页；生命周期跟随插件，disable / reload / 加载失败时自动反注册。新增权限 `mcp.publish`
- 插件文件消息支持：`ctx.messaging.send_message` 新增 `files` 参数（`[{"path": "...", "name": "...", "mime": "..."}]`），可推送非图片文件（doc / pdf / zip 等）。微信通道会先复制文件到 `data/chats/<persona>/files/<随机前缀>__<原名>` 以保证 Web 预览可用，再走新的 CDN 上传链路（`transport/cdn.upload_file`、`transport/sender.send_file`、`ILinkClient.build_file_message`，沿用图片相同的 AES-ECB 加密 + 重试上限 3 次）
- 插件 LLM 复用角色绑定：`ctx.llm` 新增 `chat_as_persona(persona_id, messages, ...)` 复用角色绑定的 provider / model / temperature / max_tokens，每次调用重读 persona 配置；新增 `list_providers()` 列出已注册 provider 名、`get_persona_binding(persona_id)` 返回角色当前绑定快照
- `LLMResponse` 新增 `reasoning_content` 字段；OpenAI 兼容渠道在 tool_use 多轮循环中回传 `reasoning_content` 给上游，避免 DeepSeek-v4 / o1 风格代理在 thinking-mode 模型上拒绝继续请求
- `/api/mcp/tools` 现在为每个工具返回 `owner` 标签（`builtin` / `plugin:<id>` / `mcp:<server>` / `""` 表示来自 `capability_adapters` 配置项），前端据此对来自插件 / 内置的工具隐藏编辑与删除入口

### 修复
- 修复 MCP stdio 启动失败：原路径启发式把任何含 `/` 的字符串当作本地路径并重写到 `APP_HOME`，导致 npm scoped 包名 (`@scope/name`)、`--key=value` 标志、`https://` / `file://` URL 被破坏，`npx` 启动的官方 MCP 服务器（如 `@playwright/mcp`）以 ENOENT 失败、被 SDK 包装为 `Connection closed`。收紧规则：仅显式相对路径前缀 (`./` / `../`)、绝对路径或已知路径后缀（`.py` / `.exe` / `.sh` 等）会被解析为路径
- 修复 MCP 连接生命周期：原先用手工 `__aenter__` / `__aexit__` 栈，anyio 任务组的 enter 与 exit 跨 asyncio task 执行（每次 `run_coroutine_threadsafe` 都是新 task），SDK 仅以 DEBUG 日志吞掉失败、实际清理交给 asyncgen GC。改为一个长存的 `_lifecycle_task` 在同一 task 内持有 transport + `ClientSession` 上下文，断开时通过 `_shutdown_event` 在限时窗口内优雅退出，必要时再 cancel
- 修复 MCP 工具结果中的图片丢失：MCP 服务器可能以三种形式返回图片（`ImageContent` 块 / `EmbeddedResource` / `TextContent` 内嵌 `data:image/...;base64,...` URI 或 markdown 包装的同 URI），新增 `services/mcp_image_extractor.py` 统一识别并落盘到 `data/chats/<persona_id>/images/mcp_*.<ext>`，再以独立 assistant 消息分发；带格式嗅探（PNG / JPEG / GIF / WebP / BMP）、单图 ≤20MB、单次工具调用最多 8 张、目录 resolve 后强校验不能逃出 `chats/`；`generate_image` 等会自行注册出站图片的工具不再被二次抽取
- 修复 OpenAI 兼容渠道偶发 SSE 误返：部分中继（个别 grok 代理等）在 `stream=False` 时仍返回 `text/event-stream`，原先直接报格式错误。新增 `_looks_like_sse_stream` + `_parse_sse_completion`，按行重组 `data:` 切片为单个 `LLMResponse`（含文本、tool_calls、`reasoning_content`，并尊重 `finish_reason`）
- 修复朋友圈刷新按钮在 feed 生成中无可视反馈：刷新图标在 `is_generating=true` 时持续转圈，状态来源于 `/api/moments/state`

### 内部
- 新增模块：`pawzochat/services/moments.py`、`pawzochat/store/moments.py`、`pawzochat/web/routes/api_moments.py`、`pawzochat/web/static/modules/moments.js`、`pawzochat/utils/profile.py`、`pawzochat/services/mcp_image_extractor.py`、`pawzochat/mcp/builtin/view_reference_image.py`
- 新增路径常量：`MOMENTS_DIR` / `MOMENTS_IMAGES_DIR` / `MOMENTS_STORE_PATH`
- `ConfigManager` 默认结构新增 `moments` 节（`publishers` / `repliers` / `reply_probabilities` / `memory_enabled` / `prompts.post` / `prompts.reply`）
- 新增路由：`GET/POST /api/moments`、`GET/DELETE /api/moments/<id>`、`POST/DELETE /api/moments/<id>/like`、`POST /api/moments/<id>/replies`、`DELETE /api/moments/<id>/replies/<rid>`、`POST /api/moments/refresh`、`GET /api/moments/state`、`GET/PUT /api/moments/settings`、`GET/POST/DELETE /api/moments/cover`、`GET /api/moments/images/<id>/<filename>`
- `CapabilityAdapterRegistry` 由「内置 vs 配置」二分改为 owner 标签三态（`""` 配置项可重载、`builtin` 程序内置保留、`plugin:<id>` 插件保留），`register(adapter, owner=...)` 与 `unregister_owner(prefix)` 配套；`reload(adapters_cfg)` 只清理空 owner 的条目
- `MemoryService._load_profile_name` 抽离为 `pawzochat/utils/profile.py.load_profile_name()` 单一来源
- 插件 API 扩展：`PluginContext` 新增 `mcp` 字段；`MCPFacade` 新增 `register_tool(name, description, parameters, handler)`（命名空间由宿主固定生成）；`ExtensionManager` 通过 `set_capability_registry()` 在 `start()` 之前注入注册表，并在插件 disable / reload / 加载失败时调用 `_unregister_plugin_tools()` 清理；`KNOWN_PERMISSIONS` 新增 `mcp.publish`
- `MessagingFacade._normalize_files` / `_persist_files_for_persona` 负责文件块校验、复制和 `text/image/file` 三类内容块的合并构建
- `services/chat.py` 工具调用循环新增 MCP 图片回收阶段；`_build_tools` 顺序调整为先按 policy 过滤、再按生图开关过滤、最后按参考图可用性过滤 `view_reference_image`；`_build_image_tool_guidance` 接受 `active_tool_names` 仅注入实际暴露给本轮的工具的提示词
- 移除 MCP `list_resources` / `list_prompts` 未使用桩函数与 `manager` 内冗余的聚合任务包装

## [0.1.6] - 2026-05-08

### 新增
- 角色生图功能：新增独立的生图服务商体系（`pawzochat/image/`），支持四类后端——PawAPI（推荐，OpenAI/Gemini 双协议直连）、OpenAI `/images/generations`、Google Gemini（NanoBanana / `generateContent` 与 chat 模式两种协议）、NovelAI v3/v4；服务商分别管理 API Key、模型列表与端点路径，配置入口位于「设置 → 生图服务商」
- 角色级生图配置：每个角色可独立开关生图，绑定服务商/模型，配置「画面风格」（`art_style`）、「场景前缀」（`style_prefix`）、「负面提示词」（`negative_prompt`，可整体开关）、参考图模式（`avatar` / `custom` / `none`）；长 prompt 字段（`style_prefix` / `art_style` / `negative_prompt`）写入 `data/prompts/<persona_id>.json`，`config.yaml` 仅保留索引元数据
- 角色自定义形象图：可在角色编辑页上传一张独立于头像的「形象参考图」，作为 `ref_mode=custom` 的参考输入；导入/导出角色卡时随 PawzoChat 原生包一起往返
- 内建生图工具 `generate_image`：作为内建 MCP 工具集成，自动随生图开关挂载到 LLM 工具列表；返回值同时包含 `ContentBlock(type="image")`（供多模态模型在下一轮自我描述）和文本 fallback（兼容会把工具结果摊平为文本的 OpenAI/Gemini 通道）；图片落盘到 `data/chats/<persona_id>/images/gen_*.png` 并以独立 assistant 消息分发
- NovelAI v4/v4.5 兼容：v4 系列不再附带 v3 才支持的 Vibe Transfer / `reference_image_multiple` 字段（上游会 500），同时尺寸自动吸附到普通安全预设（1024×1024 / 1216×832 / 832×1216），避免 LLM 任意尺寸触发付费档或失败
- 插件主动消息推送：新增 `ctx.messaging.send_message(persona_id, channel, text, images)` facade，需在 `plugin.yaml` 声明 `messaging.send` 权限；微信通道自动检查群聊/`user_id`/openclaw 23 小时安全窗口，复用主动消息互斥锁，不会与正在进行的 LLM 轮次交错
- 插件自定义配置 UI：`plugin.yaml` 可声明 `config_ui` 元数据，宿主在沙箱 iframe 中加载插件根目录下 `ui/` 的静态资源；新增路由 `GET /api/plugins/<plugin_id>/ui/<path>`（仅本地、强制 `Cache-Control: no-store`，`send_from_directory` + 路径包含校验防止 zip slip / 符号链接逃逸）
- 主题导入导出：单个或多个 CSS 主题打包为 PawzoChat 原生 zip（`<名称>_theme_pawzochat.zip` / `themes_pawzochat.zip`，含 `manifest.json`），上传大小、单包数量与解压总量均有上限，导入命名冲突自动追加 `_2`、`_3` 后缀；批量导入返回部分失败明细，UI 整体提示
- 模型预设新增：OpenAI 渠道补齐 GPT-5.5 / 5.5 Pro / 5.2 / 5 / 5 Mini / 5 Nano；PawAPI 渠道升级 GPT-5.5、新增豆包 Seed 2.0 Pro（256K 上下文 / 128K 输出）；新增图片模型预设 Nano Banana 2 / Pro、GPT Image 2 / 1.5、NAI Diffusion v4.5 Full/Curated 等
- 顶栏多选模式重构：历史消息编辑、主题选择等多选场景改用 `setTopBar` 的左侧 slot 上下文顶栏，竖屏下不再出现标题与按钮重叠；世界书编辑、角色详情、主题顶栏的文字按钮 padding 收紧，相邻按钮间距更合理
- 会话列表预览补全：图片/文件类最后一条消息现在显示「[图片]」「[文件]」标签，与既有的 emoji 处理一致

### 变更
- iLink 协议升级到 2.4.1：`CHANNEL_VERSION` / `ILINK_APP_CLIENT_VERSION` 同步更新，请求头与上游 `@tencent-weixin/openclaw-weixin@2.4.1` 对齐
- 快速配置打通生图：第二步增加「启用生图功能」开关，PawAPI 已配置且有可用模型时默认开启，使用 `gemini-3.1-flash-image-preview`（Nano Banana 2）作为默认模型；未配置 PawAPI 时开关禁用并提示去「设置 → 生图服务商」手动配置；提示词文案改为「PawAPI 对话/生图服务商和 MCP 功能已启用」
- 模型预设清理：OpenAI 移除 `o3` / `o4-mini`，DeepSeek 移除 `deepseek-v3.2` / `deepseek-v4-flash`（PawAPI 渠道同步），按 GPT-5.x / GPT-4.x / GPT-4o 分组重新整理顺序与注释
- 生图相关的角色卡导出/导入：PawzoChat 原生包随包携带 `image_generation` 配置与自定义参考图（如有）；SillyTavern 互转时保留可映射字段、丢弃专有字段并在 UI 提示

### 修复
- 配置文件原子写入与崩溃恢复：`save()` 改为先写 `config.yaml.tmp` 并 `fsync` 后再 `os.replace`，每次成功保存同时刷新 `config.yaml.bak`；启动时若主文件为空/损坏自动隔离为 `config.invalid-<reason>-<时间戳>.yaml`，并尝试从 `.bak` 恢复，再不行才回落默认配置——避免「断电/磁盘满后下次启动配置被默认值覆盖」
- Safari 上 `<select>` 与 `<input type="time">` 在右对齐布局中实际仍左对齐：补齐 `text-align-last` 并对 `time` 输入做内边距修正，与其他输入控件视觉对齐
- 修复角色卡导入/导出过程中自定义形象图丢失：`bundle.py` / `persona_card.py` 在打包时显式纳入 `data/chats/<id>/image_ref.<ext>`，导入侧落盘后再回填 `image_generation.custom_ref_filename`

### 内部
- 新增模块：`pawzochat/image/{base.py,manager.py,reference.py}` 与 `pawzochat/image/providers/{openai_image.py,gemini_image.py,gemini_chat_image.py,novelai_image.py}`、`pawzochat/mcp/builtin/image_generation.py`、`pawzochat/web/routes/api_image_providers.py`
- 扩展插件 API：`pawzochat/core/extensions/api.py` 新增 `MessagingFacade`，`ExtensionManager` 暴露 `get_plugin_ui_root(plugin_id)`，`PluginManifest` 新增 `config_ui` 字段
- 新增路径/路由：`POST/GET /api/image-providers/...`（CRUD + 测试生成 + 拉取模型）、`POST /api/personas/<id>/image_ref` 与 `DELETE`、`GET /api/themes/_export`、`POST /api/themes/_import`、`GET /api/plugins/<id>/ui/<path>`
- `transport/models.py` 新增 `normalize_image_generation()`，`PROACTIVE_DEFAULTS` 等保持单一来源；`ConfigManager` 拆出 `_load_image_prompt_overrides` / `save_image_prompt_parts`，`save_prompt_parts` 改为合并保留已有 `image_*` 字段
- `services/chat.py` 重构上下文构建与工具调用循环以接入生图工具及 `generated_images` 出站序列；`mcp/adapters.py` 增强能力适配以同时承载生图工具与已有 MCP 工具

## [0.1.5] - 2026-04-28

### 新增
- 表情包导入导出：单个表情包可导出为 PawzoChat 原生 zip（`<名称>_emoji_pawzochat.zip`，含 `manifest.json` + `emotions/<情绪>/<图片>` 目录结构），可从设置页导入；导入名称冲突时自动追加 `_2`、`_3` 后缀，不覆盖现有分组
- 世界书条目开关：每本世界书的小节可单独启用/禁用，禁用的小节即使关键词命中也不会注入；新字段 `section_meta: {<小节>: {enabled: bool}}` 与 `content` 同步维护，旧世界书与新增小节默认开启
- 主动遥测开关：默认采集匿名 UUID（本地随机生成，不来自硬件）、应用版本与操作系统类型，30 分钟心跳一次；上传地址、网站 ID、心跳间隔为代码常量，不写入 `config.yaml`；从源码运行时默认禁用（设置 `PAWZOCHAT_TELEMETRY_DEV=1` 可开启用于本地测试），任何时候可在网页面板关闭，立即生效无需重启；匿名 ID 同时写入用户级 AppData 与项目 `data/` 目录，重装/迁移可保留同一 ID
- 历史消息编辑多选：顶栏「多选」进入选择模式，跨日期累计选择，支持「删除所选 (n)」批量删除，全选/部分选状态在日期切换时正确恢复
- 自更新支持阿里云 OSS：先尝试 `pawzochat-release.oss-cn-shanghai.aliyuncs.com/channels/stable/latest.json`，失败时回退到 GitHub Releases；GitHub 镜像仅对 `api.github.com` / `github.com` 启用，OSS 直连不再被错误拼接镜像前缀；可通过 `PAWZOCHAT_OSS_LATEST_URL` 环境变量覆盖
- 快速配置「导入角色卡」入口：第二步新增「手动创建 / 导入角色卡」Tab，导入路径复用 `/api/personas/_import`，可选是否一并导入卡片内嵌的世界书
- 快速配置与网络设置增加「粘贴」/「复制」按钮，便于在没有右键菜单的环境填入 API Key、令牌等长字段
- 模型预设新增 Claude Opus 4.7、DeepSeek V4 Flash、DeepSeek V4 Pro（DeepSeek 与 PawAPI 渠道同步）；DeepSeek `base_url` 调整为 `https://api.deepseek.com`，`endpoint_path` 改为 `/chat/completions` 单一来源

### 变更
- 历史消息编辑页的「编辑」按钮改用统一的右上角文字按钮样式，与其他页面保持一致
- DeepSeek 渠道预设模型列表移除 `deepseek-chat` / `deepseek-reasoner`，由 V4 系列接替

### 修复
- 表情包分组删除新增并发保护：客户端可携带 `expected_refs` 与 `force=true` 一起请求，服务端检测到引用列表已变化时返回 409，避免「确认对话框列出的角色」与「实际清理的角色」不一致；新增 `GET /api/emoji/groups/<name>/references` 端点供 UI 一次性合并提示
- 表情包导入做了完整安全加固：拒绝加密 zip、单文件 ≤20MB、总解压 ≤200MB、文件数 ≤2000、路径必须是 `emotions/<情绪>/<图片>` 三段式、显式拦截 zip slip（`..` / 绝对路径）；先写入同目录临时文件夹再原子重命名，失败时清理临时目录，不会留下半成品分组

### 内部
- 新增模块：`pawzochat/services/telemetry.py`、`pawzochat/web/routes/api_telemetry.py`
- 新增路径常量：`TELEMETRY_ID_FILE`（OS 用户级）、`TELEMETRY_ID_FALLBACK`（项目内便携副本）
- 新增路由：`GET/POST /api/telemetry`、`POST /api/emoji/_import`、`GET /api/emoji/groups/<name>/_export`、`GET /api/emoji/groups/<name>/references`、`PUT /api/worldbooks/<name>` 接受 `section_meta`

## [0.1.4] - 2026-04-19

### 新增
- 世界书系统：独立管理"全局 / 选中角色"两种作用域的世界书，支持关键词匹配触发；每本书可包含多个命名小节，角色对话时按作用域和关键词注入上下文
- 世界书与角色的双向绑定：在世界书编辑页按角色勾选绑定，或在角色编辑页挑选要携带的世界书；任一侧保存都会同步另一侧，删除世界书或角色时自动清理遗留绑定
- 角色卡统一导入导出：通讯录页支持导入 SillyTavern v2/v3 PNG 或 JSON 角色卡，角色详情页可导出为 PawzoChat 原生包（`.zip`，推荐，保留记忆/主动消息/tool_policy 等 PawzoChat 独有字段）、SillyTavern v3 PNG、SillyTavern v3 JSON
- 世界书导出：单本世界书编辑页顶栏新增「导出」按钮（位于「保存」左侧），可选 PawzoChat 原生 JSON 或 SillyTavern 世界书 JSON（entries 结构）
- SillyTavern 角色卡内嵌 `character_book` 自动创建为独立世界书并绑定到新导入的角色
- PawzoChat 角色导出为 SillyTavern 格式时，所有绑定世界书合并为一个 `character_book` 随卡片一同分发
- PNG 角色卡同时写入 `ccv3` 与 `chara` 两个 tEXt chunk，v3 与 v2 客户端都能识别

### 修复
- 对话设置 / 回复设置保存成功后前端立即以服务端返回值刷新表单，不再显示旧值

### 兼容性说明
- SillyTavern 卡片的 `first_mes`（开场白）与 `alternate_greetings`（备选问候语）在导入时丢弃，UI 会弹窗提示（PawzoChat 当前没有开场白概念）
- SillyTavern 世界书的 per-entry `selective` / `order` / `position` / `depth` / `probability` / `keysecondary` / `match_*` 等"PawzoChat UI 无法编辑"的字段通过 `extras.sillytavern` 完整往返；而 `key` / `constant` 由 PawzoChat 的 scope/keywords 作唯一权威，导出时始终反映当前本地设置（不会被历史 ST 值覆盖）
- 角色导入、世界书导入、角色卡内嵌世界书导入三条路径共用同一套解析实现（`card_parser.decode_card_json` + `persona_card.character_book_to_worldbook`），对 UTF-8 BOM / GBK / 排序键 / 键名回退等细节行为一致
- 新增模块：`pawzochat/services/worldbook.py`、`pawzochat/services/card_parser.py`、`pawzochat/services/persona_card.py`、`pawzochat/services/bundle.py`
- 新增路由：`/api/worldbooks` CRUD、`POST /api/personas/_import`、`GET /api/personas/<id>/_export`、`GET /api/worldbooks/<name>/_export`

## [0.1.3] - 2026-04-11

### 新增
- 自定义主题系统：支持浅色/深色/跟随系统三种外观模式，可创建多个自定义 CSS 主题并按顺序叠加；主题以文件夹形式存储在 `data/theme/<名称>/style.css`，方便手动管理和分享；内置"樱花粉""深海蓝"两个演示主题
- 主动消息功能：按角色配置空闲触发器，支持随机区间、连续上限、静默时段、失败冷却与自动禁用；已绑定微信走微信通道，未绑定走网页 SSE
- 角色编辑页引入"详情/人设"子 Tab，详情页新增"主动消息"配置卡片
- `utils/llm_json.py` 统一 LLM JSON 解析，支持围栏剥离、大括号匹配、转义修复、尾部逗号容错、Windows 换行归一化
- 记忆总结/合并失败时自动重试（最多 3 次），`max_tokens` 提升至 2000
- SSE 按角色跟踪处理状态，切换到正在处理的会话时立即显示输入指示器

### 变更
- 设置页图标颜色从内联样式改为语义 CSS class（`.green`、`.orange` 等），通过 CSS 变量统一管理，深色模式自动适配
- `extra_hint` 注入格式改为"内部系统指令"措辞，降低被模型回显的风险
- `PROACTIVE_DEFAULTS` 集中到 `transport/models.py` 作为单一源

### 修复
- 消息队列处理完成后不再重置 `last_message_time`，修复待处理消息被延迟一个完整等待窗口的问题
- `ConfigManager` 新增 `RLock`，`api_personas` CRUD 改为 `with config.lock:` 包裹，消除并发写 YAML 导致的字段丢失
- `reply_dispatcher` 仅在通道真正接受时 append stored，主动消息失败重试机制得以生效
- 主动消息冷启动 anchor 从"用户最后消息时间"起算，不再被推迟整个 `wait_seconds`
- `updater.py` 解压 chmod 改用提取后的权限位，避免 Windows 上写权限丢失
- WeChat 通道惰性回填 `user_id` / `chat_type` 到 `conversation.json`

## [0.1.2] - 2026-04-06

### 新增
- CDN 图片上传：支持服务端返回的 `upload_full_url`（新格式），旧的 `upload_param` 作为回退
- 发送消息的 `client_id` 追加随机后缀，避免同一毫秒内连发多条消息出现 ID 冲突
- 聊天记录中的图片/表情包点击后弹出应用内全屏预览窗口，带下载按钮可触发浏览器下载，不再直接跳转打开图片 URL（聊天窗口与历史消息编辑页均生效）

### 变更
- 记忆摘要/合并提示词重写为第一人称视角，生成的记忆读起来像"我"的私人回忆而非第三人称会议纪要
- `ILinkClient.get_qrcode` 移除客户端超时，与上游 iLink 2.1.4 去除 AbortController 的行为对齐

### 内部
- 移除 `cdn.download_media`、`_aes_ecb_padded_size` 等无调用方的死代码

## [0.1.1] - 2026-04-05

### 新增
- 模型管理：支持从 OpenAI 兼容 API 拉取远程模型列表并批量导入
- 模型管理：支持编辑已有模型的 ID、名称、能力标记等属性
- 模型管理：拉取模型时根据名称自动标记能力（GPT/Claude/Gemini 标记视觉+工具调用，DeepSeek 标记工具调用）
- QR 登录：支持 IDC 重定向（`scaned_but_redirect`），自动切换轮询地址
- QR 登录：二维码过期后自动刷新（最多 3 次）

### 变更
- 升级 iLink 协议版本至 2.1.6，请求携带 `iLink-App-Id` / `iLink-App-ClientVersion` 头
- 角色详情页"编辑"按钮移至顶栏

### 修复
- 公网面板 QR 轮询未跟随 IDC 重定向的问题

## [0.1.0] - 2026-04-02

- 初始版本
