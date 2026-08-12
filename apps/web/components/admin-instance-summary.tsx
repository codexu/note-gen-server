"use client"

import { useCallback, useEffect, useState } from "react"
import { ActivityIcon, CircleAlertIcon, DatabaseIcon, GaugeIcon, HardDriveIcon, UsersIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Skeleton } from "@/components/ui/skeleton"
import { apiRequest, userFacingErrorMessage, type AdminSummary } from "@/lib/api"
import { formatRelativeTime } from "@/lib/relative-time"

export function AdminInstanceSummary({ refreshVersion = 0 }: { refreshVersion?: number }) {
  const [summary, setSummary] = useState<AdminSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      setSummary(await apiRequest<AdminSummary>("/v1/web/admin/summary"))
    } catch (cause) {
      setError(userFacingErrorMessage(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load, refreshVersion])
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === "visible") void load() }
    document.addEventListener("visibilitychange", onVisibility)
    return () => document.removeEventListener("visibilitychange", onVisibility)
  }, [load])

  if (loading && summary === null) return <SummarySkeleton />
  if (error && summary === null) return <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>无法读取实例状态</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>
  if (summary === null) return null

  const metrics = [
    { label: "账号", value: summary.overview.accountCount, detail: `${summary.overview.activeAccountCount} 个可用`, icon: UsersIcon },
    { label: "工作区", value: summary.overview.workspaceCount, detail: `${summary.overview.objectCount} 项内容`, icon: DatabaseIcon },
    { label: "设备", value: summary.overview.activeDeviceCount, detail: "当前有效授权", icon: ActivityIcon },
    { label: "存储", value: formatBytes(summary.system.databaseBytes), detail: `${summary.system.blobCount} 个保留 Blob`, icon: HardDriveIcon },
  ]

  return <div className="flex flex-col gap-6">
    {error ? <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>部分状态可能已经过期</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {metrics.map(({ label, value, detail, icon: Icon }) => <Card key={label}><CardHeader><CardDescription>{label}</CardDescription><CardTitle className="text-3xl tabular-nums">{value}</CardTitle></CardHeader><CardContent className="flex items-center gap-2 text-sm text-muted-foreground"><Icon />{detail}</CardContent></Card>)}
    </div>
    <div className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
      <Card><CardHeader><CardTitle>需要关注</CardTitle><CardDescription>仅显示服务端确认存在或尚未完成的事项。</CardDescription></CardHeader><CardContent>
        {summary.attention.length ? <ItemGroup>{summary.attention.map((item) => <Item key={item.code} variant="outline"><ItemMedia variant="icon"><CircleAlertIcon /></ItemMedia><ItemContent><ItemTitle>{attentionTitle(item.code)}</ItemTitle><ItemDescription>{attentionDescription(item.code, item.details)}</ItemDescription></ItemContent><ItemActions><Badge variant={item.severity === "blocking" ? "destructive" : item.severity === "warning" ? "secondary" : "outline"}>{item.count}</Badge></ItemActions></Item>)}</ItemGroup> : <Alert><GaugeIcon /><AlertTitle>当前没有待处理事项</AlertTitle><AlertDescription>实例、后台任务和队列均未报告异常。</AlertDescription></Alert>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>运行状态</CardTitle><CardDescription>v{summary.serverVersion} · {formatRelativeTime(summary.generatedAt)}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3 text-sm">
        <StatusRow label="数据库响应" value={`${summary.system.databaseLatencyMs} ms`} />
        <StatusRow label="运行时间" value={formatDuration(summary.system.uptimeSeconds)} />
        <StatusRow label="后台任务" value={`${summary.operations.activeJobs} 运行 / ${summary.operations.failedJobs} 失败`} />
        <StatusRow label="邮件队列" value={`${summary.operations.pendingMail} 等待 / ${summary.operations.failedMail} 失败`} />
        <StatusRow label="维护模式" value={summary.operations.maintenanceMode} />
        <StatusRow label="最近统一备份" value={summary.operations.latestBackupStatus ?? "尚无记录"} />
      </CardContent></Card>
    </div>
  </div>
}

function SummarySkeleton() {
  return <div className="flex flex-col gap-6"><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-32 rounded-xl" />)}</div><Skeleton className="h-72 rounded-xl" /></div>
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-4"><span className="text-muted-foreground">{label}</span><span className="text-right font-medium">{value}</span></div>
}

function attentionTitle(code: string): string {
  return ({
    maintenance_mode_active: "实例处于维护模式",
    background_jobs_failed: "后台任务需要处理",
    mail_delivery_failed: "邮件投递存在失败",
    backup_not_configured: "尚未生成统一备份",
    backup_not_ready: "最近备份尚未就绪",
    restore_drill_missing: "尚未完成恢复演练",
  } as Record<string, string>)[code] ?? code
}

function attentionDescription(code: string, details: Record<string, string | number | boolean | null>): string {
  if (code === "maintenance_mode_active") return `当前模式：${String(details.mode ?? "unknown")}`
  if (code === "backup_not_ready") return `最近状态：${String(details.status ?? "unknown")}`
  if (code === "restore_drill_missing") return "实验功能页会说明当前恢复能力与安全门槛。"
  if (code === "backup_not_configured") return "统一备份仍是实验能力，不会在此处提供无效的创建按钮。"
  return "请在对应管理页面查看详细状态。"
}

function formatBytes(raw: string): string {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  return days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时`
}
