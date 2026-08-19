"use client"

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import {
  ArrowRightIcon,
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
import QRCode from "react-qr-code"

import { AdminShell, type AdminSection } from "@/components/admin-shell"
import { NOTEGEN_SITE_URL } from "@/components/notegen-brand"
import { PublicSiteShell } from "@/components/site-chrome"
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
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
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
type AuthStep = "credentials" | "totp" | "forgot" | "reset" | "verify" | "verification-pending"
type AdminDataView = "overview" | "accounts" | "data" | "audit" | "tools"

export function AccountPortal({ forceAuthenticationFlow = false }: { forceAuthenticationFlow?: boolean }) {
  const [, setRelativeTimeTick] = useState(0)
  const [account, setAccount] = useState<Account | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const [capabilities, setCapabilities] = useState<ServerCapabilities | null>(null)
  const [installationStatus, setInstallationStatus] = useState<InstallationStatus | null>(null)
  const [overview, setOverview] = useState<SyncOverview | null>(null)
  const [workspaces, setWorkspaces] = useState<WebWorkspace[]>([])
  const [deletingWorkspaceId, setDeletingWorkspaceId] = useState<string | null>(null)
  const [recentlyDeletedWorkspace, setRecentlyDeletedWorkspace] = useState<WebWorkspace | null>(null)
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
  const [adminView, setAdminView] = useState<AdminDataView>(readAdminViewFromUrl)
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

    const failures = [
      devicesResult.status === "rejected" ? { label: "设备", reason: devicesResult.reason } : null,
      overviewResult.status === "rejected" ? { label: "同步概览", reason: overviewResult.reason } : null,
      workspacesResult.status === "rejected" ? { label: "工作区", reason: workspacesResult.reason } : null,
    ].filter((item): item is { label: string; reason: unknown } => item !== null)
    if (failures.length) setError(`部分数据未更新（${failures.map((item) => item.label).join("、")}）。${errorMessage(failures[0].reason)}`)
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
      if (adminView === "overview") {
        const [nextOverview, nextStatus] = await Promise.all([
          apiRequest<AdminOverview>("/v1/web/admin/overview"),
          apiRequest<AdminSystemStatus>("/v1/web/admin/status"),
        ])
        setAdminOverview(nextOverview); setAdminStatus(nextStatus)
      } else if (adminView === "accounts") {
        const page = await apiRequest<AdminAccountPage>(`/v1/web/admin/accounts?${accountQuery}`)
        setAdminAccounts(page.accounts); setAdminAccountTotal(page.total)
      } else if (adminView === "audit") {
        const page = await apiRequest<AdminAuditPage>(`/v1/web/admin/audit?${auditQuery}`)
        setAdminAudit(page.entries); setAdminAuditTotal(page.total)
      } else if (adminView === "data") {
        const [workspacePage, devicePage] = await Promise.all([
          apiRequest<AdminWorkspacePage>(`/v1/web/admin/workspaces?${workspaceQuery}`),
          apiRequest<AdminDevicePage>(`/v1/web/admin/devices?${deviceQuery}`),
        ])
        setAdminWorkspaces(workspacePage.workspaces); setAdminWorkspaceTotal(workspacePage.total)
        setAdminDevices(devicePage.devices); setAdminDeviceTotal(devicePage.total)
      }
    } catch (cause) {
      setAdminError(errorMessage(cause))
    } finally {
      setAdminLoading(false)
    }
  }, [adminAccountOffset, adminAccountStatus, adminAuditAction, adminAuditOffset, adminDeviceOffset, adminQuery, adminView, adminWorkspaceOffset])

  const loadAccount = useCallback(async () => {
    try {
      const session = await apiRequest<{ account: Account }>("/v1/web/session")
      setAccount(session.account)
      setError("")
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
    const onPopState = () => { setSection(readSectionFromUrl()); setAdminView(readAdminViewFromUrl()) }
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
    setOptionalParam(url, "adminView", adminView === "overview" ? "" : adminView)
    window.history.replaceState(null, "", url)
  }, [section, adminQuery, adminAccountStatus, adminAccountOffset, adminWorkspaceOffset, adminDeviceOffset, adminAuditOffset, adminAuditAction, adminView])

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
      setRecentlyDeletedWorkspace(workspaces.find((workspace) => workspace.id === targetWorkspaceId) ?? null)
      await loadDashboardData()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setDeletingWorkspaceId(null)
    }
  }

  async function handleRestoreWorkspace(targetWorkspaceId: string) {
    setDeletingWorkspaceId(targetWorkspaceId)
    setError("")
    try {
      await apiRequest(`/v1/web/workspaces/${targetWorkspaceId}/restore`, { method: "POST", csrf: true })
      setRecentlyDeletedWorkspace(null)
      await loadDashboardData()
      toast.add({ title: "工作区已恢复", type: "success" })
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
      <main className="mx-auto flex min-h-svh w-full max-w-6xl flex-col gap-6 p-6 md:p-10" aria-busy="true" aria-label="正在加载账户信息">
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

  if (!account || forceAuthenticationFlow) {
    return (
      <PublicSiteShell instanceName={capabilities?.serverName}>
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-5 sm:px-6 md:px-8">
        <div className="flex flex-1 items-center py-12 sm:py-16 lg:py-24">
          <div className="grid w-full items-center gap-12 lg:grid-cols-[minmax(0,1fr)_28rem] lg:gap-20">
            <div className="mx-auto flex w-full max-w-2xl flex-col items-center text-center lg:mx-0 lg:items-start lg:text-left">
              <Badge variant="outline" className="mb-6 rounded-full px-3 py-1">
                NoteGen Sync · 跨设备同步
              </Badge>
              <h1 className="max-w-2xl text-4xl leading-[1.08] font-semibold tracking-[-0.04em] sm:text-5xl lg:text-6xl">
                连接设备，<br />保持同步。
              </h1>
              <p className="mt-6 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
                管理 NoteGen 账号、设备和同步空间。官方公共测试服务与自行部署使用相同的开放源代码和运行方式。
              </p>
              <div className="mt-7 flex flex-wrap justify-center gap-x-6 gap-y-3 text-sm lg:justify-start">
                <LoginBenefit icon={ShieldCheckIcon} title="独立设备会话" />
                <LoginBenefit icon={LockKeyholeIcon} title="加密状态可见" />
                <LoginBenefit icon={ScrollTextIcon} title="同步记录可追溯" />
              </div>
              <p className="mt-8 text-sm text-muted-foreground">
                还没有 NoteGen？
                <a className="ml-1 font-medium text-foreground underline-offset-4 hover:underline" href={`${NOTEGEN_SITE_URL}/cn/download`} target="_blank" rel="noreferrer">
                  下载客户端
                  <ArrowRightIcon className="ml-1 inline size-3.5" />
                </a>
              </p>
            </div>
            <div className="mx-auto flex w-full max-w-md flex-col gap-4 lg:mx-0">
              {error ? <ErrorAlert message={error} /> : null}
              <AuthCard
                busy={busy}
                registrationMethods={capabilities?.registration.methods ?? []}
                setBusy={setBusy}
                onAuthenticated={handleAuthenticated}
                onError={setError}
              />
              <Alert>
                <ServerIcon />
                <AlertTitle>免费独立实例</AlertTitle>
                <AlertDescription>
                  本服务不包含付费订阅或商业 SLA。请保留本地数据；实例维护、开放范围和数据保留策略由实例管理员负责。<a className="ml-1 font-medium text-foreground underline-offset-4 hover:underline" href="/service/">查看服务说明</a>
                </AlertDescription>
              </Alert>
            </div>
          </div>
        </div>
      </main>
      </PublicSiteShell>
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
      {section === "overview" ? <><OverviewSection overview={overview} devices={devices} onNavigate={navigateSection} />{account.isAdmin ? <AdminInstanceSummary refreshVersion={adminRefreshVersion} /> : null}</> : null}
      {section === "instance" && account.isAdmin ? <AdminInstanceSummary refreshVersion={adminRefreshVersion} /> : null}
      {section === "experiments" && account.isAdmin ? <ExperimentalCenter refreshVersion={adminRefreshVersion} /> : null}
      {section === "operations" && account.isAdmin ? <OperationsCenter refreshVersion={adminRefreshVersion} /> : null}
      {section === "workspaces" ? (
        <WorkspaceManagement
          workspaces={workspaces}
          recentlyDeletedWorkspace={recentlyDeletedWorkspace}
          deletingWorkspaceId={deletingWorkspaceId}
          onDelete={handleDeleteWorkspace}
          onRestore={handleRestoreWorkspace}
        />
      ) : null}
      {section === "devices" ? (
        <DeviceManagement
          devices={devices}
          busy={busy}
          onRevoke={(id) => void handleRevokeDevice(id)}
          onConnect={() => navigateSection("connect")}
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
          adminView={adminView}
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
          onAdminViewChange={setAdminView}
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

function ErrorAlert({ message }: { message: string }) {
  const connectionFailed = message.includes("无法连接同步服务器")
  return (
    <Alert variant="destructive">
      <ShieldCheckIcon />
      <AlertTitle>{connectionFailed ? "暂时无法连接" : "操作失败"}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

function LoginBenefit({
  icon: Icon,
  title,
}: {
  icon: typeof ShieldCheckIcon
  title: string
}) {
  return (
    <div className="flex items-center gap-2 text-muted-foreground">
      <Icon className="size-4" />
      <span>{title}</span>
    </div>
  )
}

function OverviewSection({ overview, devices, onNavigate }: {
  overview: SyncOverview | null
  devices: Device[]
  onNavigate: (section: AdminSection) => void
}) {
  const contentStats = summarizeContentKinds(overview?.kinds ?? [])
  const storage = overview?.storageUsage
  const activeBytes = storage ? sumByteStrings(
    storage.activeObjectBytes, storage.activeCrdtBytes, storage.activeBlobBytes,
  ) : "0"
  const enforcedBytes = storage ? sumByteStrings(
    activeBytes, storage.reservedBlobBytes, storage.retainedBytes,
  ) : "0"
  const activeDevices = devices.filter((device) => !device.revokedAt)
  const behindDevices = activeDevices.filter((device) => device.syncStatus === "behind")
  const health = activeDevices.length === 0
    ? { label: "等待连接设备", description: "关联第一台 NoteGen 设备后，服务器会自动建立同步空间。", variant: "outline" as const }
    : behindDevices.length > 0
      ? { label: `${behindDevices.length} 台设备尚未追平`, description: "打开对应设备上的 NoteGen，让它保持联网以完成同步。", variant: "destructive" as const }
      : { label: "同步正常", description: `${activeDevices.length} 台设备已连接${overview?.lastActivityAt ? `，最近同步于 ${formatDate(overview.lastActivityAt)}` : "，正在等待首次同步"}。`, variant: "secondary" as const }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col items-start justify-between gap-4 sm:flex-row">
          <div className="flex flex-col gap-2">
            <Badge className="w-fit" variant={health.variant}>{health.label}</Badge>
            <div>
              <CardTitle>你的同步状态</CardTitle>
              <CardDescription>{health.description}</CardDescription>
            </div>
          </div>
          <Button variant={activeDevices.length === 0 ? "default" : "outline"} onClick={() => onNavigate(activeDevices.length === 0 ? "connect" : "devices")}>
            {activeDevices.length === 0 ? "关联第一台设备" : "查看设备"}
          </Button>
        </CardHeader>
      </Card>
      <Card>
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

      {storage ? (
        <Card>
          <CardHeader>
            <CardTitle>存储核算</CardTitle>
            <CardDescription>
              服务端按活跃数据、上传预留和历史保留的总和核算安全上限。删除内容后，历史保留空间会按保留策略延迟释放。
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="核算合计" value={formatBytes(enforcedBytes)} detail="这是实例空间上限实际核对的总量" />
            <Metric label="活跃数据" value={formatBytes(activeBytes)} detail="对象、协作文档和当前附件" />
            <Metric label="上传预留" value={formatBytes(storage.reservedBlobBytes)} detail="进行中的附件上传预占空间" />
            <Metric label="历史保留" value={formatBytes(storage.retainedBytes)} detail="版本与变更记录到期后自动回收" />
          </CardContent>
        </Card>
      ) : null}

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
            ) : <ActionEmpty icon={LaptopIcon} title="还没有同步活动" description="关联设备并在 NoteGen 中完成首次同步后，最近活动会显示在这里。" action="关联设备" onAction={() => onNavigate("connect")} />}
          </CardContent>
        </Card>
      </div>

    </>
  )
}

function sumByteStrings(...values: string[]): string {
  return values.reduce((total, value) => total + BigInt(value || "0"), 0n).toString()
}

function WorkspaceManagement({
  workspaces,
  recentlyDeletedWorkspace,
  deletingWorkspaceId,
  onDelete,
  onRestore,
}: {
  workspaces: WebWorkspace[]
  recentlyDeletedWorkspace: WebWorkspace | null
  deletingWorkspaceId: string | null
  onDelete: (id: string) => Promise<void>
  onRestore: (id: string) => Promise<void>
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
        {recentlyDeletedWorkspace ? <Alert><HistoryIcon /><AlertTitle>历史工作区已删除</AlertTitle><AlertDescription className="flex flex-col items-start gap-3"><span>工作区 {recentlyDeletedWorkspace.id.slice(0, 8)} 已进入软删除状态，可以立即恢复。</span><Button size="sm" variant="outline" disabled={deletingWorkspaceId !== null} onClick={() => void onRestore(recentlyDeletedWorkspace.id)}>{deletingWorkspaceId === recentlyDeletedWorkspace.id ? <Spinner data-icon="inline-start" /> : null}撤销删除</Button></AlertDescription></Alert> : null}
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
        ) : <ActionEmpty icon={ServerIcon} title="还没有同步工作区" description="连接 NoteGen 并完成首次同步后，工作区会显示在这里。" />}
      </CardContent>
    </Card>
  )
}

function DeviceManagement({
  devices,
  busy,
  onRevoke,
  onConnect,
}: {
  devices: Device[]
  busy: boolean
  onRevoke: (id: string) => void
  onConnect: () => void
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
                    {device.platform} · 最近活动 {formatDate(device.lastSeenAt)} · 关联于 {formatDate(device.createdAt)}
                  </ItemDescription>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <DeviceSyncBadge device={device} />
                    {device.acknowledgedAt ? (
                      <span className="text-xs text-muted-foreground">最后确认 {formatDate(device.acknowledgedAt)}</span>
                    ) : null}
                  </div>
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
        ) : <ActionEmpty icon={LaptopIcon} title="还没有关联设备" description="按页面提示复制服务器地址或扫描二维码，即可开始同步。" action="关联第一台设备" onAction={onConnect} />}
      </CardContent>
    </Card>
  )
}

function DeviceSyncBadge({ device }: { device: Device }) {
  if (device.syncStatus === "caught-up") return <Badge variant="outline">已追平</Badge>
  if (device.syncStatus === "behind") return <Badge variant="destructive">落后 {device.pendingEventCount} 项</Badge>
  return <Badge variant="outline">从未确认同步</Badge>
}

function ActionEmpty({ icon: Icon, title, description, action, onAction }: {
  icon: typeof LaptopIcon
  title: string
  description: string
  action?: string
  onAction?: () => void
}) {
  return <Empty className="min-h-40 border"><EmptyHeader><EmptyMedia variant="icon"><Icon /></EmptyMedia><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{description}</EmptyDescription></EmptyHeader>{action && onAction ? <EmptyContent><Button variant="outline" onClick={onAction}>{action}</Button></EmptyContent> : null}</Empty>
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
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [totpEnabled, setTotpEnabled] = useState(initiallyEnabled)
  const [totpPassword, setTotpPassword] = useState("")
  const [totpCode, setTotpCode] = useState("")
  const [totpSecret, setTotpSecret] = useState("")
  const [totpUri, setTotpUri] = useState("")
  const [deletionPassword, setDeletionPassword] = useState("")
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true)
    try { setSessions(await apiRequest<typeof sessions>("/v1/web/sessions")) }
    catch (cause) { setError(errorMessage(cause)) }
    finally { setSessionsLoading(false) }
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
      setTotpUri(setup.uri)
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }

  async function enableTotp() {
    setBusy(true); setError("")
    try {
      await apiRequest("/v1/web/auth/totp/enable", { method: "POST", csrf: true, body: JSON.stringify({ code: totpCode }) })
      setTotpEnabled(true); setTotpSecret(""); setTotpUri(""); setTotpPassword(""); setTotpCode("")
      toast.add({ title: "双因素认证已启用", description: "下次登录时需要输入验证器验证码。", type: "success" })
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
      toast.add({ title: "双因素认证已关闭", type: "success" })
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

  async function requestAccountDeletion() {
    setBusy(true)
    setError("")
    try {
      await apiRequest("/v1/web/account", {
        method: "DELETE",
        csrf: true,
        body: JSON.stringify({ password: deletionPassword, confirmation: "DELETE" }),
      })
      window.location.assign("/")
    } catch (cause) {
      setError(errorMessage(cause))
      setBusy(false)
    }
  }

  return (
    <div className="flex max-w-4xl flex-col gap-6">
    {error ? <ErrorAlert message={error} /> : null}
    <div className="grid gap-6 xl:grid-cols-2">
    <Card>
      <CardHeader>
        <CardTitle>修改密码</CardTitle>
        <CardDescription>修改后会撤销旧设备登录凭据并注销其他浏览器会话，当前浏览器会自动保持登录。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
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
        {sessionsLoading ? <div className="flex min-h-24 items-center justify-center" aria-label="正在加载浏览器会话" aria-busy="true"><Spinner /></div> : sessions.length ? <ItemGroup>{sessions.map((session) => (
          <Item key={session.id} variant="outline">
            <ItemMedia variant="icon"><LaptopIcon /></ItemMedia>
            <ItemContent><ItemTitle>{session.current ? "当前浏览器" : "其他浏览器"}</ItemTitle>
              <ItemDescription>{session.lastIp ?? "未知 IP"} · {formatDate(session.lastSeenAt)}<br />{session.userAgent ?? "未知浏览器"}</ItemDescription>
            </ItemContent>
            {session.current ? <ItemActions><Badge variant="secondary">当前</Badge></ItemActions> : null}
          </Item>
        ))}</ItemGroup> : <ActionEmpty icon={LaptopIcon} title="没有可显示的浏览器会话" description="刷新页面后仍为空时，请重新登录。" />}
        <Button variant="outline" disabled={busy || sessionsLoading || sessions.length === 0 || sessions.every((session) => session.current)} onClick={() => void logoutOtherSessions()}>
          注销其他浏览器
        </Button>
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle>双因素认证</CardTitle><CardDescription>使用任意兼容 TOTP 的验证器保护网页和客户端登录。</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Badge variant={totpEnabled ? "secondary" : "outline"}>{totpEnabled ? "已启用" : "未启用"}</Badge>
        <Field><FieldLabel htmlFor="totp-password">当前密码</FieldLabel><Input id="totp-password" type="password" autoComplete="current-password" value={totpPassword} onChange={(event) => setTotpPassword(event.target.value)} /></Field>
        {totpSecret ? <div className="flex flex-col items-center gap-4 rounded-lg border p-4"><div className="rounded-lg bg-white p-3"><QRCode value={totpUri} size={176} title="NoteGen 双因素认证二维码" /></div><Alert><ShieldCheckIcon /><AlertTitle>扫描二维码</AlertTitle><AlertDescription className="flex flex-col gap-2"><span>使用验证器应用扫描二维码，然后输入生成的 6 位验证码。</span><code className="break-all rounded bg-muted p-2 text-xs">{totpSecret}</code><Button type="button" size="sm" variant="outline" className="self-start" onClick={() => void navigator.clipboard.writeText(totpSecret).then(() => toast.add({ title: "密钥已复制", type: "success" })).catch(() => toast.add({ title: "复制失败", description: "请手动选择并复制密钥。", type: "error" }))}>复制密钥</Button></AlertDescription></Alert></div> : null}
        <Field><FieldLabel htmlFor="totp-security-code">6 位验证码</FieldLabel><Input id="totp-security-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totpCode} onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} /></Field>
        {totpEnabled ? (
          <Button variant="destructive" disabled={busy || totpPassword.length < 8 || totpCode.length !== 6} onClick={() => void disableTotp()}>关闭双因素认证</Button>
        ) : totpSecret ? (
          <div className="flex flex-wrap gap-2"><Button disabled={busy || totpCode.length !== 6} onClick={() => void enableTotp()}>确认并启用</Button><Button variant="ghost" disabled={busy} onClick={() => { setTotpSecret(""); setTotpUri(""); setTotpPassword(""); setTotpCode("") }}>取消设置</Button></div>
        ) : (
          <Button disabled={busy || totpPassword.length < 8} onClick={() => void beginTotpSetup()}>生成验证器密钥</Button>
        )}
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle>停用并删除账号</CardTitle><CardDescription>账号会立即停止登录并撤销设备凭据；数据进入实例配置的保留期，之后由维护任务清理。</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Alert variant="destructive"><Trash2Icon /><AlertTitle>此操作会中断所有设备同步</AlertTitle><AlertDescription>请先确认 NoteGen 本地数据完整。最后一个可用管理员不能删除自己的账号。</AlertDescription></Alert>
        <Field>
          <FieldLabel htmlFor="account-deletion-password">当前密码</FieldLabel>
          <Input id="account-deletion-password" type="password" autoComplete="current-password" minLength={8} maxLength={1024} value={deletionPassword} onChange={(event) => setDeletionPassword(event.target.value)} />
          <FieldDescription>输入密码后仍需在确认窗口中执行操作。</FieldDescription>
        </Field>
        <AlertDialog>
          <AlertDialogTrigger render={<Button variant="destructive" disabled={busy || deletionPassword.length < 8} />}>
            <Trash2Icon data-icon="inline-start" />停用并删除账号
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>确认停用并删除账号？</AlertDialogTitle>
              <AlertDialogDescription>所有浏览器和设备会立即退出，服务器数据将在保留期结束后清理。请确认本地数据已经保存。</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => void requestAccountDeletion()}>确认删除</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
    </div>
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
  adminView,
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
  onAdminViewChange,
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
  adminView: AdminDataView
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
  onAdminViewChange: (view: AdminDataView) => void
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
  const [queryDraft, setQueryDraft] = useState(query)
  useEffect(() => setQueryDraft(query), [query])

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

  async function exportData(scope: "accounts" | "workspaces" | "devices" | "audit") {
    setManagementError("")
    try {
      await downloadAdminExport(scope)
    } catch (cause) {
      setManagementError(errorMessage(cause))
    }
  }

  return (
    <>
      {error ? <ErrorAlert message={error} /> : null}
      {managementError ? <ErrorAlert message={managementError} /> : null}
      <ToggleGroup className="grid w-full grid-cols-2 sm:grid-cols-5" type="single" variant="outline" spacing={0} value={adminView} onValueChange={(value) => { if (value) onAdminViewChange(value as AdminDataView) }}>
        <ToggleGroupItem value="overview">总览</ToggleGroupItem>
        <ToggleGroupItem value="accounts">账号</ToggleGroupItem>
        <ToggleGroupItem value="data">同步数据</ToggleGroupItem>
        <ToggleGroupItem value="audit">审计</ToggleGroupItem>
        <ToggleGroupItem value="tools">运维</ToggleGroupItem>
      </ToggleGroup>
      {adminView !== "overview" && adminView !== "tools" ? <Card>
        <CardHeader>
          <CardTitle>查询与导出</CardTitle>
          <CardDescription>搜索账号、工作区 ID、设备或审计目标；导出文件不包含密码、令牌和解密密钥。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); onQueryChange(queryDraft.trim()) }}>
            <Input className="min-w-64 flex-1" value={queryDraft} placeholder="输入账号、设备或 ID" onChange={(event) => setQueryDraft(event.target.value)} />
            <Button type="submit" disabled={queryDraft.trim() === query}>搜索</Button>
            {query ? <Button type="button" variant="ghost" onClick={() => { setQueryDraft(""); onQueryChange("") }}>清除</Button> : null}
          </form>
          <div className="flex flex-wrap gap-2">
          {(["accounts", "workspaces", "devices", "audit"] as const).map((scope) => (
            <Button key={scope} size="sm" variant="outline" onClick={() => void exportData(scope)}>
              导出{scope === "accounts" ? "账号" : scope === "workspaces" ? "工作区" : scope === "devices" ? "设备" : "审计"}
            </Button>
          ))}
          </div>
        </CardContent>
      </Card> : null}
      {adminView === "overview" ? <Card>
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
      </Card> : null}

      <div className="grid items-start gap-6 2xl:grid-cols-2">
        {adminView === "accounts" ? <Card>
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
        </Card> : null}

        {adminView === "audit" ? <Card>
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
        </Card> : null}
      </div>

      {adminView === "data" ? <div className="grid items-start gap-6 2xl:grid-cols-2">
        <GlobalWorkspaceList workspaces={workspaces} total={workspaceTotal} offset={workspaceOffset} onPage={onWorkspacePage} onDelete={deleteGlobalWorkspace} onRestore={restoreGlobalWorkspace} />
        <GlobalDeviceList devices={devices} total={deviceTotal} offset={deviceOffset} onPage={onDevicePage} onRevoke={revokeGlobalDevice} />
      </div> : null}

      {adminView === "tools" ? <Card>
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
      </Card> : null}

      {adminView === "overview" ? <Card>
        <CardHeader><CardTitle>运行与存储状态</CardTitle><CardDescription>实时查看数据库响应、进程资源和同步数据规模。</CardDescription></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="服务运行" value={formatDuration(status?.uptimeSeconds ?? 0)} detail={`数据库响应 ${status?.databaseLatencyMs ?? 0} ms`} />
          <Metric label="数据库" value={formatBytes(status?.databaseBytes ?? "0")} detail={`${status?.versionCount ?? 0} 个版本 · ${status?.changeCount ?? 0} 条变更`} />
          <Metric label="对象与附件" value={formatBytes(status?.objectBytes ?? "0")} detail={`${status?.blobCount ?? 0} 个附件 · ${formatBytes(status?.blobBytes ?? "0")}`} />
          <Metric label="进程内存" value={formatBytes(status?.memoryRssBytes ?? "0")} detail={`堆内存 ${formatBytes(status?.heapUsedBytes ?? "0")}`} />
        </CardContent>
      </Card> : null}
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
  setBusy,
  onAuthenticated,
  onError,
}: {
  busy: boolean
  registrationMethods: string[]
  setBusy: (value: boolean) => void
  onAuthenticated: (account: Account) => Promise<void>
  onError: (message: string) => void
}) {
  const [mode, setMode] = useState<AuthMode>("login")
  const [step, setStep] = useState<AuthStep>("credentials")
  const [login, setLogin] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [setupToken, setSetupToken] = useState("")
  const [showRecoveryOptions, setShowRecoveryOptions] = useState(false)
  const [totpCode, setTotpCode] = useState("")
  const [notice, setNotice] = useState("")
  const [cooldownSeconds, setCooldownSeconds] = useState(0)
  const verificationAttempted = useRef(false)
  const token = readAuthToken()
  const canRegister = registrationMethods.some((method) => (
    method === "setup" || method === "password" || method === "email-password"
  ))
  const isAdministratorSetup = registrationMethods.includes("setup")

  useEffect(() => setStep(readInitialAuthStep()), [])
  useEffect(() => {
    if (!token || readInitialAuthStep() !== "verify" || verificationAttempted.current) return
    verificationAttempted.current = true
    setStep("verify")
    void verifyEmailToken()
    // The action token is immutable for this route; the ref prevents Strict Mode retries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])
  useEffect(() => {
    if (cooldownSeconds <= 0) return
    const timer = window.setTimeout(() => setCooldownSeconds((current) => Math.max(0, current - 1)), 1_000)
    return () => window.clearTimeout(timer)
  }, [cooldownSeconds])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    onError("")
    setNotice("")
    try {
      if (step === "forgot") {
        await apiRequest("/v1/web/auth/password-reset/request", {
          method: "POST",
          body: JSON.stringify({ email: login }),
        })
        setNotice("如果该邮箱已注册，重置链接会发送到邮箱。请检查收件箱和垃圾邮件。")
        setCooldownSeconds(60)
        return
      }
      if (step === "verify") {
        await verifyEmailToken()
        return
      }
      if (step === "reset") {
        if (password !== confirmPassword) {
          onError("两次输入的新密码不一致。")
          return
        }
        await apiRequest("/v1/web/auth/password-reset/complete", {
          method: "POST",
          body: JSON.stringify({ token, newPassword: password }),
        })
        const result = await apiRequest<{ account: Account }>("/v1/web/session")
        replaceAuthUrl()
        await onAuthenticated(result.account)
        window.location.assign("/")
        return
      }
      if (step === "verification-pending") {
        await apiRequest("/v1/web/auth/email/resend", {
          method: "POST",
          body: JSON.stringify({ email: login }),
        })
        setNotice("验证邮件已重新发送，请检查收件箱和垃圾邮件。")
        setCooldownSeconds(60)
        return
      }
      if (mode === "register" && password !== confirmPassword) {
        onError("两次输入的密码不一致。")
        return
      }
      if (mode === "register" && isAdministratorSetup) {
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
        : { login, password, ...(step === "totp" ? { totpCode: totpCode.trim() } : {}) }
      const result = await apiRequest<{ account: Account }>(`/v1/web/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify(body),
      })
      setPassword("")
      setSetupToken("")
      setTotpCode("")
      await onAuthenticated(result.account)
    } catch (cause) {
      if (isApiRequestError(cause) && cause.code === "totp_required" && step !== "totp") {
        setStep("totp")
        setTotpCode("")
        onError("")
        return
      }
      if (isApiRequestError(cause) && cause.code === "email_verification_required") {
        setStep("verification-pending")
        onError("")
        setNotice("登录前需要先验证邮箱。")
        return
      }
      onError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  async function verifyEmailToken() {
    setBusy(true)
    onError("")
    setNotice("")
    try {
      await apiRequest("/v1/web/auth/email/verify", {
        method: "POST",
        body: JSON.stringify({ token }),
      })
      setStep("credentials")
      setMode("login")
      setNotice("邮箱验证成功，现在可以登录。")
      replaceAuthUrl()
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="w-full shadow-none">
      <CardHeader>
        <CardTitle className="text-xl font-semibold tracking-tight">{authStepTitle(step)}</CardTitle>
        <CardDescription>
          {step === "totp" ? `输入 ${login} 的验证器验证码。`
            : step === "forgot" ? "输入注册邮箱，我们会发送一个限时重置链接。"
            : step === "reset" ? "设置新密码后会自动登录，并使旧登录凭据失效。"
            : step === "verify" ? busy ? "正在自动验证邮箱，请稍候。" : "自动验证未完成，你可以重新验证或返回登录。"
            : step === "verification-pending" ? `验证邮件已发送至 ${login || "你的邮箱"}。`
            : "同一账号可连接多个 NoteGen 设备。账号密码不会用于解密端到端加密工作区。"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {step === "credentials" ? <Tabs value={mode} onValueChange={(value) => { setMode(value as AuthMode); setConfirmPassword(""); setNotice(""); onError("") }}>
          {canRegister ? <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="login">登录</TabsTrigger>
            <TabsTrigger value="register">注册</TabsTrigger>
          </TabsList> : null}
          <TabsContent value={mode}>
            <form onSubmit={handleSubmit} className={cn(canRegister && "pt-2")}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="login">账号</FieldLabel>
                  <Input
                    id="login"
                    value={login}
                    onChange={(event) => setLogin(event.target.value)}
                    autoComplete="username"
                    maxLength={200}
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
                    maxLength={1024}
                    required
                  />
                  <FieldDescription>至少 8 个字符，仅用于账号登录；默认同步无需另设加密口令。</FieldDescription>
                </Field>
                {mode === "register" ? <Field data-invalid={confirmPassword.length > 0 && password !== confirmPassword || undefined}>
                  <FieldLabel htmlFor="registration-password-confirm">确认密码</FieldLabel>
                  <Input id="registration-password-confirm" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={8} maxLength={1024} aria-invalid={confirmPassword.length > 0 && password !== confirmPassword || undefined} required />
                  {confirmPassword.length > 0 && password !== confirmPassword ? <FieldDescription>两次输入的密码不一致。</FieldDescription> : null}
                </Field> : null}
                {mode === "register" && isAdministratorSetup && !showRecoveryOptions ? <Field>
                  <Button type="button" variant="ghost" className="self-start" onClick={() => setShowRecoveryOptions(true)}>高级恢复选项</Button>
                  <FieldDescription>仅灾备恢复时需要，正常创建管理员无需填写。</FieldDescription>
                </Field> : null}
                {mode === "register" && isAdministratorSetup && showRecoveryOptions ? (
                  <Field>
                    <FieldLabel htmlFor="setup-token">一次性恢复凭据（可选）</FieldLabel>
                    <Input
                      id="setup-token"
                      type="password"
                      value={setupToken}
                      onChange={(event) => setSetupToken(event.target.value)}
                      autoComplete="off"
                    />
                    <FieldDescription>仅灾备恢复场景填写本机 CLI 签发的一次性初始化凭据。</FieldDescription>
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
                  <Button className="w-full" type="submit" size="lg" disabled={busy || (mode === "register" && password !== confirmPassword)}>
                    {busy ? <Spinner data-icon="inline-start" /> : null}
                    {mode === "login" ? "登录" : "创建账号"}
                  </Button>
                </Field>
              </FieldGroup>
            </form>
          </TabsContent>
        </Tabs> : (
          <form onSubmit={handleSubmit}>
            <FieldGroup>
              {step === "totp" ? <Field><FieldLabel htmlFor="totp-code">6 位验证码</FieldLabel><Input id="totp-code" autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={totpCode} onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} required /><FieldDescription>请输入验证器当前显示的数字，验证码每 30 秒更新一次。</FieldDescription></Field> : null}
              {step === "forgot" ? <Field><FieldLabel htmlFor="recovery-email">邮箱</FieldLabel><Input id="recovery-email" type="email" autoFocus autoComplete="email" value={login} onChange={(event) => setLogin(event.target.value)} required /></Field> : null}
              {step === "reset" ? <><Field><FieldLabel htmlFor="reset-password">新密码</FieldLabel><Input id="reset-password" type="password" autoFocus autoComplete="new-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required /><FieldDescription>至少 8 个字符。</FieldDescription></Field><Field data-invalid={confirmPassword.length > 0 && password !== confirmPassword || undefined}><FieldLabel htmlFor="reset-password-confirm">确认新密码</FieldLabel><Input id="reset-password-confirm" type="password" autoComplete="new-password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} aria-invalid={confirmPassword.length > 0 && password !== confirmPassword || undefined} required />{confirmPassword.length > 0 && password !== confirmPassword ? <FieldDescription>两次输入的新密码不一致。</FieldDescription> : null}</Field></> : null}
              {step === "verify" && !token ? <Alert variant="destructive"><ShieldCheckIcon /><AlertTitle>验证链接不完整</AlertTitle><AlertDescription>请重新打开邮件中的完整链接。</AlertDescription></Alert> : null}
              {notice ? <Alert><CircleCheckIcon /><AlertTitle>操作已提交</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert> : null}
              <Field><div className="flex flex-wrap items-center gap-2"><Button type="submit" size="lg" disabled={busy || cooldownSeconds > 0 || (step === "totp" && totpCode.length !== 6) || ((step === "verify" || step === "reset") && !token) || (step === "reset" && password !== confirmPassword)}>{busy ? <Spinner data-icon="inline-start" /> : null}{cooldownSeconds > 0 && (step === "forgot" || step === "verification-pending") ? `${cooldownSeconds} 秒后可重试` : step === "totp" ? "验证并登录" : step === "forgot" ? "发送重置链接" : step === "reset" ? "重置密码" : step === "verify" ? "重新验证" : "重新发送邮件"}</Button><Button type="button" variant="ghost" onClick={() => { setStep("credentials"); setMode("login"); setPassword(""); setConfirmPassword(""); setTotpCode(""); setNotice(""); setCooldownSeconds(0); onError(""); replaceAuthUrl() }}>返回登录</Button></div></Field>
            </FieldGroup>
          </form>
        )}
      </CardContent>
    </Card>
  )
}

function authStepTitle(step: AuthStep): string {
  return ({ credentials: "连接你的同步账号", totp: "双因素验证", forgot: "找回密码", reset: "设置新密码", verify: "验证邮箱", "verification-pending": "检查你的邮箱" })[step]
}

function readInitialAuthStep(): AuthStep {
  if (typeof window === "undefined") return "credentials"
  if (window.location.pathname.startsWith("/account/verify-email")) return "verify"
  if (window.location.pathname.startsWith("/account/reset-password")) return "reset"
  return "credentials"
}

function readAuthToken(): string {
  return typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("token") ?? ""
}

function replaceAuthUrl() {
  window.history.replaceState(null, "", "/")
}

function redirectAfterAuth() {
  const next = new URLSearchParams(window.location.search).get("next")
  if (!next) return
  try {
    const target = new URL(next, window.location.origin)
    if (target.origin === window.location.origin && target.pathname.startsWith("/")) {
      window.location.assign(`${target.pathname}${target.search}${target.hash}`)
    }
  } catch {
    // Invalid redirect targets are ignored and the account portal remains open.
  }
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

function readAdminViewFromUrl(): AdminDataView {
  const value = readUrlParam("adminView")
  return value === "accounts" || value === "data" || value === "audit" || value === "tools" ? value : "overview"
}

function setOptionalParam(url: URL, name: string, value: string): void {
  if (value) url.searchParams.set(name, value)
  else url.searchParams.delete(name)
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg bg-muted/40 p-4">
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
    "workspace.restore": "恢复历史工作区",
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
