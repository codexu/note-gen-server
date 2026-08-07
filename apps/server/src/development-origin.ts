import type { FastifyRequest } from 'fastify'
import type { AppConfig } from './config.js'

function normalizedHostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, '')
}

function isLoopbackHostname(value: string): boolean {
  const hostname = normalizedHostname(value)
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1'
    || hostname.startsWith('127.')
}

export function isLocalNetworkHostname(value: string): boolean {
  const hostname = normalizedHostname(value)
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return true
  if (hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80:')) {
    return true
  }
  const parts = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number)
  return Boolean(parts
    && parts.every((part) => part >= 0 && part <= 255)
    && (parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)))
}

export function isAllowedDevelopmentWebOrigin(config: AppConfig, origin: string): boolean {
  if (config.nodeEnv !== 'development') return false
  try {
    const candidate = new URL(origin)
    const configured = new URL(config.webPublicBaseUrl)
    return (candidate.protocol === 'http:' || candidate.protocol === 'https:')
      && candidate.port === configured.port
      && isLocalNetworkHostname(candidate.hostname)
  } catch {
    return false
  }
}

export function resolveWebPublicBaseUrl(config: AppConfig, request: FastifyRequest): string {
  if (config.nodeEnv !== 'development') return config.webPublicBaseUrl
  const configured = new URL(config.webPublicBaseUrl)
  if (!isLoopbackHostname(configured.hostname)) return configured.origin
  if (!isLocalNetworkHostname(request.hostname)) return configured.origin
  configured.protocol = request.protocol
  configured.hostname = request.hostname
  return configured.origin
}

export function resolveApiPublicBaseUrl(config: AppConfig, request: FastifyRequest): string {
  if (config.nodeEnv !== 'development') return config.publicBaseUrl
  const configured = new URL(config.publicBaseUrl)
  if (!isLoopbackHostname(configured.hostname)) return configured.origin
  if (!isLocalNetworkHostname(request.hostname)) return configured.origin
  configured.protocol = request.protocol
  configured.hostname = request.hostname
  return configured.origin
}
