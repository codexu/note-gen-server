# NoteGen 账号服务生产上线准备计划

- 状态：暂缓，等待产品、法务与基础设施决策；不允许以环境变量绕过既有 capability hard gate
- 日期：2026-08-11
- 面向读者：服务端、客户端、SRE、安全、法务/隐私与运营负责人
- 前置：00～12 的内部测试范围已完成；本计划是其生产收口，不回写为“内部测试未完成”

## 1. 目标与边界

目标是在不改变既有同步、E2EE、删除 fence、auth/sync epoch 契约的条件下，选择并接入生产依赖，再以可回滚灰度开放 hosted 能力及自托管完整恢复能力。

非目标：现在启用真实付款或对外发信；代替法务决定地域或保留期；在未完成恢复演练时开放 preserve restore；将客户 `isAdmin` 用作 Staff 权限。

## 2. 决策前置与开放决策

以下决策必须由负责人书面确认，确认前对应 PR 不开始，capability 保持关闭。

| 决策包 | 必须确认 | 决策负责人 | 阻断能力 |
| --- | --- | --- | --- |
| P1 Billing | 首发供应商、test/live 账户、商户主体、服务地区、税务/发票、退款/争议、数据区域 | 产品、财务、法务 | `billing.subscription`、真实 checkout |
| P2 Hosted Mail | 邮件供应商、发信域名、DNS 管理、数据区域、退信/投诉处置与发信限额 | 产品、SRE、安全 | hosted `mail.delivery`、邮箱验证/找回对外开放 |
| P3 数据治理 | 适用地区、删除冷静期、各类保留期、DSR 响应目标、法律 hold 审批主体与升级路径 | 法务、隐私、产品 | 真实 hosted 用户、`compliance.requests` |
| P4 Staff 边界 | OIDC issuer/audience/JWKS、MFA/ACR、session、独立 origin、反向代理 ACL、break-glass 审计 | 安全、SRE | Staff live route、`support.cases` |
| P5 备份恢复 | KMS/密钥轮换、S3/对象锁、保留表、排程、恢复目标、RPO/RTO、演练负责人 | SRE、安全、产品 | 加密备份、restore apply、preserve restore、不可逆升级 |

## 3. 共同生产契约

### 数据模型与迁移

保留 00～12 已有表的前向兼容性。所有 P1～P5 新表必须新增 `provider`、`environment`、`config_revision`、`idempotency_key`、`request_hash`、`created_at`、`updated_at` 和最小审计关联；secret 只放受控 secret payload 或密钥服务引用。迁移仅 additive，先双读再切换写入；含不可逆数据变换的迁移必须排在已验证 backup/restore 之后。

### API、权限与状态机

生产 API 只能在 capability resolver、deployment mode、配置 revision、依赖健康和 OperationPolicy 全部通过时可用。客户 API 不返回供应商原始错误或 secret；Staff API 只接受独立 OIDC session、最小 permission 与新鲜 step-up。状态转换必须显式且持久化：外部任务为 `pending → sending/processing → delivered/completed | dead_letter/failed`，账户删除仍为 `scheduled → purging → completed`；不得把失败伪装成完成。

### 并发、幂等与恢复

所有 webhook、checkout、发送、删除、备份和恢复操作使用稳定幂等键与 request hash；数据库为 at-least-once，外部副作用以 inbox/outbox 和 provider event ID 去重。维护 generation、deletion fence、credential epoch 与 sync epoch 继续是不可绕过的硬门槛。恢复后先 sanitize/review credential，客户端显式接受新 sync epoch 后才能写入。

## 4. 可执行 PR 切片

### P1：BillingProvider 与真实付款

1. **PR-P1A：供应商配置与数据模型。** 增加受控 provider config、merchant/legal-entity version、region 与 webhook endpoint revision；`test`/`live` 严格隔离，mock 继续只用于内部测试。
2. **PR-P1B：Hosted checkout 与 webhook inbox。** 增加 provider-hosted checkout/portal、签名验证、provider event ID 去重、晚到事件 fencing 和订阅/退款状态机。
3. **PR-P1C：权益、删除与客户端只读。** 以 provider-confirmed period/grace 计算权益；删除时完成 billing handler、quiet-window reconciliation；客户端先普及只读/超额状态再打开收费写路径。

权限：客户仅创建自己的 checkout/portal session；Staff 手工 grant 保留 `billing.grant`，退款/退款覆盖单列 `billing.refund` 并强制 step-up。监控：webhook 验签失败、去重率、事件滞后、权益漂移、付款/退款失败。灰度：synthetic → 内部 live sandbox → 邀请 cohort → 分区比例；回滚：关 capability、停止创建 checkout、继续接收 inbox 并只读对账，不删除权益或同步数据。

### P2：Hosted MailProvider

1. **PR-P2A：provider adapter 与受控配置。** 固定模板、发件人、区域与 sender identity；secret 仅引用密钥服务。
2. **PR-P2B：域名/DNS 和投递反馈。** 验证 SPF/DKIM/DMARC，接入 bounce/complaint inbox 并做不可重放事件去重。
3. **PR-P2C：受控启用。** 先验证/找回 synthetic 流量，再邀请 cohort；失败时保持注册和找回关闭，绝不退化为 log sink 对外宣称已投递。

权限：仅部署运维可改 provider revision；客户不见供应商细节。监控：投递成功率、延迟、退信、投诉、队列年龄、dead-letter。回滚：冻结 `mail.delivery`，撤销未发送 action payload，保留审计与用户可恢复的本机支持路径。

### P3：生产数据治理与删除账本

1. **PR-P3A：版本化政策。** 持久化 jurisdiction、policy version、cooling/retention、legal-hold authority 与生效范围；不能以代码常量替代审批记录。
2. **PR-P3B：外部不可变 deletion ledger。** 替换本地 receipt store，写入跨灾害域、可验证、按 idempotency key 收敛的 receipt；失败则 deletion case 不得完成。
3. **PR-P3C：恢复 replay 演练。** 恢复环境重放 ledger/backup generation barrier，证明旧备份不会重新开放已删除数据或旧凭据。

权限：legal hold 创建/释放分别要求 `legal_hold.manage` 和被确认的审批 authority；客户和实例管理员均不得自授予。监控：删除 case age、ledger 延迟、hold 冲突、恢复 barrier 违反。灰度：合成账户全链路 → 内部账户 → 地区/邀请 cohort；回滚：暂停新删除申请的最终 purge，保留冷静期取消与 hold，不回退已完成的物理删除。

### P4：Staff OIDC 与客服生产边界

1. **PR-P4A：OIDC assertion exchange。** 仅信任确认的 issuer/audience/JWKS，校验 state/nonce/PKCE、MFA ACR/AMR 和短 session。
2. **PR-P4B：独立网络边界与 console。** `/internal/*` 使用独立 origin/audience、代理 ACL 和受控 console；客户 Cookie/access token 永不可达。
3. **PR-P4C：审计与演练。** 为权限变更、诊断读取、break-glass 建立不可删审计与定期审阅。

监控：OIDC 验证失败、权限拒绝、诊断读取量、跨 origin 拒绝、break-glass 使用。回滚：撤销 Staff session/revision、在边缘关闭 internal origin，不影响客户同步。

### P5：加密备份、恢复 apply 与发布

1. **PR-P5A：加密对象存储与排程。** 为 unified artifact 增加 envelope encryption、KMS key version、S3/object-lock policy、retention schedule 与 inventory 对账。
2. **PR-P5B：artifact-driven restore apply。** 仅 offline、目标确认、已验签 artifact、空间预检和 restore marker 下执行；恢复后固定执行 epoch rotation、credential sanitation 与 review。
3. **PR-P5C：preserve restore 演练与升级门。** 在隔离环境完成至少一次恢复、客户端 sync epoch 拒绝/接受演练、旧凭据拒绝演练后，才允许开启 preserve restore 与不可逆 migration。

权限：restore apply/preserve 需本机 operator、双人确认和维护 offline；不提供 Web API。监控：备份新鲜度、校验失败、KMS 错误、RPO/RTO、恢复 marker 停留、credential-review 积压。回滚：禁用 capability、保持目标 offline、使用上一个已验证 artifact；绝不以重新启用旧 epoch 或旧凭据恢复服务。

## 5. 测试矩阵与发布门

每个 PR 必须补齐单元、迁移、集成、并发/幂等、故障注入和权限拒绝用例；P1/P2 加 provider sandbox 与签名重放，P3/P5 加隔离 restore drill，P4 加错误 issuer/audience/ACR 与网络 ACL。发布前由负责人签署：迁移可前向执行、回滚边界、监控仪表盘和告警、运行手册、数据修复负责人、客户端最低版本及 capability revision。

统一灰度顺序：本地/CI fixture → synthetic internal → 内部真实依赖的 test 环境 → 小型邀请 cohort → 按地区和能力 revision 扩大。任一安全、删除、恢复或权限告警触发时，先关闭 capability 和异步新副作用，再按各切片回滚；不得回滚数据库以重放已发送邮件、已付款、已删除数据或已轮换 epoch。

## 6. 解除暂缓条件

P1～P5 的所有开放决策均已记录，并至少完成 P2、P3、P4 和 P5 的合成环境演练后，才可以创建“hosted 真实邀请用户”发布任务。P1 完成并通过账单删除/退款/客户端只读演练后，才可以创建付费发布任务。
