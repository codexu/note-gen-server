import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { InMemoryChangeNotifier } from '../src/sync/notifier.js'
import { TokenService } from '../src/auth/tokens.js'

describe('security configuration', () => {
  it('rejects development secrets in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow('AUTH_SECRET')
  })

  it('rejects incomplete S3 configuration', () => {
    expect(() => loadConfig({ BLOB_STORAGE_DRIVER: 's3' })).toThrow('S3 bucket and credentials')
  })
})

describe('TokenService', () => {
  it('signs scoped short-lived access claims and hashes refresh tokens', async () => {
    const tokens = new TokenService('0123456789abcdef0123456789abcdef', 'https://sync.example.test')
    const claims = { accountId: 'account-id', deviceId: 'device-id' }
    const accessToken = await tokens.signAccessToken(claims)
    expect(await tokens.verifyAccessToken(accessToken)).toMatchObject({
      accountId: claims.accountId,
      deviceId: claims.deviceId,
    })
    const refreshToken = tokens.createRefreshToken()
    expect(refreshToken.length).toBeGreaterThan(20)
    expect(tokens.hashRefreshToken(refreshToken)).toBe(tokens.hashRefreshToken(refreshToken))
  })
})

describe('InMemoryChangeNotifier', () => {
  it('isolates workspace subscribers and supports unsubscribe', async () => {
    const notifier = new InMemoryChangeNotifier()
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribe = notifier.subscribeWorkspace('workspace-1', first)
    notifier.subscribeWorkspace('workspace-2', second)
    await notifier.publish({ type: 'workspace.changed', workspaceId: 'workspace-1', latestSequence: '2' })
    expect(first).toHaveBeenCalledOnce()
    expect(second).not.toHaveBeenCalled()
    unsubscribe()
    await notifier.publish({ type: 'workspace.changed', workspaceId: 'workspace-1', latestSequence: '3' })
    expect(first).toHaveBeenCalledOnce()
  })
})
