import { describe, expect, it } from 'vitest'
import { TotpService } from '../src/auth/totp-service.js'

describe('TotpService', () => {
  it('encrypts secrets at rest and can decrypt them again', () => {
    const service = new TotpService('test-auth-secret-that-is-long-enough')
    const secret = service.createSecret()
    const encrypted = service.encrypt(secret)
    expect(encrypted).not.toContain(secret)
    expect(service.decrypt(encrypted)).toBe(secret)
  })

  it('verifies the RFC 6238 SHA-1 test secret with six digits', () => {
    const service = new TotpService('test-auth-secret-that-is-long-enough')
    expect(service.verify('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', '287082', 59_000)).toBe(true)
    expect(service.verify('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', '287083', 59_000)).toBe(false)
  })
})
