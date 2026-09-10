# 发布 NoteGen Server 容器镜像

仓库通过 `.github/workflows/ci.yml` 验证代码，并在发布条件满足时构建多架构镜像到 GitHub Container Registry：

```text
ghcr.io/codexu/note-gen-server
```

## 自动发布规则

- 推送到 `release`：完整 CI 通过后，从根目录 `package.json` 读取版本并发布 `latest`、完整版本、主次版本与 `sha-<commit>`。
- 普通分支和 `main`：只运行 CI，不发布镜像。
- 手动运行 workflow：先运行 CI；在 `release` 分支运行时发布全部标签，在其他分支运行时只发布提交 SHA 标签。
- 每次同时构建 `linux/amd64` 与 `linux/arm64`，并生成 provenance、SBOM 和 artifact attestation。
- CI 会在独立临时数据库中还原到倒数第二条 migration，写入代表性的账户、工作区和加密对象，再升级到当前版本并校验数据与 migration 账本。升级测试失败时不会发布镜像。

根目录、服务端、管理 Web 和 contracts 的 `package.json` 版本必须一致，否则发布任务会停止。Compose 默认使用 `latest` 获取 release 分支的最新发布，需要稳定复现时应固定完整版本或镜像 digest。

## 首次发布后的必要设置

GHCR 首次创建的 package 默认可能不是公开可见。第一次 workflow 成功后，维护者需要在 GitHub package 设置中：

1. 确认 package 已关联 `codexu/note-gen-server` 仓库。
2. 将 package visibility 设置为 Public。
3. 在一台未登录 GHCR 的机器上运行 `docker pull ghcr.io/codexu/note-gen-server:latest`，确认可以匿名拉取。

在公开可见之前，不要对外宣布 Docker 快速部署已经可用。

## 设置和发布版本

发布版本的唯一来源是根目录 `package.json`。发布前将以下文件的 `version` 设置为同一个语义化版本号：

- `package.json`
- `apps/server/package.json`
- `apps/web/package.json`
- `packages/contracts/package.json`

例如当前首个版本统一设置为 `0.1.0`。仓库当前尚未创建 `release` 分支，首次发布时从已经验证的 `main` 创建并推送：

```bash
git switch main
git pull --ff-only
git switch -c release
git push -u origin release
```

后续发布先在 `main` 完成开发和版本更新，再快进 `release`：

```bash
git switch release
git pull --ff-only
git merge --ff-only main
git push origin release
```

等待 `verify` 和 `publish` 依次完成，再核对镜像架构和 digest。该次发布会生成：

```text
ghcr.io/codexu/note-gen-server:latest
ghcr.io/codexu/note-gen-server:0.1.0
ghcr.io/codexu/note-gen-server:0.1
ghcr.io/codexu/note-gen-server:sha-<commit>
```

每次向 `release` 推送新的发布提交前都必须先提升版本号，否则同名版本标签会被新镜像覆盖。需要修复时发布新的补丁版本。

新增数据库 migration 时，不要修改已经发布的 SQL 文件。提交的新 migration 会自动成为升级测试的目标；如果 schema 变更要求更新测试数据，应同步调整 `apps/server/scripts/migration-upgrade-test.ts`，确保测试仍代表真实的旧版本数据。

如果发布失败，不要修改已经运行的实例；修复后提升补丁版本并重新推送 `release`。已经使用 `latest` 的实例只有在管理员执行 `docker compose pull` 和 `docker compose up -d` 后才会切换镜像，不会因为标签更新自动重启。
