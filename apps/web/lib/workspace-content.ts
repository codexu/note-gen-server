import type { WebSyncObject, WebWorkspaceKey } from "@/lib/api"

export interface DecodedSyncObject {
  object: WebSyncObject
  payload: unknown | null
  decryptionError: string | null
}

export async function unlockManagedWorkspaceKeys(
  versions: WebWorkspaceKey[]
): Promise<ReadonlyMap<number, CryptoKey>> {
  const keys = new Map<number, CryptoKey>()
  for (const version of versions) {
    const envelope = version.envelopes.find((item) => item.type === "managed")
    if (!envelope) continue
    const bytes = fromBase64Url(envelope.wrappedKey)
    if (bytes.byteLength !== 32) continue
    keys.set(
      version.keyVersion,
      await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [
        "decrypt",
      ])
    )
  }
  return keys
}

export async function decodeWorkspaceObject(
  object: WebSyncObject,
  keys: ReadonlyMap<number, CryptoKey>
): Promise<DecodedSyncObject> {
  const key = keys.get(object.keyVersion)
  if (!key) {
    return {
      object,
      payload: null,
      decryptionError: `缺少密钥 v${object.keyVersion}`,
    }
  }
  try {
    const bytes = fromBase64Url(object.ciphertext)
    if (bytes.byteLength <= 12) throw new Error("invalid encrypted payload")
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12) },
      key,
      bytes.slice(12)
    )
    return {
      object,
      payload: JSON.parse(new TextDecoder().decode(plaintext)) as unknown,
      decryptionError: null,
    }
  } catch {
    return {
      object,
      payload: null,
      decryptionError: "密文无法解密或内容格式不受支持",
    }
  }
}

export function contentTitle(item: DecodedSyncObject): string {
  const payload = recordPayload(item.payload)
  const value = recordPayload(payload?.value)
  if (item.object.kind === "note") {
    const path = stringValue(payload?.relativePath)
    return path
      ? path.split("/").at(-1)?.replace(/\.md$/i, "") || path
      : fallbackTitle(item)
  }
  const title =
    stringValue(payload?.title) ??
    stringValue(value?.title) ??
    stringValue(payload?.name) ??
    stringValue(value?.name) ??
    stringValue(payload?.label) ??
    stringValue(payload?.key) ??
    stringValue(payload?.relativePath)
  return title || fallbackTitle(item)
}

export function contentPath(item: DecodedSyncObject): string {
  const payload = recordPayload(item.payload)
  return stringValue(payload?.relativePath) ?? contentTitle(item)
}

export function contentSummary(item: DecodedSyncObject): string {
  if (item.decryptionError) return item.decryptionError
  const payload = recordPayload(item.payload)
  if (!payload) return "内容已解密，但没有可展示的结构化字段。"

  if (item.object.kind === "canvas") {
    const value = recordPayload(payload.value)
    const document = recordPayload(value?.document)
    const entries = [
      payload.nodes,
      payload.elements,
      payload.items,
      payload.shapes,
      document?.nodes,
    ].find((value) => Array.isArray(value))
    if (Array.isArray(entries)) return `绘图包含 ${entries.length} 个元素`
  }

  if (item.object.kind === "setting") {
    return compact(
      JSON.stringify(sanitizePayload(payload)) ?? "配置内容为空",
      180
    )
  }

  const text =
    stringValue(payload.content) ??
    stringValue(payload.text) ??
    stringValue(payload.transcript) ??
    stringValue(payload.description) ??
    stringValue(payload.value)
  if (text) return compact(text, 180)
  return compact(JSON.stringify(sanitizePayload(payload)), 180)
}

export function displayPayload(item: DecodedSyncObject): string {
  if (item.decryptionError) return item.decryptionError
  const payload = recordPayload(item.payload)
  if (
    item.object.kind === "note" &&
    payload &&
    typeof payload.content === "string"
  ) {
    return payload.content
  }
  return JSON.stringify(sanitizePayload(item.payload), null, 2) ?? "内容为空"
}

function fallbackTitle(item: DecodedSyncObject): string {
  return `${kindName(item.object.kind)} ${item.object.objectId.slice(0, 8)}`
}

function kindName(kind: string): string {
  if (kind === "note") return "未命名笔记"
  if (kind === "record") return "未命名记录"
  if (kind === "canvas") return "未命名绘图"
  if (kind === "setting") return "未命名配置"
  return "同步对象"
}

function recordPayload(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}…`
    : normalized
}

function sanitizePayload(value: unknown, key = ""): unknown {
  if (
    /password|passphrase|token|secret|api[-_]?key|access[-_]?key/i.test(key)
  ) {
    return value === undefined || value === null || value === ""
      ? value
      : "••••••••"
  }
  if (Array.isArray(value)) return value.map((item) => sanitizePayload(item))
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizePayload(entryValue, entryKey),
      ])
    )
  }
  return value
}

function fromBase64Url(value: string): Uint8Array {
  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
