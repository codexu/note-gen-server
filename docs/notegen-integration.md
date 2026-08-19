# NoteGen 服务端同步接入指南

本文面向 NoteGen 客户端维护者，说明如何把 `note-gen-server` 接入桌面端和移动端。字段与错误码以 `/openapi.json` 为唯一来源，冻结的同步语义见 [`protocol-v1.md`](./protocol-v1.md)。

## 边界

服务端负责账号、设备、内部同步空间、加密信封、可靠变更日志、版本、实时唤醒和 Blob。NoteGen 客户端负责：

- 本地优先读写、outbox/inbox 和 cursor 持久化。
- 数据加密、解密、密钥保管和恢复。
- Markdown 三方合并、冲突副本和 Yjs 状态应用。
- 决定哪些设置允许跨设备同步。

同步服务器资料、Token、本机密钥和本地路径永远是设备本地状态，不能通过其管理的内部同步空间反向同步。

## 本地同步配置模型

每个服务器连接保存一个本地 `SyncProfile`：

```text
profileId
normalizedBaseUrl
serverInstanceId
serverName
accountLogin
deviceId
protocolVersion
lastSuccessfulSyncAt
connectionState
```

Access Token、Refresh Token、设备私钥和同步密钥不进入普通设置数据库：Token 与私钥放入系统安全存储，同步密钥仅在运行时内存中使用。默认模式可在重新登录后从服务端托管 envelope 恢复；高级端到端加密模式必须由用户输入同步口令或恢复密钥解锁。

`serverInstanceId` 来自 `/v1/capabilities`。同一 URL 返回了不同实例 ID 时，NoteGen 必须暂停同步并提示“服务器数据已被重置或替换”，不能把本地 outbox 自动推给一个身份不同的新实例。

## 首次连接流程

### 1. 检测服务器

用户只输入服务器 URL。客户端规范化 URL 后依次请求：

1. `GET /health/live`：确认目标是可访问的服务。
2. `GET /v1/capabilities`：确认服务类型、协议范围、实例身份、限制和注册模式。
3. `GET /health/ready`：确认数据库与 Blob 后端可用。

界面显示服务端返回的名称、版本和连接安全状态。非本机地址使用明文 HTTP 时先显示普通风险警告，并在连接期间持续标记“不安全”；HTTPS 证书错误不能静默忽略，也不能自动降级为 HTTP。

### 2. 登录或注册

- 推荐入口是“使用浏览器连接”：NoteGen 创建一次性设备授权，打开服务器 Web 页面，用户注册或登录后确认设备。
- 用户已经在服务器 Web 登录时只需确认设备，不需要再次向 NoteGen 输入密码。
- 授权成功后使用 Bearer Token 请求 `GET /v1/account`，再在 NoteGen 中显示实际关联账号。
- 用户取消等待时立即调用设备授权取消接口，不把未使用票据留到自然过期。
- 浏览器授权不可用时保留账号密码直接登录；高级手动设备令牌当前不开放。
- 开放注册：显示登录与创建账号。
- 封闭注册：默认只显示登录；“我有部署邀请码”展开 Setup Token 输入。
- 每次安装生成持久化 device UUID 和 X25519 设备密钥对，登录或注册时上传设备公钥。
- device UUID 与首次上传的公钥永久绑定；私钥丢失时生成新 device UUID，不能用旧 ID 替换公钥。
- device UUID 代表本次 NoteGen 安装而不是登录会话。断开服务器、退出账号或重新关联时必须保留；只有本地设备身份或私钥确实丢失时才能生成新 UUID。
- 登录密码与高级 E2EE 同步口令必须是两个概念。默认连接不要求同步口令；用户主动开启高级端到端加密时，登录密码不能复用为同步口令。

### 3. 创建个人数据空间并显式绑定资料库

登录成功后，客户端幂等取得账号唯一的 `account-data` Workspace，用于 tags、marks、conversation、message、memory 与可同步 settings。该空间不可邀请其他成员，也不对应本地笔记目录。

每个本地笔记目录单独对应一个 `library` Workspace。首次发现未绑定目录时，客户端必须让用户选择：

- 新建资料库并绑定当前目录。
- 从自己拥有或加入的资料库中选择一个，并选择独立的本地落地目录。
- 暂不同步。

禁止静默上传未绑定目录。加入他人的资料库不会替换当前目录，而是在资料库列表中增加一个独立 Workspace；多个资料库可以同时同步到不同的本地目录。

Workspace ID 用于协议、权限和数据隔离。不同设备的绝对路径可以不同，本机绝对路径不得作为服务端数据主键。

默认托管模式追求零配置，登录后的新设备可以自动解锁。用户在“高级加密”中设置独立同步口令后，客户端把同一密钥改包为 passphrase + recovery envelope，服务端事务性删除 managed envelope。恢复密钥只展示一次；此后新设备必须使用同步口令或恢复密钥，服务端无法找回明文。

protocol v1 只开放 managed 加密；信封和 key version 保留未来 E2EE 扩展能力，但客户端不显示尚未实现的 E2EE 开关。

### 4. 自动首次同步

连接后立即按可靠顺序执行：先提交 durable outbox，再按游标 Pull；需要 bootstrap 时先读取远端固定快照，再扫描当前目录并提交尚未存在的 Markdown。用户不需要选择“上传”或“下载”。

两侧都有数据时绝不提供整库覆盖。相同路径发生并发修改时保留本地冲突副本，再应用远端版本；未冲突的内容自动合并到当前目录。

## 日常状态机

NoteGen 对用户只展示稳定的高层状态：

```text
未配置 → 正在连接 → 正在解锁 → 首次同步 → 已同步
                                  ↘ 需要处理
已同步 → 离线（本地可编辑） → 正在重连 → 已同步
```

“已同步”表示 durable outbox 为空、Pull 已追到服务器 latest sequence，并且本地 cursor 已持久化；WebSocket 在线本身不代表同步完成。文件监听负责本机低延迟触发，WebSocket 只负责远端唤醒，15 秒周期同步作为丢消息和断线的兜底。

状态区域应显示最后成功同步时间、待上传对象数、待上传附件数和需要用户处理的冲突数。普通网络重试不弹模态框，认证失效、实例身份变化、密钥不可用和协议不兼容才阻断用户。

## 配置同步策略

设置使用 `setting` 对象，每个设置键使用确定性的 UUIDv5 对象 ID。密文载荷建议包含：

```json
{
  "schemaVersion": 1,
  "key": "editor.fontSize",
  "value": 16,
  "logicalClock": "...",
  "modifiedByDeviceId": "..."
}
```

### 默认同步

- 主题、语言、字号等通用外观。
- 编辑器行为、Markdown 偏好和非设备相关快捷操作。
- 非敏感 AI 功能开关、提示词模板和模型名称。
- 用户明确创建的标签、模板和工作流偏好。

### 默认不同步

- SyncProfile、服务器 URL、账号、Token、cursor、outbox 和 inbox。
- device ID、设备私钥、同步密钥、本地解锁缓存。
- 本地资料库路径、窗口位置、下载目录和系统权限状态。
- 麦克风、扬声器、摄像头等硬件选择。
- 本地模型路径、代理、调试开关和平台专属配置。
- API Key、Cookie、第三方 OAuth Token 等秘密。

API Key 若未来支持同步，必须作为单独的“同步敏感配置”显式开关，使用独立子密钥加密，并在新设备上再次确认；不能因为普通设置同步已开启而自动加入。

普通标量设置发生 revision conflict 时，可以在客户端使用逻辑时钟确定性收敛；涉及删除、列表结构或敏感配置时保留冲突并要求确认。笔记正文仍然使用三方合并，不能套用设置的覆盖策略。

远端设置应在本轮笔记和 outbox 同步稳定后应用。修改同步连接本身的设置永远不能由远端载荷自动生效。

## 实时事件

WebSocket 认证后可能收到：

- `workspace.changed`：立即按 cursor Pull。
- `workspace.keys-changed`：重新获取 key envelopes；不要推进同步 cursor。
- `workspace.state-changed`：刷新 Workspace 列表并处理删除或恢复状态。
- `account.workspaces-changed`：账号的 Workspace 集合发生变化，重新读取列表；用于发现其他设备新建的 Workspace。

认证响应包含 Access Token 到期时间。客户端应提前刷新并重连；连接关闭不影响本地编辑，重连后始终先 Pull。

## 附件体验

- 创建上传返回 `201` 表示新会话，返回 `200` 表示 Blob 已存在或恢复了旧会话。
- `uploadedParts` 和上传状态接口用于跳过已经可靠保存的分片。
- 分片只能按服务端返回的 `partBytes` 切分，最后一片除外。
- complete 可以原样重试；成功响应丢失时不会重复生成 Blob。
- 上传状态的 `completingAt` 非空或 complete 返回 `blob_upload_completing` 时，保留会话并退避重试；服务端会恢复超时的完成任务。
- 正文先同步，附件按需后台上传；只有引用该附件的对象必须等待 Blob ready。
- 大附件显示字节进度，网络切换和应用重启后继续，而不是重新开始。

## 冲突与错误文案

用户应看到可行动的描述，而不是 HTTP 状态码：

| 服务端情况 | NoteGen 行为 |
|---|---|
| `revision_conflict` | 后台三方合并；失败后进入冲突中心 |
| `cursor_expired` | 自动重新 bootstrap，并保留本地 outbox |
| `device_revoked` | 清除该服务器会话，保留本地数据并要求登录 |
| `key_envelope_recipient_not_found` | 刷新设备列表，重新发起设备授权 |
| `operation_id_reused` | 停止该 outbox 项并报告本地一致性错误 |
| `ciphertext_hash_mismatch` | 重新加密该对象，不复用损坏载荷 |
| `blob_identity_conflict` | 重新生成 Blob ID，不覆盖远端内容 |
| `protocol_incompatible` | 阻止同步并提示升级对应一端 |

## 客户端验收

接入完成至少验证：

1. 首次上传、首次下载和两端都有数据的导入合并。
2. 离线编辑数小时后恢复，outbox 不丢失也不重复产生内容。
3. WebSocket 丢消息、断线和 Token 到期后仍通过 cursor 收敛。
4. 同一篇笔记双设备编辑可合并，失败时生成可见冲突副本。
5. 应用在每个 Blob 分片、complete 和 Push 响应前被强制退出后均能恢复。
6. 服务器 URL 指向不同 instance ID 时不会自动上传。
7. 被撤销设备立即失去 API 权限，本地笔记仍可导出。
8. 配置同步不会传播 Token、本地路径、硬件选择或 API Key。
9. 删除 Workspace 后可以在保留期内恢复，过期清理后不能恢复。
10. 没有恢复密钥或可用设备时，界面明确说明服务端无法解密或找回数据。

## 删除账号

删除账号必须再次输入登录密码并键入明确确认文本。服务端立即撤销全部设备、停止登录并软删除所有 Workspace；物理 Blob 和账号记录在保留期结束后由维护任务清理。NoteGen 在请求成功前应提醒用户先导出本地数据和恢复密钥，并明确说明该操作没有服务端撤销入口。
