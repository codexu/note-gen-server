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
  keys: ReadonlyMap<number, CryptoKey>,
  workspaceId: string
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
    const isV2Envelope = bytes[0] === 0x02 && bytes[1] === 0x01
    const nonceOffset = isV2Envelope ? 2 : 0
    const ciphertextOffset = nonceOffset + 12
    if (bytes.byteLength <= ciphertextOffset + 16)
      throw new Error("invalid encrypted payload")
    const algorithm: AesGcmParams = {
      name: "AES-GCM",
      iv: bytes.slice(nonceOffset, ciphertextOffset),
      ...(isV2Envelope
        ? {
            additionalData: new TextEncoder().encode(
              JSON.stringify([
                "notegen-sync-v1",
                workspaceId,
                object.objectId,
                object.kind,
                object.keyVersion,
                "object",
                object.objectId,
              ])
            ),
          }
        : {}),
    }
    const plaintext = await crypto.subtle.decrypt(
      algorithm,
      key,
      bytes.slice(ciphertextOffset)
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
  if (item.object.kind === "mark") {
    if (title) return title
    const recordText = recordTextValue(value)
    if (recordText) return compact(firstLine(recordText), 48)
    const type = stringValue(value?.type)
    return type ? `${recordTypeName(type)}记录` : fallbackTitle(item)
  }
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

  if (item.object.kind === "mark") {
    const text = recordTextValue(recordPayload(payload.value))
    return text ? compact(text, 180) : "这条记录没有可展示的文字内容。"
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
  if (item.object.kind === "mark" && payload) {
    const value = recordPayload(payload.value)
    if (value) return displayRecord(value)
  }
  return JSON.stringify(sanitizePayload(item.payload), null, 2) ?? "内容为空"
}

function fallbackTitle(item: DecodedSyncObject): string {
  return `${kindName(item.object.kind)} ${item.object.objectId.slice(0, 8)}`
}

function kindName(kind: string): string {
  if (kind === "note") return "未命名笔记"
  if (kind === "record" || kind === "mark") return "未命名记录"
  if (kind === "canvas") return "未命名绘图"
  if (kind === "setting") return "未命名配置"
  return "同步对象"
}

function recordTextValue(value: Record<string, unknown> | null): string | null {
  if (!value) return null
  return (
    stringValue(value.desc) ??
    stringValue(value.content) ??
    stringValue(value.text) ??
    stringValue(value.transcript) ??
    stringValue(value.url)
  )
}

function displayRecord(value: Record<string, unknown>): string {
  const sections: string[] = []
  const type = stringValue(value.type)
  if (type) sections.push(`类型：${recordTypeName(type)}`)

  const content = stringValue(value.content)
  const description = stringValue(value.desc)
  const url = stringValue(value.url)
  if (content) sections.push(content)
  if (description && description !== content) sections.push(`说明：\n${description}`)
  if (url && url !== content && url !== description) sections.push(`资源：\n${url}`)

  const createdAt = timestampValue(value.createdAt)
  if (createdAt) sections.push(`创建时间：${createdAt}`)
  return sections.join("\n\n") || "这条记录没有可展示的文字内容。"
}

function recordTypeName(type: string): string {
  const names: Record<string, string> = {
    scan: "扫描",
    text: "文本",
    image: "图片",
    link: "链接",
    file: "文件",
    recording: "录音",
    todo: "待办",
  }
  return names[type] ?? type
}

function timestampValue(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null
  const raw = typeof value === "number" && value < 10_000_000_000
    ? value * 1000
    : value
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString("zh-CN")
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() || value
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

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
