"use client"

import { useState } from "react"
import {
  ChevronLeftIcon, ChevronRightIcon, FileCogIcon, FileTextIcon, HistoryIcon, ListChecksIcon,
  LockKeyholeIcon, PaletteIcon, PlusIcon, ServerIcon, Trash2Icon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle,
} from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { SyncObjectKind, WebWorkspace } from "@/lib/api"
import { formatRelativeTime as formatDate } from "@/lib/relative-time"
import {
  contentSummary, contentTitle, displayPayload, type DecodedSyncObject,
} from "@/lib/workspace-content"

export type PrimaryContentKind = Extract<SyncObjectKind, "note" | "record" | "canvas" | "setting">
export type ContentStatus = "active" | "deleted"

export function ContentBrowser({
  workspaces,
  workspaceId,
  kind,
  status,
  items,
  total,
  offset,
  pageSize,
  selectedObjectId,
  loading,
  error,
  deletingWorkspaceId,
  deletingObjectId,
  creatingTestData,
  onWorkspaceChange,
  onDeleteWorkspace,
  onCreateTestObject,
  onCleanupTestObjects,
  onDeleteObject,
  onKindChange,
  onStatusChange,
  onPageChange,
  onSelectObject,
}: {
  workspaces: WebWorkspace[]
  workspaceId: string
  kind: PrimaryContentKind
  status: ContentStatus
  items: DecodedSyncObject[]
  total: number
  offset: number
  pageSize: number
  selectedObjectId: string | null
  loading: boolean
  error: string
  deletingWorkspaceId: string | null
  deletingObjectId: string | null
  creatingTestData: boolean
  onWorkspaceChange: (value: string) => void
  onDeleteWorkspace: (value: string) => Promise<void>
  onCreateTestObject: () => Promise<void>
  onCleanupTestObjects: () => Promise<void>
  onDeleteObject: (value: string) => Promise<void>
  onKindChange: (value: PrimaryContentKind) => void
  onStatusChange: (value: ContentStatus) => void
  onPageChange: (offset: number) => void
  onSelectObject: (value: string) => void
}) {
  const [showAllWorkspaces, setShowAllWorkspaces] = useState(false)
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | null>(null)
  const [deleteObjectCandidateId, setDeleteObjectCandidateId] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const selected = items.find((item) => item.object.objectId === selectedObjectId) ?? null
  const workspace = workspaces.find((item) => item.id === workspaceId)
  const orderedWorkspaces = sortWorkspaces(workspaces)
  const historicalWorkspaces = orderedWorkspaces.filter((item) => !item.isDefault)
  const primaryWorkspaces = orderedWorkspaces.filter((item) => item.isDefault)
    .concat(historicalWorkspaces.slice(0, 4))
  const visibleWorkspaces = showAllWorkspaces
    ? orderedWorkspaces
    : includeSelectedWorkspace(primaryWorkspaces, workspace)
  const currentPage = total === 0 ? 1 : Math.floor(offset / pageSize) + 1
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN")
  const visibleItems = normalizedQuery
    ? items.filter((item) => `${contentTitle(item)} ${contentSummary(item)}`
      .toLocaleLowerCase("zh-CN").includes(normalizedQuery))
    : items

  return (
    <Card>
      <CardHeader>
        <CardTitle>内容管理</CardTitle>
        <CardDescription>
          逐项确认已同步的笔记、记录、绘图和配置；托管模式会在当前浏览器会话内自动解密。
        </CardDescription>
        <CardAction className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!workspace || workspace.encryptionMode !== "managed" || creatingTestData}
            onClick={() => void onCleanupTestObjects()}
          >
            <Trash2Icon data-icon="inline-start" />清理测试数据
          </Button>
          <Button
            size="sm"
            disabled={!workspace || workspace.encryptionMode !== "managed" || creatingTestData}
            onClick={() => void onCreateTestObject()}
          >
            {creatingTestData ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
            生成测试{kindLabel(kind)}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {historicalWorkspaces.length ? (
          <Alert>
            <HistoryIcon />
            <AlertTitle>发现 {historicalWorkspaces.length} 个历史工作区</AlertTitle>
            <AlertDescription>
              它们不是你主动创建的附加工作区。列表已按内容数量排列，优先展示最可能包含完整数据的工作区。
              测试产生的历史工作区可以在确认后软删除。
            </AlertDescription>
          </Alert>
        ) : null}

        {workspaces.length ? (
          <div className="flex flex-col gap-3">
            <ItemGroup>
              {visibleWorkspaces.map((item) => {
                const active = item.id === workspaceId
                return (
                  <Item key={item.id} variant="outline">
                    <ItemMedia variant="icon">{item.isDefault ? <ServerIcon /> : <HistoryIcon />}</ItemMedia>
                    <ItemContent>
                      <ItemTitle>
                        {item.isDefault ? "当前默认工作区" : `历史工作区 ${item.id.slice(0, 8)}`}
                      </ItemTitle>
                      <ItemDescription>
                        {item.objectCount} 项内容 · {item.deletedObjectCount} 项删除记录 · 创建于 {formatDate(item.createdAt)}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions className="flex-wrap justify-end">
                      <Badge variant={item.isDefault ? "secondary" : "outline"}>
                        {item.isDefault ? "默认" : "历史"}
                      </Badge>
                      <Badge variant="outline">{item.encryptionMode === "managed" ? "托管加密" : "E2EE"}</Badge>
                      <Button
                        size="sm"
                        variant={active ? "secondary" : "outline"}
                        disabled={active}
                        onClick={() => onWorkspaceChange(item.id)}
                      >
                        {active ? "正在查看" : "查看内容"}
                      </Button>
                      {!item.isDefault && deleteCandidateId === item.id ? (
                        <>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={deletingWorkspaceId !== null}
                            onClick={() => void onDeleteWorkspace(item.id)}
                          >
                            {deletingWorkspaceId === item.id ? (
                              <Spinner data-icon="inline-start" />
                            ) : (
                              <Trash2Icon data-icon="inline-start" />
                            )}
                            确认删除
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={deletingWorkspaceId !== null}
                            onClick={() => setDeleteCandidateId(null)}
                          >
                            取消
                          </Button>
                        </>
                      ) : !item.isDefault ? (
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={deletingWorkspaceId !== null}
                          onClick={() => setDeleteCandidateId(item.id)}
                        >
                          <Trash2Icon data-icon="inline-start" />
                          删除
                        </Button>
                      ) : null}
                    </ItemActions>
                  </Item>
                )
              })}
            </ItemGroup>
            {historicalWorkspaces.length > 4 ? (
              <Button variant="ghost" onClick={() => setShowAllWorkspaces((current) => !current)}>
                {showAllWorkspaces
                  ? "收起历史工作区"
                  : `显示全部 ${historicalWorkspaces.length} 个历史工作区`}
              </Button>
            ) : null}
          </div>
        ) : (
          <Alert>
            <ServerIcon />
            <AlertTitle>还没有同步工作区</AlertTitle>
            <AlertDescription>连接 NoteGen 并完成首次同步后，保存的内容会显示在这里。</AlertDescription>
          </Alert>
        )}

        {workspace ? (
          <Alert>
            <ListChecksIcon />
            <AlertTitle>
              正在查看{workspace.isDefault ? "当前默认工作区" : `历史工作区 ${workspace.id.slice(0, 8)}`}
            </AlertTitle>
            <AlertDescription>
              该工作区共有 {workspace.objectCount} 项当前内容和 {workspace.deletedObjectCount} 项删除记录。
            </AlertDescription>
          </Alert>
        ) : null}

        {workspace?.encryptionMode === "e2ee" ? (
          <Alert>
            <LockKeyholeIcon />
            <AlertTitle>端到端加密内容尚未解锁</AlertTitle>
            <AlertDescription>当前可以确认对象、版本和同步状态；正文需要同步口令或恢复密钥才能查看。</AlertDescription>
          </Alert>
        ) : null}

        {error ? (
          <Alert variant="destructive">
            <LockKeyholeIcon />
            <AlertTitle>内容加载失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <Tabs value={kind} onValueChange={(value) => onKindChange(value as PrimaryContentKind)}>
            <TabsList>
              <TabsTrigger value="note">笔记</TabsTrigger>
              <TabsTrigger value="record">记录</TabsTrigger>
              <TabsTrigger value="canvas">绘图</TabsTrigger>
              <TabsTrigger value="setting">配置</TabsTrigger>
            </TabsList>
          </Tabs>
          <Tabs value={status} onValueChange={(value) => onStatusChange(value as ContentStatus)}>
            <TabsList>
              <TabsTrigger value="active">当前内容</TabsTrigger>
              <TabsTrigger value="deleted">删除记录</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <Input
          className="max-w-md"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="在当前页搜索标题或内容摘要"
          aria-label="搜索当前页内容"
        />

        {loading ? (
          <div className="flex min-h-40 items-center justify-center"><Spinner /></div>
        ) : items.length ? (
          <div className="flex flex-col gap-4">
            <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
              {visibleItems.length ? (
                <ItemGroup>
                  {visibleItems.map((item) => {
                    const Icon = kindIcon(item.object.kind)
                    return (
                      <Item key={item.object.objectId} variant="outline">
                        <ItemMedia variant="icon"><Icon /></ItemMedia>
                        <ItemContent>
                          <ItemTitle>{contentTitle(item)}</ItemTitle>
                          <ItemDescription>{contentSummary(item)}</ItemDescription>
                          <ItemDescription>
                            {formatDate(item.object.updatedAt)} · 版本 {item.object.currentRevision}
                            {item.object.blobRefs.length ? ` · ${item.object.blobRefs.length} 个附件` : ""}
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          {isAdminTestObject(item) ? <Badge variant="secondary">后台测试</Badge> : null}
                          {item.object.deletedAt ? <Badge variant="outline">已删除</Badge> : null}
                          <Button size="sm" variant="outline" onClick={() => onSelectObject(item.object.objectId)}>
                            查看
                          </Button>
                        </ItemActions>
                      </Item>
                    )
                  })}
                </ItemGroup>
              ) : (
                <Alert>
                  <ListChecksIcon />
                  <AlertTitle>当前页没有匹配内容</AlertTitle>
                  <AlertDescription>请更换关键词，或翻页后继续搜索。</AlertDescription>
                </Alert>
              )}

              <Card>
                <CardHeader>
                  <CardTitle>{selected ? contentTitle(selected) : "选择一项内容"}</CardTitle>
                  <CardDescription>
                    {selected
                      ? `${kindLabel(selected.object.kind)} · 对象 ${selected.object.objectId} · 密钥 v${selected.object.keyVersion}`
                      : `共找到 ${total} 项，选择左侧条目查看内容和同步元数据。`}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {selected ? (
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-wrap gap-2">
                        {isAdminTestObject(selected) ? <Badge variant="secondary">后台测试数据</Badge> : null}
                        <Badge variant="secondary">revision {selected.object.currentRevision}</Badge>
                        <Badge variant="outline">{formatBytes(selected.object.ciphertextBytes)} 密文</Badge>
                        <Badge variant="outline">更新于 {formatDate(selected.object.updatedAt)}</Badge>
                      </div>
                      <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 text-sm">
                        {displayPayload(selected)}
                      </pre>
                      {status === "active" && workspace?.encryptionMode === "managed"
                        && deleteObjectCandidateId === selected.object.objectId ? (
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button
                            variant="destructive"
                            disabled={deletingObjectId !== null}
                            onClick={() => void onDeleteObject(selected.object.objectId)}
                          >
                            {deletingObjectId === selected.object.objectId ? (
                              <Spinner data-icon="inline-start" />
                            ) : (
                              <Trash2Icon data-icon="inline-start" />
                            )}
                            确认删除这项内容
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={deletingObjectId !== null}
                            onClick={() => setDeleteObjectCandidateId(null)}
                          >
                            取消
                          </Button>
                        </div>
                      ) : status === "active" && workspace?.encryptionMode === "managed" ? (
                        <div className="flex justify-end">
                          <Button
                            variant="destructive"
                            disabled={deletingObjectId !== null}
                            onClick={() => setDeleteObjectCandidateId(selected.object.objectId)}
                          >
                            <Trash2Icon data-icon="inline-start" />
                            删除内容
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">尚未选择内容。</p>
                  )}
                </CardContent>
              </Card>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                共 {total} 项 · 第 {currentPage} / {pageCount} 页
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={offset === 0}
                  onClick={() => onPageChange(Math.max(0, offset - pageSize))}
                >
                  <ChevronLeftIcon data-icon="inline-start" />
                  上一页
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={offset + items.length >= total}
                  onClick={() => onPageChange(offset + pageSize)}
                >
                  下一页
                  <ChevronRightIcon data-icon="inline-end" />
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <Alert>
            {status === "deleted" ? <Trash2Icon /> : <ListChecksIcon />}
            <AlertTitle>{status === "deleted" ? "没有删除记录" : `还没有${kindLabel(kind)}`}</AlertTitle>
            <AlertDescription>
              当前工作区中没有符合条件的内容。连接 NoteGen 并完成同步后会显示在这里。
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}

function sortWorkspaces(workspaces: WebWorkspace[]): WebWorkspace[] {
  return [...workspaces].sort((left, right) => (
    Number(right.isDefault) - Number(left.isDefault)
    || right.objectCount - left.objectCount
    || new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  ))
}

function includeSelectedWorkspace(
  workspaces: WebWorkspace[],
  selected: WebWorkspace | undefined
): WebWorkspace[] {
  if (!selected || workspaces.some((item) => item.id === selected.id)) return workspaces
  return [...workspaces, selected]
}

function isAdminTestObject(item: DecodedSyncObject): boolean {
  if (typeof item.payload !== "object" || item.payload === null || Array.isArray(item.payload)) return false
  return (item.payload as Record<string, unknown>).__noteGenAdminTest === true
}

function kindIcon(kind: SyncObjectKind) {
  if (kind === "note") return FileTextIcon
  if (kind === "record") return ListChecksIcon
  if (kind === "canvas") return PaletteIcon
  return FileCogIcon
}

function kindLabel(kind: string): string {
  if (kind === "note") return "笔记"
  if (kind === "record") return "记录"
  if (kind === "canvas") return "绘图"
  if (kind === "setting") return "配置"
  return kind
}

function formatBytes(value: string): string {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const amount = bytes / 1024 ** index
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`
}
