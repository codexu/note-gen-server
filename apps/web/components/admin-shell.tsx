"use client"

import type { ReactNode } from "react"
import {
  BookOpenIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  FlaskConicalIcon,
  GaugeIcon,
  LayoutDashboardIcon,
  LinkIcon,
  KeyRoundIcon,
  MonitorSmartphoneIcon,
  MailIcon,
  LogOutIcon,
  RefreshCwIcon,
  UsersIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"
import { ThemeToggle } from "@/components/theme-toggle"
import {
  NOTEGEN_DOCS_URL,
  NOTEGEN_SITE_URL,
  GitHubMark,
  NoteGenMark,
  NoteGenWordmark,
} from "@/components/notegen-brand"
import type { Account, ServerCapabilities } from "@/lib/api"
import { SiteFooter } from "@/components/site-chrome"

export type AdminSection = "overview" | "workspaces" | "devices" | "connect" | "security" | "instance" | "operations" | "admin" | "experiments"

const sectionDetails: Record<AdminSection, { title: string; description: string }> = {
  overview: { title: "仪表盘", description: "查看同步服务、存储和最近活动。" },
  workspaces: { title: "工作区管理", description: "检查默认与历史工作区，并清理测试数据。" },
  devices: { title: "设备管理", description: "查看关联设备并撤销不再使用的会话。" },
  connect: { title: "关联新设备", description: "输入客户端验证码或扫描二维码，安全地关联新设备。" },
  security: { title: "账户安全", description: "修改账号密码并更新登录凭据。" },
  instance: { title: "实例状态", description: "查看服务健康、存储、任务以及需要处理的事项。" },
  operations: { title: "访问与配置", description: "管理注册、邀请、运行参数和邮件投递。" },
  admin: { title: "账号与数据", description: "管理服务器账号、全局同步数据和操作审计。" },
  experiments: { title: "实验功能", description: "检查尚未稳定开放的能力、状态和启用条件。" },
}

export function AdminShell({
  account,
  capabilities,
  section,
  workspaceCount,
  deviceCount,
  busy,
  onSectionChange,
  onLogout,
  onRefresh,
  children,
}: {
  account: Account
  capabilities: ServerCapabilities | null
  section: AdminSection
  workspaceCount: number
  deviceCount: number
  busy: boolean
  onSectionChange: (section: AdminSection) => void
  onLogout: () => void
  onRefresh: () => void
  children: ReactNode
}) {
  const details = sectionDetails[section]
  type NavigationItem = { section: AdminSection; label: string; icon: typeof LayoutDashboardIcon; count?: number }
  const personalNavigation: NavigationItem[] = [
    { section: "overview" as const, label: "仪表盘", icon: LayoutDashboardIcon },
    { section: "connect" as const, label: "关联新设备", icon: LinkIcon },
    { section: "devices" as const, label: "设备管理", icon: MonitorSmartphoneIcon, count: deviceCount },
    { section: "workspaces" as const, label: "工作区管理", icon: DatabaseIcon, count: workspaceCount },
    { section: "security" as const, label: "账户安全", icon: KeyRoundIcon },
  ]
  const instanceNavigation: NavigationItem[] = account.isAdmin ? [
    { section: "instance" as const, label: "实例状态", icon: GaugeIcon },
    { section: "admin" as const, label: "账号与数据", icon: UsersIcon },
    { section: "operations" as const, label: "访问与配置", icon: MailIcon },
  ] : []
  const experimentNavigation: NavigationItem[] = account.isAdmin ? [
    { section: "experiments" as const, label: "实验功能", icon: FlaskConicalIcon },
  ] : []

  function renderNavigation(items: NavigationItem[]) {
    return items.map((item) => {
      const Icon = item.icon
      return (
        <SidebarMenuItem key={item.section}>
          <SidebarMenuButton
            isActive={section === item.section}
            tooltip={item.label}
            onClick={() => onSectionChange(item.section)}
          >
            <Icon />
            <span>{item.label}</span>
          </SidebarMenuButton>
          {typeof item.count === "number" ? (
            <SidebarMenuBadge>{item.count}</SidebarMenuBadge>
          ) : null}
        </SidebarMenuItem>
      )
    })
  }

  return (
    <SidebarProvider>
      <Sidebar variant="inset" collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                tooltip="访问 NoteGen 官网"
                render={<a href={NOTEGEN_SITE_URL} target="_blank" rel="noreferrer" />}
              >
                <NoteGenMark />
                <span className="flex min-w-0 flex-col">
                  <NoteGenWordmark className="truncate" />
                  <span className="truncate text-xs text-muted-foreground">
                    {capabilities?.serverName ?? "同步服务"}
                  </span>
                </span>
                <ExternalLinkIcon className="ml-auto text-muted-foreground" />
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>我的同步</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>{renderNavigation(personalNavigation)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {account.isAdmin ? <SidebarGroup><SidebarGroupLabel>服务器管理</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{renderNavigation(instanceNavigation)}</SidebarMenu></SidebarGroupContent></SidebarGroup> : null}
          {account.isAdmin ? <SidebarGroup><SidebarGroupLabel>实验功能</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{renderNavigation(experimentNavigation)}</SidebarMenu></SidebarGroupContent></SidebarGroup> : null}
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger render={<SidebarMenuButton size="lg" tooltip={account.login} />}>
                  <span className="flex size-8 items-center justify-center rounded-lg bg-muted font-medium">
                    {account.login.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{account.login}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {account.isAdmin ? "系统管理员" : "已登录"}
                    </span>
                  </span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="right">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>{account.login}</DropdownMenuLabel>
                    <DropdownMenuItem onClick={() => onSectionChange("security")}>
                      <KeyRoundIcon />
                      账户安全
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onSectionChange("connect")}>
                      <LinkIcon />
                      关联新设备
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuItem variant="destructive" disabled={busy} onClick={onLogout}>
                      {busy ? <Spinner /> : <LogOutIcon />}
                      退出登录
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset className="bg-background">
        <header className="sticky top-0 z-30 flex min-h-16 shrink-0 items-center justify-between gap-3 border-b bg-background/90 px-4 backdrop-blur-md md:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <SidebarTrigger />
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold tracking-tight">{details.title}</h1>
              <p className="hidden truncate text-sm text-muted-foreground sm:block">{details.description}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              className="hidden sm:inline-flex"
              variant="ghost"
              size="sm"
              nativeButton={false}
              render={<a href={NOTEGEN_SITE_URL} target="_blank" rel="noreferrer" />}
            >
              官网
              <ExternalLinkIcon data-icon="inline-end" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="查看 NoteGen 文档"
              title="查看 NoteGen 文档"
              nativeButton={false}
              render={<a href={NOTEGEN_DOCS_URL} target="_blank" rel="noreferrer" />}
            >
              <BookOpenIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="查看 NoteGen GitHub"
              title="查看 NoteGen GitHub"
              nativeButton={false}
              render={<a href="https://github.com/codexu/note-gen" target="_blank" rel="noreferrer" />}
            >
              <GitHubMark />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              disabled={busy}
              aria-label="刷新当前数据"
              title="刷新当前数据"
              onClick={onRefresh}
            >
              {busy ? <Spinner /> : <RefreshCwIcon />}
            </Button>
            <ThemeToggle />
          </div>
        </header>
        <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 p-4 md:gap-6 md:p-6">{children}</div>
        <SiteFooter />
      </SidebarInset>
    </SidebarProvider>
  )
}
