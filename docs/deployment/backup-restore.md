# 单机离线备份与隔离恢复

适用对象：维护单副本、PostgreSQL 17、文件系统 Blob 实例的管理员。以下命令使用当前源码构建镜像，包含 `pg_dump`、`pg_restore` 和编译后的 CLI；旧 GHCR 镜像不保证具备这些工具。

当前备份有签名与逐文件哈希，**没有加密**。数据库包含托管同步密钥、密码哈希和 TOTP 配置，必须存放在受限本地介质，并另存一份加密的异地副本。S3、在线快照、自动排程、自动原地恢复不在本流程内。

## 前置条件

- 在仓库目录执行命令，已按 [部署指南](docker.md) 创建 `.env` 并从源码构建镜像。
- `notegen_data` 和 PostgreSQL 卷可用；数据库与 Blob 有足够空间容纳额外一份备份。
- 保管原始 `.env` 中的 `AUTH_SECRET`、数据库连接配置和实际镜像版本；它们不会自动进入备份包。
- 备份前通知用户并停止所有 server 副本。维护模式仅拒绝后续请求，不能代替停止进程。
- 下述单次工具容器使用 root 访问受限密钥及数据卷；API 服务仍以 node 用户运行。

## 一次性生成信任材料

```bash
mkdir -m 700 recovery
docker compose run --rm --no-deps --user root \
  -v "$PWD/recovery:/recovery" server \
  node apps/server/dist/cli/backup.js init-trust \
  --directory /recovery/keys --confirm INITIALIZE_BACKUP_TRUST
```

命令拒绝覆盖现有目录，生成 `signing-private.pem`、`root-private.pem`、`root-public.pem`、`trust.json` 和 `trust-digest.txt`。签名 key ID 为 `backup-1`，信任 revision 为 `1`。目录和文件仅允许所有者访问。

将 `root-private.pem` 移到离线保管介质；日常备份只挂载 `signing-private.pem`，不挂载 root 私钥。将 root 公钥、trust revision 和 digest 另存于受信渠道，不能仅从待恢复的备份目录获取信任依据。后续轮换需要离线签发新 trust store，不能重复初始化并覆盖原密钥。

## 创建并校验备份

先进入离线维护并停服：

```bash
docker compose exec server node apps/server/dist/cli/maintenance-mode.js \
  enable --mode offline --reason 'offline-backup' --confirm ENABLE_OFFLINE_MAINTENANCE
docker compose stop server
```

仅 PostgreSQL 保持运行，创建数据库和 Blob 同一停止点的备份：

```bash
docker compose run --rm --no-deps --user root \
  -v "$PWD/recovery/keys/signing-private.pem:/run/secrets/backup-signing.pem:ro" server \
  node apps/server/dist/cli/backup.js create \
  --signing-key /run/secrets/backup-signing.pem --signing-key-id backup-1 \
  --allow-unencrypted-local I_UNDERSTAND_UNENCRYPTED_LOCAL_BACKUP \
  --confirm CREATE_OFFLINE_FILESYSTEM_BACKUP
```

成功输出 `status: ready`、`backupId` 和 `manifestPath`。失败时保持停服，检查磁盘、密钥权限、`pg_dump` 错误以及 `backup list`，不要把 `.incomplete-*` 目录作为成功备份。

把输出中的 UUID 填入以下变量，复制整个备份目录到服务器数据卷之外：

```bash
export RESTORE_BACKUP=替换为backupId的UUID
mkdir -p recovery/artifacts
docker compose cp "server:/app/data/backups/$RESTORE_BACKUP" recovery/artifacts/
```

从离线保管记录填入 digest，不从候选备份自行计算并信任：

```bash
export BACKUP_TRUST_DIGEST=替换为受信渠道保存的64位SHA256
docker compose run --rm --no-deps --user root \
  -v "$PWD/recovery:/recovery:ro" server \
  node apps/server/dist/cli/backup.js verify "/recovery/artifacts/$RESTORE_BACKUP/manifest.json" \
  --trust-store /recovery/keys/trust.json --root-public-key /recovery/keys/root-public.pem \
  --minimum-trust-revision 1 --expected-trust-digest "$BACKUP_TRUST_DIGEST"
```

输出必须是 `status: verified`，并核对附件数和总字节数。这只是文件校验，不代表已经完成真实恢复演练。离线副本复制和校验完成后恢复原服务：

```bash
docker compose run --rm --no-deps server node apps/server/dist/cli/maintenance-mode.js \
  disable --confirm DISABLE_MAINTENANCE
docker compose up -d server
```

## 恢复到隔离副本

以下步骤只导入全新的 Compose 项目 `notegen-restore`。不要对仍在运行的主实例执行；不要复用生产 PostgreSQL 或 Blob 卷。隔离副本使用相同备份时点的 `AUTH_SECRET`，只映射到本机不同端口，禁止公共反向代理访问它。

先复制一份独立的 `.env` 到 `recovery/restore.env`，调整 `SERVER_BIND_ADDRESS=127.0.0.1`、`SERVER_PORT=3799`、`PUBLIC_BASE_URL=http://127.0.0.1:3799`。确保 `NOTEGEN_SERVER_IMAGE` 是包含本工具的实际镜像。后续命令统一使用此环境文件：

```bash
docker compose --env-file recovery/restore.env -p notegen-restore up -d postgres
```

再次执行上一节的 `backup verify`，确认签名与全部文件校验通过。然后仅在这个全新项目的空数据库中导入：

```bash
docker compose --env-file recovery/restore.env -p notegen-restore run --rm --no-deps --user root \
  -v "$PWD/recovery:/recovery:ro" -e RESTORE_BACKUP server sh -c \
  'pg_restore --exit-on-error --no-owner --no-privileges --dbname "$DATABASE_URL" "/recovery/artifacts/$RESTORE_BACKUP/database.dump"'

docker compose --env-file recovery/restore.env -p notegen-restore run --rm --no-deps --user root \
  -v "$PWD/recovery:/recovery:ro" -e RESTORE_BACKUP server sh -c \
  'set -eu; mkdir -p /app/data/blobs; if [ -d "/recovery/artifacts/$RESTORE_BACKUP/blobs" ]; then cp -a "/recovery/artifacts/$RESTORE_BACKUP/blobs/." /app/data/blobs/; fi; chown -R node:node /app/data/blobs'
```

导入错误时停止操作，保留日志；重新创建一个全新的隔离项目重试。不要绕过签名、手改 migration 账本或先启动 API。零附件的备份允许没有 `blobs/` 目录。

定义一个只针对隔离项目的命令辅助函数，所有恢复步骤都重新校验外部信任材料：

```bash
restore_tool() {
  docker compose --env-file recovery/restore.env -p notegen-restore run --rm --no-deps --user root \
    -v "$PWD/recovery:/recovery:ro" server node apps/server/dist/cli/restore.js "$@" \
    --backup-id "$RESTORE_BACKUP" --manifest "/recovery/artifacts/$RESTORE_BACKUP/manifest.json" \
    --trust-store /recovery/keys/trust.json --root-public-key /recovery/keys/root-public.pem \
    --minimum-trust-revision 1 --expected-trust-digest "$BACKUP_TRUST_DIGEST"
}

restore_tool preflight --mode clone
restore_tool register-verified --offline-confirm REGISTER_VERIFIED_BACKUP
restore_tool sanitize --mode clone --offline-confirm RESTORE_OFFLINE
```

备份中的维护状态是 `offline`。预检检查 dump 和数据库连接；登记把验签结果绑定到恢复后数据库；`sanitize --mode clone` 生成新的实例 ID、同步 epoch 和凭据 epoch，撤销旧 session/token，并把恢复出的账号置于待审核状态。所有命令均须成功后才能继续。

用隔离库的 SQL 工具查询管理员账号 ID（`select id, login from accounts where is_admin = true`），核对其身份。仅对你确认仍可信的管理员接受恢复凭据：

```bash
docker compose --env-file recovery/restore.env -p notegen-restore run --rm --no-deps server \
  node apps/server/dist/cli/restore.js credential-review \
  --account-id 替换为已核对的管理员UUID --decision accept-restored-credentials \
  --offline-confirm ACCEPT_RESTORED_CREDENTIALS
```

若备份后密码或 TOTP 已变更，应改用 `reset-password --password-stdin`，不要接受旧凭据。其他账号需逐一审核后才能重新登录。

```bash
docker compose --env-file recovery/restore.env -p notegen-restore run --rm --no-deps server \
  node apps/server/dist/cli/maintenance-mode.js disable --confirm DISABLE_MAINTENANCE
docker compose --env-file recovery/restore.env -p notegen-restore up -d server
curl --fail http://127.0.0.1:3799/health/ready
```

## 验收与回退

- 管理员能够使用新浏览器登录；旧 Cookie、Refresh Token 和设备授权不能继续使用。
- 实例 ID 和同步 epoch 与原实例不同。仅用新测试客户端连接隔离副本，不把日常工作库改连过来。
- 账号、工作区、笔记数与备份时点一致；随机下载若干附件并核对内容/哈希。
- 验证断线后 bootstrap、写入和二次读取；记录备份时间、恢复耗时、数据抽查与操作者。
- 失败时停止隔离服务，保持原实例和原备份不变。此过程不提供原地覆盖的回滚保证。

`drill-verify` 只记录文件校验演练，不能代替上述真实恢复。保留原实例身份的 `preserve` 路径、S3 和在线恢复仍需另行验证；Web 的统一备份与 preserve restore capability 继续关闭。
