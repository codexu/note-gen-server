# 06：官方托管客服与运营支持技术规格

- 状态：Draft
- 日期：2026-08-11
- 适用形态：`hosted`
- 前置依赖：[00 共享 Staff/step-up 基础](00-shared-foundation.md)、[01 邮箱身份](01-hosted-email-identity.md)、[05A/B 数据治理基线](05-hosted-compliance.md)；06B 面向真实用户开放前硬依赖 05D deletion fence/handler
- 关联计划：风险、用量、订阅和合规完成后在同一账号时间线只读聚合
- 交付结果：用户可提交可追踪工单，客服以最小权限诊断和执行受控操作，任何内容/账号访问均可说明和审计

## 1. 目标

- 提供站内支持入口、工单状态、消息和邮件通知。
- 把 request ID、服务端/客户端版本、能力快照和用户主动选择的诊断信息关联到工单。
- 将客服、账单、安全、合规和平台管理员角色拆开。
- 默认禁止 impersonation 和内容浏览；确需诊断时采用短期、显式用户授权。
- 支持将工单同步到外部客服平台，但内部账号 ID、权限和审计仍由 NoteGen 掌握。
- 为自托管提供可配置的 `supportUrl/supportEmail` 展示，而不连接官方工单系统。

## 2. 非目标

- 不把现有全局 `isAdmin` 直接重命名为客服角色。
- 不让客服解密 E2EE，也不默认查看 managed 笔记正文。
- 不在一期构建聊天机器人、电话系统、知识库或复杂 SLA 引擎。
- 不允许客服直接修改数据库、套餐价格、风险规则或 legal hold。

## 3. Staff 身份与 RBAC

本计划复用 00 的独立 StaffPrincipal、OIDC Session、permission registry 和 step-up，不再到 Wave 4 才创建运营身份。Support 只登记 `support.read/write/diagnostics` 权限与默认角色模板；security admin、billing admin、compliance operator、legal-hold admin 仍由各自领域 permission 决定，角色不是互相覆盖的数据库 enum。

权限矩阵：

| 操作 | support_read | support_write | billing_support | security | compliance/legal hold | platform_admin |
| --- | --- | --- | --- | --- | --- | --- |
| 查看账号基础摘要 | 是 | 是 | 是 | 是 | 是 | 是 |
| 查看/回复工单 | 只读 | 是 | 关联账单工单 | 关联安全工单 | 关联合规工单 | 是 |
| 撤销 Web/设备会话 | 否 | 需授权 | 否 | 是 | 否 | 是 |
| 人工 entitlement grant | 否 | 否 | 有时限 | 否 | 否 | 是 |
| 风险锁定/解除 | 否 | 否 | 否 | 是 | 否 | 是 |
| 数据导出/删除/hold | 否 | 否 | 否 | 否 | 按独立 permission/双人审批 | 不自动拥有 |
| 查看笔记正文/密钥 | 否 | 否 | 否 | 否 | 否 | 否 |

所有 staff Session 的 MFA、短 TTL、IdP disable 传播和 step-up 由 00 强制；不与客户 Web Cookie 共用认证域或 secret。

## 4. 工单与消息模型

```text
support_cases
  id uuid pk
  account_id uuid nullable          -- active 期间 FK；删除时 ON DELETE SET NULL
  subject_hash text
  account_snapshot jsonb
  category enum('account','sync','device','encryption','billing','privacy','abuse','other')
  severity enum('normal','high','urgent')
  status enum('open','waiting_for_support','waiting_for_user','resolved','closed','spam')
  subject text
  source enum('web','client','email','staff','external')
  assigned_staff_id nullable
  assigned_staff_snapshot jsonb nullable
  external_provider text nullable
  external_case_id text nullable
  last_message_at, resolved_at nullable
  created_at, updated_at
  unique(external_provider, external_case_id) where external_case_id is not null

support_messages
  id uuid pk
  case_id uuid
  author_type enum('account','staff','system')
  author_ref text nullable
  author_snapshot jsonb nullable
  visibility enum('customer','internal')
  body_ciphertext text
  body_key_id text
  body_encryption_version integer
  body_format text
  direction enum('local','to_provider','from_provider')
  external_provider text nullable
  external_message_id text nullable
  idempotency_key text
  request_hash text
  created_at
  unique(case_id, author_type, idempotency_key)
  unique(external_provider, external_message_id) where external_message_id is not null

support_message_revisions
  id uuid pk
  message_id uuid
  prior_body_ciphertext text
  body_key_id text
  edited_by_staff_id uuid nullable
  edited_by_staff_snapshot jsonb
  reason text
  created_at

support_case_links
  case_id uuid
  link_type enum('request_id','device','job','billing_event','risk_event','data_request')
  link_ref text
  target_account_id uuid nullable
  target_subject_hash text
  target_snapshot jsonb
  resolved_at timestamptz
  created_at

diagnostic_grants
  id uuid pk
  case_id uuid
  account_id uuid nullable
  subject_hash text
  scope_schema_version integer
  scope text[]                 -- 仅 typed registry 中 ID
  snapshot_ref text nullable
  snapshot_state enum('pending','ready','failed','expired','deleted')
  snapshot_hash text nullable
  snapshot_size bigint nullable
  snapshot_key_id text nullable
  consent_version integer
  created_by_account_id uuid nullable
  creator_snapshot jsonb
  expires_at
  revoked_at nullable
  deleted_at nullable
  created_at
```

Hosted 工单正文强制使用独立 keyring 的版本化 AEAD，不允许“ciphertext 或 plaintext”二选一。消息默认不可编辑；确需纠错时保留 revision 与原因，不能只覆盖 body/写 `edited_at`。Account/staff FK 一律使用 nullable `ON DELETE SET NULL` + 当时的最小 actor/subject snapshot，不能 cascade 清掉按批准策略需保留的 case/message 审计；active case 的 owner 查询要求 `account_id` 非空且匹配，删除后不得凭 `subject_hash` 恢复客户访问。内部备注永不发给用户或外部邮件线程。

计划 05 删除 handler 在 subject fence 内先删除 diagnostic snapshot、撤销 grant 和外部 provider 访问，再按 inventory 删除或最小化 case/message/link。需要保留的工单将 account/staff FK 脱钩、清除非必要正文/主题/外部映射，只留下受控 `subject_hash`、最小 snapshot、状态时间和审计事实；`subject_hash` 仍按高敏 pseudonymous 数据管理，不能用于重建账号或营销。晚到 provider message/Webhook 必须命中 05 deletion fence，只能进入批准的删除 reconciliation，不得重新附着已删除 account。

## 5. 工单流程

1. 用户选择分类、简短主题和描述；页面明确不要提交密码、恢复密钥或支付卡信息。
2. 可选勾选诊断项，预览将包含哪些字段。
3. 事务创建 case、首条 message、经过归属验证的 links 和 outbox 通知；用户传入的 request/device/billing/risk ID 必须在源域验证属于该 account，聚合读取时再次授权。
4. 自动路由只按 category/severity/队列，不读取同步正文。
5. 客服回复进入 customer-visible message，并异步邮件通知。
6. 用户/客服可在 resolved 后有限期重开；关闭后进入保留策略。

工单号使用不可猜的 UUID 或独立公开短 ID；访问始终校验 account ownership，不能靠 ID 保密。

## 6. 诊断授权

默认诊断包只含：

- NoteGen 版本、平台、deployment mode、server version、协议/capability 快照。
- 最近失败的安全 request ID 和稳定错误码。
- 同步 phase、outbox/inbox 数量、cursor、Workspace/设备 ID 的短哈希。
- 用量/限额摘要、最近 job 状态。
- 用户主动选择的客户端日志片段，先本地脱敏预览。

不含：密码、refresh token、action token、workspace key、恢复密钥、笔记正文、文件名、完整路径、完整 IP、邮件正文。

Scope 只能来自版本化 typed registry；授权内容、consent version、到期时间明确展示，快照生成后不可后台扩 scope。用户可提前撤销，撤销只阻止未来访问，不能声称收回 staff 已下载或已发送外部 provider 的副本；UI 按 05 retention 明示。过期/撤销后 cleanup job 物理删除 snapshot并写 `deleted_at`，客服每次查看/下载写高敏审计。E2EE 或 managed 内容分享若未来需要，应是独立、端到端用户主动上传的临时附件功能，不复用 diagnostic grant 偷渡实现。

## 7. 禁止隐式 Impersonation

一期不提供“以用户身份登录”。客服动作通过明确的内部命令执行，例如：

- `revoke_session(accountId, sessionId, caseId, reason)`
- `resend_verification(accountId, caseId)`
- `grant_temporary_entitlement(accountId, grant, expiresAt, caseId)`

每个命令：

- 校验 staff role、case 关联、step-up 和目标状态。
- 在业务事务内记录 actor、case ID、before/after 和 reason。
- 返回有限结果，不签发客户 token。
- 高风险动作可要求用户确认或第二位 staff 批准。

## 8. 外部客服平台适配

```ts
interface SupportProvider {
  upsertCase(snapshot: ExternalCaseSnapshot, idempotencyKey: string): Promise<{ externalCaseId: string }>
  appendMessage(externalCaseId: string, message: ExternalMessage, idempotencyKey: string): Promise<void>
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): VerifiedSupportEvent
}
```

- NoteGen DB 保持 account ↔ case 映射和授权事实。
- Webhook 先验签、去重、落 inbox，再异步处理。
- 外部 case/message 使用 provider ID 唯一约束与 direction/origin，入站事件不得再次回发形成 echo loop。
- 外部工单删除或故障不删除 NoteGen 审计。
- 自由文本可能仍含 PII/卡号/密钥；接入前完成 provider DPA、数据区域、retention 和删除流程，提交页明确披露接收方。只发送掩码身份、公开 case ID、用户确认的内容和允许诊断；邮件通知默认只发 case 号/站内链接，不带正文。
- provider 不可用时 Web 工单仍可创建，outbox 重试；严重告警使用独立值班通道。

## 9. 账号时间线

客服页面通过只读聚合服务显示：

- 邮箱验证与最近安全事件摘要。
- 设备/会话状态，不显示 token。
- 当前 entitlement、用量、quota 状态和订阅摘要。
- 风险 restriction reason family；详细规则仅 security 角色可见。
- data request/deletion 状态；内容和 legal hold 细节受 compliance 权限控制。
- support case 和人工操作审计。

时间线不复制各领域所有数据到一个万能表；使用分页聚合与稳定 event projection，源表仍为事实来源。

## 10. API 与 UI

用户：

```text
POST /v1/web/support/cases
GET  /v1/web/support/cases
GET  /v1/web/support/cases/:id
POST /v1/web/support/cases/:id/messages
POST /v1/web/support/cases/:id/diagnostics
DELETE /v1/web/support/cases/:id/diagnostics/:grantId
```

Staff：使用独立 `/internal/support/*` origin/audience，不与公开客户 token 混用。生产边界可由独立部署或反向代理 ACL 保护。

NoteGen 客户端提供“获取帮助”：只打开 capabilities 声明且验证同源的账号 Web。Support context token 使用随机 opaque 值、服务端只存哈希，短 TTL/一次性消费，并绑定 audience、instance/account/device 与字段 allowlist；“不含内容秘密”不代表无需保护。用户预览确认后才上传诊断。自托管则打开部署者配置且经过 URL 校验的支持地址，不误导为官方 SLA。

## 11. 指标、SLO 与告警

- 新建/等待/解决/重开 case 数，按 category/severity。
- 首次响应和解决时间分布；目标值由运营配置，不写死法律承诺。
- waiting_for_user 超时、通知失败、provider sync backlog。
- diagnostic grant 创建/查看/撤销及异常批量访问。
- staff 高风险动作、grant、会话撤销量。

账号 ID、case subject、邮箱不作为指标 label。异常批量查询、非工作时间高敏下载、同一 staff 大量账号访问必须触发安全告警。

## 12. 实施步骤与 PR 切片

1. **PR-06A：Support Permissions。** 在 00 staff realm 登记 support permission/默认角色、队列 scope 和审计动作，不另建认证体系。
2. **PR-06B：Case Core。** case/message/link、nullable FK + 最小 subject/actor snapshot、用户 Web、outbox 通知与 deletion-fence guard。
3. **PR-06C：Diagnostic Grant。** 客户端预览、脱敏快照、短期授权与访问审计。
4. **PR-06D：Support Console。** 队列、时间线、受控命令，不含 impersonation。
5. **PR-06E：External Adapter。** 双向映射、Webhook inbox、故障降级。
6. **PR-06F：自托管支持入口。** capability support URL、品牌/责任边界文案。

## 13. 测试矩阵

- 客户只能访问自己的 case；ID 枚举、跨账号 message 和 diagnostic grant 被拒绝。
- 内部备注永不出现在客户 API、邮件或外部 public comment。
- 每个角色只能看到/执行矩阵中的动作；过期 role/step-up 立即失效。
- diagnostic scope 无法在生成后扩大，过期/撤销后不可下载。
- 撤销后 snapshot cleanup 可重入；已下载副本的 UI/retention 文案不做虚假收回承诺。
- 脱敏测试覆盖 token、邮箱、路径、IP、密钥和正文样本。
- provider 重复/乱序 webhook 不重复 message；故障期间本地 case 可用。
- provider inbound/outbound echo 不循环；伪造跨账号 case link 在创建和聚合两处均被拒绝。
- staff 不能签发客户 session 或浏览 managed/E2EE 内容。
- 人工 entitlement、会话撤销、风险解除必须关联 case/reason 并有完整审计。

## 14. 上线、回滚与验收

先仅开放内部账号和只读 support console；再启用用户 case，不启用外部 provider；验证权限/审计后逐步接入 provider 和受控命令。diagnostic grant 最后上线并经过安全审查。

回滚可关闭 `support.cases` 新建和 provider worker，保留用户查看历史 case 与内部只读查询；不得删除审计或让外部 provider 变成唯一副本。

验收条件：普通客服无法查看内容/密钥/支付凭据；用户可知道诊断分享范围并撤销；任何人工账号动作可追溯到 staff、工单、原因和 before/after；自托管不会把官方客服能力错误展示为可用。

## 15. 开放问题

- 内部 IdP 和外部客服平台的选择。
- 是否允许邮件直接创建/回复工单；一期建议 Web 为事实入口，邮件只通知，降低身份冒用和线程映射风险。
- 高风险操作的双人审批清单及值班流程。
