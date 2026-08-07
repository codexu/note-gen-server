# NoteGen Server Web

NoteGen Server 的账号管理与设备授权页面。该应用使用 Next.js 静态导出，生产环境由 `apps/server` 中的 Fastify 同源托管。

它只负责：

- 注册和登录同步账号。
- 查看和撤销 NoteGen 设备。
- 确认一次性设备授权。
- 显示自托管或官方托管服务器身份。

它不包含 Markdown 编辑、AI 或多人协作功能。

## 本地开发

```bash
pnpm dev:web
```

默认连接 `http://127.0.0.1:3789`，并监听所有本地网络接口的 `3790` 端口。本机可通过 `http://127.0.0.1:3790` 访问，同一局域网设备可通过 `http://<本机局域网 IP>:3790` 访问。

## 添加组件

```bash
pnpm dlx shadcn@latest add @shadcn/<component> --cwd apps/web
```
