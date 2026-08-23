# 发布 NoteGen Server 容器镜像

仓库通过 `.github/workflows/publish-container.yml` 构建并推送多架构镜像到 GitHub Container Registry：

```text
ghcr.io/codexu/note-gen-server
```

## 自动发布规则

- 推送到仓库主开发分支 `feat/sync-foundation`：发布 `edge` 与 `sha-<commit>`。
- 推送 `v0.1.0` 形式的 Git tag：发布 `0.1.0`、`0.1` 与对应 `sha-<commit>`。
- 手动运行 workflow：发布提交 SHA 标签，用于排查构建或分发问题。
- 每次同时构建 `linux/amd64` 与 `linux/arm64`，并生成 provenance、SBOM 和 artifact attestation。

部署文档不使用 `latest`。实验用户可以跟随 `edge`，需要稳定复现时应固定完整版本或镜像 digest。

## 首次发布后的必要设置

GHCR 首次创建的 package 默认可能不是公开可见。第一次 workflow 成功后，维护者需要在 GitHub package 设置中：

1. 确认 package 已关联 `codexu/note-gen-server` 仓库。
2. 将 package visibility 设置为 Public。
3. 在一台未登录 GHCR 的机器上运行 `docker pull ghcr.io/codexu/note-gen-server:edge`，确认可以匿名拉取。

在公开可见之前，不要对外宣布 Docker 快速部署已经可用。

## 发布实验版本

确认 CI 和容器构建成功后创建版本 tag：

```bash
git tag v0.1.0
git push origin v0.1.0
```

等待 publish workflow 完成，再核对镜像架构和 digest。Compose 发布示例应固定到刚验证的版本：

```text
NOTEGEN_SERVER_IMAGE=ghcr.io/codexu/note-gen-server:0.1.0
```

不要重新覆盖已经发布的版本标签。需要修复时发布新的补丁版本。
