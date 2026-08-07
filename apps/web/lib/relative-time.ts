export function formatRelativeTime(value: string, now = Date.now()): string {
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return "未知时间"

  const difference = now - timestamp
  let remainingSeconds = Math.floor(Math.abs(difference) / 1_000)
  const days = Math.floor(remainingSeconds / 86_400)
  remainingSeconds %= 86_400
  const hours = Math.floor(remainingSeconds / 3_600)
  remainingSeconds %= 3_600
  const minutes = Math.floor(remainingSeconds / 60)
  const seconds = remainingSeconds % 60
  const parts: string[] = []

  if (days > 0) parts.push(`${days} 天`)
  if (hours > 0) parts.push(`${hours} 小时`)
  if (minutes > 0) parts.push(`${minutes} 分`)
  parts.push(`${seconds} 秒`)

  return `${parts.join(" ")}${difference >= 0 ? "前" : "后"}`
}
