import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { DatabaseContext } from '../database/client.js'
import { mailSecretPayloads } from '../database/schema.js'
import { isMailMessage, type MailMessage } from './provider.js'
import type { MailSecretPayloadResolver } from './outbox-service.js'

const keyId = 'mail-payload-auth-secret-v1'
const payloadVersion = 1

/** Database-backed, short-lived AEAD envelope for data that must not appear
 * in a normal outbox row: recipient address, action URL and template values. */
export class MailSecretPayloadService implements MailSecretPayloadResolver {
  private readonly key: Buffer

  constructor(private readonly database: DatabaseContext, authSecret: string) {
    this.key = createHmac('sha256', authSecret).update('notegen-mail-payload-aead:v1').digest()
  }

  async createInTransaction(tx: any, message: MailMessage, expiresAt: Date): Promise<string> {
    if (!isMailMessage(message) || expiresAt <= new Date()) throw new Error('Mail secret payload is invalid or expired')
    const id = randomUUID()
    const serialized = JSON.stringify(message)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(`notegen-mail-payload:${id}:v${payloadVersion}`))
    const encrypted = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()])
    const packed = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')
    await tx.insert(mailSecretPayloads).values({ id, keyId, ciphertext: packed, payloadVersion, expiresAt })
    return id
  }

  async resolve(ref: string): Promise<MailMessage | null> {
    const [row] = await this.database.db.select().from(mailSecretPayloads).where(and(
      eq(mailSecretPayloads.id, ref), eq(mailSecretPayloads.keyId, keyId), eq(mailSecretPayloads.payloadVersion, payloadVersion),
      isNull(mailSecretPayloads.erasedAt), gt(mailSecretPayloads.expiresAt, new Date()),
    )).limit(1)
    if (row === undefined) return null
    try {
      const packed = Buffer.from(row.ciphertext, 'base64url')
      if (packed.length <= 28) return null
      const decipher = createDecipheriv('aes-256-gcm', this.key, packed.subarray(0, 12))
      decipher.setAAD(Buffer.from(`notegen-mail-payload:${row.id}:v${row.payloadVersion}`))
      decipher.setAuthTag(packed.subarray(12, 28))
      const parsed: unknown = JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8'))
      return isMailMessage(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  async erase(ref: string): Promise<void> {
    await this.database.db.update(mailSecretPayloads).set({ erasedAt: new Date(), ciphertext: '' }).where(and(
      eq(mailSecretPayloads.id, ref), isNull(mailSecretPayloads.erasedAt),
    ))
  }
}
