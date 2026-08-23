"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { CheckCircle2Icon, CopyIcon, ExternalLinkIcon, LaptopIcon, QrCodeIcon, RefreshCwIcon, ShieldCheckIcon, Trash2Icon, XCircleIcon } from "lucide-react"
import QRCode from "react-qr-code"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
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
  const [serverAddress, setServerAddress] = useState("")
  const [serverAddressError, setServerAddressError] = useState("")
  const [serverAddressCopied, setServerAddressCopied] = useState(false)
  const [method, setMethod] = useState<"code" | "qr">("code")
  const authorizationRequestId = useRef(0)
  const activePairing = useRef<{ id: string, status: DevicePairingStatus | null } | null>(null)

  useEffect(() => {
    const initialCode = new URLSearchParams(window.location.search).get("code") ?? ""
    setCode(formatDeviceCode(initialCode))
    if (initialCode) {
      const url = new URL(window.location.href)
      url.pathname = "/connect/"
      url.searchParams.set("section", "connect")
      window.history.replaceState(null, "", url)
    }
    void apiRequest<{ publicBaseUrl: string }>("/v1/capabilities")
      .then((result) => setServerAddress(result.publicBaseUrl))
      .catch(() => setServerAddressError("无法读取服务器地址，请刷新页面后重试。"))
    void apiRequest("/v1/web/session")
      .then(() => {
        setSignedIn(true)
        if (initialCode) void loadAuthorization(initialCode)
      })
      .catch((cause) => {
        if (isApiRequestError(cause) && cause.status === 401) {
          setSignedIn(false)
          return
        }
        setError(errorMessage(cause))
      })
  }, [])

  useEffect(() => {
    activePairing.current = pairing ? { id: pairing.id, status: pairingStatus } : null
  }, [pairing, pairingStatus])

  useEffect(() => () => {
    const current = activePairing.current
    if (current?.status === "pending") {
      void apiRequest(`/v1/web/device-pairings/${current.id}`, { method: "DELETE", csrf: true }).catch(() => undefined)
    }
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
        if (isApiRequestError(cause) && cause.status === 404) {
          setPairingStatus("expired")
          setPairingError("")
          return
        }
        setPairingError(errorMessage(cause))
      })
    }, 2_000)
    return () => {
      window.clearInterval(countdown)
      window.clearInterval(polling)
    }
  }, [pairing, pairingStatus])

  async function replacePairing(): Promise<DevicePairing> {
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
    return result
  }

  async function createPairing() {
    setPairingBusy(true)
    setPairingError("")
    try {
      await replacePairing()
    } catch (cause) {
      setPairingError(errorMessage(cause))
    } finally {
      setPairingBusy(false)
    }
  }

  async function openPairingInNoteGen() {
    setPairingBusy(true)
    setPairingError("")
    try {
      const result = await replacePairing()
      window.location.assign(result.pairingUri)
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

  async function changeMethod(nextMethod: "code" | "qr") {
    if (nextMethod === method) return
    if (nextMethod === "qr") {
      setMethod("qr")
      if (!pairing || pairingStatus !== "pending") void createPairing()
      return
    }
    if (pairing?.id && pairingStatus === "pending") {
      setPairingBusy(true)
      setPairingError("")
      try {
        await apiRequest(`/v1/web/device-pairings/${pairing.id}`, { method: "DELETE", csrf: true })
      } catch (cause) {
        if (!(isApiRequestError(cause) && cause.status === 404)) {
          setPairingError(errorMessage(cause))
          setPairingBusy(false)
          return
        }
      }
      setPairingBusy(false)
    }
    setPairing(null)
    setPairingStatus(null)
    setMethod("code")
  }

  async function loadAuthorization(value = code) {
    const requestId = authorizationRequestId.current + 1
    authorizationRequestId.current = requestId
    setBusy(true)
    setError("")
    try {
      const result = await apiRequest<DeviceAuthorization>(
        `/v1/web/device-authorizations/${encodeURIComponent(value)}`
      )
      if (requestId !== authorizationRequestId.current) return
      setAuthorization(result)
      if (result.status === "approved" || result.status === "denied") {
        setCompleted(result.status)
        removeAuthorizationCodeFromUrl()
      }
    } catch (cause) {
      if (requestId !== authorizationRequestId.current) return
      setAuthorization(null)
      setError(errorMessage(cause))
    } finally {
      if (requestId === authorizationRequestId.current) setBusy(false)
    }
  }

  async function copyServerAddress() {
    if (!serverAddress) return
    setServerAddressError("")
    try {
      await navigator.clipboard.writeText(serverAddress)
      setServerAddressCopied(true)
      window.setTimeout(() => setServerAddressCopied(false), 2_000)
    } catch {
      setServerAddressError("复制失败，请手动选择并复制服务器地址。")
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
      removeAuthorizationCodeFromUrl()
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
      {signedIn ? <ToggleGroup className="grid w-full grid-cols-2" variant="outline" spacing={0} value={[method]} disabled={pairingBusy} onValueChange={(value) => { if (value[0]) void changeMethod(value[0] as "code" | "qr") }}><ToggleGroupItem value="code">输入验证码</ToggleGroupItem><ToggleGroupItem value="qr">手机扫码</ToggleGroupItem></ToggleGroup> : null}
      <div className="grid w-full items-start gap-6">
      {method === "code" ? (
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
              <AlertDescription className="flex flex-col gap-3">
                <span>
                  {completed === "approved" ? "设备授权已确认，可以直接打开 NoteGen 完成关联。" : "这次授权不会签发任何设备会话。"}
                </span>
                {completed === "approved" ? <span>请返回刚才显示验证码的 NoteGen，客户端会自动继续连接。</span> : null}
              </AlertDescription>
            </Alert>
          ) : (
            <FieldGroup>
              <Field data-invalid={serverAddressError ? true : undefined}>
                <FieldLabel htmlFor="server-address">同步服务器地址</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id="server-address"
                    className="min-w-0"
                    value={serverAddress}
                    placeholder="正在读取服务器地址…"
                    readOnly
                    aria-invalid={serverAddressError ? true : undefined}
                  />
                  <Button
                    type="button"
                    className="shrink-0"
                    variant="outline"
                    disabled={!serverAddress}
                    onClick={() => void copyServerAddress()}
                  >
                    {serverAddressCopied ? (
                      <CheckCircle2Icon data-icon="inline-start" />
                    ) : (
                      <CopyIcon data-icon="inline-start" />
                    )}
                    {serverAddressCopied ? "已复制" : "复制地址"}
                  </Button>
                </div>
                <FieldDescription>
                  在 NoteGen 客户端的同步设置中填写此地址，然后输入下方验证码完成关联。
                </FieldDescription>
                <FieldError>{serverAddressError}</FieldError>
              </Field>
              <Field>
                <FieldLabel htmlFor="device-code">设备验证码</FieldLabel>
                <Input
                  id="device-code"
                  value={code}
                  onChange={(event) => {
                    const nextCode = formatDeviceCode(event.target.value)
                    authorizationRequestId.current += 1
                    setCode(nextCode)
                    setAuthorization(null)
                    setCompleted(null)
                    if (signedIn && nextCode.length === 9) void loadAuthorization(nextCode)
                  }}
                  placeholder="ABCD-EFGH"
                  autoCapitalize="characters"
                  autoCorrect="off"
                />
                <FieldDescription>验证码由 NoteGen 客户端显示，5 分钟内有效且只能使用一次。</FieldDescription>
              </Field>
              {signedIn && !authorization ? (
                <Button onClick={() => void loadAuthorization()} disabled={busy || code.length !== 9}>
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
              <AlertDescription className="grid gap-1">
                <span>平台：{authorization.platform}</span>
                <span className="break-all">设备 ID：{authorization.deviceId}</span>
                <span>验证码：{authorization.userCode}</span>
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
      ) : null}
      {signedIn && method === "qr" ? (
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
                <AlertDescription>二维码可能已过期或被撤销，请重新生成后再扫描。</AlertDescription>
              </Alert>
            ) : (
              <>
                <div className="rounded-lg border bg-background p-4">
                  <QRCode value={pairing.pairingUri} size={224} title="NoteGen 手机设备配对二维码" />
                </div>
                <Badge variant="outline">剩余 {formatRemainingTime(remainingSeconds)}</Badge>
                <span className="sr-only" aria-live="polite">{remainingSeconds === 60 ? "二维码还有一分钟过期" : remainingSeconds === 10 ? "二维码还有十秒过期" : ""}</span>
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
            <Button variant="outline" onClick={() => void openPairingInNoteGen()} disabled={pairingBusy}>
              <ExternalLinkIcon data-icon="inline-start" />
              打开 NoteGen 关联
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

function formatDeviceCode(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8)
  return normalized.length > 4 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized
}

const errorMessage = userFacingErrorMessage

function formatRemainingTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

function removeAuthorizationCodeFromUrl(): void {
  const url = new URL(window.location.href)
  url.searchParams.delete("code")
  url.searchParams.set("section", "connect")
  window.history.replaceState(null, "", url)
}
