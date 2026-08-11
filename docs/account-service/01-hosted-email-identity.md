# 01：官方托管邮箱身份与账号恢复技术规格

- 状态：Draft
- 日期：2026-08-11
- 默认适用形态：`hosted`
- 可选适用形态：配置邮件投递后的 `self-hosted`
- 前置依赖：[00 共享部署策略与能力基础](00-shared-foundation.md)
- 受影响仓库：`note-gen-server`、`note-gen-server-sync-client`

## 1. 目标

- 以已验证邮箱作为官方托管账号的主登录身份。
- 支持邮箱验证、重发、忘记密码、密码重置和安全换绑。
- 保留已有用户名账号和 `login` API 的迁移兼容。
- 让 NoteGen 客户端优先使用现有浏览器设备授权，不接触邮箱密码和风控挑战。
- 建立可替换的托管邮件驱动和可靠投递语义。
- 拆分 JWT、TOTP 加密、一次性令牌等密码学用途的密钥。
- 明确登录密码恢复绝不恢复 E2EE 同步口令或恢复密钥。

## 2. 非目标

- 一期不实现社交登录、企业 SSO、Passkey 或邮箱魔法链接登录。
- 不把所有历史 `accounts.login` 自动认定为已验证邮箱。
- 不允许支付平台、邮件平台直接创建或删除账号。
- 不在本计划中实现完整风控、订阅或客服工单。

## 3. 当前基线与风险

- `accounts` 只有大小写不敏感的任意 `login`、密码哈希、TOTP 和两个停用时间字段。
- API 和 Web 各有一套注册入口，均可直接创建账号并立即登录。
- 空实例首位有效账号会自动成为全局管理员；hosted 必须先由计划 00 把客户账号管理员策略切换为 `none`，平台 Staff 只能走独立 provisioning。
- `AUTH_SECRET` 同时用于 JWT 签名和 TOTP 静态加密派生，不支持 key ID 或平滑轮换。
- NoteGen 客户端已具备浏览器设备授权，最适合承载 hosted 的验证、MFA、找回和挑战流程。
- 客户端 refresh token 当前保存在普通 Store/localStorage。正式托管前应迁移到系统凭据存储。

## 4. 身份模型

不要直接把 `accounts.login` 改名为 `email`。新增身份表并保留 legacy 字段：

```text
accounts additions
  identity_state enum('pending_verification','active','legacy_migration')
  credential_epoch bigint not null default 0

account_identities
  id uuid pk
  account_id uuid fk accounts
  kind enum('username', 'email')
  identifier text                 -- 原始展示值
  normalized_identifier text      -- 唯一比较值
  is_primary boolean
  verified_at timestamptz nullable
  disabled_at timestamptz nullable
  created_at, updated_at

account_login_claims
  normalized_login_key text pk
  account_id uuid
  identity_id uuid nullable
  kind enum('legacy_username','username','email')
  created_at, released_at, reusable_after nullable

account_login_claim_conflicts
  normalized_login_key text
  candidate_account_id uuid
  candidate_identity_id uuid nullable
  candidate_kind enum('legacy_username','username','email')
  status enum('quarantined','resolved')
  resolution_ref text nullable
  created_at, resolved_at nullable
  primary key(normalized_login_key, candidate_account_id, candidate_kind)

account_action_tokens
  id uuid pk
  account_id uuid nullable
  identity_id uuid nullable
  purpose enum('verify_email', 'reset_password', 'change_email')
  token_key_id text
  token_hash text unique
  target_normalized text nullable
  expires_at, consumed_at, revoked_at
  requested_ip_hash text nullable
  created_at

email_suppressions
  identity_id uuid
  reason enum('hard_bounce','complaint','operator')
  source_event_ref text
  starts_at, cleared_at nullable

mail_webhook_events
  provider text
  provider_event_id text
  status enum('pending','processing','processed','ignored','failed','dead_letter')
  signature_key_id text
  attempts integer
  lease_expires_at, next_attempt_at, processed_at nullable
  payload_encrypted_or_redacted jsonb
  primary key(provider, provider_event_id)

account_security_events
  id bigserial pk
  account_id uuid nullable
  type text
  outcome text
  request_id text
  ip_prefix_hash text nullable
  user_agent_family text nullable
  metadata jsonb
  created_at
```

约束：

- `unique(kind, normalized_identifier)` 仅覆盖未禁用身份；另由 `account_login_claims.normalized_login_key` 建立跨 username/email 的全局登录 namespace。
- 每个账号最多一个有效 primary 身份。
- hosted `active` 账号必须至少有一个 primary、verified email；`pending_verification` 与显式 legacy migration 状态例外。账号生命周期新增 `pending_verification → active`，不能用“所有 hosted 账号都 verified”描述待验证记录。
- 一次性令牌只保存哈希；令牌内容至少 256 bit 随机，不使用 JWT 代替可撤销 token。
- token 的 purpose、账号、目标邮箱和过期时间进入验证上下文，不能跨用途复用；数据库 purpose-specific CHECK 保证 account/identity/target 的必填组合，不允许全空/错用途 FK。

`account_login_claims` 是登录解析的唯一权威索引；认证代码在切换后不得直接查询 identity 或回退 `accounts.login`。所有可登录 identity/legacy login 先抢占共同 claim。既有 `accounts.login` 在 advisory lock + 事务内回填；若 Unicode/casefold 后出现历史冲突，则不为该 key 创建任一偏置 claim，而是把全部候选写入 `account_login_claim_conflicts`，实例保持邮箱注册关闭并进入人工 migration queue。冲突 key 的普通登录统一返回 `identity_ambiguous`，只能由已存在的可信 Session、验证过的恢复通道或审计化人工迁移解决；不能以候选顺序或客户端提供的 `identityKind` 选择账号。

新 API 可 additive 接受 `identityKind` 作为非冲突 key 的显式校验条件；未指定 kind 时也只解析唯一 active claim。解决冲突时必须在一个事务中确认最终归属、创建唯一 claim、标记全部 conflict candidate 已解决并递增相关账号 credential epoch；`accounts.login` 在兼容期仅作为展示/迁移源保留，不能重新成为认证旁路。

Claim 的主键还冻结释放语义：`released_at is null` 才可认证；released 行在 `reusable_after` 前继续保留该 key，但绝不能通过更新 `account_id/identity_id` 原地转让。邮箱换绑、删除或管理员解除 identity 时，在同一账号事务中 disabled identity、撤销相关 action token、递增 credential epoch 并 CAS 标记 claim released；hosted 默认至少保留 30 天安全隔离期，具体保留进入 05 registry。隔离期和法律/安全保留结束后，清理任务先写只含版本化 HMAC key/原因的审计，再物理删除 claim；新主体随后只能通过普通唯一 insert 重新取得。冲突 quarantine 不走这条自动复用路径，必须人工解决。这样 PK、`released_at` 和是否允许复用只有一套语义。

### 4.1 邮箱规范化

一期规则固定为：去除首尾空白、验证基础 RFC 语法、域名转 ASCII/小写；本地部分保留原字符展示，但唯一比较采用 Unicode 规范化后的小写。这是 NoteGen 的账号唯一性产品政策，不是宣称 RFC 中所有邮箱本地部分天然大小写等价；上线前用固定测试向量冻结规则，后续若调整必须显式迁移。不要实现 Gmail 点号、`+tag` 或供应商特有折叠，避免合并两个真实邮箱。

数据库保存原始邮箱和 normalized 值。日志、指标和审计默认只记录不可逆哈希或掩码。

## 5. 账号状态与流程

### 5.1 Hosted 注册

推荐新流程全部发生在账号 Web：

1. 用户提交邮箱和密码。
2. 统一 RegistrationService 执行能力、风险和注册策略判断。
3. 事务中创建普通账号、未验证 email identity、验证 token 和 outbox 邮件；永不授予平台管理员。
4. 返回 `202 registration_pending`，不创建长期设备 session。
5. 用户点击验证链接；服务端在事务中消费 token、标记 verified，并创建 Web Session。
6. 用户回到原设备授权页批准 NoteGen device authorization。

为避免枚举，重复注册已存在邮箱时页面显示同一类提示；只有已登录用户能看到该邮箱实际归属状态。

兼容策略：

- hosted 的 legacy `/v1/auth/register` 对旧客户端保持 `registrationMode=closed`，默认返回 `web_registration_required` 和安全的账号 Web URL。
- self-hosted 仍可使用原 `login` 字段和直接注册流程。
- 请求字段 `login` 在兼容期继续存在；hosted 新 Web 流程可同时接受 `email`，但共享 contract 明确二者映射。

### 5.2 验证与重发

- 默认验证 token 有效期 30 分钟，可配置在 10 分钟至 24 小时范围。
- 同一身份新建 token 时撤销旧 token；多次点击已消费 token 返回幂等成功页，不暴露账号状态。
- 重发按 IP、邮箱哈希和账号三维限流；事务创建 token hash 与计划 00 独立 key 加密的 secret outbox payload。Worker 发送/作废后擦除 plaintext；dead-letter 重发撤销旧 token、生成新 token，不从数据库恢复旧明文。
- 未验证账号仅可登录验证页、退出、重发、改错邮箱和删除待验证账号；不能创建设备、Workspace 或同步数据。
- 待验证账号超过配置天数后由维护任务清理；cleanup 与 verify 锁同一 account/identity 并做状态 CAS，token 刚消费/账号已 active 时不得级联误删。清理前确认无设备/Workspace/同步数据。
- Action link 页面使用 `Referrer-Policy: no-referrer`、`Cache-Control: no-store`、无第三方脚本；消费后清理地址栏/history 中 token。

### 5.3 忘记密码与重置

`POST /v1/web/auth/password-reset/request` 对存在/不存在的邮箱都返回 `202`。存在且允许恢复时创建默认 15 分钟 token 和邮件。

重置成功必须在一个事务中：

- 消费 token 并写入新 Argon2id 哈希。
- 递增 `credential_epoch`/account token-not-before。
- 撤销该账号全部 refresh token 和 Web Session。
- 撤销未完成的其他 password reset token。
- 写安全事件与审计。

Access JWT、refresh、Web Session、设备授权 exchange 都携带/校验 credential epoch；reset 后旧 Access Token 立即失效，不能仅等待 15 分钟。密码登录在 Argon2 校验后锁账号，并确认 password hash/epoch 仍等于刚验证的 snapshot，才签发 Session，关闭“旧密码已验证、reset 后又创建新 Session”的竞态。

随后只创建一个新 Web Session；NoteGen 客户端必须重新通过浏览器授权。页面必须明确：这里只重置账号登录密码，E2EE 工作区仍需要同步口令或恢复密钥。

### 5.4 邮箱换绑

1. 已登录用户执行 step-up：当前密码 + TOTP（若已启用）。
2. 服务端先创建 pending email identity 并取得全局 login claim，再创建 `change_email` token，唯一性保留有数据库约束。
3. 新邮箱验证成功后原子切换 primary；旧邮箱 identity 置 disabled、旧 claim 按 4 节规则进入 released/quarantine 且不再作为 login，不允许直接转给另一账号；仅保留脱敏安全审计并收到通知。
4. 新邮箱与已有账号冲突、token 过期或账号在删除/风控锁定状态时拒绝切换。
5. 一期保留 NoteGen 设备，但撤销全部 Web Session 并要求重新登录；最终 Web Session issuance 与换绑锁同一账号/identity generation，避免换绑后竞态签发旧身份 Session。

### 5.5 Legacy 账号迁移

- 为每个现有账号创建 `username` identity，内容等于 `accounts.login`。
- 只有通过新验证流程的地址才能成为 verified email；看起来像邮箱的 login 也不能自动验证。
- hosted 上线前为 legacy 账号提供一次“补充并验证邮箱”的迁移页。
- 兼容期认证统一查询 `account_login_claims`；legacy login 通过已回填的 `legacy_username` claim 兼容。存在 conflict 记录的 key fail-closed，不查询 identities 或 `accounts.login` 猜测归属。所有新账号同时维护 legacy display login，直到客户端和 Web 完成迁移。
- 不在首个 migration 删除 `accounts.login` 或其唯一索引。

## 6. 邮件投递接口

使用计划 00 定义的 `MailProvider` 和 outbox。Hosted 一期实现一个事务邮件 provider 适配器，但内部身份流程不引用供应商套餐名或 SDK 类型。要求：

- 启动时静态验证 API credential、from address 和公开 URL；启用邮箱身份能力但缺失/格式错误时 `configured=false`，hosted readiness 失败。供应商临时网络故障只标记 `healthy=false` 并由 outbox 重试，不让 readiness 抖动。
- 模板在代码中版本化，提供纯文本与 HTML；URL 只允许配置的账号域名。
- 临时失败重试，认证失败/地址语法错误进入 dead-letter；重复任务使用同一幂等键。
- provider webhook 使用 current/previous signature secret 验签，先写带 status/lease/attempt/dead-letter 的 inbox，再异步处理 delivered/bounced/complained；事件 ID 唯一、乱序/重复幂等。
- hard bounce/complaint 写独立 `email_suppressions`，不 disabled identity/删除账号，避免误伤登录；停止非安全邮件并提示更新邮箱，安全/合规必需通知按批准策略处理。
- 托管邮件同样是 at-least-once；provider 支持 idempotency key 时去重，否则允许重复邮件但 token 消费必须幂等。
- 邮件正文、完整收件地址和 action token 不进入普通日志。

自托管 SMTP 在计划 09 实现同一接口；未配置时相应能力为关闭。

## 7. 密钥与会话安全

### 7.1 服务端密钥拆分

新增独立 keyring 配置：

- Access Token signing keys，带 `kid`，至少保留当前和上一把。
- TOTP encryption keys，密文记录 `keyId`，支持惰性重加密。
- action token pepper，令牌记录 `token_key_id`；轮换时保留旧 pepper 至其签发令牌全部过期/撤销，不能让数据库中仍有效 token 突然失效。
- managed workspace KMS 属于后续安全计划，不与本次邮箱改造混用。

轮换顺序按用途独立：先部署 reader(current+previous/legacy) → 切 writer 到新 key/kid → 对账 → 超过 JWT/action-token 最大 TTL 后移除旧 reader。TOTP 没有自然“最大凭据寿命”，只能在全部密文成功重包、逐行对账且无旧 keyId 后移除旧 key；不得靠等待过期。

修正 TOTP setup 语义：创建新 secret 不能立即清空现有 `totpEnabledAt`；只有新 secret 验证成功后原子替换。

### 7.2 客户端凭据

- Tauri 的 refresh token 迁移到 Keychain/Keystore；Store 只保存非秘密 profile。
- OS secure storage 不可用/锁定时不持久化 refresh，要求重新授权；绝不静默回退普通 Store/localStorage。
- Access token 只保存在内存。
- 旧 Store 双读一次，写入系统凭据后删除旧字段；失败时不删除原值并提示重新授权。
- Web fallback 不长期保存 refresh token 到 localStorage。
- 客户端本地备份不包含服务器 session；恢复后要求重新授权。
- 只有 `refresh_token_invalid/reused/revoked` 才清除本地会话。临时网络错误、429、5xx、邮箱待验证、风险挑战或欠费进入各自状态。
- 正式启用托管登录前完成计划 12 的 refresh rotation 崩溃恢复，否则“服务端已旋转、客户端 Keychain 未落盘”会把下一次旧 token 使用误判为设备重放。

## 8. API 与错误码

建议新增：

```text
POST /v1/web/auth/register/email
POST /v1/web/auth/email/verify
POST /v1/web/auth/email/resend
POST /v1/web/auth/password-reset/request
POST /v1/web/auth/password-reset/complete
POST /v1/web/account/email-change/request
POST /v1/web/account/email-change/complete
GET  /v1/web/account/identities
```

稳定错误码：

- `email_verification_required`
- `email_delivery_unavailable`
- `action_token_invalid`
- `action_token_expired`
- `action_token_consumed`
- `web_registration_required`
- `step_up_required`
- `identity_conflict`
- `identity_ambiguous`（仅 legacy migration，不暴露候选账号）

公开 request/resend 接口避免返回 `identity_not_found`。验证落地页可显示通用过期/已使用状态，但不返回账号内部 ID。

## 9. Web 与客户端改动

### 9.1 账号 Web

- hosted 使用邮箱文案、验证等待页、重发倒计时和找回密码入口。
- self-hosted 未启用 email capability 时继续显示用户名，不出现“忘记密码”。
- 浏览器设备授权若账号未验证，先完成验证再回到原 `next`；只允许同源相对跳转。
- 安全页显示掩码邮箱、验证状态、换绑入口、最近安全事件。

### 9.2 NoteGen 客户端

- 中性化“自托管”标题，连接后按 mode 显示官方托管或自托管。
- hosted 默认只显示“在浏览器中连接”；密码直登作为能力控制的兼容入口。
- 使用 `web.accountUrl` 增加“管理账号”入口。
- 不把 password reset 当作 E2EE 恢复。
- 更新错误模型，保存 `requestId` 和安全 details，客户端自行本地化。

## 10. 建议 PR 切片

1. **PR-01A：身份/登录 Claim 与 legacy 回填。** lifecycle、claims、identities、action tokens、歧义 quarantine/migration queue、单一 claim resolver；先部署回填与冲突审计，再原子切换认证读路径，禁止 identities/legacy 优先级双读。
2. **PR-01B：托管 MailProvider。** outbox handler、模板、provider webhook inbox。
3. **PR-01C：邮箱注册与验证。** Web 流程、未验证权限、管理员隔离。
4. **PR-01D：密码重置与换绑。** credential epoch、登录签发竞态、pending claim、step-up、会话撤销、安全事件。
5. **PR-01E：密钥拆分与 TOTP 修复。** keyring、`kid`、双读迁移。
6. **PR-01F：客户端安全凭据与连接 UX。** 浏览器优先、系统凭据存储、错误状态。

## 11. 测试与验收

- 大小写、Unicode、IDN、重复邮箱和并发注册只产生一个有效身份。
- legacy username 与 email-looking login 共享 namespace；冲突进入 quarantine/migration queue，普通登录与显式 identityKind 都 fail-closed，非冲突 legacy claim 继续兼容且不会串账号。
- 验证/重置/换绑 token 过期、重放、跨用途、并发消费均安全且幂等。
- 注册事务成功但邮件 provider 失败时账号保持 pending，任务可恢复重试。
- 不存在邮箱和存在邮箱的找回接口在状态码、响应结构和大致耗时上不可区分。
- hosted 普通注册永不获得管理员；self-hosted legacy 用户名注册不受影响。
- 密码重置撤销所有旧 session，旧客户端 outbox 保留并提示重新授权。
- 旧密码验证与 reset、邮箱换绑与 Session issuance 的并发不能在撤销后签发旧代次凭据；旧 Access JWT 立即失效。
- verify 与 pending cleanup 并发不删除已激活账号；邮箱换绑 pending claim 并发只有一个账号成功。
- released claim 在隔离期内拒绝登录和重新认领；到期清理与新 insert 并发只有一个结果，任何流程都不能原地改写 claim 的 account owner。
- TOTP 换绑失败不会关闭原 TOTP。
- 旧 `AUTH_SECRET` 格式可读，新 keyring 写入后可轮换。
- 日志、审计、dead-letter 和 provider webhook 均无 token、密码或完整邮件正文。
- bounce/complaint 只写 suppression，不 disabled 可登录 identity；Webhook inbox 重放/乱序可恢复。

上线门槛：验证邮件成功率和延迟已可观测；重置与换绑完成安全评审；客户端 refresh token 已移出普通 Store；公开注册仍由 02 风控计划的开关控制。

## 12. 上线与回滚

- 先部署表、claim shadow writer/backfill 和冲突审计，保持 `identity.email=false`；此时 legacy resolver 仍是唯一读路径，不实现“identities 优先、accounts.login 回退”的双权威读取。
- 回填 username identity/claim 并对账，不改变登录行为；发现冲突先 quarantine。
- 关闭注册并排空旧认证进程后，把全部认证 reader 原子切到 claim-only resolver；此版本成为最低身份契约 binary，不能回退到会绕过 claim 的旧 resolver。
- 内部账号试用邮件 provider、验证和找回。
- 内部 synthetic 账号先灰度；完成 02 风控、08A/B 注册与邀请核心及 05 Pilot Gate 后才接收真实邀请用户，再评估 public。
- 回滚时关闭邮箱注册与找回，保留已验证 identity 并继续允许其作为 login；不得删除 action/audit 表。

## 13. 开放问题

- 托管事务邮件 provider 的最终选择、发信域名和数据区域需在实施前由运营确认。
- hosted 是否允许用户保留额外 username alias；一期建议不提供新增入口，但兼容历史账号。
- 密码策略是否接入泄露密码库；如使用外部查询，必须采用 k-anonymity 或本地库并单独审查隐私。
