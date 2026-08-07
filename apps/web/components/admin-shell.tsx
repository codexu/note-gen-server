"use client"

import type { ReactNode } from "react"
import Link from "next/link"
import {
  DatabaseIcon,
  FileSearchIcon,
  LayoutDashboardIcon,
  LaptopIcon,
  KeyRoundIcon,
  LogOutIcon,
  ServerIcon,
  UsersIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import type { Account, ServerCapabilities } from "@/lib/api"

export type AdminSection = "overview" | "content" | "workspaces" | "devices" | "security" | "admin"

const sectionDetails: Record<AdminSection, { title: string; description: string }> = {
  overview: { title: "仪表盘", description: "查看同步服务、存储和最近活动。" },
  content: { title: "内容管理", description: "确认已保存的笔记、记录、绘图和配置。" },
  workspaces: { title: "工作区管理", description: "检查默认与历史工作区，并清理测试数据。" },
  devices: { title: "设备管理", description: "查看关联设备并撤销不再使用的会话。" },
  security: { title: "账户安全", description: "修改账号密码并更新登录凭据。" },
  admin: { title: "系统管理", description: "管理服务器账号、全局数据概览和后台操作审计。" },
}

export function AdminShell({
  account,
  capabilities,
  section,
  objectCount,
  workspaceCount,
  deviceCount,
  busy,
  onSectionChange,
  onLogout,
  children,
}: {
  account: Account
  capabilities: ServerCapabilities | null
  section: AdminSection
  objectCount: number
  workspaceCount: number
  deviceCount: number
  busy: boolean
  onSectionChange: (section: AdminSection) => void
  onLogout: () => void
  children: ReactNode
}) {
  const details = sectionDetails[section]
  const navigation = [
    { section: "overview" as const, label: "仪表盘", icon: LayoutDashboardIcon },
    { section: "content" as const, label: "内容管理", icon: FileSearchIcon, count: objectCount },
    { section: "workspaces" as const, label: "工作区管理", icon: DatabaseIcon, count: workspaceCount },
    { section: "devices" as const, label: "设备管理", icon: LaptopIcon, count: deviceCount },
    { section: "security" as const, label: "账户安全", icon: KeyRoundIcon },
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
          <SidebarGroup>
            <SidebarGroupLabel>快捷入口</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton render={<Link href="/connect/" />} tooltip="关联新设备">
                    <LaptopIcon />
                    <span>关联新设备</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" tooltip={account.login}>
                <span className="flex size-8 items-center justify-center rounded-lg bg-muted font-medium">
                  {account.login.slice(0, 1).toUpperCase()}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{account.login}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {account.isAdmin ? "系统管理员" : "已登录"}
                  </span>
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onLogout}>
            {busy ? <Spinner data-icon="inline-start" /> : <LogOutIcon data-icon="inline-start" />}
            退出登录
          </Button>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 px-4 md:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <SidebarTrigger />
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold">{details.title}</h1>
              <p className="hidden truncate text-sm text-muted-foreground sm:block">{details.description}</p>
            </div>
          </div>
          <Badge variant="secondary">
            {capabilities?.deploymentMode === "hosted" ? "官方托管" : "自托管"}
          </Badge>
        </header>
        <Separator />
        <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  )
}
