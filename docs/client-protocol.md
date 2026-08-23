# NoteGen 客户端接入协议

本文说明 NoteGen 客户端接入 Sync Server 时必须遵守的可靠性与安全约束。冻结的 v1 总览见 [protocol-v1.md](protocol-v1.md)，HTTP 请求和字段的最终定义以服务端 `/openapi.json` 为准。本文中与 v1 总览冲突的早期草案描述均以 v1 为准。

## 本地状态

每个 Workspace 至少维护：

```text
sync_cursor
object_id ↔ 本地文件/数据库记录映射
object_revision
durable_outbox
durable_inbox
workspace_key_versions
```

本地业务修改、对象 revision 记录和 outbox 写入必须属于同一个本地事务。远端 change 的应用、inbox 完成标记和 cursor 推进也必须属于同一个本地事务。

## 登录与设备

1. 每次安装生成并持久化一个 UUID device ID 和 X25519 设备密钥对；device ID 应与密钥材料分开保存，以便密钥丢失后仍能恢复同一设备身份。登录时上传 Base64URL 公钥。
2. Access Token 只保存在内存或安全系统存储中。
3. Refresh Token 必须使用系统安全存储；每次刷新都会轮换。
4. 收到 `401` 时最多刷新并重试一次，不能无限循环。
5. 设备被撤销后清除该服务器的 token，但不删除本地笔记。
6. 保存 `/v1/capabilities` 返回的 `instanceId`；同一 URL 的实例身份变化时必须停止自动同步。
7. device ID 属于安装身份。同一账号重新完成浏览器授权或密码认证后，可以用新的设备公钥恢复已撤销设备或替换丢失的密钥；服务端覆盖公钥并撤销该设备的旧 Refresh Token，不创建重复设备记录。不同账号不能认领同一 device ID。

推荐使用浏览器设备授权，账号密码直接登录作为备用方式：

1. 客户端 `POST /v1/device-authorizations`，提交设备身份并取得 `deviceCode`、`userCode` 和验证地址。
2. 打开 `verificationUriComplete`；用户在 Web 中注册或登录，并确认设备名称与平台。
3. 客户端按响应中的 `interval` 轮询 `POST /v1/device-authorizations/token`。
4. `authorization_pending` 表示继续等待；成功后保存返回的设备 Refresh Token。
5. 验证码 5 分钟过期，只能消费一次。客户端不能记录或上传 Web Session Cookie。
6. 用户取消连接时调用 `POST /v1/device-authorizations/cancel`，使尚未批准的设备码立即失效。
7. 换取设备会话后调用 `GET /v1/account` 获取规范化账号名，不从浏览器页面或 URL 传递账号身份。

Web Session 与 NoteGen Device Session 是两套独立凭据。浏览器使用 HttpOnly Cookie 和 CSRF Token；NoteGen 使用 Bearer Access Token 和按设备轮换的 Refresh Token。

## 默认工作区

每个账号的 NoteGen 默认本地工作区必须使用固定的 `notegen.default-library.v1` 幂等键创建或查询云端工作区。不同设备不得根据本地绑定情况各自创建默认云端工作区。升级前若已有多个工作区且尚无该幂等键，服务端选择最早创建的有效工作区作为账号级默认；各设备保留本地文件并重新绑定、扫描和合并，不自动删除其余远端工作区。

## 端到端加密

推荐 envelope：

```text
version: 1
algorithm: XChaCha20-Poly1305
keyVersion: Workspace Key version
nonce: 24 random bytes
associatedData:
  workspaceId, objectId, kind, keyVersion
ciphertext: encrypted payload + authentication tag
```

密文和二进制字段使用 Base64URL。`ciphertextHash` 是密文字节的 SHA-256 Base64URL。默认零配置模式通过 `managed` envelope 让服务端托管同步密钥；只有用户主动启用高级 E2EE 后，服务端才不再持有可解密的 Workspace Key。

登录密码不能复用为同步加密口令：登录密码会通过 TLS 发送给服务端，复用将破坏“服务端无法解密”的威胁模型。

Associated Data 只包含不会因重试或历史恢复而改变的对象身份字段。revision 与 baseRevision 由服务端并发控制保护，不能加入 AEAD，否则服务端复用历史密文创建恢复版本时客户端将无法解密。

普通客户端优先调用 `POST /v1/workspaces/default` 获取账号内部默认同步空间：首次调用提交随机 256-bit managed key，后续调用返回同一空间。高级 E2EE 则用 passphrase 和 recovery envelope 原子替换 managed envelope；恢复密钥只向用户展示一次，不上传明文。

- Passphrase envelope：Argon2id，至少 64 MiB memory、3 iterations、parallelism 1，并使用独立随机 salt。
- Recovery envelope：使用客户端生成的 256-bit 恢复密钥包装 Workspace Key。
- Device envelope：X25519 临时密钥交换，经 HKDF-SHA256 派生包装密钥，再用 XChaCha20-Poly1305 包装；载荷携带临时公钥和 nonce。
- 每种 envelope 都带独立格式版本；客户端遇到未知版本必须停止解锁，不能降级猜测。

## 普通同步循环

```text
启动/网络恢复
  → POST sync/session
  → cursor 过期则 bootstrap
  → Push durable outbox
  → Pull cursor 之后的 changes
  → ACK cursor
  → 建立 WebSocket
  → 收到 workspace.changed 后立即 Pull
```

WebSocket 连接后第一条消息必须是：

```json
{
  "type": "authenticate",
  "accessToken": "...",
  "workspaceIds": ["..."],
  "expectedSyncEpoch": "..."
}
```

WebSocket 消息只表示状态可能变化。`workspace.changed` 触发 Pull，`workspace.keys-changed` 触发重新获取 envelope，`workspace.state-changed` 与 `account.workspaces-changed` 触发刷新 Workspace 列表。任何消息都不能直接推进 cursor，也不能假设每条 change 都会收到通知。

文本光标的 `presence.update` 需携带 `coordinateSpace: "markdown" | "prosemirror"`，接收端只在相同坐标空间渲染；Canvas 使用 `coordinateSpace: "canvas"`。Canvas 拖拽期间可以在 `presence.update.canvas.nodes` 中发送最多 100 个 `{ id, x, y }` 临时位置；拖拽结束后的最终位置仍须使用 durable Yjs command 持久化。

## Push 与幂等

- 每次操作生成永久 operation UUID。
- 超时或连接中断后原样重试，不能生成新 operation ID。
- 已发送但未 ACK 的 envelope 不可被后续本地编辑覆盖。
- 同一对象尚未发送的连续操作可以在本地合并。
- 服务端返回 `duplicate: true` 仍表示操作已可靠提交。
- 相同 operation ID 只能对应完全相同的请求；`operation_id_reused` 表示客户端 outbox 已损坏。
- Batch 按顺序逐项提交并返回 `applied`、`conflict` 或 `rejected` 结果；单个业务错误不阻塞后续操作。基础设施错误导致请求中断时，前面的操作可能已经成功，客户端原样重试整个 Batch 并依靠 operation ID 去重。
- 服务端验证 Base64URL 密文、密文字节 SHA-256 和单对象大小。

收到 `revision_conflict` 时：

1. 解密共同 Base、本地 Local 和服务端 Remote。
2. Markdown 执行三方合并。
3. 合并成功后以服务端当前 revision 为 base 创建新 operation。
4. 无法安全合并时保存冲突副本，并保留 Local 与 Remote 历史。
5. 禁止 last-write-wins 静默覆盖。

## Pull 与 cursor

- 严格按 sequence 升序应用。
- 一页全部持久化成功后才保存 `nextCursor`。
- change 可被重复接收，应用过程必须幂等。
- ACK 只用于服务端运维；本地持久化 cursor 才是恢复依据。
- `cursor_expired` 必须进入 bootstrap，不能改成从零盲目 Pull。
- 客户端只有在事件已经写入本地 inbox 且全部成功应用后，才调用
  `POST /v1/workspaces/:workspaceId/sync/ack` 提交 `through`。服务端不会把
  HTTP 响应已发送视为持久确认。
- 当前服务端声明 `syncEpochFencing` 和 `durableCursorAcknowledgement` 为必需
  同步特性；所有同步请求必须携带最近一次显式接受的 `expectedSyncEpoch`。

## Bootstrap

第一页不传 `bootstrapId`。服务端返回固定 `snapshotSequence` 和短期 `bootstrapId`。后续每页必须传回该 session：

```text
GET .../sync/bootstrap?afterObjectId=<id>&bootstrapId=<uuid>&expectedSyncEpoch=<uuid>
```

完成所有页后：

1. 删除本地存在、但 manifest 中不存在的远端对象映射。
2. 将本地 cursor 设置为 `snapshotSequence`。
3. 立即 Pull `snapshotSequence` 之后的变化。

Session 过期时丢弃 staging 中未完成的 manifest 并从第一页重新开始，不能把不同快照的页面拼接在一起。服务端在 session 存活期间保护该快照依赖的历史版本不被清理。

不能为每页重新选择快照，否则分页期间的并发修改可能被遗漏。

## Blob

1. 客户端先加密完整附件。
2. `ciphertextHash = SHA-256(encryptedBytes)`。
3. v1 使用密文字节的 SHA-256 Base64URL 作为 `blobId`；重试必须复用同一份 encrypted bytes。
4. 创建上传会话并按服务端返回的 `partBytes` 分片。
5. 创建结果为 resumed 时，读取 `uploadedParts`；也可随时 GET 上传会话恢复进度。
6. 每个 part 可使用相同 part number 重传；非最后一片必须正好等于 `partBytes`。
7. complete 可使用同一 upload ID 重试；成功后才能在对象 `blobRefs` 中引用。
8. 下载支持 Range；完成后必须重新验证 ciphertext hash，再执行 AEAD 解密。

上传状态中的 `completingAt` 非空表示服务端正在合并并校验分片。并发 complete 可能返回
`blob_upload_completing`（`retryable=true`）；客户端应保留 upload ID，退避后查询状态并原样重试。
服务端会接管超过完成租约的任务，因此进程在对象存储完成后、数据库提交前退出也不要求重新上传。

文字对象 Push 不等待非必要附件下载，附件按需后台获取。

## Yjs

- 每个 update 具有独立 `updateId`，通过 durable `append-update` command 写入文档流。
- checkpoint 通过 durable `commit-checkpoint` command 写入。
- update 在客户端加密后通过可靠 HTTP command 传输；WebSocket 不承载 update payload。
- 客户端解密后，Yjs update 可以重复、乱序应用。
- 服务端不解析 Awareness，不保存多人光标，也不执行 CRDT 合并。
- 客户端生成 checkpoint 后仍应保留本地旧 update，直到 checkpoint 和对应 Markdown 快照都获得服务端 ACK。
- checkpoint 和 Markdown 快照确认后，客户端用普通 delete operation 删除已经覆盖的远端 update 对象。

## 配置同步

- 使用 `setting` kind 和按设置键生成的确定性 UUIDv5 object ID。
- SyncProfile、凭据、密钥、cursor、本地路径、硬件选择和平台状态永不进入同步。
- 普通设置按逻辑时钟确定性收敛；敏感设置默认不同步。
- 远端设置在数据同步稳定后应用，不能自动改变当前 SyncProfile。

完整分类和交互要求见 [NoteGen 服务端同步接入指南](notegen-integration.md)。

## 错误处理

| code | 客户端动作 |
|---|---|
| `unauthorized` | 刷新 token 后重试一次 |
| `device_revoked` | 清除 token，要求重新登录 |
| `authorization_pending` | 按服务端 interval 继续轮询，直到授权、拒绝或过期 |
| `authorization_denied` | 停止轮询并提示用户重新发起关联 |
| `authorization_expired` | 丢弃 device code 并重新发起关联 |
| `operation_id_reused` | 停止该 outbox 项并报告本地一致性错误 |
| `ciphertext_hash_mismatch` | 重新生成加密载荷 |
| `revision_conflict` | 三方合并或冲突副本 |
| `cursor_expired` | 固定快照 bootstrap |
| `blob_not_ready` | 先完成附件上传，再重试原 operation ID 前生成的新操作 |
| `blob_identity_conflict` | 重新生成 Blob ID，不覆盖已有内容 |
| `blob_upload_completing` | 保留上传会话，短暂退避后查询状态并重试 complete |
| `rate_limited` | 遵循退避时间并增加随机抖动 |
| `storage_unavailable` | 保留 outbox，后台指数退避 |
| `protocol_incompatible` | 停止同步并提示升级客户端/服务端 |

网络错误、`429` 和 `5xx` 使用指数退避；任何重试都必须保留 operation ID。
