# 03：官方托管用量计量与配额技术规格

- 状态：已完成（内部测试范围；商业套餐配额接入与 retained-safety 扩展移至 [13 生产上线准备](13-production-readiness.md)）
- 日期：2026-08-11
- 默认适用形态：`hosted`
- 自托管行为：默认不启用商业配额，仅保留实例级安全上限
- 前置依赖：[00 共享部署策略与能力基础](00-shared-foundation.md)
- 交付结果：账号用量可解释、可对账，并能在并发 command 与 Blob 上传下原子执行限额

## 1. 目标

- 对存储、设备和 Workspace 建立账号级强一致当前用量。
- 对并发 Blob 上传建立 reservation，消除“先检查后上传”穿透。
- 将 plan/entitlement 与同步核心解耦；核心只接收解析后的 limit。
- 超额时保留 Pull、删除、导出和本地 outbox，不造成数据丢失。
- 提供账务展示用量与物理安全用量的定期对账/修复。
- 让 self-hosted 在关闭 enforcement 时不承担计费复杂度。

## 2. 非目标

- 一期不做按 token、笔记数或 AI 调用计费。
- 不把 Prometheus 指标当作计费账本。
- 不要求每个历史版本立即可归因到财务发票。
- 不允许订阅模块直接在同步代码中判断 `free/pro/team` 套餐名。

## 3. 计量定义

先冻结语义，避免 UI、配额和数据库各算一套：

| Metric | 定义 | 一期执行 |
| --- | --- | --- |
| `active_storage_bytes` | 未删除当前对象的逻辑 ciphertext payload、当前 CRDT payload、账号拥有的全部 ready Blob（每个实际 storage key 一次）及上传 reservation | 硬限额 |
| `retained_storage_bytes` | 历史版本、tombstone、冲突、V2 event/command/document/update/checkpoint 等不属于当前逻辑 payload 的持久副本 | 物理安全限额/告警 |
| `active_objects` | `objects.deleted_at is null` 的逻辑对象数量 | 展示，暂不作为付费核心 |
| `active_devices` | `devices.revoked_at is null` | 硬限额 |
| `active_workspaces` | `workspaces.deleted_at is null` | 硬限额 |
| `monthly_ingress_bytes` | 账期内成功接收的 Blob part 与 command payload 字节 | 只计量，后续可执行 |
| `monthly_egress_bytes` | 账期内成功返回的 Blob/body 字节 | 只计量，后续可执行 |

商业 active quota 计逻辑 payload，不宣称等于 PostgreSQL 磁盘占用；PostgreSQL tuple/index/WAL/压缩开销由实例容量指标另管。`objects` 是当前状态，`object_versions` 是历史事实；同一 ciphertext 在 current/version/event 多表出现时 active 只计一次，额外持久副本进入 retained safety。历史保留不计入用户套餐时，仍通过 retained safety limit 防止版本风暴无限占用。

对于 CRDT，一期保持当前“checkpoint 覆盖后立即 prune update”的语义，并在同一事务扣减 active/retained；不虚构一个尚不存在的 update 保留期。`sync_v2_events/commands/documents/checkpoints/conflicts` 的真实副本全部纳入 retained safety 与清理/对账；如以后新增保留期，另做 migration/GC 计划。

Ready Blob 在 upload complete 时立即收费，不等待对象引用；否则 complete 与首个/最后引用需要额外并发 refcount，容易穿透。对象引用变化不修改 blob usage，同账号/Workspace 的相同 storage key 只计一次；成为无引用后仍收费直到 fencing-aware GC 物理删除并在同事务扣减。

## 4. 数据模型

```text
account_usage
  account_id uuid pk
  active_object_bytes bigint
  active_crdt_bytes bigint
  active_blob_bytes bigint
  reserved_blob_bytes bigint
  retained_bytes bigint
  active_objects bigint
  active_devices bigint
  active_workspaces bigint
  revision bigint
  reconciled_at timestamptz nullable
  updated_at

usage_reservations
  id uuid pk
  account_id uuid
  workspace_id uuid nullable
  metric text
  quantity bigint
  source_type text
  source_id text
  request_hash text
  provider_upload_ref text nullable
  status enum('reserved','external_started','committed','released','expired','reconciling')
  expires_at timestamptz
  created_at, completed_at
  partial unique(account_id, workspace_id, source_type, source_id, metric) where workspace_id is not null
  partial unique(account_id, source_type, source_id, metric) where workspace_id is null

usage_events
  id bigserial pk
  account_id uuid
  metric text
  delta bigint
  resulting_value bigint nullable
  source_type text
  source_id text
  workspace_id uuid nullable
  request_hash text
  idempotency_key text
  occurred_at timestamptz
  billing_period text nullable
  metadata jsonb
  partial unique(account_id, workspace_id, idempotency_key) where workspace_id is not null
  partial unique(account_id, idempotency_key) where workspace_id is null

account_period_usage
  account_id uuid
  metric enum('ingress_bytes','egress_bytes')
  period_start, period_end timestamptz
  quantity bigint
  revision bigint
  unique(account_id, metric, period_start)
```

不能对 nullable `workspace_id` 只建普通多列 UNIQUE：PostgreSQL 默认把多个 `NULL` 视为互不相等，会让账号级设备/Workspace 事件和 reservation 重复写入。Migration 使用上面的两组 partial unique（或经版本门槛确认后的 `UNIQUE NULLS NOT DISTINCT` 等价实现），所有 upsert/冲突目标与这两种 scope 保持一致。

为热路径添加显式字节列，避免每次 `octet_length` 全表计算：

- `objects.ciphertext_bytes`
- `object_versions.ciphertext_bytes`
- CRDT update/checkpoint/conflict 的 `ciphertext_bytes`
- Blob 已有 size。

迁移按 expand → 新写 dual-write → 分批 backfill → 对账 → NOT NULL 执行，避免在线写产生空洞。Base64URL ciphertext 的商业逻辑计量统一使用解码后 ciphertext bytes；retained safety 使用各持久列的实际 UTF-8/bytea 长度并逐表声明，UI 分别显示“套餐用量”与“服务端保留量”，不混称数据库总占用。

## 5. Limit 与有效策略

消费计划 00 的 `EffectiveLimitsProvider`，本计划先实现 `hosted-static-default` 与 `self-hosted-disabled`，不反向依赖计划 04：

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
```

- `null` 表示无限，不使用超大哨兵值。
- self-hosted 默认 `enforcement=disabled`，但单对象、单请求、单 Blob 等安全限制仍来自 capabilities。
- 计划 04 上线前 hosted 全部使用配置版本化的 static free/default 限制；04 以后 `EntitlementService` 实现同一 provider，UsageGuard 无需了解套餐名称。
- limit 变更发布账号策略事件，客户端刷新 context；hard 写事务读取/锁定数据库中的 limits revision 或以 CAS 校验，不能用可能过期的进程缓存作为强一致事实。
- 月度 ingress/egress 一期只 observe 并写 `account_period_usage`；在账期边界、重试去重和 provider period 对齐完成前，相应 hard limit 必须为 null。

当前实现只允许 hosted `internal-test` 以 `USAGE_ENFORCEMENT=hard` 加 `CAPABILITIES_ENABLE=usage.enforcement` 显式打开 `storage_bytes` 的 CAS gate；值来自当前 entitlement 的 `limits.storage_bytes`，缺失/null 即无限。自托管必须 `disabled`。已覆盖 Blob reservation、普通/管理员设备撤销、普通/管理员 Workspace、legacy/durable 当前对象写入与 durable CRDT append/checkpoint/resolve；管理员可读取或显式触发按账号当前状态对账快照。合规删除恢复、retained safety、账期 ledger 仍未纳入统一 guard，因此不是生产商业配额启用条件。

## 6. 原子计量与 Guard

### 6.1 对象和 command

每条 durable command 已独立事务处理。写入顺序：

1. 锁定/原子更新 `account_usage`。
2. 基于旧当前对象与新状态计算 delta；`account + workspace + commandId` 作为计量幂等源，并绑定 request hash，禁止同 ID 换 payload/quantity。
3. 在同一事务校验 EffectiveLimits revision 与 limit；revision 已变化则重读/重算，不以缓存值继续提交。
4. 同一事务写对象/版本/event、usage event 和 counter。

Web 管理页测试数据和任何 legacy `SyncService` 写操作必须调用同一 UsageGuard。在 legacy/durable 双栈清理前，不允许仅在 HTTP 路由统计。

删除和缩减操作始终允许，即使它会产生一个很小的 tombstone/history 记录；该额外保留字节进入 retained safety buffer。冲突解决、恢复历史版本等扩容操作按正常写入检查。

### 6.2 Blob reservation

创建上传时已知 `expectedSize`，必须在调用对象存储前：

1. 事务确认 Blob 不已存在、账号/Workspace 所有权和有效 limits revision。
2. 原子创建 reservation，并检查 `active + reserved + expected <= limit`。
3. 提交后以 reservation ID 作为 provider idempotency/source key 调用 `beginUpload`；成功后 CAS 为 `external_started` 并保存 provider ref。
4. “provider 成功、本地未提交”由 reconciliation job 通过 provider list/head 或受控 orphan prefix 找回；adapter 不支持查询/幂等时使用唯一临时 key并在 TTL 后清理，不能直接释放后再创建第二份。
5. 每次续传查询复用相同 reservation/provider ref，不重复占额。
6. complete 外部成功后由可重入 reconcile 验证 size/hash，再在事务中把 reserved 转为 ready active Blob bytes；“外部 complete 成功、DB commit 前崩溃”不得产生第二 Blob或双计量。
7. abort、过期、账号删除和外部 orphan cleanup 幂等释放；已 ready Blob 只有实际 GC 删除事务才扣 active bytes。

并发相同 blob ID 依赖唯一约束，只允许一个 active reservation。若 ready Blob 已存在，返回 deduplicated 且不新增用量。

### 6.3 设备与 Workspace

- 创建设备 session 前原子判断 active device；同 device ID 重新登录不重复计数。
- 撤销只减少 active count；同一设备重新授权按新增重新检查。
- 默认 Workspace 首次创建与显式 Workspace 创建共用同一计数入口。
- soft-delete Workspace 立即减少 active workspace count，但其中 retained bytes 继续保留并受 safety limit 约束。
- 普通/管理员 Workspace restore、历史版本恢复、设备 revive 都必须走 UsageGuard；restore 预先计算 Workspace 全部重新 active 的 bytes/count，原子检查后再改状态，禁止管理服务直接写表绕过。

## 7. 超额状态与客户端行为

分为：

- `warning`：达到 80%，只通知。
- `soft_exceeded`：超过新下调的 limit 或订阅变更，允许短期增长但持续警告。
- `hard_exceeded`：宽限期结束，禁止增加用量。
- `safety_blocked`：retained storage 或异常速率超过安全阈值，仅允许 Pull、导出、删除和客服/管理员处置。

Warning/恢复阈值带 hysteresis，例如 80% 进入 warning、降到 75% 才清除，避免多设备写入时 UI 抖动。具体 operation allowlist 由计划 00 OperationPolicy 返回，客户端不自行假设导出/删除一定可用。

API 错误：

- HTTP 操作：`409 quota_exceeded`，details 含 `metric`、`limit`、`used`、`reserved`、`manageUrl`，数值使用十进制字符串。
- 设备/Workspace：`409 device_limit_exceeded`、`workspace_limit_exceeded`。
- command batch：单项 `status=rejected`、相同 code、`retryable=false`，但客户端把它归类为可解除的 `quota-blocked`，不是永久丢弃。

客户端进入 quota-blocked 后：

- 保留 durable outbox 和本地编辑。
- 降低/暂停 Push，继续 Pull 和 WebSocket 唤醒。
- 显示用量、清理或升级入口。
- 收到账号策略事件、重新连接或用户手动刷新后重试。
- 不清除 refresh token、不重做 Workspace、不创建冲突副本来绕过限制。

## 8. 对账与修复

后台 job 按账号分片重算：

- active objects/bytes。
- CRDT 当前与 retained bytes。
- 全部 `state=ready` 的 Blob 按实际 storage key 去重 bytes，不以当前对象是否引用为过滤条件；无引用 ready Blob 仍收费，直到 fencing-aware GC 已确认物理删除并提交扣减。
- active devices/workspaces。
- 未过期 reservations。

每个账号用短生命周期 `REPEATABLE READ` snapshot 捕获数据与 `account_usage.revision`，离线计算 expected；提交补偿时 CAS 原 revision，期间有新写则放弃并重排，不能覆盖并发 delta。差异在容忍阈值内自动补偿并写 usage event，较大差异进入人工 review，但人工修复仍走相同 CAS/审计接口。按账号分片避免全库长事务，不将账号 ID 作为 Prometheus label。

初次上线：

1. 回填 bytes 列。
2. shadow 构建 account_usage。
3. 连续多轮对账无系统性差异。
4. `observe` 模式记录本应拒绝的操作。
5. 再按账号 cohort 切 soft/hard。

## 9. API、Web 与运维

新增：

```text
GET /v1/account/usage
GET /v1/web/account/usage-history?period=...
GET /v1/web/admin/accounts/:id/usage
POST /v1/web/admin/accounts/:id/usage/reconcile
```

账号上下文返回当前 usage、effective limits、warning threshold、状态和更新时间。本计划不提供人工 limit override；计划 04 的 entitlement grant 以后可替换 limits provider，但任何人都不能直接编辑 counter。

`usage_events` 按时间分区并设在线明细保留/周期汇总，避免每 command 一行成为新容量热点。指标：reservation 数/字节、quota decision、counter delta、reconcile drift、blocked accounts、usage job 延迟。高基数账号明细只进入受控管理查询，不进入指标 label。

## 10. 建议 PR 切片

1. **PR-03A：计量定义与 bytes 列。** migration、backfill、查询对账器。
2. **PR-03B：account_usage/ledger。** NULL-safe scope 唯一约束、幂等事件、设备/Workspace counter、shadow 模式。
3. **PR-03C：对象与 CRDT 热路径。** durable + Web/legacy 统一 UsageGuard。
4. **PR-03D：Blob reservation。** begin/complete/abort/expiry 并发语义、全部 ready Blob 对账口径。
5. **PR-03E：Static Limits 与执行。** `EffectiveLimitsProvider`、observe/soft/hard、revision fencing、账号上下文。
6. **PR-03F：Web/客户端 UX。** usage 页、warning、quota-blocked、恢复触发。

## 11. 测试矩阵

- 两个实例同时上传刚好超过剩余额度时只有一个 reservation 成功。
- begin 外部调用失败、complete 进程退出、abort 重试、过期维护都不会泄漏 reservation。
- 相同 command ID、相同 Blob、设备重登和 Workspace 重试不重复计量。
- 更新对象按新旧差值计量；删除在已超额时仍可执行。
- CRDT checkpoint/prune 后 active/retained delta 正确。
- legacy Web 测试写和 durable 客户端写都不能绕过 limit。
- 配额下调使账号超额但不删除数据；Pull/导出/删除仍可用。
- 自托管 enforcement disabled 时不产生商业限制，实例安全上限继续生效。
- 对账能检测并安全修复故意破坏的 counter。
- 对账 snapshot 后发生新写时 CAS 失败重试，不覆盖新 delta；月度请求重试不重复计量且账期边界固定。
- 不同 Workspace 的相同 command/blob ID 不冲突，同 idempotency key 不同 payload 被拒绝。
- 所有 bigint 通过 API 使用字符串，无 JavaScript 精度损失。

## 12. 上线、回滚与验收

12C/12F 已将 durable command 的 `quota_exceeded`/device 限额及其他 account-action rejection 从逐条 blocked 转为保留 outbox 的全局暂停，不再在同一 flush 高频重试；用户或运营方处理后再显式恢复。Hard enforcement 只在所有 HTTP/Web/legacy/durable/admin writer 版本都识别 UsageGuard/schema 后开启；任何旧 server 都能绕过 object/device/workspace guard，不能仅保护 reservation。

回滚只关闭 enforcement，不删除 usage/ledger/reservation 表。关闭前仍需等待或释放有效 reservation；旧版本若不理解任一 usage guard，不得在滚动发布中与 hard enforcement 混跑。

验收条件：

- 用量定义在代码、API、UI 和运营文档中一致。
- 并发上传/command 无配额穿透或双计量。
- 超额不会让客户端登出、丢 outbox 或停止 Pull。
- 能按账号重算并解释 counter 差异。
- 订阅计划只需提供 EffectiveLimits，无需修改同步领域代码。

## 13. 开放问题

- 套餐是否向用户计入历史版本；本规格建议不计入商业 active storage，但用 retained safety limit 控制成本。
- Blob 跨 Workspace 是否永远不去重；当前模型是 Workspace 级标识，本计划按实际现有存储行为计量。
- 月度 ingress/egress 是否进入首版套餐；建议先 observe 至少一个完整账期再决定。
