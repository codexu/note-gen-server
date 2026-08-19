"use client"

import { useEffect, useState, type FormEvent } from "react"
import Link from "next/link"
import { CircleCheckIcon, TicketIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { apiRequest, userFacingErrorMessage, type Account } from "@/lib/api"
import { PublicSiteShell } from "@/components/site-chrome"

interface InvitationInspection {
  canContinue: boolean
  requiresEmail: boolean
  serverName: string
}

export function InvitationAcceptance() {
  const [inspection, setInspection] = useState<InvitationInspection | null>(null)
  const [login, setLogin] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [busy, setBusy] = useState(true)
  const [fatalError, setFatalError] = useState("")
  const [submitError, setSubmitError] = useState("")
  const token = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("token") ?? ""
  const mismatch = confirmPassword.length > 0 && password !== confirmPassword

  async function inspectInvitation() {
    if (!token) { setBusy(false); setFatalError("邀请链接不完整，请重新打开管理员发送的完整链接。"); return }
    setBusy(true)
    setInspection(null)
    setFatalError("")
    try {
      const result = await apiRequest<InvitationInspection>("/v1/invitations/inspect", {
      method: "POST", body: JSON.stringify({ token }),
      })
      setInspection(result)
      if (!result.canContinue) setFatalError("邀请链接无效、已经过期或已被使用。")
    } catch (cause) {
      setFatalError(userFacingErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void inspectInvitation()
    // The bearer token is immutable for the lifetime of this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!inspection?.canContinue || mismatch) return
    setBusy(true); setSubmitError("")
    try {
      await apiRequest<{ account: Account }>("/v1/web/auth/register/invitation", {
        method: "POST",
        body: JSON.stringify({ token, login, password, ...(inspection.requiresEmail ? { email } : {}) }),
      })
      window.location.assign("/")
    } catch (cause) {
      setSubmitError(userFacingErrorMessage(cause))
    } finally { setBusy(false) }
  }

  return <PublicSiteShell instanceName={inspection?.serverName}><main className="mx-auto flex w-full max-w-lg flex-1 items-center p-6 py-12">
    <Card className="w-full">
      <CardHeader><div className="mb-2 flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground"><TicketIcon /></div><CardTitle>接受 NoteGen 邀请</CardTitle><CardDescription>{inspection?.serverName ? `创建账号并加入 ${inspection.serverName}。` : "正在检查邀请链接…"}</CardDescription></CardHeader>
      <CardContent>
        {busy && !inspection ? <div className="flex min-h-32 items-center justify-center" aria-label="正在检查邀请" aria-busy="true"><Spinner /></div> : fatalError ? <div className="flex flex-col gap-4"><Alert variant="destructive"><TicketIcon /><AlertTitle>无法使用邀请</AlertTitle><AlertDescription>{fatalError}</AlertDescription></Alert><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void inspectInvitation()}>重新检查</Button><Link className={buttonVariants({ variant: "ghost" })} href="/">返回登录</Link></div></div> : inspection?.canContinue ? <form onSubmit={accept}><FieldGroup><Alert><CircleCheckIcon /><AlertTitle>邀请有效</AlertTitle><AlertDescription>填写下面的信息即可创建账号，完成后会自动登录。</AlertDescription></Alert>{submitError ? <Alert variant="destructive"><TicketIcon /><AlertTitle>暂时无法创建账号</AlertTitle><AlertDescription>{submitError} 请修改后重试。</AlertDescription></Alert> : null}<Field><FieldLabel htmlFor="invite-login">账号</FieldLabel><Input id="invite-login" autoFocus autoComplete="username" maxLength={200} value={login} onChange={(event) => { setLogin(event.target.value); setSubmitError("") }} required /></Field>{inspection.requiresEmail ? <Field><FieldLabel htmlFor="invite-email">受邀邮箱</FieldLabel><Input id="invite-email" type="email" autoComplete="email" maxLength={320} value={email} onChange={(event) => { setEmail(event.target.value); setSubmitError("") }} required /><FieldDescription>请输入收到邀请邮件的邮箱地址，用于确认你是受邀人。</FieldDescription></Field> : null}<Field><FieldLabel htmlFor="invite-password">密码</FieldLabel><Input id="invite-password" type="password" autoComplete="new-password" minLength={8} maxLength={1024} value={password} onChange={(event) => { setPassword(event.target.value); setSubmitError("") }} required /><FieldDescription>至少 8 个字符。</FieldDescription></Field><Field data-invalid={mismatch || undefined}><FieldLabel htmlFor="invite-password-confirm">确认密码</FieldLabel><Input id="invite-password-confirm" type="password" autoComplete="new-password" minLength={8} maxLength={1024} value={confirmPassword} onChange={(event) => { setConfirmPassword(event.target.value); setSubmitError("") }} aria-invalid={mismatch || undefined} required />{mismatch ? <FieldDescription>两次输入的密码不一致。</FieldDescription> : null}</Field><Field><Button type="submit" size="lg" disabled={busy || mismatch}>{busy ? <Spinner data-icon="inline-start" /> : null}创建账号并加入</Button></Field></FieldGroup></form> : null}
      </CardContent>
    </Card>
  </main></PublicSiteShell>
}
