# 07：自托管首次初始化技术规格

- 状态：已完成（内部测试范围；后续生产发布动作由 [13 生产上线准备](13-production-readiness.md) 统一编排）
- 日期：2026-08-11
- 适用形态：`self-hosted`
- 前置依赖：[00 共享部署策略与能力基础](00-shared-foundation.md)
- 交付结果：空实例只能通过一次性、原子、可审计的流程创建首位管理员；初始化完成后 Setup Token 不再是通用注册码

## 1. 问题

当前封闭注册使用长期环境变量 `SETUP_TOKEN`。只要运维没有轮换它，持有者可以持续注册；并且注册逻辑在“当前没有有效管理员”时自动把新账号设为管理员。该机制不能区分首次初始化和后续邀请，也会在全部管理员停用后产生意外接管。

## 2. 目标

- 建立单调的 `uninitialized → ready` 持久实例状态；初始化事务本身不伪造一个外部不可观察的 `initializing` 状态。
- 仅 self-hosted 空实例提供 Web/CLI 初始化。
- 首位管理员在同一事务中显式创建，不再依赖“没有管理员就自动授予”。
- 初始化 token 一次性、短期/可撤销、并发只能消费一次。
- 初始化向导验证部署关键配置并给出可操作警告。
- 既有部署升级时自动识别为 ready，不打断现有账号。
- hosted 完全禁用该入口，管理员由受限 provisioning 流程产生。

## 3. 非目标

- 初始化向导不自动配置 DNS、TLS、反向代理、S3 或 SMTP。
- 不在 Web 页面保存 SMTP/数据库/S3 密码。
- 不把初始化 token 继续用作普通邀请或密码重置 token。
- 一期不支持把已有 hosted 数据库切换为 self-hosted。

## 4. 状态与数据模型

复用计划 00 的权威 `deployment_settings.self_hosted_lifecycle`，本计划只新增 credential：

```text
bootstrap_credentials
  id uuid pk
  source enum('cli','legacy_environment')
  token_key_id text
  token_hash text unique
  token_hint text
  expires_at timestamptz not null
  consumed_at timestamptz nullable
  revoked_at timestamptz nullable
  created_at
```

规则：

- lifecycle 为 uninitialized 时 registration policy 强制为 bootstrap；singleton 有 `CHECK(id=true)` 与 mode/lifecycle CHECK。
- ready 时 bootstrap capability 永久关闭；代码/Schema 回滚不得重置该值。灾备恢复到初始化前空备份属于新安全事件，必须走计划 10 的 operator 流程：恢复 sanitation 先撤销包内全部 bootstrap credential、永久禁止再次导入 legacy environment token，再由本机 CLI 为本次 restore 重新签发；不能宣称数据库时间回退也保留状态。
- token 至少 256 bit 随机，只保存带 key ID 的 HMAC 和末尾提示；比较恒时，限流键使用 IP 前缀 + token fingerprint。
- CLI Web token 默认 30 分钟、最大 24 小时；legacy environment token 在首次 reconciliation 时导入为最长 7 天的兼容 credential，过期后必须由本机 CLI 重签。
- 初始化完成记录由数据库状态决定，不依赖 cookie、文件或“是否存在管理员”的动态判断。

## 5. 既有实例迁移

静态 Drizzle migration 只建立 Schema。随后由启动期 locked reconciliation（或同逻辑 data-migration CLI）在事务/advisory lock 内分类，不能假设 SQL migration 能读取运行时 `DEPLOYMENT_MODE`：

- 已存在任意账号：记录 `ready`。如果没有有效管理员，设置 `admin_repair_required=true`；既有登录、Pull/Push 保持可用，普通 readiness 不摘流，只限制管理员操作并在 health/admin status 告警。下一位注册者绝不能自动成为管理员。
- 空库且 mode=self-hosted：记录 `uninitialized/bootstrap`。
- hosted 不由计划 07 分类，计划 00 的独立 control-plane state 管理其 staff provisioning，公开 setup route 始终不可用。

现有 `SETUP_TOKEN` 在兼容发布中可作为 bootstrap credential 的初始来源，但只在 uninitialized 状态接受一次。完成后即使环境变量未轮换，也不得再用于注册。

配置校验必须读取持久 lifecycle：只有 legacy 兼容且 `uninitialized` 的实例可要求 `SETUP_TOKEN`。实例一旦 `ready`，缺少该环境变量不影响启动/readiness，存在该变量也不重新开放注册；新部署优先由 CLI 签发短期 bootstrap credential。

若数据库存在计划 10 的 completed restore marker，BootstrapService 必须执行额外恢复门槛：任何 `legacy_environment` 导入永久关闭；marker 标记 `bootstrap_reissue_required=true` 时，Web complete 拒绝所有 credential，直到本机 CLI 在同一事务中签发新 token、写明关联 restore marker 并清除该标记。恢复包内 token 即使尚未过期、hash 匹配或环境仍提供同一 `SETUP_TOKEN` 也不能复活。

## 6. 初始化入口

提供两种等价入口：

### 6.1 CLI（推荐）

```text
node dist/cli/setup.js status
node dist/cli/setup.js issue-web-token --ttl 30m
node dist/cli/setup.js repair-admin --login <name> --password-stdin --confirm=REPAIR_ADMIN
```

- `repair-admin` 仅限 ready/self-hosted 且持久 `admin_repair_required=true` 的实例；密码必须从 stdin 读取，并要求显式确认字符串，不能出现在命令行历史。它不重新打开普通注册。
- 容器非交互场景优先 issue 一次性 Web token。
- CLI 使用同一 Registration/BootstrapService，不直接写表。

### 6.2 Web

公开 endpoints：

```text
GET  /v1/setup/status
POST /v1/setup/validate
POST /v1/setup/complete
```

`status` 只返回 `setupRequired: boolean`、server name 和安全的配置检查摘要，不暴露账号数量、数据库信息或 token hint。ready 后 `GET status` 固定返回 `setupRequired:false`；`validate/complete` 固定返回 404，不在实现时二选一。

Web token 通过 Authorization header 或 POST body 提交并被日志脱敏。初始化页使用同源 HTTPS、严格 CSRF/origin 校验和更低限流；不允许 token 放在 URL query/referrer。

## 7. 原子完成流程

`POST /v1/setup/complete`：

1. 验证 deployment mode、token hash、有效期和 origin。
2. 获取 `notegen-bootstrap` advisory transaction lock，并锁 singleton settings。
3. 再次确认 lifecycle=uninitialized、数据库中无账号、无已消费 token。
4. 通过统一 `AccountCreationService` 创建 `accounts.login` 主体、明确 `isAdmin=true`；不依赖计划 01 的 identity 表，邮箱计划以后统一 backfill username identity。
5. 写 initialized 时间/账号、registration policy=disabled、`admin_repair_required=false`，消费并撤销全部 bootstrap credential。
6. 写 system→account 的高敏审计，不记录 token/密码，并提交事务。
7. 提交后创建 Web Session，并展示恢复/运维检查单。若 Session 创建失败，初始化仍已成功，返回 `setup_completed_login_required`；用户走普通登录，重试 complete 不得创建第二账号。

提交前任一步失败回滚并保持 uninitialized；外部邮件、备份测试等不放入该事务。两个并发 complete 只有一个成功，另一个得到 `setup_already_completed`。

## 8. 初始化检查单

### 8.1 阻断项

- deployment mode 与数据库记录一致。
- 数据库、migration、Blob 后端 ready。
- 生产 `AUTH_SECRET`/keyring 与 bootstrap token 不是默认值。
- `PUBLIC_BASE_URL`/`WEB_PUBLIC_BASE_URL` 是合法 origin。
- hosted mode 不允许执行。

### 8.2 警告项

- 公网 URL 不是 HTTPS。
- `TRUST_PROXY` 与可见转发头看起来不一致。
- 文件系统 Blob/backup 使用临时路径或同一故障域。
- SMTP 未配置：邀请只能复制链接，邮箱验证/找回不可用。
- 没有完成过备份/恢复演练。
- metrics、备份计划、保留期仍为默认值。

警告可带确认完成初始化，但必须保存“哪些警告被接受”审计。涉及默认 secret、数据库/Blob 不 ready 等阻断项不可绕过。

## 9. 管理员安全规则

- 先抽出统一普通账号创建 primitive，让当前 `AuthService.registerAccount`、`AuthService.register`、Web/原生/设备相关注册路径全部调用它；一次性删除两套“没有管理员就自动 admin”的分支，不能只修一个 route。
- self-hosted 首位 admin 只由 BootstrapService 创建。
- 后续管理员由已有管理员在安全页显式授予，使用计划 00 的 action-bound WebStepUpService。
- 继续保护最后一位有效管理员；无管理员时只允许本机/容器 TTY 的 repair CLI：获取 advisory lock，显示 instanceId/目标 login 与前后状态，要求逐字确认，选择既有账号提升/重新启用，撤销其全部旧 Session，清除 repair flag，并写不可删除的 system break-glass 审计。公开 HTTP 注册不能接管。
- hosted staff provisioning 使用不同服务与凭据，永不调用 self-hosted bootstrap。

## 10. Capabilities 与 UI

未初始化时客户端必须仍能发现实例：`/v1/capabilities` 先返回 setup/account Web，普通设备授权、注册、同步、Blob 和管理能力 unavailable，legacy `registrationMode=closed`。`/health/ready` 以 200 表示“setup control plane 可服务”，响应另含 `serviceState=setup_required`；这不等于业务 route 可用，OperationPolicy 仍全部拒绝。计划 12 同时改为先 discovery、再解释 readiness。

初始化完成后：

- `operations.webBootstrap=false`。
- `registration.policy=disabled`，除非管理员之后显式选择邀请/公开。
- Setup Token 字段从 Web 和 NoteGen 客户端普通注册 UI 消失。
- 管理后台显示“初始化完成时间”和下一步检查，不显示 credential。

## 11. 建议 PR 切片

1. **PR-07A：Lifecycle Reconciliation。** Schema + 启动期 locked 分类、repair degraded、setup readiness。
2. **PR-07B：统一账号创建 + CLI。** 两套注册路径移除自动 admin、显式首 admin、repair flow。
3. **PR-07C：Web Setup。** token issue/consume、状态/检查、原子 complete。
4. **PR-07D：Capabilities/UI。** 未初始化能力投影、初始化向导、移除普通 Setup Token 语义。
5. **PR-07E：运维文档。** 首次部署、token 轮换、无管理员修复和安全检查。

## 12. 测试矩阵

- 空 self-hosted、hosted、已有账号有/无管理员的 Schema + reconciliation 分类正确；既有无管理员实例仍可同步但 admin degraded。
- 两请求/两实例并发完成只有一个 admin 和一条消费记录。
- token 错误、过期、撤销、重放、ready 后使用均失败且不泄露状态。
- 初始化事务在每个提交前写步骤失败后无半初始化账号/状态；提交后 Session 失败返回 login-required 且不能重做初始化。
- 普通注册在任何 mode 下都不能因“无管理员”自动升级。
- ready 数据库改环境 mode 后进入 StartupSafetyGate、不能提供业务流量，也绝不重新初始化。
- CLI 密码/token 不出现在进程列表、日志、审计或 shell 输出。
- 旧客户端看到 closed registration，不会误把 setup 当普通注册。
- 未初始化 discovery/readiness 可展示 setup，但所有普通 HTTP/WS/worker 业务写均被拒绝。
- repair CLI 不能经网络调用，目标/确认/会话撤销/审计完整。
- 恢复到 uninitialized 备份后，包内/环境 bootstrap token 全部无效；只有本机 CLI 针对最新 restore marker 新签发的 token 可完成初始化，重复恢复后旧的重新签发 token 也失效。

## 13. 上线、回滚与验收

先部署 migration 和新的显式管理员策略，但保留 legacy bootstrap token 一次性兼容；确认所有现有实例被标记 ready 后再删除旧 route 中的 Setup Token 注册分支。

代码/Schema 回滚不能把 ready 改回 uninitialized。旧版本若仍接受 `SETUP_TOKEN`，回滚前必须从环境移除/轮换该值并保持 `REGISTRATION_MODE=closed`；恢复旧空数据库则按计划 10 作为独立 bootstrap/security event 处理。

验收条件：空 self-hosted 有清晰的一次性初始化；完成后 token 永远不能创建第二账号；hosted 无 setup 暴露；无管理员故障只能通过受限 repair CLI 解决。

## 14. 开放问题

- 首次管理员是否强制配置 TOTP；建议完成初始化后高优先级引导，但不要因 SMTP/时钟问题阻断首次登录。
- Web bootstrap token 由环境注入还是 CLI 生成；推荐 CLI 生成短期 token，环境值仅保留无人值守部署兼容。
