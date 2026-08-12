"use client"

import { useCallback, useEffect, useState, type FormEvent } from "react"
import {
  CircleCheckIcon,
  HistoryIcon,
  LaptopIcon,
  LockKeyholeIcon,
  ScrollTextIcon,
  ServerIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserRoundCogIcon,
  UsersIcon,
} from "lucide-react"

import { AdminShell, type AdminSection } from "@/components/admin-shell"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Pagination, PaginationContent, PaginationItem, PaginationNext, PaginationPrevious } from "@/components/ui/pagination"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { toast } from "@/components/ui/toast"
import { ThemeToggle } from "@/components/theme-toggle"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AdminInstanceSummary } from "@/components/admin-instance-summary"
import { ExperimentalCenter } from "@/components/experimental-center"
import { OperationsCenter } from "@/components/operations-center"
import { DeviceConnection } from "@/components/device-connection"
import { InstallationGuide, type InstallationStatus } from "@/components/installation-guide"
import {
  apiRequest,
  isApiRequestError,
  userFacingErrorMessage,
  type Account,
  type AdminAccount,
  type AdminAccountPage,
  type AdminBackup,
  type AdminAuditEntry,
  type AdminAuditPage,
  type AdminDevice,
  type AdminDevicePage,
  type AdminOverview,
  type AdminSystemStatus,
  type AdminStorageReport,
  type AdminWebSession,
  type AdminWorkspace,
  type AdminWorkspacePage,
  type Device,
  type ServerCapabilities,
  type SyncOverview,
  type WebWorkspace,
} from "@/lib/api"
import { formatRelativeTime as formatDate } from "@/lib/relative-time"
import { cn } from "@/lib/utils"

type AuthMode = "login" | "register"

export function AccountPortal() {
  const [, setRelativeTimeTick] = useState(0)
  const [account, setAccount] = useState<Account | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const [capabilities, setCapabilities] = useState<ServerCapabilities | null>(null)
  const [installationStatus, setInstallationStatus] = useState<InstallationStatus | null>(null)
  const [overview, setOverview] = useState<SyncOverview | null>(null)
  const [workspaces, setWorkspaces] = useState<WebWorkspace[]>([])
  const [deletingWorkspaceId, setDeletingWorkspaceId] = useState<string | null>(null)
  const [section, setSection] = useState<AdminSection>(readSectionFromUrl)
  const [adminRefreshVersion, setAdminRefreshVersion] = useState(0)
  const [adminOverview, setAdminOverview] = useState<AdminOverview | null>(null)
  const [adminAccounts, setAdminAccounts] = useState<AdminAccount[]>([])
  const [adminAccountTotal, setAdminAccountTotal] = useState(0)
  const [adminAudit, setAdminAudit] = useState<AdminAuditEntry[]>([])
  const [adminAuditTotal, setAdminAuditTotal] = useState(0)
  const [adminWorkspaces, setAdminWorkspaces] = useState<AdminWorkspace[]>([])
  const [adminWorkspaceTotal, setAdminWorkspaceTotal] = useState(0)
  const [adminDevices, setAdminDevices] = useState<AdminDevice[]>([])
  const [adminDeviceTotal, setAdminDeviceTotal] = useState(0)
  const [adminStatus, setAdminStatus] = useState<AdminSystemStatus | null>(null)
  const [adminQuery, setAdminQuery] = useState(() => readUrlParam("query"))
  const [adminAccountStatus, setAdminAccountStatus] = useState(() => readUrlParam("status") || "all")
  const [adminAccountOffset, setAdminAccountOffset] = useState(() => readUrlOffset("accountsOffset"))
  const [adminWorkspaceOffset, setAdminWorkspaceOffset] = useState(() => readUrlOffset("workspacesOffset"))
  const [adminDeviceOffset, setAdminDeviceOffset] = useState(() => readUrlOffset("devicesOffset"))
  const [adminAuditOffset, setAdminAuditOffset] = useState(() => readUrlOffset("auditOffset"))
  const [adminAuditAction, setAdminAuditAction] = useState(() => readUrlParam("auditAction"))
  const [adminLoading, setAdminLoading] = useState(false)
  const [adminError, setAdminError] = useState("")
  const [adminBusyAccountId, setAdminBusyAccountId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const loadDashboardData = useCallback(async () => {
    setError("")
    const [devicesResult, overviewResult, workspacesResult] = await Promise.allSettled([
      apiRequest<Device[]>("/v1/web/devices"),
      apiRequest<SyncOverview>("/v1/web/sync-overview"),
      apiRequest<WebWorkspace[]>("/v1/web/workspaces"),
    ])

    if (devicesResult.status === "fulfilled") setDevices(devicesResult.value)
    if (overviewResult.status === "fulfilled") setOverview(overviewResult.value)
    if (workspacesResult.status === "fulfilled") setWorkspaces(workspacesResult.value)

    const failed = devicesResult.status === "rejected"
      ? devicesResult
      : overviewResult.status === "rejected"
        ? overviewResult
        : workspacesResult.status === "rejected"
          ? workspacesResult
          : null
    if (failed) setError(errorMessage(failed.reason))
  }, [])

  const loadAdminData = useCallback(async () => {
    setAdminLoading(true)
    setAdminError("")
    try {
      const commonQuery = new URLSearchParams({ limit: "25", query: adminQuery })
      const accountQuery = new URLSearchParams(commonQuery)
      accountQuery.set("offset", String(adminAccountOffset))
      accountQuery.set("status", adminAccountStatus)
      const workspaceQuery = new URLSearchParams(commonQuery)
      workspaceQuery.set("offset", String(adminWorkspaceOffset))
      const deviceQuery = new URLSearchParams(commonQuery)
      deviceQuery.set("offset", String(adminDeviceOffset))
      const auditQuery = new URLSearchParams(commonQuery)
      auditQuery.set("offset", String(adminAuditOffset))
      if (adminAuditAction) auditQuery.set("action", adminAuditAction)
      const [overviewResult, accountsResult, auditResult, workspacesResult, devicesResult, statusResult] = await Promise.allSettled([
        apiRequest<AdminOverview>("/v1/web/admin/overview"),
        apiRequest<AdminAccountPage>(`/v1/web/admin/accounts?${accountQuery}`),
        apiRequest<AdminAuditPage>(`/v1/web/admin/audit?${auditQuery}`),
        apiRequest<AdminWorkspacePage>(`/v1/web/admin/workspaces?${workspaceQuery}`),
        apiRequest<AdminDevicePage>(`/v1/web/admin/devices?${deviceQuery}`),
        apiRequest<AdminSystemStatus>("/v1/web/admin/status"),
      ])
      if (overviewResult.status === "fulfilled") setAdminOverview(overviewResult.value)
      if (accountsResult.status === "fulfilled") { setAdminAccounts(accountsResult.value.accounts); setAdminAccountTotal(accountsResult.value.total) }
      if (auditResult.status === "fulfilled") { setAdminAudit(auditResult.value.entries); setAdminAuditTotal(auditResult.value.total) }
      if (workspacesResult.status === "fulfilled") { setAdminWorkspaces(workspacesResult.value.workspaces); setAdminWorkspaceTotal(workspacesResult.value.total) }
      if (devicesResult.status === "fulfilled") { setAdminDevices(devicesResult.value.devices); setAdminDeviceTotal(devicesResult.value.total) }
      if (statusResult.status === "fulfilled") setAdminStatus(statusResult.value)
      const failed = [overviewResult, accountsResult, auditResult, workspacesResult, devicesResult, statusResult]
        .find((result) => result.status === "rejected")
      if (failed?.status === "rejected") setAdminError(errorMessage(failed.reason))
    } finally {
      setAdminLoading(false)
    }
  }, [adminAccountOffset, adminAccountStatus, adminAuditAction, adminAuditOffset, adminDeviceOffset, adminQuery, adminWorkspaceOffset])

  const loadAccount = useCallback(async () => {
    try {
      const session = await apiRequest<{ account: Account }>("/v1/web/session")
      setAccount(session.account)
      setLoading(false)
      void loadDashboardData()
      redirectAfterAuth()
    } catch (cause) {
      if (!isApiRequestError(cause) || cause.status !== 401) {
        setError(errorMessage(cause))
      }
      setAccount(null)
    } finally {
      setLoading(false)
    }
  }, [loadDashboardData])

  useEffect(() => {
    const loadingFallback = window.setTimeout(() => {
      setLoading(false)
      setError((current) => current || "登录状态检查超时，请重试或重新登录。")
    }, 5_000)
    void (async () => {
      try {
        const status = await apiRequest<InstallationStatus>("/v1/installation/status")
        setInstallationStatus(status)
        if (status.installationRequired || status.activationPending) {
          setLoading(false)
          return
        }
      } catch (cause) {
        // Older compatible servers do not expose the installer status route.
        if (!isApiRequestError(cause) || cause.status !== 404) {
          setError(errorMessage(cause))
          setLoading(false)
          return
        }
      }
      await Promise.all([
        apiRequest<ServerCapabilities>("/v1/capabilities").then(setCapabilities),
        loadAccount(),
      ])
    })().catch((cause) => {
      setError(errorMessage(cause))
      setLoading(false)
    }).finally(() => window.clearTimeout(loadingFallback))
    return () => window.clearTimeout(loadingFallback)
  }, [loadAccount])

  useEffect(() => {
    if (!account) return
    const onVisibility = () => { if (document.visibilityState === "visible") void loadDashboardData() }
    document.addEventListener("visibilitychange", onVisibility)
    return () => document.removeEventListener("visibilitychange", onVisibility)
  }, [account, loadDashboardData])

  useEffect(() => {
    if (!account) return
    const timer = window.setInterval(() => {
      setRelativeTimeTick((current) => current + 1)
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [account])

  useEffect(() => {
    if (!account?.isAdmin || section !== "admin") return
    const timer = window.setTimeout(() => void loadAdminData(), 250)
    return () => window.clearTimeout(timer)
  }, [account, loadAdminData, section])

  useEffect(() => {
    if (!account || account.isAdmin || !adminOnlySections.has(section)) return
    setSection("overview")
    const url = new URL(window.location.href)
    url.searchParams.set("section", "overview")
    window.history.replaceState(null, "", url)
  }, [account, section])

  useEffect(() => {
    const onPopState = () => setSection(readSectionFromUrl())
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [])

  useEffect(() => {
    if (section !== "admin") return
    const url = new URL(window.location.href)
    setOptionalParam(url, "query", adminQuery)
    setOptionalParam(url, "status", adminAccountStatus === "all" ? "" : adminAccountStatus)
    setOptionalParam(url, "accountsOffset", adminAccountOffset ? String(adminAccountOffset) : "")
    setOptionalParam(url, "workspacesOffset", adminWorkspaceOffset ? String(adminWorkspaceOffset) : "")
    setOptionalParam(url, "devicesOffset", adminDeviceOffset ? String(adminDeviceOffset) : "")
    setOptionalParam(url, "auditOffset", adminAuditOffset ? String(adminAuditOffset) : "")
    setOptionalParam(url, "auditAction", adminAuditAction)
    window.history.replaceState(null, "", url)
  }, [section, adminQuery, adminAccountStatus, adminAccountOffset, adminWorkspaceOffset, adminDeviceOffset, adminAuditOffset, adminAuditAction])

  const navigateSection = useCallback((nextSection: AdminSection) => {
    setSection(nextSection)
    const url = new URL(window.location.href)
    url.pathname = nextSection === "connect" ? "/connect/" : "/"
    url.searchParams.set("section", nextSection)
    if (nextSection !== "connect") url.searchParams.delete("code")
    window.history.pushState(null, "", url)
  }, [])

  async function handleAuthenticated(nextAccount: Account) {
    setAccount(nextAccount)
    setError("")
    void loadDashboardData()
    redirectAfterAuth()
  }

  async function handleLogout() {
    setBusy(true)
    setError("")
    try {
      await apiRequest("/v1/web/auth/logout", { method: "POST", csrf: true })
      setAccount(null)
      setDevices([])
      setOverview(null)
      setWorkspaces([])
      setAdminOverview(null)
      setAdminAccounts([])
      setAdminAccountTotal(0)
      setAdminAudit([])
      setAdminWorkspaces([])
      setAdminDevices([])
      setAdminStatus(null)
      setSection("overview")
      window.history.replaceState(null, "", window.location.pathname)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  async function handleRevokeDevice(deviceId: string) {
    setBusy(true)
    setError("")
    try {
      await apiRequest(`/v1/web/devices/${deviceId}`, { method: "DELETE", csrf: true })
      setDevices((current) => current.map((device) => (
        device.id === deviceId ? { ...device, revokedAt: new Date().toISOString() } : device
      )))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  async function handleDeleteWorkspace(targetWorkspaceId: string) {
    setDeletingWorkspaceId(targetWorkspaceId)
    setError("")
    try {
      await apiRequest(`/v1/web/workspaces/${targetWorkspaceId}`, {
        method: "DELETE",
        csrf: true,
      })
      await loadDashboardData()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setDeletingWorkspaceId(null)
    }
  }

  async function handleSetAccountSuspended(targetAccountId: string, suspended: boolean) {
    setAdminBusyAccountId(targetAccountId)
    setAdminError("")
    try {
      await apiRequest(`/v1/web/admin/accounts/${targetAccountId}`, {
        method: "PATCH",
        csrf: true,
        body: JSON.stringify({ suspended }),
      })
      await loadAdminData()
    } catch (cause) {
      setAdminError(errorMessage(cause))
    } finally {
      setAdminBusyAccountId(null)
    }
  }

  async function handleSetAccountAdmin(targetAccountId: string, isAdmin: boolean) {
    setAdminBusyAccountId(targetAccountId)
    setAdminError("")
    try {
      await apiRequest(`/v1/web/admin/accounts/${targetAccountId}/role`, {
        method: "PATCH",
        csrf: true,
        body: JSON.stringify({ isAdmin }),
      })
      await loadAdminData()
    } catch (cause) {
      setAdminError(errorMessage(cause))
    } finally {
      setAdminBusyAccountId(null)
    }
  }

  if (loading) {
    return (
      <main className="mx-auto flex min-h-svh w-full max-w-6xl flex-col gap-6 p-6 md:p-10">
        <div className="flex items-center justify-between">
          <Skeleton className="h-10 w-56" />
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
        <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <Skeleton className="min-h-105 rounded-2xl" />
          <Skeleton className="min-h-105 rounded-2xl" />
        </div>
      </main>
    )
  }

  if (installationStatus?.installationRequired || installationStatus?.activationPending) {
    return <InstallationGuide initialStatus={installationStatus} onStatusChange={setInstallationStatus} />
  }

  if (!account) {
    return (
      <main className="mx-auto flex min-h-svh w-full max-w-6xl flex-col gap-6 p-6 md:justify-center md:p-10">
        <LoginHeader capabilities={capabilities} />
        {error ? <ErrorAlert message={error} /> : null}
        <div className="grid items-stretch gap-6 lg:grid-cols-[1.05fr_0.95fr]">
          <Card className="hidden justify-between bg-primary text-primary-foreground lg:flex">
            <CardHeader>
              <Badge className="w-fit" variant="secondary">NoteGen Sync</Badge>
              <CardTitle className="mt-6 text-3xl font-semibold tracking-tight">让同步保持清晰、可控。</CardTitle>
              <CardDescription className="max-w-md text-primary-foreground/75">
                在这里管理账号、设备和同步空间。敏感操作始终由服务器再次验证，而不只依赖页面状态。
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <LoginBenefit icon={ShieldCheckIcon} title="独立设备会话" description="每台设备都可以单独查看和撤销。" />
              <LoginBenefit icon={LockKeyholeIcon} title="加密状态可见" description="托管与端到端加密工作区都会明确标识。" />
              <LoginBenefit icon={ScrollTextIcon} title="同步记录可追溯" description="查看最近同步活动，不暴露内容秘密。" />
            </CardContent>
          </Card>
          <AuthCard
            busy={busy}
            registrationMethods={capabilities?.registration.methods ?? []}
            deploymentMode={capabilities?.deploymentMode ?? "self-hosted"}
            setBusy={setBusy}
            onAuthenticated={handleAuthenticated}
            onError={setError}
          />
        </div>
      </main>
    )
  }

  return (
    <AdminShell
      account={account}
      capabilities={capabilities}
      section={section}
      workspaceCount={workspaces.length}
      deviceCount={devices.filter((device) => !device.revokedAt).length}
      busy={busy}
      onSectionChange={navigateSection}
      onLogout={() => void handleLogout()}
      onRefresh={() => {
        if (section === "admin" && account.isAdmin) {
          void loadAdminData()
          return
        }
        if (["instance", "operations", "experiments"].includes(section) && account.isAdmin) {
          setAdminRefreshVersion((value) => value + 1)
          return
        }
        if (section === "overview" && account.isAdmin) {
          setAdminRefreshVersion((value) => value + 1)
        }
        void loadDashboardData()
      }}
    >
      {error ? <ErrorAlert message={error} /> : null}
      {section === "overview" ? <><OverviewSection overview={overview} />{account.isAdmin ? <AdminInstanceSummary refreshVersion={adminRefreshVersion} /> : null}</> : null}
      {section === "instance" && account.isAdmin ? <AdminInstanceSummary refreshVersion={adminRefreshVersion} /> : null}
      {section === "experiments" && account.isAdmin ? <ExperimentalCenter refreshVersion={adminRefreshVersion} /> : null}
      {section === "operations" && account.isAdmin ? <OperationsCenter refreshVersion={adminRefreshVersion} /> : null}
      {section === "workspaces" ? (
        <WorkspaceManagement
          workspaces={workspaces}
          deletingWorkspaceId={deletingWorkspaceId}
          onDelete={handleDeleteWorkspace}
        />
      ) : null}
      {section === "devices" ? (
        <DeviceManagement
          devices={devices}
          busy={busy}
          onRevoke={(id) => void handleRevokeDevice(id)}
        />
      ) : null}
      {section === "connect" ? <DeviceConnection embedded /> : null}
      {section === "security" ? <PasswordManagement initiallyEnabled={account.totpEnabled} /> : null}
      {section === "admin" && account.isAdmin ? (
        <SystemManagement
          currentAccountId={account.id}
          overview={adminOverview}
          accounts={adminAccounts}
          accountTotal={adminAccountTotal}
          audit={adminAudit}
          auditTotal={adminAuditTotal}
          workspaces={adminWorkspaces}
          workspaceTotal={adminWorkspaceTotal}
          devices={adminDevices}
          deviceTotal={adminDeviceTotal}
          status={adminStatus}
          query={adminQuery}
          accountStatus={adminAccountStatus}
          accountOffset={adminAccountOffset}
          workspaceOffset={adminWorkspaceOffset}
          deviceOffset={adminDeviceOffset}
          auditOffset={adminAuditOffset}
          auditAction={adminAuditAction}
          loading={adminLoading}
          error={adminError}
          busyAccountId={adminBusyAccountId}
          onRefresh={() => void loadAdminData()}
          onSetSuspended={handleSetAccountSuspended}
          onSetAdmin={handleSetAccountAdmin}
          onQueryChange={(value) => {
            setAdminQuery(value)
            setAdminAccountOffset(0); setAdminWorkspaceOffset(0); setAdminDeviceOffset(0); setAdminAuditOffset(0)
          }}
          onAccountStatusChange={(value) => { setAdminAccountStatus(value); setAdminAccountOffset(0) }}
          onAccountPage={setAdminAccountOffset}
          onWorkspacePage={setAdminWorkspaceOffset}
          onDevicePage={setAdminDeviceOffset}
          onAuditPage={setAdminAuditOffset}
          onAuditActionChange={(value) => { setAdminAuditAction(value); setAdminAuditOffset(0) }}
        />
      ) : null}
    </AdminShell>
  )
}

function LoginHeader({ capabilities }: { capabilities: ServerCapabilities | null }) {
  return (
    <header className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <ServerIcon />
        </span>
        <div>
          <h1 className="text-lg font-semibold">{capabilities?.serverName ?? "NoteGen 同步服务器"}</h1>
          <p className="text-sm text-muted-foreground">登录同步管理后台</p>
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
        <ThemeToggle />
      </div>
    </header>
  )
}

function ErrorAlert({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <ShieldCheckIcon />
      <AlertTitle>操作失败</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

function LoginBenefit({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof ShieldCheckIcon
  title: string
  description: string
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl bg-primary-foreground/10 p-4">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-foreground/15">
        <Icon />
      </span>
      <div className="flex flex-col gap-0.5">
        <p className="font-medium">{title}</p>
        <p className="text-sm text-primary-foreground/75">{description}</p>
      </div>
    </div>
  )
}

function OverviewSection({ overview }: { overview: SyncOverview | null }) {
  const contentStats = summarizeContentKinds(overview?.kinds ?? [])

  return (
    <>
      <Card className="bg-card/90 shadow-sm">
        <CardHeader>
          <CardTitle>同步概览</CardTitle>
          <CardDescription>汇总当前账号的同步对象、物理存储、序列和加密状态；已移除附件会按保留策略延迟回收。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="同步内容"
            value={`${overview?.objectCount ?? 0} 项`}
            detail={`${overview?.deletedObjectCount ?? 0} 项删除记录 · ${formatBytes(overview?.objectBytes ?? "0")} 加密数据`}
          />
          <Metric
            label="附件占用（含保留）"
            value={formatBytes(overview?.blobBytes ?? "0")}
            detail={`${overview?.blobCount ?? 0} 个存储 Blob`}
          />
          <Metric
            label="最新序列"
            value={overview?.latestSequence ?? "0"}
            detail={overview?.lastActivityAt ? `更新于 ${formatDate(overview.lastActivityAt)}` : "还没有同步活动"}
          />
          <Metric
            label="加密模式"
            value={overview?.encryptionMode === "e2ee" ? "端到端加密" : overview?.encryptionMode === "managed" ? "全部托管" : overview?.encryptionMode === "mixed" ? "混合加密" : "尚未建立"}
            detail={overview?.encryptionMode === "e2ee" ? "服务器无法解密内容" : overview?.encryptionMode === "mixed" ? "不同工作区使用不同加密方式" : "登录后可自动恢复"}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>内容数量</CardTitle>
          <CardDescription>仅展示各类同步内容的数量，不读取文件名或正文。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {contentStats.map((item) => (
            <Metric
              key={item.label}
              label={item.label}
              value={`${item.activeCount} 项`}
              detail={`${item.deletedCount} 项删除记录`}
            />
          ))}
        </CardContent>
      </Card>

      <div className="grid items-start gap-6">
        <Card>
          <CardHeader>
            <CardTitle>最近同步活动</CardTitle>
            <CardDescription>显示设备、内容类型和操作，不展示文件名或正文。</CardDescription>
          </CardHeader>
          <CardContent>
            {overview?.recentActivity.length ? (
              <ItemGroup>
                {overview.recentActivity.slice(0, 10).map((activity) => (
                  <Item key={`${activity.sequence}-${activity.device.id}`} variant="outline">
                    <ItemMedia variant="icon"><LaptopIcon /></ItemMedia>
                    <ItemContent>
                      <ItemTitle>{activity.changeType === "delete" ? "删除" : "更新"} {kindLabel(activity.kind)}</ItemTitle>
                      <ItemDescription>{activity.device.name} · {formatDate(activity.createdAt)}</ItemDescription>
                    </ItemContent>
                    <ItemActions><Badge variant="outline">#{activity.sequence}</Badge></ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            ) : (
              <p className="text-sm text-muted-foreground">还没有同步活动。</p>
            )}
          </CardContent>
        </Card>
      </div>

    </>
  )
}

function WorkspaceManagement({
  workspaces,
  deletingWorkspaceId,
  onDelete,
}: {
  workspaces: WebWorkspace[]
  deletingWorkspaceId: string | null
  onDelete: (id: string) => Promise<void>
}) {
  const sorted = [...workspaces].sort((left, right) => (
    Number(right.isDefault) - Number(left.isDefault)
    || right.objectCount - left.objectCount
    || new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  ))
  const historicalCount = workspaces.filter((workspace) => !workspace.isDefault).length

  return (
    <Card>
      <CardHeader>
        <CardTitle>工作区列表</CardTitle>
        <CardDescription>查看工作区状态与用量；默认工作区受到保护，历史工作区可在确认后软删除。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {historicalCount ? (
          <Alert>
            <HistoryIcon />
            <AlertTitle>发现 {historicalCount} 个历史工作区</AlertTitle>
            <AlertDescription>历史工作区按内容数量排序。删除会影响其全部同步数据，请确认不再使用后操作。</AlertDescription>
          </Alert>
        ) : null}
        {sorted.length ? (
          <ItemGroup>
            {sorted.map((workspace) => (
              <Item key={workspace.id} variant="outline">
                <ItemMedia variant="icon">{workspace.isDefault ? <ServerIcon /> : <HistoryIcon />}</ItemMedia>
                <ItemContent>
                  <ItemTitle>{workspace.isDefault ? "当前默认工作区" : `历史工作区 ${workspace.id.slice(0, 8)}`}</ItemTitle>
                  <ItemDescription>
                    {workspace.objectCount} 项内容 · {workspace.deletedObjectCount} 项删除记录 · 创建于 {formatDate(workspace.createdAt)}
                  </ItemDescription>
                </ItemContent>
                <ItemActions className="flex-wrap justify-end">
                  <Badge variant={workspace.isDefault ? "secondary" : "outline"}>
                    {workspace.isDefault ? "默认" : "历史"}
                  </Badge>
                  <Badge variant="outline">{workspace.encryptionMode === "managed" ? "托管加密" : "E2EE"}</Badge>
                  {!workspace.isDefault ? <DangerConfirmButton
                    label="删除"
                    title="删除这个历史工作区？"
                    description="工作区及其同步内容将进入软删除状态。确认所有设备都不再使用它后再继续。"
                    disabled={deletingWorkspaceId !== null}
                    busy={deletingWorkspaceId === workspace.id}
                    onConfirm={() => void onDelete(workspace.id)}
                  /> : null}
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        ) : (
          <Alert>
            <ServerIcon />
            <AlertTitle>还没有同步工作区</AlertTitle>
            <AlertDescription>连接 NoteGen 并完成首次同步后，工作区会显示在这里。</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}

function DeviceManagement({
  devices,
  busy,
  onRevoke,
}: {
  devices: Device[]
  busy: boolean
  onRevoke: (id: string) => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>已关联设备</CardTitle>
        <CardDescription>每台设备拥有独立会话，可以单独撤销；撤销不会删除已同步内容。</CardDescription>
      </CardHeader>
      <CardContent>
        {devices.length ? (
          <ItemGroup>
            {sortDevices(devices).map((device) => (
              <Item key={device.id} variant="outline">
                <ItemMedia variant="icon"><LaptopIcon /></ItemMedia>
                <ItemContent>
                  <ItemTitle>{device.name}</ItemTitle>
                  <ItemDescription>
                    {device.platform} · 最近活动 {formatDate(device.lastSeenAt)} · 设备 ID：{device.id}
                  </ItemDescription>
                  {isLikelyDuplicateDevice(device, devices) ? <Badge variant="outline">疑似重复设备</Badge> : null}
                </ItemContent>
                <ItemActions>
                  {device.revokedAt ? (
                    <Badge variant="outline">已撤销</Badge>
                  ) : (
                    <DangerConfirmButton
                      label="撤销"
                      title={`撤销“${device.name}”的设备授权？`}
                      description="这台设备需要重新关联才能继续同步，已经同步到服务端的内容不会删除。"
                      disabled={busy}
                      onConfirm={() => onRevoke(device.id)}
                    />
                  )}
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        ) : (
          <p className="text-sm text-muted-foreground">还没有关联 NoteGen 设备。</p>
        )}
      </CardContent>
    </Card>
  )
}

function PasswordManagement({ initiallyEnabled }: { initiallyEnabled: boolean }) {
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [sessions, setSessions] = useState<Array<{
    id: string; lastSeenAt: string; lastIp: string | null; userAgent: string | null; current: boolean
  }>>([])
  const [totpEnabled, setTotpEnabled] = useState(initiallyEnabled)
  const [totpPassword, setTotpPassword] = useState("")
  const [totpCode, setTotpCode] = useState("")
  const [totpSecret, setTotpSecret] = useState("")
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword

  const loadSessions = useCallback(async () => {
    try { setSessions(await apiRequest<typeof sessions>("/v1/web/sessions")) }
    catch (cause) { setError(errorMessage(cause)) }
  }, [])

  useEffect(() => { void loadSessions() }, [loadSessions])

  async function logoutOtherSessions() {
    setBusy(true)
    setError("")
    try {
      await apiRequest("/v1/web/sessions/others", { method: "DELETE", csrf: true })
      await loadSessions()
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }

  async function beginTotpSetup() {
    setBusy(true); setError("")
    try {
      const setup = await apiRequest<{ secret: string; uri: string }>("/v1/web/auth/totp/setup", {
        method: "POST", csrf: true, body: JSON.stringify({ currentPassword: totpPassword }),
      })
      setTotpSecret(setup.secret)
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }

  async function enableTotp() {
    setBusy(true); setError("")
    try {
      await apiRequest("/v1/web/auth/totp/enable", { method: "POST", csrf: true, body: JSON.stringify({ code: totpCode }) })
      setTotpEnabled(true); setTotpSecret(""); setTotpPassword(""); setTotpCode("")
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }

  async function disableTotp() {
    setBusy(true); setError("")
    try {
      await apiRequest("/v1/web/auth/totp", {
        method: "DELETE", csrf: true, body: JSON.stringify({ currentPassword: totpPassword, code: totpCode }),
      })
      setTotpEnabled(false); setTotpPassword(""); setTotpCode("")
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致。")
      return
    }
    setBusy(true)
    try {
      await apiRequest("/v1/web/auth/password", {
        method: "PUT",
        csrf: true,
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      setCurrentPassword("")
      setNewPassword("")
      setConfirmPassword("")
      toast.add({ title: "密码修改成功", description: "其他设备需要重新登录。", type: "success" })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid max-w-4xl gap-6 xl:grid-cols-2">
    <Card>
      <CardHeader>
        <CardTitle>修改密码</CardTitle>
        <CardDescription>修改后会撤销旧设备登录凭据并注销其他浏览器会话，当前浏览器会自动保持登录。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? <ErrorAlert message={error} /> : null}
        <form onSubmit={handleSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="current-password">当前密码</FieldLabel>
              <Input id="current-password" type="password" autoComplete="current-password" minLength={8} maxLength={1024} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-password">新密码</FieldLabel>
              <Input id="new-password" type="password" autoComplete="new-password" minLength={8} maxLength={1024} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required />
              <FieldDescription>至少 8 个字符，且不能与当前密码相同。</FieldDescription>
            </Field>
            <Field data-invalid={mismatch || undefined}>
              <FieldLabel htmlFor="confirm-password">确认新密码</FieldLabel>
              <Input id="confirm-password" type="password" autoComplete="new-password" minLength={8} maxLength={1024} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} aria-invalid={mismatch || undefined} required />
              {mismatch ? <FieldDescription>两次输入的新密码不一致。</FieldDescription> : null}
            </Field>
            <Field>
              <Button type="submit" disabled={busy || mismatch}>
                {busy ? <Spinner data-icon="inline-start" /> : <ShieldCheckIcon data-icon="inline-start" />}
                修改密码
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle>浏览器会话</CardTitle><CardDescription>检查登录位置，并注销当前浏览器之外的全部会话。</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ItemGroup>{sessions.map((session) => (
          <Item key={session.id} variant="outline">
            <ItemMedia variant="icon"><LaptopIcon /></ItemMedia>
            <ItemContent><ItemTitle>{session.current ? "当前浏览器" : "其他浏览器"}</ItemTitle>
              <ItemDescription>{session.lastIp ?? "未知 IP"} · {formatDate(session.lastSeenAt)}<br />{session.userAgent ?? "未知浏览器"}</ItemDescription>
            </ItemContent>
            {session.current ? <ItemActions><Badge variant="secondary">当前</Badge></ItemActions> : null}
          </Item>
        ))}</ItemGroup>
        <Button variant="outline" disabled={busy || sessions.every((session) => session.current)} onClick={() => void logoutOtherSessions()}>
          注销其他浏览器
        </Button>
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle>双因素认证</CardTitle><CardDescription>使用任意兼容 TOTP 的验证器保护网页和客户端登录。</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Badge variant={totpEnabled ? "secondary" : "outline"}>{totpEnabled ? "已启用" : "未启用"}</Badge>
        <Field><FieldLabel htmlFor="totp-password">当前密码</FieldLabel><Input id="totp-password" type="password" autoComplete="current-password" value={totpPassword} onChange={(event) => setTotpPassword(event.target.value)} /></Field>
        {totpSecret ? <Alert><ShieldCheckIcon /><AlertTitle>添加到验证器</AlertTitle><AlertDescription className="break-all">密钥：{totpSecret}</AlertDescription></Alert> : null}
        <Field><FieldLabel htmlFor="totp-security-code">6 位验证码</FieldLabel><Input id="totp-security-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totpCode} onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} /></Field>
        {totpEnabled ? (
          <Button variant="destructive" disabled={busy || totpPassword.length < 8 || totpCode.length !== 6} onClick={() => void disableTotp()}>关闭双因素认证</Button>
        ) : totpSecret ? (
          <Button disabled={busy || totpCode.length !== 6} onClick={() => void enableTotp()}>确认并启用</Button>
        ) : (
          <Button disabled={busy || totpPassword.length < 8} onClick={() => void beginTotpSetup()}>生成验证器密钥</Button>
        )}
      </CardContent>
    </Card>
    </div>
  )
}

function SystemManagement({
  currentAccountId,
  overview,
  accounts,
  accountTotal,
  audit,
  auditTotal,
  workspaces,
  workspaceTotal,
  devices,
  deviceTotal,
  status,
  query,
  accountStatus,
  accountOffset,
  workspaceOffset,
  deviceOffset,
  auditOffset,
  auditAction,
  loading,
  error,
  busyAccountId,
  onRefresh,
  onSetSuspended,
  onSetAdmin,
  onQueryChange,
  onAccountStatusChange,
  onAccountPage,
  onWorkspacePage,
  onDevicePage,
  onAuditPage,
  onAuditActionChange,
}: {
  currentAccountId: string
  overview: AdminOverview | null
  accounts: AdminAccount[]
  accountTotal: number
  audit: AdminAuditEntry[]
  auditTotal: number
  workspaces: AdminWorkspace[]
  workspaceTotal: number
  devices: AdminDevice[]
  deviceTotal: number
  status: AdminSystemStatus | null
  query: string
  accountStatus: string
  accountOffset: number
  workspaceOffset: number
  deviceOffset: number
  auditOffset: number
  auditAction: string
  loading: boolean
  error: string
  busyAccountId: string | null
  onRefresh: () => void
  onSetSuspended: (accountId: string, suspended: boolean) => Promise<void>
  onSetAdmin: (accountId: string, isAdmin: boolean) => Promise<void>
  onQueryChange: (value: string) => void
  onAccountStatusChange: (value: string) => void
  onAccountPage: (offset: number) => void
  onWorkspacePage: (offset: number) => void
  onDevicePage: (offset: number) => void
  onAuditPage: (offset: number) => void
  onAuditActionChange: (value: string) => void
}) {
  const [roleCandidateId, setRoleCandidateId] = useState<string | null>(null)
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([])
  const [managementError, setManagementError] = useState("")
  const [operationsLoading, setOperationsLoading] = useState(false)
  const [webSessions, setWebSessions] = useState<AdminWebSession[]>([])
  const [backups, setBackups] = useState<AdminBackup[]>([])
  const [storageReport, setStorageReport] = useState<AdminStorageReport | null>(null)

  async function batchSuspend(suspended: boolean) {
    setManagementError("")
    try {
      await apiRequest("/v1/web/admin/accounts/batch", {
        method: "POST", csrf: true,
        body: JSON.stringify({ accountIds: selectedAccountIds, suspended }),
      })
      setSelectedAccountIds([])
      onRefresh()
    } catch (cause) { setManagementError(errorMessage(cause)) }
  }

  async function cleanupAudit() {
    setManagementError("")
    try {
      await apiRequest("/v1/web/admin/audit?retentionDays=90", { method: "DELETE", csrf: true })
      onRefresh()
    } catch (cause) { setManagementError(errorMessage(cause)) }
  }

  async function deleteGlobalWorkspace(workspaceId: string) {
    setManagementError("")
    try { await apiRequest(`/v1/web/admin/workspaces/${workspaceId}`, { method: "DELETE", csrf: true }); onRefresh() }
    catch (cause) { setManagementError(errorMessage(cause)) }
  }

  async function revokeGlobalDevice(deviceId: string) {
    setManagementError("")
    try { await apiRequest(`/v1/web/admin/devices/${deviceId}`, { method: "DELETE", csrf: true }); onRefresh() }
    catch (cause) { setManagementError(errorMessage(cause)) }
  }

  async function restoreGlobalWorkspace(workspaceId: string) {
    setManagementError("")
    try { await apiRequest(`/v1/web/admin/workspaces/${workspaceId}/restore`, { method: "POST", csrf: true }); onRefresh() }
    catch (cause) { setManagementError(errorMessage(cause)) }
  }

  async function loadOperations() {
    setOperationsLoading(true)
    setManagementError("")
    try {
      const [sessionsPage, backupRows, report] = await Promise.all([
        apiRequest<{ sessions: AdminWebSession[] }>("/v1/web/admin/sessions?limit=50"),
        apiRequest<AdminBackup[]>("/v1/web/admin/backups"),
        apiRequest<AdminStorageReport>("/v1/web/admin/storage/orphans"),
      ])
      setWebSessions(sessionsPage.sessions)
      setBackups(backupRows)
      setStorageReport(report)
    } catch (cause) { setManagementError(errorMessage(cause)) }
    finally { setOperationsLoading(false) }
  }

  async function revokeWebSession(sessionId: string) {
    setManagementError("")
    try {
      await apiRequest(`/v1/web/admin/sessions/${sessionId}`, { method: "DELETE", csrf: true })
      await loadOperations()
    } catch (cause) { setManagementError(errorMessage(cause)) }
  }

  return (
    <>
      {error ? <ErrorAlert message={error} /> : null}
      {managementError ? <ErrorAlert message={managementError} /> : null}
      <Card>
        <CardHeader>
          <CardTitle>查询与导出</CardTitle>
          <CardDescription>搜索账号、工作区 ID、设备或审计目标；导出文件不包含密码、令牌和解密密钥。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Input className="min-w-64 flex-1" value={query} placeholder="输入账号、设备或 ID" onChange={(event) => onQueryChange(event.target.value)} />
          {(["accounts", "workspaces", "devices", "audit"] as const).map((scope) => (
            <Button key={scope} size="sm" variant="outline" onClick={() => void downloadAdminExport(scope)}>
              导出{scope === "accounts" ? "账号" : scope === "workspaces" ? "工作区" : scope === "devices" ? "设备" : "审计"}
            </Button>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>服务器总览</CardTitle>
            <CardDescription>跨账号汇总服务器中的有效数据和管理操作。</CardDescription>
          </div>
          <Button variant="outline" size="sm" disabled={loading} onClick={onRefresh}>
            {loading ? <Spinner data-icon="inline-start" /> : null}
            刷新
          </Button>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="账号"
            value={`${overview?.activeAccountCount ?? 0} / ${overview?.accountCount ?? 0}`}
            detail="可用账号 / 全部账号"
          />
          <Metric
            label="工作区"
            value={`${overview?.workspaceCount ?? 0} 个`}
            detail="未删除的工作区"
          />
          <Metric
            label="同步内容"
            value={`${overview?.objectCount ?? 0} 项`}
            detail={`${overview?.deletedObjectCount ?? 0} 项删除记录`}
          />
          <Metric
            label="在线授权"
            value={`${overview?.activeDeviceCount ?? 0} 台设备`}
            detail={`${overview?.auditCount ?? 0} 条后台审计记录`}
          />
        </CardContent>
      </Card>

      <div className="grid items-start gap-6 2xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><UsersIcon className="size-5" />账号管理</CardTitle>
            <CardDescription>
              共 {accountTotal} 个账号。停用后会立即注销其网页会话，并撤销设备和刷新令牌。
            </CardDescription>
            <div className="flex flex-wrap gap-2 pt-2">
              <Select value={accountStatus} onValueChange={(value) => { if (value) onAccountStatusChange(value) }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup>
                <SelectItem value="all">全部状态</SelectItem><SelectItem value="active">正常</SelectItem>
                <SelectItem value="suspended">已停用</SelectItem><SelectItem value="deletion">待删除</SelectItem>
              </SelectGroup></SelectContent></Select>
              <DangerConfirmButton label="批量停用" title={`停用选中的 ${selectedAccountIds.length} 个账号？`} description="这些账号的网页会话、设备凭据和刷新令牌会立即失效。" disabled={!selectedAccountIds.length} onConfirm={() => void batchSuspend(true)} />
              <Button size="sm" variant="outline" disabled={!selectedAccountIds.length} onClick={() => void batchSuspend(false)}>批量恢复</Button>
            </div>
          </CardHeader>
          <CardContent>
            {loading && accounts.length === 0 ? (
              <div className="flex min-h-32 items-center justify-center"><Spinner /></div>
            ) : accounts.length ? (
              <ItemGroup>
                {accounts.map((managedAccount) => {
                  const isCurrent = managedAccount.id === currentAccountId
                  const isSuspended = managedAccount.suspendedAt !== null
                  const pendingDeletion = managedAccount.deletionRequestedAt !== null
                  return (
                    <Item key={managedAccount.id} variant="outline">
                      {!isCurrent && !pendingDeletion ? (
                        <input
                          type="checkbox"
                          aria-label={`选择账号 ${managedAccount.login}`}
                          checked={selectedAccountIds.includes(managedAccount.id)}
                          onChange={(event) => setSelectedAccountIds((current) => event.target.checked
                            ? [...current, managedAccount.id]
                            : current.filter((id) => id !== managedAccount.id))}
                        />
                      ) : null}
                      <ItemMedia variant="icon"><UserRoundCogIcon /></ItemMedia>
                      <ItemContent>
                        <ItemTitle className="flex flex-wrap items-center gap-2">
                          {managedAccount.login}
                          {managedAccount.isAdmin ? <Badge variant="secondary">管理员</Badge> : null}
                          {isCurrent ? <Badge variant="outline">当前账号</Badge> : null}
                          {isSuspended ? <Badge variant="destructive">已停用</Badge> : null}
                          {pendingDeletion ? <Badge variant="destructive">待删除</Badge> : null}
                        </ItemTitle>
                        <ItemDescription>
                          {managedAccount.workspaceCount} 个工作区 · {managedAccount.objectCount} 项内容 · {managedAccount.deviceCount} 台有效设备
                          <br />创建于 {formatDate(managedAccount.createdAt)}
                          {pendingDeletion ? ` · 申请删除于 ${formatDate(managedAccount.deletionRequestedAt!)}` : ""}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions className="flex-wrap justify-end">
                        {!isCurrent && !pendingDeletion && roleCandidateId === managedAccount.id ? (
                          <>
                            <Button
                              size="sm"
                              variant={managedAccount.isAdmin ? "destructive" : "default"}
                              disabled={busyAccountId !== null}
                              onClick={() => {
                                void onSetAdmin(managedAccount.id, !managedAccount.isAdmin)
                                  .then(() => setRoleCandidateId(null))
                              }}
                            >
                              {busyAccountId === managedAccount.id ? <Spinner data-icon="inline-start" /> : null}
                              {managedAccount.isAdmin ? "确认移除权限" : "确认授予权限"}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busyAccountId !== null}
                              onClick={() => setRoleCandidateId(null)}
                            >
                              取消
                            </Button>
                          </>
                        ) : !isCurrent && !pendingDeletion ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busyAccountId !== null}
                            onClick={() => setRoleCandidateId(managedAccount.id)}
                          >
                            {managedAccount.isAdmin ? "移除管理员" : "设为管理员"}
                          </Button>
                        ) : null}
                        {!isCurrent && !pendingDeletion && isSuspended ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busyAccountId !== null}
                            onClick={() => void onSetSuspended(managedAccount.id, false)}
                          >
                            {busyAccountId === managedAccount.id
                              ? <Spinner data-icon="inline-start" />
                              : <CircleCheckIcon data-icon="inline-start" />}
                            恢复
                          </Button>
                        ) : !isCurrent && !pendingDeletion ? (
                          <DangerConfirmButton
                            label="停用"
                            title={`停用账号 ${managedAccount.login}？`}
                            description="该账号的网页会话、设备凭据和刷新令牌会立即失效。"
                            disabled={busyAccountId !== null}
                            onConfirm={() => void onSetSuspended(managedAccount.id, true)}
                          />
                        ) : null}
                      </ItemActions>
                    </Item>
                  )
                })}
              </ItemGroup>
            ) : (
              <p className="text-sm text-muted-foreground">还没有账号数据。</p>
            )}
            <AdminPagination total={accountTotal} offset={accountOffset} onPage={onAccountPage} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><ScrollTextIcon className="size-5" />操作审计</CardTitle>
            <CardDescription>保留最近 100 条后台数据变更，便于确认谁在何时执行了什么操作。</CardDescription>
            <div className="flex flex-wrap gap-2 pt-2">
              <Select value={auditAction || "all"} onValueChange={(value) => onAuditActionChange(value === "all" || value === null ? "" : value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup>
                <SelectItem value="all">全部操作</SelectItem><SelectItem value="account.suspend">停用账号</SelectItem>
                <SelectItem value="account.resume">恢复账号</SelectItem><SelectItem value="object.delete">删除内容</SelectItem>
                <SelectItem value="workspace.delete">删除工作区</SelectItem><SelectItem value="data.export">数据导出</SelectItem>
              </SelectGroup></SelectContent></Select>
              <DangerConfirmButton label="清理审计" title="清理 90 天前的审计记录？" description="历史审计删除后无法从管理页面恢复，本次清理操作本身仍会被记录。" onConfirm={() => void cleanupAudit()} />
            </div>
          </CardHeader>
          <CardContent>
            {loading && audit.length === 0 ? (
              <div className="flex min-h-32 items-center justify-center"><Spinner /></div>
            ) : audit.length ? (
              <ItemGroup>
                {audit.map((entry) => (
                  <Item key={entry.id} variant="outline">
                    <ItemMedia variant="icon"><ScrollTextIcon /></ItemMedia>
                    <ItemContent>
                      <ItemTitle>{auditActionLabel(entry.action)}</ItemTitle>
                      <ItemDescription>
                        {entry.actorLogin} · {formatDate(entry.createdAt)}
                        {entry.targetId ? ` · ${entry.targetType} ${entry.targetId.slice(0, 8)}` : ""}
                      </ItemDescription>
                      {Object.keys(entry.metadata).length ? (
                        <p className="mt-1 break-all text-xs text-muted-foreground">
                          {formatAuditMetadata(entry.metadata)}
                        </p>
                      ) : null}
                    </ItemContent>
                  </Item>
                ))}
              </ItemGroup>
            ) : (
              <p className="text-sm text-muted-foreground">还没有后台操作记录。</p>
            )}
            <AdminPagination total={auditTotal} offset={auditOffset} onPage={onAuditPage} />
          </CardContent>
        </Card>
      </div>

      <div className="grid items-start gap-6 2xl:grid-cols-2">
        <GlobalWorkspaceList workspaces={workspaces} total={workspaceTotal} offset={workspaceOffset} onPage={onWorkspacePage} onDelete={deleteGlobalWorkspace} onRestore={restoreGlobalWorkspace} />
        <GlobalDeviceList devices={devices} total={deviceTotal} offset={deviceOffset} onPage={onDevicePage} onRevoke={revokeGlobalDevice} />
      </div>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div><CardTitle>运维工具</CardTitle><CardDescription>管理浏览器会话、旧备份记录和对象存储一致性。</CardDescription></div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={operationsLoading} onClick={() => void loadOperations()}>
              {operationsLoading ? <Spinner data-icon="inline-start" /> : null}检查
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-6 xl:grid-cols-3">
          <div><p className="mb-2 text-sm font-medium">浏览器会话（{webSessions.length}）</p>
            <Table><TableHeader><TableRow><TableHead>账号</TableHead><TableHead>最后活动</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{webSessions.slice(0, 8).map((item) => (
              <TableRow key={item.id}><TableCell>{item.accountLogin}</TableCell><TableCell>{formatDate(item.lastSeenAt)}</TableCell><TableCell className="text-right"><Button size="sm" variant="ghost" onClick={() => void revokeWebSession(item.id)}>下线</Button></TableCell></TableRow>
            ))}</TableBody></Table>
          </div>
          <div><p className="mb-2 text-sm font-medium">旧数据库备份记录（{backups.length}）</p>
            <Table><TableHeader><TableRow><TableHead>文件</TableHead><TableHead>状态</TableHead></TableRow></TableHeader><TableBody>{backups.slice(0, 8).map((item) => (
              <TableRow key={item.id}><TableCell className="max-w-40 truncate">{item.filename}</TableCell><TableCell>{item.status}</TableCell></TableRow>
            ))}</TableBody></Table>
            {!backups.length ? <p className="text-sm text-muted-foreground">没有旧记录。统一备份的状态与门槛请查看实验功能。</p> : null}
          </div>
          <div><p className="mb-2 text-sm font-medium">对象存储</p>
            {storageReport ? <div className="rounded-lg border p-3 text-sm">
              <p>已检查 {storageReport.checked} 个附件</p>
              <p className="text-muted-foreground">缺失 {storageReport.missing.length} · 孤立 {storageReport.orphaned.length}</p>
            </div> : <p className="text-sm text-muted-foreground">点击“检查”扫描数据库和对象存储。</p>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>运行与存储状态</CardTitle><CardDescription>实时查看数据库响应、进程资源和同步数据规模。</CardDescription></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="服务运行" value={formatDuration(status?.uptimeSeconds ?? 0)} detail={`数据库响应 ${status?.databaseLatencyMs ?? 0} ms`} />
          <Metric label="数据库" value={formatBytes(status?.databaseBytes ?? "0")} detail={`${status?.versionCount ?? 0} 个版本 · ${status?.changeCount ?? 0} 条变更`} />
          <Metric label="对象与附件" value={formatBytes(status?.objectBytes ?? "0")} detail={`${status?.blobCount ?? 0} 个附件 · ${formatBytes(status?.blobBytes ?? "0")}`} />
          <Metric label="进程内存" value={formatBytes(status?.memoryRssBytes ?? "0")} detail={`堆内存 ${formatBytes(status?.heapUsedBytes ?? "0")}`} />
        </CardContent>
      </Card>
    </>
  )
}

function GlobalWorkspaceList({ workspaces, total, offset, onPage, onDelete, onRestore }: {
  workspaces: AdminWorkspace[]
  total: number
  offset: number
  onPage: (offset: number) => void
  onDelete: (id: string) => Promise<void>
  onRestore: (id: string) => Promise<void>
}) {
  return (
    <Card>
      <CardHeader><CardTitle>全局工作区</CardTitle><CardDescription>跨账号确认默认、历史和已删除工作区及其占用。</CardDescription></CardHeader>
      <CardContent>
        <ItemGroup>{workspaces.map((workspace) => (
          <Item key={workspace.id} variant="outline">
            <ItemMedia variant="icon"><ServerIcon /></ItemMedia>
            <ItemContent><ItemTitle>{workspace.accountLogin} · {workspace.id.slice(0, 8)}</ItemTitle>
              <ItemDescription>{workspace.objectCount} 项内容 · {workspace.deletedObjectCount} 项删除 · {formatBytes(workspace.objectBytes)} · {formatDate(workspace.updatedAt)}</ItemDescription>
            </ItemContent>
            <ItemActions><Badge variant="outline">{workspace.isDefault ? "默认" : "历史"}</Badge><Badge variant="outline">{workspace.encryptionMode === "managed" ? "托管" : "E2EE"}</Badge>{workspace.deletedAt ? <><Badge variant="destructive">已删除</Badge><Button size="sm" variant="outline" onClick={() => void onRestore(workspace.id)}>恢复</Button></> : !workspace.isDefault ? <DangerConfirmButton label="删除" title={`删除 ${workspace.accountLogin} 的工作区？`} description="工作区及其同步内容会进入软删除状态，请确认对应设备不再使用它。" onConfirm={() => void onDelete(workspace.id)} /> : null}</ItemActions>
          </Item>
        ))}</ItemGroup>
        {!workspaces.length ? <p className="text-sm text-muted-foreground">没有匹配的工作区。</p> : null}
        <AdminPagination total={total} offset={offset} onPage={onPage} />
      </CardContent>
    </Card>
  )
}

function GlobalDeviceList({ devices, total, offset, onPage, onRevoke }: {
  devices: AdminDevice[]
  total: number
  offset: number
  onPage: (offset: number) => void
  onRevoke: (id: string) => Promise<void>
}) {
  return (
    <Card>
      <CardHeader><CardTitle>全局设备</CardTitle><CardDescription>跨账号检查设备身份、平台、活动时间和撤销状态。</CardDescription></CardHeader>
      <CardContent>
        <ItemGroup>{devices.map((device) => (
          <Item key={device.id} variant="outline">
            <ItemMedia variant="icon"><LaptopIcon /></ItemMedia>
            <ItemContent><ItemTitle>{device.name}</ItemTitle><ItemDescription>{device.accountLogin} · {device.platform} · 最近活动 {formatDate(device.lastSeenAt)}</ItemDescription></ItemContent>
            <ItemActions>{device.revokedAt ? <Badge variant="outline">已撤销</Badge> : <DangerConfirmButton label="撤销" title={`撤销设备 ${device.name}？`} description="设备会立即失去同步权限，需要重新关联后才能继续使用。" onConfirm={() => void onRevoke(device.id)} />}</ItemActions>
          </Item>
        ))}</ItemGroup>
        {!devices.length ? <p className="text-sm text-muted-foreground">没有匹配的设备。</p> : null}
        <AdminPagination total={total} offset={offset} onPage={onPage} />
      </CardContent>
    </Card>
  )
}

function AdminPagination({ total, offset, onPage }: { total: number, offset: number, onPage: (offset: number) => void }) {
  const pageSize = 25
  if (total <= pageSize) return null
  return (
    <div className="mt-4 flex flex-col items-center gap-2 border-t pt-4">
      <span className="text-xs text-muted-foreground">第 {Math.floor(offset / pageSize) + 1} / {Math.ceil(total / pageSize)} 页 · 共 {total} 条</span>
      <Pagination><PaginationContent><PaginationItem><PaginationPrevious href="#" text="上一页" aria-disabled={offset === 0} onClick={(event) => { event.preventDefault(); if (offset > 0) onPage(Math.max(0, offset - pageSize)) }} /></PaginationItem><PaginationItem><PaginationNext href="#" text="下一页" aria-disabled={offset + pageSize >= total} onClick={(event) => { event.preventDefault(); if (offset + pageSize < total) onPage(offset + pageSize) }} /></PaginationItem></PaginationContent></Pagination>
    </div>
  )
}

function DangerConfirmButton({
  label, title, description, disabled = false, busy = false, onConfirm,
}: {
  label: string
  title: string
  description: string
  disabled?: boolean
  busy?: boolean
  onConfirm: () => void
}) {
  return <AlertDialog><AlertDialogTrigger render={<Button size="sm" variant="destructive" disabled={disabled} />}>
    {busy ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}{label}
  </AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription>{description}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={onConfirm}>确认{label}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
}

async function downloadAdminExport(scope: "accounts" | "workspaces" | "devices" | "audit") {
  const data = await apiRequest<unknown>(`/v1/web/admin/export?scope=${scope}`)
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }))
  const link = document.createElement("a")
  link.href = url
  link.download = `notegen-${scope}-${new Date().toISOString().slice(0, 10)}.json`
  link.click()
  URL.revokeObjectURL(url)
}

function AuthCard({
  busy,
  registrationMethods,
  deploymentMode,
  setBusy,
  onAuthenticated,
  onError,
}: {
  busy: boolean
  registrationMethods: string[]
  deploymentMode: "hosted" | "self-hosted"
  setBusy: (value: boolean) => void
  onAuthenticated: (account: Account) => Promise<void>
  onError: (message: string) => void
}) {
  const [mode, setMode] = useState<AuthMode>("login")
  const [login, setLogin] = useState("")
  const [password, setPassword] = useState("")
  const [setupToken, setSetupToken] = useState("")
  const [totpCode, setTotpCode] = useState("")
  const [notice, setNotice] = useState("")
  const canRegister = registrationMethods.some((method) => (
    method === "setup" || method === "password" || method === "email-password"
  ))
  const isAdministratorSetup = registrationMethods.includes("setup")

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    onError("")
    setNotice("")
    try {
      if (mode === "register" && deploymentMode === "hosted") {
        await apiRequest("/v1/web/auth/register/email", {
          method: "POST",
          body: JSON.stringify({ email: login, password }),
        })
        setPassword("")
        setNotice("验证邮件已进入内部测试投递流程。验证完成后即可登录。")
        return
      }
      if (mode === "register" && deploymentMode === "self-hosted" && isAdministratorSetup) {
        const result = await apiRequest<{ account: Account }>("/v1/setup/complete", {
          method: "POST",
          body: JSON.stringify({ login, password, token: setupToken.trim() }),
        })
        setPassword("")
        setSetupToken("")
        await onAuthenticated(result.account)
        return
      }
      const body = mode === "register"
        ? { login, password, ...(setupToken.trim() ? { setupToken: setupToken.trim() } : {}) }
        : { login, password, ...(totpCode.trim() ? { totpCode: totpCode.trim() } : {}) }
      const result = await apiRequest<{ account: Account }>(`/v1/web/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify(body),
      })
      setPassword("")
      setSetupToken("")
      setTotpCode("")
      await onAuthenticated(result.account)
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mx-auto w-full max-w-md bg-card/90 shadow-sm lg:mx-0 lg:max-w-none">
      <CardHeader>
        <CardTitle>连接你的同步账号</CardTitle>
        <CardDescription>
          {deploymentMode === "hosted" && !canRegister
            ? "当前官方托管测试实例暂未开放注册。"
            : "同一账号可连接多个 NoteGen 设备。账号密码不会用于解密端到端加密工作区。"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs value={mode} onValueChange={(value) => setMode(value as AuthMode)}>
          <TabsList className={cn("grid w-full", canRegister ? "grid-cols-2" : "grid-cols-1")}>
            <TabsTrigger value="login">登录</TabsTrigger>
            {canRegister ? <TabsTrigger value="register">注册</TabsTrigger> : null}
          </TabsList>
          <TabsContent value={mode}>
            <form onSubmit={handleSubmit}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="login">{deploymentMode === "hosted" ? "邮箱" : "账号"}</FieldLabel>
                  <Input
                    id="login"
                    value={login}
                    onChange={(event) => setLogin(event.target.value)}
                    autoComplete="username"
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="password">密码</FieldLabel>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    minLength={8}
                    required
                  />
                  <FieldDescription>至少 8 个字符，仅用于账号登录；默认同步无需另设加密口令。</FieldDescription>
                </Field>
                {mode === "register" && deploymentMode === "self-hosted" && isAdministratorSetup ? (
                  <Field>
                    <FieldLabel htmlFor="setup-token">一次性恢复凭据</FieldLabel>
                    <Input
                      id="setup-token"
                      type="password"
                      value={setupToken}
                      onChange={(event) => setSetupToken(event.target.value)}
                      autoComplete="off"
                    />
                    <FieldDescription>灾备恢复场景请填写本机 CLI 签发的一次性初始化凭据。</FieldDescription>
                  </Field>
                ) : null}
                {mode === "login" ? (
                  <Field>
                    <FieldLabel htmlFor="totp-code">双因素验证码（可选）</FieldLabel>
                    <Input id="totp-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={totpCode} onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} />
                    <FieldDescription>账号启用双因素认证后填写验证器中的 6 位数字。</FieldDescription>
                  </Field>
                ) : null}
                {notice ? (
                  <Alert>
                    <CircleCheckIcon />
                    <AlertTitle>已提交</AlertTitle>
                    <AlertDescription>{notice}</AlertDescription>
                  </Alert>
                ) : null}
                <Field>
                  <Button type="submit" size="lg" disabled={busy}>
                    {busy ? <Spinner data-icon="inline-start" /> : null}
                    {mode === "login" ? "登录" : "创建账号"}
                  </Button>
                </Field>
              </FieldGroup>
            </form>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

function redirectAfterAuth() {
  const next = new URLSearchParams(window.location.search).get("next")
  if (next?.startsWith("/") && !next.startsWith("//")) window.location.assign(next)
}

const adminSections = new Set<AdminSection>([
  "overview", "workspaces", "devices", "connect", "security",
  "instance", "operations", "admin", "experiments",
])
const adminOnlySections = new Set<AdminSection>(["instance", "operations", "admin", "experiments"])

function readSectionFromUrl(): AdminSection {
  if (typeof window === "undefined") return "overview"
  const requested = new URLSearchParams(window.location.search).get("section")
  if (requested === "services") return "experiments"
  if (requested !== null && adminSections.has(requested as AdminSection)) {
    return requested as AdminSection
  }
  // `/connect/` remains a compatibility entry point for device authorization,
  // but an explicit section selected inside the portal must win on refresh.
  return window.location.pathname.startsWith("/connect") ? "connect" : "overview"
}

function readUrlParam(name: string): string {
  return typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get(name) ?? ""
}

function readUrlOffset(name: string): number {
  const value = Number(readUrlParam(name))
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function setOptionalParam(url: URL, name: string, value: string): void {
  if (value) url.searchParams.set(name, value)
  else url.searchParams.delete(name)
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl border bg-muted/30 p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  )
}

function sortDevices(devices: Device[]): Device[] {
  return [...devices].sort((left, right) => (
    Number(Boolean(left.revokedAt)) - Number(Boolean(right.revokedAt))
    || new Date(right.lastSeenAt).getTime() - new Date(left.lastSeenAt).getTime()
  ))
}

function isLikelyDuplicateDevice(device: Device, devices: Device[]): boolean {
  if (device.revokedAt) return false
  const matching = devices.filter((candidate) => (
    !candidate.revokedAt
    && candidate.name === device.name
    && candidate.platform === device.platform
  ))
  if (matching.length < 2) return false
  const newest = matching.reduce((current, candidate) => (
    new Date(candidate.lastSeenAt).getTime() > new Date(current.lastSeenAt).getTime()
      ? candidate
      : current
  ))
  return newest.id !== device.id
}

function kindLabel(kind: string): string {
  const labels: Record<string, string> = {
    note: "Markdown 笔记",
    folder: "目录",
    asset: "附件",
    canvas: "画布",
    record: "记录",
    tag: "标签",
    mark: "记录",
    conversation: "对话",
    memory: "记忆",
    setting: "设置",
    "yjs-checkpoint": "实时文档快照",
    "yjs-update": "实时文档增量",
  }
  return labels[kind] ?? kind
}

function summarizeContentKinds(kinds: SyncOverview["kinds"]): Array<{
  label: string
  activeCount: number
  deletedCount: number
}> {
  const groups = [
    { label: "笔记", kinds: ["note"] },
    { label: "记录", kinds: ["mark", "record"] },
    { label: "绘图", kinds: ["canvas"] },
    { label: "对话", kinds: ["conversation"] },
    { label: "记忆", kinds: ["memory"] },
    { label: "配置", kinds: ["setting"] },
    { label: "附件", kinds: ["asset"] },
  ]
  return groups.map((group) => {
    const matches = kinds.filter((item) => group.kinds.includes(item.kind))
    return {
      label: group.label,
      activeCount: matches.reduce((total, item) => total + item.activeCount, 0),
      deletedCount: matches.reduce((total, item) => total + item.deletedCount, 0),
    }
  })
}

function auditActionLabel(action: string): string {
  const labels: Record<string, string> = {
    "account.suspend": "停用账号",
    "account.resume": "恢复账号",
    "account.admin-grant": "授予管理员权限",
    "account.admin-revoke": "移除管理员权限",
    "account.password-change": "修改账号密码",
    "test-object.create": "创建测试内容",
    "object.delete": "删除同步内容",
    "workspace.delete": "删除历史工作区",
    "workspace.admin-delete": "管理员删除工作区",
    "device.revoke": "撤销设备授权",
    "device.admin-revoke": "管理员撤销设备",
    "data.export": "导出后台数据",
    "audit.cleanup": "清理历史审计",
    "runtime-configuration.update": "更新运行配置",
    "instance.web-installation-complete": "完成 Web 安装",
  }
  return labels[action] ?? action
}

function formatAuditMetadata(metadata: Record<string, unknown>): string {
  return Object.entries(metadata)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" · ")
}

function formatBytes(value: string): string {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const amount = bytes / 1024 ** index
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  return days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分钟`
}

const errorMessage = userFacingErrorMessage
