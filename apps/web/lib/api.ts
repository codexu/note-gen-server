export type {
  AdminAccountContract as AdminAccount,
  AdminAccountPageContract as AdminAccountPage,
  AdminAuditEntryContract as AdminAuditEntry,
  AdminAuditPageContract as AdminAuditPage,
  AdminDeviceContract as AdminDevice,
  AdminDevicePageContract as AdminDevicePage,
  AdminOverviewContract as AdminOverview,
  AdminSystemStatusContract as AdminSystemStatus,
  AdminWorkspaceContract as AdminWorkspace,
  AdminWorkspacePageContract as AdminWorkspacePage,
  AccountContract as Account,
  DeviceAuthorizationContract as DeviceAuthorization,
  DeviceContract as Device,
  ServerCapabilitiesContract as ServerCapabilities,
  SyncObjectKindContract as SyncObjectKind,
  SyncOverviewContract as SyncOverview,
  WebSyncObjectContract as WebSyncObject,
  WebSyncObjectPageContract as WebSyncObjectPage,
  WebWorkspaceContract as WebWorkspace,
  WebWorkspaceKeyContract as WebWorkspaceKey,
} from "@notegen/contracts"

const apiBaseUrl = resolveApiBaseUrl()

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly retryable = false
  ) {
    super(message)
    this.name = "ApiRequestError"
  }
}

export function isApiRequestError(cause: unknown): cause is ApiRequestError {
  return cause instanceof ApiRequestError || (
    typeof cause === "object" &&
    cause !== null &&
    "status" in cause &&
    typeof cause.status === "number" &&
    "code" in cause &&
    typeof cause.code === "string"
  )
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit & { csrf?: boolean } = {}
): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  if (init.csrf) {
    const token = readCookie("notegen_csrf")
    if (token) headers.set("x-csrf-token", token)
  }
  const timeoutController = new AbortController()
  const timeout = window.setTimeout(() => timeoutController.abort(), 15_000)
  const signal = init.signal ?? timeoutController.signal
  let response: Response
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      headers,
      signal,
      credentials: "include",
    })
  } finally {
    window.clearTimeout(timeout)
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as {
      code?: string
      message?: string
      requestId?: string
      retryable?: boolean
    } | null
    throw new ApiRequestError(
      response.status,
      body?.code ?? "request_failed",
      body?.message ?? `请求失败（${response.status}）`,
      body?.requestId,
      body?.retryable ?? false
    )
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

const apiErrorMessages: Record<string, string> = {
  registration_closed: "服务器已关闭公开注册，请填写管理员提供的 Setup Token。",
  credentials_invalid: "账号或密码不正确，请检查后重试。",
  password_unchanged: "新密码不能与当前密码相同。",
  account_exists: "这个账号已经注册，请切换到“登录”。",
  account_not_found: "账号不存在或已停用。",
  account_pending_deletion: "该账号已经申请删除，不能再执行停用或恢复。",
  admin_required: "当前账号不是管理员，无法访问系统管理功能。",
  admin_self_disable_forbidden: "不能停用当前登录的管理员账号。",
  admin_self_demote_forbidden: "不能移除当前登录账号自己的管理员权限。",
  last_admin_disable_forbidden: "不能停用最后一个可用的管理员账号。",
  last_admin_demote_forbidden: "不能移除最后一个可用账号的管理员权限。",
  last_admin_delete_forbidden: "不能删除最后一个可用的管理员账号，请先设置其他管理员。",
  authorization_not_found: "没有找到这个设备验证码，请返回 NoteGen 重新发起连接。",
  authorization_not_pending: "设备验证码已过期或已经处理，请返回 NoteGen 重新发起连接。",
  authorization_expired: "设备验证码已过期，请返回 NoteGen 重新发起连接。",
  authorization_denied: "这次设备连接已被拒绝。",
  pairing_not_found: "没有找到这个扫码配对请求，请重新生成二维码。",
  pairing_not_pending: "配对二维码已过期、已使用或已撤销。",
  pairing_expired: "配对二维码无效或已经使用，请重新生成。",
  web_session_required: "请先登录同步账号。",
  web_session_invalid: "登录状态已过期，请重新登录。",
  csrf_invalid: "页面的安全凭据已过期，请刷新页面后重试。",
  origin_not_allowed: "当前页面地址未被服务器信任，请检查 Web 地址和 CORS 配置。",
  device_not_found: "设备不存在或已被删除。",
  device_revoked: "这台设备的授权已被撤销，请在 NoteGen 中重新连接。",
  workspace_default_delete_forbidden: "默认工作区不能从管理后台删除。",
  web_test_data_managed_only: "只有托管加密工作区可以从后台生成测试数据。",
  web_mutation_device_required: "请先关联并保留一台有效的 NoteGen 设备，再从后台修改同步内容。",
  object_not_found: "这项同步内容不存在或已经被清理。",
  object_already_deleted: "这项同步内容已经处于删除状态。",
  object_delete_conflict: "内容刚刚发生变化，请刷新后重新确认删除。",
  web_object_delete_managed_only: "这类内容只有在托管加密工作区中才能从后台安全删除。",
  web_object_payload_invalid: "无法解析这项内容的稳定身份，为避免客户端数据不一致，后台已取消删除。",
  web_test_data_conflict: "测试数据创建发生冲突，请刷新后重试。",
  rate_limited: "操作过于频繁，请稍等一会再试。",
  request_invalid: "提交的信息不完整或格式不正确，请检查后重试。",
  runtime_configuration_invalid: "运行配置中的数值关系无效，请检查保留周期和附件上限。",
  runtime_configuration_conflict: "运行配置已被其他管理员修改，请刷新后重试。",
  internal_error: "服务器处理请求时出错，请稍后重试。",
}

export function userFacingErrorMessage(cause: unknown): string {
  if (isApiRequestError(cause)) {
    const message = apiErrorMessages[cause.code] ?? statusErrorMessage(cause.status)
    return cause.requestId ? `${message}（请求编号：${cause.requestId}）` : message
  }
  if (cause instanceof TypeError) {
    return "无法连接同步服务器，请确认服务已启动并检查网络。"
  }
  return cause instanceof Error && cause.message
    ? `操作未完成：${cause.message}`
    : "操作未完成，请稍后重试。"
}

function resolveApiBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "")
  if (configured) return configured
  if (process.env.NODE_ENV !== "development") return ""
  if (typeof window === "undefined") return "http://127.0.0.1:3789"

  const url = new URL(window.location.origin)
  url.port = "3789"
  return url.origin
}

function statusErrorMessage(status: number): string {
  if (status === 400) return "提交的信息有误，请检查后重试。"
  if (status === 401) return "登录状态已失效，请重新登录。"
  if (status === 403) return "当前账号无权执行该操作。"
  if (status === 404) return "请求的资源不存在或已失效。"
  if (status === 409) return "当前操作与服务器状态冲突，请刷新后重试。"
  if (status === 429) return "操作过于频繁，请稍等一会再试。"
  if (status >= 500) return "同步服务器暂时无法完成请求，请稍后重试。"
  return `请求未完成（HTTP ${status}）。`
}

function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined
  const prefix = `${encodeURIComponent(name)}=`
  const item = document.cookie.split("; ").find((entry) => entry.startsWith(prefix))
  return item ? decodeURIComponent(item.slice(prefix.length)) : undefined
}
