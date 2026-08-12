# 05：官方托管合规与数据治理技术规格

- 状态：已完成（内部测试范围；地域政策、法律 hold 审批主体、外部删除账本与恢复演练移至 [13 生产上线准备](13-production-readiness.md)）
- 日期：2026-08-11
- 默认适用形态：`hosted`
- 前置依赖：[00 共享基础](00-shared-foundation.md)；Pilot Gate（05A、05B、05C 最小访问、05D identity/sync/blob 删除 + 外部 deletion ledger/restore barrier/drill）是任何 hosted 真实用户前置，账单删除扩展需 [04 订阅权益](04-hosted-subscriptions-entitlements.md)
- 交付结果：服务能够解释保存了什么、为何保存、保存多久，并可执行可审计的数据访问、导出、删除与法律保留流程

## 1. 边界声明

本文是工程规格，不是法律意见。适用地区、处理依据、法定时限、税务记录和具体保留期必须由专业顾问及实际运营主体确认。代码使用可配置策略和版本化文档，不能把未确认的法定数字写死。

当前档位固定为内部测试：`HOSTED_DATA_REGION=local-internal-test`、删除冷静期 30 天、工程数据保留期 90 天，legal hold 审批主体为 `platform-admin`。这些仅用于删除/恢复演练，不构成对外隐私承诺，也不允许开启 hosted 真实用户注册或数据请求 capability。

## 2. 目标

- 建立数据清单、敏感级别、处理目的、存储位置、第三方接收者和保留规则。
- 记录服务条款/隐私政策版本及用户接受证据。
- 提供账号数据访问/导出、更正入口、删除申请、冷静期、进度和工程完成收据。
- 区分删除、停用、风控锁定、计费只读和 legal hold。
- 使主库、Blob、缓存、任务、日志、外部 provider 和备份有可执行的清理策略。
- 保护 hosted managed key 和备份中的解密能力。
- 防止灾备恢复意外复活已完成删除的账号。

## 3. 非目标

- 不承诺服务端能解密 E2EE 内容。
- 不把系统管理员 JSON 导出包装成用户完整数据导出。
- 不在在线 API 中提供立即物理擦除所有备份的虚假承诺。
- 不允许普通客服自行创建 legal hold 或查看用户内容。

## 4. 数据清单基线

实施前维护版本化 inventory，至少覆盖：

| 类别 | 例子 | 敏感度 | 主要存储 | 删除/保留负责人 |
| --- | --- | --- | --- | --- |
| 身份 | 邮箱、验证状态、密码哈希、TOTP | 高 | PostgreSQL/密钥系统 | Identity |
| 会话/设备 | token hash、设备名、最近活动、IP/UA | 高 | PostgreSQL | Security |
| 同步内容 | ciphertext、版本、冲突、Blob | 高 | PostgreSQL/Blob | Sync/Storage |
| 密钥材料 | managed envelope、E2EE envelopes、KMS key ID | 最高 | PostgreSQL/KMS | Security |
| 运营 | 用量、订阅、工单、风控事件 | 高 | PostgreSQL/providers | Ops |
| 审计 | actor、action、target、reason、request ID | 高 | PostgreSQL/不可变日志 | Security/Compliance |
| 备份 | 数据库 dump、Blob snapshot、manifest | 最高 | 备份目标 | SRE |

每个新表的 PR 必须更新 inventory：字段、目的、访问角色、加密、第三方、保留期和删除 handler。未登记的数据不能进入生产采集。

## 5. 数据模型

```text
policy_documents
  id uuid pk
  type enum('terms','privacy','data_processing','cookie')
  version text
  locale text
  content_ref text
  canonicalization_version integer
  content_hash text
  effective_at timestamptz
  requires_reacceptance boolean
  retired_at nullable
  unique(type, version, locale)

policy_acceptances
  id bigserial pk
  account_id uuid nullable
  subject_hash text
  subject_snapshot jsonb
  policy_document_id uuid
  accepted_at timestamptz
  ip_prefix_hash text nullable
  user_agent_family text nullable
  evidence_version integer

data_requests
  id uuid pk
  account_id uuid nullable
  subject_hash text
  client_idempotency_key text
  request_hash text
  type enum('access','export','correct','delete','restrict','object')
  status enum('submitted','identity_check','queued','processing','awaiting_user','completed','rejected','canceled','held','failed')
  request_channel text
  due_at nullable
  verified_at nullable
  completed_at nullable
  reason_code nullable
  result_ref nullable
  created_at, updated_at
  unique(subject_hash, client_idempotency_key)

account_deletion_cases
  id uuid pk
  account_id uuid nullable
  subject_hash text
  status enum('requested','cooling_off','scheduled','held','purging','completed','canceled','failed')
  requested_at
  cancel_until
  purge_after
  completed_at nullable
  cancel_credential_hash text nullable
  purge_manifest_ref text nullable
  purge_manifest_hash text nullable
  failure_code nullable
  created_at
  partial unique(account_id) where status in ('requested','cooling_off','scheduled','held','purging')
  partial unique(subject_hash) where status in ('requested','cooling_off','scheduled','held','purging')

account_deletion_fences
  account_uuid uuid pk              -- 稳定主体 UUID，不设回 accounts 的 FK
  subject_hash text
  generation uuid
  state enum('cooling_off','scheduled','purging','completed','canceled')
  hold_revision bigint
  blocks_domain_writes boolean
  created_at, updated_at
  completed_at nullable

legal_holds
  id uuid pk
  subject_type, subject_id
  scope jsonb
  reason_reference text
  starts_at, expires_at nullable, released_at nullable
  created_by_staff_id, released_by_staff_id nullable

deletion_case_holds
  deletion_case_id uuid
  legal_hold_id uuid
  scope_snapshot jsonb
  primary key(deletion_case_id, legal_hold_id)

deletion_case_steps
  deletion_case_id uuid
  handler text
  state enum('pending','running','completed','failed','skipped')
  attempt integer
  idempotency_key text
  external_ref text nullable
  last_error_code text nullable
  completed_at nullable
  primary key(deletion_case_id, handler)

deletion_ledger
  subject_hash text pk
  hash_key_id text
  deletion_case_id uuid
  completed_at
  minimum_backup_generation bigint
  minimum_database_lsn pg_lsn nullable
  receipt_hash text
```

`deletion_ledger` 位于与普通应用备份隔离、同样受灾备保护的受控存储中，或在恢复后从不可变外部副本重放。`subject_hash` 使用 instance scope + 稳定 account UUID 的版本化 HMAC，不能基于邮箱；它是可关联的 pseudonymous 高敏记录，按可能属于个人数据保护，不能断言“不是 PII”。收据是工程处理记录，不宣称法律意义上的不可争议证明。`account_deletion_fences.account_uuid` 同样按高敏 pseudonymous 标识登记保留策略；它故意不带 FK，账号业务行删除后仍作为异步写屏障，并最终由 deletion ledger/恢复屏障继续阻止主体复活。

内部测试中 `deletion_ledger_outbox` 先持久化投递意图，再写入 `DELETION_LEDGER_PATH` 下 create-exclusive、按 idempotency key 命名的 receipt 文件；文件已写而数据库尚未确认时重试会验证完全相同的内容并收敛，只有 outbox delivered 才完成 case/fence。它不满足生产不可变/跨灾害域保证，生产必须替换为受控外部存储适配器。

Hosted 配置会拒绝将 `DELETION_LEDGER_PATH` 规范化后指向 filesystem Blob 或 backup 路径；内部演练也不能把 receipt 与同一清理生命周期混放。

receipt replay 会校验文件名与 idempotency key、receipt hash 与本地 ledger 的 case/time/generation/LSN/hash 一致；任何解析或冲突错误都在 Hosted HTTP socket 绑定前 fail-closed，不把损坏账本当作“没有已删除主体”。

迁移会把早期仅有本地 ledger 的 completed case 回退为 `purging` 并生成待投递 outbox；这比错误宣称已有外部收据更安全，maintenance 重放成功后才再次完成。Hosted 服务在绑定 HTTP socket 前会读取 receipt store：与恢复快照中账户 UUID 的 HMAC 匹配时，先重建删除 fence、禁用账户、撤销 bearer/device 凭据并 tombstone Workspace，再复用既有 purge handler；已 delivered 的收据不会再次外部投递。

## 6. 政策接受

- 注册页面显示当前政策版本并记录明确接受；预勾选无效。
- `content_ref` 指向不可变原始字节/对象；按版本化 canonicalization 计算 hash，保证未来可还原当时呈现版本。Acceptance 只能记录“系统呈现该版本且用户执行 affirmative action”，不能证明用户实际阅读或替代法律评审。
- `account_id` 外键使用 `ON DELETE SET NULL`；`subject_hash` 和当时的最小主体快照让账号删除后仍能保留接受记录，但不得保存可重新建立账号的邮箱明文。
- `requires_reacceptance` 的新版本通过账号上下文返回 restriction；用户可先导出/删除，其他新写入可按政策暂停。
- 当前内部测试实现将未接受的强制政策投射为 `policy_reacceptance_required`，在 account context 中 deny `sync.push`/`blob.upload`，并以服务端 preHandler 阻止 Sync command、全部非 DELETE 的 Workspace（含 key/recovery）写入与 Blob upload；DELETE 保持可用。后续仍需收敛为完整 OperationPolicy enforcement。
- 未登录公开页面始终可查看当前及必要历史政策。
- 客户端浏览器授权遇到 reacceptance 时转到 Web 完成，不在原生客户端复制法律文案。

## 7. 数据访问与导出

将三种概念分开：

1. **客户端本地导出/备份**：本地 Markdown、数据库和应用数据，由 NoteGen 客户端负责。
2. **账号数据导出**：服务端持有的身份、设备、用量、订阅、审计摘要和同步密文/Blob 清单。
3. **实例灾备**：整库/Blob 备份，只用于恢复，不交给普通用户。

`POST /v1/web/account/data-requests` 创建持久 job，client idempotency key 与规范 request hash 决定重试去重；同 key 不同请求冲突。已登录账号使用最近登录 + 计划 00 step-up；账号已删除/无法登录的主体进入独立人工 identity-check channel，不能强依赖现存 `account_id`，也不能仅凭 Cookie 下载高敏归档。

导出包建议：

```text
manifest.json          版本、生成时间、账号、校验和、加密模式说明
account.json           allowlist 身份/设备/会话摘要；无 password/TOTP/token hash
usage.json
billing.json           不含支付凭据
support.json           仅 customer-visible 消息；无 internal notes/staff 私有数据
sync/objects.ndjson    密文、revision、key version、元数据
sync/key-envelopes.json
blobs/                 或短期签名下载清单
README.txt             如何导入/解密及 E2EE 限制
```

每类 export serializer 使用字段 allowlist；billing/risk/audit 需排除支付凭据、内部规则、其他主体/员工数据。导出结果以随机 archive key 做 AEAD；key 通过用户在 step-up 后提供的导出口令 KDF 包装，或通过同 Session 的一次性受控 key endpoint 交付，不能把 key 与 archive 放在同一 bearer URL。

应用代理 ticket 可在数据库中原子消费并承诺一次性；普通对象存储 signed URL 只能描述为短期 bearer URL。下载/失败单独审计，结果过期后 job 清理物理文件。

内容可用性：

- E2EE：服务端只可导出密文和 envelopes；用户需 NoteGen 与同步口令/恢复密钥。
- managed：一期仍导出加密数据；账号 Web 可在浏览器端把 workspace key 重包给用户提供的导出口令，避免服务端生成长期明文归档。
- 普通用户更易用的 Markdown 导出优先由已解锁的 NoteGen 客户端执行。

## 8. 删除状态机

当前 `disabledAt` 同时代表删除申请和登录禁用，需迁移到显式 case：

1. `requested`：用户 step-up 确认，记录政策与影响。
2. `cooling_off`：在同一事务创建带随机 generation 的 deletion fence，立即撤销普通 refresh/Web Session、阻止新设备和写入；签发/保留一条短期、action-scoped cancel/export credential，或要求重新验证身份，保证取消入口真实可用而不恢复完整账号权限。
3. `scheduled`：冷静期结束，等待异步 purge；先取消/结束订阅并完成必要对账。
4. `held`：仅有授权的 legal hold 可暂停特定数据清理，不应恢复正常使用。
5. `purging`：按有序 handler 删除外部和内部数据。
6. `completed`：写 deletion ledger/工程收据，账号主体不可再登录。

推荐 purge 顺序：

1. 取得与 legal-hold 创建/释放共用的 subject-scoped exclusive lock，核对 case、fence generation、hold revision、幂等键与主体；每个破坏性 handler 在外部副作用前都必须重新取得该锁并按 scope 复查，不能只在整条流程开头检查一次。
2. 在删除任何业务行前生成加密、不可变的 purge manifest：Workspace/Blob storage key+VersionId、外部 provider ref、KMS/key ref、预期数量/hash；写入 case 的 manifest hash。
3. 撤销所有 session/action token/invitation/support grants 与 scoped cancel credential；按主体取消或 drain 已排队/运行的普通 job/outbox，等待 worker lease 收敛。所有 job/outbox/inbox payload 都携带 account UUID 与 enqueue 时 fence generation，handler 在业务提交前重查 fence；晚到 Webhook 可以验签和最小落 inbox，但只能进入删除 reconciliation/批准保留路径，不能重建已删除领域行。
4. 结束计费 customer 的可取消关系，保留法律要求的最小交易记录映射；处理由此产生的 provider event，并再次抓取 provider snapshot/ref 清单。未到达确定终态或仍有 subject job/inbox lease 时不得继续完成。
5. 删除/匿名化工单、风控和邮件数据，按各自批准的保留规则处理。
6. 按 purge manifest 删除 Blob/外部对象并确认不存在；失败则 step 重试，不能先删掉定位它们的数据库行。
7. 删除 Workspace 及 PostgreSQL 依赖数据，销毁 purge manifest 的敏感 envelope key，仅保留 manifest/receipt hash。
8. 匿名化必须保留的审计、支付和工单 actor/target/subject snapshot；保留行使用 nullable `ON DELETE SET NULL` 关联或独立 pseudonymous subject，不依赖仍存在的 account FK。
9. 在配置的 provider quiet window 后做最后一次 subject job/inbox/provider-ref 扫描；任何新事件都回到对应 handler，不得签发 completed。
10. 两阶段写外部 deletion ledger 与本地 completed/receipt，并把 fence 原子置为 `completed`；任一侧成功、另一侧失败都由 reconciliation 收敛，不能提前返回 completed。Completed fence 继续拒绝普通异步领域写。

`deletion_case_steps` 是恢复账本；每个 handler 有 idempotency key、attempt、external ref 和完成时间，可从任意崩溃点恢复。多个 legal hold 通过关联表按 scope 求并集；hold 创建/释放与 destructive handler 使用同一 subject lock，并在事务中递增 `hold_revision`，因此并发顺序确定且新 hold 不会被已读取的旧 snapshot 绕过。人工“恢复账号”只在 cooling-off 且没有 purge 副作用时允许；取消时必须以旧 generation CAS 把 fence 置为 `canceled`、轮换 generation 并关闭 write block，旧 worker 携带的 generation 此后仍不得提交，不能直接删除 fence 行。

用户工程收据分别列出：在线系统已处理范围、依法/安全仍保留的最小类别、备份预计轮换到期时间和无法立即擦除的原因；不得笼统写“所有副本已永久删除”。

PR-05D 开启 shadow/双写前，必须先让现有 maintenance account purge 尊重 deletion case/active hold，或停止 legacy 物理清理；否则旧 `disabled_at` 逻辑会绕过 hold。

## 9. 备份与恢复中的删除

- 备份有明确最大保留期和不可变 manifest；用户文案说明已删数据会在备份轮换中到期。
- 灾备恢复后、开放业务流量前，必须重放 deletion ledger，重新删除备份快照之后已完成的主体。
- restore preflight 比较 backup generation/LSN；从备份恢复后的 hosted 实例在完成 ledger 可用性校验、外部/本地两阶段 reconcile 与重放前不得 ready。普通运行期的短暂探测故障进入受控只读/告警，不误判为一次新恢复。
- 不对普通应用备份做选择性修改，以免破坏完整性与恢复可靠性。
- 每次恢复演练验证一个已删 synthetic account 不会复活。

## 10. Managed key 托管要求

当前 managed envelope 实质包含可恢复 workspace key。hosted 上线前：

- 使用 KMS/HSM envelope encryption；数据库只保存 wrapped key、KMS key ID、算法/version 和上下文。
- 解包只在受控服务身份中发生，按 account/workspace/request 记录密钥访问审计。
- generic key-list API 不得再返回可直接解密的 managed workspace key/envelope。客户端先注册 device public key，服务端经授权/KMS 解包后只产生短期、device-bound rewrap/key grant；账号 Web 同样使用 step-up、最小范围接口，不向客服或通用管理员返回 key。
- KMS key rotation 支持旧 key 解包和惰性重包；灾备清单包含 key 版本依赖但不包含 KMS 主密钥。
- hosted 备份无 KMS 权限时不可单独解密；恢复演练必须同时验证 KMS 可用性。
- E2EE envelopes 不经过 KMS 解包，不改变现有威胁模型。

05F 与对应客户端 key-grant 接入完成前，hosted `managedDefaultWorkspace` 保持关闭或仅限无真实数据的内部 cohort；不能把“数据库已 KMS 包裹”误当作 API 分发已经收口。

## 11. 审计与最小权限

- 将 `admin_audit_logs.actor_account_id ON DELETE CASCADE` 迁移为 nullable actor reference + 不可变 actor snapshot，避免删账号连带删审计。
- hosted 禁止管理员把安全/合规审计保留期任意缩到 1 天；最低值由部署政策锁定。
- 使用计划 00 permission registry：合规处理与 `legal_hold.manage/approve` 分离，hold scope 使用版本化受控 schema；创建/释放要求 step-up 与两位不同 staff 审批，`platform_admin` 不自动绕过。客服只有工单范围。
- 导出下载、managed key 解包、hold 创建/释放、删除取消/完成均为高敏审计。

## 12. API 与用户体验

```text
GET  /v1/web/policies/current
POST /v1/web/policies/:id/accept
POST /v1/web/account/data-requests
GET  /v1/web/account/data-requests
GET  /v1/web/account/data-requests/:id
POST /v1/web/account/deletion
POST /v1/web/account/deletion/cancel
GET  /v1/web/admin/compliance/requests
POST /v1/web/admin/compliance/requests/:id/action
```

账号删除响应不再仅给 `purgeAfter`，还返回 case ID、cancel deadline、当前状态和解释 URL。NoteGen 客户端只打开账号 Web；本地编辑数据是否保留由客户端明确询问，不远程删除本地文件。

现有 `DELETE /v1/account` 在兼容窗口内映射为创建同一 deletion case，继续 additive 返回旧 `purgeAfter`，同时增加 case ID/status；不能直接删除 endpoint 或继续走 legacy immediate purge。capabilities/客户端迁移完成后再安排移除旧形态。

## 13. 实施步骤与 PR 切片

1. **PR-05A：Data Inventory + Retention Registry。** 表/字段清单、第三方、owner、清理 handler 契约；所有 hosted PII 功能前置。
2. **PR-05B：政策 + Retention。** immutable 文档/接受、注册 restriction、已登记数据清理策略。
3. **PR-05C：Data Request/Export。** 先交付基础 access/export，再扩展加密归档、短期下载、E2EE/managed 说明。
4. **PR-05D：Deletion Case/Purge/Deletion Ledger。** Pilot 先完成 identity/sync/blob 实际删除；先 fence legacy maintenance，再从 `disabledAt` 双读迁移、subject deletion fence、job/inbox generation guard、step ledger/purge manifest、外部 deletion ledger 两阶段写与 backup generation/LSN restore barrier。04/06 上线前扩展 billing/support handler。
5. **PR-05E：Legal Hold。** 独立权限、与 destructive handler 共用的 subject lock/hold revision、scope 合并、审批与审计迁移；不得把 05D 已承诺的 deletion ledger/restore barrier 延后到本切片。
6. **PR-05F：Hosted KMS。** managed envelope 版本、双读、重包与恢复演练。

## 14. 测试与演练

- 政策版本/hash/locale 正确，重确认不阻断导出和删除。
- 同一 data request 重试只生成一个有效归档；过期下载失效并清理文件。
- 同 idempotency key 不同 request hash 冲突；已删除/无法登录主体进入独立 identity check。
- E2EE 导出不会请求/记录明文 key；managed 导出口令重包仅在浏览器端完成。
- 删除在每个 handler 前后模拟进程退出，最终一次完成且不提前出具工程收据。
- `scheduled → purging → completed` 每一跳均可在崩溃后重入；purging 只能在 workspace/blob handler 已完成且无 active hold 时进入，purge manifest/ref/hash 必须在 support 内容、identity 行删除前持久化，step idempotency key 不因重试改变。
- purge manifest 在 DB 行删除前固化；Blob/external 删除失败仍保留定位信息，多个 hold scope 正确合并。
- legal hold 创建/释放只接受独立 Staff realm 的 `legal_hold.manage + legal_hold.approve`，不接受客户 `accounts.isAdmin`；与每个外部删除 handler 并发时按 subject lock/hold revision 串行化，不会在旧 snapshot 下误删。
- cooling-off/purging/completed 期间，旧 generation job、晚到 Webhook 和 provider 取消回调都不能重建主体数据；quiet-window 扫描未收敛时不得 completed。
- 删除事务与已认证的晚到写入并发时，workspace 创建/密钥变更/删除恢复、durable sync/bootstrap、blob 分片与完成、support 创建和回复都在各自提交事务中重查 subject fence；删除先提交后，写请求必须稳定拒绝且不得留下领域行。
- cooling-off 可取消，purging 开始后不可恢复。
- Web step-up 与兼容原生 `DELETE /v1/account` 都必须在同一 deletion transaction 执行 authentication risk restriction；deny/lock/review 时不创建 case、不禁用账号、不撤销任何凭据。
- deletion cancel 不受该 restriction 阻断，且取消后仍不能恢复删除前的 Web Session、refresh token、device authorization 或 pairing。
- Hosted 内部测试的 legal hold 仅通过独立 Staff session 的 `POST /v1/internal/staff/compliance/accounts/:accountId/legal-holds` 与 `POST /v1/internal/staff/compliance/legal-holds/:holdId/release` 操作；路由不建立 Staff session，要求 `step-up` 或 `phishing-resistant` assertion，并由服务层重复核验 `legal_hold.manage + legal_hold.approve`。
- legal hold 只暂停 scope 内数据，释放后任务继续；无权限者无法创建/释放。
- 账号删除后审计仍在但 PII 已按规则匿名化。
- 从删除前备份恢复后，deletion ledger 阻止已删账号复活；启动期 replay 必须发生在 HTTP 监听之前。
- ledger 外部写/本地 complete 任一侧崩溃可 reconcile，backup generation/LSN barrier 可比较。
- deletion ledger 的 `minimum_backup_generation` 必须等于完成时最大 ready backup generation 加一；早于该 generation 的备份只能在外部 ledger replay 后作为恢复输入，不能被宣称为 post-deletion baseline。
- `doctor` 对 completed case 缺 delivered ledger receipt、delivered receipt 缺 completed case、或本地 ledger 缺 replay outbox 返回 blocking；purging 缺 manifest、pending receipt delivery 或 completed case 留有未完成 step 返回 warning，避免把中断的 deletion 误判为已完成。
- KMS current/previous key、故障和恢复路径均验证，E2EE 行为不变。

## 15. 上线、回滚与验收

先完成 Pilot Gate：05A/B、05C 最小访问、05D identity/sync/blob 真实删除、外部 deletion ledger/restore barrier 与真实 restore 演练；这是任何 hosted 真实用户 gate。随后按新功能扩展 billing/support handler 与 legal hold。KMS 采用双读、只写新格式，确认 rewrap/API key-grant 覆盖率后再停止原 managed key 读取并开启 managed default。

回滚可暂停新请求和 worker，但不能撤销已经完成的删除或重新写回原始 managed key。删除 ledger、政策接受和审计 schema 必须向前保留。

验收需要：数据清单有 owner；导出/删除可追踪；备份恢复不会复活已删主体；客服/管理员不能越权查看内容或密钥；所有对外保留承诺已由法律/隐私评审确认。

## 16. 开放问题

- 实际运营主体、适用地区、政策文本、请求时限和各数据类别保留期。
- 合规不可变存储/删除 ledger 的基础设施选择。
- managed 内容是否提供服务端生成的可读导出；一期建议避免，优先客户端/浏览器本地导出。
