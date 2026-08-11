"use client"

import { useCallback, useEffect, useState } from "react"
import { CircleCheckIcon, MailIcon, SendIcon, Settings2Icon, TicketIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { apiRequest, userFacingErrorMessage } from "@/lib/api"
import { formatRelativeTime } from "@/lib/relative-time"

type Invitation = { id: string; tokenHint: string; expiresAt: string; revokedAt: string | null; maxUses: number; useCount: number; delivery: { status: string; errorCode: string | null } | null }
type MailStatus = { configured: boolean; health: string; queue: Record<string, number> }
type MailItem = { id: string; template: string; status: string; attempts: number; maxAttempts: number; errorCode: string | null; createdAt: string }
type RegistrationPolicy = "disabled" | "invitation" | "public"
type RegistrationCapabilities = { deploymentMode: "self-hosted" | "hosted"; registration: { policy: RegistrationPolicy } }
type RuntimeConfiguration = {
  serverName: string
  maxObjectBytes: number
  maxBlobBytes: number
  changeRetentionDays: number
  versionRetentionDays: number
  tombstoneRetentionDays: number
  mailDefaultLocale: "en" | "zh-CN"
  pendingEmailVerificationDays: number
  accountDeletionCoolingOffDays: number
  accountDeletionRetentionDays: number
  mailDriver: "disabled" | "smtp"
  mailFromAddress: string
  mailFromName: string
  mailReplyTo: string
  smtpHost: string
  smtpPort: number
  smtpTlsMode: "starttls-required" | "starttls" | "tls" | "none"
  smtpUsername: string
  smtpPasswordConfigured: boolean
  smtpConnectTimeoutMs: number
  smtpCommandTimeoutMs: number
  smtpTlsRejectUnauthorized: boolean
}
type ConfigurationResponse = { editable: boolean; revision: string; runtimeConfiguration: RuntimeConfiguration | null }

export function OperationsCenter() {
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [mail, setMail] = useState<MailStatus | null>(null)
  const [queue, setQueue] = useState<MailItem[]>([])
  const [password, setPassword] = useState("")
  const [registration, setRegistration] = useState<RegistrationCapabilities | null>(null)
  const [nextPolicy, setNextPolicy] = useState<RegistrationPolicy>("disabled")
  const [configuration, setConfiguration] = useState<RuntimeConfiguration | null>(null)
  const [configurationRevision, setConfigurationRevision] = useState("0")
  const [configurationEditable, setConfigurationEditable] = useState(false)
  const [smtpPassword, setSmtpPassword] = useState("")
  const [clearSmtpPassword, setClearSmtpPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const load = useCallback(async () => {
    const [invitationResult, mailResult, queueResult, capabilitiesResult, configurationResult] = await Promise.allSettled([
      apiRequest<Invitation[]>("/v1/web/admin/invitations"), apiRequest<MailStatus>("/v1/web/admin/mail/status"), apiRequest<MailItem[]>("/v1/web/admin/mail/queue?limit=20"),
      apiRequest<RegistrationCapabilities>("/v1/capabilities"),
      apiRequest<ConfigurationResponse>("/v1/web/admin/configuration"),
    ])
    if (invitationResult.status === "fulfilled") setInvitations(invitationResult.value)
    if (mailResult.status === "fulfilled") setMail(mailResult.value)
    if (queueResult.status === "fulfilled") setQueue(queueResult.value)
    if (capabilitiesResult.status === "fulfilled") {
      setRegistration(capabilitiesResult.value)
      setNextPolicy(capabilitiesResult.value.registration.policy)
    }
    if (configurationResult.status === "fulfilled") {
      setConfiguration(configurationResult.value.runtimeConfiguration)
      setConfigurationRevision(configurationResult.value.revision)
      setConfigurationEditable(configurationResult.value.editable)
    }
    const failed = [invitationResult, mailResult, queueResult, capabilitiesResult, configurationResult].find((result) => result.status === "rejected")
    if (failed?.status === "rejected") setError(userFacingErrorMessage(failed.reason))
  }, [])
  useEffect(() => { void load() }, [load])
  async function createInvitation() {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    const body = { expiresAt, maxUses: 1, send: false }
    setBusy(true); setError(""); setNotice("")
    try {
      const requestHash = await digest(body)
      const grant = await apiRequest<{ token: string }>("/v1/web/auth/step-up", { method: "POST", csrf: true, body: JSON.stringify({ audience: "registration.invitation.create", requestHash, password }) })
      const invitation = await apiRequest<{ url: string }>("/v1/web/admin/invitations", { method: "POST", csrf: true, headers: { "x-step-up-token": grant.token }, body: JSON.stringify(body) })
      setPassword(""); setNotice(`邀请已创建：${invitation.url}`); await load()
    } catch (cause) { setError(userFacingErrorMessage(cause)) }
    finally { setBusy(false) }
  }
  async function updateRegistrationPolicy() {
    const body = { policy: nextPolicy }
    setBusy(true); setError(""); setNotice("")
    try {
      const requestHash = await digest(body)
      const grant = await apiRequest<{ token: string }>("/v1/web/auth/step-up", { method: "POST", csrf: true, body: JSON.stringify({ audience: "registration.policy.update", requestHash, password }) })
      await apiRequest("/v1/web/admin/registration-policy", { method: "PUT", csrf: true, headers: { "x-step-up-token": grant.token }, body: JSON.stringify(body) })
      setPassword(""); setNotice("注册策略已保存。"); await load()
    } catch (cause) { setError(userFacingErrorMessage(cause)) }
    finally { setBusy(false) }
  }
  async function updateConfiguration() {
    if (!configuration) return
    setBusy(true); setError(""); setNotice("")
    try {
      const body = {
        revision: configurationRevision,
        configuration,
        ...(clearSmtpPassword ? { smtpPassword: null } : smtpPassword.length > 0 ? { smtpPassword } : {}),
      }
      const requestHash = await digest(body)
      const grant = await apiRequest<{ token: string }>("/v1/web/auth/step-up", {
        method: "POST", csrf: true,
        body: JSON.stringify({ audience: "runtime.configuration.update", requestHash, password }),
      })
      const response = await apiRequest<ConfigurationResponse>("/v1/web/admin/configuration", {
        method: "PUT", csrf: true, headers: { "x-step-up-token": grant.token }, body: JSON.stringify(body),
      })
      setConfiguration(response.runtimeConfiguration)
      setConfigurationRevision(response.revision)
      setPassword("")
      setSmtpPassword("")
      setClearSmtpPassword(false)
      setNotice("运行配置已保存并立即生效。")
    } catch (cause) { setError(userFacingErrorMessage(cause)) }
    finally { setBusy(false) }
  }
  function setNumber(key: keyof RuntimeConfiguration, value: string) {
    setConfiguration((current) => current === null ? null : { ...current, [key]: Number(value) })
  }
  return <div className="grid max-w-5xl gap-6 xl:grid-cols-2">
    {error ? <Alert variant="destructive"><MailIcon /><AlertTitle>实例运维操作失败</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {notice ? <Alert><CircleCheckIcon /><AlertTitle>操作已完成</AlertTitle><AlertDescription className="break-all">{notice}</AlertDescription></Alert> : null}
    <Card><CardHeader><CardTitle>注册策略</CardTitle><CardDescription>{registration?.deploymentMode === "hosted" ? "官方托管实例的策略由控制面管理，此处仅显示当前状态。" : "保存后立即写入实例数据库，不需要重启服务或修改环境变量。"}</CardDescription></CardHeader><CardContent className="flex flex-col gap-4"><FieldGroup><Field><FieldLabel>允许新账号加入</FieldLabel><ToggleGroup type="single" variant="outline" spacing={0} value={nextPolicy} disabled={busy || registration?.deploymentMode === "hosted"} onValueChange={(value) => { if (value) setNextPolicy(value as RegistrationPolicy) }}><ToggleGroupItem value="disabled">关闭</ToggleGroupItem><ToggleGroupItem value="invitation">仅邀请</ToggleGroupItem><ToggleGroupItem value="public">公开</ToggleGroupItem></ToggleGroup><FieldDescription>{nextPolicy === "public" ? "任何人都可以创建账号。" : nextPolicy === "invitation" ? "仅持有管理员邀请链接的用户可注册。" : "不接受新的注册请求。"}</FieldDescription></Field>{registration?.deploymentMode !== "hosted" ? <Field><FieldLabel htmlFor="policy-password">当前密码</FieldLabel><Input id="policy-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /><FieldDescription>修改实例策略需要重新验证当前密码。</FieldDescription></Field> : null}<Field><Button disabled={busy || registration?.deploymentMode === "hosted" || password.length < 8 || nextPolicy === registration?.registration.policy} onClick={() => void updateRegistrationPolicy()}>{busy ? <Spinner data-icon="inline-start" /> : <Settings2Icon data-icon="inline-start" />}保存注册策略</Button></Field></FieldGroup></CardContent></Card>
    <Card><CardHeader><CardTitle>邀请注册</CardTitle><CardDescription>创建的链接只显示一次；仅在“仅邀请”策略下可用。</CardDescription></CardHeader><CardContent className="flex flex-col gap-4"><FieldGroup><Field><FieldLabel htmlFor="invite-password">当前密码</FieldLabel><Input id="invite-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /><FieldDescription>默认创建一条 7 天有效、仅使用一次且不发送邮件的邀请。</FieldDescription></Field><Field><Button disabled={busy || password.length < 8 || registration?.registration.policy !== "invitation"} onClick={() => void createInvitation()}>{busy ? <Spinner data-icon="inline-start" /> : <TicketIcon data-icon="inline-start" />}创建邀请</Button></Field></FieldGroup><ItemGroup>{invitations.map((invitation) => <Item key={invitation.id} variant="outline"><ItemMedia variant="icon"><TicketIcon /></ItemMedia><ItemContent><ItemTitle>{invitation.tokenHint}</ItemTitle><ItemDescription>使用 {invitation.useCount}/{invitation.maxUses} · 过期 {formatRelativeTime(invitation.expiresAt)}</ItemDescription></ItemContent><ItemActions><Badge variant="outline">{invitation.revokedAt ? "已撤销" : invitation.delivery?.status ?? "可用"}</Badge></ItemActions></Item>)}</ItemGroup></CardContent></Card>
    <Card><CardHeader><CardTitle>SMTP 状态</CardTitle><CardDescription>仅展示脱敏队列元数据，不显示收件人、正文、密码或服务商原始响应。</CardDescription></CardHeader><CardContent className="flex flex-col gap-4"><div className="flex flex-wrap gap-2"><Badge variant="secondary">{mail?.configured ? "已配置" : "未配置"}</Badge><Badge variant="outline">{mail?.health ?? "unknown"}</Badge>{Object.entries(mail?.queue ?? {}).map(([status, count]) => <Badge key={status} variant="outline">{status} {count}</Badge>)}</div><ItemGroup>{queue.map((item) => <Item key={item.id} variant="outline"><ItemMedia variant="icon"><SendIcon /></ItemMedia><ItemContent><ItemTitle>{item.template}</ItemTitle><ItemDescription>尝试 {item.attempts}/{item.maxAttempts} · 创建于 {formatRelativeTime(item.createdAt)}</ItemDescription></ItemContent><ItemActions><Badge variant="outline">{item.status}</Badge></ItemActions></Item>)}</ItemGroup>{!queue.length ? <p className="text-sm text-muted-foreground">没有待展示的投递任务。</p> : null}</CardContent></Card>
    {configuration ? <Card className="xl:col-span-2"><CardHeader><CardTitle>运行配置</CardTitle><CardDescription>这些设置保存在实例数据库中，保存后立即生效，无需修改 env 或重启。当前版本 {configurationRevision}。</CardDescription></CardHeader><CardContent className="flex flex-col gap-5"><FieldGroup className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"><Field><FieldLabel htmlFor="server-name">实例名称</FieldLabel><Input id="server-name" value={configuration.serverName} disabled={busy || !configurationEditable} onChange={(event) => setConfiguration({ ...configuration, serverName: event.target.value })} /></Field><NumberField id="max-object-bytes" label="单对象上限（字节）" value={configuration.maxObjectBytes} disabled={busy || !configurationEditable} onChange={(value) => setNumber("maxObjectBytes", value)} /><NumberField id="max-blob-bytes" label="单附件上限（字节）" value={configuration.maxBlobBytes} disabled={busy || !configurationEditable} onChange={(value) => setNumber("maxBlobBytes", value)} /><NumberField id="change-retention" label="变更保留（天）" value={configuration.changeRetentionDays} disabled={busy || !configurationEditable} onChange={(value) => setNumber("changeRetentionDays", value)} /><NumberField id="version-retention" label="版本保留（天）" value={configuration.versionRetentionDays} disabled={busy || !configurationEditable} onChange={(value) => setNumber("versionRetentionDays", value)} /><NumberField id="tombstone-retention" label="删除标记保留（天）" value={configuration.tombstoneRetentionDays} disabled={busy || !configurationEditable} onChange={(value) => setNumber("tombstoneRetentionDays", value)} /><NumberField id="pending-email-retention" label="待验证账号保留（天）" value={configuration.pendingEmailVerificationDays} disabled={busy || !configurationEditable} onChange={(value) => setNumber("pendingEmailVerificationDays", value)} /><NumberField id="deletion-cooling-off" label="账号删除冷静期（天）" value={configuration.accountDeletionCoolingOffDays} disabled={busy || !configurationEditable} onChange={(value) => setNumber("accountDeletionCoolingOffDays", value)} /><NumberField id="deletion-retention" label="账号删除保留（天）" value={configuration.accountDeletionRetentionDays} disabled={busy || !configurationEditable} onChange={(value) => setNumber("accountDeletionRetentionDays", value)} /><Field><FieldLabel>邮件默认语言</FieldLabel><ToggleGroup type="single" variant="outline" spacing={0} value={configuration.mailDefaultLocale} disabled={busy || !configurationEditable} onValueChange={(value) => { if (value) setConfiguration({ ...configuration, mailDefaultLocale: value as "en" | "zh-CN" }) }}><ToggleGroupItem value="zh-CN">中文</ToggleGroupItem><ToggleGroupItem value="en">English</ToggleGroupItem></ToggleGroup></Field><Field><FieldLabel htmlFor="configuration-password">当前密码</FieldLabel><Input id="configuration-password" type="password" value={password} disabled={busy || !configurationEditable} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /><FieldDescription>保存运行配置需要重新验证当前密码。</FieldDescription></Field></FieldGroup><div><Button disabled={busy || !configurationEditable || !configuration.serverName.trim() || password.length < 8} onClick={() => void updateConfiguration()}>{busy ? <Spinner data-icon="inline-start" /> : <Settings2Icon data-icon="inline-start" />}保存运行配置</Button></div></CardContent></Card> : null}
    {configuration ? <Card className="xl:col-span-2"><CardHeader><CardTitle>SMTP 配置</CardTitle><CardDescription>SMTP 密码使用实例密钥加密保存且不会回显；修改后邮件工作线程会自动切换到新连接。</CardDescription></CardHeader><CardContent className="flex flex-col gap-5"><FieldGroup className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"><Field><FieldLabel>邮件投递</FieldLabel><ToggleGroup type="single" variant="outline" spacing={0} value={configuration.mailDriver} disabled={busy || !configurationEditable} onValueChange={(value) => { if (value) setConfiguration({ ...configuration, mailDriver: value as "disabled" | "smtp" }) }}><ToggleGroupItem value="disabled">关闭</ToggleGroupItem><ToggleGroupItem value="smtp">SMTP</ToggleGroupItem></ToggleGroup></Field><Field><FieldLabel htmlFor="smtp-host">SMTP 主机</FieldLabel><Input id="smtp-host" value={configuration.smtpHost} disabled={busy || !configurationEditable} onChange={(event) => setConfiguration({ ...configuration, smtpHost: event.target.value })} /></Field><NumberField id="smtp-port" label="SMTP 端口" value={configuration.smtpPort} disabled={busy || !configurationEditable} onChange={(value) => setNumber("smtpPort", value)} /><Field><FieldLabel htmlFor="mail-from-address">发件地址</FieldLabel><Input id="mail-from-address" type="email" value={configuration.mailFromAddress} disabled={busy || !configurationEditable} onChange={(event) => setConfiguration({ ...configuration, mailFromAddress: event.target.value })} /></Field><Field><FieldLabel htmlFor="mail-from-name">发件名称</FieldLabel><Input id="mail-from-name" value={configuration.mailFromName} disabled={busy || !configurationEditable} onChange={(event) => setConfiguration({ ...configuration, mailFromName: event.target.value })} /></Field><Field><FieldLabel htmlFor="mail-reply-to">回复地址</FieldLabel><Input id="mail-reply-to" type="email" value={configuration.mailReplyTo} disabled={busy || !configurationEditable} onChange={(event) => setConfiguration({ ...configuration, mailReplyTo: event.target.value })} /></Field><Field><FieldLabel htmlFor="smtp-username">SMTP 用户名</FieldLabel><Input id="smtp-username" value={configuration.smtpUsername} disabled={busy || !configurationEditable} onChange={(event) => setConfiguration({ ...configuration, smtpUsername: event.target.value })} /></Field><Field><FieldLabel htmlFor="smtp-password">SMTP 密码</FieldLabel><Input id="smtp-password" type="password" value={smtpPassword} disabled={busy || !configurationEditable || clearSmtpPassword} placeholder={configuration.smtpPasswordConfigured ? "已配置；留空则保持不变" : "未配置"} onChange={(event) => setSmtpPassword(event.target.value)} autoComplete="new-password" /><FieldDescription>{clearSmtpPassword ? "保存后将清除密码。" : "密码不会从服务器返回。"}</FieldDescription></Field><Field><FieldLabel>TLS 模式</FieldLabel><ToggleGroup type="single" variant="outline" spacing={0} value={configuration.smtpTlsMode} disabled={busy || !configurationEditable} onValueChange={(value) => { if (value) setConfiguration({ ...configuration, smtpTlsMode: value as RuntimeConfiguration["smtpTlsMode"] }) }}><ToggleGroupItem value="starttls-required">STARTTLS</ToggleGroupItem><ToggleGroupItem value="tls">TLS</ToggleGroupItem><ToggleGroupItem value="starttls">可选</ToggleGroupItem></ToggleGroup></Field><NumberField id="smtp-connect-timeout" label="连接超时（毫秒）" value={configuration.smtpConnectTimeoutMs} disabled={busy || !configurationEditable} onChange={(value) => setNumber("smtpConnectTimeoutMs", value)} /><NumberField id="smtp-command-timeout" label="命令超时（毫秒）" value={configuration.smtpCommandTimeoutMs} disabled={busy || !configurationEditable} onChange={(value) => setNumber("smtpCommandTimeoutMs", value)} /><Field><FieldLabel>凭据状态</FieldLabel><div className="flex flex-wrap gap-2"><Badge variant="outline">{configuration.smtpPasswordConfigured ? "密码已配置" : "无密码"}</Badge><Button type="button" size="sm" variant="outline" disabled={busy || !configurationEditable} onClick={() => { setClearSmtpPassword((value) => !value); setSmtpPassword("") }}>{clearSmtpPassword ? "保留原密码" : "清除密码"}</Button></div></Field><Field><FieldLabel htmlFor="smtp-admin-password">管理员当前密码</FieldLabel><Input id="smtp-admin-password" type="password" value={password} disabled={busy || !configurationEditable} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></Field></FieldGroup><div><Button disabled={busy || !configurationEditable || password.length < 8} onClick={() => void updateConfiguration()}>{busy ? <Spinner data-icon="inline-start" /> : <Settings2Icon data-icon="inline-start" />}保存 SMTP 配置</Button></div></CardContent></Card> : null}
  </div>
}

function NumberField({ id, label, value, disabled, onChange }: { id: string; label: string; value: number; disabled: boolean; onChange: (value: string) => void }) {
  return <Field><FieldLabel htmlFor={id}>{label}</FieldLabel><Input id={id} type="number" min={1} step={1} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} /></Field>
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value))
  const hash = await crypto.subtle.digest("SHA-256", bytes)
  const encoded = btoa(String.fromCharCode(...new Uint8Array(hash)))
  return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`
  }
  throw new Error("无法为当前操作生成安全摘要")
}
