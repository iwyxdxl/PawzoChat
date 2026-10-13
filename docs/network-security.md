# 本地面板 / 公网面板访问与安全模型

> 术语约定：本文使用“本地面板”表示仅绑定 `127.0.0.1` 的 HTTP 服务，使用“公网面板”表示绑定 `0.0.0.0` 的 HTTPS 服务。

## 双服务实例

PawzoChat 启动时最多创建两个 Cheroot WSGI Server，二者共享同一个 Flask 应用和运行时数据：

| | 本地面板 | 公网面板 |
| --- | --- | --- |
| 绑定地址 | `127.0.0.1:web.port` | `0.0.0.0:web.public_port` |
| 协议 | HTTP | HTTPS（自签名证书） |
| 启动条件 | 始终启动 | `public_enabled=true`，且密码、端口、路径前缀均有效 |
| 登录 | 免登录 | 必须通过密码登录 |

更改公网开关、端口、路径或密码后，需要重启 PawzoChat 才能重建监听实例并完整生效。清空密码会同时把 `public_enabled` 设为 `false`。

> 重要：清空密码后应立即重启。当前进程不会动态停止已经运行的公网 Server，而认证中间件会立即读到空密码；因此在重启前，原公网 URL 仍可能继续可达且不再要求登录。单纯关闭 `public_enabled` 也要重启后才会停止监听。

## 公网路径前缀

本地和公网 URL 结构不同：

```text
本地：http://127.0.0.1:62000/api/settings
公网：https://<IP>:38271/aB3xK9mQ2pLw/api/settings
                         └─ public_secret ─┘
```

公网 Server 由 `SecretPrefixMiddleware` 包装：

1. 请求路径必须等于 `/<public_secret>` 或以 `/<public_secret>/` 开头，否则返回 404。
2. 中间件剥离前缀，并设置 `SCRIPT_NAME=/<public_secret>`。
3. 在 WSGI environ 中设置 `pawzochat.is_public=True`，供认证、中间件和路由判断来源。

Flask 内部仍只定义 `/api/settings` 等普通路由。模板使用 `request.script_root`，前端使用 `window.PAWZOCHAT_BASE` 自动补前缀：

```javascript
const base = window.PAWZOCHAT_BASE || "";
fetch(`${base}/api/settings`);
```

后端不得通过客户端 IP 或端口猜测来源，应统一读取：

```python
is_public = request.environ.get("pawzochat.is_public", False)
```

## 登录与会话

公网请求的认证流程：

```text
请求进入
  ├─ 公网端点已锁定 → 403（此时不再检查路径前缀）
  ├─ 路径前缀不匹配 → 404
  ├─ /login、/static/style.css、/static/logo.png → 免登录
  ├─ 插件签名静态资源 GET/HEAD → 验证资源令牌后只读放行
  ├─ session.authenticated=true → 放行
  ├─ /api/* → 401 JSON
  └─ 其他页面 → 重定向 /login
```

登录页使用随机 CSRF Token。登录成功后的 Session 有效期为 24 小时；应用重启会更换 Flask Session 密钥，因此现有 Session 同时失效。Cookie 名为 `pawzochat_session`，并设置 `HttpOnly`、`SameSite=Lax`；启用公网模式时还设置 `Secure`。

修改密码不会主动撤销已经认证的 Session；需要立即使所有既有登录失效时，应重启应用。

本地请求不检查面板密码。这是密码恢复与本机维护入口，也意味着能在本机访问 PawzoChat 进程的用户拥有完整面板权限。

## 密码与暴力破解

新密码必须：

- 至少 8 个字符
- 同时包含大写字母、小写字母和数字

密码使用 PBKDF2-HMAC-SHA256 保存，参数为 60 万次迭代和 16 字节随机盐：

```text
$pbkdf2-sha256$600000$<salt_hex>$<hash_hex>
```

登录只接受上述哈希格式的存储值，不兼容明文密码。未公开开发测试阶段遗留的明文配置可通过本地面板重设密码。

公网连续 5 次密码错误后，`SecretPrefixMiddleware` 会锁定整个公网端点，后续请求统一返回 403。一次成功登录会把失败计数清零；锁定后只能重启程序解锁。该计数是整个公网实例共享的，不是按 IP 分组的限流器。

## 公网写请求防护

除登录表单外，公网的 `POST`、`PUT`、`PATCH`、`DELETE` 请求必须满足同源检查：

- `Origin` 等于当前请求 Origin；或
- `Referer` 的 Origin 等于当前请求 Origin。

二者都不匹配时返回 403。此检查与 `SameSite=Lax` Cookie、登录页 CSRF Token 共同降低跨站请求风险。

进入 Flask 后生成的响应默认带有（路径前缀中间件直接生成的 403/404 不经过这一步）：

- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: same-origin`
- 公网响应额外带 `Content-Security-Policy: frame-ancestors 'none'`

插件配置 iframe 的静态资源响应使用 `X-Frame-Options: SAMEORIGIN` 和 `Content-Security-Policy: frame-ancestors 'self'`，允许本地或公网的同源宿主页面嵌入沙箱 iframe。

## 公网功能限制

即使已登录，公网请求仍有以下硬限制：

- `GET /api/settings` 不返回 `web` 段，不暴露端口、路径和密码状态。
- `PATCH /api/settings` 禁止修改 `web` 段。
- `POST /api/settings/regenerate-public` 禁止重新生成公网端口和路径。
- `/api/update/check|state|download|apply` 仅限本地访问，公网返回 404。
- 插件 URL 预览、安装、取消预览、在线检查更新、升级及任务查询仅限本地，已登录公网访问返回 403。
- 插件安装进度和更新通知 SSE 仅发送给本地连接，公网插件响应也不提供下载管理元数据。
- 前端在公网模式下隐藏网络设置入口及插件安装、在线更新操作。

公网登录后可管理已安装插件，包括查看、修改配置、启停、重载和重新扫描；写请求仍需通过同源检查。插件详情中的配置值（包括标记为 `secret` 的字段）可由已登录用户读取，加载错误的 `last_error` 也可能包含本地文件路径。其他已认证 API 还可修改角色、会话、服务商等数据；公网密码泄露应按完整面板权限泄露处理。

## 本地插件安装请求

本地面板仍免密码登录，但插件安装相关写接口额外检查同源：`/api/plugins/install/preview`、`/api/plugins/install`、`/api/plugins/install/cancel` 和 `/api/plugins/{id}/upgrade` 的请求目标必须是实际本地监听端口上的 `http://127.0.0.1` 或 `http://localhost`，且 `Origin` 必须与目标的协议、主机和端口全部相同。仅在没有 `Origin` 时回退检查 `Referer`；缺失或不匹配返回 403。两种本地主机名不能混用。此限制也适用于脚本调用。

安装确认前只下载和解析候选包，不执行候选插件代码；新装插件默认停用。安装包哈希及可选签名用于完整性和后续来源连续性校验，首次索引自带公钥不独立证明作者身份。插件启用后运行在宿主 Python 进程内，不具备代码沙箱。完整流程见[插件概览](plugins-overview.md#12-url-安装发布与更新)。

## 插件配置面板与资源链接

自定义插件面板继续使用 `sandbox="allow-scripts"`，不授予 `allow-same-origin`。面板通过 `postMessage` 接收初始配置、请求宿主保存配置，不能直接取得宿主页面身份。

插件详情及返回 `plugin` 详情的操作响应包含 `config_ui_url`：未声明自定义面板时为 `null`，本地使用 `/api/plugins/{id}/ui/{entry}`，公网使用包含路径前缀的 `/api/plugins/{id}/ui-assets/{token}/{entry}`。前端直接使用该地址，并在进入详情时重新获取，避免复用过期链接。

公网沙箱内的 JS/CSS 等资源请求可能不携带登录 Cookie，因此签名资源路由支持凭令牌进行 `GET/HEAD` 读取。令牌绑定单个插件，有效期 24 小时；仅可读取已声明 `config_ui` 的插件 `ui/` 目录内文件，不能读取配置或调用管理 API。相对资源路径会保留令牌路径，目录穿越和符号链接逃逸均被拒绝。普通 `/ui/` 路由在公网仍要求登录。

资源令牌使用独立签名用途和当前应用密钥，无效或过期令牌返回 401。应用重启会使令牌失效；退出登录不会撤销已签发的资源链接，它们持续有效至到期或重启。

## 证书、凭据与部署边界

公网证书首次启用时写入：

```text
data/certs/server.crt
data/certs/server.key
```

证书为 PawzoChat 自签名证书，浏览器首次访问通常会显示不受信任警告。它提供传输加密，但不提供公共 CA 身份背书；需要受信任证书、域名或反向代理时，应由部署者在 PawzoChat 外部配置。

`data/config/config.yaml` 中的密码是哈希，但 `public_secret` 不是加密凭据；`data/auth/accounts.json` 还包含通道令牌或 App Secret。应限制整个 `data/` 目录的读取权限，不要把它提交到公开仓库或直接共享。

绑定 `0.0.0.0` 只代表监听所有网卡，不会自动完成防火墙放行、路由器端口转发或云安全组配置。公网暴露前还应确认：

- 使用足够强且唯一的面板密码。
- 公网路径未通过截图、日志或浏览器分享泄露。
- 只开放实际使用的 `public_port`。
- 能接受自签名证书的信任提示，或在外部终止可信 TLS。
- 了解当前只有“连续 5 次失败后全局锁定”，没有按 IP、时间窗口或分布式限流。

## 密码恢复

在运行 PawzoChat 的同一台机器上访问：

```text
http://127.0.0.1:<web.port>
```

进入“设置 → 网络设置”重设密码。本地面板免登录，无需直接编辑配置文件；保存后重启应用。

## 配置

```yaml
web:
  port: 62000
  password: ""             # PBKDF2 哈希；空值表示未设置
  public_enabled: false
  public_port: 0           # 启用时由设置 API 自动生成
  public_secret: ""        # 启用时由设置 API 自动生成
```

相关实现：

- `pawzochat/app.py`：双 Server 启动
- `pawzochat/web/app.py`：路径前缀、认证、同源检查和安全响应头
- `pawzochat/web/routes/api_plugins.py`：插件管理与配置面板静态资源
- `pawzochat/web/routes/api_settings.py`：密码规则与公网设置限制
- `pawzochat/utils/crypto.py`：密码哈希与校验
- `pawzochat/utils/certs.py`：自签名证书生成
