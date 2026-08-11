import { createHash, createHmac } from 'node:crypto'
import nodemailer, { type Transporter } from 'nodemailer'
import type { AppConfig } from '../config.js'

export const mailTemplateIds = ['verify-email', 'reset-password', 'change-email', 'invitation', 'security-notice', 'support-notice'] as const
export type MailTemplateId = typeof mailTemplateIds[number]
export type SupportedLocale = 'en' | 'zh-CN'

export interface MailMessage {
  idempotencyKey: string
  to: string
  template: MailTemplateId
  locale: SupportedLocale
  variables: Record<string, string>
}

export interface MailProvider {
  send(message: MailMessage): Promise<{ providerMessageId: string | null }>
  probe(): Promise<MailProviderHealth>
  isConfigured(): boolean
}

export interface MailProviderHealth {
  status: 'healthy' | 'degraded' | 'misconfigured'
}

const templateVariableKeys: Readonly<Record<MailTemplateId, readonly string[]>> = {
  'verify-email': ['actionUrl'],
  'reset-password': ['actionUrl'],
  'change-email': ['actionUrl'],
  invitation: ['actionUrl'],
  'security-notice': [],
  'support-notice': [],
}

/** Validates the decrypted payload before any provider can render it. */
export function isMailMessage(value: unknown): value is MailMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.idempotencyKey !== 'string' || candidate.idempotencyKey.length < 1 || candidate.idempotencyKey.length > 512
    || typeof candidate.to !== 'string' || !isEmailLike(candidate.to.trim().toLowerCase())
    || typeof candidate.template !== 'string' || !mailTemplateIds.includes(candidate.template as MailTemplateId)
    || (candidate.locale !== 'en' && candidate.locale !== 'zh-CN')
    || typeof candidate.variables !== 'object' || candidate.variables === null || Array.isArray(candidate.variables)) return false
  const variables = candidate.variables as Record<string, unknown>
  const entries = Object.entries(variables)
  const template = candidate.template as MailTemplateId
  return entries.length <= templateVariableKeys[template].length && entries.every(([key, item]) => (
    templateVariableKeys[template].includes(key) && typeof item === 'string' && item.length <= 8_192 && !/[\r\n]/.test(item)
  )) && (variables.actionUrl === undefined || isHttpsUrl(variables.actionUrl))
}

interface MailLogger { info(bindings: Record<string, unknown>, message: string): void }

/**
 * The only hosted provider permitted during internal testing. It deliberately
 * delivers nowhere and logs a keyed recipient digest, never the address,
 * template variables, action tokens, or provider-style message payload.
 */
export class LogMailProvider implements MailProvider {
  constructor(private readonly secret: string, private readonly logger: MailLogger = console) {}

  async send(message: MailMessage): Promise<{ providerMessageId: string | null }> {
    if (!isMailMessage(message)) throw new MailProviderError('configuration_error', false)
    const recipient = message.to.trim().toLowerCase()
    if (!isEmailLike(recipient)) throw new MailProviderError('invalid_recipient', false)
    this.logger.info({
      provider: 'log', template: message.template, locale: message.locale,
      recipientDigest: digest(this.secret, recipient), idempotencyDigest: digest(this.secret, message.idempotencyKey),
    }, 'Internal test mail suppressed')
    return { providerMessageId: null }
  }

  async probe(): Promise<MailProviderHealth> { return { status: 'healthy' } }
  isConfigured(): boolean { return true }
}

export class MailProviderError extends Error {
  constructor(readonly code: 'invalid_recipient' | 'temporary_failure' | 'configuration_error', readonly retryable: boolean) {
    super(code)
  }
}

/**
 * Self-hosted SMTP transport.  It is deliberately a narrow adapter: callers
 * can only send a validated MailMessage and never supply raw MIME, headers,
 * sender identity, or a transport URL.  Nodemailer owns TLS negotiation and
 * SMTP protocol details; the durable outbox owns retries and at-least-once
 * semantics.
 */
export class SmtpMailProvider implements MailProvider {
  private readonly transport: Transporter
  private readonly from: string
  private readonly replyTo: string | undefined
  private readonly messageDomain: string

  constructor(private readonly config: AppConfig) {
    const secure = config.smtpTlsMode === 'tls'
    this.transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure,
      requireTLS: config.smtpTlsMode === 'starttls-required',
      ignoreTLS: config.smtpTlsMode === 'none',
      connectionTimeout: config.smtpConnectTimeoutMs,
      greetingTimeout: config.smtpCommandTimeoutMs,
      socketTimeout: config.smtpCommandTimeoutMs,
      auth: config.smtpUsername.length === 0 ? undefined : { user: config.smtpUsername, pass: config.smtpPassword },
      tls: { rejectUnauthorized: config.smtpTlsRejectUnauthorized },
    })
    this.from = formatMailbox(config.mailFromName, config.mailFromAddress)
    this.replyTo = config.mailReplyTo.length === 0 ? undefined : config.mailReplyTo
    this.messageDomain = config.mailFromAddress.slice(config.mailFromAddress.lastIndexOf('@') + 1).toLowerCase()
  }

  async send(message: MailMessage): Promise<{ providerMessageId: string | null }> {
    if (!isMailMessage(message)) throw new MailProviderError('configuration_error', false)
    try {
      if (message.variables.actionUrl !== undefined && new URL(message.variables.actionUrl).origin !== this.config.publicBaseUrl) {
        throw new MailProviderError('configuration_error', false)
      }
      const rendered = renderTemplate(message)
      const info = await this.transport.sendMail({
        from: this.from,
        to: message.to.trim(),
        replyTo: this.replyTo,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        // A stable ID narrows duplicate presentation after the server loses
        // the local success acknowledgement; SMTP itself cannot be exactly-once.
        messageId: `<${this.messageKey(message.idempotencyKey)}@${this.messageDomain}>`,
        headers: { 'X-NoteGen-Template': message.template },
      })
      return { providerMessageId: info.messageId || null }
    } catch (error) {
      throw classifySmtpError(error)
    }
  }

  /** SMTP EHLO/auth/TLS verification without a recipient or message body. */
  async probe(): Promise<MailProviderHealth> {
    try {
      await this.transport.verify()
      return { status: 'healthy' }
    } catch (error) {
      const classified = classifySmtpError(error)
      return { status: classified.code === 'configuration_error' || classified.code === 'invalid_recipient' ? 'misconfigured' : 'degraded' }
    }
  }
  isConfigured(): boolean { return true }

  private messageKey(idempotencyKey: string): string {
    return createHash('sha256').update(`notegen-smtp-message:v1:${idempotencyKey}`).digest('hex')
  }
}

/** Rebuilds the SMTP transport lazily whenever an administrator changes its
 * encrypted database-backed configuration. */
export class DynamicSmtpMailProvider implements MailProvider {
  private signature = ''
  private provider: SmtpMailProvider | undefined

  constructor(private readonly config: AppConfig) {}

  isConfigured(): boolean { return this.config.mailDriver === 'smtp' }

  async send(message: MailMessage): Promise<{ providerMessageId: string | null }> {
    const provider = this.current()
    if (provider === undefined) throw new MailProviderError('configuration_error', false)
    return provider.send(message)
  }

  async probe(): Promise<MailProviderHealth> {
    return (await this.current()?.probe()) ?? { status: 'misconfigured' }
  }

  private current(): SmtpMailProvider | undefined {
    if (!this.isConfigured()) return undefined
    const signature = JSON.stringify([
      this.config.smtpHost, this.config.smtpPort, this.config.smtpTlsMode,
      this.config.smtpUsername, this.config.smtpPassword, this.config.smtpConnectTimeoutMs,
      this.config.smtpCommandTimeoutMs, this.config.smtpTlsRejectUnauthorized,
      this.config.mailFromAddress, this.config.mailFromName, this.config.mailReplyTo,
    ])
    if (this.provider === undefined || signature !== this.signature) {
      this.provider = new SmtpMailProvider(this.config)
      this.signature = signature
    }
    return this.provider
  }
}

export function createMailProvider(config: AppConfig): MailProvider | undefined {
  if (config.deploymentMode !== 'hosted') {
    return new DynamicSmtpMailProvider(config)
  }
  if (config.hostedReleaseStage !== 'internal-test' || config.hostedMailProvider !== 'log') {
    throw new Error('No reviewed hosted mail provider is configured')
  }
  return new LogMailProvider(config.authSecret)
}

function renderTemplate(message: MailMessage): { subject: string, text: string, html: string } {
  const actionUrl = message.variables.actionUrl
  const safeUrl = typeof actionUrl === 'string' && /^https:\/\//.test(actionUrl) ? actionUrl : undefined
  const labels: Record<MailTemplateId, { en: string, zh: string }> = {
    'verify-email': { en: 'Verify your email address', zh: '验证你的邮箱地址' },
    'reset-password': { en: 'Reset your password', zh: '重置你的密码' },
    'change-email': { en: 'Your email address changed', zh: '邮箱地址已变更' },
    invitation: { en: 'You have been invited to NoteGen', zh: '你收到了 NoteGen 邀请' },
    'security-notice': { en: 'NoteGen security notice', zh: 'NoteGen 安全通知' },
    'support-notice': { en: 'NoteGen support update', zh: 'NoteGen 客服更新' },
  }
  const label = labels[message.template][message.locale === 'zh-CN' ? 'zh' : 'en']
  const intro = message.locale === 'zh-CN' ? '请在安全的浏览器中继续操作。' : 'Continue in a secure browser.'
  const text = safeUrl === undefined ? `${label}\n\n${intro}` : `${label}\n\n${intro}\n${safeUrl}`
  const html = safeUrl === undefined
    ? `<p>${escapeHtml(label)}</p><p>${escapeHtml(intro)}</p>`
    : `<p>${escapeHtml(label)}</p><p>${escapeHtml(intro)}</p><p><a href="${escapeHtmlAttribute(safeUrl)}">${escapeHtml(safeUrl)}</a></p>`
  return { subject: label, text, html }
}

function classifySmtpError(error: unknown): MailProviderError {
  const candidate = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {}
  const code = typeof candidate.code === 'string' ? candidate.code : ''
  const responseCode = typeof candidate.responseCode === 'number' ? candidate.responseCode : undefined
  if (responseCode !== undefined && responseCode >= 400 && responseCode < 500) return new MailProviderError('temporary_failure', true)
  if (['EAUTH', 'ETLS', 'ESOCKET'].includes(code)) return new MailProviderError('configuration_error', false)
  if (['ETIMEDOUT', 'ECONNECTION', 'EDNS', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND'].includes(code)) return new MailProviderError('temporary_failure', true)
  if (responseCode !== undefined && responseCode >= 500 && responseCode < 600) return new MailProviderError('invalid_recipient', false)
  return new MailProviderError('temporary_failure', true)
}

function formatMailbox(name: string, address: string): string {
  if (/[\u0000-\u001f\u007f]/.test(name) || /[\r\n]/.test(address)) throw new Error('SMTP sender contains an invalid header character')
  return name.length === 0 ? address : `"${name.replace(/["\\]/g, '\\$&')}" <${address}>`
}
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!) }
function escapeHtmlAttribute(value: string): string { return escapeHtml(value) }

function digest(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url').slice(0, 20)
}

function isEmailLike(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}
function isHttpsUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && url.username.length === 0 && url.password.length === 0 } catch { return false }
}
