# 09：自托管可选 SMTP 与邮件通知技术规格

- 状态：Draft
- 日期：2026-08-11
- 适用形态：`self-hosted`
- 前置依赖：[00 共享部署策略与能力基础](00-shared-foundation.md)
- 使用方：[08 邀请注册](08-self-hosted-invitations.md)、可选邮箱验证/找回、安全通知、备份失败和升级通知
- 交付结果：配置 SMTP 时获得可靠邮件；未配置或临时故障时同步和基本账号管理仍可用

## 1. 目标

- 实现计划 00 所定义 `MailProvider` 的 SMTP adapter。
- 使用持久 outbox、幂等状态转换、at-least-once SMTP 投递、有限重试和 dead-letter，不在 HTTP 请求中同步等待 SMTP。
- 支持 STARTTLS/SMTPS、认证、连接超时、证书验证和常见自建 relay。
- 管理后台显示脱敏配置、健康状态、队列和测试邮件。
- 明确哪些功能在 SMTP 关闭时降级，不让用户进入无法完成的邮箱流程。
- 模板版本化并支持至少中文和英文纯文本/HTML。

## 2. 非目标

- 不内置 SMTP server、DKIM 签名器、邮件营销或群发系统。
- 不保存邮箱账号密码到数据库管理页面；一期只从 secret/environment 读取。
- 不保证普通 SMTP 能提供可靠 bounce/complaint Webhook。
- 不因一次 EHLO/投递失败让 `/health/ready` 关闭同步服务。

## 3. 配置

建议新增：

```text
MAIL_DRIVER=disabled|smtp
MAIL_FROM_ADDRESS=
MAIL_FROM_NAME=NoteGen
MAIL_REPLY_TO=
MAIL_DEFAULT_LOCALE=zh-CN

SMTP_HOST=
SMTP_PORT=587
SMTP_TLS_MODE=starttls-required|starttls|tls|none
SMTP_USERNAME=
SMTP_PASSWORD=
SMTP_CONNECT_TIMEOUT_MS=10000
SMTP_COMMAND_TIMEOUT_MS=15000
SMTP_POOL_SIZE=2
SMTP_MAX_MESSAGES_PER_CONNECTION=100
SMTP_TLS_REJECT_UNAUTHORIZED=true
```

规则：

- `MAIL_DRIVER=disabled` 是 self-hosted 默认，SMTP 其他字段可为空。
- 启用 smtp 时 host、port、from 必填；username/password 必须同时有或同时无。
- `tls` 用于隐式 TLS，`starttls-required` 拒绝不支持升级的 server；`starttls` 只用于受信内网兼容并显示警告。
- 生产 `none` 或关闭证书验证需要单独 `ALLOW_INSECURE_SMTP=true`，管理员页面持续显示高风险警告；不得成为示例默认值。
- 密码进入日志 redaction，管理 API 只返回 `configured: true`，不返回长度或值。
- `.env`/secret 不进入普通实例备份；manifest 只记录 driver、非秘密配置 revision、from domain 与“恢复后需重新配置”的说明，不记录可用于离线猜测弱 SMTP 密码的 secret fingerprint。

## 4. 投递流程

1. 业务事务写 `outbox_messages`，recipient 在受控列或独立加密 payload 中保存。
2. Worker 领取 lease，解密受限 payload，渲染固定模板，校验 headers/recipient，并用 outbox ID 生成稳定 RFC `Message-ID`。
3. SMTP adapter 发送并记录远端 response/message ID（若有）。
4. 成功标 sent；临时失败计算 next attempt；永久失败 dead-letter。远端可能已接受但连接/进程在本地提交前中断时标 `delivery_unknown`。
5. HTTP 请求只返回业务状态或 queued，不等待远端 SMTP。

错误分类：

- 4xx transient、连接/超时/DNS：重试。
- 明确 mailbox unavailable/recipient syntax：永久失败。
- 认证/证书/from rejected：配置错误，快速熔断并告警；相同配置未变化前降低重试频率。
- 不明确响应进入 `delivery_unknown`；按模板风险使用有限重试，接受可能重复，不无限重投安全邮件。

退避建议从 1 分钟开始，带抖动，逐步到 1 小时；安全 token 邮件不得在 token 过期后继续发送，handler 发送前检查业务 token 仍有效。SMTP 不支持通用幂等键，因此“远端接受成功、本地 sent 未提交”的重复不可完全消除；模板必须重复安全、action token 消费幂等，并提示忽略旧邮件。

## 5. 模板与安全

一期模板：

- invitation-created / invitation-replaced（重发会轮换 token）
- email-verification
- password-reset
- email-changed / password-changed / new-device / device-revoked
- backup-failed（管理员）
- upgrade-available/security-update（管理员，可关闭）

要求：

- 模板 ID 和 version 进入 outbox，发布后旧任务仍可渲染兼容版本或安全作废。
- MIME/header/body 有明确大小上限；recipient/正文/secret payload 使用独立 keyring 加密并按模板保留期清理，轮换先双读后切 writer。
- subject/from/to/reply-to 禁止 CR/LF 注入；显示名称做编码。
- 所有 action URL 来自验证过的 `WEB_PUBLIC_BASE_URL`，不接受请求 Host 拼接生产链接。
- 安全邮件不加入远程图片、第三方 tracking pixel 或可泄露 token 的链接重写。
- HTML 与纯文本语义一致，内容可国际化；不要在邮件中发送密码、同步口令、恢复密钥或完整诊断。

## 6. 健康检查与能力

SMTP 状态分为：

- disabled：能力关闭，实例正常。
- configured/unknown：启动配置合法，尚未探测。
- healthy：最近 EHLO/真实投递成功。
- degraded：短期连接/投递失败，队列重试。
- misconfigured：认证、TLS、from 等永久错误。

`/health/ready` 对 self-hosted 不因 degraded/misconfigured 失败；`/v1/capabilities` 中传输无关的 `mail.delivery` 在 provider configured 时保持稳定，`operations.smtpAdmin` 只表示 self-hosted 管理员状态/测试/队列入口可用，不代表可在页面读取或修改 secret。管理员 operational status 单独显示健康状态。依赖邮件完成的具体流程在 misconfigured 时：

- 已生成可复制邀请仍可用。
- UI 可隐藏新邮箱验证/找回入口；公开 password-reset request 为防枚举仍对存在/不存在邮箱、邮件故障统一返回 202，只在管理员状态/内部 job 显示投递不可用。不能创建会永久卡死的 hosted-style pending 账号。
- 安全通知失败不回滚密码修改/设备撤销，但必须告警。

不要每次 readiness 请求都连接 SMTP。后台每 5～15 分钟探测，或以最近发送结果更新状态。

## 7. 管理 API 与 Web

```text
GET  /v1/web/admin/mail/status
POST /v1/web/admin/mail/test
GET  /v1/web/admin/mail/outbox?status=...
POST /v1/web/admin/mail/outbox/:id/retry
POST /v1/web/admin/mail/outbox/:id/cancel
```

测试邮件：

- 只允许 admin + CSRF + 计划 00 step-up。启用 email identity 时可默认当前 verified 管理员邮箱；纯用户名实例由已 step-up 管理员显式输入测试地址，不假设字段存在。
- 使用 outbox，而非绕过队列直接发送。
- 有独立限流和审计。
- UI 显示 accepted/queued/sent/failed，不把 SMTP 原始响应无过滤展示给浏览器。

dead-letter 页面显示模板、掩码 recipient、attempt、分类错误、时间和 request/job ID；不显示 action token 或正文。

## 8. 自托管无邮件恢复边界

未配置 SMTP 时：

- 用户名/密码登录和浏览器设备授权继续可用。
- 邀请由管理员复制链接。
- 不显示“忘记密码会发邮件”。本机密码重置 CLI/action token、credential epoch 与 Session 撤销属于计划 01 identity/recovery core 的可选 self-hosted 切片；未完成该切片时本计划不凭空提供恢复命令。
- 邮箱 identity 若启用但投递关闭，默认保持 unverified/仅展示地址。部署者线下核验只能记录独立 `operator_attested` + step-up/audit，不等同邮件 possession verification，也不能自动启用密码找回。

页面必须说明部署者负责邮件交付，不能暗示 NoteGen 官方可代为找回自托管账号。

## 9. 指标与告警

- `mail_outbox_total{status,template_family}`
- queue depth/oldest age、send latency、attempts。
- SMTP connection/auth/TLS/permanent/transient errors。
- circuit breaker state、test mail result。

禁止 recipient、domain（除非低基数自有 from domain）、subject 或 message ID 作为公开指标 label。告警：队列最老任务超过阈值、持续认证/TLS失败、dead-letter 增长、验证邮件过期前未发送。

## 10. 建议 PR 切片

1. **PR-09A：SMTP Config + Adapter。** TLS/认证/timeout、secret redaction、单元 fake transport。
2. **PR-09B：Outbox Worker。** lease、稳定 Message-ID、错误分类、`delivery_unknown`、退避、dead-letter、token 过期检查。
3. **PR-09C：模板。** i18n、HTML/text、安全 URL 和 header 校验。
4. **PR-09D：Admin Status/Test。** 掩码状态、测试、队列查询/重试、审计。
5. **PR-09E：Feature Integrations。** 邀请、验证/找回、安全、备份/升级通知的降级矩阵。
6. **PR-09F：Runbook。** 常见 provider 配置、TLS、SPF/DKIM/DMARC 提示和排障。

## 11. 测试矩阵

- disabled、无认证 relay、STARTTLS、SMTPS、认证失败、证书失败、超时。
- 两 worker 不同时持有有效 lease；发送成功后进程退出进入 at-least-once/`delivery_unknown`，重复邮件安全且不会重复业务消费。
- 4xx/5xx SMTP 分类、max attempts、dead-letter 与人工重试。
- token 到期/撤销后待发送邮件被 cancel，不发送无效链接。
- header injection、恶意显示名、外部 Host、模板变量转义。
- 日志、管理 API、备份均不包含 SMTP 密码、action token 或完整正文。
- SMTP 故障期间同步、登录、复制邀请和数据导出仍工作。
- password-reset request 在地址不存在、SMTP disabled/misconfigured 时外部响应不可区分。

## 12. 上线、回滚与验收

先以内部 relay 和 test template 运行；再启用管理员通知；最后启用邀请/验证/找回。每类模板用独立 capability/配置逐项打开。

回滚将 `MAIL_DRIVER=disabled` 并停止 worker；保留 outbox，安全 token 任务按过期清理。不要让旧进程继续领取新模板类型。

验收条件：配置正确时邮件可恢复投递；错误时管理者能定位且不泄密；未配置时实例完全可用并提供明确替代路径；任何业务请求不因 SMTP 慢而阻塞。

## 13. 开放问题

- 是否支持运行时数据库配置 SMTP；一期建议不做，避免秘密加密/权限/备份复杂度。
- 是否需要 DSN/bounce mailbox；一期根据自托管需求再评估，不能假定所有 SMTP provider 支持 Webhook。
