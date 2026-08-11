"use client"

import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  Building2Icon,
  CheckIcon,
  Globe2Icon,
  ServerIcon,
  Settings2Icon,
  ShieldCheckIcon,
  UserRoundCogIcon,
} from "lucide-react"

import { LanguageToggle } from "@/components/language-toggle"
import { useLocale, type Locale } from "@/components/locale-provider"
import { ThemeToggle } from "@/components/theme-toggle"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { apiRequest, isApiRequestError } from "@/lib/api"

export interface InstallationStatus {
  installationRequired: boolean
  activationPending: boolean
  deploymentMode: "self-hosted" | "hosted" | null
  serverName: string
}

type DeploymentMode = "self-hosted" | "hosted"
type RegistrationPolicy = "disabled" | "public"

const COPY = {
  "zh-CN": {
    product: "NoteGen 同步服务器",
    guide: "Web 安装向导",
    firstInstall: "首次安装",
    steps: ["部署模式", "实例配置", "确认安装"],
    stepDescriptions: ["确定服务运行方式", "填写实例初始信息", "核对并写入数据库"],
    modeTitle: "选择部署模式",
    modeDescription: "部署模式决定账号体系、管理权限和可用服务。",
    modeLabel: "使用方式",
    selfHosted: "自托管",
    selfHostedDescription: "适合个人、家庭或社区，自主管理账号与数据。",
    hosted: "运营模式",
    hostedDescription: "适合平台运营，目前使用安全的内部测试适配器。",
    immutableMode: "初始化完成后，当前数据库不能直接切换部署模式。",
    configurationTitle: "配置实例信息",
    selfHostedConfigurationDescription: "设置服务名称并创建首位管理员。",
    hostedConfigurationDescription: "设置服务名称、创建首位运营管理员，并选择客户注册策略。",
    serverName: "服务名称",
    serverNameDescription: "显示在登录页和客户端连接信息中，之后可在后台修改。",
    administratorLogin: "管理员账号",
    administratorPassword: "管理员密码",
    passwordDescription: "至少 8 个字符。安装完成后使用此账号登录 Web 管理后台。",
    operationsAdministratorLogin: "运营管理员账号",
    operationsAdministratorPassword: "运营管理员密码",
    operationsPasswordDescription: "至少 8 个字符。此账号只用于运营后台，不是客户账号。",
    registration: "新用户注册",
    disabled: "关闭",
    public: "公开",
    registrationDescription: "运营人员使用独立的 Staff 权限域，不会成为客户账号管理员。",
    internalTitle: "内部测试配置",
    internalDescription: "计费使用 Mock，邮件写入脱敏日志，不会真实扣款或投递邮件。",
    reviewTitle: "确认安装配置",
    reviewDescription: "请检查下面的信息。提交后部署模式将固化到数据库。",
    reviewMode: "部署模式",
    reviewServer: "服务名称",
    reviewAdministrator: "初始管理员",
    reviewOperationsAdministrator: "首位运营管理员",
    reviewRegistration: "注册策略",
    beforePublicTitle: "请先安装，再开放公网服务",
    beforePublicDescription: "空实例允许首位访问者完成初始化。完成本向导后，再配置公网反向代理或开放端口。",
    back: "上一步",
    continue: "继续",
    install: "保存并完成初始化",
    installing: "正在初始化",
    failed: "安装失败",
    saved: "安装配置已保存",
    activatingTitle: "正在启动",
    activatingDescription: (mode: DeploymentMode) => `正在启用${mode === "hosted" ? "运营模式" : "自托管模式"}。`,
  },
  en: {
    product: "NoteGen Sync Server",
    guide: "Web installation guide",
    firstInstall: "First-time setup",
    steps: ["Deployment", "Instance setup", "Review"],
    stepDescriptions: ["Select how the service runs", "Enter the initial settings", "Review and save to the database"],
    modeTitle: "Choose a deployment mode",
    modeDescription: "The deployment mode determines the account model, administrative permissions, and available services.",
    modeLabel: "Deployment type",
    selfHosted: "Self-hosted",
    selfHostedDescription: "For individuals, families, or communities that manage their own accounts and data.",
    hosted: "Operations mode",
    hostedDescription: "For a managed platform. Safe internal-test adapters are currently used.",
    immutableMode: "The deployment mode cannot be changed in this database after installation.",
    configurationTitle: "Configure the instance",
    selfHostedConfigurationDescription: "Name the service and create the first administrator.",
    hostedConfigurationDescription: "Name the service, create the first operations administrator, and choose the customer registration policy.",
    serverName: "Service name",
    serverNameDescription: "Shown on the sign-in page and in client connection details. It can be changed later.",
    administratorLogin: "Administrator account",
    administratorPassword: "Administrator password",
    passwordDescription: "Use at least 8 characters. This account signs in to the Web administration portal.",
    operationsAdministratorLogin: "Operations administrator account",
    operationsAdministratorPassword: "Operations administrator password",
    operationsPasswordDescription: "Use at least 8 characters. This account is only for the operations portal and is not a customer account.",
    registration: "New user registration",
    disabled: "Disabled",
    public: "Public",
    registrationDescription: "Operators use a separate Staff permission realm and are not customer account administrators.",
    internalTitle: "Internal-test configuration",
    internalDescription: "Billing uses a mock provider and mail goes to a redacted log. No real charge or delivery occurs.",
    reviewTitle: "Review installation",
    reviewDescription: "Check the settings below. Submitting will make the deployment mode permanent for this database.",
    reviewMode: "Deployment mode",
    reviewServer: "Service name",
    reviewAdministrator: "Initial administrator",
    reviewOperationsAdministrator: "First operations administrator",
    reviewRegistration: "Registration policy",
    beforePublicTitle: "Install before exposing the service",
    beforePublicDescription: "The first visitor to an empty instance can initialize it. Finish this guide before configuring a public reverse proxy or opening the port.",
    back: "Back",
    continue: "Continue",
    install: "Save and finish installation",
    installing: "Installing",
    failed: "Installation failed",
    saved: "Installation settings saved",
    activatingTitle: "Starting",
    activatingDescription: (mode: DeploymentMode) => `${mode === "hosted" ? "Operations mode" : "Self-hosted mode"} is being enabled.`,
  },
} as const

export function InstallationGuide({
  initialStatus,
  onStatusChange,
}: {
  initialStatus: InstallationStatus
  onStatusChange: (status: InstallationStatus) => void
}) {
  const { locale } = useLocale()
  const c = COPY[locale]
  const [step, setStep] = useState(0)
  const [deploymentMode, setDeploymentMode] = useState<DeploymentMode>("self-hosted")
  const [registrationPolicy, setRegistrationPolicy] = useState<RegistrationPolicy>("disabled")
  const [serverName, setServerName] = useState(initialStatus.serverName)
  const [login, setLogin] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!initialStatus.activationPending) return
    let active = true
    const installedMode = initialStatus.deploymentMode ?? "self-hosted"
    const checkReady = async () => {
      try {
        const status = await apiRequest<InstallationStatus>("/v1/installation/status")
        if (active && !status.activationPending) {
          window.location.assign(installedMode === "hosted" ? "/operations/" : "/")
        }
      } catch {
        // The API is briefly unavailable while it replaces the installation app.
      }
    }
    void checkReady()
    const timer = window.setInterval(() => void checkReady(), 500)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [initialStatus.activationPending, initialStatus.deploymentMode])

  const canContinue = step !== 1 || (
    serverName.trim().length > 0
    && login.trim().length > 0
    && password.length >= 8
  )

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (step < 2) {
      setStep((current) => Math.min(2, current + 1))
      return
    }
    setBusy(true)
    setError("")
    try {
      const result = await apiRequest<{
        deploymentMode: DeploymentMode
        serverName: string
        activationPending: true
      }>("/v1/installation/complete", {
        method: "POST",
        body: JSON.stringify({
          deploymentMode,
          serverName,
          administrator: { login, password },
          ...(deploymentMode === "hosted" ? { hostedRegistrationPolicy: registrationPolicy } : {}),
        }),
      })
      setPassword("")
      onStatusChange({
        installationRequired: false,
        activationPending: result.activationPending,
        deploymentMode: result.deploymentMode,
        serverName: result.serverName,
      })
    } catch (cause) {
      setError(installationErrorMessage(cause, locale))
    } finally {
      setBusy(false)
    }
  }

  if (initialStatus.activationPending) {
    const installedMode = initialStatus.deploymentMode ?? "self-hosted"
    return (
      <InstallationLayout>
        <Card className="mx-auto w-full max-w-4xl shadow-sm">
          <CardHeader>
            <Badge className="mb-3 w-fit" variant="secondary">{c.saved}</Badge>
            <CardTitle className="flex items-center gap-2 text-xl"><Spinner />{c.activatingTitle}</CardTitle>
            <CardDescription>{c.activatingDescription(installedMode)}</CardDescription>
          </CardHeader>
        </Card>
      </InstallationLayout>
    )
  }

  return (
    <InstallationLayout>
      <Card className="mx-auto w-full max-w-6xl shadow-sm">
        <CardHeader>
          <Badge className="mb-3 w-fit" variant="secondary">{c.firstInstall}</Badge>
          <CardTitle className="text-xl">{c.steps[step]}</CardTitle>
          <CardDescription className="break-words">{c.stepDescriptions[step]}</CardDescription>
        </CardHeader>
        <Separator />
        <form onSubmit={handleSubmit}>
          <CardContent className="grid min-h-120 gap-8 py-2 lg:grid-cols-[17rem_minmax(0,1fr)]">
            <nav aria-label={locale === "zh-CN" ? "安装步骤" : "Installation steps"}>
              <ol className="grid grid-cols-3 gap-2 lg:grid-cols-1 lg:gap-4">
                {c.steps.map((label, index) => (
                  <li className="flex min-w-0 items-start gap-3" key={label}>
                    <Badge variant={index === step ? "default" : "secondary"}>
                      {index < step ? <CheckIcon /> : index + 1}
                    </Badge>
                    <span className="hidden min-w-0 lg:grid lg:gap-0.5">
                      <span className="truncate font-medium">{label}</span>
                      <span className="break-words text-xs text-muted-foreground">{c.stepDescriptions[index]}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </nav>
            <div className="min-w-0">
              {step === 0 ? (
                <StepSection title={c.modeTitle} description={c.modeDescription} icon={ServerIcon}>
                  <FieldGroup>
                    <Field>
                      <FieldLabel>{c.modeLabel}</FieldLabel>
                      <ToggleGroup
                        className="grid w-full grid-cols-1 gap-3 md:grid-cols-2"
                        value={[deploymentMode]}
                        onValueChange={(values) => {
                          const value = values[0]
                          if (value === "self-hosted" || value === "hosted") setDeploymentMode(value)
                        }}
                      >
                        <ToggleGroupItem className="h-full min-w-0 items-start justify-start gap-3 whitespace-normal p-5 text-left" value="self-hosted" variant="outline">
                          <ServerIcon />
                          <span className="grid min-w-0 flex-1 gap-1">
                            <span className="break-words font-medium">{c.selfHosted}</span>
                            <span className="break-words whitespace-normal text-xs leading-relaxed text-muted-foreground">{c.selfHostedDescription}</span>
                          </span>
                        </ToggleGroupItem>
                        <ToggleGroupItem className="h-full min-w-0 items-start justify-start gap-3 whitespace-normal p-5 text-left" value="hosted" variant="outline">
                          <Building2Icon />
                          <span className="grid min-w-0 flex-1 gap-1">
                            <span className="break-words font-medium">{c.hosted}</span>
                            <span className="break-words whitespace-normal text-xs leading-relaxed text-muted-foreground">{c.hostedDescription}</span>
                          </span>
                        </ToggleGroupItem>
                      </ToggleGroup>
                      <FieldDescription>{c.immutableMode}</FieldDescription>
                    </Field>
                  </FieldGroup>
                </StepSection>
              ) : null}

              {step === 1 ? (
                <StepSection
                  title={c.configurationTitle}
                  description={deploymentMode === "self-hosted" ? c.selfHostedConfigurationDescription : c.hostedConfigurationDescription}
                  icon={Settings2Icon}
                >
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="installation-server-name">{c.serverName}</FieldLabel>
                      <Input id="installation-server-name" value={serverName} onChange={(event) => setServerName(event.target.value)} maxLength={100} required />
                      <FieldDescription>{c.serverNameDescription}</FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="installation-login">
                        {deploymentMode === "hosted" ? c.operationsAdministratorLogin : c.administratorLogin}
                      </FieldLabel>
                      <Input id="installation-login" value={login} onChange={(event) => setLogin(event.target.value)} autoComplete="username" maxLength={200} required />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="installation-password">
                        {deploymentMode === "hosted" ? c.operationsAdministratorPassword : c.administratorPassword}
                      </FieldLabel>
                      <Input id="installation-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={8} maxLength={1024} required />
                      <FieldDescription>
                        {deploymentMode === "hosted" ? c.operationsPasswordDescription : c.passwordDescription}
                      </FieldDescription>
                    </Field>
                    {deploymentMode === "hosted" ? (
                      <Field>
                        <FieldLabel>{c.registration}</FieldLabel>
                        <ToggleGroup
                          value={[registrationPolicy]}
                          onValueChange={(values) => {
                            const value = values[0]
                            if (value === "disabled" || value === "public") setRegistrationPolicy(value)
                          }}
                          variant="outline"
                          spacing={0}
                        >
                          <ToggleGroupItem value="disabled">{c.disabled}</ToggleGroupItem>
                          <ToggleGroupItem value="public">{c.public}</ToggleGroupItem>
                        </ToggleGroup>
                        <FieldDescription>{c.registrationDescription}</FieldDescription>
                      </Field>
                    ) : null}
                    {deploymentMode === "hosted" ? (
                      <Alert>
                        <ShieldCheckIcon />
                        <AlertTitle>{c.internalTitle}</AlertTitle>
                        <AlertDescription>{c.internalDescription}</AlertDescription>
                      </Alert>
                    ) : null}
                  </FieldGroup>
                </StepSection>
              ) : null}

              {step === 2 ? (
                <StepSection title={c.reviewTitle} description={c.reviewDescription} icon={ShieldCheckIcon}>
                  <div className="flex flex-col gap-5">
                    <ItemGroup>
                      <ReviewItem icon={ServerIcon} title={c.reviewMode} description={deploymentMode === "hosted" ? c.hosted : c.selfHosted} />
                      <ReviewItem icon={Settings2Icon} title={c.reviewServer} description={serverName} />
                      <ReviewItem
                        icon={UserRoundCogIcon}
                        title={deploymentMode === "hosted" ? c.reviewOperationsAdministrator : c.reviewAdministrator}
                        description={login}
                      />
                      {deploymentMode === "hosted"
                        ? <ReviewItem icon={Globe2Icon} title={c.reviewRegistration} description={registrationPolicy === "public" ? c.public : c.disabled} />
                        : null}
                    </ItemGroup>
                    <Alert>
                      <ShieldCheckIcon />
                      <AlertTitle>{c.beforePublicTitle}</AlertTitle>
                      <AlertDescription>{c.beforePublicDescription}</AlertDescription>
                    </Alert>
                    {error ? (
                      <Alert variant="destructive">
                        <ShieldCheckIcon />
                        <AlertTitle>{c.failed}</AlertTitle>
                        <AlertDescription>{error}</AlertDescription>
                      </Alert>
                    ) : null}
                  </div>
                </StepSection>
              ) : null}
            </div>
          </CardContent>
          <CardFooter className="flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Button className="w-full sm:w-auto" type="button" variant="ghost" disabled={step === 0 || busy} onClick={() => setStep((current) => Math.max(0, current - 1))}>
              <ArrowLeftIcon data-icon="inline-start" />
              {c.back}
            </Button>
            <Button className="w-full sm:w-auto" type="submit" size="lg" disabled={!canContinue || busy}>
              {busy ? <Spinner data-icon="inline-start" /> : step === 2 ? <ShieldCheckIcon data-icon="inline-start" /> : null}
              {busy ? c.installing : step === 2 ? c.install : c.continue}
              {!busy && step < 2 ? <ArrowRightIcon data-icon="inline-end" /> : null}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </InstallationLayout>
  )
}

function StepSection({
  title,
  description,
  icon: Icon,
  children,
}: {
  title: string
  description: string
  icon: typeof ServerIcon
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-6">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground"><Icon /></span>
        <div className="grid min-w-0 gap-1">
          <h2 className="break-words text-lg font-semibold">{title}</h2>
          <p className="break-words text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </section>
  )
}

function ReviewItem({ icon: Icon, title, description }: { icon: typeof ServerIcon, title: string, description: string }) {
  return (
    <Item>
      <ItemMedia variant="icon"><Icon /></ItemMedia>
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription>{description}</ItemDescription>
      </ItemContent>
    </Item>
  )
}

function InstallationLayout({ children }: { children: ReactNode }) {
  const { locale } = useLocale()
  const c = COPY[locale]
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-7xl flex-col gap-6 p-5 md:justify-center md:p-8 xl:p-10">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground"><ServerIcon /></span>
          <div>
            <h1 className="text-lg font-semibold">{c.product}</h1>
            <p className="text-sm text-muted-foreground">{c.guide}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <LanguageToggle />
          <ThemeToggle />
        </div>
      </header>
      {children}
    </main>
  )
}

function installationErrorMessage(cause: unknown, locale: Locale): string {
  if (locale === "zh-CN") {
    if (isApiRequestError(cause)) {
      const messages: Record<string, string> = {
        installation_already_completed: "实例已经完成安装。",
        installation_existing_data: "数据库中已经存在账号数据，不能作为全新实例初始化。",
        installation_server_name_invalid: "服务名称不能为空，且不能超过 100 个字符。",
        installation_administrator_required: "必须创建首位管理员账号。",
        installation_administrator_invalid: "管理员账号格式不正确。",
      }
      return messages[cause.code] ?? `安装请求失败（HTTP ${cause.status}）。`
    }
    return cause instanceof TypeError ? "无法连接同步服务器，请确认服务已启动。" : "安装未完成，请稍后重试。"
  }
  if (isApiRequestError(cause)) {
    const messages: Record<string, string> = {
      installation_already_completed: "This instance has already been installed.",
      installation_existing_data: "The database already contains account data and cannot be initialized as a new instance.",
      installation_server_name_invalid: "Enter a service name no longer than 100 characters.",
      installation_administrator_required: "An initial administrator account is required.",
      installation_administrator_invalid: "The administrator account format is invalid.",
    }
    return messages[cause.code] ?? `The installation request failed (HTTP ${cause.status}).`
  }
  return cause instanceof TypeError ? "Could not connect to the sync server. Make sure it is running." : "Installation did not finish. Try again."
}
