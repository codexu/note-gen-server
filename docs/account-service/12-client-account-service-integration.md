# 12：NoteGen 客户端账号服务接入技术规格

- 状态：Draft
- 日期：2026-08-11
- 适用形态：`hosted` 与 `self-hosted`
- 前置依赖：[00 共享部署策略与能力基础](00-shared-foundation.md)
- 按功能依赖：01～11 对应 API/错误/事件冻结后逐项接入
- 受影响仓库：`/Users/xu/code/note-gen-server-sync-client`
- 交付结果：两种部署共用同一同步运行时，客户端按能力呈现账号、配额、维护和恢复状态，并安全保存会话

## 1. 当前基线

现有客户端已完成可靠同步核心：服务发现、协议检查、设备授权/扫码、refresh、默认 managed Workspace、E2EE、多 key version、outbox/inbox、bootstrap、冲突、Blob、WebSocket 和断线恢复。

账号服务层仍有明显缺口：

- `deploymentMode`、`registrationMode`、`web.accountUrl` 和 limits 已声明但基本没有消费。
- UI 仍以“自托管”为主标题，却同时声称可连接官方服务。
- 密码连接总是显示注册与 Setup Token，不按注册策略变化。
- refresh token 写入普通 Store/Web localStorage；本地备份可能连同旧 session 一起恢复。
- 任何 refresh 失败都可能清除会话；部分 403/404 也被视为认证失效。
- command batch/bootstrap/event page 等仍使用硬编码上限。
- 设备 ID 从机器 ID 派生，跨服务器可关联；移动端底层 ID 位于临时目录，可能变化。
- 客户端没有 quota、billing read-only、risk challenge、maintenance 或 sync epoch 状态。
- 首次授权当前硬依赖 `managedDefaultWorkspace=true` 并调用 managed default endpoint；hosted 按 05F 门槛关闭 managed 默认时会直接报 server upgrade required，无法完成首次工作区 onboarding。

## 2. 目标

- 维持一个同步协议和一个后台运行时，不按 deployment mode 分叉同步代码。
- 建立客户端 `CapabilityResolver`，优先使用细粒度能力，旧服务端安全回退。
- 官方托管默认浏览器授权，自托管按能力选择浏览器/密码/邀请/初始化。
- 凭据进入系统安全存储；本地备份不复制服务器 session。
- 稳定区分临时离线、认证失效、邮箱、风控、配额、欠费、维护和不兼容。
- 受限时保留本地编辑/outbox，并按服务端语义继续 Pull 或等待恢复。
- 消费服务端 limits，同时保持对旧服务端和旧兼容下限的支持。
- 支持灾备 `syncEpoch` 变化后的安全 staged re-bootstrap。

## 3. 非目标

- 不在原生客户端内嵌支付卡表单、完整客服后台或法律政策正文。
- 不把 capability 当授权；服务端仍是最终执行者。
- 不因官方托管加入另一套对象、加密、冲突或 Blob 协议。
- 不在本计划重做 NoteGen 客户端本地备份全部功能，只修正账号/session 边界。

## 4. 客户端能力层

### 4.1 标准化模型

网络响应先经过 resolver，不让 React 组件和 sync runtime 直接散读可选字段：

```ts
interface ResolvedServerCapabilities {
  source: 'legacy' | 'schema-2'
  deploymentMode: 'hosted' | 'self-hosted' | 'unknown'
  protocol: { selected: number; minimum: number; maximum: number }
  requiredSyncFeatures: Record<RequiredSyncFeature, true>
  registration: {
    policy: 'bootstrap' | 'disabled' | 'invitation' | 'public'
    methods: Array<'browser' | 'password' | 'invitation'>
  }
  accountPortalUrl: string | null
  supportUrl: string | null
  limits: ResolvedTechnicalLimits
  instanceCapabilities: Readonly<Partial<Record<KnownCapabilityId, boolean>>>
  instanceCapabilityRevision: string | null
  registrationPolicyRevision: string | null
}
```

规则：

- 缺失 `deploymentMode` 的旧服务端显示为 legacy 自定义服务器，但不推断功能。
- 新字段 unknown 忽略；已知字段缺失按 unsupported/false。
- 连接时一次验证“同步核心必需能力集合”，不等登录后逐个随机失败。
- schema-2 dotted ID 只从 00 的 wire mapping 进入 typed `KnownCapabilityId`；未知项忽略，legacy camelCase `features` 仅走显式 alias 表，不能字符串变换。
- capability snapshot 带 schema version + ETag/revision，进入后台 runtime，在启动、重连、server version/revision 变化和策略事件后刷新。
- limits 做逐字段校验；协议必需字段不兼容才提示 server incompatible，普通对象/Blob 限额较小只影响本地预检，不把整个服务器判坏。

### 4.2 旧字段回退

- 只有 legacy 响应缺少结构化 registration 时才使用 `registrationMode`。
- `open` → public password registration；`closed` → login only，旧版本的 Setup Token 入口放入“兼容连接”折叠区。
- `webAccountPortal`/`accountUrl` 缺失时不显示账号外链。
- 不能因为 mode=hosted 就假定 billing、email 或 support 一定存在。

### 4.3 Discovery 与 readiness

新连接必须先独立 GET capabilities，成功解析 origin/instance/setup/maintenance 后再查询 readiness；不能延续当前 `Promise.all(capabilities, readiness)` 中任一 503 就完全无法发现实例的行为。未初始化 self-hosted 可返回 setup control-plane ready，维护/offline 则保留已解析的 server identity 与可执行 action。Capabilities 请求失败才视为 discovery 失败；readiness 失败是单独 operational state。

## 5. 连接与账号 UX

入口改为中性的“NoteGen 同步”：

- 官方托管预设：固定、签名/内置的官方 base URL，默认“在浏览器中连接”。
- 自定义服务器：输入 origin，发现后显示 server name、mode、注册/连接方法和安全提示。
- 不允许官方品牌仅由任意服务器返回 `deploymentMode=hosted` 冒充；官方预设身份由内置 origin/证书/配置决定。

按 capability 显示：

| 能力 | 客户端入口 |
| --- | --- |
| browser device authorization | 默认“浏览器连接” |
| password login | 兼容/自托管密码连接 |
| invitation registration | 打开 Web 邀请页；只有未来声明 native contract 才原生输入 token |
| public registration | 显示注册，不显示 Setup Token |
| bootstrap required | 只提示管理员在 Web/CLI 初始化；普通客户端不抢首 admin |
| web account portal | “管理账号/设备/订阅/数据”外链 |
| device pairing | 只有声明支持时显示扫码 |

浏览器授权保留现有 device code 和 `notegen://sync/pair?v=1...` QR 契约。Hosted 的邮箱验证、TOTP、风险挑战、政策接受和支付全部在 Web 完成，成功后客户端只交换 device session。

自托管兼容密码登录若返回 `totp_required`，客户端才显示一次性验证码输入并用同一受限登录流程重试；验证码仅驻留内存，不写 Store/日志/诊断。该错误不能显示成“密码错误”或清除已有其他 profile session。服务端声明只能在 Web 完成 step-up/风险挑战时，客户端打开受信账号页面，不自行模拟挑战。

## 6. 账号上下文与状态机

后台维护认证后的 account context：身份状态、entitlements、usage、restrictions、action URLs 和 revision。UI 可以缓存，写入不能只靠缓存放行。

这些状态可以同时发生，不能塞进单一互斥 enum。运行时拆成正交维度：

```ts
interface AccountServiceRuntimeState {
  transport: 'idle' | 'checking' | 'online' | 'offline'
  authentication: 'anonymous' | 'authorizing' | 'authenticated' | 'reauthentication-required'
  compatibility: 'compatible' | 'server-incompatible' | 'sync-epoch-recovery' | 'workspace-mismatch' | 'fatal'
  maintenance: { mode: 'normal' | 'read-only' | 'write-drain' | 'offline'; retryAt?: string }
  restrictions: Readonly<Record<OperationId, {
    effect: 'allow' | 'challenge' | 'read-only' | 'throttle' | 'deny'
    reasonCode: string
    actionUrl?: string
    retryAt?: string
  }>>
  notices: Array<'email-verification' | 'policy-acceptance' | 'quota-warning' | 'billing-grace'>
}
```

`canPush/canPull/canCreateDevice/canExport/canDelete` 只从服务端逐 operation action 与本地 transport/compatibility 取交集；客户端不猜“risk 通常允许 Pull”或“policy 一定阻止全部写”。Presentation selector 再按 fatal/recovery → reauthentication → challenge → maintenance → read-only → warning 的优先级选一个 primary banner/action，其余保留为次级提示。

通用不变量：offline/5xx/timeout/maintenance/risk/quota/billing 保留 Session 与 outbox；只有明确 refresh invalid/revoked/reused、device revoked 或 deletion completed 清凭据。任何 operation 被 deny 都不等于把本地 command 标永久失败；outbox 等待 context revision/用户动作，只有服务端明确 `non_retryable_data_error` 才进入人工冲突/丢弃流程。

## 7. 结构化错误模型

扩展 `NoteGenServerRequestError`：

```ts
interface ServerErrorEnvelope {
  code: string
  message: string
  requestId: string
  retryable: boolean
  details?: {
    retryAfterSeconds?: number
    actionUrl?: string
    metric?: string
    limit?: string
    used?: string
    capability?: string
    [key: string]: unknown
  }
}
```

- 优先读取 `Retry-After` header，做上限/抖动处理。
- `message` 只用于未知 code fallback；已知 code 由客户端本地化。
- action URL 必须验证为 capabilities 声明的受信 origin 或安全自定义 server origin。
- request ID 进入诊断和客服入口，但不作为高基数遥测 label。
- command-level rejected 与 HTTP error 进入同一分类器。
- `retryable=false` 只表示“不要立即原样重试”，不等于永久丢弃本地 operation。Quota/risk/billing/policy/maintenance 进入 scope-level blocked queue，等待 context revision/action；真正不可恢复的 payload/schema/ownership 错误才标 command failed 并进入冲突/人工处理。`retryable=true` 也必须经过调度退避，不能在同一 flush loop 立即自旋。

稳定映射至少覆盖：`email_verification_required`、`policy_acceptance_required`、`risk_challenge_required`、`risk_temporarily_locked`、`quota_exceeded`、`device_limit_exceeded`、`account_read_only`、`credential_review_required`、`server_maintenance`、`cursor_expired`、`sync_epoch_changed`。`credential_review_required` 表示灾备恢复出的密码/TOTP 尚未由部署者处理：不反复尝试密码登录，不清 profile/outbox，self-hosted 显示 operator CLI/受信说明，等待审阅后重新浏览器授权。

## 8. Refresh 与安全凭据

### 8.1 凭据存储

- Tauri refresh token 使用 OS Keychain/Keystore，key 为 `instanceId + accountId + deviceId`。
- Access token 仅内存保存，应用重启用 refresh 获取。
- Store/profile 保留 base URL、instance ID、非秘密 `accountId`、server name、login/display identity、device ID、Workspace/local binding，以及 credential schema/version/ref；不保存 token。
- Web runtime 明确选择“refresh 仅内存、关闭跨重启自动连接”；账号 Web 的 HttpOnly Cookie 不能替代跨源同步 bearer。未来如需持久自动同步，另做同源 BFF 规格；绝不回退 localStorage。
- Linux/移动端 secure storage 不可用或锁定时不持久化，关闭自动连接并要求重新授权。

迁移：读取旧 Store → 写安全存储 → 校验读取 → 删除旧 session。任一步失败保留旧数据、停止自动迁移并要求重新授权，不能先删后写。

Refresh rotation 需要 server/client 共同的 crash-safe 协议：客户端在安全存储写 `refreshRequestId + family/version` journal 后发请求；服务端对“同一旧 token + 同一 requestId”在短 TTL 内返回同一加密缓存响应，不判 reuse，不同 requestId/超时后复用才撤销 family。客户端先原子写新 token/version并读回，再清 journal。没有这一幂等恢复，服务端已旋转而客户端落盘前崩溃会把正常设备误判为 token 重放。

### 8.2 Refresh 分类

只有以下 code 清除凭据：`refresh_token_invalid`、`refresh_token_revoked`、`refresh_token_reused`、`device_revoked`、明确的 account deletion complete。timeout、网络、429、5xx、maintenance、quota、billing 和 risk 不清除。

计划 10 restore 推进共享实例 auth epoch 后，旧 refresh/access token 按规范返回 revoked/invalid；客户端只删除该 credential ref，保留非秘密 profile、Workspace、live materialization 和 outbox。重新授权若得到 `credential_review_required`，进入可恢复认证状态而不是删除本地同步数据；只有 operator 已审计处置并清除对应 `AccountRestriction` 后才取得新 Session并继续 sync epoch reconciliation。

Refresh 在 access token 到期前带抖动启动；失败按错误退避但保留 current access token 至真实 expiry，不能因一次网络错误提前登出。后台状态和 UI 显示下次重试，不每分钟轮询永久错误。

## 9. 设备身份

- 存储结构固定为 `serverDeviceIds: Record<instanceId, deviceId>`，API 改为 `getOrCreateServerDeviceId(instanceId)`；新连接生成随机 ID 并存 application-support/安全持久区，减少跨服务器关联。
- 现有 profile 保留老 device ID，直至用户重新授权；不能原地重算，否则 refresh token、设备记录和事件来源断裂。
- 移动端随机源存 application support/secure storage，不放 temp 目录。
- 恢复本地备份时保留当前真实设备 ID，不恢复备份来源设备的 ID/session。
- 设备名称允许用户编辑，并上报 app version/平台的受控元数据；完整机器 UID 不上传。

## 10. 技术 limits 与同步运行时

现有硬编码至少为 command batch 100、bootstrap page 50、event page 200、document updates 500。迁移规则：

```ts
interface ResolvedTechnicalLimits {
  maxBatchOperations: number
  maxObjectBytes: bigint
  maxBlobBytes: bigint
  maxRequestBytes: bigint
  bootstrapPageItems: number
  eventPageItems: number
  documentUpdatePageItems: number
}
```

Schema-2 的 byte 字段使用非负 decimal string；count/page 字段使用 JSON safe integer。Legacy number 只有 `Number.isSafeInteger` 时接收，缺失的 page 值回退 50/200/500，缺失的已有限制按当前 legacy contract 回退；任何默认值都集中在 resolver 并带来源，不散落 runtime。

- resolver 计算 `min(clientPreferred, serverLimit)`。
- server limit 缺失使用 legacy default。
- server 宣称 max batch < 旧客户端一次固定批量时，旧客户端仍可能失败；服务端在兼容窗口维持至少 100，新客户端普及后可降，当前客户端按至少 1 动态分批。
- `maxObjectBytes/maxBlobBytes/maxRequestBytes` 在本地入队/上传前做预提示，但服务端拒绝仍是事实。
- 较小的 object/blob limit 只表示产品约束，不自动判 server incompatible；只有值非法、0、相互矛盾（例如 request envelope 永远装不下最小 command）或低于协议不可分割最小单元才判不兼容。
- capability/limit 更新只影响新 batch，不拆坏正在发送的幂等 request。

required sync feature 集合包含实际无条件使用的 durable commands/events/bootstrap/CRDT/conflict/resumable Blob/asset objects/WebSocket 契约；连接时集中报缺失能力。

## 11. 配额与订阅行为

quota/billing 拒绝时：

- 本地修改继续写入 SQLite/文件和 durable outbox。
- Push 调度进入 blocked，不把每条 operation 标为永久失败或逐条弹窗。
- Pull/WebSocket 保持，避免错过其他设备删除/订阅恢复事件。
- 显示 usage/limit、管理/清理 URL 和最后 request ID。
- 用户删除本地内容时相应 delete command 可按服务端策略发送；若 batch 混合，调度器优先允许减量操作。
- context revision 变化、应用回前台、支付 Web 返回或用户手动检查后自动恢复。

客户端不直接根据支付 success URL 解除状态，也不修改 entitlement cache。

## 12. 加密策略能力化

账号上下文/能力可声明：

```ts
encryption: {
  modes: Array<'managed' | 'e2ee'>
  defaultMode: 'managed' | 'e2ee'
  allowedTransitions: Array<'managed-to-e2ee' | 'e2ee-to-managed'>
}
```

- UI 只显示允许操作；旧客户端仍可能调用，因此服务端必须 enforcement。
- 密码重置页面和客户端明确不恢复 E2EE。
- 高风险切换要求 Web step-up/本地再次确认和恢复密钥检查。
- mode/entitlement 变化不能改变现有 workspace ID/key version 或静默把 E2EE 转 managed。

### 12.1 Managed 关闭时的首次 E2EE onboarding

官方免费邀请测试在 05F 完成前固定 `managedDefaultWorkspace=false`，因此 12G 必须先交付可恢复的 E2EE-only 首次路径，不能继续把该状态解释为 server 版本过低：

1. 浏览器授权完成后先读取 encryption policy 与 Workspace 列表，不调用 `/v1/workspaces/default`。若已有 Workspace，要求用户选择；E2EE Workspace 使用现有同步口令、恢复密钥或已授权 device envelope 解锁，不能为同一账号静默再建默认 Workspace。
2. 没有 Workspace 且 policy 允许/默认 E2EE 时进入前台向导，明确区分“账号登录密码”和“同步口令”。用户输入 Workspace 名、满足本地/KDF 政策的同步口令并二次确认；客户端复用现有 `createServerWorkspace` 在本地生成 Workspace key、passphrase envelope 与 recovery envelope，服务端只收到密文/envelope。每次向导先持久化随机 creation idempotency key，再发起创建。
3. 创建成功后一次性展示恢复密钥，要求用户完成复制/下载并通过末尾字符或重新输入确认。确认前不把同步标记为 active、不启动后台 Push；支持系统安全存储的平台可把 pending Workspace/recovery key 放入有 TTL 的 Keychain/Keystore onboarding record，确认后立即删除。没有安全存储或 pending secret 丢失时，用户重新输入同步口令解锁同一 Workspace，客户端撤销未确认的 recovery envelope、生成并确认一条新 recovery envelope，不能让未知 recovery key 永久有效。
4. 客户端在 secure profile 中原子保存 instance/workspace/device/encryption mode，再把解锁 key 交给内存中的后台 runtime；不把同步口令、恢复密钥或明文 Workspace key 写入普通 Store、日志、诊断或本地账号备份。
5. 进程若在 server 创建成功、profile 提交或 recovery confirmation 之间退出，重开先 list Workspace 并读取非秘密 phase journal/安全 pending record，恢复选择/确认流程；以 creation idempotency key 找回同一次创建，不能重复建 Workspace。无前台 UI 的 background runtime 进入 `foreground_onboarding_required`，不得回退调用 managed endpoint。
6. 若 policy 不提供任何客户端支持的模式，返回结构化 `encryption_policy_unsupported` 并保留会话/profile；不能清账号凭据或假装连接成功。

12G 包含一个 additive server companion contract：`POST /v1/workspaces` 接受账号作用域的 `Idempotency-Key`，把规范化 name ciphertext/key version/envelope 集合记为 request hash；同 key+同 hash 返回原 Workspace 和 `created=false`，同 key+不同 hash 返回 409。`workspaces` 可新增 nullable `creation_idempotency_key/creation_request_hash` 并对 `(account_id, creation_idempotency_key)` 建 partial unique，记录至少保留到 Workspace 删除完成；旧客户端不带 key 时维持现有 201 行为。另提供认证后的 account-scoped `GET /v1/workspace-creation-requests/:key`，只返回 workspace ID/状态/createdAt，供“服务端已提交但本地 pending secret 丢失”时定位原 Workspace，跨账号 key 始终返回不可枚举结果。Recovery-envelope replacement 同样使用幂等键与稳定 envelope ID/status，在一个事务中新增已确认 envelope、撤销未确认 envelope，不能出现无 recovery 路径的中间状态。

未来启用 managed 默认是另一条门槛：05F KMS 与 12G device-bound key-grant 全部验收后，才允许 capability/defaultMode 切为 managed。E2EE-only 用户不会因此自动转换；转换仍按 allowedTransitions 和显式用户确认执行。

## 13. 本地备份账号边界

明确文案：

- 客户端 `.ngbackup`：本地 Workspace/SQLite/设置。
- 服务器统一备份：部署者恢复 PostgreSQL + Blob。
- 账号导出：用户从服务获取所持数据。

本地备份默认排除 refresh/access token、Web Session、机器/设备 secret 和临时 capability/account context。恢复后：

- 保留当前设备的 per-instance device IDs。
- 在 restore staging、应用重启/目录 swap 前无条件 scrub 新旧 session key（至少 `noteGenServerSyncSession`、access/refresh、旧 localStorage/session refs）；旧版 `.ngbackup` 即使递归包含 `store.json` 也不能把 legacy Session 重新引入。随后要求重新浏览器授权。
- profile 可作为非秘密“曾连接服务器”提示，但不能与旧 token 混合自动启动。
- 本计划只完成账号/session scrub 与恢复失败不无条件 relaunch；完整本地备份 format 版本、checksums/加密属于独立客户端备份规格，不能与加密策略塞在同一 PR 隐式扩 scope。

## 14. `syncEpoch` 与灾备恢复

当前同步 scope 由 `instanceId + workspaceId + localWorkspaceKey` 计算，客户端另存 cursor/bootstrap 状态。恢复旧服务端快照而保持 instanceId 会导致 sequence 回退，必须引入 epoch。

### 14.1 Auth fencing 与重新授权顺序

计划 10 preserve/clone 在切换前按计划 00 的共享契约递增数据库 bigint `instance_auth_epoch`、推进 `token_not_before`；wire 中 epoch 使用无损十进制字符串，Access JWT、Refresh、Web Session、device authorization/pairing exchange 都必须校验该代次。客户端不能用旧凭据执行 epoch bootstrap：先保留 profile/outbox并清除明确 revoked 的 credential，完成账号 credential review/浏览器重新授权，再以新 Session进入下述 sync epoch recovery。服务端数据库 `auth_epoch_enforced` 未为 true、或仍存在低于最低认证契约的 binary 时，计划 10 `preserveRestore` 必须保持 false；这不是可由客户端或 capability override 放宽的功能开关。

### 14.2 Server fencing contract

计划 10A 先 additive 返回随机 UUID epoch：capabilities、workspace context、同步 snapshot bootstrap、Pull/events 都携带 epoch；command、Blob begin/complete 与 server-mediated part、cursor ACK、WebSocket authenticate/`document.update` 都提交 `expectedSyncEpoch`。直传 part session 在 begin 绑定 epoch，complete 再校验；不匹配统一 `sync_epoch_changed` 并关闭旧连接。

Restore metadata 至少包括 `restoredFromBackupId`、`backupEpoch`、`restoredThroughSequenceByWorkspace`。旧 command ID 不能原样发到新 epoch；idempotency namespace 包含 epoch。服务端先支持但不要求 → 新客户端开始发送 → restore drill 验证 fencing → 才将 `syncEpochFencing` 设为 required/开放 preserve；缺 epoch 的旧客户端此后 fail-closed。

### 14.3 本地持久化与 staging

- `sync_v2_state` 按 instance/workspace 保存 syncEpoch；staging namespace 另含 target epoch、bootstrap cursor、恢复 phase、checksums。
- 每个恢复 generation 使用一个独立 root，内含 staged SQLite、Markdown/附件物化、journal 和 signed/checksummed generation manifest；cursor/epoch 只写 staged SQLite，不提前修改 live generation。每个 page 可重放，完成后依次 fsync 文件、SQLite/WAL、sealed generation manifest 和目录；sealed 只表示内容不可再改，不表示已经 live。
- `activeGeneration` 是唯一提交事实，位于不随 generation 切换的 application-support control area。提交前停止 watcher、关闭旧/新 SQLite handle，并在 control journal 记录 prepared；随后只原子 replace 这一个 pointer并 fsync 其父目录，该 replace 本身就是 commit，不再写第二个“已提交”marker。所有 DB/Markdown/附件路径都通过该 pointer 解析，禁止分别切 DB pointer 和目录 marker。
- 启动先验证 pointer 指向 sealed generation 的 manifest/checksums，再以只读方式打开 SQLite 完成 bootstrap validation；验证完成前 UI 编辑、filesystem watcher、Push 与任何写连接都保持 disabled。只有 validation 成功并把 control journal 置 `validated` 后，才重开可写 SQLite、启动 watcher/UI 并允许 Push。pointer 缺失、指向 unsealed/incomplete generation 或校验失败时，关闭新 handle、根据 control journal 原子回指 previousGeneration并保持 Push 停止；因为验证窗口从未接受编辑，不存在需要从失败 generation 回放的新本地修改。旧 generation 至少保留到该步骤完成后再清理。
- 平台若不能保证同卷 atomic replace + directory fsync，使用稳定 control DB 的 `prepared → pointer-swapped → validated` 两阶段恢复协议，并在启动时收敛；不能用两个“各自原子”的 rename 冒充跨 SQLite/文件系统原子提交。
- Epoch 变化立即停止 Push、watcher 派发、WebSocket write 和 ACK 推进；冻结旧 outbox/last-known-base 快照，不删 live materialized 内容，也不发送旧 cursor。

### 14.4 三方 reconcile 规则

对每个 object 使用 old known base `B`、当前本地 `L`、恢复端 `R`：

1. `L==B`：本地无改动，采用 R。
2. `R==B && L!=B`：服务端回退丢失本地变化，用新 epoch/new commandId 重建 upsert/delete。
3. `L!=B && R!=B && L!=R`：双方变化，文本/对象进入现有三方 conflict；不得用时间戳 last-write-wins。
4. 旧 epoch 已 ACK 但 R 缺失的修改，只要 L/旧 base 能证明，就按第 2/3 条重建；未确认 outbox 也不原样 replay。
5. Delete 与 upsert 分别比较：本地 delete、R 未变时重建 delete；R delete、本地有新改动时进入恢复/保留冲突，不静默复活或丢弃。
6. CRDT/Yjs 在校验 workspace/key version 后用 state vector/update merge；无法证明共同 base 时保留两份冲突表示。新 key version 若备份不存在且本地无可用 key，停止并提供本地导出，不能伪造 re-encryption。
7. Blob 先验证/重传 ciphertext 与 hash，成功后才发送引用 object；缺 Blob 不允许先提交悬空引用。

Reconcile 完成后在 staged generation 中校验对象数/hash/key identity，再通过唯一 `activeGeneration` pointer 同时提交 epoch/cursor/SQLite/物化文件，验证成功后才恢复 watcher/Push。多次中断只继续同一 target epoch journal；server 再次换 epoch 时丢弃旧 staging、保留 live/local edit snapshot并重新开始。

### 14.5 RPO 边界与人工路径

Epoch 自动恢复只覆盖备份中仍存在的 account/workspace。Cutoff 后新账号无法认证、新 Workspace 不存在；UI 必须说明 RPO，并让仍持有本地内容的设备先导出，再在恢复端现存/新账号中导入。12H 完成前计划 10 `preserveRestore=false`，不再用“管理员口头要求所有设备清状态”代替协议 fencing。

## 15. 支持与诊断入口

诊断包新增：客户端/server version、deployment mode、capability/account context revision、状态机 phase、request ID、limits、sync epoch、outbox/inbox/count/cursor 的安全摘要。

不包含 token、完整路径、文件名、正文、workspace key、恢复密钥。Hosted 打开账号 Web support action；self-hosted 打开 capabilities 声明的 operator support URL/email。

## 16. 建议 PR 切片

1. **PR-12A：Capability Resolver + Discovery。** schema-2/ETag/revisions、legacy fallback、capabilities-first readiness、required features、typed limits。
2. **PR-12B：连接 UX。** 中性品牌、官方预设、自定义 server、按能力显示方法/账号入口。
3. **PR-12C：Error/Orthogonal State。** 结构化 details、Retry-After、operation actions、blocked/maintenance/credential-review/auth presentation。
4. **PR-12D：Secure Session。** Keychain/Keystore、旧 Store 迁移、refresh request journal/服务端幂等恢复。
5. **PR-12E：Per-instance Device。** 随机 ID、移动持久化、兼容迁移/重命名。
6. **PR-12F：Quota/Billing/Support UX。** account context、usage/action URL、诊断。
7. **PR-12G：Encryption Policy + First Workspace。** 先交付 server workspace-create/envelope-replacement 幂等 companion、managed=false 的 E2EE-only 前台 onboarding/journal/安全 pending record/恢复密钥确认；随后接入 05F managed device-bound key grant、mode 限制与转换文案。
8. **PR-12H：Sync Epoch Recovery。** auth reauthorization ordering、expected-epoch client、single-generation pointer staging、三方 reconcile、RPO UI、故障注入；计划 10 preserve gate。
9. **PR-12I：Local Backup Session Boundary。** 新旧 session key scrub、恢复重新授权；完整 backup format hardening 另立计划。

## 17. 测试矩阵

- 新/旧 hosted/self-hosted capabilities 全组合，未知/缺失字段回退。
- capabilities 成功而 readiness=setup/maintenance/offline 时仍能识别实例并展示正确 action；只有 discovery 失败才视为未知服务器。
- 官方预设防冒充；自定义 URL/origin/action URL 校验。
- 浏览器、密码、邀请、closed/bootstrap、扫码能力显示和服务端拒绝一致。
- timeout/429/5xx/maintenance 不清 session；仅明确 refresh 无效才清。
- offline+quota、maintenance+risk 等组合状态保持正交，UI primary priority 与服务端逐 operation action 一致。
- quota/risk/billing blocked 保留 outbox、继续允许的 Pull，并在 revision 变化后恢复。
- 安全存储迁移在写前/写后/删前崩溃均不丢 token或产生两个错误身份。
- refresh 在 provider/server rotate 前后与 Keychain commit 各崩溃点用相同 request journal 恢复，不把正常重试误判 reuse。
- restore 推进实例 auth epoch 后旧 Access/Refresh/Web Session 均不能继续；客户端清 credential 但保留 profile/outbox，`credential_review_required` 不会触发登录重试风暴或本地数据清理，operator 审计处置并清除对应 `AccountRestriction` 后可重新授权。
- per-instance device 不跨 server 复用，旧 profile 不被强制迁移断线。
- 新旧本地备份恢复 staging 都 scrub legacy session/store key，跨设备恢复不冒充来源设备；Web runtime 重启不持久连接。
- sync epoch 变化覆盖：无本地改动、有未确认改动、有已 ACK 但服务端回退改动、E2EE、Blob、CRDT、冲突和多次中断恢复。
- epoch 测试覆盖缺 expected epoch 的旧 command/Blob/WS/cursor、连续两次 restore、cutoff 后新账号/Workspace 的本地导出路径。
- `managedDefaultWorkspace=false` 的全新 hosted 邀请账号可完成 E2EE Workspace 创建、恢复密钥确认并开始同步；已有 E2EE Workspace 走选择/解锁，不调用 managed default endpoint。创建响应前后、profile commit 前后和 recovery confirmation 前后崩溃均不重复建 Workspace；pending secret 存在时可继续确认，丢失时用同步口令原子替换未确认 recovery envelope，不留下未知有效恢复密钥；background-only 状态稳定等待前台。
- staged generation 在每次文件 fsync、SQLite checkpoint/close、manifest seal、control journal prepared、pointer replace、父目录 fsync、只读 reopen/validation 和 watcher enable 前后崩溃，启动后只能看到完整 old 或完整 new generation，不能出现新 DB+旧文件/旧 DB+新文件；validation 完成前编辑/watcher 均被拒绝，校验失败稳定回指 previous generation 且 Push 保持停止。
- bigint limits/usage 无精度损失；batch/page 动态值不超 server limit。

## 18. 上线、回滚与验收

先上线 12A/C/D；官方真实邀请用户还硬依赖 12G E2EE-only 首次工作区路径，完成前保持注册 disabled。01 托管会话、02 的 423/429、03 hard quota、04 billing read-only 都以对应客户端版本普及为 capability gate，避免当前实现清 Session、永久 block 或高速重试 outbox。功能只有相应 server capability/action 打开时出现。

Restore rollout 是硬序列：计划 00 全认证入口完成 epoch 兼容迁移并切换数据库 `auth_epoch_enforced=true` → 10A server 支持但不要求 sync epoch → 12H 客户端发送/持久化并完成真实 restore、single-pointer/validation-before-watcher 崩溃演练 → server 开启 `syncEpochFencing` required → 10 才开放 preserve。任何阶段都不对旧客户端隐式恢复。

回滚保留旧 Store 双读一段版本；不能在单个版本写入仅新客户端可读的凭据后立刻删除所有兼容数据。server 能力开关可关闭新 UX，但客户端同步核心仍使用同一协议。

验收条件：两种部署无同步代码分叉；managed 默认关闭时新用户仍可经受测 E2EE onboarding 建立首个 Workspace；客户端不会因运营限制或临时故障登出/丢 outbox；凭据不在普通 Store/备份；连接入口与真实 capability 一致；历史灾备恢复同时通过 auth fencing、credential review、sync epoch 与单 generation 原子切换验证。

## 19. 开放问题

- 官方托管预设 origin 的发布/切换机制和测试环境选择。
- 官方 Web runtime 如未来需要跨重启后台同步，是否建设同源 BFF；当前决策是 refresh 仅内存、重启重新授权。
- sync epoch 自动 reconcile 若无法在首版覆盖 CRDT/key-version/Blob，preserve 必须继续关闭，不能降级为直接覆盖 live 数据。
