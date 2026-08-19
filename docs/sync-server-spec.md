# NoteGen Sync Server 技术规格

- 状态：Implemented baseline（v0.1.0）
- 日期：2026-08-05
- 面向读者：NoteGen 客户端与同步服务开发者、部署维护者
- 目标：确定第一版可实施的同步协议、服务端边界、数据模型、加密模型与交付顺序

> 本文保留早期设计背景。已经冻结的发布协议以 [protocol-v1.md](protocol-v1.md) 与 `/openapi.json` 为准；其中“无多人共享/无成员/无 presence”等早期非目标已经被 protocol v1 取代。

## 1. 概述

NoteGen Sync Server 是一个无界面、可 Docker 自托管的同步服务。NoteGen 桌面端、移动端和 Web 端均作为本地优先客户端，通过同一套协议与服务端交换变更。

服务端不托管 NoteGen Web，不渲染或编辑 Markdown，不运行 AI、RAG、OCR、MCP，也不提供多人共享、角色权限或多人实时协作。

系统采用两层同步模型：

1. 可靠同步层：使用本地 outbox、服务端变更日志、单调递增游标、幂等操作和 tombstone，覆盖全部需要同步的数据。
2. 活跃文档层：使用 Yjs 二进制增量处理同一用户多设备同时编辑同一篇笔记；不实现在线用户、多人光标和协作房间。

WebSocket 只用于降低通知延迟。任何断线或漏消息都必须能通过持久化游标恢复，不能将 WebSocket 当作唯一事实来源。

## 2. 问题

NoteGen 当前的 Git、WebDAV、S3 等同步方式建立在远程文件或对象存储之上，存在以下共同限制：

- 需要扫描、列举或比较大量远程对象。
- 以路径和文件为同步单位，无法理解重命名、逻辑记录或附件引用。
- 修改小段文字也可能上传完整文件。
- 缺少服务端连续变更日志，客户端无法可靠订阅增量变化。
- 冲突通常只能整文件覆盖或生成副本。
- 后台重试、重复请求和断线恢复缺少统一语义。
- 各同步提供商行为不同，客户端包含大量提供商分支。

目标不是实现一个更快的 WebDAV，而是建立 NoteGen 自有、与存储提供商无关的复制协议。

## 3. 目标

- 本地优先：所有编辑先持久化到客户端本地，不等待网络。
- 近实时：同地域正常网络下，文本变更提交后其他在线设备通常在 1 秒内收到。
- 增量高效：同步复杂度与变化量相关，不与工作区文件总数相关。
- 可靠恢复：进程退出、网络抖动、设备休眠和消息丢失后可自动补齐。
- 幂等：客户端可安全重试任何未确认操作。
- 离线并发：多设备离线修改后不静默丢失内容。
- 版本历史：可查看和恢复历史版本，恢复本身生成新版本。
- 端到端加密：服务端默认无法读取笔记正文、结构化数据、Yjs 更新和附件内容。
- 自托管：提供清晰的 Docker Compose 部署、升级、备份和恢复流程。
- 客户端无关：桌面、移动和 Web 使用同一协议；服务端不包含 Web 专用逻辑。
- 可演进：协议显式版本化，旧客户端能识别不兼容升级。

## 4. 非目标

- 多人共享 Workspace。
- Workspace 成员、角色和细粒度权限。
- 多人光标、在线状态、评论、邀请和协作房间。
- 服务端 Markdown 渲染、全文检索、AI、RAG、OCR 或内容分析。
- 托管 NoteGen Web 静态资源。
- 直接暴露服务器文件系统或数据库给客户端。
- 同步整个 SQLite 数据库文件。
- 与 Git、WebDAV、S3 协议兼容。
- 第一版跨 Workspace 或跨账号去重附件。

## 5. 约束与假设

### 5.1 已确定约束

- 服务端语言与运行时：TypeScript + Node.js。
- HTTP 框架：Fastify。
- 数据访问：Drizzle ORM。
- 元数据数据库：PostgreSQL。
- 实时通知：WebSocket。
- 部署：Docker Compose。
- 默认附件后端：Docker Volume 中的本地文件系统。
- 扩展附件后端：S3-compatible Storage Adapter。
- NoteGen 仍以本地 Markdown 可访问性为重要产品能力。

### 5.2 工作假设

- 一个账号可以拥有多个 Workspace。
- 每个 Workspace 只有一个 owner，不存在成员或共享关系。
- 部署可以承载多个彼此完全隔离的账号，但不提供账号间协作。
- 服务端时间不用于判断冲突先后，设备时钟偏差不能影响正确性。
- 客户端负责加密、解密、三方合并、Yjs 应用与 Markdown 物化。
- 第一版采用单主 PostgreSQL 和单实例 Server；横向扩容在协议层预留。

## 6. 系统边界

```text
┌──────────────────────── NoteGen 客户端 ────────────────────────┐
│ 编辑器 / 文件系统 / 本地数据库                                  │
│        ↓                                                       │
│ Local Change Journal → Durable Outbox → Sync Engine            │
│        ↑                                  ↓                    │
│ Local Inbox / Cursor ← HTTP Pull + WebSocket Wake-up           │
│        ↓                                                       │
│ Merge / Decrypt / Materialize Markdown                         │
└────────────────────────────────────────────────────────────────┘
                              │
                              │ HTTPS / WSS
                              ▼
┌────────────────────── NoteGen Sync Server ─────────────────────┐
│ Auth │ Push/Pull API │ Change Log │ WebSocket │ Blob API       │
│                         ↓                 ↓                    │
│                    PostgreSQL        Blob Storage              │
└────────────────────────────────────────────────────────────────┘
```

### 6.1 服务端负责

- 账号、设备、访问令牌和 Workspace 所有权校验。
- 接收幂等变更并分配服务端 revision 与 sequence。
- 返回指定 cursor 之后的增量变化。
- 保存对象当前版本、历史密文版本和删除墓碑。
- 广播 Workspace 最新 sequence。
- 存储、校验和回收加密附件。
- 协议版本、能力和限制协商。
- 过期游标检测与全量 bootstrap。

### 6.2 客户端负责

- 本地数据模型和本地持久化。
- 捕获变化并可靠写入 outbox。
- 加密所有内容 payload 和 blob。
- 生成稳定对象 ID、operation ID 和设备 ID。
- 应用远端变化并更新本地 cursor。
- 三方合并 Markdown。
- 保存冲突版本，不静默覆盖。
- 应用、合并和压缩 Yjs 更新。
- 将 Yjs 状态物化为 Markdown 快照。

## 7. 技术栈

### 7.1 服务端组件

- Node.js 当前 LTS
- TypeScript strict mode
- Fastify：HTTP API、生命周期、日志和插件体系
- Drizzle ORM + drizzle-kit：Schema 与迁移
- PostgreSQL：事务、sequence、唯一约束和历史记录
- `@fastify/websocket`：实时变更通知
- TypeBox 或 Zod：请求响应运行时校验；最终选择应与 OpenAPI 生成方式一致
- Pino：结构化日志（Fastify 内置集成）
- Argon2id：账号密码派生
- JOSE：短期访问令牌与设备刷新令牌
- Node.js Crypto：服务端 token 哈希、随机数和完整性校验

### 7.2 不在第一版引入

- Redis：PostgreSQL `LISTEN/NOTIFY` 已覆盖共享同一数据库的多实例 WebSocket 唤醒；只有跨数据库或更大规模拓扑出现后再评估 Redis。
- Kafka、NATS 或 RabbitMQ：当前同步日志已由 PostgreSQL 持久化，无需额外消息系统。
- Elasticsearch：服务端看不到明文，无法提供内容检索。
- Kubernetes：先保证 Docker Compose 的部署和升级质量。

## 8. 身份与设备模型

### 8.1 账号隔离

多账号仅用于部署级隔离，不代表多人权限：

- 一个 Workspace 必须且只能属于一个账号。
- API 不存在成员表、角色表或分享接口。
- 所有对象查询必须同时约束 `account_id` 和 `workspace_id`。
- 自托管可配置 `REGISTRATION_MODE=closed|open`，默认 `closed`。

### 8.2 设备

每次客户端安装生成随机 `device_id` 和设备密钥。设备记录用于：

- 绑定 refresh token。
- 标识操作来源。
- 记录每个 Workspace 的确认 cursor。
- 展示和撤销已登录设备。
- 判断长期离线设备是否需要重新 bootstrap。

设备名称和平台属于非敏感元数据，不参与同步冲突判断。

### 8.3 Token

- Access token：短期有效，例如 15 分钟。
- Refresh token：随机高熵值，只在服务端保存哈希，绑定账号和设备。
- Refresh token 轮换；复用已轮换 token 时撤销该设备会话。
- WebSocket 使用短期 access token 建立连接。

## 9. 端到端加密

### 9.1 威胁模型

目标是让服务器管理员、数据库泄露和对象存储泄露无法直接恢复用户内容。以下元数据第一版仍对服务端可见：

- 账号、Workspace 和设备 ID。
- 对象 ID、对象类别、revision、sequence、大小和时间。
- 变更频率和密文大小。

路径、标题、正文、标签、聊天、设置值、Yjs update 和附件内容必须加密。

### 9.2 密钥层次

```text
用户同步加密口令
        ↓ Argon2id
Key Encryption Key (KEK)
        ↓ 解包
Workspace Key (WK，随机 256 bit)
        ├── Payload Encryption Key
        ├── Blob Encryption Key
        └── Blob Identifier Key
```

- 每个内部同步空间独立生成 WK。默认零配置模式由服务端托管 managed envelope；高级 E2EE 模式只保留客户端生成的 passphrase/recovery envelope。
- 服务端只保存被 KEK 包装后的 WK、salt、KDF 参数和 key version。
- 登录密码与同步加密口令逻辑分离。
- 新设备通过输入加密口令或现有设备配对获取 WK。
- 必须生成离线恢复密钥；服务端无法找回遗失的 E2EE 密钥。

### 9.3 内容加密

- 使用带认证加密算法，例如 XChaCha20-Poly1305 或 AES-256-GCM。
- 每次加密使用唯一随机 nonce。
- Associated Data 包含 workspace ID、object ID、kind 和 key version。revision 不加入，因为历史恢复会把同一密文写成新 revision；revision 并发语义由服务端事务保护。
- 服务端在提交事务前校验密文大小和客户端提供的密文哈希，但不能校验明文语义。
- 对象内容采用 envelope version，便于未来升级算法。

### 9.4 Blob 标识

不直接使用明文 SHA-256 作为全局对象键，以避免跨账号内容相等性泄露。客户端使用 Workspace 专属标识键计算：

```text
blob_id = HMAC-SHA256(blob_identifier_key, plaintext_hash)
```

因此只在同一 Workspace 内去重。服务端按 `workspace_id + blob_id` 定位密文。

### 9.5 密钥轮换

- 新写入使用最新 key version。
- 历史对象保留原 key version，客户端按需惰性重加密。
- 全量轮换作为显式后台任务，不阻塞正常同步。
- 删除旧密钥前必须确认所有现存对象已完成重加密。

## 10. 逻辑对象模型

同步协议同步逻辑对象，不同步数据库表文件或目录扫描结果。

```ts
type SyncObjectKind =
  | 'note'
  | 'folder'
  | 'asset'
  | 'canvas'
  | 'record'
  | 'tag'
  | 'mark'
  | 'conversation'
  | 'memory'
  | 'setting'
  | 'yjs-checkpoint'
  | 'yjs-update'

interface EncryptedObjectEnvelope {
  objectId: string
  workspaceId: string
  kind: SyncObjectKind
  baseRevision: number | null
  keyVersion: number
  ciphertext: string
  ciphertextHash: string
  blobRefs: string[]
}
```

### 10.1 稳定 ID

- 对象使用 UUIDv7 或 ULID，不能使用文件路径作为主键。
- 文件移动和重命名是同一对象的 metadata 更新。
- 路径包含在加密 payload 内，服务端不依赖路径建立层级。
- 客户端必须维护 `object_id ↔ local path/local row` 映射。

### 10.2 设置同步白名单

只同步跨设备有意义的设置。以下内容默认留在设备本地：

- 窗口大小和位置。
- 本地 Workspace 绝对路径。
- 系统快捷键注册状态。
- 最近打开的系统文件选择器路径。
- 设备性能和缓存参数。
- 未经加密的第三方 API token。

## 11. PostgreSQL 数据模型

以下是概念 Schema，实际实现使用 Drizzle 定义和迁移。

### 11.1 核心表

```text
accounts
  id, login, password_hash, created_at, disabled_at

devices
  id, account_id, name, platform, encryption_public_key,
  created_at, last_seen_at, revoked_at

refresh_tokens
  id, account_id, device_id, token_hash, expires_at, rotated_at, revoked_at

workspaces
  id, account_id, name_ciphertext, latest_sequence, created_at, deleted_at

workspace_keys
  workspace_id, key_version, created_at

workspace_key_envelopes
  id, workspace_id, key_version, envelope_type, recipient_id,
  wrapped_key, kdf_salt, kdf_params, created_at

objects
  workspace_id, object_id, kind, current_revision,
  ciphertext, ciphertext_hash, key_version,
  blob_refs, deleted_at, created_at, updated_at

object_versions
  workspace_id, object_id, revision, sequence, kind,
  ciphertext, ciphertext_hash, key_version,
  blob_refs, source_device_id, created_at

changes
  workspace_id, sequence, object_id, revision,
  operation_id, source_device_id, change_type, created_at

operations
  workspace_id, operation_id, source_device_id, request_hash,
  result_revision, result_sequence, created_at

device_cursors
  workspace_id, device_id, acknowledged_sequence, updated_at

bootstrap_sessions
  id, workspace_id, device_id, snapshot_sequence, expires_at, created_at

blobs
  workspace_id, blob_id, size, ciphertext_hash,
  storage_key, state, created_at, last_referenced_at

blob_uploads
  id, workspace_id, blob_id, expected_size,
  received_size, expires_at, completed_at

server_metadata
  key, value, created_at
```

### 11.2 必要约束

- `operations(workspace_id, operation_id)` 唯一，提供幂等性。
- `changes(workspace_id, sequence)` 唯一且有序。
- `object_versions(workspace_id, object_id, revision)` 唯一。
- `objects(workspace_id, object_id)` 唯一。
- 所有外键删除策略必须显式定义，不能依赖 ORM 默认值。
- sequence 在 Workspace 范围内单调递增，由数据库事务分配。

## 12. 同步协议

所有 API 位于 `/v1`。请求和响应必须有运行时校验，并生成 OpenAPI 文档作为客户端实现依据。

### 12.1 能力协商

```http
GET /v1/capabilities
```

返回：

- 协议版本范围。
- 最大批量操作数和 payload 大小。
- Blob 分片大小与并发限制。
- 是否启用注册、E2EE、WebSocket、S3 后端。
- 服务端版本和最低兼容客户端版本。

### 12.2 建立同步会话

```http
POST /v1/workspaces/:workspaceId/sync/session
```

客户端提交 `deviceId`、当前 cursor、协议版本和支持能力。服务端返回：

- `latestSequence`。
- cursor 是否仍在保留窗口内。
- 是否必须 bootstrap。
- WebSocket endpoint。
- 当前 limits 和 key versions。

### 12.3 Push

```http
POST /v1/workspaces/:workspaceId/sync/push
```

```ts
interface PushOperation {
  operationId: string
  objectId: string
  kind: SyncObjectKind
  baseRevision: number | null
  keyVersion: number
  ciphertext: string
  ciphertextHash: string
  blobRefs: string[]
  delete: boolean
}
```

服务端对每个操作：

1. 验证身份、Workspace 所有权、请求大小和 envelope。
2. 查询 `operation_id`；已存在且请求指纹一致则返回原结果，不一致返回 `operation_id_reused`。
3. 锁定目标对象行。
4. 比较 `base_revision` 与当前 revision。
5. 匹配时写入版本、更新当前对象并追加 change。
6. 不匹配时返回 `revision_conflict`，包含当前 revision 和远端密文版本。
7. 在同一事务中记录 operation result。
8. 提交后发送 PostgreSQL NOTIFY，并通知 WebSocket 连接。

每个操作使用独立事务并返回 `applied`、`conflict` 或 `rejected`。单个业务错误不阻塞后续操作；基础设施故障导致批次中断时，客户端原样重试，由 operation ID 安全去重。

### 12.4 Pull

```http
GET /v1/workspaces/:workspaceId/sync/changes?after=<cursor>&limit=<n>
```

响应包含：

- 有序 changes。
- 对应密文对象版本或获取地址。
- `nextCursor`。
- `hasMore`。
- `latestSequence`。

客户端只有在本页所有变化成功、持久化应用后，才更新本地 cursor。更新过程必须在客户端本地事务中完成。

### 12.5 Cursor 确认

```http
PUT /v1/workspaces/:workspaceId/sync/cursor
```

服务端记录设备已持久化应用的最大 sequence，用于诊断、清理和设备状态展示。它不是 correctness 的唯一依据；客户端本地 cursor 才是恢复起点。

### 12.6 WebSocket

```text
WSS /v1/sync/events
```

连接订阅账号拥有的 Workspace。消息只发送提示：

```json
{
  "type": "workspace.changed",
  "workspaceId": "...",
  "latestSequence": 1042
}
```

WebSocket 不直接承诺完整传送所有 change。客户端收到通知后调用 Pull；断线重连也调用 Pull。

需要心跳、指数退避和带随机抖动的重连策略。Token 过期时客户端刷新 token 后重新连接。

### 12.7 Bootstrap

新设备或 cursor 过期时：

1. 请求 Workspace manifest，得到当前有效对象 ID、revision、kind 和密文哈希。
2. 分页下载当前对象密文。
3. 按需下载 Blob。
4. 在客户端事务中构建本地状态。
5. 保存 bootstrap 对应的服务端 sequence。
6. 再 Pull bootstrap 期间产生的新变化。

不能要求服务端无限保留 change log。cursor 超出保留窗口时明确返回 `cursor_expired`，客户端进入 bootstrap，而不是静默漏数据。

Bootstrap 不依赖可能被裁剪的 change log：每个 object version 固化其 workspace sequence。第一页创建 30 分钟的设备级 Bootstrap Session，后续页携带 session ID；维护任务在 session 有效期内不得删除其快照需要的版本。

## 13. 客户端同步状态机

```text
STOPPED
  ↓ login / network available
CONNECTING
  ↓
HANDSHAKE
  ├── cursor valid ──→ PUSH_OUTBOX → PULL_CHANGES
  └── cursor expired → BOOTSTRAP ──→ PULL_CHANGES
                                      ↓
                                    IDLE
                         local change ↓ ↑ websocket wake-up
                                PUSH / PULL
```

### 13.1 Durable Outbox

本地修改和 outbox 写入必须是同一逻辑事务；不能先改内容再异步尝试记录待同步操作。

Outbox 至少保存：

- operation ID。
- object ID 和 kind。
- base revision。
- 加密 envelope 或可重新生成它的本地版本引用。
- 重试次数、下次重试时间和最后错误。
- 创建时间与优先级。

同一对象尚未发送的连续快照操作可以合并，已发送未 ACK 的操作不能修改 operation ID 或内容。

### 13.2 Inbox 与应用事务

远端 change 必须先进入本地 inbox，再解密和应用。应用内容、更新对象 revision、标记 inbox 完成和推进 cursor 应保持原子性。崩溃后允许重复应用同一 change，但不能跳过。

### 13.3 重试

- 网络错误、`429` 和 `5xx`：指数退避并增加随机抖动。
- `401`：刷新 token 后重试一次。
- `409 revision_conflict`：进入合并流程，不能盲目重试。
- `413`：拆分 batch 或转为 Blob 上传。
- 不可恢复的 schema/协议错误：暂停相关对象并向用户显示可操作错误。

## 14. 冲突与三方合并

### 14.1 基础规则

服务端不使用时间戳决定胜者，也不执行 last-write-wins。出现 base revision 不匹配时，服务端保留当前版本并返回冲突。

客户端使用：

- Base：本地修改开始时的共同版本。
- Local：当前本地内容。
- Remote：服务端当前内容。

执行客户端三方合并。

### 14.2 Markdown 合并

- 优先采用行级三方合并。
- 无重叠修改自动合并并生成新 operation。
- 重叠但可结构化判断的修改可在编辑器中提示选择。
- 无法安全解决时保存 `Local` 与 `Remote` 两个历史版本，并生成明确的冲突副本。
- 任何路径都不得静默丢弃一个版本。

### 14.3 结构化记录

- 不同字段可按字段合并，但必须为每种 kind 显式定义策略。
- 集合使用稳定成员 ID，避免按数组下标合并。
- 删除与修改并发时保留修改版本并提示，而不是直接删除。
- 未定义合并器的 kind 默认产生冲突，不使用隐式 last-write-wins。

## 15. Yjs 活跃文档同步

### 15.1 范围

Yjs 仅用于同一账号的多台设备同时打开同一篇 NoteGen 笔记。明确不实现：

- Awareness。
- 多人光标和选区。
- 用户颜色、头像和在线列表。
- 分享链接和房间 ACL。

### 15.2 双层表示

NoteGen 需要同时保持：

- Yjs 文档状态：用于活跃编辑、细粒度增量和并发收敛。
- Markdown 快照：用于本地文件、导出、外部编辑器和长期可读性。

Yjs checkpoint 必须记录其对应的 Markdown revision。客户端稳定保存后，将编辑器状态物化为 Markdown，并作为普通 note revision 推送。

### 15.3 更新流程

1. 打开笔记时加载最近 Yjs checkpoint。
2. 拉取 checkpoint 之后的加密 Yjs updates。
3. 客户端解密并应用到 Y.Doc。
4. 本地编辑产生 update，立即保存本地 outbox。
5. 在线时通过普通 push API 或专用低延迟通道上传。
6. 其他设备收到 sequence 通知后拉取并应用。
7. 达到更新数量或体积阈值后，由客户端生成新 checkpoint。
8. 服务端在 checkpoint 被确认后按保留策略清理旧 updates。

由于服务端看不到 E2EE 明文，它不能合并、验证或压缩 Yjs 内容；checkpoint 必须由持有 Workspace Key 的客户端产生。

### 15.4 外部 Markdown 修改

外部编辑器可能绕过 Yjs：

- 没有未提交 Yjs 更新时，将外部 Markdown 解析为新的编辑器状态并建立 checkpoint。
- 存在活跃 Yjs 修改时，不允许直接覆盖 Y.Doc。
- 客户端尝试使用最近 Markdown 快照进行三方合并。
- 无法安全转换或 Markdown 往返不保真时生成冲突版本。

在实现 Yjs 前必须完成 Tiptap ↔ Markdown 往返保真测试；这是该阶段的进入条件。

## 16. Blob 与附件

### 16.1 原则

- 文本变化不能被大附件阻塞。
- Blob 使用 Workspace 内内容寻址和去重。
- 上传支持分片、恢复、并发限制和最终哈希校验。
- 客户端按需下载，允许先显示笔记再后台获取附件。

### 16.2 上传流程

1. 客户端加密内容并计算 ciphertext hash。
2. 客户端使用 Workspace Blob Identifier Key 对 ciphertext hash 做 HMAC，得到 workspace-scoped blob ID。
3. `HEAD /v1/workspaces/:id/blobs/:blobId` 查询是否存在。
4. 不存在时创建 upload session。
5. 分片上传密文。
6. 服务端校验密文总大小和 ciphertext hash。
7. 完成后 Blob 状态从 `uploading` 变为 `ready`。
8. 对象 push 只能引用 `ready` Blob。

### 16.3 Storage Adapter

```ts
interface BlobStorage {
  createUpload(input: CreateUploadInput): Promise<UploadSession>
  writePart(input: WritePartInput): Promise<void>
  completeUpload(input: CompleteUploadInput): Promise<StoredBlob>
  openReadStream(key: string, range?: ByteRange): Promise<NodeJS.ReadableStream>
  delete(key: string): Promise<void>
  exists(key: string): Promise<boolean>
}
```

当前已实现 `FilesystemBlobStorage` 和 `S3BlobStorage`。接口不向 API 暴露本地路径或对象存储凭据。

### 16.4 垃圾回收

- 解除引用后不立即删除 Blob。
- 使用宽限期，例如 30 天。
- GC 前重新检查当前对象和保留历史的 blob refs。
- 未完成上传超过 TTL 后清理。
- 删除数据库记录与物理 Blob 使用可重试任务，避免半完成状态。

## 17. 删除、历史与保留

### 17.1 Tombstone

删除操作生成新 revision 和 change，`objects.deleted_at` 标记墓碑。其他设备同步墓碑后删除或移入本地回收站。

墓碑至少保留到以下条件之一满足：

- 所有仍有效设备 cursor 均越过删除 sequence，并达到最小保留期。
- 达到部署配置的最大保留期，旧设备之后必须 bootstrap。

### 17.2 历史版本

- 每次成功 push 产生不可变 `object_versions` 记录。
- 历史内容保持端到端加密。
- 恢复历史版本是一次新的 push，不能回退 sequence 或原地覆盖历史。
- 默认保留策略建议为 90 天，可按部署配置。
- 删除历史前必须考虑其 Blob 引用。

### 17.3 Change Log 清理

- Change log 保留期与历史版本保留期独立。
- 清理边界参考有效设备最小 cursor，并设置最大离线窗口。
- 超过最大离线窗口的设备标记为 stale；重新连接时 bootstrap。
- 清理任务按小批次运行，避免长事务锁表。

## 18. Docker 部署

### 18.1 Compose 拓扑

```text
reverse proxy / TLS（用户自选）
        ↓
note-gen-server
        ↓
PostgreSQL
        ↓
blob-data Docker Volume
```

仓库交付：

- 多阶段 `Dockerfile`。
- 非 root 运行镜像。
- `docker-compose.yml`。
- `.env.example`。
- PostgreSQL 与 Blob 持久化 Volume。
- Server 和 PostgreSQL healthcheck。
- 容器启动时迁移策略。
- 备份、恢复和升级文档。

### 18.2 配置

启动配置和秘密来自环境变量或挂载文件，不把秘密提交到仓库。业务运行参数由管理员在 Web 后台持久化管理。启动配置至少包括：

```text
NODE_ENV
DATABASE_URL
PUBLIC_BASE_URL
AUTH_SECRET
SETUP_TOKEN
BLOB_STORAGE_PATH
```

### 18.3 迁移

- Drizzle migration 文件必须进入版本控制。
- 容器启动只能执行向前兼容迁移。
- 破坏性迁移需要独立命令、备份前置检查和明确版本说明。
- Server 启动前检查数据库 schema version；不兼容时拒绝服务而不是带病运行。

### 18.4 备份与恢复

完整备份包含：

- PostgreSQL dump。
- Blob Volume。
- 部署配置，但不应复制明文 secret 到公共位置。

备份必须保证数据库中标记 `ready` 的 Blob 在备份介质中存在。恢复演练应验证：登录、bootstrap、随机抽样 Blob 下载和 ciphertext hash。

## 19. 安全

- 生产环境只允许 HTTPS/WSS；TLS 可由反向代理终止。
- 密码使用 Argon2id，不能可逆保存。
- Refresh token 只保存哈希。
- 所有对象访问同时检查账号与 Workspace 所有权。
- 请求体、batch、WebSocket 消息、Blob 大小和连接数都有上限。
- 登录、注册和上传接口设置速率限制。
- 日志禁止记录 token、密文 payload、wrapped key 和上传内容。
- 数据库账号使用最小权限。
- 文件存储路径完全由服务端生成，不能拼接客户端文件名。
- Blob 下载校验授权，不能依赖不可猜测 URL 作为权限。
- 容器使用非 root 用户和只读根文件系统；仅 Blob 目录可写。

## 20. 可观测性

### 20.1 日志

使用 JSON 结构化日志，字段至少包括：

- request ID。
- account/workspace/device 的不可逆或内部 ID。
- operation ID。
- endpoint、status code 和 duration。
- push/pull 数量与字节数。
- conflict、retry、cursor expired 和 bootstrap 事件。

不得记录内容密文或密钥材料。

### 20.2 健康检查

- `/health/live`：进程存活，不访问依赖。
- `/health/ready`：数据库可用、迁移版本兼容、Blob 后端可读写。

### 20.3 指标

第一版提供 Prometheus 格式指标或结构化统计：

- HTTP 延迟和错误率。
- WebSocket 连接数。
- push/pull 操作数与冲突率。
- change lag：latest sequence 与设备 cursor 差值。
- out-of-date/stale device 数量。
- Blob 上传失败、未完成上传和 GC 数量。
- 数据库连接池与慢查询。

## 21. 性能目标

初始验收目标，不作为无限规模承诺：

- 单个 Workspace 50,000 个逻辑对象时，增量同步不执行全量扫描。
- 单次 Pull 默认 200 条、最大 1,000 条 change。
- 同地域在线文本变更从 Server commit 到 WebSocket 通知 p95 小于 300ms。
- 正常网络下其他设备展示变更的端到端目标 p95 小于 1 秒。
- 重复 operation 的响应不得再次创建 version 或 change。
- 服务重启后所有已 ACK 操作仍可查询并恢复。
- 10,000 条离线变化支持分页恢复，内存占用与总变化量解耦。

## 22. 失败模式与处理

| 失败 | 处理 |
|---|---|
| WebSocket 消息丢失 | 重连或定时 Pull 根据 cursor 补齐 |
| Push 响应丢失 | 使用相同 operation ID 重试并返回原结果 |
| 服务端在事务中崩溃 | PostgreSQL 回滚；客户端重试 |
| Blob 上传中断 | 保留 upload session，分片续传；过期后 GC |
| 对象引用缺失 Blob | 拒绝对象提交，返回 `blob_not_ready` |
| 同一对象并发修改 | 返回 revision conflict，客户端三方合并/Yjs 合并 |
| 设备 cursor 过期 | 返回 `cursor_expired`，执行 bootstrap |
| E2EE 密钥遗失 | 服务端无法恢复；使用恢复密钥或现有设备配对 |
| 外部 Markdown 与 Yjs 并发 | 三方合并或生成冲突版本，不直接覆盖 |
| 数据库可用但 Blob 不可用 | readiness 失败，暂停涉及 Blob 的写操作 |
| 磁盘空间不足 | 拒绝新上传，保留已有数据并产生明确告警 |

## 23. 实施阶段

### 阶段 0：协议与工程基础

- Fastify/TypeScript/Drizzle 项目骨架。
- PostgreSQL migration。
- OpenAPI、错误码、request ID 和结构化日志。
- Dockerfile、Compose、healthcheck。
- 能力协商与协议版本。

验收：空服务可通过 Compose 启动、迁移、健康检查和升级验证。

### 阶段 1：可靠增量同步

- 账号、设备、Workspace。
- object/version/change/operation/cursor 表。
- 幂等 Push、分页 Pull、cursor ACK。
- tombstone 和 bootstrap。
- NoteGen 客户端 outbox/inbox 状态机。

验收：两台客户端经历断网、重复请求和重启后数据一致，无全量扫描。

### 阶段 2：实时通知

- WebSocket 认证、订阅、心跳和重连。
- PostgreSQL NOTIFY 到连接广播。
- 客户端收到通知后立即 Pull。

验收：在线文本变化 p95 小于 1 秒；主动丢弃 WebSocket 消息后仍能恢复。

### 阶段 3：附件

- Blob Storage Adapter。
- Filesystem backend。
- 分片上传、续传、Range 下载、引用校验和 GC。
- 客户端后台上传与按需下载。

验收：大附件中断后续传，重复附件只上传一次，文字同步不被阻塞。

### 阶段 4：历史与冲突

- 版本保留与恢复。
- Markdown 三方合并。
- 各结构化 kind 合并策略。
- 冲突 UI 所需协议字段。

验收：并发编辑无静默覆盖；无法合并时两个版本均可恢复。

### 阶段 5：端到端加密

- Workspace key、wrapped key、恢复密钥和 key version。
- 对象、历史、Yjs、Blob 加密 envelope。
- 新设备配对与密钥轮换。
- 日志和备份泄露审计。

验收：服务端数据库与 Blob 备份中不出现可识别明文；错误密钥不能通过 AEAD 校验。

建议在协议初期就使用 opaque payload 字段，但在阶段 5 完成前不宣称 E2EE 可用。

### 阶段 6：Yjs 活跃文档

- Tiptap/Yjs 本地持久化。
- 加密 update 和 checkpoint 同步。
- update compaction 协议。
- Markdown 物化与外部修改处理。
- Tiptap ↔ Markdown 往返保真测试。

验收：同一用户两台设备同时编辑不同和相同段落，离线重连后内容收敛且 Markdown 可读。

### 阶段 7：运维加固

- 保留策略、stale device、后台清理。
- 备份恢复脚本与演练。
- 限流、配额、故障注入和负载测试。
- S3-compatible adapter。

## 24. 验证策略

项目应建立自动化协议与收敛测试，而不是只测试 HTTP happy path。

### 24.1 必测场景

- 同一 operation 重放 1、10、100 次只产生一个版本。
- Push 已提交但响应丢失。
- Pull 页面应用一半时客户端崩溃。
- WebSocket 断线、漏消息和乱序通知。
- 两设备同时修改不同对象。
- 两设备同时修改同一对象。
- 删除与修改并发。
- 重命名与内容修改并发。
- 设备离线超过 change retention。
- 服务端在 Push 事务各阶段重启。
- Blob 分片重复、缺失、乱序和 hash 不匹配。
- key rotation 期间新旧 key version 并存。
- Yjs updates 重复、乱序和离线合并。
- 外部 Markdown 修改与活跃 Yjs 编辑并发。

### 24.2 收敛测试

使用模型测试随机生成多个设备的 create/update/delete/move/offline/reconnect 序列。所有消息最终送达后，应满足：

- 所有设备对象集合一致。
- 每个对象 revision 和内容一致。
- 已删除对象不会在无新操作时复活。
- operation 重放不改变最终状态。
- 无法自动解决的冲突均有可恢复记录。

## 25. NoteGen 客户端接入

现有 Git/WebDAV/S3 同步不立即删除。新增独立 `NoteGen Server` provider：

1. 抽象统一的本地 change journal 和 outbox，不再由 UI 直接调用提供商。
2. 为文件和结构化记录补稳定 object ID。
3. 首次连接时让用户选择创建远端 Workspace 或从远端 bootstrap。
4. 本地已有数据采用显式 initial upload，不能根据时间戳猜测覆盖方向。
5. 新服务稳定前禁止同时向旧提供商和 NoteGen Server 双写同一 Workspace。
6. 迁移完成后，旧同步配置保留为手动导出/备份选项。

## 26. 协议错误模型

错误响应必须包含稳定机器码：

```ts
interface ApiError {
  code: string
  message: string
  requestId: string
  retryable: boolean
  details?: Record<string, unknown>
}
```

至少定义：

- `protocol_incompatible`
- `unauthorized`
- `device_revoked`
- `workspace_not_found`
- `revision_conflict`
- `cursor_expired`
- `operation_invalid`
- `payload_too_large`
- `blob_not_ready`
- `blob_hash_mismatch`
- `rate_limited`
- `storage_unavailable`

客户端只能依据 `code` 分支，不解析自然语言 message。

## 27. 关键决策与取舍

### 27.1 PostgreSQL 而非直接文件存储

变更日志、事务、唯一幂等约束和历史版本需要数据库语义。文件存储仅承载 Blob，不承担同步索引。

### 27.2 WebSocket 作为提示而非同步通道

这样既获得低延迟，也能在移动设备休眠、代理断开和丢消息时通过 cursor 恢复。

### 27.3 服务端不合并明文

端到端加密与服务端内容合并不可同时成立。客户端承担三方合并与 Yjs 处理，服务端只负责版本和密文传递。

### 27.4 Yjs 不覆盖全部数据

CRDT 适合高频并发文档，不适合替代附件、设置和普通记录的可靠复制协议。限制使用范围可以控制复杂度和存储膨胀。

### 27.5 多账号隔离但不做多人权限

这允许官方托管或家庭部署服务多个独立账号，同时避免 Workspace 成员、ACL 和协作语义进入第一版。

## 28. 开放问题

服务端实现阶段已确定：

1. 对象 ID 使用客户端生成的 UUIDv7；服务端内部 ID 使用 PostgreSQL UUID。
2. API Schema 使用 TypeBox，`/openapi.json` 是 HTTP 接口事实来源。
3. 客户端内容加密采用 XChaCha20-Poly1305 envelope；服务端只验证密文哈希。
4. 密钥封装支持 passphrase、recovery 和 device 三种 envelope；二维码配对属于客户端交互。
5. 默认 change、历史和 tombstone 保留时间均为 90 天，由管理员在 Web 后台调整。
6. 自托管首次注册使用 Setup Token，默认关闭公开注册。
7. 文件系统和 S3-compatible Blob Storage Adapter 均已实现。
8. PostgreSQL `LISTEN/NOTIFY` 已用于跨服务实例实时事件广播。
9. `/v1/capabilities` 返回稳定实例 ID、实例名称、协议能力、服务端时间和实际限制。
10. Blob 创建、状态查询、分片重传和 complete 均支持应用重启后的幂等恢复。

仍属于 NoteGen 客户端接入阶段的决策：

1. Markdown 三方合并库及冲突展示 UX。
2. Tiptap 与 Markdown 的规范化和往返保真规则。
3. Yjs checkpoint 的客户端触发阈值及设备选择策略。

## 29. 参考设计

- CouchDB Replication Protocol：changes feed、checkpoint、连续复制和冲突语义  
  <https://docs.couchdb.org/en/stable/replication/protocol.html>
- Joplin Synchronisation：offline-first 和同步层抽象  
  <https://joplinapp.org/help/dev/spec/sync>
- Joplin Server Delta Sync：基于 delta 的服务端变化读取  
  <https://joplinapp.org/help/dev/spec/server_delta_sync/>
- Yjs Document Updates：幂等、可交换的增量更新与 state vector  
  <https://docs.yjs.dev/api/document-updates>
- Yjs WebSocket Provider：客户端—服务端实时连接模型  
  <https://docs.yjs.dev/ecosystem/connection-provider/y-websocket>
- Automerge：local-first 与离线并发合并理念  
  <https://automerge.org/docs/hello/>
