"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { BeakerIcon, CircleAlertIcon, FlaskConicalIcon, LockKeyholeIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Skeleton } from "@/components/ui/skeleton"
import { apiRequest, userFacingErrorMessage, type AdminCapabilities, type AdminCapability } from "@/lib/api"

export function ExperimentalCenter({ refreshVersion = 0 }: { refreshVersion?: number }) {
  const [data, setData] = useState<AdminCapabilities | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const load = useCallback(async () => {
    setLoading(true); setError("")
    try { setData(await apiRequest<AdminCapabilities>("/v1/web/admin/capabilities")) }
    catch (cause) { setError(userFacingErrorMessage(cause)) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load, refreshVersion])
  const rows = useMemo(() => data?.capabilities.filter((item) => item.lifecycle === "experimental") ?? [], [data])

  if (loading) return <div className="grid gap-4 lg:grid-cols-2">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-40 rounded-xl" />)}</div>
  if (error) return <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>无法读取实验能力</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>

  return <div className="flex max-w-5xl flex-col gap-6">
    <Alert><BeakerIcon /><AlertTitle>实验入口不会绕过服务端安全门槛</AlertTitle><AlertDescription>这里保留尚未稳定开放的功能及其启用条件。不可用项目只展示状态，不会调用对应写接口。</AlertDescription></Alert>
    <Card><CardHeader><CardTitle>实验能力</CardTitle><CardDescription>当前为独立实例；实验能力只有满足服务端安全条件后才可启用。</CardDescription></CardHeader><CardContent>
      <ItemGroup>{rows.map((item) => <CapabilityRow key={item.id} item={item} />)}</ItemGroup>
    </CardContent></Card>
  </div>
}

function CapabilityRow({ item }: { item: AdminCapability }) {
  return <Item variant="outline"><ItemMedia variant="icon">{item.status === "unavailable" ? <LockKeyholeIcon /> : <FlaskConicalIcon />}</ItemMedia><ItemContent><ItemTitle>{capabilityTitle(item.id)}</ItemTitle><ItemDescription>{capabilityDescription(item)}</ItemDescription></ItemContent><ItemActions><Badge variant={item.status === "available" ? "secondary" : item.status === "degraded" ? "destructive" : "outline"}>{statusLabel(item.status)}</Badge><Badge variant="outline">实验中</Badge></ItemActions></Item>
}

function capabilityTitle(id: string): string {
  return ({
    "identity.email": "邮箱身份",
    "identity.emailVerification": "邮箱验证",
    "identity.passwordReset": "密码找回",
    "operations.unifiedBackup": "统一备份",
    "operations.upgradeAssistant": "升级助手",
    "operations.preserveRestore": "原实例恢复",
  } as Record<string, string>)[id] ?? id
}

function capabilityDescription(item: AdminCapability): string {
  const reason = item.reasons.map((value) => ({
    unsupported_deployment_mode: "不支持当前部署模式",
    not_requested: "尚未启用",
    release_stage_gated: "当前发布阶段未开放",
    restore_safety_gated: "恢复安全门槛尚未完成",
    dependency_unavailable: "依赖能力不可用",
    mail_delivery_adapter_unavailable: "邮件适配器不可用",
    smtp_admin_surface_unavailable: "SMTP 管理能力未配置",
    registration_policy_gated: "当前注册策略未开放此能力",
    lifecycle_gated: "当前实例生命周期不允许此操作",
    capability_registry_unavailable: "服务端能力注册表不可用",
    available: "服务端已允许使用",
  } as Record<string, string>)[value] ?? value).join("；")
  return reason || "服务端没有提供更多状态说明。"
}

function statusLabel(status: AdminCapability["status"]): string {
  return ({ available: "可用", disabled: "未启用", unavailable: "不可用", degraded: "已降级" })[status]
}
