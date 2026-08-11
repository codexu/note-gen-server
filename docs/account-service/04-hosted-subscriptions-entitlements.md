# 04：官方托管订阅、计费与权益技术规格

- 状态：Draft
- 日期：2026-08-11
- 适用形态：`hosted`；`self-hosted` 不注册计费路由
- 前置依赖：[00 共享基础](00-shared-foundation.md)、[01 邮箱身份](01-hosted-email-identity.md)、[02 风控](02-hosted-risk-control.md)、[03 用量与配额](03-hosted-usage-quotas.md)；上线前完成 05 Pilot Gate，任何真实付款前再完成 05D billing 删除/fencing handler
- 交付结果：支付供应商状态被可靠转换为内部订阅与权益，失败或取消按明确宽限策略降级而不删除数据

## 1. 设计原则

1. 已验签 provider snapshot/event 是外部支付状态输入；NoteGen 的内部 inbox/ledger/audit 保存处理事实，`EntitlementService` 是产品授权事实来源。Provider 不是 NoteGen 审计、税务或会计总账的唯一副本。
2. 同步、Blob 和设备代码只消费 `EffectiveEntitlements/EffectiveLimits`，不判断套餐名称或供应商状态。
3. Checkout 成功跳转不能直接解锁权益；只有已验签 Webhook 或服务端主动核验才能改变状态。
4. Webhook 必须先持久化再处理，支持重复、乱序、延迟和人工重放。
5. 欠费、取消或退款不直接删除数据。在安全、合规、账号生命周期与 provider 可用性允许时提供读取、导出、删除和恢复付费路径。
6. self-hosted 不加载 SDK、secret、页面或 Webhook endpoint；capability 返回关闭。

## 2. 目标与非目标

目标：

- 提供套餐/价格版本、客户映射、订阅状态、一次性权益覆盖和账期信息。
- 提供 Checkout、客户门户、升级/降级/取消和恢复入口。
- 支持试用、宽限、past-due、取消期末生效、退款/争议后的人工复核。
- 让运营可解释“账号当前为何拥有这些权益”。
- 不保存卡号、CVC 或完整账单地址等受监管支付凭据。

非目标：

- 一期不自建支付页面、税务引擎、发票系统或总账。
- 不实现按量后付费；usage 先用于限额和展示。
- 不在首版支持组织席位、多成员 Workspace 或复杂优惠组合。
- 不把 provider webhook 当作同步请求内的同步依赖。

## 3. 供应商决策门

实现前必须选择一个首发 BillingProvider，并记录：可服务地区、商户主体、税务/发票职责、退款/争议能力、Webhook 重放、客户门户、数据区域和费用。支付必须使用 provider-hosted redirect/portal；即使 NoteGen 不接触卡号，也需记录 PCI shared-responsibility/适用 SAQ 评估、provider 尽调和年度合规复核，不能宣称“完全不在 PCI 范围”。核心规格保持 provider-neutral：

```ts
interface BillingProvider {
  findOrCreateCustomer(input: CustomerInput, idempotencyKey: string): Promise<{ customerId: string }>
  createCheckout(input: CheckoutInput, idempotencyKey: string): Promise<{ checkoutId: string; url: string }>
  getCheckoutByIdempotencyKey(idempotencyKey: string): Promise<ProviderCheckoutSnapshot | null>
  createCustomerPortal(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>
  getSubscription(providerSubscriptionId: string): Promise<ProviderSubscriptionSnapshot>
  cancelSubscription(providerSubscriptionId: string, atPeriodEnd: boolean): Promise<void>
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): VerifiedBillingEvent
}
```

供应商 SDK 只存在于 adapter 目录。领域层只处理规范化 snapshot/event。

## 4. 数据模型

```text
billing_plan_versions
  id uuid pk
  plan_key text
  version integer
  display_name text
  currency text
  amount_minor bigint
  interval enum('month','year')
  entitlement_schema_version integer
  entitlements jsonb
  active_from, retired_at
  unique(plan_key, version)

billing_price_mappings
  id uuid pk
  plan_version_id uuid
  provider text
  provider_environment enum('test','live')
  provider_price_id text
  currency text
  interval enum('month','year')
  active boolean
  created_at, retired_at nullable
  unique(provider, provider_environment, provider_price_id)
  unique(plan_version_id, provider, provider_environment, currency, interval)

billing_customers
  id uuid pk
  account_id uuid nullable          -- active 期间 FK；账号删除时 ON DELETE SET NULL
  subject_hash text
  provider text
  provider_customer_id text unique
  created_at, updated_at
  partial unique(account_id) where account_id is not null

account_subscriptions
  id uuid pk
  account_id uuid nullable          -- 保留记录按 05 最小化后与账号行脱钩
  subject_hash text
  provider text
  provider_subscription_id text unique
  plan_version_id uuid
  status enum('incomplete','trialing','active','past_due','grace','paused','ended','review')
  is_current boolean
  provider_revision text nullable
  current_period_start, current_period_end
  cancel_at_period_end boolean
  grace_ends_at timestamptz nullable
  ended_at timestamptz nullable
  snapshot jsonb                 -- 脱敏规范化快照
  created_at, updated_at
  partial unique(account_id) where account_id is not null and is_current = true

entitlement_grants
  id uuid pk
  account_id uuid
  source enum('promotion','support','migration','staff')
  source_ref text
  schema_version integer
  entitlements jsonb
  priority integer
  starts_at, expires_at nullable
  revoked_at nullable
  reason text nullable
  created_by nullable
  created_at
  unique(account_id, source, source_ref)

billing_webhook_events
  provider text
  provider_event_id text
  event_type text
  signature_verified_at timestamptz
  received_at timestamptz
  payload_encrypted_or_redacted jsonb
  status enum('pending','processing','processed','ignored','failed','dead_letter')
  attempts integer
  next_attempt_at timestamptz nullable
  error_code text nullable
  processed_at timestamptz nullable
  primary key(provider, provider_event_id)

billing_checkout_sessions
  id uuid pk
  account_id uuid
  provider text
  provider_checkout_id text nullable
  subscription_id uuid nullable
  price_mapping_id uuid
  plan_version_id uuid
  idempotency_key text
  request_hash text
  status enum('pending_provider','open','completed','linked','expired','failed','reconciling')
  expires_at, completed_at nullable
  created_at
  unique(account_id, idempotency_key)
  unique(provider, provider_checkout_id) where provider_checkout_id is not null
  partial unique(account_id) where status in ('pending_provider','open','completed','reconciling')

billing_account_states
  account_id uuid pk
  current_subscription_id uuid nullable
  purchase_intent_id uuid nullable
  revision bigint
  check(not (current_subscription_id is not null and purchase_intent_id is not null))
```

套餐/entitlement JSON 在发布时按 `entitlement_schema_version` 校验且不可原地修改。价格、限额或能力变化创建新 version；历史订阅继续引用原 version，迁移必须显式。客户端 checkout 只提交服务端公开的 plan/version，服务端从受控 `billing_price_mappings` 按 provider environment 选 price ID；不得接受客户端直接传任意 provider price ID。

一期采用 one-current-subscription：所有 checkout、Webhook/reconciliation 状态变更先 `FOR UPDATE` 同一 `billing_account_states` 行；其 CHECK 把 current subscription 与 purchase intent 变成跨表共享的互斥槽，各表 partial unique 是第二层防线。Checkout 从创建开始持续占用 `purchase_intent_id`，直到已验签/主动核验的 provider subscription 在同一事务写入 current row、把 checkout 置为 `linked` 并将槽原子切换为 `current_subscription_id`，不能在 provider 已完成但 Webhook 尚未落地的窗口释放。ended 行置 `is_current=false` 并 CAS 清空对应 current 槽；新购买创建新 row，不能复活/改写旧订阅历史。若未来允许叠加订阅，必须另写合并规格。

Webhook 若发现 provider 外部已产生第二条有效订阅，不覆盖 current 行；新对象进入 `review`、停止重复 entitlement，并触发对账/取消 Runbook。

与计划 05 的账号删除边界：checkout、grant 和非必要 customer PII 按删除 handler 清理；依法/税务/争议处理仍需保留的最小 subscription/transaction snapshot 将 `account_id` 以 `ON DELETE SET NULL` 脱钩，`is_current=false`，仅保留版本化 `subject_hash`、必要 provider reference、金额/币种/时间/状态和批准的审计字段。`subject_hash` 不是匿名数据，进入 05 inventory、访问控制与保留期。不得通过保留的 billing row 恢复 entitlement、重建客户账号或继续营销；provider 侧 customer 的删除/匿名化能力与法定保留例外必须在供应商决策门和删除 Runbook 中逐项确认。

## 5. Entitlement 计算

`EntitlementService` 对给定账号返回带 revision 的不可变快照：

```ts
interface EffectiveEntitlements {
  schemaVersion: number
  revision: string
  source: 'free-default' | 'trial' | 'subscription' | 'manual-grant'
  validUntil: string | null
  features: Record<string, boolean>
  limits: EffectiveLimits
}
```

推荐优先级：

1. 有效、未撤销的临时 staff/support grant。
2. active/trialing/grace subscription 对应套餐。
3. 免费默认权益。

多个 grant 合并规则必须逐字段声明：boolean 可提升；limit 默认取更宽值；`null=无限` 在 lattice 中是最高额度，只有明确允许授予 unlimited 的 permission 才能产生，不能因缺字段/深合并意外得到 null。Entitlement 不包含 risk/compliance/lifecycle restriction，计划 00 OperationPolicy 在其后取交集；任何 grant 都不能放宽这些限制。

每次 entitlement 变化：

- 在同一事务更新订阅/grant 和 `entitlement_revision`。
- 写审计与账号策略事件。
- 使服务端缓存失效。
- 异步通知 Web/客户端刷新，但正确性不依赖通知送达。

## 6. 订阅状态机

```text
incomplete → trialing/active/ended/review
trialing   → active/past_due/ended
active     → active(cancel_at_period_end=true)/past_due/paused/ended
active(cancel_at_period_end=true) → active(cancel_at_period_end=false)/ended
past_due   → active/grace/paused/ended/review
grace      → active/ended/review
paused     → active/past_due/ended/review
review     → incomplete/trialing/active/past_due/grace/paused/ended（仅依据新取得的已验签/主动核验 snapshot）
ended      → terminal；新购买创建新的 subscription row
任一 non-terminal → review（退款、争议、供应商异常或人工调查）
```

“期末取消”是 active 行上的 `cancel_at_period_end=true`，不是提前切 canceled status；在 `current_period_end`/provider confirmed end 之前继续享有 active entitlement。`incomplete` 无付费权益；`paused` 默认保持免费层并进入只读评估；`review` 保留最近已确认 entitlement 到有上限的 review deadline，超时 fail-safe 回免费/只读，具体规则按 reason family 固化。`review` 不是终态：reconciliation 必须取得 provider 当前 snapshot 后落到上表的确定状态；`ended` 才是不可复活的终态，任何迟到事件都不能把原 row 改回 review/active。

规范化状态由 provider snapshot 计算，不直接信任单个 event 名称。乱序处理采用：

- provider 提供 revision/updated time 时拒绝更旧 snapshot。
- 无可靠顺序字段时，收到关键事件后主动 `getSubscription` 获取当前状态。
- event 处理器幂等；同一状态重复写不增加 revision。

### 6.1 宽限与只读

默认策略可配置但必须固定记录：

- `past_due`：短期内保留原权益并提示更新支付方式。
- `grace`：到期前保留读写，临近结束加强通知。
- `ended`：回落免费 entitlement。若现有用量超过免费限额，账号进入 billing read-only：允许 Pull、导出、删除/缩减、支付恢复；阻止新增/扩容写入。
- 任何状态都不自动调用账号删除。

客户端错误使用 `account_read_only` 或 quota 计划的具体 code，包含 manage billing URL；不得返回 401。

## 7. Checkout 与客户门户

### 7.1 Checkout

`POST /v1/web/billing/checkout` 需要：计划 01 verified email、有效 Web Session、CSRF、计划 02 风控允许、合法 active plan/version/price mapping，且无冲突 current subscription。请求带客户端 idempotency key；服务端把 account/plan/mapping/return URL 规范化为 request hash，同 key 不同 hash 返回冲突。return URL 只能是预配置同源地址。

流程：

1. 事务锁定/创建 `billing_account_states`，确认两个槽为空，创建 `pending_provider` checkout 并 CAS 写入 `purchase_intent_id`；provider checkout ID 此时为空。Webhook、portal reconciliation 与 checkout 必须共用这把账号锁，不能仅分别依赖两张业务表的 UNIQUE。
2. 以内部 checkout ID 派生稳定 provider idempotency key，find/create billing customer；邮箱只传给经批准的 provider。
3. 调 provider 创建 session，CAS 保存 provider checkout ID/status。Provider 成功、本地崩溃时，通过 `getCheckoutByIdempotencyKey`/reconciliation 找回，不能再创建第二 session/customer；不确定结果进入 `reconciling`，继续占用唯一槽。
4. 返回短期 URL；失败可用相同内部记录重试。
5. Provider 表示 checkout 完成时先置 `completed`，仍继续占用唯一槽。Webhook/reconciler 通过受控 metadata、customer mapping 和 provider snapshot 找到对应内部 checkout，在一个事务中创建/确认 current subscription、写 `subscription_id` 并把 checkout 置 `linked`；只有这一步完成后才能接受下一次购买。无法关联、重复外部订阅或超时不明的 completed checkout 进入 review/runbook，不能仅按 `expires_at` 解锁。
6. success 页面显示“正在确认订阅”，轮询账号 context；不自行解锁。

### 7.2 客户门户

`POST /v1/web/billing/portal` 每次生成短期 provider URL，不把固定 URL 存库。用户可执行哪些更新/账单/发票/取消/恢复动作由 provider、商户主体和地区 capability 决定，不能统一承诺。回到 NoteGen 后刷新订阅 snapshot。

所有套餐变更/取消在页面明确生效时间、下期价格和是否按比例计费；具体金额以 provider 返回为准，服务端不自行估算后展示。

## 8. Webhook 安全与可靠性

- 使用 raw request body 验签；Fastify body parser 前保留原字节。
- 每个 provider 独立 path/secret，secret 支持 current/previous 轮换。
- 验签失败直接 400/401，不记录完整 payload。
- 验签成功后只做最小解析和 inbox insert，成功持久化即 2xx；业务处理由 job worker 完成。
- provider event ID 唯一；未知 event 标记 ignored 而非失败。
- PII payload 仅保存规范化所需字段或独立加密，按合规保留期清理。
- dead-letter 有告警、查看 reason、从 provider 重新获取 snapshot 后重放的工具。

不能用 success redirect、客户端提交的 customer ID 或未经核验的 price ID更新权益。

## 9. 运营与客服边界

- 运营可管理 plan version 的发布/退休，但不能修改已存在版本。
- billing staff 使用计划 00 的 `billing.read/grant/admin` permission，可查看脱敏 customer/subscription ID、账期、状态和事件处理结果；不复用 customer `isAdmin`。
- 人工 grant 必须有工单/原因、到期时间、step-up 和二次确认；永久/无限 grant 需要独立高权限/双人审批。
- 退款/争议动作默认在 provider 完成；NoteGen 只同步结果和记录内部审计。
- 客服不能查看支付方式详情，不能直接编辑订阅表。

## 10. API、Capabilities 与 UI

```text
GET  /v1/web/billing/summary
GET  /v1/web/billing/plans
POST /v1/web/billing/checkout
POST /v1/web/billing/portal
POST /v1/web/billing/cancel          -- 若不完全委托 provider portal
POST /v1/webhooks/billing/:provider
GET  /v1/web/admin/billing/events
POST /v1/web/admin/billing/events/:id/replay
```

公开 capabilities 只说明 `billing.subscription=true` 和 portal 是否可用；套餐与价格从认证/公开的专用 endpoint 获取并带 catalog revision。self-hosted 返回 capability false 且不注册 Webhook/管理路由。

账号 Web 展示当前套餐、有效期、用量、下次变更、支付问题与管理入口。NoteGen 客户端只需展示摘要和打开账号 Web，不内嵌支付 SDK。

## 11. 指标与告警

- checkout created/completed/expired（按 plan key，不按账号）。
- subscription transition、past_due、grace、ended。
- Webhook 验签失败、积压、处理延迟、重试、dead-letter。
- entitlement recompute latency/cache stale。
- billing read-only 账号数量与恢复数量。
- provider API 延迟/错误/circuit breaker。

告警：Webhook 积压超过阈值、active 订阅异常下降、provider 与内部状态对账漂移、dead-letter、宽限通知失败、人工 grant 异常增长。

## 12. 建议 PR 切片

1. **PR-04A：Catalog + Entitlement Core。** plan version、grant、effective snapshot；先用 manual fixture。
2. **PR-04B：Provider Adapter + Customer。** secret/config、customer 映射、规范化 snapshot。
3. **PR-04C：Webhook Inbox。** raw 验签、幂等、异步状态机、重放。
4. **PR-04D：Checkout/Portal。** 风控、return URL、`billing_account_states` 跨表互斥槽、completed→linked reconciliation、pending confirmation UI。
5. **PR-04E：宽限与读写限制。** quota 联动、账号事件；启用前硬依赖 12C/12F 客户端不会清 token/丢 outbox。
6. **PR-04F：运营对账。** 管理页、manual grant、provider reconciliation job。

## 13. 测试矩阵

- 重复、乱序、缺失、延迟 Webhook 最终得到 provider 当前状态。
- success redirect 在 Webhook 前到达时不提前解锁。
- 同一 idempotency key 并发 checkout 只产生一个内部 session。
- 同 key 不同 plan/return URL 冲突；两个不同 checkout 并发也不能产生两条 current subscription。
- Provider checkout 已 completed、订阅 Webhook 尚未落地时第二次 checkout 仍被唯一槽拒绝；崩溃恢复后只能关联原 purchase intent。
- provider API 成功但本地进程退出后可恢复，不重复 customer/checkout。
- plan version 不可修改；旧订阅保持原权益直到显式迁移。
- past_due/grace/ended/恢复的 limits 与客户端状态正确。
- 期末取消在 period end 前保持 active entitlement；paused/review/incomplete 的 deadline/权益不会默认无限延长；review 经核验可恢复或结束，ended 不会被迟到事件复活且新购创建新 row。
- 自托管不加载 provider secret、不暴露 endpoint/UI。
- 账号删除、邮箱换绑、退款、争议和人工 grant 的联动均有审计。
- Webhook/日志/管理页无卡数据和不必要 PII。

## 14. 上线、回滚与验收

- 先完成 05A/B 支付数据 inventory/retention/policy 与 12 客户端 read-only gate，再上线 entitlement core，以有时限 internal grants 验证配额。
- Provider Webhook 先 shadow 处理并与 provider dashboard 对账。
- Checkout 仅内部/邀请 cohort；任何真实付款前，05D 必须已经验收 billing customer/subscription/checkout/account-state 的删除或最小脱钩 handler、deletion-generation guard、晚到 Webhook fencing 和 provider quiet-window reconciliation，且相应恢复演练通过。只有 identity/sync/blob 删除不满足计费上线门槛。
- 使用 provider sandbox/test clock 演练完整月/年周期、past_due、取消与恢复，不把自然等待一年作为发布条件。
- hard downgrade 最后启用；此前只 warning。
- 回滚可关闭 checkout/portal 和 webhook worker，但保留 inbox 接收与现有 entitlement 快照，避免付费用户突然降级。

验收条件：任何账号的 entitlement 都能解释来源、版本、有效期和限制；支付平台重复/乱序事件不重复权益；故障不会删除数据或使所有同步离线；取消/欠费/恢复均有用户可理解的路径；删除主体后晚到计费事件不能重建账号、current subscription 或 entitlement。

## 15. 开放问题

- 首发 BillingProvider 与 merchant-of-record/税务责任。
- 是否首发月付、年付、试用和优惠码；建议先一个免费层 + 一个月付 + 一个年付，避免状态组合爆炸。
- 退款后立即结束权益还是进入人工 review，应与退款政策一致并经合规确认。
