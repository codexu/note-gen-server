"use client"

import { useCallback, useEffect, useState } from "react"
import { CircleCheckIcon, FileOutputIcon, FileTextIcon, HeartHandshakeIcon, ShieldCheckIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { apiRequest, userFacingErrorMessage } from "@/lib/api"
import { formatRelativeTime } from "@/lib/relative-time"

type Policy = { id: string; type: string; version: string; effectiveAt: string; requiresReacceptance: boolean }
type DataRequest = { id: string; type: string; status: string; createdAt: string }
type Plan = { planKey: string; version: number; displayName: string; currency: string; amountMinor: string; interval: string }
type BillingSummary = { source: string; validUntil: string | null }
type SupportCase = { id: string; category: string; severity: string; subject: string; status: string; updatedAt: string }

export function ServiceCenter() {
  const [policies, setPolicies] = useState<Policy[]>([])
  const [requests, setRequests] = useState<DataRequest[]>([])
  const [plans, setPlans] = useState<Plan[]>([])
  const [summary, setSummary] = useState<BillingSummary | null>(null)
  const [cases, setCases] = useState<SupportCase[]>([])
  const [subject, setSubject] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    const results = await Promise.allSettled([
      apiRequest<Policy[]>("/v1/web/policies/current?locale=zh-CN"),
      apiRequest<DataRequest[]>("/v1/web/account/data-requests"),
      apiRequest<Plan[]>("/v1/web/billing/plans"),
      apiRequest<BillingSummary>("/v1/web/billing/summary"),
      apiRequest<SupportCase[]>("/v1/web/support/cases"),
    ])
    const [policy, dataRequests, catalog, entitlement, support] = results
    if (policy.status === "fulfilled") setPolicies(policy.value)
    if (dataRequests.status === "fulfilled") setRequests(dataRequests.value)
    if (catalog.status === "fulfilled") setPlans(catalog.value)
    if (entitlement.status === "fulfilled") setSummary(entitlement.value)
    if (support.status === "fulfilled") setCases(support.value)
    const failed = results.find((result) => result.status === "rejected")
    if (failed?.status === "rejected") setError(userFacingErrorMessage(failed.reason))
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  async function mutate(action: () => Promise<void>, message: string) {
    setBusy(true); setError(""); setNotice("")
    try { await action(); setNotice(message); await load() }
    catch (cause) { setError(userFacingErrorMessage(cause)) }
    finally { setBusy(false) }
  }

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      {error ? <Alert variant="destructive"><ShieldCheckIcon /><AlertTitle>操作失败</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      {notice ? <Alert><CircleCheckIcon /><AlertTitle>操作已完成</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert> : null}
      <Tabs defaultValue="membership">
        <TabsList className="w-full sm:w-fit"><TabsTrigger value="membership">权益</TabsTrigger><TabsTrigger value="privacy">数据与政策</TabsTrigger><TabsTrigger value="support">支持</TabsTrigger></TabsList>
        <TabsContent value="membership"><Card><CardHeader><CardTitle>当前权益</CardTitle><CardDescription>只显示内部测试套餐和权益；不会创建真实付款或 checkout。</CardDescription></CardHeader><CardContent className="flex flex-col gap-4">
          {loading ? <Spinner /> : <><div className="flex flex-wrap gap-2"><Badge variant="secondary">来源：{summary?.source ?? "未配置"}</Badge>{summary?.validUntil ? <Badge variant="outline">有效至 {formatRelativeTime(summary.validUntil)}</Badge> : null}</div><ItemGroup>{plans.map((plan) => <Item key={`${plan.planKey}-${plan.version}`} variant="outline"><ItemMedia variant="icon"><FileTextIcon /></ItemMedia><ItemContent><ItemTitle>{plan.displayName}</ItemTitle><ItemDescription>{plan.interval} · {plan.currency} {plan.amountMinor}</ItemDescription></ItemContent><ItemActions><Badge variant="outline">内部测试</Badge></ItemActions></Item>)}</ItemGroup>{!plans.length ? <p className="text-sm text-muted-foreground">当前没有可展示的内部套餐。</p> : null}</>}
        </CardContent></Card></TabsContent>
        <TabsContent value="privacy"><div className="grid gap-6 xl:grid-cols-2">
          <Card><CardHeader><CardTitle>政策记录</CardTitle><CardDescription>仅在服务端要求重新接受时才写入新的政策接受记录。</CardDescription></CardHeader><CardContent><ItemGroup>{policies.map((policy) => <Item key={policy.id} variant="outline"><ItemMedia variant="icon"><ShieldCheckIcon /></ItemMedia><ItemContent><ItemTitle>{policy.type} · v{policy.version}</ItemTitle><ItemDescription>生效于 {formatRelativeTime(policy.effectiveAt)}</ItemDescription></ItemContent><ItemActions>{policy.requiresReacceptance ? <Button size="sm" disabled={busy} onClick={() => void mutate(() => apiRequest(`/v1/web/policies/${policy.id}/accept`, { method: "POST", csrf: true, body: JSON.stringify({}) }).then(() => undefined), "政策接受记录已保存。")} >接受</Button> : <Badge variant="outline">已生效</Badge>}</ItemActions></Item>)}</ItemGroup></CardContent></Card>
          <Card><CardHeader><CardTitle>数据请求</CardTitle><CardDescription>内部测试可创建访问或导出请求；账号删除仍需要独立 step-up。</CardDescription></CardHeader><CardContent className="flex flex-col gap-4"><div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void mutate(() => apiRequest("/v1/web/account/data-requests", { method: "POST", csrf: true, body: JSON.stringify({ type: "access", idempotencyKey: crypto.randomUUID() }) }).then(() => undefined), "访问请求已提交。")}><FileTextIcon data-icon="inline-start" />请求访问</Button><Button variant="outline" disabled={busy} onClick={() => void mutate(() => apiRequest("/v1/web/account/data-requests", { method: "POST", csrf: true, body: JSON.stringify({ type: "export", idempotencyKey: crypto.randomUUID() }) }).then(() => undefined), "导出请求已进入内部测试队列。")}><FileOutputIcon data-icon="inline-start" />请求导出</Button></div><ItemGroup>{requests.map((request) => <Item key={request.id} variant="outline"><ItemContent><ItemTitle>{request.type}</ItemTitle><ItemDescription>创建于 {formatRelativeTime(request.createdAt)}</ItemDescription></ItemContent><ItemActions><Badge variant="outline">{request.status}</Badge></ItemActions></Item>)}</ItemGroup></CardContent></Card>
        </div></TabsContent>
        <TabsContent value="support"><div className="grid gap-6 xl:grid-cols-2">
          <Card><CardHeader><CardTitle>创建工单</CardTitle><CardDescription>请只提交必要的故障摘要，不要提交密码、恢复密钥或内容正文。</CardDescription></CardHeader><CardContent><FieldGroup><Field><FieldLabel htmlFor="support-subject">主题</FieldLabel><Input id="support-subject" value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={200} /></Field><Field><FieldLabel htmlFor="support-message">问题摘要</FieldLabel><Textarea id="support-message" value={message} onChange={(event) => setMessage(event.target.value)} maxLength={10_000} /><FieldDescription>后续会加入完整对话与受控诊断授权。</FieldDescription></Field><Field><Button disabled={busy || !subject.trim() || !message.trim()} onClick={() => void mutate(() => apiRequest("/v1/web/support/cases", { method: "POST", csrf: true, body: JSON.stringify({ category: "other", severity: "normal", subject: subject.trim(), body: message.trim(), idempotencyKey: crypto.randomUUID() }) }).then(() => { setSubject(""); setMessage("") }), "工单已创建。")}><HeartHandshakeIcon data-icon="inline-start" />创建工单</Button></Field></FieldGroup></CardContent></Card>
          <Card><CardHeader><CardTitle>我的工单</CardTitle><CardDescription>仅展示客户可见状态，不暴露内部备注或敏感诊断。</CardDescription></CardHeader><CardContent><ItemGroup>{cases.map((supportCase) => <Item key={supportCase.id} variant="outline"><ItemMedia variant="icon"><HeartHandshakeIcon /></ItemMedia><ItemContent><ItemTitle>{supportCase.subject}</ItemTitle><ItemDescription>{supportCase.category} · 更新于 {formatRelativeTime(supportCase.updatedAt)}</ItemDescription></ItemContent><ItemActions><Badge variant="outline">{supportCase.status}</Badge></ItemActions></Item>)}</ItemGroup>{!cases.length ? <p className="text-sm text-muted-foreground">还没有工单。</p> : null}</CardContent></Card>
        </div></TabsContent>
      </Tabs>
    </div>
  )
}
