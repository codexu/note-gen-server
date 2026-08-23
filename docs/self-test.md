# NoteGen Sync Server 个人验收用例

这份用例供服务端部署者在 NoteGen 内完成连接验收，也保留命令行诊断脚本用于排除客户端以外的问题。

## 在 NoteGen 中连接

使用包含“NoteGen 同步服务器”的 NoteGen 构建：

1. 启动 `note-gen-server`，确认 `/health/ready` 返回 200。
2. 打开 NoteGen → 设置 → 同步 → NoteGen 同步服务器。
3. 本机部署填写 `http://127.0.0.1:3789`；远程部署填写实际 HTTPS 域名。
4. 选择“注册”或“登录”。实例关闭注册时，由管理员切换为“仅邀请”并创建一次性邀请链接。
5. 登录密码至少 8 个字符。它只负责账号认证，并继续支持更长密码。
6. 登录完成后不需要选择 Workspace 或输入同步口令；NoteGen 自动绑定当前笔记目录并将 NoteGen Server 设为主要同步方式。
7. 确认页面显示“实时同步已启用”，并且当前笔记目录正确；页面不应出现上传、下载或立即同步按钮。
8. 新建或修改一个 Markdown，等待状态由“正在同步”回到“已同步”。新增、修改和删除都应自动触发。
9. 在第二台设备或另一份空白 NoteGen 数据目录中登录同一账号；远端 Markdown 应自动恢复到该设备当前绑定的笔记目录。
10. 分别验证断网编辑后重连续传，以及两台设备同时修改同一路径时保留 `.conflict-*` 副本。未修改文件不应重复制造新版本。
11. 在同一台 NoteGen 上断开后重新关联，Web“已关联设备”数量不应增加，原设备的最近活动时间应更新。
12. Web“同步概览”“同步内容”和“最近同步活动”应显示对象统计，但不应显示文件名或笔记正文。

默认模式不要求同步加密口令。高级端到端加密模式下，同步口令必须与登录密码不同；启用后请立即保存只展示一次的恢复密钥。Markdown 新增、修改、删除、空设备恢复、断线续传和冲突副本均由后台同步链路处理。

如果 NoteGen 报服务器实例发生变化，不要反复清除配置绕过检查。先确认数据库是否被重置、域名是否指向另一套部署，或恢复时是否使用了错误备份。

## 命令行诊断

当 NoteGen 连接失败、需要判断问题在客户端还是服务器时，再使用下面的一键脚本。

## 验收范围

脚本会依次验证：

1. `/health/ready` 和协议能力协商。
2. 注册测试账号，并登录第二台模拟设备。
3. 创建带 passphrase/recovery envelope 的协议兼容测试 Workspace。
4. 首次 Push，以及同一 operationId 重试的幂等性。
5. 第二台设备通过 Bootstrap 获得笔记。
6. WebSocket 收到 `workspace.changed` 实时通知。
7. 两台设备基于同一 revision 离线编辑时，后提交者得到 conflict，而不是覆盖数据。
8. `editor.fontSize` 配置对象同步，以及增量 Pull/cursor 收敛。

脚本使用协议形状正确的模拟密文，不验证 NoteGen 客户端的 AEAD、系统安全存储、Markdown 三方合并或界面交互。这些必须在 NoteGen 客户端接入后单独验收。

## 前置条件

- Node.js 22 或更高版本。
- 已在项目目录执行 `pnpm install`。
- 服务端已启动，且 `/health/ready` 返回 200。
- 管理员已在 Web 后台临时启用公开注册；脚本结束后应恢复为“仅邀请”或“关闭”。

本地 PostgreSQL 部署可以先执行：

```bash
createuser notegen
createdb -O notegen notegen
cp .env.example .env
# 编辑 .env，至少设置数据库密码、DATABASE_URL、AUTH_SECRET 和 PUBLIC_BASE_URL
pnpm install
pnpm dev
curl --fail http://127.0.0.1:3789/health/ready
```

## 本机使用

在 Web 后台临时启用公开注册后运行：

```bash
pnpm test:self
```

全部通过时，最后会显示：

```text
✅ 全部验收通过
```

默认情况下，脚本最后会停用测试账号，使其进入服务端保留期清理队列。它不会删除你的既有账号、Workspace 或笔记。

## 测试远程部署

把地址改成实际的 HTTPS 域名：

```bash
SELF_TEST_BASE_URL='https://sync.example.com' \
pnpm test:self
```

这也会验证反向代理的 HTTPS API 和 WSS WebSocket 转发。验收结束后立即恢复原注册策略。

## 保留测试数据

需要登录测试账号、手工检查 Workspace 时：

```bash
SELF_TEST_KEEP_DATA=true \
pnpm test:self
```

脚本成功后会打印随机生成的登录名和固定测试密码。检查完成后，应通过 API 或未来的 NoteGen 账号界面删除该测试账号。

## 失败处理

| 现象 | 检查项 |
|---|---|
| `fetch failed` | 地址、端口、防火墙、HTTPS 证书和服务进程状态 |
| 自动验收提示需启用公开注册 | 在 Web 后台临时将注册策略改为“公开”，完成后恢复原策略 |
| `/health/ready` 返回 503 | PostgreSQL、Blob 目录/S3 和 migration 日志 |
| WebSocket 超时 | 反向代理是否支持 Upgrade，是否对事件接口启用了缓冲 |
| `instanceId` 与客户端记录不一致 | 数据库是否被重置、恢复错备份或指向了另一套部署 |

查看本地服务日志：

```bash
pnpm dev:server
```

测试失败时，脚本会保留已经产生的数据，方便排查。测试账号名称以 `self-test-` 开头，可在确认问题后清理。

## 相关文档

- [本地运行与运维](operations.md)
- [NoteGen 客户端接入协议](client-protocol.md)
- [NoteGen 接入与配置同步体验](notegen-integration.md)
- [公共测试实例上线清单](production-checklist.md)
