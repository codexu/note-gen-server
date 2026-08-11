"use client"

import type { ReactNode } from "react"
import {
  BadgeDollarSignIcon,
  Building2Icon,
  ClipboardCheckIcon,
  HeadsetIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  UsersIcon,
} from "lucide-react"

import { LanguageToggle } from "@/components/language-toggle"
import { useLocale } from "@/components/locale-provider"
import { ThemeToggle } from "@/components/theme-toggle"
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

import type { StaffProfile } from "@/components/operations-portal"

export type OperationsSection =
  | "overview"
  | "accounts"
  | "support"
  | "billing"
  | "risk"
  | "compliance"
  | "access"

const COPY = {
  "zh-CN": {
    product: "NoteGen 运营后台",
    realm: "官方托管 · 内部运营",
    group: "运营管理",
    role: "运营管理员",
    internal: "内部测试",
    overview: ["运营总览", "关注增长、服务与风险队列。"],
    accounts: ["客户账号", "检索客户并了解账号、设备与订阅状态。"],
    support: ["支持工单", "处理等待运营团队响应的客户问题。"],
    billing: ["订阅授权", "核对订阅生命周期与权益来源。"],
    risk: ["风险中心", "观察近期风险决策与异常信号。"],
    compliance: ["合规请求", "跟进数据访问、导出和删除请求。"],
    access: ["权限中心", "查看当前运营身份、角色与授权能力。"],
    refresh: "刷新当前数据",
    logout: "退出运营后台",
  },
  en: {
    product: "NoteGen Operations",
    realm: "Hosted · Internal operations",
    group: "Operations",
    role: "Operations administrator",
    internal: "Internal test",
    overview: ["Operations overview", "Monitor growth, service, and risk queues."],
    accounts: ["Customer accounts", "Search customers and inspect account, device, and subscription state."],
    support: ["Support cases", "Handle customer issues waiting for an operations response."],
    billing: ["Subscriptions", "Review subscription lifecycle and entitlement sources."],
    risk: ["Risk center", "Monitor recent risk decisions and unusual signals."],
    compliance: ["Compliance requests", "Track data access, export, and deletion requests."],
    access: ["Access center", "Review the current staff identity, roles, and permissions."],
    refresh: "Refresh current data",
    logout: "Sign out of operations",
  },
} as const

const PERMISSION: Partial<Record<OperationsSection, string>> = {
  overview: "platform.provision",
  accounts: "platform.provision",
  support: "support.read",
  billing: "billing.read",
  risk: "risk.read",
  compliance: "compliance.request.process",
}

export function permittedOperationsSections(profile: StaffProfile): OperationsSection[] {
  const order: OperationsSection[] = ["overview", "accounts", "support", "billing", "risk", "compliance", "access"]
  return order.filter((section) => {
    const permission = PERMISSION[section]
    return permission === undefined || profile.permissions.includes(permission)
  })
}

export function OperationsShell({
  profile,
  section,
  counts,
  busy,
  onSectionChange,
  onRefresh,
  onLogout,
  children,
}: {
  profile: StaffProfile
  section: OperationsSection
  counts: Partial<Record<OperationsSection, number>>
  busy: boolean
  onSectionChange: (section: OperationsSection) => void
  onRefresh: () => void
  onLogout: () => void
  children: ReactNode
}) {
  const { locale } = useLocale()
  const c = COPY[locale]
  const sections = permittedOperationsSections(profile)
  const details = c[section]
  const icons = {
    overview: LayoutDashboardIcon,
    accounts: UsersIcon,
    support: HeadsetIcon,
    billing: BadgeDollarSignIcon,
    risk: ShieldAlertIcon,
    compliance: ClipboardCheckIcon,
    access: KeyRoundIcon,
  }

  return (
    <SidebarProvider>
      <Sidebar variant="inset" collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" tooltip={c.product}>
                <span className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <Building2Icon />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{c.product}</span>
                  <span className="truncate text-xs text-muted-foreground">{c.realm}</span>
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>{c.group}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {sections.map((item) => {
                  const Icon = icons[item]
                  return (
                    <SidebarMenuItem key={item}>
                      <SidebarMenuButton
                        isActive={section === item}
                        tooltip={c[item][0]}
                        onClick={() => onSectionChange(item)}
                      >
                        <Icon />
                        <span>{c[item][0]}</span>
                      </SidebarMenuButton>
                      {counts[item] !== undefined ? <SidebarMenuBadge>{counts[item]}</SidebarMenuBadge> : null}
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
                <DropdownMenuTrigger render={<SidebarMenuButton size="lg" tooltip={profile.login} />}>
                  <span className="flex size-8 items-center justify-center rounded-lg bg-muted font-medium">
                    {profile.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{profile.displayName}</span>
                    <span className="truncate text-xs text-muted-foreground">{c.role}</span>
                  </span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="right">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>{profile.login}</DropdownMenuLabel>
                    <DropdownMenuItem onClick={() => onSectionChange("access")}>
                      <KeyRoundIcon />
                      {c.access[0]}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuItem variant="destructive" disabled={busy} onClick={onLogout}>
                      {busy ? <Spinner /> : <LogOutIcon />}
                      {c.logout}
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
              <h1 className="truncate text-base font-semibold">{details[0]}</h1>
              <p className="hidden truncate text-sm text-muted-foreground sm:block">{details[1]}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Badge variant="secondary" className="hidden sm:inline-flex">{c.internal}</Badge>
            <Button variant="ghost" size="icon" disabled={busy} aria-label={c.refresh} title={c.refresh} onClick={onRefresh}>
              {busy ? <Spinner /> : <RefreshCwIcon />}
            </Button>
            <LanguageToggle />
            <ThemeToggle />
          </div>
        </header>
        <Separator />
        <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 p-4 md:p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  )
}
