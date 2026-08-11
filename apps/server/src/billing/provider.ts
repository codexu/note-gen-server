import { createHash, randomUUID } from 'node:crypto'
import type { AppConfig } from '../config.js'
import { ApiError } from '../errors.js'

export interface CustomerInput { accountId: string, subjectHash: string, email?: string }
export interface CheckoutInput { customerId: string, priceId: string, returnUrl: string, metadata: Record<string, string> }
export interface ProviderCheckoutSnapshot { id: string, customerId: string, status: 'open' | 'completed' | 'expired', subscriptionId: string | null }
export interface ProviderSubscriptionSnapshot { id: string, customerId: string, status: 'trialing' | 'active' | 'past_due' | 'grace' | 'paused' | 'ended' | 'review', revision: string, currentPeriodEnd: Date | null }
export interface VerifiedBillingEvent { id: string, type: string, payload: Record<string, unknown> }

/** Provider-specific adapters implement this boundary; domain services do not import SDKs. */
export interface BillingProvider {
  findOrCreateCustomer(input: CustomerInput, idempotencyKey: string): Promise<{ customerId: string }>
  createCheckout(input: CheckoutInput, idempotencyKey: string): Promise<{ checkoutId: string, url: string }>
  getCheckoutByIdempotencyKey(idempotencyKey: string): Promise<ProviderCheckoutSnapshot | null>
  createCustomerPortal(input: { customerId: string, returnUrl: string }): Promise<{ url: string }>
  getSubscription(providerSubscriptionId: string): Promise<ProviderSubscriptionSnapshot>
  cancelSubscription(providerSubscriptionId: string, atPeriodEnd: boolean): Promise<void>
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): VerifiedBillingEvent
}

/**
 * Deliberately non-networked test adapter. State is process-local, which makes
 * it unsuitable for restart recovery and therefore impossible to mistake for a
 * production payment provider.
 */
export class MockBillingProvider implements BillingProvider {
  private readonly customers = new Map<string, string>()
  private readonly checkouts = new Map<string, ProviderCheckoutSnapshot>()
  private readonly subscriptions = new Map<string, ProviderSubscriptionSnapshot>()

  async findOrCreateCustomer(_input: CustomerInput, idempotencyKey: string): Promise<{ customerId: string }> {
    const customerId = this.customers.get(idempotencyKey) ?? `mock_customer_${stableId(idempotencyKey)}`
    this.customers.set(idempotencyKey, customerId)
    return { customerId }
  }

  async createCheckout(input: CheckoutInput, idempotencyKey: string): Promise<{ checkoutId: string, url: string }> {
    const existing = this.checkouts.get(idempotencyKey)
    if (existing !== undefined) return { checkoutId: existing.id, url: mockUrl('checkout', existing.id) }
    const checkoutId = `mock_checkout_${randomUUID()}`
    this.checkouts.set(idempotencyKey, { id: checkoutId, customerId: input.customerId, status: 'open', subscriptionId: null })
    return { checkoutId, url: mockUrl('checkout', checkoutId) }
  }

  async getCheckoutByIdempotencyKey(idempotencyKey: string): Promise<ProviderCheckoutSnapshot | null> {
    return this.checkouts.get(idempotencyKey) ?? null
  }

  async createCustomerPortal(input: { customerId: string, returnUrl: string }): Promise<{ url: string }> {
    return { url: mockUrl('portal', input.customerId) }
  }

  async getSubscription(providerSubscriptionId: string): Promise<ProviderSubscriptionSnapshot> {
    const snapshot = this.subscriptions.get(providerSubscriptionId)
    if (snapshot === undefined) throw new ApiError({ code: 'billing_mock_subscription_not_found', message: 'Mock subscription does not exist', statusCode: 404 })
    return snapshot
  }

  async cancelSubscription(providerSubscriptionId: string, atPeriodEnd: boolean): Promise<void> {
    const snapshot = await this.getSubscription(providerSubscriptionId)
    this.subscriptions.set(providerSubscriptionId, atPeriodEnd
      ? snapshot
      : { ...snapshot, status: 'ended', revision: `${Number(snapshot.revision) + 1}` })
  }

  verifyWebhook(_rawBody: Buffer, _headers: Record<string, string | undefined>): VerifiedBillingEvent {
    throw new ApiError({ code: 'billing_mock_webhook_unsupported', message: 'Mock provider accepts no network webhook', statusCode: 400 })
  }
}

export function createBillingProvider(config: AppConfig): BillingProvider | undefined {
  if (config.deploymentMode !== 'hosted') return undefined
  if (config.hostedReleaseStage !== 'internal-test' || config.billingProvider !== 'mock') {
    throw new Error('No reviewed hosted billing provider is configured')
  }
  return new MockBillingProvider()
}

function stableId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function mockUrl(kind: 'checkout' | 'portal', id: string): string {
  return `https://billing.invalid/internal-test/${kind}/${encodeURIComponent(id)}`
}
