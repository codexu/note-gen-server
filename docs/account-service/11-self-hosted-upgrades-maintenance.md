# 11：自托管发布、升级与维护技术规格

- 状态：Draft
- 日期：2026-08-11
- 适用形态：`self-hosted`；相同迁移兼容规则也约束 hosted 发布
- 前置依赖：[00 共享基础](00-shared-foundation.md)
- 分阶段依赖：release/doctor 只依赖 00；任何 `irreversible` migration 硬依赖已验证的 [10 unified restore](10-self-hosted-backup-restore.md) 与 [12H syncEpoch fencing](12-client-account-service-integration.md)
- 交付结果：部署者能发现版本、执行预检、进入维护、迁移、验证和回滚；文档与实际镜像发布方式一致

## 1. 当前问题

- Compose 使用 `build: .`，运维文档却要求 `docker compose pull`，实际没有可拉取镜像定义。
- 启动默认自动执行全部 Drizzle migration，没有 migration 风险分级、耗时预算或回滚兼容窗口。
- readiness 只检查 PostgreSQL 与 Blob，没有校验数据库 migration/schema 与服务端版本兼容。
- 没有服务端 release workflow、稳定镜像 tag/digest、版本通道、更新 manifest、签名/SBOM 或历史数据库升级矩阵。
- 当前单机与多实例升级步骤不同，但没有统一 preflight/maintenance 状态。

## 2. 目标

- 发布可验证、可固定 digest 的服务端镜像和 release metadata。
- 提供 opt-in 版本检查和离线可用的升级说明，不静默自动更新。
- 在变更前检查版本、Schema、磁盘、备份、任务、Blob、secret 和 mode。
- 用共享维护状态安全停止新写入并 drain 在途任务。
- 定义 expand/migrate/contract migration 规则和 N-1 滚动兼容。
- 明确何时可代码回滚、何时只能恢复备份。
- 将客户端协议、server schema 和 backup format 分别版本化。

## 3. 非目标

- 不在容器内自我替换二进制或自动重启 Docker host。
- 不承诺所有 migration 都可逆。
- 不把 Git branch/commit 当作用户可理解的 release channel。
- 不要求 self-hosted 向官方发送实例 ID、账号数或使用数据来检查更新。

## 4. 版本与兼容维度

分别维护：

- `serverVersion`：SemVer 发布版本。
- `protocol.minimum/maximum`：NoteGen 同步协议范围，账号功能 additive change 不改变它。
- `capabilitySchema`：capabilities 结构版本。
- `databaseSchema`：binary 内嵌的 ordered migration IDs + 每个 SQL 内容 hash 形成的 migration-set hash，不直接 hash `_journal.json` 文件格式。
- `minimumDatabaseSchema/maximumDatabaseSchema`：当前 binary 可读写范围。
- `backupFormatVersion`：备份 reader/writer 范围。
- `syncEpoch`：灾备恢复导致同步历史断点时变化，不等于版本。

`/v1/capabilities` 继续返回 server/protocol；管理员配置、`doctor --json` 和 readiness 返回 schema/backup compatibility，不向公开接口暴露内部路径或 secret 状态。

## 5. 发布产物

每个 stable/beta release 生成：

- 多架构 OCI image，SemVer tag 和不可变 digest。
- 源码 tag、变更说明、migration/rollback notes。
- SBOM、漏洞扫描结果、镜像签名/来源证明。
- `release-manifest.json`：版本、channel、digest、发布日期、支持的 Schema/protocol/backup range、是否 security update、升级前置。
- `release-root.json` 与连续 delegation metadata：root/version/threshold keys、受权 online release key、有效期、撤销和轮换链；与普通 release manifest 分开发布。
- 更新后的 `.env.example`、Compose image 模板和运维 Runbook。

Compose 提供两种明确文件：

- 兼容期继续保留现有 `docker-compose.yml` 文件名，但把默认 server 改为已发布 image + `NOTEGEN_SERVER_VERSION` 或 digest，确保现有 `docker compose pull/up` 命令真实可用。
- 新增 `docker-compose.dev.yml` 作为显式 override，保留 `build: .` 给源码开发；开发文档固定写完整 `-f` 命令，不让两个文件产生隐式歧义。

文档命令必须与实际文件一致。生产推荐锁 digest；版本检查只建议新版本，不自动改 `.env`。

## 6. 更新检查

`UPDATE_CHANNEL=off|stable|beta`，默认 `off`；只有初始化向导/管理员明确同意后才切 stable/beta。检查器只发送当前 server version、channel 和平台架构；不发送 instanceId、域名、账号/用量。也支持管理员上传/指定离线 release manifest。

状态：

- current
- update_available
- security_update_available
- unsupported
- check_failed

管理员可忽略普通版本至指定时间；安全更新仍显示但不自动安装。release manifest 必须验签；网络失败不影响同步 readiness。

签名契约在实现前冻结：canonical JSON 格式、Ed25519 key ID、binary 内置初始 root、manifest issued/expiry、channel、最低当前版本与前一 release digest。信任链分层，online release key 只能签 release manifest，不能在自己签名的 manifest 中授权 successor、撤销 key 或修改 root：

1. 版本化 `release-root.json` 记录 threshold root public keys、受权 release keys、有效期和角色；root 离线保存并达到阈值签名。
2. Root 轮换 metadata 必须同时满足当前 trusted root 阈值签名与新 root 自签名，客户端逐版本更新，拒绝跳号/回退；release key 委派、轮换和撤销只能由有效 root metadata 完成。
3. `release-manifest.json` 由当前受权 online release key 签名，包含单调 release sequence、channel、digest 与兼容范围；它携带的 key/撤销字段一律不提升信任。
4. 客户端保存最高接受的 root version 与各 channel release sequence/digest；root/manifest 撤销或过期默认 fail-closed。离线安装必须携带从已信 root 连续可验的 metadata chain；break-glass downgrade 只允许 CLI 显示 digest/版本后明确确认并审计，不能改写长期最高水位。

## 7. Schema 兼容与 migration 规则

### 7.1 启动校验

启动先读取 migration journal/version：

- DB 低于 binary minimum：状态 `migration_required`，业务 ready=false。
- DB 高于 binary maximum：状态 `binary_too_old`，ready=false，禁止旧 binary 写入。
- journal hash 与已知 migration ID 不一致：`schema_drift`，拒绝自动修改并要求 doctor。
- 兼容范围内才组装业务服务。

### 7.2 Migration 分类

既有 0001～当前 migration 在首个 release 生成审核过的 baseline hash；以后每个 migration 附 metadata：

- `online-additive`：加表/可空列/索引并发创建，可自动。
- `backfill-required`：先 expand，后台 job 分批回填并可观察进度。
- `contract`：删除旧字段/约束，只能在至少一个兼容 release 后执行。
- `maintenance-required`：需要停止写入或外部 Blob/secret 协调。
- `irreversible`：必须有已验证备份和明确确认。

Metadata 还必须包含预计锁时、空间放大、是否要求 unified backup、允许 binary/schema range、payload/job generation、pre/post validation SQL 与 rollback class；不能只写一个风险标签。

大表禁止单发布“add not-null with full rewrite + backfill + drop old”。标准三阶段：

1. Release N expand，双读/双写。
2. 后台分批 backfill，对账并记录 checkpoint。
3. Release N+1 切新读；N+2 contract，清旧字段。

滚动发布窗口内新旧实例共享数据库时，Schema 必须同时被 N 和 N+1 支持。migration 由独立一次性 job 获取 advisory lock 执行，业务副本以 `MIGRATE_ON_START=false` 启动。

## 8. 共享维护模式

复用计划 00 的 `MaintenanceModeCoordinator`、advisory shared/exclusive 写屏障、generation 和实例 ack，不在本计划再建第二张状态表。升级只增加 reason/Runbook：

- `read_only` 只允许 capabilities、已有 Access/Refresh/Web Session 的受控读取与必要 refresh rotation、Pull/读取/导出/备份下载；密码登录会创建 Session/设备，因此不允许笼统称“登录可用”。
- `write_drain` 等待写事务、Blob lease、普通 job checkpoint 和所有活跃实例 ack；CLI 在这些计数归零前不得报告 drained。
- migration/restore generation 不复用；irreversible owner 不能自动超时回 normal。
- WebSocket 发送 `server.maintenance` 后主动断开仍可能写的连接；每条 realtime `document.update` 仍由事务 fencing 拒绝。
- 旧客户端收到 `503 server_maintenance` + `Retry-After`，保留 session/outbox。反向代理关流量不是 worker/其他实例的安全边界。

## 9. 升级预检

`notegen-server upgrade plan --to <version>` 只读检查：

- 当前/目标 server、protocol、Schema、backup format 范围。
- deployment mode 与 capability provider 配置。
- PostgreSQL 版本/extensions/权限、连接和预估 migration lock/空间。
- 主机与 backup target 可用空间。
- 最近成功、已验证备份是否满足策略；irreversible migration 必须指定已完成真实 restore drill 的 unified backup ID，并同时验证 `syncEpochFencing` required/12H 客户端门槛、数据库 `auth_epoch_enforced=true`、当前与回退候选 binary 均不低于计划 00 的认证契约最低版本。
- active backup/restore、删除、billing、邮件和 backfill jobs。
- Blob health/缺失/孤儿摘要。
- 目标镜像签名/digest 与 release manifest。
- secret keyring 是否包含目标版本需要的 current/previous key。
- N-1 实例是否仍在运行，多实例 migration owner 是否唯一。

输出 machine-readable JSON 和人类摘要；警告与阻断分开。`--force` 不能跳过 schema drift、错误 mode、缺失 irreversible backup 等安全阻断。

## 10. 标准升级流程

### 10.1 单机 Compose

1. 读取 release notes/manifest，运行 doctor + upgrade plan。
2. 按 migration class 创建并 verify 预升级 unified backup；irreversible 还必须通过 10/12 restore fencing gate。
3. 在旧容器仍运行时拉取并验签目标 digest，记录旧 image digest 与回滚 class。
4. online-additive 可先执行独立 migrate job；其余进入 write-drain，确认 fencing/drain 后停止旧 server/worker。
5. 单机默认接受短暂停机：执行 migration/backfill 前置，启动目标 container，保持 maintenance/read-only 并执行 self-check。
6. 验证 capabilities、已有 Session 读取、Pull/Push、Blob、Web、jobs 与 Schema；成功后解除维护并观察。
7. 失败按 metadata 选择旧 binary、feature-off、forward fix 或离线 restore；达到 soak 窗口后才清理旧 image。

默认 Compose 不声称 blue/green：同一 service/端口无法同时运行旧容器和隔离新容器。未来若提供第二 service、隔离端口和反向代理切换 profile，必须另有可执行 Runbook 与端到端测试，不能只在步骤中写“切流量”。

### 10.2 多实例

1. 确认 N/N+1 Schema 兼容和共享 S3/PostgreSQL。
2. 独立 migration job 一次执行。
3. 逐实例 canary，检查 error/latency/job lease/WebSocket。
4. 批量滚动，禁止 N-1 在超出 maximum Schema 后重启写入。
5. 完成后再启动 backfill/contract，不在混跑窗口 contract。

## 11. 回滚决策

发布 metadata 明确：

- **Code rollback safe**：Schema 仍在 N-1 maximum 范围，未写 N-1 不认识的必需语义。
- **Feature rollback only**：关闭 capability/新 worker，保留新 binary/Schema。
- **Forward fix**：数据已按新格式写入，但旧字段仍在；修复新版本优于代码回滚。
- **Backup restore required**：irreversible contract/数据变换已执行，只能执行计划 10 的离线 restore + sanitation；生成全新随机 sync epoch，同时按 00 对数据库 bigint auth epoch 执行原子 `+1`、推进 token-not-before 并强制 enforced=true。

回滚步骤先进入 read-only/write-drain、停止新 job 类型、确认没有处理中外部副作用，再切 binary。禁止仅把 image tag 改回旧版而忽略 DB maximum Schema。

## 12. CLI、Web 与 API

概念命令：

```text
notegen-server doctor [--json]
notegen-server update check [--manifest <file>]
notegen-server upgrade plan --to <version>
notegen-server maintenance enable --mode write_drain --reason upgrade
notegen-server migrate preflight
notegen-server migrate apply
notegen-server maintenance disable
```

管理 Web 展示当前/可用版本、release notes link、Schema 状态、backup freshness、计划摘要和 Runbook。它不调用 Docker socket、不自动 pull/restart。敏感升级/维护动作优先 CLI，Web 只读或生成短期批准。

## 13. 客户端兼容

- server 继续以 protocol/capabilities 判断兼容，不要求客户端猜版本。
- maintenance 错误与 429/401 分开；客户端保留 session/outbox，按 Retry-After 重试，继续允许 Pull 时保持 Pull。
- capabilities 可提供 `minimumRecommendedClientVersion`、`upgradeMessage`，但强制升级只在协议/安全确实不兼容时使用。
- sync epoch 变化走 12H staged reconciliation，不伪装成普通 server version 升级。
- 旧客户端兼容下限在发布 manifest 中可验证，不能静默把 batch/page 限制调低到现有硬编码以下。

## 14. 指标与告警

- 当前 server/schema/capability revision（低基数 info metric）。
- maintenance mode/duration/drain outstanding。
- migration duration/lock wait/backfill progress/error。
- mixed-version instance count。
- update check result（不含 instance ID）、unsupported version。
- 升级后 HTTP/DB/Blob/WebSocket/job error regression。

告警：schema drift、binary too old、维护超时、migration lock、backfill stalled、混跑超窗口、backup 不新鲜、更新签名失败。

## 15. 建议 PR 切片

1. **PR-11A：Schema Metadata + Doctor。** journal 校验、compat range、readiness 真正检查。
2. **PR-11B：Release Pipeline。** image/digest、SBOM/signature、manifest、Compose image 模板。
3. **PR-11C：Update Check。** opt-in/离线 manifest、threshold root/delegation chain、anti-rollback、管理只读 UI。
4. **PR-11D：Upgrade Maintenance Integration。** 复用 00 coordinator，补 migration reason、drain/ack、客户端错误和 WS 关闭。
5. **PR-11E：Migration Framework。** 分类 metadata、preflight、backfill checkpoint、advisory lock。
6. **PR-11F：Upgrade/rollback Runbook。** 单机、多实例、canary、验证、文档漂移修复。

## 16. 测试矩阵

- 从真实 N-2/N-1 数据库快照升级到 N；每步校验并可按声明回滚。
- DB 过旧、过新、journal drift、缺 extension/权限时 readiness/doctor 一致。
- 两实例只有一个 migration owner；N/N+1 混跑期间读写兼容。
- maintenance 覆盖认证、设备、两条同步写路径、WebSocket document update、Blob、管理员、worker；允许清单外无漏写。
- drain 超时/实例崩溃/owner lease、irreversible migration 不自动解锁。
- manifest 签名/镜像 digest 错误、网络离线、beta/stable channel。
- threshold root 与 release key 轮换/撤销、双签 root 迁移、manifest 过期、anti-rollback、离线连续 trust chain；online key 自行委派 successor/伪造撤销或 root 跳号必须失败。
- 单机按真实 stop→migrate→start 流程演练；文档中每条 Compose 命令与保留的文件名一致。
- code rollback safe 与 restore required 场景分别演练。
- 客户端 maintenance/epoch/最低版本状态不清 session、不丢 outbox。

## 17. 上线、回滚与验收

先上线 doctor/schema readiness 与 existing migration baseline；再在保留 `docker-compose.yml` 命令兼容的前提下发布首个签名 image/manifest；之后接入 00 maintenance fencing；最后引入 migration 分类和自动 preflight。更新检查保持 off，必须由管理员 opt-in。每一步都可独立使用。

验收条件：文档命令能实际拉取固定版本；服务不会在不兼容 Schema 上 ready；升级前能证明备份与预检；失败时明确选择 code rollback/feature off/forward fix/restore；旧客户端在维护中不丢本地状态。

## 18. 开放问题

- OCI registry、签名基础设施和 stable/beta 发布权限。
- 首版支持的 N-1/N-2 窗口；建议先承诺 N-1 滚动兼容，并用测试扩大。
- 哪些 migration 允许单机 `MIGRATE_ON_START=true`；建议只有标记 online-additive 的 migration 自动执行。
