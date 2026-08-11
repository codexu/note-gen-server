# 00：共享部署策略与能力基础技术规格

- 状态：Draft
- 日期：2026-08-11
- 适用形态：`hosted` 与 `self-hosted`
- 面向读者：服务端、账号 Web、NoteGen 客户端开发者
- 前置依赖：无
- 交付结果：后续所有账号、运营和自托管功能拥有同一个可强制执行的策略、能力、任务和审计基础

## 1. 问题

当前 `deploymentMode` 已经进入配置、capabilities 和 Web 徽标，但没有改变注册、管理员授予、路由暴露或后台能力。继续直接在各路由中写 `if (config.deploymentMode === ...)` 会迅速形成难以测试的组合分支，也无法表达“模式允许，但驱动未配置”“实例能力已启用，但当前账号没有权益”等不同状态。

更紧急的问题是：账号注册会把没有现存管理员时创建的账号设为管理员。自托管首次初始化需要这一行为，官方托管公开注册绝不能继承它。

## 2. 目标

- 将 deployment mode 固化为实例级策略，不允许数据库被意外换模式启动。
- 建立有类型、可验证、可发现、可审计的 capability registry。
- 严格区分实例能力、商业权益、账号限制和最终操作决策。
- 在路由与领域服务两层执行能力和账号限制。
- 为邮件、支付、导出、备份等功能提供可恢复的通用 Job/Outbox。
- 保持现有同步协议、`registrationMode` 和旧客户端可用。
- 为 hosted staff 与 self-hosted 实例管理员建立互不复用的身份、权限和创建路径。
- 提供共享 step-up、维护写屏障和静态限额接口，避免后续计划形成循环依赖。

## 3. 非目标

- 本计划不实现邮箱验证、支付、配额、工单或完整备份。
- 不重写同步引擎，也不选择新的队列、缓存或事件总线。
- 不提供任意脚本在运行时修改安全关键能力的万能开关。
- 不承诺 deployment mode 的原地双向迁移；一期把它视为数据库实例不可变属性。

## 4. 当前实现锚点

- `apps/server/src/config.ts`：已有 `DEPLOYMENT_MODE=self-hosted|hosted` 与 `AppConfig.deploymentMode`。
- `apps/server/src/routes/capabilities.ts`：已有公开能力发现、限制和 legacy `registrationMode`。
- `apps/server/src/services.ts` 与 `apps/server/src/server.ts`：适合注入 policy、capability、job runner 等共享依赖。
- `apps/server/src/app.ts`：负责路由注册、错误格式、限流和日志脱敏，可安装 route guard。
- `apps/server/src/database/schema.ts`：已有 `server_metadata`、`admin_jobs`、`admin_audit_logs`。
- `apps/server/src/auth/service.ts`：当前自动授予首位管理员，需按部署策略拆开。
- `src/lib/sync/note-gen-server.ts`（NoteGen 客户端）：已读取 capabilities，并保存与 `instanceId` 绑定的会话。

## 5. 核心设计

### 5.1 固化 deployment mode

`deployment_settings` singleton 是 deployment mode 的唯一长期事实来源。`server_metadata['deployment_mode']` 只作为兼容迁移输入，完成迁移后不再与 singleton 双写。Schema migration 只建表；启动期 locked reconciliation 执行：

1. 读取环境配置中的 `DEPLOYMENT_MODE`。
2. 读取 `deployment_settings.deployment_mode`；若尚不存在，可读取 legacy metadata 作为一次性候选值。
3. singleton 不存在时，在事务和 advisory lock 内校验候选值后写入；legacy metadata 随后只保留迁移审计，不再读取。
4. singleton 存在但环境值不一致时进入 `StartupSafetyGate`：live/受限诊断可用，ready 失败；普通 HTTP、WebSocket upgrade、业务 worker 和内部定时任务全部拒绝启动/执行。

`StartupSafetyGate` 必须安装在路由分发和 worker start 之前，使用显式 allowlist，仅允许 `/health/live`、安全的 readiness 原因和本机/受控管理员诊断。不能把“负载均衡器会尊重 readiness”当作安全边界。Hosted 必需 provider 静态配置缺失时使用同一 gate；self-hosted 可选 provider 缺失不触发全局 gate。

```text
deployment_settings
  id boolean pk check(id = true)
  deployment_mode enum('hosted','self-hosted') not null
  registration_policy enum('bootstrap','disabled','invitation','public') not null
  self_hosted_lifecycle enum('uninitialized','ready') nullable
  admin_repair_required boolean not null default false
  hosted_control_plane_state enum('provisioning_required','ready') nullable
  instance_auth_epoch bigint not null default 1 check(instance_auth_epoch > 0)
  token_not_before timestamptz not null
  auth_epoch_enforced boolean not null default false
  configuration_revision bigint not null
  initialized_at, initialized_by_account_id nullable
  created_at, updated_at
```

Mode 决定哪些 lifecycle 列必须为空/非空；数据库 CHECK 保证 hosted 不进入 self-hosted bootstrap。`admin_repair_required` 是 degraded 诊断，不把已运行实例退回 uninitialized。Hosted control-plane provisioning 与客户账号生命周期分离。

`instance_auth_epoch` 与 `token_not_before` 是实例级认证安全事实，不是普通配置 revision，也不能由 capability override 修改。前者隔离恢复前后的凭据代次，后者阻断历史代次碰撞或时钟/快照回退带来的旧凭据；具体签发、校验、恢复和兼容切换见 5.4.1。既有实例 additive backfill 为 epoch=1、`token_not_before`=固定历史哨兵时间、enforced=false，避免建列即撤销全部会话；新实例在创建 singleton 时写数据库当前时间并直接 enforced=true。`auth_epoch_enforced=false` 只允许出现在兼容迁移窗口，任何 preserve/clone restore 都要求其已为 true。

一期不支持仅改环境变量切换模式。未来如确需迁移，应另写迁移规格，至少处理管理员来源、邮箱身份、订阅、配额、客服角色和合规状态。

### 5.2 有类型的能力目录

新增单一 `CapabilityRegistry`，能力 ID 使用字符串字面量联合类型；每项元数据至少包含：

```ts
interface CapabilityDefinition {
  id: CapabilityId
  supportedModes: readonly DeploymentMode[]
  defaultByMode: Record<DeploymentMode, boolean>
  requires: readonly CapabilityId[]
  requiredConfig: readonly ConfigKey[]
  exposure: 'public' | 'authenticated' | 'admin-only'
  overrideable: boolean
  availabilitySource: 'configuration' | 'lifecycle' | 'registration-policy'
}
```

`defaultByMode` 的值只能是当前代码发布的布尔启动默认值。README 中的“目标产品策略”不直接序列化到该字段；“不支持”由 `supportedModes` 表达，生命周期由 `availabilitySource` 表达，驱动类型与配置完整性由 `requiredConfig` 表达。除 `operations.webBootstrap` 这类新实例必须可达且不可 override 的生命周期控制面外，新增账号服务 capability 首次发布一律 `defaultByMode=false`，待对应计划的激活门槛完成后由生产配置显式启用并递增配置 revision。不得在后续代码版本中仅修改默认值，导致既有实例静默开启能力。

解析结果分为：

- `enabled`：部署者请求启用且模式允许。
- `configured`：所有必要驱动和秘密均通过启动校验。
- `available`：Resolver 对 enabled、configured、依赖和当前持久 lifecycle/策略求交后的最终实例可用性；这是客户端能否展示实例功能的字段。
- `healthy`：最近一次依赖检查正常，仅用于状态和告警。
- `reasonCode`：仅管理员可见，例如 `driver_missing`、`dependency_disabled`。

Resolver 按 `available = enabled && configured && dependenciesSatisfied && lifecycleOrPolicyAllows` 计算最终值，但它仍不是账号授权。`healthy=false` 不自动改写 enabled/configured/available；最终动作是否 fail-open、fail-closed 或降级由 5.5 的逐操作策略决定，避免 UI 抖动又避免公开注册在风控故障时误开放。

建议通过显式的 `CAPABILITIES_ENABLE`、`CAPABILITIES_DISABLE` 逗号列表覆盖模式默认值。未知 ID、同一 ID 同时启停、依赖环和跨模式非法能力属于结构错误，进程启动失败。`overrideable=false` 的生命周期能力拒绝任何环境覆盖：尤其 `operations.webBootstrap` 只能在数据库 lifecycle=uninitialized 时 available，初始化后单调关闭，配置不能重开。缺少 provider/secret 时解析为 `configured=false`：hosted 发布所必需的能力触发 StartupSafetyGate；self-hosted 可选 SMTP 等能力保持同步服务 ready，但具体流程禁用并告警。提供 `capabilities explain <id>` CLI 输出解析来源，但不打印秘密。

### 5.3 部署策略不是能力开关

新增 `DeploymentPolicy`，集中回答不能仅由单个 capability 表达的问题：

- 注册策略：`bootstrap | disabled | invitation | public`。
- 客户账号管理员策略：`bootstrap-first-admin | none`。
- 身份要求：`username-allowed | email-required`。
- 超额行为：`safety-limit-only | entitlement-enforced`。
- 官方运维路由是否对实例管理员暴露。

推荐规则：

- self-hosted 未初始化时为 `bootstrap-first-admin`，且只有计划 07 的受限 `BootstrapService` 可以显式创建首位 `isAdmin=true` 账号；进入 ready 后普通账号创建策略为 `none`，后续管理员授予走已认证管理操作。
- hosted 客户账号策略恒为 `none`，任何客户注册或 provisioning primitive 都不得设置 `isAdmin=true`。平台运维身份来自 5.8 的独立 staff realm，staff provisioning 不是客户账号管理员策略。
- 环境变量 `REGISTRATION_MODE` 只作为 self-hosted 兼容迁移输入：`open → public`，`closed → disabled`；新旧显式配置冲突时拒绝启动。
- hosted 首次迁移无条件写 `registration_policy=disabled`。若发现 legacy `REGISTRATION_MODE=open`，StartupSafetyGate 保持业务关闭并要求运维显式确认迁移；只有邮箱验证、风控和最低合规门槛均 configured/healthy 且操作员再次显式启用后才能变为 public。
- API 响应字段 `registrationMode` 是兼容投影，不是环境配置名：`public → open`，其余策略对旧客户端均投影为 `closed`。

### 5.4 能力发现与账号上下文

内部 dotted `CapabilityId`、schema-2 wire 字段与 legacy camelCase `features` 必须有一张代码内显式映射表，不能靠字符串变换猜测。保留现有 `/v1/capabilities`，只做增量扩展：

```json
{
  "deploymentMode": "self-hosted",
  "registrationMode": "closed",
  "capabilitySchema": 2,
  "instanceCapabilityRevision": "17",
  "registrationPolicyRevision": "4",
  "requiredSyncFeatures": [],
  "registration": {
    "policy": "invitation",
    "methods": ["password", "invitation"],
    "emailVerificationRequired": false
  },
  "instanceCapabilities": {
    "identity.email": false,
    "registration.invitation": true,
    "operations.webBootstrap": false
  },
  "features": {
    "accountContext": true,
    "invitationRegistration": true
  }
}
```

规范如下：

- `instanceCapabilities` 是 schema-2 的公共、布尔 `available` 投影；已知 ID 缺失按 false，未知 ID 新客户端忽略。内部 configured/healthy/reasonCode 只进管理员诊断。
- `features` 是明确列举的 legacy alias；一个发布窗口内保持原语义，不能把它变成任意 dotted map。
- `requiredSyncFeatures` 是独立的同步协议硬要求集合，不属于 Capability Registry。`syncEpochFencing` 只能按“服务端先支持但不要求 → 客户端普及/演练 → 服务端标记 required”的协议门槛推进；一旦 required，缺失该 feature 的客户端 fail-closed。
- 计划 10 的 dotted `operations.preserveRestore` 可显式映射 legacy `features.preserveRestore`，但其 resolver 必须内部验证 `auth_epoch_enforced=true`、`syncEpochFencing` required、最低 binary 和恢复演练，任何环境 override 都不能越过这些硬门槛。
- `capabilitySchema` 只在 wire 结构不兼容时变化；实例配置变化只递增 `instanceCapabilityRevision`，注册策略变化只递增 `registrationPolicyRevision`。
- lifecycle 派生能力也出现在 `instanceCapabilities`，但不能被客户端或环境变量写回。

新增认证接口 `GET /v1/account/context`，由客户端和账号 Web 共用，返回：

- 账号身份摘要和生命周期状态。
- 商业 entitlements（features/limits/source/revision），不包含安全或合规限制。
- 用量与限制摘要；未启用配额时标记 `enforced: false`。
- 独立 `restrictions`（identity/risk/compliance/account lifecycle），每项包含 scope、effect、reasonCode、expiresAt/actionUrl。
- 服务端计算的逐操作 actions，例如 `sync.push`、`sync.pull`、`blob.upload`、`account.export` 的 allow/challenge/read-only/deny 结果。
- 独立 `accountContextRevision`；任一 entitlement/restriction/action 变化都更新，但不冒充实例 capability revision。

未认证 capabilities 不返回账号套餐、封禁原因、邮箱或内部配置错误。

### 5.4.1 实例认证代次与恢复限制

所有可继续换取或代表账号权限的凭据都必须绑定 `deployment_settings.instance_auth_epoch`：

- Access JWT 携带 `instanceAuthEpoch` 与服务端签发时间；Refresh Token、Web Session、设备授权/exchange、pairing 等持久记录保存 `issued_instance_auth_epoch` 与 `issued_at`。
- 每次 HTTP 鉴权、WebSocket 建连/重认证、refresh rotation、Web Session 校验和设备授权 exchange 都读取权威 singleton，要求凭据 epoch 严格相等且 `issued_at >= token_not_before`；同时拒绝超过允许时钟偏差的未来 `issued_at`。进程缓存必须按 auth-state revision/通知立即失效；不得让无界 TTL 的本地缓存继续接受恢复前凭据。
- 离线恢复先证明目标 binary 达到最低认证契约并停止全部旧进程；随后在 maintenance owner 持锁的一个数据库事务内覆盖备份值，执行 `instance_auth_epoch = instance_auth_epoch + 1`、`token_not_before = now()`、`auth_epoch_enforced = true`，并撤销全部 Refresh Token、Web Session、待处理设备授权/pairing、step-up grant、邀请、challenge 和 action token。事务提交后才允许新 binary 启动；旧 Access JWT 因 epoch/not-before 校验立即失效，不能只等待自然过期，也不能让旧备份中的 enforced=false 重开兼容读取。
- 普通密码重置或邮箱换绑仍可使用计划 01 的账号级 credential epoch；账号级代次只能进一步收紧，不能代替实例恢复代次。

恢复事务还必须为备份中恢复出的每个账号创建持久 `AccountRestriction(reasonCode='credential_review_required')`。该 restriction 的优先级属于硬安全 deny：operator 明确处理前禁止密码/TOTP 登录、refresh、设备授权和全部 domain write；旧远程凭据已由实例 epoch 失效，唯一允许的处置入口是本机/容器 TTY 的恢复控制面。Entitlement、staff grant、HTTP 管理 API 或 capability override 均不能绕过。operator 必须逐账号选择强制重置/重新登记认证因子或明确接受恢复凭据风险，记录不可删除审计；清除 restriction 与递增 `accountContextRevision` 在同一事务完成。

兼容上线采用硬序列：先 additive 增加 claim/列并让所有 binary 签发新 epoch，验证所有鉴权入口已经双读；兼容期可暂时读取 legacy 凭据，但 restore capability 必须保持关闭。随后撤销或迁移无 epoch 的持久凭据、等待旧 Access Token 最大 TTL，停止并确认所有旧进程退出，再原子切换 `auth_epoch_enforced=true`。切换后缺失 epoch 的凭据一律拒绝，并把该版本记为认证契约最低 binary；不得回退到不校验实例 epoch 的版本。

### 5.5 双层 Guard

提供两个复用入口：

1. Fastify route guard：尽早拒绝整个功能未启用、部署模式不允许或缺少认证的请求。
2. Domain policy guard：在 `AuthService`、同步写入、Blob 上传、管理员操作等真实变更事务前再次判断，防止内部调用、未来新路由或 Web 测试数据绕过。

最终决策固定为四层，禁止后续计划越层读取：

1. `InstanceCapability`：代码/mode/config/lifecycle/provider 是否允许该实例功能。
2. `EffectiveEntitlements`：商业 features/limits；只能提供或收紧商业额度，不携带 risk/compliance restriction。
3. `AccountRestrictions`：邮箱验证、风险、合规、停用/删除等独立限制。
4. `OperationPolicy`：按具体 operation 取前三层交集，再叠加维护 fencing、技术安全上限和 dependency failure policy。

优先级为硬安全/生命周期 deny → challenge/step-up → read-only/只允许减量 → throttle → allow。Entitlement 或 staff grant 永远不能放宽安全、法律保留、账号删除和维护 fencing。每个领域计划必须登记 operation scope；客户端不得根据粗粒度账号状态猜 Pull、导出或删除是否可用。

Guard 返回统一决策：

```ts
type PolicyDecision =
  | { effect: 'allow' }
  | {
      effect: 'deny' | 'challenge' | 'read-only' | 'throttle'
      code: PolicyReasonCode
      statusCode: 403 | 409 | 423 | 429 | 503
      retryable: boolean
      retryAfterSeconds?: number
      details: Record<string, string | number | boolean>
    }
```

HTTP adapter 同时生成规范 `Retry-After` header；OpenAPI/shared contract 登记 423/429/503。同步批处理中的限制转换为每条 command 的稳定 rejection；Blob、认证和 Web 操作继续使用标准 HTTP 错误。所有写入口使用同一决策器。

依赖故障策略至少冻结以下默认值，领域计划只能显式收紧/细化：

| Operation | 依赖不健康时 | 既有核心能力 |
| --- | --- | --- |
| `registration.public` / `billing.checkout` | fail-closed，503/可重试 | 登录、Pull 不受牵连 |
| 邮件 outbox enqueue | 接受入队，投递 degraded | 不同步等待 provider |
| `sync.pull` / 已授权下载 | 不调用外部风控/计费 provider | 既有 operation restriction 可拒绝；provider outage 本身不新增拒绝 |
| `sync.push` / Blob | 使用本地 restriction、quota 和静态上限 | provider 故障本身不全站停写 |

共享 `EffectiveLimitsProvider` 让计划 03 不依赖计划 04：

```ts
interface EffectiveLimits {
  storageBytes: bigint | null
  retainedStorageBytes: bigint | null
  devices: number | null
  workspaces: number | null
  monthlyIngressBytes: bigint | null
  monthlyEgressBytes: bigint | null
  enforcement: 'disabled' | 'observe' | 'soft' | 'hard'
  sourceRevision: string
}

interface EffectiveLimitsProvider {
  resolve(accountId: string, tx: DatabaseTransaction): Promise<{
    revision: string
    limits: EffectiveLimits
    source: 'self-hosted-disabled' | 'hosted-static-default' | 'entitlement'
  }>
}
```

00/03 先提供 self-hosted disabled 与 hosted static-free provider；04 的 `EntitlementService` 以后实现同一接口。Hard enforcement 必须在写事务内校验数据库 revision/CAS，不能只信任进程缓存。

### 5.5.1 同步双栈收口门槛

账号计量/保留不能把 legacy `changes/operations` 与 durable `sync_v2_events/commands` 当作两份等价事实。先记录 ADR：durable commands/events 是新客户端 canonical log；legacy 仅作为兼容入口，Web 测试数据迁到 durable。兼容期所有对象/CRDT/Blob 写必须经过共同 `SyncWritePolicyFacade`，usage/audit 写独立领域 ledger，而不是从任一日志事后猜测。

在完全停写 legacy 前，retention/GC/对账同时覆盖两套表并按对象/command 幂等去重；`workspaces.latest_sequence` 的推进只有一个事务 owner。未建模/未使用的 `collaboration_updates` 先标 quarantine，不接入新配额/合规逻辑，另做删除或正式建模 migration。完成 writer telemetry 为零和旧客户端兼容窗口后，再独立 contract migration 移除 legacy。

### 5.6 通用后台任务与 Outbox

当前备份任务以进程内 `void` 启动，服务重启后统一标记失败。邮箱、支付 Webhook、数据导出和备份需要可恢复语义，因此新增通用任务执行器，继续以 PostgreSQL 为协调层。

建议新增：

```text
background_jobs
  id, type, category, status, payload, payload_version, request_hash,
  queue_generation, min_handler_version, result, error_code,
  idempotency_key, attempt, max_attempts, scheduled_at,
  locked_at, locked_by, lease_expires_at,
  actor_account_id nullable, target_account_id nullable,
  created_at, started_at, finished_at

outbox_messages
  id, channel, template_or_event, recipient_ref, payload, payload_version,
  secret_payload_ref nullable, request_hash,
  idempotency_key, status, attempts, next_attempt_at,
  provider_message_id, last_error_code, created_at, sent_at
```

执行约束：

- 业务状态与 job/outbox 在同一数据库事务创建。
- Worker 使用 `FOR UPDATE SKIP LOCKED` 领取，带实例 ID 和可过期 lease。
- 重试采用带抖动的指数退避；永久错误进入 `dead_letter`，不无限重试。
- 内部状态转换与 handler 按 idempotency key + request hash 设计；同 key 不同载荷返回冲突。
- 数据库 job/outbox 提供 at-least-once 执行。只有外部 provider 明确支持幂等键时才承诺效果去重；SMTP 等不可幂等系统允许安全重复/`delivery_unknown`，不得宣称 exactly-once。
- 管理员可以查看、重试 dead-letter，但不能编辑原始安全载荷。
- 对邮件、支付、合规、备份分别设置保留期，维护任务小批量清理。

现有 `admin_jobs` 和 `admin_backups` 不能直接交给新 runner。当前旧启动恢复会把 pending/running job 批量标失败，先发布 compatibility/fencing release：

1. 旧 recovery 只处理显式 legacy type/generation，未知 type 永不改状态；旧 worker claim 同样使用 allowlist。
2. 增加 payload version、queue generation、min handler version 并把存量任务标为 legacy；此发布尚不创建新类型。
3. 部署所有实例后停止旧 worker，确认 lease 清零，再启用只 claim 兼容 generation/version 的新 runner。
4. 每个旧任务类型分别双读/迁移/切换；兼容窗口内不删旧表。
5. 回滚先停止新 worker与新 enqueue，drain/冻结新 generation，再启动只认识旧 generation 的 binary；不可把未知任务交给旧 recovery。

Worker 启动时公布 handler allowlist/version；不满足 `min_handler_version` 的任务保持 queued 并告警。具体表名可在实现时调整，但不得继续新增不可恢复的 fire-and-forget 任务。

邮件适配器契约也放在共享层，避免 self-hosted SMTP 反向依赖 hosted 身份计划：

```ts
interface MailProvider {
  send(message: {
    idempotencyKey: string
    to: string
    template: MailTemplateId
    locale: SupportedLocale
    variables: Record<string, string>
  }): Promise<{ providerMessageId: string | null }>
}
```

Capability Registry 使用传输无关的 `mail.delivery` 表示可用邮件投递器；`operations.smtpAdmin` 仅支持 self-hosted、仅向管理员暴露状态、测试与队列入口，一期 SMTP 配置仍来自环境/secret。Hosted 托管 provider 可以让 `mail.delivery` configured，但永远不能让 `operations.smtpAdmin` available。身份、邀请、备份和升级模块只写 outbox/template，不直接引用 SMTP 或托管供应商 SDK；`MailTemplateId`、locale 和可重试错误分类属于共享 contract。Action token plaintext 若邮件投递必须使用，只能进入独立 key 加密的 `secret_payload_ref`，管理 API 不可读取；发送或作废后擦除。重发 dead-letter 安全链接时撤销旧 token、生成新 token，不长期保留可解密明文。

### 5.7 审计事件规范

扩展现有审计表或新增统一表，支持 actor 类型：`account | staff | system | webhook`。事件字段至少包括：

- `action`：稳定、点分命名，例如 `account.email.changed`。
- `actorType/actorId`、`targetType/targetId`。
- `requestId`、来源 IP 的受控表示、user agent 摘要。
- `metadata`：只保存枚举、数量、原因码、外部对象 ID 的脱敏值。
- `occurredAt` 与可选 `jobId`。

密码、令牌、完整邮箱、密文、邮件正文和完整 Webhook payload 不进入 metadata。安全关键审计与业务事务同提交；仅低风险可观测事件允许异步。

### 5.8 Staff 身份、权限与共享 Step-up

Hosted 运营人员不使用客户 `accounts`/`isAdmin`。00 提供独立 staff realm，后续风控、账单、合规、客服只登记权限，不各建登录体系：

```text
staff_principals
  id uuid pk
  external_issuer, external_subject, display_name, email
  disabled_at, last_login_at nullable
  unique(external_issuer, external_subject)

staff_sessions
  id uuid pk
  staff_id uuid
  auth_strength text
  expires_at, revoked_at nullable
  created_at, last_seen_at

staff_role_assignments
  staff_id uuid
  role_key text
  scope jsonb
  expires_at nullable
  assigned_by_staff_id, created_at
```

`role_key` 不是跨计划封闭数据库 enum；代码中的 typed permission registry 才是授权事实。首批权限至少覆盖 `risk.read/manage/admin`、`billing.read/grant/admin`、`compliance.request.process`、`legal_hold.read/manage/approve`、`support.read/write/diagnostics`、`platform.provision`。可提供 security analyst/admin、billing support/admin、compliance operator、legal-hold admin、support read/write 等默认角色模板；`platform_admin` 不天然绕过 legal hold 双人审批。

Staff 使用受限 OIDC/SSO、独立 issuer/audience/cookie/signing key，校验 state/nonce/PKCE 与 `acr/amr`；MFA、短 Session、IdP disable 传播和高敏 step-up 是上线门槛。Hosted 客户账号永不通过 `isAdmin` 获得这些权限。Self-hosted `isAdmin` 只表示该实例管理员，不进入 staff realm。

共享 `WebStepUpService` 同时服务 self-hosted admin、客户高敏动作和 staff：

```text
step_up_grants
  id uuid pk
  token_digest text not null
  digest_key_id text not null
  actor_type enum('account','staff')
  actor_id uuid
  session_id uuid
  action_audience text
  auth_methods text[]
  issued_at, expires_at, consumed_at, revoked_at nullable
  request_hash text
  unique(token_digest)
```

- 默认 TTL 5 分钟；下载备份、legal hold、账号删除等 destructive action 使用一次性 grant。
- audience、actor、session、instance、request hash 必须匹配；Session 撤销时 grant 同时失效。
- 账号已启用 TOTP 时要求密码/最近强认证 + TOTP；staff 使用 IdP MFA/强 `acr`，权限校验仍独立执行。
- Step-up endpoint 受 CSRF/origin/限流保护，返回的高熵 opaque token 只保存带 `digest_key_id` 的 keyed digest，并通过唯一索引查找，不进入 URL、日志或诊断；`request_hash` 只绑定目标动作载荷，不能兼作 token digest。验证与一次性 `consumed_at` 更新必须在同一事务完成。

### 5.9 共享维护模式与写入 Fencing

计划 10 与 11 共同依赖 `MaintenanceModeCoordinator`；它与现有清理/GC 的 `RetentionMaintenanceService` 明确分名：

```text
maintenance_state
  id boolean pk check(id = true)
  mode enum('normal','read_only','write_drain','offline')
  reason_code text
  generation uuid
  revision bigint
  owner_type enum('system','backup','upgrade','restore') nullable
  owner_ref text nullable
  lease_expires_at nullable
  irreversible boolean
  starts_at, expected_end_at, updated_at nullable

maintenance_instance_acks
  instance_id text
  generation uuid
  revision bigint
  acked_at timestamptz
```

安全屏障不依赖缓存通知：每个业务写事务先取得固定 advisory key 的 transaction-level shared lock，再读取 mode/generation；协调器用 exclusive lock 原子切换 generation，因此已开始写入会 drain，切换后的写入看到新状态并拒绝。实例 ack 用于观察和等待 WebSocket/worker 收敛，不替代数据库 fencing。

- `read_only` 允许公开发现、已有 Access/Refresh/Web Session 的受控读取与必要 refresh rotation、Pull/下载/导出；禁止密码登录产生新设备、新 Session、普通 domain write。
- `write_drain` 在 read_only 基础上等待所有共享写锁、Blob lease 和普通 job checkpoint 清零。
- `offline` 只允许 health、维护/恢复控制面；ready=false。
- 维护 owner 仅可更新自己的 lease/progress/manifest 和解除状态，不能借 system principal 绕过对象、账号或 Blob 写限制；backup job 因此不会被自己的 write-drain 锁死。
- WebSocket 每条写消息进入同一 fenced transaction；generation 切换时主动发送维护事件并关闭仍可写的旧连接。
- 可恢复维护有 owner lease + 明确 CLI recover；irreversible migration/restore 不自动超时回 normal，必须人工核验。

## 6. 数据库迁移计划

建议分为可独立回滚的 migration：

1. 新增权威 `deployment_settings`，包括 additive 的实例 auth epoch/not-before/enforcement 字段；启动期 reconciliation 从 legacy metadata/env 一次性迁移，随后停止双读。
2. 新增 StartupSafetyGate、maintenance/step-up/staff/audit 基础表，但保持新能力关闭。
3. 先发布 legacy job fencing compatibility，再新增带 generation/payload version 的 jobs/outbox 表与索引。
4. self-hosted 才可从 `REGISTRATION_MODE` 派生初始策略；hosted 强制 disabled 并要求显式确认旧 open 配置。
5. 先让全部账号创建 primitive 理解 `bootstrap-first-admin | none`，保持注册关闭并清空旧进程后，再把 hosted 客户账号策略切换为 none；平台人员只从 staff provisioning 创建，不自动回写/提升已有客户账号。切换属于安全契约 migration，不受 capability 开关控制。
6. additive 增加各类凭据的 instance auth epoch/issued-at 字段并完成兼容签发；旧凭据清退且所有实例达到最低认证 binary 后，才切换 `auth_epoch_enforced=true`。恢复能力在此之前保持关闭。
7. 引入账号上下文 revision 和最小生命周期字段，但不提前创建各功能私有表。

所有 migration 先 add/backfill/read，再启用约束；不得在同一发布中删除旧字段。既有数据库第一次运行时默认记录当前 `DEPLOYMENT_MODE`，不会默认为 hosted。

## 7. API、Web 与客户端任务

### 7.1 服务端

- 新建 `deployment/` 或 `policy/` 模块，禁止业务层直接到处读取环境变量。
- 在 `services.ts` 注入 registry、policy、account context 和 job runner。
- 为 capabilities、账号上下文和管理员能力诊断增加 TypeBox schema 与共享 contract。
- 在注册、设备会话、同步 command、Blob 上传、后台写操作接入 Guard。
- 在 Access/Refresh/Web Session、WebSocket 与设备授权的签发和每次鉴权中接入 instance auth epoch/not-before，并提供仅本机可用的 credential review 恢复命令。
- 在 HTTP、WebSocket、worker start 安装 StartupSafetyGate；readiness 只是其可观察投影，不是唯一执行点。
- 提供 staff OIDC/session/permission、WebStepUpService、EffectiveLimitsProvider 和 MaintenanceModeCoordinator 基础实现。

### 7.2 账号 Web

- 根据结构化注册策略显示入口，不再仅凭 `registrationMode`。
- 管理员配置页展示 capability 的 enabled/configured/available/healthy/reasonCode 与来源 revision。
- hosted 不显示本机备份、Setup Token 等不允许能力。
- 所有按钮仍以服务端 403/409 为最终事实，并显示 `requestId`。

### 7.3 NoteGen 客户端

- 扩展 `ServerCapabilities`，保留所有字段可选以兼容旧服务端。
- 连接前读取注册方法；旧服务端回退到 `registrationMode + setupToken`。
- 登录后缓存账号上下文的短期副本，只用于 UI；每次写仍接受服务端判定。
- 对 `account_restricted`、`quota_exceeded`、`account_read_only` 显示持久但不丢弃 outbox 的状态。

## 8. 建议 PR 切片

1. **PR-00A：权威模式与 StartupSafetyGate。** singleton/reconciliation、HTTP/WS/worker allowlist、readiness 和诊断。
2. **PR-00B：Capability Wire/Registry。** 类型目录、override/lifecycle、revision、legacy alias 映射。
3. **PR-00C：Operation Policy + Sync Write Facade。** 四层决策、错误 contract、注册策略、static limits provider、legacy/durable 双栈共同 guard 与 canonical-log ADR。
4. **PR-00D：身份权限基础。** Staff realm/permission registry、带 token digest 的共享 step-up、hosted 客户 admin 隔离、instance auth epoch 签发/校验与 credential-review restriction。
5. **PR-00E：Maintenance Fencing。** coordinator、advisory write barrier、instance ack、WS/worker 集成。
6. **PR-00F：Legacy Job Fencing。** 先限制旧 recovery/claim，为滚动迁移建立 generation 边界。
7. **PR-00G：Durable Job/Outbox。** versioned payload、lease、at-least-once、dead-letter、状态 API。
8. **PR-00H：Web/客户端兼容。** 能力诊断、发现顺序、注册入口和结构化限制状态。

Additive Schema、wire contract 和普通功能 PR 应能在 capability 默认关闭时部署；不要把所有基础改动压成一次发布。Hosted 客户 admin 隔离、`auth_epoch_enforced` 和 job generation 切换是安全/兼容契约 cutover，不是 capability：必须分别满足最低兼容 binary、停止旧 writer/worker、持久状态切换和回滚下限，不能用“关闭 capability”伪装成可回退。

## 9. 测试矩阵

- 新库分别以两种 mode 启动并固化；已有库升级不改变当前 mode。
- 环境 mode 与数据库不一致时 HTTP 业务读写、WS 和 worker 均被 StartupSafetyGate 拒绝，不能只验证 ready。
- hosted 无论空库还是“所有管理员已停用”，普通注册都永远不是管理员；平台权限只能由 staff provisioning 创建。
- admin 策略切换时混跑的旧账号 writer 已被停止；切换后启动低于认证/管理员契约下限的 binary 会被发布流程阻断，数据库中的 hosted 策略仍为 none。
- hosted 发现 legacy `REGISTRATION_MODE=open` 时不会自动开放；self-hosted 兼容映射正确。
- 能力依赖缺失、未知 ID、冲突覆盖、跨模式能力在启动时得到确定错误。
- 初始化完成后环境 override 无法重新打开 web bootstrap。
- route guard 与 service guard 对内部调用和 HTTP 调用给出同一结果。
- 423/429/503、Retry-After、command rejection 与账号 context action 使用同一 reason code。
- 旧客户端仍可连接；旧服务端响应缺少新字段时新客户端回退正确。
- maintenance 切换等待既有写事务，切换后 HTTP/WS/worker 新写均被 fence；owner 只能做最小控制面更新。
- 两个实例并发领取 job 时只有一个 lease；lease 到期后 at-least-once 恢复，未知 generation/version 不被领取。
- 外部调用各崩溃点不丢业务意图；支持幂等的 provider 不重复效果，不支持幂等的邮件进入重复安全/`delivery_unknown` 路径。
- staff 权限、step-up audience/TTL/一次性消费和双人 legal-hold 边界不可由 customer admin 绕过。
- Step-up opaque token 只能凭 digest 查找，request hash 不能被当作 token；同一 token 的并发消费只有一个事务成功。
- Access/Refresh/Web Session、WebSocket 和设备授权都拒绝 epoch 不等或早于 token-not-before 的凭据；恢复事务递增 epoch 后，所有旧凭据立即失败。
- 恢复账号在 `credential_review_required` 清除前不能密码/TOTP 登录、换取新凭据或写入；HTTP/staff/capability 均不能绕过，仅本机恢复命令可审计处置。
- 审计、日志和管理 API 不泄露秘密或敏感 payload。

## 10. 上线与回滚

上线顺序：

1. 先部署 compatibility binary：mode singleton、StartupSafetyGate、legacy job allowlist、`bootstrap-first-admin | none` 的账号创建代码，以及 auth epoch additive 签发/双读；保持注册、恢复和所有新能力关闭，不创建新 generation job。
2. 验证两种 mode 的公共发现、全局 gate、readiness、旧客户端连接，以及所有 HTTP/Web/设备/WS 鉴权入口都能处理新 epoch。
3. 保持注册关闭，停止并确认所有 pre-00D 账号 writer 退出；再切换 hosted 客户管理员策略为 none。该安全切换建立最低管理员契约 binary，之后不能回退到仍会自动提权的版本。
4. 撤销/迁移无 epoch 的持久凭据、等待旧 Access Token 最大 TTL，停止旧认证进程后切换 `auth_epoch_enforced=true`；这建立最低认证契约 binary，之后才允许计划 10 的 restore。
5. 上线 staff/step-up、maintenance fencing 和 static limits provider；先 observe，并验证 credential-review 本机处置流程。
6. 停止旧 worker并确认 generation 边界后启用新 runner，先迁移低风险任务。
7. 后续功能逐项通过显式生产配置灰度，不通过修改代码默认值静默开启既有实例。

功能/UI 可以通过 capability 回滚，但权威 mode、hosted admin=`none`、实例 auth epoch/not-before、credential-review restriction 和已建立的最低 binary 下限必须保留；这些安全事实不能随代码回滚恢复旧行为。任何 binary 回退只能到同时理解当前管理员策略、强制 auth epoch 且具备 legacy job allowlist 的已声明兼容版本，禁止启动当前基线或其他 pre-compatibility binary。若已创建新 generation job，回滚前停 enqueue/worker、冻结或 drain 新 generation；已进入 irreversible maintenance 的实例不能仅切 binary。若没有满足所有持久契约的旧版本，只能 feature-off 或 forward fix，不能声称支持代码回滚。

## 11. 验收条件

- deployment mode 已成为服务端策略而非 UI 标签。
- hosted 普通注册无法获得系统管理员。
- 认证契约能通过一次原子实例 epoch/not-before 切换立即撤销恢复前的所有凭据，恢复账号默认进入不可远程绕过的 credential review。
- 任一能力可以解释“为何启用/禁用/配置不完整”，且前后端结果一致。
- entitlement、restriction 与最终 operation action 可分别解释，账号级限制有稳定错误语义。
- staff/step-up、maintenance fencing 和 versioned job runner 已成为后续运营计划可直接复用的前置。
- 后续计划不需要自行发明任务重试、能力判断或审计格式。
- 现有同步、设备授权、加密和旧客户端连接没有协议破坏。

## 12. 开放问题

- hosted staff provisioning 的内部 IdP/部署平台集成方式；一期推荐受限 OIDC + 审计化 break-glass CLI，不把客户账号提升为 staff。
- capability override 是否需要数据库动态配置；一期推荐环境配置为主、注册策略等少量运营值入库，避免双重事实来源。
- 通用 job 表是否原地演进 `admin_jobs` 还是新建后迁移；实施前根据现有备份记录外键成本决定。
