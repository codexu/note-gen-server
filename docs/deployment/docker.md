# 使用 Docker Compose 部署 NoteGen Server

NoteGen Server 自托管目前处于实验阶段。部署方式、配置和数据库结构仍可能变化，请保留 NoteGen 本地 Markdown，不要把实验实例作为重要数据的唯一副本。

## 适用范围

这条路径适合在单台 Linux 服务器或受信局域网中体验 NoteGen Server。默认拓扑包含：

- NoteGen Server 与同源账号管理 Web
- PostgreSQL 17
- PostgreSQL 与附件数据的独立 Docker Volume

默认只把服务映射到宿主机 `127.0.0.1:3789`。远程使用时应由 Caddy、Nginx 或 Traefik 提供 HTTPS/WSS，不要直接把 PostgreSQL 或 NoteGen Server 的内部端口暴露到公网。

## 前置条件

- Docker Engine 与 Docker Compose v2
- 用于远程访问的域名和 HTTPS 反向代理；仅本机实验时不需要
- 能够拉取 `ghcr.io/codexu/note-gen-server` 的网络

## 当前版本启动方式

本次安全与恢复修复尚未发布镜像。`latest` 和 `0.1.0` 不能当成已经可用；2026-10-30 核对存在的 `sha-e258b44` 是旧构建，不含这些修复。当前使用源码构建：

```bash
git clone https://github.com/codexu/note-gen-server.git
cd note-gen-server
cp .env.docker.example .env
```

分别运行三次 `openssl rand -hex 32`，为 `POSTGRES_PASSWORD`、`AUTH_SECRET`、`SETUP_TOKEN` 生成不同的随机值，并设置客户端实际访问的 `PUBLIC_BASE_URL`。`SETUP_TOKEN` 是安装所有权凭据，不是管理员密码，不能公开发送；安装完成后入口永久关闭，可从环境文件移除它。已有实例不要求补设。

示例默认 `NOTEGEN_SERVER_IMAGE=notegen-server:dev`：

```bash
docker compose -f compose.yaml -f compose.dev.yaml up -d --build
docker compose ps
curl --fail http://127.0.0.1:3789/health/ready
```

首次启动会等待 PostgreSQL 并执行迁移。使用本机连接或 HTTPS 打开 Web，输入安装凭据、管理员账号与独立密码，再完成安装。之后才向其他用户开放入口。

后续维护者完成 [镜像发布](container-publishing.md) 并核对匿名拉取成功后，将 `NOTEGEN_SERVER_IMAGE` 改为该次实际发布的版本或 digest，才使用：

```bash
docker compose pull
docker compose up -d
```

## 容量保护

默认每账号 5 GiB、实例合计 50 GiB；分别通过 `ACCOUNT_STORAGE_MAX_BYTES`、`INSTANCE_STORAGE_MAX_BYTES` 配置。预算包含当前密文、保留历史、工作区名称与全部密钥封套、删除后尚未清理的数据和附件上传预占，因此删除笔记不会立即回收全部预算。共享库计入所有者。超过预算会拒绝新增写入，保留读取、删除和取消上传；压缩名称或以更小封套替换现有内容也可继续减少已占用容量。

`STORAGE_MIN_FREE_BYTES` 默认在 Blob 文件系统保留 1 GiB；分片写入、附件组装和同步新增写入前都会检查。附件组装还需一份附件大小的额外空间。该检查不能代替 PostgreSQL 数据盘、索引、WAL、S3 和备份盘的容量告警。预算是自托管资源保护，与付费套餐无关。

## 公网 HTTPS

保持 `SERVER_BIND_ADDRESS=127.0.0.1`，让反向代理转发到 `127.0.0.1:3789`。代理必须：

- 支持 WebSocket Upgrade
- 保留 `Authorization`、`Range` 和 `X-Request-Id`
- 允许大于 `BLOB_PART_BYTES` 的请求体
- 不缓冲 `/v1/sync/events` 的响应

Caddy 最小配置：

```caddyfile
sync.example.com {
  reverse_proxy 127.0.0.1:3789
}
```

将 `.env` 中的 `PUBLIC_BASE_URL` 改为 `https://sync.example.com`。只有代理和容器处于受信网络、外部无法绕过代理直连服务端端口时，才把 `TRUST_PROXY` 设置为 `true`。

## 从本地源码构建容器

贡献者可以复用同一套运行拓扑，只把官方镜像替换为当前工作区构建结果：

```bash
docker compose -f compose.yaml -f compose.dev.yaml up -d --build
```

修改源码后再次执行该命令即可重新构建。需要更快的日常开发反馈时，使用 README 中的 `pnpm dev` 源码开发流程。

## 日常诊断

```bash
docker compose ps
docker compose logs --tail=200 server
docker compose logs --tail=200 postgres
curl --fail http://127.0.0.1:3789/v1/capabilities
```

停止服务但保留数据：

```bash
docker compose down
```

不要在仍需保留数据时执行 `docker compose down -v`；`-v` 会请求删除 Compose 管理的 PostgreSQL 和 NoteGen 数据卷。

## 实验阶段的数据边界

当前提供单副本、文件系统、离线且未加密的签名备份，以及校验、预检、凭据清理和隔离恢复步骤。完整命令见 [备份与恢复](backup-restore.md)。S3、在线快照、自动排程和加密备份未交付；备份必须另存于受控介质，并完成隔离恢复验收。

更多反向代理、维护和验收说明见：

- [运维说明](../operations.md)
- [部署后的个人验收](../self-test.md)
- [公共测试实例上线清单](../production-checklist.md)
