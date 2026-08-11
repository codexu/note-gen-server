"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { CheckCircle2Icon, LaptopIcon, QrCodeIcon, RefreshCwIcon, ShieldCheckIcon, Trash2Icon, XCircleIcon } from "lucide-react"
import QRCode from "react-qr-code"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { ThemeToggle } from "@/components/theme-toggle"
import { apiRequest, isApiRequestError, userFacingErrorMessage, type DeviceAuthorization } from "@/lib/api"

interface DevicePairing {
  id: string
  pairingUri: string
  expiresAt: string
  expiresIn: number
}

type DevicePairingStatus = "pending" | "consumed" | "expired"

export function DeviceConnection({
  embedded = false,
}: {
  embedded?: boolean
}) {
  const [code, setCode] = useState("")
  const [authorization, setAuthorization] = useState<DeviceAuthorization | null>(null)
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [completed, setCompleted] = useState<"approved" | "denied" | null>(null)
  const [pairing, setPairing] = useState<DevicePairing | null>(null)
  const [pairingStatus, setPairingStatus] = useState<DevicePairingStatus | null>(null)
  const [pairingBusy, setPairingBusy] = useState(false)
  const [pairingError, setPairingError] = useState("")
  const [remainingSeconds, setRemainingSeconds] = useState(0)

  useEffect(() => {
    const initialCode = new URLSearchParams(window.location.search).get("code") ?? ""
    setCode(initialCode)
    void apiRequest("/v1/web/session")
      .then(() => {
        setSignedIn(true)
        if (initialCode) void loadAuthorization(initialCode)
      })
      .catch((cause) => {
        if (isApiRequestError(cause) && cause.status === 401) {
          redirectToLogin()
          return
        }
        setError(errorMessage(cause))
      })
  }, [])

  useEffect(() => {
    if (!pairing || pairingStatus !== "pending") return
    const updateRemaining = () => {
      const remaining = Math.max(0, Math.ceil((new Date(pairing.expiresAt).getTime() - Date.now()) / 1_000))
      setRemainingSeconds(remaining)
      if (remaining === 0) setPairingStatus("expired")
    }
    updateRemaining()
    const countdown = window.setInterval(updateRemaining, 1_000)
    const polling = window.setInterval(() => {
      void apiRequest<{ status: DevicePairingStatus, expiresAt: string }>(
        `/v1/web/device-pairings/${pairing.id}`
      ).then((result) => setPairingStatus(result.status)).catch((cause) => {
        if (!(isApiRequestError(cause) && cause.status === 404)) setPairingError(errorMessage(cause))
      })
    }, 2_000)
    return () => {
      window.clearInterval(countdown)
      window.clearInterval(polling)
    }
  }, [pairing, pairingStatus])

  async function createPairing() {
    setPairingBusy(true)
    setPairingError("")
    try {
      if (pairing?.id && pairingStatus === "pending") {
        await apiRequest(`/v1/web/device-pairings/${pairing.id}`, { method: "DELETE", csrf: true })
      }
      const result = await apiRequest<DevicePairing>("/v1/web/device-pairings", {
        method: "POST",
        csrf: true,
      })
      setPairing(result)
      setPairingStatus("pending")
      setRemainingSeconds(result.expiresIn)
    } catch (cause) {
      setPairingError(errorMessage(cause))
    } finally {
      setPairingBusy(false)
    }
  }

  async function cancelPairing() {
    if (!pairing) return
    setPairingBusy(true)
    setPairingError("")
    try {
      if (pairingStatus === "pending") {
        await apiRequest(`/v1/web/device-pairings/${pairing.id}`, { method: "DELETE", csrf: true })
      }
      setPairing(null)
      setPairingStatus(null)
    } catch (cause) {
      setPairingError(errorMessage(cause))
    } finally {
      setPairingBusy(false)
    }
  }

  async function loadAuthorization(value = code) {
    setBusy(true)
    setError("")
    try {
      const result = await apiRequest<DeviceAuthorization>(
        `/v1/web/device-authorizations/${encodeURIComponent(value)}`
      )
      setAuthorization(result)
    } catch (cause) {
      setAuthorization(null)
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  async function decide(action: "approve" | "deny") {
    if (!authorization) return
    setBusy(true)
    setError("")
    try {
      await apiRequest(
        `/v1/web/device-authorizations/${encodeURIComponent(authorization.userCode)}/${action}`,
        { method: "POST", csrf: true }
      )
      setCompleted(action === "approve" ? "approved" : "denied")
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const content = (
    <>
      {embedded ? null : (
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <LaptopIcon />
          </span>
          <div>
            <h1 className="text-lg font-semibold">关联新设备</h1>
            <p className="text-sm text-muted-foreground">确认授权后，客户端会自动开始同步。</p>
          </div>
        </div>
        <ThemeToggle />
      </header>
      )}
      <div className="grid w-full items-start gap-6 lg:grid-cols-2">
      <Card className="w-full bg-card/90 shadow-sm">
        <CardHeader>
          <CardTitle>关联 NoteGen 设备</CardTitle>
          <CardDescription>确认设备信息后，服务器只会向这一台设备签发独立会话。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {error ? (
            <Alert variant="destructive">
              <ShieldCheckIcon />
              <AlertTitle>无法完成关联</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {signedIn === false ? (
            <Alert>
              <ShieldCheckIcon />
              <AlertTitle>请先登录</AlertTitle>
              <AlertDescription>登录或注册后会返回当前设备关联页面。</AlertDescription>
            </Alert>
          ) : null}

          {completed ? (
            <Alert>
              {completed === "approved" ? <CheckCircle2Icon /> : <XCircleIcon />}
              <AlertTitle>{completed === "approved" ? "设备已允许连接" : "已拒绝设备连接"}</AlertTitle>
              <AlertDescription>
                {completed === "approved" ? "可以返回 NoteGen，客户端会自动完成登录。" : "这次授权不会签发任何设备会话。"}
              </AlertDescription>
            </Alert>
          ) : (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="device-code">设备验证码</FieldLabel>
                <Input
                  id="device-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value.toUpperCase())}
                  placeholder="ABCD-EFGH"
                  autoCapitalize="characters"
                  autoCorrect="off"
                />
                <FieldDescription>验证码由 NoteGen 客户端显示，5 分钟内有效且只能使用一次。</FieldDescription>
              </Field>
              {signedIn ? (
                <Button onClick={() => void loadAuthorization()} disabled={busy || code.length < 8}>
                  {busy ? <Spinner data-icon="inline-start" /> : null}
                  查看设备
                </Button>
              ) : null}
            </FieldGroup>
          )}

          {authorization && !completed ? (
            <Alert>
              <LaptopIcon />
              <AlertTitle>{authorization.deviceName}</AlertTitle>
              <AlertDescription>
                平台：{authorization.platform} · 设备 ID：{authorization.deviceId} · 验证码：{authorization.userCode}
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
        {!embedded || signedIn === false || (authorization && !completed) ? (
          <CardFooter className="justify-between gap-3">
            {signedIn === false ? (
              <Link
                className={buttonVariants()}
                href={`/?next=${encodeURIComponent(`/connect/?code=${code}`)}`}
              >
                登录或注册
              </Link>
            ) : authorization && !completed ? (
              <>
                <Button variant="destructive" disabled={busy} onClick={() => void decide("deny")}>
                  拒绝
                </Button>
                <Button disabled={busy} onClick={() => void decide("approve")}>
                  {busy ? <Spinner data-icon="inline-start" /> : <CheckCircle2Icon data-icon="inline-start" />}
                  允许连接
                </Button>
              </>
            ) : (
              <Link className={buttonVariants({ variant: "outline" })} href="/">
                返回账号页面
              </Link>
            )}
          </CardFooter>
        ) : null}
      </Card>
      {signedIn ? (
        <Card className="w-full bg-card/90 shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <QrCodeIcon data-icon="inline-start" />
              手机扫码关联
            </CardTitle>
            <CardDescription>
              在手机 NoteGen 的同步设置中选择“扫码关联”。二维码 5 分钟内有效且只能使用一次。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-5">
            {pairingError ? (
              <Alert variant="destructive">
                <ShieldCheckIcon />
                <AlertTitle>无法生成配对二维码</AlertTitle>
                <AlertDescription>{pairingError}</AlertDescription>
              </Alert>
            ) : null}
            {!pairing ? (
              <Alert>
                <ShieldCheckIcon />
                <AlertTitle>仅向你信任的设备展示</AlertTitle>
                <AlertDescription>扫码会直接关联当前账号，不需要输入账号密码。</AlertDescription>
              </Alert>
            ) : pairingStatus === "consumed" ? (
              <Alert>
                <CheckCircle2Icon />
                <AlertTitle>手机已成功关联</AlertTitle>
                <AlertDescription>二维码已经失效，手机正在初始化同步空间。</AlertDescription>
              </Alert>
            ) : pairingStatus === "expired" ? (
              <Alert variant="destructive">
                <XCircleIcon />
                <AlertTitle>二维码已过期</AlertTitle>
                <AlertDescription>请刷新二维码后再扫描。</AlertDescription>
              </Alert>
            ) : (
              <>
                <div className="rounded-lg border bg-background p-4">
                  <QRCode value={pairing.pairingUri} size={224} title="NoteGen 手机设备配对二维码" />
                </div>
                <Badge variant="outline">剩余 {formatRemainingTime(remainingSeconds)}</Badge>
                <p className="text-center text-sm text-muted-foreground">
                  二维码包含一次性配对凭据。扫码成功或倒计时结束后会自动失效。
                </p>
              </>
            )}
          </CardContent>
          <CardFooter className="flex flex-wrap gap-2">
            <Button onClick={() => void createPairing()} disabled={pairingBusy}>
              {pairingBusy ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
              {pairing ? "刷新二维码" : "生成配对二维码"}
            </Button>
            {pairing ? (
              <Button variant="outline" onClick={() => void cancelPairing()} disabled={pairingBusy}>
                <Trash2Icon data-icon="inline-start" />
                撤销二维码
              </Button>
            ) : null}
          </CardFooter>
        </Card>
      ) : null}
      </div>
    </>
  )

  if (embedded) return content

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-5xl flex-col gap-6 p-6 md:justify-center md:p-10">
      {content}
    </main>
  )
}

const errorMessage = userFacingErrorMessage

function formatRemainingTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

function redirectToLogin(): void {
  const returnPath = `${window.location.pathname}${window.location.search}`
  const loginUrl = new URL("/", window.location.origin)
  loginUrl.searchParams.set("next", returnPath)
  window.location.replace(loginUrl.toString())
}
