"use client"

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"
import { ShieldCheckIcon, UserRoundCogIcon } from "lucide-react"

import { useLocale, type Locale } from "@/components/locale-provider"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { apiRequest, isApiRequestError } from "@/lib/api"

export interface InstallationStatus {
  installationRequired: boolean
  activationPending: boolean
  serverName: string
}

const COPY = {
  "zh-CN": {
    firstInstall: "首次安装",
    title: "创建管理员账号",
    description: "这个账号将拥有实例管理权限。登录后可以继续配置注册、邮件、存储限制和数据保留策略。",
    administratorLogin: "管理员账号",
    administratorPassword: "管理员密码",
    passwordDescription: "至少 8 个字符，请使用独立密码。",
    confirmPassword: "确认密码",
    passwordMismatch: "两次输入的密码不一致。",
    securityTitle: "完成初始化后再开放公网",
    securityDescription: "空实例允许首位访问者创建管理员。请先完成此步骤，再配置公开反向代理或开放端口。",
    install: "创建管理员并启动",
    installing: "正在初始化",
    failed: "安装失败",
    saved: "安装设置已保存",
    activatingTitle: "正在启动实例",
    activatingDescription: "实例正在加载配置，完成后会自动进入登录页。",
  },
  en: {
    firstInstall: "First installation",
    title: "Create an administrator account",
    description: "This account will have full instance administration access. Registration, email, storage limits, and retention policies can be configured after signing in.",
    administratorLogin: "Administrator account",
    administratorPassword: "Administrator password",
    passwordDescription: "Use at least 8 characters and a password unique to this service.",
    confirmPassword: "Confirm password",
    passwordMismatch: "The passwords do not match.",
    securityTitle: "Finish initialization before exposing the server",
    securityDescription: "The first visitor to an empty instance can create its administrator. Complete this page before configuring a public reverse proxy or opening the port.",
    install: "Create administrator and start",
    installing: "Initializing",
    failed: "Installation failed",
    saved: "Installation settings saved",
    activatingTitle: "Starting the instance",
    activatingDescription: "The instance is loading its configuration. You will be redirected to sign in when it is ready.",
  },
} as const

export function InstallationGuide({ initialStatus, onStatusChange }: {
  initialStatus: InstallationStatus
  onStatusChange: (status: InstallationStatus) => void
}) {
  const { locale } = useLocale()
  const c = COPY[locale]
  const [login, setLogin] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [activationWaitSeconds, setActivationWaitSeconds] = useState(0)
  const activationCheckBusy = useRef(false)

  useEffect(() => {
    if (!initialStatus.activationPending) return
    let active = true
    const checkReady = async () => {
      if (activationCheckBusy.current) return
      activationCheckBusy.current = true
      try {
        const status = await apiRequest<InstallationStatus>("/v1/installation/status")
        if (active && !status.activationPending) {
          if (status.installationRequired) onStatusChange(status)
          else window.location.assign("/")
        }
      } catch {
        // The API is briefly unavailable while it replaces the installation app.
      } finally {
        activationCheckBusy.current = false
      }
    }
    void checkReady()
    const timer = window.setInterval(() => {
      setActivationWaitSeconds((current) => current + 1)
      void checkReady()
    }, 1_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [initialStatus.activationPending, onStatusChange])

  const passwordMismatch = confirmPassword.length > 0 && password !== confirmPassword
  const canSubmit = login.trim().length > 0 && password.length >= 8 && password === confirmPassword

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError("")
    try {
      const result = await apiRequest<{ serverName: string, activationPending: true }>("/v1/installation/complete", {
        method: "POST",
        body: JSON.stringify({
          serverName: initialStatus.serverName,
          administrator: { login: login.trim(), password },
        }),
      })
      setPassword("")
      setConfirmPassword("")
      onStatusChange({ installationRequired: false, activationPending: result.activationPending, serverName: result.serverName })
    } catch (cause) {
      setError(installationErrorMessage(cause, locale))
    } finally {
      setBusy(false)
    }
  }

  if (initialStatus.activationPending) {
    return (
      <InstallationLayout>
        <Card className="w-full max-w-lg shadow-sm">
          <CardHeader>
            <Badge className="mb-3 w-fit" variant="secondary">{c.saved}</Badge>
            <CardTitle className="flex items-center gap-2 text-xl"><Spinner />{c.activatingTitle}</CardTitle>
            <CardDescription>{c.activatingDescription}</CardDescription>
          </CardHeader>
          {activationWaitSeconds >= 30 ? (
            <CardContent>
              <Alert>
                <ShieldCheckIcon />
                <AlertTitle>{locale === "zh-CN" ? "启动时间比预期更长" : "Startup is taking longer than expected"}</AlertTitle>
                <AlertDescription className="flex flex-col items-start gap-3">
                  <span>{locale === "zh-CN" ? "配置已经保存。请确认服务进程正在运行；也可以重新检查当前状态。" : "Your settings are saved. Confirm that the service process is running, or check the current status again."}</span>
                  <Button variant="outline" onClick={() => window.location.reload()}>{locale === "zh-CN" ? "重新检查" : "Check again"}</Button>
                </AlertDescription>
              </Alert>
            </CardContent>
          ) : null}
        </Card>
      </InstallationLayout>
    )
  }

  return (
    <InstallationLayout>
      <Card className="w-full max-w-lg shadow-sm">
        <CardHeader>
          <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <UserRoundCogIcon />
          </div>
          <Badge className="mb-1 w-fit" variant="secondary">{c.firstInstall}</Badge>
          <CardTitle className="text-xl">{c.title}</CardTitle>
          <CardDescription>{c.description}</CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="flex flex-col gap-6">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="installation-login">{c.administratorLogin}</FieldLabel>
                <Input id="installation-login" value={login} onChange={(event) => setLogin(event.target.value)} autoComplete="username" maxLength={200} autoFocus required />
              </Field>
              <Field>
                <FieldLabel htmlFor="installation-password">{c.administratorPassword}</FieldLabel>
                <Input id="installation-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={8} maxLength={1024} required />
                <FieldDescription>{c.passwordDescription}</FieldDescription>
              </Field>
              <Field data-invalid={passwordMismatch || undefined}>
                <FieldLabel htmlFor="installation-password-confirm">{c.confirmPassword}</FieldLabel>
                <Input id="installation-password-confirm" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={8} maxLength={1024} aria-invalid={passwordMismatch || undefined} required />
                {passwordMismatch ? <FieldDescription>{c.passwordMismatch}</FieldDescription> : null}
              </Field>
            </FieldGroup>
            <Alert>
              <ShieldCheckIcon />
              <AlertTitle>{c.securityTitle}</AlertTitle>
              <AlertDescription>{c.securityDescription}</AlertDescription>
            </Alert>
            {error ? (
              <Alert variant="destructive">
                <ShieldCheckIcon />
                <AlertTitle>{c.failed}</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
          <CardFooter>
            <Button className="w-full" type="submit" size="lg" disabled={!canSubmit || busy}>
              {busy ? <Spinner data-icon="inline-start" /> : <ShieldCheckIcon data-icon="inline-start" />}
              {busy ? c.installing : c.install}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </InstallationLayout>
  )
}

function InstallationLayout({ children }: { children: ReactNode }) {
  return <main className="flex min-h-svh w-full items-center justify-center bg-muted/20 p-5 md:p-8">{children}</main>
}

function installationErrorMessage(cause: unknown, locale: Locale): string {
  if (locale === "zh-CN") {
    if (isApiRequestError(cause)) {
      const messages: Record<string, string> = { installation_already_completed: "实例已经完成安装。", installation_existing_data: "数据库中已经存在账号数据，不能作为全新实例初始化。", installation_server_name_invalid: "服务名称配置无效。", installation_administrator_required: "必须创建首位管理员账号。", installation_administrator_invalid: "管理员账号格式不正确。" }
      return messages[cause.code] ?? `安装请求失败（HTTP ${cause.status}）。`
    }
    return cause instanceof TypeError ? "无法连接同步服务器，请确认服务已启动。" : "安装未完成，请稍后重试。"
  }
  if (isApiRequestError(cause)) {
    const messages: Record<string, string> = { installation_already_completed: "This instance has already been installed.", installation_existing_data: "The database already contains account data and cannot be initialized as a new instance.", installation_server_name_invalid: "The configured service name is invalid.", installation_administrator_required: "An initial administrator account is required.", installation_administrator_invalid: "The administrator account format is invalid." }
    return messages[cause.code] ?? `The installation request failed (HTTP ${cause.status}).`
  }
  return cause instanceof TypeError ? "Could not connect to the sync server. Make sure it is running." : "Installation did not finish. Try again."
}
