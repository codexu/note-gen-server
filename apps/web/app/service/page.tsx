import type { Metadata } from "next"
import Link from "next/link"
import {
  DatabaseBackupIcon,
  HardDriveIcon,
  MailIcon,
  ServerIcon,
  ShieldCheckIcon,
  UserRoundCogIcon,
} from "lucide-react"

import { NOTEGEN_SITE_URL } from "@/components/notegen-brand"
import { PublicSiteShell } from "@/components/site-chrome"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

export const metadata: Metadata = {
  title: "服务说明 · NoteGen Sync",
  description: "NoteGen 免费独立同步实例的服务范围、数据边界与使用须知",
}

export default function ServicePage() {
  return (
    <PublicSiteShell>
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-5 py-10 md:px-8 md:py-14 xl:py-16">
      <section className="flex max-w-3xl flex-col gap-5 py-6 md:py-10">
        <Badge className="w-fit" variant="secondary">免费 · 独立实例</Badge>
        <h1 className="text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">服务说明与数据边界</h1>
        <p className="text-base leading-7 text-muted-foreground sm:text-lg">
          NoteGen Sync 不区分商业托管版与社区部署版。官方公共测试服务和自行部署实例使用同一套开放源代码、账号体系和管理能力。
        </p>
        <div className="flex flex-wrap gap-2">
          <Button nativeButton={false} render={<Link href="/" />}>返回登录</Button>
          <Button variant="outline" nativeButton={false} render={<a href={`${NOTEGEN_SITE_URL}/cn/download`} target="_blank" rel="noreferrer" />}>下载 NoteGen</Button>
        </div>
      </section>

      <Alert>
        <ShieldCheckIcon />
        <AlertTitle>公共测试服务不是云备份承诺</AlertTitle>
        <AlertDescription>
          服务免费提供，不包含商业 SLA。请始终保留本地数据和必要备份；实例可能因维护、资源限制或滥用处理调整开放范围与保留周期。
        </AlertDescription>
      </Alert>

      <section className="grid gap-4 md:grid-cols-2">
        <BoundaryCard icon={ServerIcon} title="一种运行方式" description="官方实例与自行部署实例使用相同程序；不加载订阅、计费、Staff 运营后台或商业客服系统。" />
        <BoundaryCard icon={UserRoundCogIcon} title="实例管理员负责" description="管理员决定关闭、邀请或公开注册，并负责账号处理、安全上限、运行监控和数据保留配置。" />
        <BoundaryCard icon={MailIcon} title="邮件完全可选" description="SMTP 默认关闭。未配置邮件时，账号密码、设备授权和管理员手动复制的一次性邀请链接仍可使用。" />
        <BoundaryCard icon={DatabaseBackupIcon} title="备份属于部署责任" description="PostgreSQL 和 Blob 数据必须配套备份并定期恢复验证；公共测试实例不应成为任何用户的唯一数据副本。" />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>实例会处理哪些数据</CardTitle>
          <CardDescription>实际保留周期由实例配置和管理员维护策略决定。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm leading-6 text-muted-foreground">
          <p>服务会保存账号标识、密码哈希、设备与浏览器会话、同步协议元数据、加密后的同步对象与附件，以及保障安全和排查故障所需的有限日志。</p>
          <Separator />
          <p>默认托管密钥模式以跨设备零配置为目标，服务器在技术上具备恢复内容密钥的能力；启用高级端到端加密后，服务器只保存加密载荷和密钥封装，用户必须自行保管同步口令或恢复密钥。</p>
          <Separator />
          <p>管理员可以停用账号并执行实例提供的删除流程。由于保留期和备份轮换，数据从所有副本中消失可能晚于账号停止使用的时间。</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><HardDriveIcon />使用前请确认</CardTitle>
          <CardDescription>无论使用公共测试实例还是自行部署，都建议完成以下准备。</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-2">
            <li>保留 NoteGen 本地数据，不把服务器当作唯一副本。</li>
            <li>为管理员账号设置独立强密码并启用 TOTP。</li>
            <li>自行部署时定期备份数据库和附件存储。</li>
            <li>公开注册前确认存储容量、限流与滥用处理方式。</li>
          </ul>
        </CardContent>
      </Card>

      <aside className="mt-auto flex flex-col justify-between gap-3 rounded-xl border bg-muted/30 p-4 text-xs text-muted-foreground sm:flex-row">
        <span>NoteGen Sync · 免费独立同步实例</span>
        <span>继续使用即表示你理解当前实例的测试性质与数据边界。</span>
      </aside>
    </main>
    </PublicSiteShell>
  )
}

function BoundaryCard({ icon: Icon, title, description }: {
  icon: typeof ServerIcon
  title: string
  description: string
}) {
  return (
    <Card>
      <CardHeader>
        <span className="flex size-10 items-center justify-center rounded-xl bg-secondary text-secondary-foreground"><Icon /></span>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
    </Card>
  )
}
