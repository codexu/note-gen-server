import { describe, expect, it } from 'vitest'
import { isMailMessage } from '../src/mail/provider.js'

describe('mail payload boundary', () => {
  it('accepts a fixed security template without arbitrary payload fields', () => {
    expect(isMailMessage({
      idempotencyKey: 'smtp-test:0123456789', to: 'operator@example.test', template: 'security-notice', locale: 'en', variables: {},
    })).toBe(true)
  })

  it('allows action URLs only for action templates and only over HTTPS', () => {
    expect(isMailMessage({
      idempotencyKey: 'action:0123456789', to: 'member@example.test', template: 'verify-email', locale: 'zh-CN',
      variables: { actionUrl: 'https://sync.example.test/account/verify-email?token=opaque' },
    })).toBe(true)
    expect(isMailMessage({
      idempotencyKey: 'action:0123456789', to: 'member@example.test', template: 'verify-email', locale: 'zh-CN',
      variables: { actionUrl: 'http://sync.example.test/account/verify-email' },
    })).toBe(false)
  })

  it('rejects arbitrary template variables and header injection', () => {
    expect(isMailMessage({
      idempotencyKey: 'smtp-test:0123456789', to: 'operator@example.test', template: 'security-notice', locale: 'en', variables: { body: 'unbounded' },
    })).toBe(false)
    expect(isMailMessage({
      idempotencyKey: 'action:0123456789', to: 'member@example.test', template: 'reset-password', locale: 'en',
      variables: { actionUrl: 'https://sync.example.test/reset\r\nBcc: attacker@example.test' },
    })).toBe(false)
  })
})
