# NoteGen Sync Server 运维说明

## 启动

确保本机 PostgreSQL 已启动。首次初始化时创建应用角色与数据库：

```bash
createuser notegen
createdb -O notegen notegen
```

复制 `.env.example` 为 `.env`，至少修改：

- `DATABASE_URL`
- `AUTH_SECRET`
- `PUBLIC_BASE_URL`

然后运行：

```bash
pnpm install
pnpm dev
curl --fail http://localhost:3789/health/ready
```

可使用 `openssl rand -hex 32` 分别生成数据库密码和 `AUTH_SECRET`；十六进制数据库密码可直接安全放入 PostgreSQL URL。

`pnpm dev` 会先执行全部 Drizzle migration，成功后才启动 HTTP 服务。

首次打开 Web 页面会进入安装向导。向导负责选择自托管或运营模式、设置实例名称与注册策略，并在同一事务中创建首位管理员：自托管创建客户域的实例管理员，运营模式创建独立 Staff 域的运营管理员。保存后服务会自动切换到完整运行状态，部署模式由数据库唯一决定，不再读取 `DEPLOYMENT_MODE`。

实例名称、对象与附件大小上限、同步数据保留期、邮件默认语言、账号删除周期和完整 SMTP 配置由管理员在 Web 后台“实例运维”中维护，保存后立即生效。SMTP 密码使用 `AUTH_SECRET` 派生密钥加密保存，接口只返回是否已配置，不会回显。

数据库连接、公开 URL 和认证密钥属于启动配置，继续保留在 env。部署模式与运营模式的内部测试适配器由安装向导固化，普通部署不需要理解相关环境变量。

`PUBLIC_BASE_URL` 必须是客户端实际访问的 HTTPS 地址。首次启动会在 PostgreSQL 中生成稳定的 `instanceId`；它包含在数据库备份中，客户端用它识别服务器是否被意外重置。

若 `DATABASE_URL` 中的密码包含 `@`、`:`、`/`、`?` 等 URL 保留字符，必须进行百分号编码。

反向代理与 server 容器处于受信网络、且外部无法绕过代理直连时设置 `TRUST_PROXY=true`，这样登录限流才能按真实客户端 IP 生效。若服务端端口直接暴露公网，不要开启该选项。

## 首次安装

空数据库启动后只装配安装页面、健康检查和安装 API。访问 Web 页面，选择部署模式并完成向导。服务会在安装响应结束后自动关闭安装态监听、重新读取数据库配置并装配完整服务；页面检测到就绪后自动进入对应入口。自托管模式创建的管理员从普通 Web 入口登录；运营模式创建的运营管理员从 `/operations/` 登录，凭据、会话、角色和权限均不写入客户 `accounts`。客户公开注册只创建普通客户账号，不能进入运营后台。空实例不要求额外安装密钥，因此应先完成安装，再开放公网入口。

当前运营模式属于内部测试阶段，因此安装向导创建本地运营账号，并授予首个账号 `platform-admin` 角色。该角色通过 Staff 权限表授权，不等同于客户管理员。正式运营接入 OIDC/SSO 后，应沿用同一 Staff principal、role 和 session 边界；本地密码登录不作为生产身份方案。

系统管理员可以在 Web 后台的“系统管理”中授予或移除其他账号的管理员权限、停用或恢复账号，并查看后台操作审计。停用使用独立的 `suspended_at` 状态，不会进入账号删除保留期；账号申请删除仍由 `disabled_at` 和维护任务处理。系统会阻止停用、降级或删除最后一个可用管理员。

系统管理同时提供账号、全局工作区、全局设备和审计的搜索分页，支持批量停用/恢复账号和不含敏感凭据的 JSON 导出。运行状态页显示数据库响应时间、进程内存、数据库体积、对象与附件用量、历史版本和变更日志数量；审计记录可按操作过滤，并可按保留天数清理。

账户安全页支持 TOTP 双因素认证、浏览器会话查看和“一键注销其他浏览器”。管理员可以跨账号查看并撤销 Web 会话。TOTP 密钥使用由 `AUTH_SECRET` 派生的 AES-256-GCM 密钥加密后存入数据库，因此轮换 `AUTH_SECRET` 前必须先规划令牌和 TOTP 密钥迁移。

登录、注册和设备授权限流计数保存在 PostgreSQL，多个服务实例共享同一限制窗口。定时维护使用 PostgreSQL advisory lock，确保同一时刻只有一个实例执行清理。

生产构建中，服务端可在根路径提供账号管理 Web；本地开发时 Web 默认运行在 `3790` 端口。若设置 `WEB_ENABLED=false`，只关闭静态页面，不影响账号密码登录和同步 API。

自托管和运营模式在首次 Web 安装时选择。该选择会固化到 `deployment_settings`，当前数据库不支持原地切换；需要测试另一种模式时应使用新的空数据库。同步协议、镜像和数据库结构不分叉。

## 反向代理

生产环境必须由 Caddy、Nginx、Traefik 等提供 HTTPS/WSS。代理需要：

- 保留 `Authorization`、`Range` 和 `X-Request-Id`。
- 支持 WebSocket Upgrade。
- 允许大于 `BLOB_PART_BYTES` 的请求体。
- 关闭对 `/v1/sync/events` 的响应缓冲。

Caddy 最小配置示例：

```caddyfile
sync.example.com {
  reverse_proxy 127.0.0.1:3789
}
```

部署后从外部网络分别验证 `https://sync.example.com/health/ready` 和 `wss://sync.example.com/v1/sync/events`。不要把 PostgreSQL 端口暴露到公网。

## 多实例

多个 server 进程共享同一个 PostgreSQL 时，实时事件通过 `LISTEN/NOTIFY` 广播，不需要 Redis。多实例部署必须同时满足：

- 所有实例使用相同的 `AUTH_SECRET`、`PUBLIC_BASE_URL` 和数据库。
- Blob 使用同一个 S3-compatible Bucket；本地文件系统 Volume 不适合跨主机扩容。
- 反向代理支持普通负载均衡；WebSocket 不要求粘性会话。
- migration 仍应作为部署前的单独步骤执行，避免所有副本同时承担升级工作。

多实例发布时先由一个实例执行迁移，再以 `MIGRATE_ON_START=false` 启动其余服务副本。单机本地开发保持默认值 `true` 即可。

## 备份

旧的网页备份接口和 `scripts/backup.sh` 已停用。它们只能生成数据库 dump 或普通 Blob 拷贝，缺少统一 manifest、认证签名、加密、版本固定与离线恢复预检；不得把该类文件标记为可恢复备份，也不得为新备份继续使用它们。

备份与恢复仅按 [账号服务备份规格](account-service/10-self-hosted-backup-restore.md) 的统一离线流程执行。当前已提供 run/drill/restore-marker 数据模型、启动时 credential epoch fence、bootstrap reissue guard，以及只读的 detached-signature/trust/artifact 校验器；统一 artifact runner、加密、Blob snapshot 与 offline restore CLI 尚在交付中，因此生产部署者需要继续使用经过本地审计的外部灾备流程，并明确其未获得本项目的 verified-backup 认定。

## 恢复

恢复会覆盖实例数据，因此不提供自动执行的无确认脚本。统一离线恢复工具交付前，不要按历史步骤直接覆盖运行中的实例；它们没有写入 restore marker，无法保证旧凭据、旧设备与旧客户端被 fencing。历史 artifact 只能在隔离副本中由运维人员人工取证。

统一工具的目标流程将是：

1. 停止 `server` 进程并确认备份目录。
2. 对当前 PostgreSQL 和 Blob Volume 再做一次应急备份。
3. 使用 `pg_restore --clean --if-exists` 恢复 `database.dump`。
4. 将备份的 `blobs` 内容恢复到 Blob Volume。
5. 启动服务，检查 `/health/ready`。
6. 使用一个新设备执行 bootstrap，并随机下载附件核对 ciphertext hash。

默认零配置同步的 managed key 会随数据库备份保存，因此恢复数据库即可让用户重新登录同步。用户启用高级端到端加密后，服务端不再保存可解密密钥；恢复后仍需要客户端同步口令或恢复密钥。

## 手动维护

升级或统一备份进入维护窗口时，可从运行 server 的本机终端显式切换全实例写屏障。`read_only` 拒绝所有业务变更但允许 Access refresh rotation；`write_drain` 连 refresh 也拒绝。两者都会让 HTTP 变更请求返回 `503 server_maintenance` 与 `Retry-After`，并暂停定时清理任务。命令有固定 confirmation，避免脚本误切换：

```bash
pnpm --filter @notegen/server maintenance:mode -- status
pnpm --filter @notegen/server maintenance:mode -- enable --mode write_drain --reason 'pre-upgrade' --confirm ENABLE_MAINTENANCE
pnpm --filter @notegen/server maintenance:mode -- disable --confirm DISABLE_MAINTENANCE
```

这是维护围栏的初始切片，尚未提供跨实例 ack、在途 Blob lease 计数或 Web 管理入口。realtime `document.update` 会在下一条可变消息时收到 `server.maintenance` 后关闭；尚未维护状态变更时主动枚举并断开所有已连接 WebSocket。不要把 `write_drain` 的当前状态误解为已完成完整 backup/upgrade drain。

后台每小时自动执行一次小批量维护，也可在本机手动执行：

```bash
pnpm --filter @notegen/server maintenance
```

维护任务包括：过期 Web Session、设备授权、Bootstrap/分片会话、超过 7 天的已完成上传会话、change log、非当前历史版本、幂等操作记录、墓碑、无引用 Blob、到期 Workspace 和已停用账号清理。

“版本保留天数”不能小于“变更保留天数”，否则保留的 change 可能失去对应版本；管理后台会拒绝这种配置。

软删除 Workspace 在后台配置的“删除标记保留天数”内可以恢复；到期后维护任务先删除物理 Blob，再级联删除数据库记录。同一进程不会并发执行两轮维护。

## 升级

停止本机服务后，更新依赖、执行迁移并按你的进程管理方式重新启动。统一备份 runner 交付前，请使用经本地审计的外部灾备流程。

若数据库 Schema 与服务端版本不兼容，服务不会进入 ready 状态。不要跳过 migration 或手工修改 Drizzle journal。

## 监控

- `/health/live`：只表示进程存活。
- `/health/ready`：检查 PostgreSQL 与 Blob 后端。
- `/metrics`：Prometheus 格式运行时和 HTTP 指标。生产环境默认关闭，通过 `METRICS_ENABLED=true` 开启；跨受信网络访问时同时设置 `METRICS_TOKEN` 并使用 Bearer Token。
- JSON 日志不会记录 token、密文 payload 或封装密钥。

生产反向代理仍应只允许监控网络访问 `/metrics`；不要将运行时指标无条件暴露到公网。生产环境的 `/openapi.json` 同样默认关闭，需要时设置 `OPENAPI_ENABLED=true`。

## 上线检查

- `/v1/capabilities` 中的 `publicBaseUrl`、`serverName` 和协议范围正确。
- 外部 HTTPS 与 WSS 均可用，证书链完整。
- `AUTH_SECRET`、数据库密码和 S3 凭据来自秘密管理，不写入版本控制文件。
- 首位管理员已完成初始化，安装入口已关闭；日常注册策略已在“实例运维”中确认。
- PostgreSQL 与 Blob 都有独立备份，并完成过一次恢复抽查。
- Prometheus 已抓取 `/metrics`，日志和磁盘容量有告警。
- 使用 NoteGen 新设备完成登录、解锁、bootstrap、Push、附件续传和设备撤销验证。
- 浏览器注册、登录、设备授权确认、拒绝和过期流程均已验证。
