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

## 启动官方镜像

```bash
git clone https://github.com/codexu/note-gen-server.git
cd note-gen-server
cp .env.docker.example .env
```

分别运行两次下面的命令，为 `POSTGRES_PASSWORD` 和 `AUTH_SECRET` 生成不同的值：

```bash
openssl rand -hex 32
```

编辑 `.env`，至少确认：

- `POSTGRES_PASSWORD`：随机生成的数据库密码
- `AUTH_SECRET`：另一个随机值，上线后不要随意更换
- `PUBLIC_BASE_URL`：NoteGen 客户端实际访问的地址

启动并查看状态：

```bash
docker compose pull
docker compose up -d
docker compose ps
```

首次启动会等待 PostgreSQL 就绪并自动执行尚未应用的数据库迁移。两个服务都显示为 `healthy` 后，检查：

```bash
curl --fail http://127.0.0.1:3789/health/ready
```

访问 `PUBLIC_BASE_URL`，根据安装向导设置实例名称和首位管理员。安装完成后，在 NoteGen 的同步设置中填写同一个服务器地址。

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

当前统一备份 artifact runner、加密、Blob snapshot 和离线恢复 CLI 仍在交付中。正式使用前，部署者需要自行对 PostgreSQL 与 `notegen_data` Volume 建立配套备份，并在隔离环境中验证恢复结果。未经恢复演练的文件不能视为可靠备份。

更多反向代理、维护和验收说明见：

- [运维说明](../operations.md)
- [部署后的个人验收](../self-test.md)
- [公共测试实例上线清单](../production-checklist.md)
