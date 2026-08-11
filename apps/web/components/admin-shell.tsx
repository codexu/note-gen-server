"use client"

import type { ReactNode } from "react"
import {
  DatabaseIcon,
  LayoutDashboardIcon,
  LaptopIcon,
  KeyRoundIcon,
  LifeBuoyIcon,
  MailIcon,
  LogOutIcon,
  RefreshCwIcon,
  ServerIcon,
  UsersIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
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
import { Separator } from "@/components/ui/separator"
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
import type { Account, ServerCapabilities } from "@/lib/api"

export type AdminSection = "overview" | "services" | "workspaces" | "devices" | "connect" | "security" | "operations" | "admin"

const sectionDetails: Record<AdminSection, { title: string; description: string }> = {
  overview: { title: "仪表盘", description: "查看同步服务、存储和最近活动。" },
  services: { title: "账号服务", description: "管理权益、政策、数据请求与内部测试支持工单。" },
  workspaces: { title: "工作区管理", description: "检查默认与历史工作区，并清理测试数据。" },
  devices: { title: "设备管理", description: "查看关联设备并撤销不再使用的会话。" },
  connect: { title: "关联新设备", description: "输入客户端验证码或扫描二维码，安全地关联新设备。" },
  security: { title: "账户安全", description: "修改账号密码并更新登录凭据。" },
  operations: { title: "实例运维", description: "管理自托管邀请和 SMTP 内部测试状态。" },
  admin: { title: "系统管理", description: "管理服务器账号、全局数据概览和后台操作审计。" },
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
  const navigation = [
    { section: "overview" as const, label: "仪表盘", icon: LayoutDashboardIcon },
    { section: "services" as const, label: "账号服务", icon: LifeBuoyIcon },
    { section: "workspaces" as const, label: "工作区管理", icon: DatabaseIcon, count: workspaceCount },
    { section: "devices" as const, label: "设备管理", icon: LaptopIcon, count: deviceCount },
    { section: "connect" as const, label: "关联新设备", icon: LaptopIcon },
    { section: "security" as const, label: "账户安全", icon: KeyRoundIcon },
    ...(account.isAdmin ? [{ section: "operations" as const, label: "实例运维", icon: MailIcon }] : []),
    ...(account.isAdmin ? [{ section: "admin" as const, label: "系统管理", icon: UsersIcon }] : []),
  ]

  return (
    <SidebarProvider>
      <Sidebar variant="inset" collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" tooltip={capabilities?.serverName ?? "NoteGen 管理后台"}>
                <span className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <ServerIcon />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{capabilities?.serverName ?? "NoteGen"}</span>
                  <span className="truncate text-xs text-muted-foreground">同步管理后台</span>
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>管理</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {navigation.map((item) => {
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
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
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
                      <LaptopIcon />
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

      <SidebarInset className="bg-background/70">
        <header className="flex min-h-16 shrink-0 items-center justify-between gap-3 px-4 md:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <SidebarTrigger />
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold">{details.title}</h1>
              <p className="hidden truncate text-sm text-muted-foreground sm:block">{details.description}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {capabilities ? (
              <>
                <Badge variant="secondary">
                  {capabilities.deploymentMode === "hosted" ? "官方托管" : "自托管"}
                </Badge>
                <Badge variant="outline">
                  {capabilities.registrationMode === "open" ? "开放注册" : "关闭注册"}
                </Badge>
              </>
            ) : null}
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
        <Separator />
        <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 p-4 md:p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  )
}
