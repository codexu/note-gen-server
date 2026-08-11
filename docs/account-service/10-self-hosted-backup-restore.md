# 10：自托管备份、恢复与灾备技术规格

- 状态：Draft
- 日期：2026-08-11
- 适用形态：`self-hosted`；hosted 使用内部基础设施 Runbook，不向普通管理员开放整库下载
- 前置依赖：[00 共享基础](00-shared-foundation.md)，包括实例级 `authEpoch/tokenNotBefore` 的签发与全链路校验契约
- 分阶段依赖：10A 先提供 additive `syncEpoch`/fencing contract；[12H 客户端支持](12-client-account-service-integration.md)普及后才允许本计划开启 preserve restore
- 交付结果：数据库、Blob 和实例身份形成可校验的一致备份；恢复只能通过离线、预检、可回退流程执行

## 1. 当前基线

- 管理后台备份只执行 PostgreSQL custom-format `pg_dump`，不包含 Blob、manifest、加密和恢复验证。
- `scripts/backup.sh` 会停止单机 server，dump 数据库并复制文件系统 Blob，但只校验 database dump。
- S3/多实例依赖人工维护窗口。
- 数据库备份包含 managed workspace key、密码哈希、TOTP 密文、token hash 和全部账号元数据，属于最高敏感数据。
- 客户端本地 `.ngbackup` 是另一套能力，不是服务器灾备；两者不能共用文案或恢复按钮。

## 2. 目标

- 定义版本化、可验证、可迁移的统一备份格式。
- 覆盖 PostgreSQL、Blob、实例/Schema/版本元数据及必要配置指纹。
- 分别支持单机文件系统与 S3-compatible 备份策略。
- 支持手工/计划备份、保留、加密、异地目标和失败告警。
- 提供只读 verify 与 offline restore CLI，不在运行中的 Web 服务直接覆盖实例。
- 明确原地灾备恢复和克隆测试恢复的身份语义。
- 每次正式版本发布前至少能完成自动校验，周期性执行真实恢复演练。

## 3. 非目标

- 一期不自建 PostgreSQL PITR/WAL 归档服务；可对接外部能力。
- 不承诺零停机全量文件系统快照。
- 不把生产 secret 明文自动塞进备份包。
- 不允许浏览器一个按钮无确认覆盖主数据库。
- 不用客户端本地备份替代服务器灾备。

## 4. 恢复目标与策略档位

部署者显式配置目标，而不是项目文档承诺统一数字：

```text
BACKUP_SCHEDULE=0 3 * * *
BACKUP_RETENTION_DAILY=7
BACKUP_RETENTION_WEEKLY=4
BACKUP_TARGET_DRIVER=filesystem|s3
BACKUP_TARGET_PATH=/...
BACKUP_TARGET_S3_*=...
BACKUP_ENCRYPTION=age|kms|none
BACKUP_SIGNING_DRIVER=ed25519|kms
BACKUP_SIGNING_KEY_ID=operator-defined-id
BACKUP_SIGNING_PRIVATE_KEY_FILE=/run/secrets/notegen-backup-signing-key
BACKUP_SIGNING_KMS_KEY=
BACKUP_TRUST_STORE=/etc/notegen/backup-trust.json
BACKUP_TRUST_ROOT_PUBLIC_KEY_FILE=/etc/notegen/backup-root.pub
BACKUP_TRUST_HIGH_WATER_STATE=/var/lib/notegen/backup-trust-high-water.json
BACKUP_RPO_TARGET_HOURS=24
BACKUP_RTO_TARGET_HOURS=4
```

- 兼容期若仅设置现有 `BACKUP_PATH`，将其映射为 `BACKUP_TARGET_DRIVER=filesystem` 与 `BACKUP_TARGET_PATH`，并持续提示迁移；新旧路径同时存在且不一致时拒绝启动备份 worker，不静默选择其一。
- `none` 仅允许本地受控目标并持续警告；远程目标必须加密。
- signing private key/KMS、只含公钥和状态的 trust store、离线 root 的 pinned public key 三者分离；`ed25519` 只读取权限受限 secret file，`kms` 只保存 key reference。所选 driver 对应的 signer 不能为空、不能复用 `AUTH_SECRET`；offline root private key 永不部署到 server，包内携带的公钥/key status 只作提示，绝不能成为自己的信任来源。
- high-water state 独立于备份 target，以原子 replace + fsync 保存最高接受的 root version、trust revision 和 canonical digest。`verify/restore apply` 只接受不低于该水位且链连续的 trust store；新灾备主机若没有该状态，必须从离线恢复包提供受信的 `--minimum-root-version`、`--minimum-trust-revision` 与 `--expected-trust-digest`，不能从待验证备份或候选 trust store 自行初始化水位。首次 `trust init` 需要 operator 显示并确认离线 root fingerprint/revision，写审计后才建立本地水位。
- 备份 target 与主 Blob backend 分开配置，避免同一凭据/生命周期误删。
- 排程、保留和 RPO/RTO 是运维目标，状态页显示“最近成功备份/验证/演练是否满足”，不伪装成保证。

## 5. 统一备份格式

逻辑目录：

```text
manifest.json
manifest.sig
database.dump[.enc]
blobs/
  <storage-key or packed chunks>
blob-index.ndjson[.enc]
checksums.txt
README-restore.txt
```

`manifest.json`（本身不含 secret）至少包括：

```json
{
  "formatVersion": 1,
  "backupId": "uuid",
  "createdAt": "date-time",
  "completedAt": "date-time",
  "serverVersion": "semver",
  "database": {
    "postgresMajor": "17",
    "pgDumpMajor": "17",
    "migrationHead": "0022",
    "migrationSetHash": "sha256:...",
    "extensions": [{ "name": "...", "version": "..." }],
    "collation": "...",
    "format": "pg-custom",
    "size": "0",
    "sha256": "..."
  },
  "deploymentMode": "self-hosted",
  "instanceId": "uuid",
  "syncEpoch": "uuid",
  "authEpoch": "decimal-string",
  "backupGeneration": "decimal-string",
  "artifactRootSha256": "...",
  "blobs": { "count": "0", "bytes": "0", "indexSha256": "..." },
  "storage": {
    "sourceDriver": "filesystem",
    "adapterVersion": 1,
    "snapshotMethod": "drained-copy"
  },
  "encryption": { "mode": "age", "keyId": "operator-defined-id", "layout": "artifact-aead-v1" },
  "signature": { "algorithm": "ed25519", "keyId": "backup-signing-2026-01" },
  "requiredSecrets": [
    { "purpose": "totp-keyring", "fingerprint": "..." }
  ]
}
```

所有整数避免 JavaScript 精度丢失，使用十进制字符串。manifest 完成前备份状态为 incomplete，不纳入可恢复列表。`checksums.txt` 覆盖 manifest 之外的每个 artifact；大规模 Blob 可使用分块 Merkle/root hash 与逐对象 index。

Checksum 只能发现普通损坏，不能防止攻击者同时替换 artifact 与 manifest。格式必须认证：对 canonical manifest（冻结 canonicalization/version）生成 detached Ed25519/KMS signature；每个 artifact 使用随机 data key 的 AEAD/age envelope，manifest 记录 nonce/layout/hash，data key 再包给 operator recipient/KMS。Verify 顺序固定为：限制解析大小/路径 → 验 manifest 签名与 key status → 解包 data key → AEAD 解密 → 校验 artifact/Merkle hash → 才调用 `pg_restore --list`。`BACKUP_ENCRYPTION=none` 也必须有受控 signing key；缺签名只能标记 legacy/untrusted，不能成为 ready unified backup。

`backup-trust.json` 是 operator 在备份之外保管、由离线 root 签名的版本化信任事实，至少记录单调 trust revision、`keyId`、public key/KMS verifier、`active|retired|revoked`、生效/退休/撤销时间及 root signature；CLI 以另行分发的 pinned root public key 验证它，并与外部 high-water state/显式最低 revision+digest 同时比较后拒绝回退。轮换顺序固定为：先用 offline root 签发包含新 verifier 的 trust store并验证所有恢复环境可读 → 原子推进各恢复环境 high-water → 切 writer → 保留旧 verifier 至所有受保留策略保护的备份过期或被重新签名/淘汰 → 再退休。撤销 key 默认让相关备份 verify/restore fail-closed；仅为取证的只读检查可显式使用 `--allow-untrusted-for-inspection`，但不得据此执行 `restore apply`。CLI 必须从外部 `--trust-store`/pinned root/受控 KMS 取 verifier，不能信任备份包内自带 key。

## 6. 数据模型与任务

```text
backup_policies
  id uuid pk
  enabled boolean
  schedule text
  target_ref text
  retention jsonb
  encryption_key_id text nullable
  created_by, updated_by nullable
  created_at, updated_at

backup_runs
  id uuid pk
  job_id uuid
  policy_id uuid nullable
  status enum('queued','preparing','draining','dumping','copying','verifying','ready','failed','deleting')
  snapshot_at timestamptz nullable
  manifest_ref text nullable
  database_bytes, blob_count, blob_bytes bigint nullable
  error_code text nullable
  checkpoint jsonb nullable
  created_at, completed_at nullable

backup_snapshot_blobs
  backup_run_id uuid
  workspace_id uuid
  blob_id text
  storage_key text
  size bigint
  ciphertext_hash text
  storage_version_id text nullable

restore_drills
  id uuid pk
  backup_run_id uuid
  mode enum('verify-only','isolated-restore','full-drill')
  status text
  checks jsonb
  started_at, completed_at nullable
  actor_id nullable

restore_markers
  id uuid pk
  backup_id uuid
  mode enum('preserve','clone')
  old_sync_epoch uuid
  new_sync_epoch uuid unique
  restored_through_sequence_by_workspace jsonb
  sanitation_status enum('pending','running','complete','failed')
  auth_epoch_after bigint
  bootstrap_token_cutoff timestamptz
  bootstrap_reissue_required boolean not null default false
  created_at, completed_at nullable
```

任务使用计划 00 的 durable job。备份创建、下载、删除、策略修改、验证和演练都记录审计；actor 删除不能级联丢失 job/run。

## 7. 一致性方案

### 7.1 单机文件系统

一期推荐短时写入维护窗口：

1. 预检磁盘、目标、secret 指纹、DB/Blob health。
2. 通过计划 00 `MaintenanceModeCoordinator` 设置 `write_drain`，停止新 command、Blob begin/complete、账号和普通后台写入；Pull/下载可继续。备份 owner 仅可更新自己的 lease/progress/manifest 与解除维护，不能写业务数据。
3. 等待在途写事务和 Blob completion lease 到安全点，超时则取消备份并恢复写入。
4. 创建 DB dump 和 Blob index/copy；server 进程可保留只读，避免整站无响应。
5. 校验数量/hash/引用关系，原子发布 manifest。
6. 清除 maintenance mode。

复制时间过长时支持文件系统快照 adapter（ZFS/LVM/云盘 snapshot），但必须由部署者声明其原子性。普通 `cp` 不声称零停机。

### 7.2 S3-compatible / 多实例

优先要求 bucket versioning 或 provider snapshot。PostgreSQL 可执行 cutoff 固定为：

1. 先提交一个全局 active backup lease/generation，使 Blob GC、账号 purge 和 storage cleanup 暂停删除；该 lease 必须在 snapshot 事务之外先对其他实例可见。
2. 开启 `REPEATABLE READ, READ ONLY` 事务，在该 snapshot 中建立 ready Blob index（含 storage VersionId/hash）并调用 `pg_export_snapshot()`。
3. 在 snapshot 事务保持打开时，使用兼容 major 的 `pg_dump --snapshot=<exported-id> --format=custom`；失败则整次备份失败，不能改用普通 dump。
4. dump 完成后提交 snapshot 事务；依据已固化 index 从不可变 storage key/version 复制到独立 target。
5. 校验签名、数量/hash/引用后发布 manifest，再释放 lease；失败 lease 保留到安全 TTL 并由 fencing-aware cleanup 恢复。

若 provider 不支持版本/一致快照，则进入全实例 write-drain 维护窗口。不得只 dump DB 后“稍后随便复制当前 bucket”，那会产生数据库引用与 Blob 不一致。

### 7.3 Blob 不变性

ready Blob 的 storage key 内容必须不可原地覆盖；相同 key 的写入视为完整性错误。当前 filesystem `rename` 与 S3 multipart complete 均不能直接视为满足此契约，PR-10C/D 必须先增加 adapter capability：filesystem 使用 conditional create/no-replace；S3 使用 versioned immutable key 或 provider 支持的 conditional complete，并持久化 VersionId/ETag。若后端无法证明 no-overwrite/version pinning，持续写入模式不可用，只能 write-drain 后复制。备份任务随机抽样重新计算 ciphertext hash，全量 hash 由策略选择。

## 8. 加密与 secret

- 备份加密密钥来自 operator-controlled age recipient、KMS 或独立 passphrase；manifest signing key/KMS 和 verify trust store 按第 4/5 节独立配置，任何一项都不复用 `AUTH_SECRET`。
- 加密在写入最终 target 前完成；临时明文位于权限受限目录并在成功/失败后清理。
- 恢复需要的 JWT/TOTP/managed-KMS keyring、S3/SMTP credentials 不默认写入备份；manifest 对密码类 secret 只写“需重新配置”，仅对高熵加密 key 保存非秘密 key ID/fingerprint。
- 运维 Runbook 要求将这些 secret、backup signing key 和 trust store 存入相互独立的 secret manager/离线介质并定期从灾备环境验证；只有私钥是 secret，public trust store 仍必须防篡改和版本回退。
- 缺少旧 TOTP/KMS key 时 restore preflight 阻断或明确要求禁用/迁移受影响凭据，不能静默让用户锁死。
- 下载完整备份要求计划 00 的 action-bound admin step-up；优先签发一次性短 TTL stream ticket/受控 signed URL，响应 no-store，下载开始/结束/失败单独审计。普通对象存储 URL 是短期 bearer，不宣称真正单次消费；hosted 不注册此路由。

## 9. 备份执行与保留

- 同一实例默认只运行一个全量备份；advisory lock + DB lease 防多实例重复。
- 排程错过时只补一次，不在重启后同时跑多份。
- 每阶段 checkpoint 可重入；只有可证明安全的 copy/verify 续跑，DB snapshot 中断必须重新开始。incomplete artifact 有独立 TTL/prefix，清理前逐项验证 target 边界。
- 删除策略先把 run 标 deleting，再删除 artifacts，成功后删 index/记录或保留最小审计；失败可重试。
- grandfather/father/son 保留通过已完成时间分类；incomplete/failed 有短期故障保留。
- 删除 target 前解析并验证 resolved key 必须位于该 backup run prefix，禁止任意路径/桶删除。
- 目标容量、最老未验证备份、连续失败、RPO 违约触发告警。

## 10. 离线恢复 CLI

概念命令：

```text
notegen-server backup list
notegen-server backup verify <manifest>
notegen-server restore preflight <manifest> --mode preserve|clone
notegen-server restore apply <manifest> --target-config <file>
notegen-server restore validate --target-config <file>
```

`restore apply` 只在 HTTP/worker 已停止或显式 offline target 上运行。流程：

1. 限制性解析并验证 manifest signature/envelope/checksum，不写当前实例；不信任包内路径、大小或 README。
2. 执行 `pg_restore --list`、PostgreSQL/pg_dump major、extension/collation、migration-set hash、临时空间和 secret/key ID preflight。
3. 校验目标路径/数据库为空或进入显式 replace 模式；replace 前创建并 verify 应急备份。
4. 进入 offline fencing，停止 HTTP 业务、WebSocket 和全部 worker；在隔离临时数据库和 Blob prefix 恢复。
5. 运行 schema compatibility、FK/数量、Blob existence/hash、workspace key envelope、instance metadata 检查。
6. 执行下述 restore sanitation；完成前任何 worker 都不能启动。
7. 选择身份语义，在隔离数据库中生成全新 sync epoch，并按计划 00 的共享契约推进实例 `authEpoch/tokenNotBefore`；确认目标 binary 会在 Access JWT、Refresh、Web Session、device authorization/pairing exchange 的签发和校验路径执行该代次后，写不可变 restore marker。
8. 原子切换目标连接/prefix，或由运维明确完成切换。
9. 启动只读验证，执行 health、账号登录、同步 snapshot bootstrap、抽样 Blob 下载。
10. 确认后开放写入；失败切回应急备份/旧 target。

CLI 必须在每个破坏步骤前打印 resolved target、实例 ID、backup ID、数据量和模式，并要求明确 confirmation；自动化使用一次性 confirmation file/flag，不能默认覆盖。

### 10.1 Restore sanitation allowlist

恢复数据库会带回过时的 lease、任务和凭据，不能“恢复完直接启动”：

- 清除/重建 advisory owner、rate-limit bucket、maintenance ack、backup/Blob lease、worker heartbeat、临时 upload 与运行中 job 状态。
- 将恢复出的 pending/running outbox、邮件、Webhook、billing/support sync 和未知 generation job 全部放入 quarantine；逐类人工 reconcile 后才可重放，默认不向外部系统再次发送。
- Restore preflight 先证明目标 binary 已达到计划 00 的最低认证契约且所有旧进程已停止；随后 Preserve 与 clone 在同一恢复事务中覆盖备份值，执行数据库 `instance_auth_epoch = instance_auth_epoch + 1`、`token_not_before = now()`、`auth_epoch_enforced = true`，并撤销全部 refresh/Web Session、device authorization、pairing、step-up grant、invitation、challenge 和 action token。数据库列是 bigint，manifest/wire 使用无损十进制字符串；即使旧备份中的 enforced=false 也不能带入运行态。旧 Access JWT 必须同时因 token 内代次/`iat` 与当前实例状态不匹配而立即失效。目标 binary 没有在全部认证入口执行该检查时 sanitation/preflight 失败并保持 offline。
- 备份之后可能发生密码/TOTP 变更、账号删除或封禁。所有恢复账号默认创建计划 00 的 `AccountRestriction(reasonCode='credential_review_required')`；AuthService 在校验密码/TOTP 后、签发任何 Web/Access/Refresh/device session 前锁账号并再次检查该 restriction，命中时返回稳定 `credential_review_required`，不得签发“受限但仍可写”的临时 Session。
- 本机 `restore credentials review` 逐账号只允许：安全重置密码并按政策重置/保留 TOTP、保持账号 disabled，或在显示 backup cutoff/账号/风险后逐字确认接受恢复凭据；每个动作都再次撤销该账号 Session、清除对应 `AccountRestriction` 并写 break-glass 审计。至少一位管理员必须通过本机重置/审阅后，才能执行联网账号登录验证；clone 默认不接受生产凭据，改为本机创建 synthetic 管理员/测试账号。
- 撤销恢复出的全部 `bootstrap_credentials`。若恢复后 lifecycle=`uninitialized`，marker 以数据库时间写 `bootstrap_token_cutoff` 和 `bootstrap_reissue_required=true`，completed marker 永久阻止再次导入环境 `SETUP_TOKEN`；只有本机 setup CLI 可在事务中签发新 token、审计关联 marker 并清除此标志。ready 实例保持 bootstrap 关闭。
- 把包内 backup run/index 标为 imported history，创建新的 restore marker；删除 incomplete 临时 artifact 只按明确 prefix/allowlist 执行。
- Sanitation 每步持久化 checkpoint/结果；失败保持 offline，可重入，不允许“尽量清理后继续”。

## 11. Preserve 与 Clone 语义

### 11.1 Preserve（灾难恢复）

- 保留 account/workspace/object/document/key IDs 和 `instanceId`。
- 不重写 Workspace ID；加密 AAD 绑定它，重写会导致无法解密。
- 每次执行 restore 都生成新的不可预测 UUID `syncEpoch`，不能用“备份 epoch + 1”：生产可能已经用过该值，重复恢复同一备份也不能复用 epoch。
- restore marker 记录 `restoredFromBackupId`、`backupEpoch`、`restoredThroughSequenceByWorkspace`。客户端看到 epoch 变化时暂停 Push、保留 outbox、进入 staged reconciliation。
- `syncEpochFencing` required 与计划 00 的数据库 `auth_epoch_enforced=true`、最低认证 binary 共同构成 preserve 硬门槛。在 10A 服务端 additive contract → 12H 客户端发送/持久化 epoch → sync/auth fencing 演练完成前，capability 明确 `preserveRestore=false`，CLI 阻断 preserve；人工口头要求“清状态”不能替代协议屏障。
- RPO 边界必须直说：备份 cutoff 后新建的账号/Workspace 不存在于恢复端，无法自动登录/bootstrap；只能从仍有本地数据的设备导出后，以恢复端现存/新建账号重新导入。

### 11.2 Clone（演练/迁移测试）

- 生成新 `instanceId` 和全新随机 sync epoch，但保留 Workspace/object/key ID，保证密文可解。
- 执行与 preserve 相同的 auth epoch/token revocation/sanitation；clone 另使用独立 signing secret。
- 默认关闭邮件、Webhook、计费、支持同步和外部通知，防止测试环境向真实用户发送消息。
- 绑定不同公开域名与 storage prefix；客户端将其视为新服务器。

绝不能用生产备份启动一个同 instanceId、同公开 URL 可访问的第二写实例。

### 11.3 `syncEpoch` wire 与事务 fencing

10A 冻结共享 contract：capabilities、workspace context、同步 snapshot bootstrap、Pull/events 响应都携带 epoch；每个 command batch、Blob begin/complete 与 server-mediated part、cursor ACK、WebSocket authenticate/`document.update` 都提交 `expectedSyncEpoch`。直传对象存储的 part session 在 begin 时绑定 epoch/lease，complete 再强制比较。服务端在实际写事务内比较当前 epoch，不匹配返回稳定 `sync_epoch_changed`，并关闭旧 WebSocket/lease。

Additive rollout 初期旧客户端可省略 epoch，但 preserve 始终 disabled。新客户端普及并验证后，实例启用 required feature `syncEpochFencing`；一旦 restore 生成新 epoch，缺字段的旧客户端 fail-closed，绝不能把回退后的 command idempotency 表当成普通首次请求。Command/blob idempotency namespace必须包含 epoch。

## 12. 恢复验证

自动检查：

- manifest signature、AEAD/envelope、checksum/Merkle 完整。
- migration journal 与 server compatibility。
- instance mode/ID、账号数、Workspace sequence、key versions。
- 每条 ready Blob 数据库引用存在，随机/全量 ciphertext hash 正确。
- 没有数据库外孤儿 Blob（允许按报告处理，不自动删）。
- managed key 可由当前 keyring/KMS 解包；E2EE 只校验 envelope 格式。
- clone 模式外部副作用全部禁用。
- preserve/clone 新 sync/auth epoch、token revocation、operational sanitation 与 worker quarantine 完成。
- 恢复账号在 review 前不能签发任何 Session；本机审阅/重置后才可登录。uninitialized 恢复包内及环境 bootstrap token 均失败，只有关联最新 marker 的本机重新签发 token 可用。
- 所有写 API/WS 对错误或缺失 expected epoch fail-closed。

人工演练：使用 synthetic 账号的新设备完成登录、bootstrap、Push、Pull、历史版本、附件下载、E2EE 解锁和设备撤销；记录实际 RPO/RTO 与失败项。

## 13. API 与管理 Web

```text
GET/PUT /v1/web/admin/backup-policy
POST    /v1/web/admin/backups
GET     /v1/web/admin/backups
GET     /v1/web/admin/backups/:id
POST    /v1/web/admin/backups/:id/verify
GET     /v1/web/admin/backups/:id/download
DELETE  /v1/web/admin/backups/:id
GET     /v1/web/admin/restore-drills
```

Web 不提供 `restore apply`。它只展示离线恢复说明、manifest 下载和最近演练。旧“数据库备份”明确标记 legacy，不再与 unified backup 混称。

## 14. 建议 PR 切片

1. **PR-10A：Sync Epoch Server Contract。** additive wire、expected-epoch 事务比较、WS/Blob/command fencing，`preserveRestore=false`。
2. **PR-10B：Authenticated Format + Verify。** signed manifest、外部 trust store/KMS verifier 与轮换/撤销、AEAD/envelope、compat metadata、legacy DB-only 降级识别、只读 CLI。
3. **PR-10C：Backup Runner。** run/policy/checkpoint、durable job、加密、filesystem target。
4. **PR-10D：Immutable Blob + Filesystem Snapshot。** no-overwrite、write-drain、Blob index/copy、完整校验。
5. **PR-10E：S3 Exported Snapshot。** version ID、exported DB snapshot、lease、GC/purge 互锁。
6. **外部 gate：PR-12H。** 客户端发送/持久化 epoch、staged reconciliation；普及与故障演练前不得继续下一项 preserve enablement。
7. **PR-10F：Offline Restore + Sanitation。** preflight、isolated restore、共享 auth epoch、credential review/bootstrap reissue、worker 清理、preserve/clone、应急回退。
8. **PR-10G：UI/Runbook/Drill。** 策略、告警、下载审计、定期演练、开启 `preserveRestore`。

## 15. 测试矩阵

- 备份期间对象写、Blob complete、GC、账号 purge、进程退出的每个竞态。
- DB dump/Blob 缺失/额外/损坏/错误 hash/错误 key/version 时 verify 阻断。
- manifest/artifact 同时被替换、签名 key 撤销、AEAD tag 错误、路径/大小炸弹均在 restore 前阻断。
- 包内伪造 public key/trust status、低于 high-water 或不匹配显式最低 revision/digest 的 trust store、writer 切换早于 verifier/high-water 分发、已撤销 signing key 均不能进入 ready/restore apply；全新恢复主机缺少外部水位时 fail-closed，inspection override 不能提升为可恢复。
- 加密 key 错误、secret 指纹不匹配、目标空间不足不修改生产目标。
- 两实例排程只跑一个；lease 到期可恢复且不误删 Blob。
- preserve 恢复保留 ID/key、每次生成未使用随机 epoch；clone 新 instanceId；两者都撤销所有 auth/action/invitation token并 quarantine 外部副作用。
- 旧 Access JWT 在恢复切换后立即因共享 auth epoch 失败；恢复密码/TOTP 在 `credential_review_required` 清除前不能创建任何 Session，clone 生产凭据默认不可用。
- uninitialized 备份恢复后，包内 bootstrap credential、仍在环境中的 legacy `SETUP_TOKEN` 和上一次 restore 后签发的 token 全部失败；本机 CLI 针对最新 marker 重签后只有新 token 可用。
- 旧客户端/旧 WebSocket、缺 expected epoch 的 command/Blob/cursor/document update 在 restore 后全部被拒绝。
- 恢复出的 job/outbox/lease/rate limit 不会在 sanitation 前运行，sanitation 各崩溃点可重入。
- E2EE 内容在恢复后仍可用原恢复密钥解锁。
- 下载/删除路径约束与审计；hosted route 不存在。
- 从至少 N-2 真实备份格式做 verify/迁移测试。

## 16. 上线、回滚与验收

先上线 10A 但不要求 epoch，也不允许 preserve；再上线外部 trust store/KMS verifier 与 signed format/verify，让新 backup runner 与旧脚本并行生成但不自动删旧备份，旧 DB-only 产物明确标 legacy/non-unified。计划 00 auth epoch 已覆盖全部认证入口、12H 普及、sync/auth fencing 故障演练和至少一次隔离恢复完成后才开启 preserve；最后启用 schedule/retention，S3 单独灰度。

回滚停止新 schedule/worker但保留已完成 artifacts 和 format reader；不要让旧版本删除不认识的 backup prefix。恢复功能永远要求与 manifest 兼容的 CLI 版本。

验收条件：任一 ready 备份都有 DB+Blob+manifest+校验；能在空环境恢复并通过 synthetic 账号验收；恢复模式和实例身份明确；最近一次演练可证明而不是仅显示“备份成功”。

## 17. 开放问题

- 首发 backup target 是否同时支持 S3；若资源有限，先完成 filesystem + encrypted remote copy adapter。
- 大规模 Blob 全量 hash 的成本与抽样比例。
- PostgreSQL PITR/WAL 与全量备份的组合属于后续高级运维计划。
