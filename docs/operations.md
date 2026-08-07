# NoteGen Sync Server 运维说明

## 启动

复制 `.env.example` 为 `.env`，至少修改：

- `POSTGRES_PASSWORD`
- `DATABASE_URL`
- `AUTH_SECRET`
- `SETUP_TOKEN`
- `PUBLIC_BASE_URL`
- `SERVER_NAME`
- `CORS_ORIGINS`
- `BACKUP_PATH`

然后运行：

```bash
docker compose up -d --build
docker compose ps
curl --fail http://localhost:3789/health/ready
```

可使用 `openssl rand -hex 32` 分别生成数据库密码、`AUTH_SECRET` 和 `SETUP_TOKEN`；十六进制密码可直接安全放入示例中的 PostgreSQL URL。

容器入口会先执行全部 Drizzle migration，成功后才启动 HTTP 服务。

`PUBLIC_BASE_URL` 必须是客户端实际访问的 HTTPS 地址。首次启动会在 PostgreSQL 中生成稳定的 `instanceId`；它包含在数据库备份中，客户端用它识别服务器是否被意外重置。

`DATABASE_URL` 中的密码必须与 `POSTGRES_PASSWORD` 一致；若密码包含 `@`、`:`、`/`、`?` 等 URL 保留字符，必须进行百分号编码。

反向代理与 server 容器处于受信网络、且外部无法绕过代理直连时设置 `TRUST_PROXY=true`，这样登录限流才能按真实客户端 IP 生效。若服务端端口直接暴露公网，不要开启该选项。

## 首个账号

默认 `REGISTRATION_MODE=closed`。打开服务器首页，切换到注册并填写部署时配置的 Setup Token；API 注册也可以继续使用 `X-Setup-Token`。数据库中的首个账号会自动成为系统管理员；已有部署升级时，如尚无管理员，则按创建时间选择最早账号。创建账号后应轮换 `SETUP_TOKEN`，并继续保持封闭注册。

系统管理员可以在 Web 后台的“系统管理”中授予或移除其他账号的管理员权限、停用或恢复账号，并查看后台操作审计。停用使用独立的 `suspended_at` 状态，不会进入账号删除保留期；账号申请删除仍由 `disabled_at` 和维护任务处理。系统会阻止停用、降级或删除最后一个可用管理员。

系统管理同时提供账号、全局工作区、全局设备和审计的搜索分页，支持批量停用/恢复账号和不含敏感凭据的 JSON 导出。运行状态页显示数据库响应时间、进程内存、数据库体积、对象与附件用量、历史版本和变更日志数量；审计记录可按操作过滤，并可按保留天数清理。

账户安全页支持 TOTP 双因素认证、浏览器会话查看和“一键注销其他浏览器”。管理员可以跨账号查看并撤销 Web 会话。TOTP 密钥使用由 `AUTH_SECRET` 派生的 AES-256-GCM 密钥加密后存入数据库，因此轮换 `AUTH_SECRET` 前必须先规划令牌和 TOTP 密钥迁移。

登录、注册和设备授权限流计数保存在 PostgreSQL，多个服务实例共享同一限制窗口。定时维护使用 PostgreSQL advisory lock，确保同一时刻只有一个实例执行清理。

同一个容器会在根路径提供账号管理 Web；`/v1/*`、`/health/*` 和 Web 使用同一域名。若设置 `WEB_ENABLED=false`，只关闭静态页面，不影响账号密码登录和同步 API。

自部署保持 `DEPLOYMENT_MODE=self-hosted`。运营官方服务器时设为 `hosted`，Web 会显示托管身份；同步协议、镜像和数据库结构不分叉。

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

多个 server 容器共享同一个 PostgreSQL 时，实时事件通过 `LISTEN/NOTIFY` 广播，不需要 Redis。多实例部署必须同时满足：

- 所有实例使用相同的 `AUTH_SECRET`、`PUBLIC_BASE_URL` 和数据库。
- Blob 使用同一个 S3-compatible Bucket；本地文件系统 Volume 不适合跨主机扩容。
- 反向代理支持普通负载均衡；WebSocket 不要求粘性会话。
- migration 仍应作为部署前的单独步骤执行，避免所有副本同时承担升级工作。

多实例发布时先用同版本镜像执行一次 `node dist/database/migrate.js`，再以 `MIGRATE_ON_START=false` 启动所有服务副本。单机 Compose 保持默认值 `true` 即可。

## 备份

系统管理接口支持创建 PostgreSQL custom-format 备份，并通过后台任务查询进度：

- `POST /v1/web/admin/backups`：创建备份任务。
- `GET /v1/web/admin/jobs/:jobId`：查询任务状态。
- `GET /v1/web/admin/backups`：查看最近备份。
- `GET /v1/web/admin/backups/:backupId/download`：下载备份。
- `DELETE /v1/web/admin/backups/:backupId`：删除备份。

服务运行环境需要安装与 PostgreSQL 兼容的 `pg_dump`，备份写入 `BACKUP_PATH`。数据库备份不包含文件系统 Blob，Blob 仍需独立快照。

默认文件系统 Blob 后端可使用：

```bash
scripts/backup.sh /absolute/path/to/backup
```

脚本拒绝覆盖非空目录，并在单机 Compose 部署中短暂停止 server 容器，以获得 PostgreSQL dump 与本地 Blob 的一致视图；结束或异常退出时会恢复原本正在运行的服务。备份包含 custom dump、加密 Blob、UTC 时间和数据库 dump 校验和。

S3 或多实例部署不能依赖此单机脚本获得全局停写，应使用维护窗口或外部编排停止全部写入实例，配合对象存储版本/快照能力和 PostgreSQL dump。

## 恢复

恢复会覆盖实例数据，因此不提供自动执行的无确认脚本。标准流程：

1. 停止 `server` 容器并确认备份目录。
2. 对当前 PostgreSQL 和 Blob Volume 再做一次应急备份。
3. 使用 `pg_restore --clean --if-exists` 恢复 `database.dump`。
4. 将备份的 `blobs` 内容恢复到 Blob Volume。
5. 启动服务，检查 `/health/ready`。
6. 使用一个新设备执行 bootstrap，并随机下载附件核对 ciphertext hash。

默认零配置同步的 managed key 会随数据库备份保存，因此恢复数据库即可让用户重新登录同步。用户启用高级端到端加密后，服务端不再保存可解密密钥；恢复后仍需要客户端同步口令或恢复密钥。

## 手动维护

后台每小时自动执行一次小批量维护，也可在容器中手动执行：

```bash
docker compose exec server node dist/cli/maintenance.js
```

维护任务包括：过期 Web Session、设备授权、Bootstrap/分片会话、超过 7 天的已完成上传会话、change log、非当前历史版本、幂等操作记录、墓碑、无引用 Blob、到期 Workspace 和已停用账号清理。

`VERSION_RETENTION_DAYS` 不能小于 `CHANGE_RETENTION_DAYS`，否则保留的 change 可能失去对应版本；服务启动时会拒绝这种配置。

软删除 Workspace 在 `TOMBSTONE_RETENTION_DAYS` 内可以恢复；到期后维护任务先删除物理 Blob，再级联删除数据库记录。同一进程不会并发执行两轮维护。

## 升级

```bash
scripts/backup.sh /absolute/path/to/pre-upgrade-backup
docker compose pull
docker compose up -d --build
docker compose logs -f server
```

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
- `AUTH_SECRET`、数据库密码、Setup Token 和 S3 凭据来自秘密管理，不写入 Compose 文件。
- `REGISTRATION_MODE=closed`，首个账号创建后已经轮换 Setup Token。
- PostgreSQL 与 Blob 都有独立备份，并完成过一次恢复抽查。
- Prometheus 已抓取 `/metrics`，日志和磁盘容量有告警。
- 使用 NoteGen 新设备完成登录、解锁、bootstrap、Push、附件续传和设备撤销验证。
- 浏览器注册、登录、设备授权确认、拒绝和过期流程均已验证。
