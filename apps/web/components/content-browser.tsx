"use client"

import { useState } from "react"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FileCogIcon,
  FileSearchIcon,
  FileTextIcon,
  FolderIcon,
  HistoryIcon,
  ListChecksIcon,
  LockKeyholeIcon,
  PaletteIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { SyncObjectKind, WebWorkspace } from "@/lib/api"
import {
  contentSummary,
  contentPath,
  contentTitle,
  displayPayload,
  type DecodedSyncObject,
} from "@/lib/workspace-content"

export type PrimaryContentKind = Extract<
  SyncObjectKind,
  "note" | "record" | "canvas" | "setting"
>
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
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | null>(
    null
  )
  const [deleteObjectCandidateId, setDeleteObjectCandidateId] = useState<
    string | null
  >(null)
  const [query, setQuery] = useState("")
  const selected =
    items.find((item) => item.object.objectId === selectedObjectId) ?? null
  const workspace = workspaces.find((item) => item.id === workspaceId)
  const orderedWorkspaces = sortWorkspaces(workspaces)
  const historicalWorkspaces = orderedWorkspaces.filter(
    (item) => !item.isDefault
  )
  const primaryWorkspaces = orderedWorkspaces
    .filter((item) => item.isDefault)
    .concat(historicalWorkspaces.slice(0, 4))
  const visibleWorkspaces = showAllWorkspaces
    ? orderedWorkspaces
    : includeSelectedWorkspace(primaryWorkspaces, workspace)
  const currentPage = total === 0 ? 1 : Math.floor(offset / pageSize) + 1
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN")
  const visibleItems = normalizedQuery
    ? items.filter((item) =>
        `${contentTitle(item)} ${contentSummary(item)}`
          .toLocaleLowerCase("zh-CN")
          .includes(normalizedQuery)
      )
    : items

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-4 rounded-xl border bg-card p-5 shadow-xs sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <FileSearchIcon />
            <h2 className="text-lg font-semibold tracking-tight">内容管理</h2>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            浏览已同步内容。选择左侧条目后，右侧会显示可读正文和同步信息。
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={
              !workspace ||
              workspace.encryptionMode !== "managed" ||
              creatingTestData
            }
            onClick={() => void onCleanupTestObjects()}
          >
            <Trash2Icon data-icon="inline-start" />
            清理测试数据
          </Button>
          <Button
            size="sm"
            disabled={
              !workspace ||
              workspace.encryptionMode !== "managed" ||
              creatingTestData
            }
            onClick={() => void onCreateTestObject()}
          >
            {creatingTestData ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <PlusIcon data-icon="inline-start" />
            )}
            生成测试{kindLabel(kind)}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="text-sm">工作区</CardTitle>
          <CardDescription>先选择要查看的同步空间</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          {historicalWorkspaces.length ? (
            <Alert className="mb-4">
              <HistoryIcon />
              <AlertTitle>
                发现 {historicalWorkspaces.length} 个历史工作区
              </AlertTitle>
              <AlertDescription>
                列表已按内容数量排列，优先展示最可能包含完整数据的工作区。
              </AlertDescription>
            </Alert>
          ) : null}
          {workspaces.length ? (
            <div className="flex flex-col gap-3">
              <ItemGroup className="grid gap-3 md:grid-cols-2">
                {visibleWorkspaces.map((item) => {
                  const active = item.id === workspaceId
                  return (
                    <Item
                      key={item.id}
                      variant={active ? "muted" : "outline"}
                      className={
                        active ? "border-primary/40 ring-1 ring-primary/20" : ""
                      }
                    >
                      <ItemMedia variant="icon">
                        {item.isDefault ? <ServerIcon /> : <HistoryIcon />}
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>
                          {item.isDefault
                            ? "当前默认工作区"
                            : `历史工作区 ${item.id.slice(0, 8)}`}
                        </ItemTitle>
                        <ItemDescription>
                          {item.objectCount} 项内容 · {item.deletedObjectCount}{" "}
                          项删除记录
                        </ItemDescription>
                        <ItemDescription>
                          更新于 {formatFixedDate(item.updatedAt)}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions className="flex-wrap justify-end">
                        <Badge
                          variant={item.isDefault ? "secondary" : "outline"}
                        >
                          {item.isDefault ? "默认" : "历史"}
                        </Badge>
                        <Badge variant="outline">
                          {item.encryptionMode === "managed"
                            ? "托管加密"
                            : "E2EE"}
                        </Badge>
                        <Button
                          size="sm"
                          variant={active ? "secondary" : "outline"}
                          disabled={active}
                          onClick={() => onWorkspaceChange(item.id)}
                        >
                          {active ? "已选择" : "查看"}
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
                <Button
                  variant="ghost"
                  onClick={() => setShowAllWorkspaces((current) => !current)}
                >
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
              <AlertDescription>
                连接 NoteGen 并完成首次同步后，保存的内容会显示在这里。
              </AlertDescription>
            </Alert>
          )}
          {workspace ? (
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-muted/50 px-3 py-2 text-sm">
              <span className="font-medium">
                正在查看：
                {workspace.isDefault
                  ? "当前默认工作区"
                  : `历史工作区 ${workspace.id.slice(0, 8)}`}
              </span>
              <span className="text-muted-foreground">
                {workspace.objectCount} 项当前内容
              </span>
              <span className="text-muted-foreground">
                {workspace.deletedObjectCount} 项删除记录
              </span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {workspace?.encryptionMode === "e2ee" ? (
        <Alert>
          <LockKeyholeIcon />
          <AlertTitle>端到端加密内容尚未解锁</AlertTitle>
          <AlertDescription>
            当前可以确认对象、版本和同步状态；正文需要同步口令或恢复密钥才能查看。
          </AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <LockKeyholeIcon />
          <AlertTitle>内容加载失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardContent className="flex flex-col gap-4 pt-5">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <Tabs
              value={kind}
              onValueChange={(value) =>
                onKindChange(value as PrimaryContentKind)
              }
            >
              <TabsList>
                <TabsTrigger value="note">笔记</TabsTrigger>
                <TabsTrigger value="record">记录</TabsTrigger>
                <TabsTrigger value="canvas">绘图</TabsTrigger>
                <TabsTrigger value="setting">配置</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative min-w-0 sm:w-72">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-9"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索标题或摘要"
                  aria-label="搜索当前页内容"
                />
              </div>
              <Tabs
                value={status}
                onValueChange={(value) =>
                  onStatusChange(value as ContentStatus)
                }
              >
                <TabsList>
                  <TabsTrigger value="active">当前内容</TabsTrigger>
                  <TabsTrigger value="deleted">删除记录</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </div>
          <div className="flex items-center justify-between border-b pb-3 text-sm">
            <p className="text-muted-foreground">
              {visibleItems.length
                ? `显示 ${visibleItems.length} / ${total} 项`
                : "没有匹配内容"}
            </p>
            <p className="text-muted-foreground">
              第 {currentPage} / {pageCount} 页
            </p>
          </div>

          {loading ? (
            <div className="flex min-h-64 items-center justify-center">
              <Spinner />
            </div>
          ) : items.length ? (
            <div className="grid items-start gap-4 xl:grid-cols-[minmax(20rem,0.85fr)_minmax(0,1.6fr)]">
              {visibleItems.length ? (
                <ItemGroup className="max-h-[42rem] overflow-y-auto pr-1">
                  {kind === "note" ? (
                    <NoteTree
                      items={visibleItems}
                      selectedObjectId={selectedObjectId}
                      onSelectObject={onSelectObject}
                    />
                  ) : (
                    visibleItems.map((item) => (
                      <ContentListItem
                        key={item.object.objectId}
                        item={item}
                        selected={item.object.objectId === selectedObjectId}
                        onSelect={() => onSelectObject(item.object.objectId)}
                      />
                    ))
                  )}
                </ItemGroup>
              ) : (
                <Alert>
                  <ListChecksIcon />
                  <AlertTitle>当前页没有匹配内容</AlertTitle>
                  <AlertDescription>
                    请更换关键词，或翻页后继续搜索。
                  </AlertDescription>
                </Alert>
              )}

              <Card className="min-w-0 xl:sticky xl:top-4">
                <CardHeader className="border-b bg-muted/20">
                  <CardTitle className="truncate">
                    {selected ? contentTitle(selected) : "选择一项内容"}
                  </CardTitle>
                  <CardDescription>
                    {selected
                      ? `${kindLabel(selected.object.kind)} · 更新于 ${formatFixedDate(selected.object.updatedAt)}`
                      : "从左侧选择一项，查看正文与同步元数据。"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4 pt-4">
                  {selected ? (
                    <>
                      <div className="flex flex-wrap gap-2">
                        {isAdminTestObject(selected) ? (
                          <Badge variant="secondary">后台测试数据</Badge>
                        ) : null}
                        <Badge variant="secondary">
                          版本 {selected.object.currentRevision}
                        </Badge>
                        <Badge variant="outline">
                          {formatBytes(selected.object.ciphertextBytes)} 密文
                        </Badge>
                        <Badge variant="outline">
                          密钥 v{selected.object.keyVersion}
                        </Badge>
                      </div>
                      <div className="rounded-lg border bg-background p-5">
                        <pre className="max-h-[32rem] overflow-auto font-sans text-sm leading-7 break-words whitespace-pre-wrap">
                          {displayPayload(selected)}
                        </pre>
                      </div>
                      {status === "active" &&
                      workspace?.encryptionMode === "managed" &&
                      deleteObjectCandidateId === selected.object.objectId ? (
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button
                            variant="destructive"
                            disabled={deletingObjectId !== null}
                            onClick={() =>
                              void onDeleteObject(selected.object.objectId)
                            }
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
                      ) : status === "active" &&
                        workspace?.encryptionMode === "managed" ? (
                        <div className="flex justify-end">
                          <Button
                            variant="destructive"
                            disabled={deletingObjectId !== null}
                            onClick={() =>
                              setDeleteObjectCandidateId(
                                selected.object.objectId
                              )
                            }
                          >
                            <Trash2Icon data-icon="inline-start" />
                            删除内容
                          </Button>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div className="flex min-h-64 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center">
                      <ListChecksIcon className="text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">
                        选择左侧内容开始阅读
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : (
            <Alert>
              {status === "deleted" ? <Trash2Icon /> : <ListChecksIcon />}
              <AlertTitle>
                {status === "deleted"
                  ? "没有删除记录"
                  : `还没有${kindLabel(kind)}`}
              </AlertTitle>
              <AlertDescription>
                当前工作区中没有符合条件的内容。连接 NoteGen
                并完成同步后会显示在这里。
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">共 {total} 项</p>
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
        </CardContent>
      </Card>
    </div>
  )
}

function sortWorkspaces(workspaces: WebWorkspace[]): WebWorkspace[] {
  return [...workspaces].sort(
    (left, right) =>
      Number(right.isDefault) - Number(left.isDefault) ||
      right.objectCount - left.objectCount ||
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  )
}

type NoteTreeNode = {
  name: string
  children: Map<string, NoteTreeNode>
  item?: DecodedSyncObject
}

function NoteTree({
  items,
  selectedObjectId,
  onSelectObject,
}: {
  items: DecodedSyncObject[]
  selectedObjectId: string | null
  onSelectObject: (value: string) => void
}) {
  const root: NoteTreeNode = { name: "", children: new Map() }

  for (const item of items) {
    const parts = contentPath(item).split("/").filter(Boolean)
    let current = root
    parts.forEach((part, index) => {
      const child = current.children.get(part) ?? {
        name: part,
        children: new Map<string, NoteTreeNode>(),
      }
      current.children.set(part, child)
      current = child
      if (index === parts.length - 1) current.item = item
    })
  }

  return (
    <NoteTreeNodes
      node={root}
      depth={0}
      selectedObjectId={selectedObjectId}
      onSelectObject={onSelectObject}
    />
  )
}

function NoteTreeNodes({
  node,
  depth,
  selectedObjectId,
  onSelectObject,
}: {
  node: NoteTreeNode
  depth: number
  selectedObjectId: string | null
  onSelectObject: (value: string) => void
}) {
  return [...node.children.values()]
    .sort(
      (left, right) =>
        Number(Boolean(right.item)) - Number(Boolean(left.item)) ||
        left.name.localeCompare(right.name, "zh-CN")
    )
    .map((child) => (
      <div key={child.name} className="flex flex-col gap-2">
        {child.item ? (
          <ContentListItem
            item={child.item}
            selected={child.item.object.objectId === selectedObjectId}
            onSelect={() => onSelectObject(child.item!.object.objectId)}
            indent={depth}
          />
        ) : (
          <div
            className="flex items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-sm font-medium"
            style={{ marginLeft: `${depth}rem` }}
          >
            <FolderIcon className="text-muted-foreground" />
            <span className="truncate">{child.name}</span>
          </div>
        )}
        {child.children.size ? (
          <NoteTreeNodes
            node={child}
            depth={depth + 1}
            selectedObjectId={selectedObjectId}
            onSelectObject={onSelectObject}
          />
        ) : null}
      </div>
    ))
}

function ContentListItem({
  item,
  selected,
  onSelect,
  indent = 0,
}: {
  item: DecodedSyncObject
  selected: boolean
  onSelect: () => void
  indent?: number
}) {
  const Icon = kindIcon(item.object.kind)
  return (
    <Item
      variant={selected ? "muted" : "outline"}
      className={
        selected
          ? "border-primary/40 ring-1 ring-primary/20"
          : "cursor-pointer hover:bg-muted/50"
      }
      style={
        indent
          ? { marginLeft: `${indent}rem`, width: `calc(100% - ${indent}rem)` }
          : undefined
      }
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onSelect()
      }}
    >
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>{contentTitle(item)}</ItemTitle>
        {item.object.kind !== "note" ? (
          <ItemDescription>{contentSummary(item)}</ItemDescription>
        ) : null}
        <ItemDescription>
          更新时间 {formatFixedDate(item.object.updatedAt)} · 版本{" "}
          {item.object.currentRevision}
          {item.object.kind !== "note" && item.object.blobRefs.length
            ? ` · ${item.object.blobRefs.length} 个附件`
            : ""}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {isAdminTestObject(item) ? (
          <Badge variant="secondary">测试</Badge>
        ) : null}
        {item.object.deletedAt ? <Badge variant="outline">已删除</Badge> : null}
      </ItemActions>
    </Item>
  )
}

function includeSelectedWorkspace(
  workspaces: WebWorkspace[],
  selected: WebWorkspace | undefined
): WebWorkspace[] {
  if (!selected || workspaces.some((item) => item.id === selected.id))
    return workspaces
  return [...workspaces, selected]
}

function isAdminTestObject(item: DecodedSyncObject): boolean {
  if (
    typeof item.payload !== "object" ||
    item.payload === null ||
    Array.isArray(item.payload)
  )
    return false
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
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  )
  const amount = bytes / 1024 ** index
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`
}

function formatFixedDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "时间未知"
  const pad = (part: number) => String(part).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
