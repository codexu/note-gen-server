"use client"

import { useEffect, useMemo, useState, type FormEvent } from "react"
import {
  ActivityIcon,
  BadgeDollarSignIcon,
  Building2Icon,
  CalendarClockIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  DatabaseIcon,
  HeadsetIcon,
  KeyRoundIcon,
  LogInIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  UserRoundCogIcon,
  UsersIcon,
} from "lucide-react"

import { LanguageToggle } from "@/components/language-toggle"
import { useLocale, type Locale } from "@/components/locale-provider"
import {
  OperationsShell,
  permittedOperationsSections,
  type OperationsSection,
} from "@/components/operations-shell"
import { ThemeToggle } from "@/components/theme-toggle"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
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
import { apiRequest, isApiRequestError } from "@/lib/api"

export interface StaffProfile {
  id: string
  login: string
  displayName: string
  roles: string[]
  permissions: string[]
}

interface OperationsOverview {
  accountCount: number
  activeAccountCount: number
  newAccountCount: number
  activeSubscriptionCount: number
  openSupportCaseCount: number
  urgentSupportCaseCount: number
  reviewRiskEventCount: number
  pendingDataRequestCount: number
  activeStaffSessionCount: number
  generatedAt: string
}

interface OperationsAccount {
  id: string
  login: string
  identityState: string
  status: string
  workspaceCount: number
  deviceCount: number
  subscriptionStatus: string | null
  createdAt: string
}

interface SupportCase {
  id: string
  category: string
  severity: string
  status: string
  subject: string
  assignedStaffId: string | null
  lastMessageAt: string | null
  createdAt: string
  updatedAt: string
}

interface Subscription {
  id: string
  accountId: string | null
  accountLogin: string | null
  provider: string
  status: string
  isCurrent: boolean
  currentPeriodEnd: string | null
  createdAt: string
}

interface RiskEvent {
  id: string
  eventType: string
  accountId: string | null
  accountLogin: string | null
  outcome: string
  reasonCodes: string[]
  score: number | null
  createdAt: string
}

interface DataRequest {
  id: string
  accountId: string | null
  accountLogin: string | null
  type: string
  status: string
  requestChannel: string
  dueAt: string | null
  createdAt: string
}

const LOGIN_COPY = {
  "zh-CN": {
    product: "NoteGen 运营后台",
    realm: "独立运营账号",
    title: "登录运营管理后台",
    description: "使用安装时创建的运营管理员账号。客户账号无法登录这里。",
    login: "运营管理员账号",
    password: "密码",
    passwordDescription: "该凭据只属于运营权限域，不与客户账号共享。",
    submit: "进入运营后台",
    submitting: "正在登录",
    loading: "正在检查运营登录状态",
    failed: "操作未完成",
  },
  en: {
    product: "NoteGen Operations",
    realm: "Separate operations account",
    title: "Sign in to operations",
    description: "Use the operations administrator created during installation. Customer accounts cannot sign in here.",
    login: "Operations administrator account",
    password: "Password",
    passwordDescription: "This credential belongs only to the operations realm and is not shared with customer accounts.",
    submit: "Enter operations",
    submitting: "Signing in",
    loading: "Checking the operations session",
    failed: "The operation did not complete",
  },
} as const

export function OperationsPortal() {
  const { locale } = useLocale()
  const c = LOGIN_COPY[locale]
  const [profile, setProfile] = useState<StaffProfile | null>(null)
  const [login, setLogin] = useState("")
  const [password, setPassword] = useState("")
  const [section, setSection] = useState<OperationsSection>("overview")
  const [overview, setOverview] = useState<OperationsOverview | null>(null)
  const [accounts, setAccounts] = useState<OperationsAccount[]>([])
  const [supportCases, setSupportCases] = useState<SupportCase[]>([])
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [riskEvents, setRiskEvents] = useState<RiskEvent[]>([])
  const [dataRequests, setDataRequests] = useState<DataRequest[]>([])
  const [accountQuery, setAccountQuery] = useState("")
  const [appliedAccountQuery, setAppliedAccountQuery] = useState("")
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [dataLoading, setDataLoading] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [error, setError] = useState("")

  useEffect(() => {
    let active = true
    apiRequest<{ activationPending: boolean }>("/v1/installation/status")
      .then((status) => {
        if (status.activationPending) {
          window.location.replace("/")
          return null
        }
        return apiRequest<{ staff: StaffProfile }>("/v1/staff/session")
      })
      .then((result) => {
        if (!active || result === null) return
        setProfile(result.staff)
        setSection(permittedOperationsSections(result.staff)[0] ?? "access")
      })
      .catch((cause) => {
        if (active && (!isApiRequestError(cause) || cause.status !== 401)) setError(staffErrorMessage(cause, locale))
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [locale])

  useEffect(() => {
    if (profile === null || section === "access") return
    let active = true
    setDataLoading(true)
    setError("")
    const request = section === "overview"
      ? apiRequest<OperationsOverview>("/v1/staff/operations/overview").then(setOverview)
      : section === "accounts"
        ? apiRequest<OperationsAccount[]>(`/v1/staff/operations/accounts?limit=100&query=${encodeURIComponent(appliedAccountQuery)}`).then(setAccounts)
        : section === "support"
          ? apiRequest<SupportCase[]>("/v1/staff/operations/support/cases").then(setSupportCases)
          : section === "billing"
            ? apiRequest<Subscription[]>("/v1/staff/operations/billing/subscriptions?limit=100").then(setSubscriptions)
            : section === "risk"
              ? apiRequest<RiskEvent[]>("/v1/staff/operations/risk/events?limit=100").then(setRiskEvents)
              : apiRequest<DataRequest[]>("/v1/staff/operations/compliance/requests?limit=100").then(setDataRequests)
    request.catch((cause) => {
      if (!active) return
      if (isApiRequestError(cause) && cause.status === 401) setProfile(null)
      setError(staffErrorMessage(cause, locale))
    }).finally(() => { if (active) setDataLoading(false) })
    return () => { active = false }
  }, [profile, section, appliedAccountQuery, refreshVersion, locale])

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      const result = await apiRequest<{ staff: StaffProfile }>("/v1/staff/auth/login", {
        method: "POST",
        body: JSON.stringify({ login, password }),
      })
      setPassword("")
      setProfile(result.staff)
      setSection(permittedOperationsSections(result.staff)[0] ?? "access")
    } catch (cause) {
      setError(staffErrorMessage(cause, locale))
    } finally {
      setBusy(false)
    }
  }

  async function handleLogout() {
    setBusy(true)
    setError("")
    try {
      await apiRequest<void>("/v1/staff/auth/logout", { method: "POST", csrf: true })
      setProfile(null)
      setOverview(null)
    } catch (cause) {
      setError(staffErrorMessage(cause, locale))
    } finally {
      setBusy(false)
    }
  }

  const counts = useMemo(() => ({
    accounts: overview?.accountCount,
    support: overview?.openSupportCaseCount,
    billing: overview?.activeSubscriptionCount,
    risk: overview?.reviewRiskEventCount,
    compliance: overview?.pendingDataRequestCount,
  }), [overview])

  if (loading) return <LoginFrame><Card className="w-full max-w-xl"><CardContent className="flex min-h-56 items-center justify-center gap-2 text-muted-foreground"><Spinner />{c.loading}</CardContent></Card></LoginFrame>
  if (profile === null) return (
    <LoginFrame>
      <Card className="w-full max-w-xl shadow-sm">
        <CardHeader>
          <Badge className="mb-3 w-fit" variant="secondary"><ShieldCheckIcon />{c.realm}</Badge>
          <CardTitle className="text-xl">{c.title}</CardTitle>
          <CardDescription>{c.description}</CardDescription>
        </CardHeader>
        <form onSubmit={handleLogin}>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="operations-login">{c.login}</FieldLabel>
                <Input id="operations-login" value={login} onChange={(event) => setLogin(event.target.value)} autoComplete="username" maxLength={200} required />
              </Field>
              <Field>
                <FieldLabel htmlFor="operations-password">{c.password}</FieldLabel>
                <Input id="operations-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" minLength={8} maxLength={1024} required />
                <FieldDescription>{c.passwordDescription}</FieldDescription>
              </Field>
              {error ? <Alert variant="destructive"><KeyRoundIcon /><AlertTitle>{c.failed}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
              <Field orientation="horizontal" className="justify-end">
                <Button type="submit" size="lg" disabled={busy || login.trim().length === 0 || password.length < 8}>
                  {busy ? <Spinner data-icon="inline-start" /> : <LogInIcon data-icon="inline-start" />}
                  {busy ? c.submitting : c.submit}
                </Button>
              </Field>
            </FieldGroup>
          </CardContent>
        </form>
      </Card>
    </LoginFrame>
  )

  return (
    <OperationsShell
      profile={profile}
      section={section}
      counts={counts}
      busy={busy || dataLoading}
      onSectionChange={setSection}
      onRefresh={() => setRefreshVersion((value) => value + 1)}
      onLogout={() => void handleLogout()}
    >
      {error ? <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>{c.failed}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      {dataLoading ? <LoadingPanel /> : null}
      {!dataLoading && section === "overview" ? <OverviewPanel overview={overview} locale={locale} onNavigate={setSection} /> : null}
      {!dataLoading && section === "accounts" ? <AccountsPanel accounts={accounts} query={accountQuery} locale={locale} onQueryChange={setAccountQuery} onSearch={() => setAppliedAccountQuery(accountQuery.trim())} /> : null}
      {!dataLoading && section === "support" ? <SupportPanel cases={supportCases} locale={locale} /> : null}
      {!dataLoading && section === "billing" ? <BillingPanel subscriptions={subscriptions} locale={locale} /> : null}
      {!dataLoading && section === "risk" ? <RiskPanel events={riskEvents} locale={locale} /> : null}
      {!dataLoading && section === "compliance" ? <CompliancePanel requests={dataRequests} locale={locale} /> : null}
      {section === "access" ? <AccessPanel profile={profile} locale={locale} /> : null}
    </OperationsShell>
  )
}

function LoginFrame({ children }: { children: React.ReactNode }) {
  const { locale } = useLocale()
  const c = LOGIN_COPY[locale]
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-7xl flex-col gap-6 p-5 md:justify-center md:p-8 xl:p-10">
      <header className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground"><Building2Icon /></span>
          <div className="min-w-0"><h1 className="truncate text-lg font-semibold">{c.product}</h1><p className="truncate text-sm text-muted-foreground">{c.realm}</p></div>
        </div>
        <div className="flex shrink-0 items-center gap-1"><LanguageToggle /><ThemeToggle /></div>
      </header>
      <div className="flex justify-center">{children}</div>
    </main>
  )
}

function LoadingPanel() {
  return <Card><CardContent className="flex min-h-64 items-center justify-center gap-2 text-muted-foreground"><Spinner />正在加载运营数据</CardContent></Card>
}

function OverviewPanel({ overview, locale, onNavigate }: { overview: OperationsOverview | null, locale: Locale, onNavigate: (section: OperationsSection) => void }) {
  if (overview === null) return <NoticeCard title={locale === "zh-CN" ? "暂无总览数据" : "No overview data"} />
  const metrics = [
    { label: locale === "zh-CN" ? "客户账号" : "Customer accounts", value: overview.accountCount, helper: `${overview.activeAccountCount} ${locale === "zh-CN" ? "个可用" : "active"}`, icon: UsersIcon, section: "accounts" as const },
    { label: locale === "zh-CN" ? "近 7 天新增" : "New in 7 days", value: overview.newAccountCount, helper: locale === "zh-CN" ? "新增客户" : "new customers", icon: ActivityIcon, section: "accounts" as const },
    { label: locale === "zh-CN" ? "有效订阅" : "Active subscriptions", value: overview.activeSubscriptionCount, helper: locale === "zh-CN" ? "含试用与宽限期" : "including trial and grace", icon: BadgeDollarSignIcon, section: "billing" as const },
    { label: locale === "zh-CN" ? "待处理工单" : "Open support cases", value: overview.openSupportCaseCount, helper: `${overview.urgentSupportCaseCount} ${locale === "zh-CN" ? "个紧急" : "urgent"}`, icon: HeadsetIcon, section: "support" as const },
  ]
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => {
          const Icon = metric.icon
          return <Card key={metric.label} className="cursor-pointer" onClick={() => onNavigate(metric.section)}><CardHeader><CardDescription>{metric.label}</CardDescription><CardAction><Icon /></CardAction><CardTitle className="text-3xl tabular-nums">{metric.value}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">{metric.helper}</CardContent></Card>
        })}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2"><CardHeader><CardTitle>{locale === "zh-CN" ? "待办与风险" : "Queues and risk"}</CardTitle><CardDescription>{locale === "zh-CN" ? "需要运营团队持续关注的跨域队列。" : "Cross-domain queues that need operations attention."}</CardDescription></CardHeader><CardContent><ItemGroup>
          <QueueItem icon={ShieldAlertIcon} title={locale === "zh-CN" ? "近 24 小时风险信号" : "Risk signals in 24 hours"} value={overview.reviewRiskEventCount} locale={locale} onClick={() => onNavigate("risk")} />
          <QueueItem icon={CalendarClockIcon} title={locale === "zh-CN" ? "待处理合规请求" : "Pending compliance requests"} value={overview.pendingDataRequestCount} locale={locale} onClick={() => onNavigate("compliance")} />
          <QueueItem icon={HeadsetIcon} title={locale === "zh-CN" ? "紧急支持工单" : "Urgent support cases"} value={overview.urgentSupportCaseCount} locale={locale} onClick={() => onNavigate("support")} />
        </ItemGroup></CardContent></Card>
        <Card><CardHeader><CardTitle>{locale === "zh-CN" ? "运营状态" : "Operations status"}</CardTitle><CardDescription>{formatDate(overview.generatedAt, locale)}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3"><div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">{locale === "zh-CN" ? "运营会话" : "Staff sessions"}</span><Badge variant="outline">{overview.activeStaffSessionCount}</Badge></div><div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">{locale === "zh-CN" ? "控制台状态" : "Console status"}</span><Badge variant="secondary"><CircleCheckIcon />{locale === "zh-CN" ? "正常" : "Healthy"}</Badge></div></CardContent></Card>
      </div>
    </div>
  )
}

function QueueItem({ icon: Icon, title, value, locale, onClick }: { icon: typeof UsersIcon, title: string, value: number, locale: Locale, onClick: () => void }) {
  const description = value === 0
    ? (locale === "zh-CN" ? "当前队列为空" : "The queue is currently empty")
    : (locale === "zh-CN" ? "点击进入队列查看详情" : "Open the queue to review details")
  return <Item variant="outline" render={<button type="button" onClick={onClick} />}><ItemMedia variant="icon"><Icon /></ItemMedia><ItemContent><ItemTitle>{title}</ItemTitle><ItemDescription>{description}</ItemDescription></ItemContent><ItemActions><Badge variant={value > 0 ? "secondary" : "outline"}>{value}</Badge></ItemActions></Item>
}

function AccountsPanel({ accounts, query, locale, onQueryChange, onSearch }: { accounts: OperationsAccount[], query: string, locale: Locale, onQueryChange: (value: string) => void, onSearch: () => void }) {
  return <Card><CardHeader><CardTitle>{locale === "zh-CN" ? "客户账号目录" : "Customer account directory"}</CardTitle><CardDescription>{locale === "zh-CN" ? "按登录名检索，查看账号可用性、工作区、设备和当前订阅。" : "Search by login and inspect availability, workspaces, devices, and subscription."}</CardDescription></CardHeader><CardContent className="flex flex-col gap-5"><form className="flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); onSearch() }}><Input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={locale === "zh-CN" ? "输入账号或邮箱" : "Enter account or email"} maxLength={200} /><Button type="submit">{locale === "zh-CN" ? "搜索" : "Search"}</Button></form><RecordList empty={accounts.length === 0} locale={locale}>{accounts.map((account) => <Item key={account.id} variant="outline"><ItemMedia variant="icon"><UserRoundCogIcon /></ItemMedia><ItemContent><ItemTitle>{account.login}</ItemTitle><ItemDescription>{formatDate(account.createdAt, locale)} · {account.workspaceCount} {locale === "zh-CN" ? "个工作区" : "workspaces"} · {account.deviceCount} {locale === "zh-CN" ? "台设备" : "devices"}</ItemDescription></ItemContent><ItemActions><Badge variant="outline">{account.subscriptionStatus ?? (locale === "zh-CN" ? "无订阅" : "No subscription")}</Badge><StatusBadge value={account.status} /></ItemActions></Item>)}</RecordList></CardContent></Card>
}

function SupportPanel({ cases, locale }: { cases: SupportCase[], locale: Locale }) {
  return <RecordCard title={locale === "zh-CN" ? "客户支持队列" : "Customer support queue"} description={locale === "zh-CN" ? "优先处理紧急、未分配和等待支持的工单。" : "Prioritize urgent, unassigned, and waiting cases."} empty={cases.length === 0} locale={locale}>{cases.map((item) => <Item key={item.id} variant="outline"><ItemMedia variant="icon"><HeadsetIcon /></ItemMedia><ItemContent><ItemTitle>{item.subject}</ItemTitle><ItemDescription>{item.category} · {formatDate(item.updatedAt, locale)} · {item.assignedStaffId ? (locale === "zh-CN" ? "已分配" : "Assigned") : (locale === "zh-CN" ? "未分配" : "Unassigned")}</ItemDescription></ItemContent><ItemActions><Badge variant={item.severity === "urgent" ? "destructive" : "outline"}>{item.severity}</Badge><StatusBadge value={item.status} /></ItemActions></Item>)}</RecordCard>
}

function BillingPanel({ subscriptions, locale }: { subscriptions: Subscription[], locale: Locale }) {
  return <RecordCard title={locale === "zh-CN" ? "订阅生命周期" : "Subscription lifecycle"} description={locale === "zh-CN" ? "展示最近更新的订阅记录，便于核对支付侧与账号侧状态。" : "Recently updated subscriptions for provider and account-side reconciliation."} empty={subscriptions.length === 0} locale={locale}>{subscriptions.map((item) => <Item key={item.id} variant="outline"><ItemMedia variant="icon"><BadgeDollarSignIcon /></ItemMedia><ItemContent><ItemTitle>{item.accountLogin ?? (locale === "zh-CN" ? "已脱离账号" : "Detached account")}</ItemTitle><ItemDescription>{item.provider} · {item.currentPeriodEnd ? `${locale === "zh-CN" ? "周期至" : "Period ends"} ${formatDate(item.currentPeriodEnd, locale)}` : formatDate(item.createdAt, locale)}</ItemDescription></ItemContent><ItemActions>{item.isCurrent ? <Badge variant="secondary">{locale === "zh-CN" ? "当前" : "Current"}</Badge> : null}<StatusBadge value={item.status} /></ItemActions></Item>)}</RecordCard>
}

function RiskPanel({ events, locale }: { events: RiskEvent[], locale: Locale }) {
  return <RecordCard title={locale === "zh-CN" ? "近期风险事件" : "Recent risk events"} description={locale === "zh-CN" ? "按时间查看认证、设备、同步和计费域的风险决策。" : "Chronological risk decisions across authentication, device, sync, and billing."} empty={events.length === 0} locale={locale}>{events.map((item) => <Item key={item.id} variant="outline"><ItemMedia variant="icon"><ShieldAlertIcon /></ItemMedia><ItemContent><ItemTitle>{item.eventType}</ItemTitle><ItemDescription>{item.accountLogin ?? (locale === "zh-CN" ? "匿名主体" : "Anonymous subject")} · {formatDate(item.createdAt, locale)}{item.reasonCodes.length ? ` · ${item.reasonCodes.join(", ")}` : ""}</ItemDescription></ItemContent><ItemActions>{item.score !== null ? <Badge variant="outline">{locale === "zh-CN" ? "分值" : "Score"} {item.score}</Badge> : null}<StatusBadge value={item.outcome} /></ItemActions></Item>)}</RecordCard>
}

function CompliancePanel({ requests, locale }: { requests: DataRequest[], locale: Locale }) {
  return <RecordCard title={locale === "zh-CN" ? "数据主体请求" : "Data subject requests"} description={locale === "zh-CN" ? "跟踪访问、导出、更正、删除与限制处理请求。" : "Track access, export, correction, deletion, and restriction requests."} empty={requests.length === 0} locale={locale}>{requests.map((item) => <Item key={item.id} variant="outline"><ItemMedia variant="icon"><CalendarClockIcon /></ItemMedia><ItemContent><ItemTitle>{item.accountLogin ?? (locale === "zh-CN" ? "已匿名化主体" : "Anonymized subject")}</ItemTitle><ItemDescription>{item.type} · {item.requestChannel} · {item.dueAt ? `${locale === "zh-CN" ? "截止" : "Due"} ${formatDate(item.dueAt, locale)}` : formatDate(item.createdAt, locale)}</ItemDescription></ItemContent><ItemActions><StatusBadge value={item.status} /></ItemActions></Item>)}</RecordCard>
}

function AccessPanel({ profile, locale }: { profile: StaffProfile, locale: Locale }) {
  return <div className="grid gap-4 lg:grid-cols-2"><Card><CardHeader><CardTitle className="flex items-center gap-2"><UserRoundCogIcon />{locale === "zh-CN" ? "当前运营管理员" : "Current operations administrator"}</CardTitle><CardDescription>{profile.login}</CardDescription></CardHeader><CardContent className="flex flex-col gap-4"><div><p className="font-medium">{profile.displayName}</p><p className="text-sm text-muted-foreground">{locale === "zh-CN" ? "运营身份与客户身份独立存储。" : "Operations and customer identities are stored separately."}</p></div><div className="flex flex-wrap gap-2">{profile.roles.map((role) => <Badge key={role} variant="secondary">{role}</Badge>)}</div></CardContent></Card><Card><CardHeader><CardTitle className="flex items-center gap-2"><KeyRoundIcon />{locale === "zh-CN" ? "已授权能力" : "Granted capabilities"}</CardTitle><CardDescription>{profile.permissions.length}</CardDescription></CardHeader><CardContent className="flex flex-wrap gap-2">{profile.permissions.map((permission) => <Badge key={permission} variant="outline">{permission}</Badge>)}</CardContent></Card><Alert className="lg:col-span-2"><ShieldCheckIcon /><AlertTitle>{locale === "zh-CN" ? "内部测试认证" : "Internal-test authentication"}</AlertTitle><AlertDescription>{locale === "zh-CN" ? "当前使用本地运营凭据。正式环境接入企业身份登录后，客户账号体系仍保持独立。" : "Local operations credentials are active. Customer identities remain separate when enterprise sign-in is connected."}</AlertDescription></Alert></div>
}

function RecordCard({ title, description, empty, locale, children }: { title: string, description: string, empty: boolean, locale: Locale, children: React.ReactNode }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader><CardContent><RecordList empty={empty} locale={locale}>{children}</RecordList></CardContent></Card>
}

function RecordList({ empty, locale, children }: { empty: boolean, locale: Locale, children: React.ReactNode }) {
  if (empty) return <Empty className="min-h-48 border"><EmptyHeader><EmptyMedia variant="icon"><DatabaseIcon /></EmptyMedia><EmptyTitle>{locale === "zh-CN" ? "当前没有记录" : "No records right now"}</EmptyTitle><EmptyDescription>{locale === "zh-CN" ? "有新数据后会自动出现在这里。" : "New data will appear here when available."}</EmptyDescription></EmptyHeader></Empty>
  return <ItemGroup>{children}</ItemGroup>
}

function NoticeCard({ title }: { title: string }) {
  return <Card><CardContent className="flex min-h-48 items-center justify-center text-muted-foreground">{title}</CardContent></Card>
}

function StatusBadge({ value }: { value: string }) {
  const positive = ["active", "trialing", "resolved", "completed", "allow", "ok"].includes(value)
  return <Badge variant={positive ? "secondary" : "outline"}>{value}</Badge>
}

function formatDate(value: string, locale: Locale): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return locale === "zh-CN" ? "未知时间" : "Unknown time"
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date)
}

function staffErrorMessage(cause: unknown, locale: Locale): string {
  if (isApiRequestError(cause)) {
    const zh: Record<string, string> = {
      staff_credentials_invalid: "运营管理员账号或密码不正确。",
      staff_session_invalid: "运营登录状态已过期，请重新登录。",
      staff_permission_denied: "当前运营角色无权访问这个工作区。",
      staff_local_auth_unavailable: "当前实例未启用运营模式的内部测试登录。",
      csrf_invalid: "页面安全凭据已过期，请刷新后重试。",
      origin_not_allowed: "当前页面地址未被服务器信任，请检查 Web 地址配置。",
      rate_limited: "操作过于频繁，请稍后再试。",
    }
    const en: Record<string, string> = {
      staff_credentials_invalid: "The operations administrator account or password is incorrect.",
      staff_session_invalid: "The operations session has expired. Sign in again.",
      staff_permission_denied: "The current operations role cannot access this workspace.",
      staff_local_auth_unavailable: "Internal-test operations sign-in is not enabled for this instance.",
      csrf_invalid: "The page security credential has expired. Refresh and try again.",
      origin_not_allowed: "This page origin is not trusted by the server. Check the Web URL configuration.",
      rate_limited: "There have been too many requests. Try again later.",
    }
    const message = (locale === "zh-CN" ? zh : en)[cause.code]
    if (message) return message
    return locale === "zh-CN" ? `请求未完成（HTTP ${cause.status}）。` : `The request did not complete (HTTP ${cause.status}).`
  }
  return locale === "zh-CN" ? "无法连接同步服务器，请确认服务已启动。" : "Could not connect to the sync server. Make sure it is running."
}
