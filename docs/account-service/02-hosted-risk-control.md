# 02：官方托管风控与滥用防护技术规格

- 状态：已完成（内部测试范围；生产 Staff OIDC、风险策略与运营控制台移至 [13 生产上线准备](13-production-readiness.md)）
- 日期：2026-08-11
- 默认适用形态：`hosted`
- 前置依赖：[00 共享基础](00-shared-foundation.md)；公开邮箱注册前需 [01 邮箱身份](01-hosted-email-identity.md)
- 交付结果：注册、登录、恢复、设备、同步写入和 Blob 流量有统一风险决策、人工处置和可恢复客户端状态

## 1. 目标

- 在现有 PostgreSQL 共享限流之上增加多维速度限制与风险决策。
- 对注册、登录、找回、设备授权、上传和支付入口采用不同的策略。
- 分开建模请求决策、持久限制和最终 enforcement，覆盖 allow/challenge/silent-drop/throttle/read-only/deny/review/lock 并给出稳定 reason code。
- 将临时风险限制与账号停用、删除、订阅只读彻底分开。
- 默认不依赖单一外部风控服务；外部挑战或信誉数据通过适配器接入。
- 保证误判可人工解除、所有高风险操作可审计。

## 2. 非目标

- 不构建通用机器学习平台或跨产品用户画像。
- 不收集笔记正文、密文内容特征、文件名或 E2EE 内容用于风控。
- 不承诺完全消除撞库、垃圾注册或流量攻击；网络层 DDoS 仍由 CDN/WAF/基础设施处理。
- 不用 401 统一表达所有风控结果。

## 3. 风险面与保护动作

| 动作 | 主要风险 | 默认信号 | 可用决策 |
| --- | --- | --- | --- |
| 邮箱注册 | 批量账号、一次性邮箱、机器人 | IP 前缀、邮箱域、挑战结果、速度 | allow/challenge/deny |
| 登录 | 撞库、密码喷洒、账号接管 | IP、邮箱哈希、失败率、已知设备、TOTP | allow/challenge/lock |
| 找回/重发 | 邮件轰炸、账号枚举 | IP、邮箱哈希、账号、投递历史 | allow/silent-drop |
| 设备授权/配对 | 授权码枚举、恶意绑定 | code 失败、账号、设备、IP | allow/challenge/deny |
| 同步 command | 自动化滥用、版本风暴 | 账号、设备、command rate、拒绝率 | allow/throttle/read-only |
| Blob 上传/下载 | 存储与带宽滥用 | 账号、设备、字节速度、并发数 | allow/throttle/deny |
| 支付/优惠 | 卡测、优惠滥用 | 账号年龄、验证状态、provider signals | allow/challenge/review |

风险策略只使用必要元数据。同步对象 kind、大小和速率可用于容量保护，但内容和密文哈希不能用于跨账号关联。

## 4. 数据模型

```text
risk_events
  id bigserial pk
  event_type text
  account_id uuid nullable
  identity_hash text nullable
  device_id uuid nullable
  ip_prefix_hash text nullable
  user_agent_family text nullable
  request_id text
  outcome text
  reason_codes text[]
  score integer nullable
  metadata jsonb
  created_at

risk_restrictions
  id uuid pk
  subject_type enum('account','identity','device','ip_prefix')
  subject_ref text
  scope enum('registration','authentication','recovery','device','sync_write','blob','billing','all')
  action enum('challenge','deny','lock','read_only','review')
  reason_code text
  source enum('automatic','staff','provider')
  expires_at nullable
  created_by nullable
  revoked_at nullable
  revoked_by nullable
  created_at
  partial unique(subject_type, subject_ref, scope, action) where revoked_at is null

challenge_consumptions
  token_digest text pk             -- HMAC(key, provider || token)，全局一次性
  digest_key_id text
  provider text
  action text
  expected_hostname text
  verified_claims_hash text
  consumed_at timestamptz
  expires_at timestamptz

risk_provider_events
  provider text
  provider_event_id text
  signature_verified_at timestamptz
  payload_redacted jsonb
  status enum('pending','processing','processed','ignored','failed','dead_letter')
  attempts integer
  next_attempt_at, lease_expires_at, processed_at nullable
  error_code text nullable
  primary key(provider, provider_event_id)
```

`subject_ref` 按 kind 校验：account/device 使用可验证内部 ID，identity/IP 使用带 `key_id` 的版本化 HMAC；current/previous secret 重叠避免轮换瞬间拆分限流桶。注册/登录 route 的 PostgreSQL rate bucket 已从原始 IP/login 组合改为版本化 HMAC，并以 IP prefix、identity、IP+identity 和客户端提交的 device ID 四个独立 bucket 共同判定，任一超过短窗口阈值即返回带 `Retry-After` 的 429；HMAC key rotation 双读仍待 PR-02B。Active restriction 用 partial unique 或同事务合并，不能叠出不确定状态。Provider inbox 复用 00 durable job/lease。

不把每次成功同步都写成高基数永久事件。常规速率使用现有 rate-limit buckets 或按时间桶聚合；`risk_events` 保存拒绝、挑战、锁定、解锁和抽样成功事件，按数据治理计划设置保留期。

冻结三类动作，避免表/矩阵互相缺枚举：

```ts
type DecisionAction = 'allow' | 'challenge' | 'silent-drop' | 'throttle' | 'deny' | 'review'
type PersistentRestrictionAction = 'challenge' | 'lock' | 'read-only' | 'deny' | 'review'
type EnforcementResult = 'allow' | 'challenge' | 'throttle' | 'read-only' | 'deny'
```

`silent-drop` 只用于防枚举邮件请求的本次响应，不写成账号永久 restriction；`throttle` 通常有 Retry-After，也不等同长期 lock。组合优先级交给 00 OperationPolicy：生命周期/安全 deny > challenge > read-only > throttle > allow，review 先投影为具体 operation restriction 后执行。

## 5. 决策引擎

新增 `RiskDecisionService.evaluate(context)`，输入只包含归一化动作和服务端可信信号，客户端提交的 `trustedDevice=true` 或相同 device ID 不得直接采信。“已知设备”至少要求服务端现存归属、未撤销的 refresh/device credential 或已验证设备公钥/Web Session 证据。

决策顺序：

1. 明确的人工/系统 restriction。
2. 固定安全规则，例如 token 重放、设备归属冲突。
3. PostgreSQL 多维速度限制。
4. 邮箱域、账号年龄、已验证状态、设备历史等本地规则。
5. 可选外部 challenge/reputation adapter。
6. 输出最高优先级 action、reason codes、有效期和审计级别。

策略配置版本化。每个事件记录 `policyVersion`，但规则阈值不公开给客户端。变更策略需要变更说明、灰度比例和误判观察，不允许直接在代码中散落魔法数字。

### 5.1 基础限流键

- 注册：IP 前缀、邮箱域、邮箱哈希、全局；原生客户端另使用其提交的 device ID。
- 登录：IP 前缀、identity hash、`IP + identity`；原生客户端另使用其提交的 device ID，成功后逐步衰减失败惩罚。
- 找回：IP、identity hash、账号、provider recipient。
- 设备 code：IP、user code hash、device ID。
- Blob：账号、设备、并发上传数、分钟字节数。

原始 IP 不进入普通指标标签。短期安全调查如必须保存完整 IP，应独立加密、严格保留期和权限；默认使用带轮换 secret 的前缀 HMAC。

### 5.2 Challenge 适配器

```ts
interface ChallengeProvider {
  verify(input: { token: string; action: string; expectedHostname: string; ip?: string }): Promise<
    | {
        valid: true
        provider: string
        verifiedAction: string
        verifiedHostname: string
        expiresAt?: string
      }
    | { valid: false; provider: string; reasonCode: string }
  >
}
```

页面先获取服务端声明的 challenge 类型，再提交短期 token。Adapter 必须返回并校验 provider 已确认的 action、hostname 和时效，领域层不能只相信 `valid=true`。服务端对 `provider || token/jti` 计算版本化 HMAC，并在与受保护动作相同的事务中按 `token_digest` 全局唯一插入 `challenge_consumptions`；唯一冲突一律视为重放，因此同一 token 即使改 action 或 hostname 也不能再次消费。`verified_claims_hash` 固化 adapter 已验证声明的规范 hash，供审计但不保存原 token。Challenge action URL 必须是 capabilities 中账号 Web origin 的受控相对路径，客户端不接受 provider 返回的任意 URL。Provider outage 的处理按动作确定，不能全局一个 fail-open 开关。

## 6. 故障与降级矩阵

| 场景 | 外部风控不可用 | 本地限流存储不可用 | 默认行为 |
| --- | --- | --- | --- |
| 已知设备登录 | 跳过外部评分 | 登录服务整体 degraded | 本地规则通过则允许 |
| 新账号公开注册 | 暂停或改为邀请制 | 拒绝注册 | fail-closed |
| 密码找回请求 | 接受通用响应但不必发送 | 接受通用响应 | 防枚举、后台告警 |
| 已登录同步 Pull | 不调用外部风控 | 不受影响 | 始终允许 |
| 同步 Push/Blob | 使用本地配额和静态上限 | 依赖数据库本身已不可用 | 不因外部 provider 单独停服 |
| 支付创建 | 暂停新 checkout | 允许 provider 自身限制 | fail-closed，可稍后重试 |

任何风险 provider 故障本身不能让既有已授权 Pull 失效；数据导出仍需按账号接管风险、step-up 和合规身份校验决定，不作无条件承诺。

## 7. 账号限制语义

新增独立风险 restriction，不复用：

- `suspendedAt`：管理员账号停用。
- `disabledAt`：当前账号删除流程。
- billing read-only：订阅/权益状态。
- email unverified：身份状态。

推荐错误：

- `risk_challenge_required`：403，details 含安全 challenge URL/type，不含分数。
- `risk_temporarily_locked`：423，含 `retryAfterSeconds`。
- `risk_access_denied`：403，不暴露内部规则。
- `risk_review_pending`：409，可恢复。
- `rate_limited`：429，必须同时返回 `Retry-After` header 和 details。

只有 refresh token 确认无效/撤销/重放才返回 401。风险锁定期间 refresh 可返回 423，并让客户端进入 `risk-blocked` 状态而不是删除凭据。

引入 423/429 是一组 contract 变更：同步更新全局 ErrorResponse/OpenAPI、共享 TypeBox contract、客户端 request error 的 code/details/requestId/header 与 `Retry-After` 解析、refresh 分类；不能只在一个 route 返回新状态码。

RiskDecision 输出逐 operation scope，不能用“风险锁定通常允许 Pull/导出/删除”概括：

| Reason family | 已授权 Pull | Push/Blob | 导出/删除 | 恢复路径 |
| --- | --- | --- | --- | --- |
| automation/容量滥用 | 通常允许 | throttle/read-only | step-up 后允许 | 到期/人工复核 |
| 可疑账号接管 | 当前可疑 Session 可 challenge/deny | deny | deny 或独立 identity-check 人工通道 | 可信设备/Web step-up |
| 单设备被盗 | 其他可信设备允许，目标设备 deny | 目标设备 deny | 可信 Session + step-up | 撤销设备/重新授权 |
| provider outage | 已授权 Pull allow | 本地规则决定 | 本地身份规则决定 | provider 恢复 |

客户端严格消费 account context 的 `sync.pull/sync.push/account.export/account.delete` action，保留 outbox、停止高频重试，限制解除或 revision 更新后恢复。

## 8. 管理与人工复核

当前内部测试已提供下列独立 Staff API，均不接受客户 token 或 `accounts.isAdmin`：

- `GET /v1/internal/staff/risk/accounts/:accountId/restrictions`：要求 `risk.read`，仅返回当前 active restriction。
- `POST /v1/internal/staff/risk/accounts/:accountId/restrictions`：要求 `risk.manage`；长期、`deny`/`lock` 另要求 `risk.admin` 及 `step-up` 或 `phishing-resistant` Staff assertion，对相同 account/scope/action 在同一账户咨询锁内创建或更新。
- `DELETE /v1/internal/staff/risk/restrictions/:restrictionId`：要求 `risk.manage` 与高保证 Staff assertion；解除长期、`deny`/`lock` 或 provider/automatic restriction 另要求 `risk.admin`。

每次写入同步写入 append-only Staff 审计，并使用独立 `created_by_staff_id` / `revoked_by_staff_id` 归属字段。路由已消费新鲜 `step-up` 或 phishing-resistant Staff assertion；真实 OIDC edge、操作台 UI 与设备/identity/IP 主体处置仍未实现。

一期管理页提供：

- 按账号、设备、identity hash、reason code、时间筛选风险事件。
- 查看当前 restrictions、来源、到期时间和关联 request ID。
- 带必填原因的临时锁定、只读、解除和延长。
- 对高风险长期封禁要求 step-up MFA；禁止操作自己或最后平台管理员。
- 误判标记与策略版本反馈，但不允许直接编辑历史事件。

权限使用计划 00 的 `risk.read/manage/admin` 与默认 security analyst/admin 角色，不默认授予客服。所有人工操作使用 staff step-up并同步写不可删除审计；账号被物理清理后保留脱敏 actor/target snapshot，不使用 cascade 删除安全审计。

## 9. 指标与告警

低基数指标：

- `risk_decisions_total{action,event_type,reason_family}`
- `risk_challenges_total{result,provider}`
- `risk_restrictions_active{scope,action}`
- `auth_attempts_total{outcome,flow}`
- `rate_limit_denials_total{bucket_family}`
- provider 延迟、超时、错误率和 circuit breaker 状态

禁止用邮箱、账号 ID、IP、设备 ID 作为指标 label。告警至少覆盖：注册拒绝率突增、同一 IP 前缀失败爆发、challenge provider 故障、设备 code 猜测、Blob 字节速率异常、人工解锁量异常。

## 10. 实施步骤与 PR 切片

1. **PR-02A：风险事件与 restriction。** 表、保留策略、决策类型、账号上下文投影。
2. **PR-02B：多维限流。** 统一注册/登录/找回/设备入口，替换重复的 route 内 key 生成。
3. **PR-02C：Challenge adapter。** provider claim 验证、全局一次性 consumption、故障矩阵、公开注册 gate。
4. **PR-02D：同步与 Blob Guard。** command 单项 rejection、上传/并发节流、Pull 保持可用。
5. **PR-02E：安全运营台。** RBAC、筛选、人工限制/解除、审计。
6. **PR-02F：客户端状态。** Retry-After、challenge 浏览器跳转、risk-blocked、诊断 request ID。

## 11. 测试矩阵

- 两实例并发请求共享限流窗口，不出现各实例各放行一份。
- 注册、登录、找回的多维 key 相互隔离；不存在邮箱无法被时序/响应枚举。
- challenge token 跨 action、跨 hostname、过期、重放均失败。
- 伪造相同 device ID 不能获得 known-device 风险降级；HMAC key 轮换期间限流/restriction 不断层。
- provider 超时按故障矩阵处理，已登录 Pull 不受影响。
- 风险 lock 不触发账号删除，不取消订阅，不清空 E2EE key。
- command batch 中受限 command 稳定 rejected，已成功 command 不回滚，客户端 outbox 不丢。
- 人工解除后客户端无需重新创建本地同步状态即可恢复。
- actor 或目标账号删除后安全审计仍保留脱敏记录。
- 相同 subject/scope 并发限制按确定规则合并，provider inbox 崩溃/重试不丢失或重复处置。
- 指标无高基数 PII，日志无原始 token/IP/邮箱。

## 12. 上线与回滚

- 先 shadow 模式只记录决策，不拒绝请求；对比现有限流结果。
- Shadow 样本不记录原始 token/IP/邮箱，并定义误判基线、拒绝率/客服量阈值和自动回退门槛。
- 任何 423/429/risk restriction enforcement 前，先合并 12C 客户端分类：临时风险/限流不能清 refresh 或永久丢弃/高速重试 outbox。
- 先启用找回/重发限流，再登录保护，再邀请注册，最后 public 注册。
- 同步与 Blob 先启用告警阈值，再启用 throttle，最后才允许 read-only/deny。
- 每条策略可单独关闭并退回现有静态限流；restriction 表和安全事件保留。
- 外部 challenge 故障可立即把 public registration 切到 invitation，而不关闭已有用户登录。

## 13. 验收条件

- hosted 公开注册只有在邮箱验证、基础风控和挑战依赖全部可用时才能启用。
- 所有风险拒绝有稳定错误码、恢复条件和 request ID。
- 风控状态与停用、删除、订阅状态互不覆盖。
- 客户端不会因风险/临时限流清空 refresh token 或丢弃 outbox。
- 人工处置使用最小权限并可完整审计。

## 14. 开放问题

- 外部 challenge/reputation provider 及允许的数据区域。
- 一次性邮箱策略采用本地域名列表还是外部信誉查询；一期建议只作为 challenge 信号，不硬编码永久封禁。
- 完整 IP 的安全事件保留时长与访问审批需由合规计划确认。
