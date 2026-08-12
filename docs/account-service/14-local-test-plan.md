# NoteGen 账号服务本地测试用例计划

- 状态：待执行
- 日期：2026-08-11
- 模式：内部测试测试规格；面向服务端、客户端与自托管维护者
- 目的：在不启用真实支付、对外邮件、生产 OIDC 或生产对象存储的前提下，验证 00～12 已完成的本地能力与不可绕过的安全边界

## 1. 范围、非目标与通过条件

范围：账号身份、注册/邀请、风险限制、用量、删除、支持诊断、自托管 SMTP、维护模式、备份签名验证/预检、客户端 sync epoch/E2EE 恢复。

非目标：真实 BillingProvider checkout、真实 Hosted MailProvider 投递、外部不可变 deletion ledger、生产 Staff OIDC、S3/KMS、restore apply 和 preserve restore。这些在本地仅验证其 capability 保持关闭及错误路径，不模拟成功。

通过条件：每个 P0/P1 用例有可复现结果；失败用例不会产生真实外部副作用、不会泄露 token/正文/密钥、不会绕过 `deploymentMode`、删除 fence、maintenance fencing、auth epoch 或 sync epoch；失败记录 request ID、错误码与最小诊断信息。

## 2. 本地基线与安全约束

### 环境

使用独立 PostgreSQL 数据库、独立 filesystem Blob 路径和独立 `BACKUP_PATH`；三者不得指向开发者常用数据或彼此重叠。每轮创建测试实例 ID、两个普通账号、一个 self-hosted 管理员、一个 hosted Staff fixture、一个 synthetic workspace 和测试邮件地址。测试完成后只删除明确命名的临时资源。

Hosted 通过首次 Web 安装向导选择，服务端自动使用 internal-test、日志邮件和 Mock 计费配置。不要填入 live token、真实发信凭据、生产数据库 URL 或生产 DNS。

### 建议命令

以下是计划中的执行入口，实际执行前先按当前 `.env.example` 和部署文档提供必需变量：

```bash
pnpm --filter @notegen/server db:migrate
pnpm --filter @notegen/server dev
pnpm --filter @notegen/server capabilities
pnpm --filter @notegen/server doctor
pnpm --filter @notegen/server test
pnpm --filter @notegen/server test:integration
```

破坏性 backup/restore 测试仅使用临时路径、offline maintenance 与明确 confirmation：

```bash
pnpm --filter @notegen/server maintenance:mode -- offline
pnpm --filter @notegen/server backup -- create \
  --signing-key <temporary-ed25519-pem> \
  --signing-key-id local-test \
  --allow-unencrypted-local I_UNDERSTAND_UNENCRYPTED_LOCAL_BACKUP \
  --confirm CREATE_OFFLINE_FILESYSTEM_BACKUP
pnpm --filter @notegen/server backup -- verify <temporary-manifest>
pnpm --filter @notegen/server restore -- preflight \
  --backup-id <uuid> --mode clone --manifest <temporary-manifest> \
  --trust-store <temporary-trust-store> --root-public-key <temporary-root-key> \
  --minimum-trust-revision 1 --expected-trust-digest <digest>
```

恢复正常前使用项目 CLI 的明确 disable 确认；不要手改数据库 maintenance state。

## 3. Fixture 与观测

| Fixture | 最小数据 | 用途 |
| --- | --- | --- |
| H1 hosted-internal | log mail、mock billing、capability 默认关闭 | 邮箱、风险、用量、删除、支持与 capability 拒绝 |
| S1 self-hosted setup | 空数据库、仅本机可访问的安装页面 | 首次初始化和自动提权防护 |
| S2 self-hosted ready | 一位管理员、SMTP fake server 或不可达端口 | 邀请、SMTP 队列、probe、maintenance |
| C1 client profile | 两个本地实体、未同步 outbox、E2EE workspace | sync epoch 与恢复 UX |
| R1 restore sandbox | 空隔离 DB/Blob/backup path、临时 trust/key | backup create、verify、preflight 及拒绝路径 |

每个用例记录：用例 ID、Git SHA、migration set、fixture、输入、HTTP/CLI 输出、`requestId`、预期错误码、数据库断言、日志/审计 event 和清理结果。日志只保存脱敏摘要；不得把 cookie、access/refresh token、邀请链接 fragment、邮件正文、备份私钥或 recovery key 写进测试报告。

## 4. 优先级与测试矩阵

| 优先级 | 测试域 | 自动化候选 | 手工/隔离验证 |
| --- | --- | --- | --- |
| P0 | mode、注册、认证 epoch、删除/维护/sync fence | 单元 + integration | 恢复前后客户端状态 |
| P0 | 备份 verify/preflight 与目标隔离 | CLI integration | 临时 DB/Blob package |
| P1 | 邀请、SMTP 队列、风险限制、用量 CAS、支持诊断 | route/service integration | fake SMTP 与 Staff fixture |
| P1 | 客户端 E2EE onboarding、sync epoch 接受/拒绝 | 客户端单元 | 两 profile 手工冒烟 |
| P2 | doctor、审计、错误/指标、退避与 lease 恢复 | integration | 重启/超时注入 |

## 5. 按执行顺序的测试用例

### T0：部署与 capability 边界（P0）

| ID | 步骤 | 预期结果 |
| --- | --- | --- |
| T0.1 | 分别启动 hosted 与 self-hosted fixture；读取 `/v1/capabilities`。 | 返回 additive schema；不支持的 mode 不可用，能力开关不因前端参数打开。 |
| T0.2 | 空数据库启动并尝试在未完成向导前访问普通业务 route。 | 只开放安装、静态页面与健康检查；HTTP、WebSocket、worker 不开始业务服务。 |
| T0.3 | hosted 使用 legacy register 与 self-hosted 未初始化访问普通业务 route。 | hosted 不出现自动 admin；setup 仅暴露 control plane，普通业务被拒绝。 |
| T0.4 | 尝试以 capability 环境覆盖提前打开 billing、preserve restore 或 live mail。 | resolver 仍拒绝；输出稳定错误，不出现 provider 调用。 |

### T1：自托管初始化、会话与邀请（P0/P1）

| ID | 步骤 | 预期结果 |
| --- | --- | --- |
| T1.1 | 在 S1 调用 setup status/validate/complete，重复提交同一完成请求。 | 只创建一位首管理员；重复请求幂等或稳定冲突，不创建第二管理员。 |
| T1.2 | ready 后再次调用 validate/complete；删除/停用唯一管理员后运行本机 repair-admin。 | 前者 404；后者只可本机受确认执行，撤销旧会话/令牌/ceremony。 |
| T1.3 | 管理员创建 bound-email 邀请、inspect、注册；并发提交同一 token。 | token 仅消费一次；第二请求稳定拒绝；token/link 仅在创建响应出现一次。 |
| T1.4 | 对 pending 邀请 replace-and-send、撤销、重复撤销。 | 旧 token 与未领取 outbox 失效/擦除；replacement 是新 token；审计完整。 |
| T1.5 | 无 step-up、错误 CSRF、非管理员调用 invitation/policy route。 | 401/403 或稳定 step-up 错误；无邀请、无策略变更。 |

### T2：Hosted 身份、风险和用量（P0/P1）

| ID | 步骤 | 预期结果 |
| --- | --- | --- |
| T2.1 | H1 注册邮箱、重发、验证、重复验证、过期 token 与未知邮箱 reset request。 | 未验证前拒绝登录；重复/未知路径不泄露账号存在；log mail 无收件人/正文泄露。 |
| T2.2 | 完成 password reset 后使用旧 refresh/web/device authorization/pairing。 | 全部因 credential epoch 失效；新登录可建立新 session。 |
| T2.3 | 从同一 IP/identity/device 并发触发 register/login/reset，超过 bucket。 | 多维限流生效、Retry-After 稳定；数据库不保存原始 IP/登录名。 |
| T2.4 | Staff fixture 创建 `read_only`、`deny`、`lock` restriction，再尝试 Sync、Blob、Workspace 读写。 | scope/action 准确拒绝或只读；高风险 restriction 需要相应 permission + 新鲜 assertion。 |
| T2.5 | 把 `storage_bytes` limit 调到边界，竞态执行 Blob begin/complete、workspace/device 创建和 legacy/durable 写。 | CAS 只允许一个越界前成功；无负数/双计费，取消或删除后 counters 可重建。 |

### T3：删除、legal hold 与支持诊断（P0/P1）

| ID | 步骤 | 预期结果 |
| --- | --- | --- |
| T3.1 | 创建 deletion request；缺密码、缺 step-up、request-hash 不匹配及重复请求分别提交。 | 前三种拒绝；同幂等键同请求收敛，不同请求冲突。 |
| T3.2 | deletion fence 写入后并发进行 Workspace/Blob/durable sync/support message 写入。 | 所有晚提交写入拒绝；不留下半写对象或 message。 |
| T3.3 | 在冷静期取消删除；另建 legal hold 后尝试 purge/取消/释放 hold。 | 取消仅在允许状态生效；hold 阻断 purge；创建/释放需要独立 Staff 双权限和审计。 |
| T3.4 | 用本地 ledger fixture 故意使 receipt 写入失败、重放 outbox、再恢复成功。 | case 不在 receipt delivered 前 completed；重放按幂等 key 收敛，无重复 receipt。 |
| T3.5 | 客户创建 support case、诊断 grant、撤销；Staff 读取 grant，随后过期或账户删除。 | snapshot 仅允许 `sync-summary-v1`；最长七天；单 grant 读取需 `support.diagnostics` 并审计；撤销/过期/删除后密文擦除。 |

### T4：SMTP、任务恢复与维护（P1/P2）

| ID | 步骤 | 预期结果 |
| --- | --- | --- |
| T4.1 | S2 配置 fake SMTP 成功/不可达/错误证书；调用 status、test、probe。 | readiness 不因 SMTP degraded 失败；probe 不返回收件人、正文、secret 或 provider 原始响应。 |
| T4.2 | 发送邀请邮件后观察 queue；取消 pending、尝试取消 sending/dead-letter。 | 仅 pending 可取消；sending 不误报未发送；dead-letter payload 已擦除且不能伪造重试。 |
| T4.3 | worker lease 中途终止，重启后恢复；达到 max attempts 或 lease 过期。 | at-least-once 重领，最终 dead-letter；无无限 reclaim；维护非 normal 时不领取。 |
| T4.4 | 切入 read_only、write_drain、offline，分别尝试 HTTP 写、WebSocket document update、worker 领取。 | 各模式按策略拒绝；恢复 normal 后 durable queue 继续，无丢失/重复副作用。 |

### T5：备份、恢复预检、epoch 与客户端（P0/P1）

| ID | 步骤 | 预期结果 |
| --- | --- | --- |
| T5.1 | R1 在非 offline、重叠路径、错误确认词、权限过宽私钥下执行 backup create。 | 全部预检拒绝，不发布 artifact/run。 |
| T5.2 | offline 下创建 backup，再 list/verify；篡改 manifest、signature、artifact、trust revision 与路径。 | 正常包 ready 且验证通过；任一篡改拒绝，不写目标 DB/Blob。 |
| T5.3 | 对有效包与无效包运行 restore preflight，目标分别为 online/offline、schema drift、错误 instance contract。 | 仅合格 offline 目标通过；preflight 始终只读，不 import、不注册 inventory、不写 marker。 |
| T5.4 | 触发 restore sanitize 的 clone 语义 fixture，验证 auth epoch、sync epoch、credential-review restriction。 | 旧 credential/ceremony fail-closed；至少一位管理员审阅前不可联网登录。 |
| T5.5 | C1 收到变化的 `syncEpoch`、再重新授权、再显式接受新 epoch。 | 初次变化暂停自动同步且保留 outbox；重新授权不清 epoch；接受后仅重置远端 cursor/bootstrap/inbox。 |
| T5.6 | E2EE onboarding 在创建/恢复中断、secure record TTL 过期、设备/实例绑定不符、恢复 key 解锁失败。 | 不额外创建恢复路径；安全记录被清理；本地队列与实体保持。 |

### T6：Doctor、审计和不应开放的生产能力（P2）

| ID | 步骤 | 预期结果 |
| --- | --- | --- |
| T6.1 | 正常与 migration missing/hash drift/binary-too-old fixture 执行 `doctor`。 | machine-readable JSON 正确分类；schema incompatibility blocking。 |
| T6.2 | 构造过期 lease、dead-letter、stale diagnostic snapshot、缺 ready backup、未完成 deletion receipt。 | doctor 输出 warning/blocking，且不自行修改状态。 |
| T6.3 | 请求真实 checkout、live mail、external support provider、S3 backup、restore apply/preserve。 | capability 或路由拒绝；mock/log/本地 filesystem 不被误标为生产可用。 |
| T6.4 | 抽样检查 Staff、删除、风险、邮件、备份操作的 audit event 与服务日志。 | audit 有 actor/action/request ID 和最小 metadata；日志无 secret/正文/完整 PII。 |

## 6. 并发与故障注入规则

每个写入用例至少重复三次：同一 idempotency key、同 key 不同 request hash、两个并发请求。对 outbox/worker/backup/deletion 额外在“DB 提交后、外部副作用前”和“外部副作用后、状态确认前”终止进程，再重启并验证收敛。对 WebSocket 需在维护切换和 sync epoch 变化的同时提交 document update，确保服务端事务最终裁决，而不是仅依赖客户端提示。

## 7. 结果处置、回滚与开放问题

P0 失败：停止该 fixture 的继续测试，关闭相关 capability，保存脱敏证据并修复后从该套件重新开始。P1 失败：可继续不依赖该能力的套件，但不得将其标为本地可用。P2 失败：建立回归任务，不能掩盖 P0/P1 失败。

测试环境回滚只允许：关闭 capability、停止进程、丢弃明确命名的临时 DB/Blob/backup 路径并重建 fixture。不得使用生产数据、不得把临时备份提升为可信恢复源、不得通过回退 epoch/恢复旧凭据来“修复”失败。

开放问题：客户端 E2E 自动化入口与真实设备矩阵需由客户端仓库确认；fake SMTP 的实现与测试域名需由本地环境提供；若要把本计划转为 CI gate，需要先确定容器化 PostgreSQL、filesystem Blob、临时 DNS/SMTP 和并行测试隔离策略。
