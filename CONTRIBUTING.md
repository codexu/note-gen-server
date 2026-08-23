# 参与 NoteGen Server 开发

NoteGen Server 处于实验阶段，欢迎通过 Issue、文档改进和代码贡献共同完善部署、同步协议、服务端 API 与账号管理 Web。

## 选择运行方式

### 源码开发

适合频繁修改、调试和提交代码。需要 Node.js 22 或更高版本、pnpm 10.20.0 和 PostgreSQL 17。

```bash
git clone https://github.com/codexu/note-gen-server.git
cd note-gen-server
pnpm install
cp .env.example .env
pnpm dev
```

首次创建本地数据库：

```bash
createuser notegen
createdb -O notegen notegen
```

修改 `.env` 中的 `DATABASE_URL`、`AUTH_SECRET` 和 `PUBLIC_BASE_URL`。API 默认监听 `3789`，开发态 Web 默认监听 `3790`。

### 本地容器构建

适合复现 Docker 部署问题或验证镜像构建：

```bash
cp .env.docker.example .env
docker compose -f compose.yaml -f compose.dev.yaml up -d --build
```

完整说明见 [Docker Compose 部署](docs/deployment/docker.md)。

## 仓库结构

```text
apps/server       Fastify API、认证、同步和运维 CLI
apps/web          静态导出的账号管理 Web
packages/contracts  Web 与服务端共享的协议类型
docs              协议、部署和运维文档
```

## 修改边界

- 数据库结构变化必须通过 Drizzle migration 表达，不手工改 migration journal。
- 同步协议和 capabilities 采用显式版本与能力协商，不能只根据服务端版本猜测行为。
- 不把访问令牌、密码、同步密文、封装密钥或真实 `.env` 提交到仓库。
- Web 使用静态导出，生产环境由 Fastify 同源托管。
- 新配置项需要同步更新 `.env.example`、部署文档和能力说明。

## 提交前检查

项目当前提供以下检查命令，按改动范围选择执行：

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm db:migrate
```

涉及真实同步链路时，可在服务启动后运行：

```bash
INTEGRATION_BASE_URL=http://127.0.0.1:3789 pnpm test:integration
```

提交 Pull Request 时请说明问题、实现方式、兼容性影响，以及自己执行过的验证。涉及数据库迁移、协议、安全边界或备份恢复时，同时说明升级与回退约束。
