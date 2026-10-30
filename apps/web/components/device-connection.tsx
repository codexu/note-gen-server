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
  const [accountId, setAccountId] = useState<string | null>(null)
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
  const [target, setTarget] = useState<"current" | "other">("current")
  const [method, setMethod] = useState<"code" | "qr">("qr")
  const authorizationRequestId = useRef(0)
  const activePairing = useRef<{ id: string, status: DevicePairingStatus | null, accountId: string | null } | null>(null)

  useEffect(() => {
    const initialCode = new URLSearchParams(window.location.search).get("code") ?? ""
    setCode(formatDeviceCode(initialCode))
    if (initialCode) {
      setTarget("other")
      setMethod("code")
      const url = new URL(window.location.href)
      url.pathname = "/connect/"
      url.searchParams.set("section", "connect")
      window.history.replaceState(null, "", url)
    }
    void apiRequest<{ publicBaseUrl: string }>("/v1/capabilities")
      .then((result) => setServerAddress(result.publicBaseUrl))
      .catch(() => setServerAddressError("无法读取服务器地址，请刷新页面后重试。"))
    void apiRequest<{ account: { id: string } }>("/v1/web/session")
      .then((session) => {
        setAccountId(session.account.id)
        setSignedIn(true)
        if (initialCode) {
          storeCurrentDevicePairing(session.account.id, null)
          void loadAuthorization(initialCode)
        }
        else {
          const savedPairing = readCurrentDevicePairing(session.account.id)
          if (savedPairing) {
            setPairing(savedPairing)
            setPairingStatus("pending")
            setRemainingSeconds(savedPairing.expiresIn)
          }
        }
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
    activePairing.current = pairing ? { id: pairing.id, status: pairingStatus, accountId } : null
  }, [pairing, pairingStatus, accountId])

  useEffect(() => () => {
    const current = activePairing.current
    if (current?.accountId) storeCurrentDevicePairing(current.accountId, null)
    if (current?.status === "pending") {
      void apiRequest(`/v1/web/device-pairings/${current.id}`, { method: "DELETE", csrf: true }).catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    if (!pairing || pairingStatus !== "pending") return
    let active = true
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
      ).then((result) => {
        if (!active) return
        setPairingStatus(result.status)
        setPairingError("")
      }).catch((cause) => {
        if (!active) return
        if (isApiRequestError(cause) && cause.status === 404) {
          setPairingStatus("expired")
          setPairingError("")
          return
        }
        setPairingError(errorMessage(cause))
      })
    }, 2_000)
    return () => {
      active = false
      window.clearInterval(countdown)
      window.clearInterval(polling)
    }
  }, [pairing, pairingStatus])

  async function replacePairing(): Promise<DevicePairing> {
    if (pairing?.id && pairingStatus === "pending") {
      await apiRequest(`/v1/web/device-pairings/${pairing.id}`, { method: "DELETE", csrf: true }).catch((cause) => {
        if (!isPairingUnavailable(cause)) throw cause
      })
      if (accountId) storeCurrentDevicePairing(accountId, null)
    }
    const result = await apiRequest<DevicePairing>("/v1/web/device-pairings", {
      method: "POST",
      csrf: true,
    })
    setPairing(result)
    setPairingStatus("pending")
    setRemainingSeconds(result.expiresIn)
    if (target === "current" && accountId) storeCurrentDevicePairing(accountId, result)
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

  async function cancelPairing(): Promise<boolean> {
    if (!pairing) return true
    setPairingBusy(true)
    setPairingError("")
    try {
      if (pairingStatus === "pending") {
        await apiRequest(`/v1/web/device-pairings/${pairing.id}`, { method: "DELETE", csrf: true }).catch((cause) => {
          if (!isPairingUnavailable(cause)) throw cause
        })
      }
      setPairing(null)
      setPairingStatus(null)
      if (accountId) storeCurrentDevicePairing(accountId, null)
      return true
    } catch (cause) {
      setPairingError(errorMessage(cause))
      return false
    } finally {
      setPairingBusy(false)
    }
  }

  async function changeTarget(nextTarget: "current" | "other"): Promise<boolean> {
    if (nextTarget === target) return true
    if (pairing && !await cancelPairing()) return false
    setTarget(nextTarget)
    setPairingError("")
    return true
  }

  async function useDeviceCode() {
    if (await changeTarget("other")) setMethod("code")
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
        if (!isPairingUnavailable(cause)) {
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
            <p className="text-sm text-muted-foreground">先关联设备，再返回 NoteGen 查看工作区和同步进度。</p>
          </div>
        </div>
        <ThemeToggle />
      </header>
      )}
      {signedIn ? <ToggleGroup type="single" className="grid w-full grid-cols-2" variant="outline" spacing={0} value={target} disabled={pairingBusy || busy} onValueChange={(value) => { if (value === "current" || value === "other") void changeTarget(value) }} aria-label="选择要关联的设备"><ToggleGroupItem value="current">连接当前设备</ToggleGroupItem><ToggleGroupItem value="other">连接其他设备</ToggleGroupItem></ToggleGroup> : null}
      <div className="grid w-full items-start gap-6">
      {signedIn && target === "current" ? (
        <Card>
          <CardHeader>
            <CardTitle>连接这台设备上的 NoteGen</CardTitle>
            <CardDescription>已安装 NoteGen 时，点击下方按钮打开应用并关联当前账号。首次连接后，请在客户端确认工作区和同步进度。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {pairingError ? <Alert variant="destructive"><ShieldCheckIcon /><AlertTitle>暂时无法关联</AlertTitle><AlertDescription>{pairingError}</AlertDescription></Alert> : null}
            {pairingStatus === "consumed" ? <Alert><CheckCircle2Icon /><AlertTitle>设备已关联</AlertTitle><AlertDescription>请回到 NoteGen，确认工作区并查看首次同步进度。</AlertDescription></Alert>
              : pairingStatus === "expired" ? <Alert><XCircleIcon /><AlertTitle>这次关联已过期</AlertTitle><AlertDescription>请重新点击“打开 NoteGen 并关联”，生成新的关联请求。</AlertDescription></Alert>
              : pairingStatus === "pending" ? <Alert><LaptopIcon /><AlertTitle>等待 NoteGen 完成关联</AlertTitle><AlertDescription>请在浏览器提示中允许打开 NoteGen。此次请求剩余 {formatRemainingTime(remainingSeconds)}，成功后会自动更新。</AlertDescription></Alert> : null}
            <p className="text-sm text-muted-foreground">应用没有打开时，也可以在 NoteGen 的同步设置中发起浏览器授权，再使用客户端验证码完成关联。</p>
          </CardContent>
          <CardFooter className="flex flex-wrap gap-2">
            <Button onClick={() => void openPairingInNoteGen()} disabled={pairingBusy || pairingStatus === "consumed"}>
              {pairingBusy ? <Spinner data-icon="inline-start" /> : <ExternalLinkIcon data-icon="inline-start" />}
              {pairingStatus === "pending" ? "重新打开 NoteGen 并关联" : "打开 NoteGen 并关联"}
            </Button>
            {pairingStatus === "pending" ? <Button variant="outline" disabled={pairingBusy} onClick={() => void cancelPairing()}>取消这次关联</Button> : null}
            <Button variant="outline" disabled={pairingBusy} onClick={() => void useDeviceCode()}>改用客户端验证码</Button>
          </CardFooter>
        </Card>
      ) : null}
      {signedIn && target === "other" ? <ToggleGroup type="single" className="grid w-full grid-cols-2" variant="outline" spacing={0} value={method} disabled={pairingBusy || busy} onValueChange={(value) => { if (value === "code" || value === "qr") void changeMethod(value) }} aria-label="选择关联方式"><ToggleGroupItem value="qr">手机扫码</ToggleGroupItem><ToggleGroupItem value="code">客户端验证码</ToggleGroupItem></ToggleGroup> : null}
      {signedIn !== true || (target === "other" && method === "code") ? (
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
                {completed === "approved" ? <span>请返回刚才显示验证码的 NoteGen，确认工作区并查看同步进度。</span> : null}
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
                  在要连接的 NoteGen 客户端中打开“设置 → 同步”，填写此地址并选择浏览器授权，再将客户端显示的验证码填到下方。
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
      {signedIn && target === "other" && method === "qr" ? (
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
                <AlertDescription>二维码已经失效。请在手机 NoteGen 中确认工作区并查看同步进度。</AlertDescription>
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

function isPairingUnavailable(cause: unknown): boolean {
  return isApiRequestError(cause) && (cause.status === 404 || cause.code === "pairing_not_pending")
}

function storeCurrentDevicePairing(accountId: string, pairing: DevicePairing | null): void {
  try {
    const key = `notegen:current-device-pairing:${accountId}`
    if (pairing) window.sessionStorage.setItem(key, JSON.stringify({ id: pairing.id, expiresAt: pairing.expiresAt }))
    else window.sessionStorage.removeItem(key)
  } catch {
    // Pairing still works when the browser does not allow session storage.
  }
}

function readCurrentDevicePairing(accountId: string): DevicePairing | null {
  try {
    const stored: unknown = JSON.parse(window.sessionStorage.getItem(`notegen:current-device-pairing:${accountId}`) ?? "null")
    if (typeof stored === "object" && stored !== null && "id" in stored && typeof stored.id === "string"
      && /^[a-f0-9-]{36}$/i.test(stored.id) && "expiresAt" in stored && typeof stored.expiresAt === "string") {
      const expiresIn = Math.ceil((Date.parse(stored.expiresAt) - Date.now()) / 1_000)
      if (Number.isFinite(expiresIn) && expiresIn > 0) {
        // The one-time credential is never persisted; only the authenticated status lookup is restored.
        return { id: stored.id, expiresAt: stored.expiresAt, expiresIn, pairingUri: "" }
      }
    }
  } catch {
    // Ignore expired, invalid, or unavailable browser session data.
  }
  storeCurrentDevicePairing(accountId, null)
  return null
}

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
