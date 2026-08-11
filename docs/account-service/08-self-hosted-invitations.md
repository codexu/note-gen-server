# 08：共享邀请核心与自托管邀请注册技术规格

- 状态：已完成（内部测试范围；生产注册开放由 [13 生产上线准备](13-production-readiness.md) 的灰度门控）
- 日期：2026-08-11
- 适用形态：邀请 token/accept 核心共用；管理员 UI 默认 `self-hosted`
- 核心前置：[00 共享基础](00-shared-foundation.md)
- 自托管管理前置：[07 首次初始化](07-self-hosted-bootstrap.md)
- 可选依赖：投递需 [09 自托管 SMTP](09-self-hosted-smtp.md)；绑定邮箱需 [01 邮箱 identity core](01-hosted-email-identity.md)
- 交付结果：Setup Token 被真正的一次性/限时邀请替代；没有 SMTP 时仍可安全复制链接完成注册

## 1. 目标

- 支持 `disabled | invitation | public` 注册策略，默认 invitation/disabled 可由管理员选择。
- 邀请可限时、撤销、限制使用次数、可选绑定邮箱，并完整审计。
- token 只保存哈希，只在创建时显示一次。
- 接受邀请与创建账号原子执行，防止并发重复消费。
- SMTP 未配置时管理员可以复制邀请链接；配置后可投递并查看状态。
- 旧客户端仍看到 `registrationMode=closed`，新客户端按结构化方法展示。

## 2. 非目标

- 邀请不自动授予系统管理员；管理员角色需注册后单独授予。
- 一期不实现组织、团队、Workspace 成员或协作邀请。
- 不把邀请 token 放在 URL query、日志或邮件追踪参数中。
- 不用通用 Setup Token 伪装成“部署邀请码”。

## 3. 数据模型

```text
registration_invitations
  id uuid pk
  token_key_id text
  token_hash text unique
  token_hint text
  created_by_actor_type enum('account','staff','system')
  created_by_actor_id uuid nullable
  creator_snapshot jsonb
  bound_email_normalized text nullable
  max_uses integer default 1
  use_count integer default 0
  expires_at timestamptz not null
  revoked_at timestamptz nullable
  last_sent_at timestamptz nullable
  note text nullable
  replaces_invitation_id uuid nullable
  created_at, updated_at

registration_invitation_uses
  id uuid pk
  invitation_id uuid
  account_id uuid
  request_id text
  used_at timestamptz
  unique(invitation_id, account_id)
```

约束：

- 默认有效期 7 天，一期硬上限 90 天；部署者可通过 policy 收紧但不能放宽该上限。API/CLI 不接受 null、无限期或超上限过期时间。
- `CHECK(max_uses > 0 AND use_count >= 0 AND use_count <= max_uses)`；多次邀请明确标识为批量链接并限制合理上限。
- bound email 只有启用计划 01 identity core 时可设置，且强制 `max_uses=1`；接受时完全匹配 normalized email，但绑定本身不写 `verified_at`，仍需独立邮箱验证流程。
- actor 被删除后保留脱敏 creator snapshot 或 nullable reference，邀请审计不级联消失。
- 使用记录的账号外键 `ON DELETE SET NULL` 并保留 subject snapshot；`DELETE` API 只 revoke，不物理删历史。

## 4. Token 与链接

- 生成至少 256 bit 随机 token，数据库只保存带 key ID 的 HMAC。切 writer 前先部署 current+previous reader；旧 pepper 只有在引用它的邀请全部过期/撤销、最长 90 天 TTL 与允许时钟偏差均已越过并完成对账后才能移除。
- 管理页面只在创建响应中返回 plaintext；之后仅显示 hint、状态、使用次数和过期时间。
- 邀请 URL 使用 fragment，例如 `https://server.example/#/accept-invite/<token>`；浏览器从 fragment 读取后通过 POST body 提交，避免代理/access log/referrer 收集。
- 页面设置 `Referrer-Policy: no-referrer`、禁止第三方脚本和资源，消费后立即从地址栏清除 token。
- 邮件模板中的链接也使用同一形式，不加入第三方点击追踪。

## 5. 注册策略

`registrationPolicy` 是数据库中的运营设置：

- `disabled`：只能登录，不能新建邀请/注册；已创建未消费邀请是否继续有效由切换确认决定，默认全部暂停而非删除。
- `invitation`：只有有效邀请可注册。
- `public`：允许无需邀请注册；自托管 UI 显示公网滥用警告，仍受基础限流。

切换策略使用计划 00 的 action-bound step-up、写审计并递增 `registrationPolicyRevision`，不混称 instance capability revision。`registrationMode` 响应兼容映射：public→open，其余→closed；环境变量 `REGISTRATION_MODE` 只由计划 00 迁移读取。

## 6. 创建、发送与接受流程

### 6.1 创建

`POST /v1/web/admin/invitations`：校验 admin、CSRF、step-up、能力和策略，事务创建邀请及审计。响应包含一次 plaintext token/link；浏览器刷新后无法再取回。

Self-hosted 管理员或 hosted 受权 staff 可选择：

- 只复制链接。
- 有 SMTP 且绑定邮箱时“创建并发送”。
- 创建并发送必须在同一业务事务写邀请与加密 secret outbox payload；worker 发送/作废后擦除 token plaintext。

服务端只保存 token hash，不能“重发同一个 token”。如需重发/重新取得链接，事务撤销旧邀请、创建带 `replaces_invitation_id` 的新邀请/token/outbox；旧链接立即失效。

### 6.2 预检

`POST /v1/invitations/inspect` 接受 token，返回最小安全信息：是否可继续、是否要求邮箱、服务名称、过期状态的通用提示。不得返回创建者、已注册邮箱或剩余使用次数。

### 6.3 接受

一期只支持账号 Web 接受：用户提交 token、login/password，以及需要时的 email。
2. RegistrationService 执行基础限流、身份唯一性和密码策略。
3. 事务锁 invitation row，检查 hash/expiry/revoked/policy/use_count。
4. 通过统一 RegistrationService 创建普通账号与可用 identity；不得自动 admin。绑定邮箱只约束值，不自动验证。
5. 增加 use_count、写 use record、审计。
6. 若该次达到 max uses，邀请变为 consumed。
7. 提交后创建 Web Session；失败返回注册已完成、请登录。NoteGen 设备继续通过浏览器授权关联。

账号创建冲突不会消费邀请。外部邮件通知失败不回滚已完成注册。

## 7. 撤销、过期与维护

- 管理员可撤销未完成邀请；已使用记录保留。
- 过期由查询逻辑立即生效，维护任务分批物理清理 token hash，审计/使用记录按保留策略保存。
- 删除创建者不撤销邀请；管理员删除账号前 UI 显示其未完成邀请并要求转交/撤销。
- `paused` 是由全局 registration policy 派生的查询状态，不写 invitation row；切策略不批量更新记录。恢复 invitation 后未过期/未撤销邀请可继续使用，管理筛选显式包含 paused。
- token 被猜测/多次失败触发 invitation + IP 限流，但 inspect 响应不泄露哪个条件失败。

## 8. API 与 Capabilities

```text
POST   /v1/invitations/inspect
POST   /v1/web/auth/register/invitation
POST   /v1/web/auth/step-up
GET    /v1/web/admin/invitations
POST   /v1/web/admin/invitations
POST   /v1/web/admin/invitations/:id/replace-and-send
DELETE /v1/web/admin/invitations/:id
PUT    /v1/web/admin/registration-policy
```

capabilities 示例：

```json
{
  "registrationMode": "closed",
  "registration": {
    "policy": "invitation",
    "methods": ["invitation", "browser"],
    "emailVerificationRequired": false
  },
  "features": { "invitationRegistration": true }
}
```

普通账号 API 不暴露邀请列表。NoteGen 客户端优先打开账号 Web；native invitation 需要 deviceId/name/platform 与不同 Session 语义，作为后续独立 endpoint，不能让本期 Web contract 偷渡支持。

Canonical 注册边界：`/v1/web/auth/register/invitation` 只处理邀请；现有 `/v1/auth/register` 与 `/v1/web/auth/register` 的 public 流程统一调用 RegistrationService。07 兼容窗口结束后两者移除 `x-setup-token/setupToken` 语义，旧客户端仍由 capabilities 得到 closed/升级提示。

## 9. 无 SMTP 与有 SMTP 的行为

| 能力 | 无 SMTP | 有 SMTP |
| --- | --- | --- |
| 创建邀请 | 支持 | 支持 |
| 复制链接 | 支持，默认路径 | 支持 |
| 绑定邮箱 | 仅 identity core 启用时可约束，不等于验证 | 支持约束并发送，仍走独立验证 |
| 重发 | 不显示；撤销后重新生成链接 | 轮换旧 token、创建新邀请后发送 |
| 投递状态 | 显示“未配置邮件” | queued/sent/failed |
| 忘记密码 | 不因邀请自动获得 | 由邮箱身份能力决定 |

SMTP 不可用不能让实例或已有账号同步不可用。

## 10. 管理 Web 与客户端

- 管理页按 active/paused/used/expired/revoked 筛选，显示 hint、创建者、用途备注、过期和使用次数。
- 复制 plaintext 后立即给出“此链接之后无法再次查看”的提示。
- 切 public registration 要二次确认外网限流、SMTP/找回能力和滥用风险。
- 注册页只显示当前策略允许的方法；不再把 Setup Token 称为邀请码。
- 客户端一期打开 Web 接受邀请；不在 direct register 偷加 token，也不复用 `x-setup-token`。

## 11. 建议 PR 切片

1. **PR-08A：Shared RegistrationPolicy/Core。** 仅依赖 00；强类型设置、capabilities、统一 RegistrationService。
2. **PR-08B：Shared Invitation Core。** token、Web inspect/accept、并发消费、staff/system creator、审计；可单独用于 hosted 邀请测试。
3. **PR-08C：Self-hosted Admin UI。** 依赖 07；创建/复制/revoke/筛选/策略切换。
4. **PR-08D：Mail + Email Identity Integration。** 可选依赖 01/09；绑定、token rotation resend、outbox 状态和降级。
5. **PR-08E：Client Compatibility。** 浏览器入口、新错误码、移除 Setup Token 邀请语义。

## 12. 测试矩阵

- 两实例并发接受单次邀请只有一个账号成功，失败者不消费第二次。
- 账号唯一冲突、密码失败、事务中断不增加 use_count。
- token 错误/过期/撤销/已用/paused 返回不可枚举的统一外部结果。
- fragment token 不出现在 access log、referrer、分析脚本或审计 metadata。
- bound email 规范化匹配，不能改成另一邮箱。
- bound email 强制单次且不能因复制/邮件邀请直接变成 verified。
- null、无限期和超过 90 天的邀请被拒绝；pepper 轮换期间旧邀请可消费，旧 key 仍有有效引用时不能退休。
- 无 SMTP 的完整创建→复制→接受流程可用；SMTP 故障不破坏链接。
- `send=true` 必须同时具备 bound email 和 `mail.delivery`；邀请、加密 payload 与 outbox 在同一事务创建，任一失败不留下可用 token 或孤儿投递。
- replace-and-send 并发时只产生一个有效 replacement；旧 invitation 的 pending outbox 变为 dead-letter 并擦除 payload，已租约任务在 provider 调用前复核旧 token 已失效。
- 邀请永不自动授予 admin；最后管理员保护仍有效。
- 旧客户端看到 closed，现有登录和浏览器设备授权不受影响。

## 13. 上线、回滚与验收

先上线 08A/B 并保持生产 registration disabled，在测试环境完成 token/并发验证；hosted 由受权 staff、self-hosted 在 08C 后由实例管理员切到 invitation 再创建生产邀请。删除 legacy Setup Token 注册只能在计划 07 完成、客户端文案迁移后执行。

回滚可把策略切 disabled 并暂停所有邀请；保留 invitation/use 表。已创建账号不受影响。不要回退到长期 Setup Token 作为普通邀请码。

验收条件：每个邀请可追踪、可撤销、可过期、不可重放；无 SMTP 仍能完成；策略与 capabilities/服务端 enforcement 一致；并发或异常不产生幽灵账号/错误消费。

## 14. 开放问题

- 是否需要批量邀请 CSV；一期建议不做，先支持合理 maxUses 和逐个邮箱邀请。
- public registration 是否在自托管默认暴露；本规格建议默认 disabled/invitation，由管理员明确承担风险后开启。
