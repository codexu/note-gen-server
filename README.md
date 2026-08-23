# NoteGen Sync Server

NoteGen Sync Server 是 NoteGen 客户端使用的免费同步服务。官方公共测试服务和用户自行部署使用同一套独立实例运行方式。

> 自托管服务目前处于实验阶段，部署方式、配置和数据库结构仍可能变化。请保留 NoteGen 本地 Markdown，不要把实验实例作为重要数据的唯一副本。

项目包含同步 API 和账号管理 Web。Web 负责注册、登录、设备关联、同步统计和账号管理，不包含 Markdown 编辑器、AI 功能或多人协作功能。

## 开始使用

### Docker Compose（推荐体验）

适合快速搭建个人测试实例。官方 Compose 默认拉取 GHCR 的 `edge` 镜像，并启动 NoteGen Server 与 PostgreSQL 17。镜像地址为 `ghcr.io/codexu/note-gen-server:edge`，支持 `linux/amd64` 和 `linux/arm64`，服务器无需安装 Node.js 或 pnpm：

```bash
git clone https://github.com/codexu/note-gen-server.git
cd note-gen-server
cp .env.docker.example .env
# 编辑 .env，设置 POSTGRES_PASSWORD、AUTH_SECRET 和 PUBLIC_BASE_URL
docker compose pull
docker compose up -d
docker compose ps
```

详细的首次初始化、HTTPS、日志和数据说明见 [Docker Compose 部署](docs/deployment/docker.md)。

### 从源码运行（开发者）

适合调试服务端、修改功能和提交贡献。需要 Node.js 22 或更高版本、pnpm 10.20.0 和 PostgreSQL 17：

```bash
git clone https://github.com/codexu/note-gen-server.git
cd note-gen-server
createuser notegen
createdb -O notegen notegen
pnpm install
cp .env.example .env
pnpm dev
```

贡献约定、仓库结构与本地容器构建方法见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 项目定位

- 项目免费且不以商业化为目标，不提供付费订阅、套餐或商业 SLA。
- 官方只提供供社区体验的公共测试实例；它与用户自行部署使用相同代码和运行方式。
- 每个实例由自己的管理员负责注册策略、邀请、数据保留、备份和滥用处理。
- 邮件不是基础依赖。SMTP 默认关闭；未配置时仍可使用账号密码和一次性邀请链接。
- 客户端应继续保留本地数据，公共测试实例不应被视为唯一备份。

## Monorepo 结构

```text
apps/server  Fastify 同步与认证 API
apps/web     Next.js + shadcn/ui 账号管理页面
```

生产环境中 Web 静态导出后可由 Fastify 同源托管；本地开发时 API 与 Web 分别运行。

当前项目已完成首个可部署的服务端基线，详细方案见：

- [Docker Compose 部署](docs/deployment/docker.md)
- [容器镜像发布](docs/deployment/container-publishing.md)
- [参与服务端开发](CONTRIBUTING.md)
- [同步服务技术规格](docs/sync-server-spec.md)
- [本地运行与运维](docs/operations.md)
- [NoteGen 客户端接入协议](docs/client-protocol.md)
- [NoteGen 接入与配置同步体验](docs/notegen-integration.md)
- [部署后的个人验收用例](docs/self-test.md)
- [公共测试实例上线清单](docs/production-checklist.md)
- [账号服务开发计划总览](docs/account-service/README.md)

## 已确定技术栈

- TypeScript
- Fastify
- Drizzle ORM
- PostgreSQL
- WebSocket
- 本地文件系统与 S3-compatible 附件存储

## 当前实现

服务端基线包含：

- Fastify 服务、统一错误响应与 OpenAPI 输出
- PostgreSQL/Drizzle 核心同步数据模型和版本化迁移
- 存活、就绪检查与协议能力协商
- 文件系统与 S3-compatible Blob Storage 适配器
- 本地进程运行与环境变量配置

- 封闭/开放注册、Argon2id 密码、JWT Access Token 与 Refresh Token 轮换
- 设备会话、撤销和内部同步空间的账号隔离
- 登录后自动创建账号默认同步空间，客户端无需选择 Workspace 或输入同步口令
- 默认服务端托管同步密钥；高级设置可切换为 passphrase + recovery 的端到端加密
- 幂等 Push、连续 sequence、分页 Pull、cursor ACK 和固定快照 bootstrap
- 不静默覆盖的 revision conflict 与历史版本恢复
- WebSocket 实时唤醒及断线后 cursor 补偿
- PostgreSQL `LISTEN/NOTIFY` 跨实例实时事件广播
- 文件系统/S3-compatible 分片上传、断点续传、Range 下载和哈希校验
- Yjs update/checkpoint opaque object 支持，不包含多人 Awareness
- 自动保留清理、Prometheus 指标、备份和恢复流程
- 稳定实例 ID、服务名称、设备公钥和误删 Workspace 恢复窗口
- 管理员角色、跨账号服务总览、账号停用/恢复和后台操作审计
- 托管加密内容的笔记、记录、绘图与配置预览，以及受保护的测试数据增删
- 后台账号、工作区、设备和审计的搜索筛选、服务端分页、批量操作与 JSON 导出
- 数据库响应、运行时内存、数据库/对象/附件占用、版本和变更日志监控
- 账户安全页修改密码；成功后撤销旧设备凭据、注销其他 Web 会话并续签当前浏览器会话

能力支持情况由 `/v1/capabilities` 返回，客户端不能仅根据服务端版本猜测功能。

## 本地开发

先启动本地 PostgreSQL 17，并创建应用数据库和拥有者。以下命令仅需在首次初始化时执行：

```bash
createuser notegen
createdb -O notegen notegen
```

复制并填写本地配置。`DATABASE_URL`、`AUTH_SECRET` 与 `PUBLIC_BASE_URL` 必须设置为自己的值：

```bash
cp .env.example .env
```

然后安装依赖并启动 API 与 Web：

```bash
pnpm install
pnpm dev
```

`pnpm dev` 会在启动服务端前自动执行尚未应用的数据库迁移。只有设置
`MIGRATE_ON_START=false`，或需要单独排查迁移时，才需要手动运行 `pnpm db:migrate`。

本地完成首位管理员初始化后，可在 Web 后台的“实例运维 → 注册策略”中选择关闭、仅邀请或公开注册；该策略保存在数据库中，无需修改环境变量或重启服务。

也可以分别启动：

```bash
pnpm dev:server
pnpm dev:web
```

`pnpm dev` 默认让 Web 监听所有本地网络接口的 `3790` 端口。本机可通过 `http://127.0.0.1:3790` 打开管理页面，同一局域网设备可通过 `http://<本机局域网 IP>:3790` 访问。需要修改 API 地址时可以设置：

```bash
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3789 pnpm dev:web
```

开发模式默认允许 `127.0.0.1:3790` 和 `localhost:3790`；自定义 Web 地址时需要同步加入服务端 `CORS_ORIGINS`。浏览器和 API 应使用相同主机名，确保开发环境 Cookie 的 SameSite 约束生效。

开发模式下，设备授权地址会根据客户端实际访问 API 时使用的局域网主机生成，例如通过 `192.168.31.137:3789` 连接时会返回 `http://192.168.31.137:3790/connect/`。生产环境默认与 `PUBLIC_BASE_URL` 同源，也可以通过 `WEB_PUBLIC_BASE_URL` 单独指定。

验证命令：

```bash
pnpm typecheck
pnpm test
pnpm build
# 服务已启动时
INTEGRATION_BASE_URL=http://localhost:3789 pnpm test:integration
```

服务默认监听 `http://localhost:3789`：

- `GET /health/live`
- `GET /health/ready`
- `GET /v1/capabilities`
- `GET /openapi.json`

浏览器访问同一个地址即可进入账号管理页面。NoteGen 可以继续使用账号密码直接登录，也可以通过一次性设备验证码在浏览器中确认连接。

## NoteGen 中的使用体验

用户只需要填写服务器地址并登录。连接成功后，NoteGen 会自动：

1. 将当前笔记目录绑定到该账号的默认同步空间。
2. 把 NoteGen Server 设为当前主要同步方式，并暂停其他平台的自动同步。
3. 扫描现有 Markdown，持续监听新增、修改和删除。
4. 通过 WebSocket 接收其他设备的变化通知，并在断线恢复后按游标补齐遗漏变化。

界面不提供 Workspace 选择，也不要求用户手动上传或下载。服务端仍使用内部同步空间 ID 隔离数据，但它不是用户需要理解或维护的配置。

账号 Web 会展示同步对象数量、数据类型、附件占用、加密模式和最近设备活动。默认托管模式可在当前浏览器会话中解密并预览笔记、记录、绘图和配置；高级 E2EE 工作区仍只展示元数据。首个账号会自动成为系统管理员，可在“系统管理”中查看跨账号统计、停用或恢复其他账号，并检查后台操作审计。

默认模式以零配置体验为目标，同步密钥由服务端托管。需要防止服务端读取数据的用户，可以在 NoteGen 的“高级加密”中设置独立同步口令；切换后服务端删除托管密钥，只保留 passphrase 与 recovery envelope，新设备需要同步口令或恢复密钥才能解锁。
