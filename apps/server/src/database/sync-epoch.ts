import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { DatabaseContext } from './client.js'
import { serverMetadata } from './schema.js'

const syncEpochKey = 'sync_epoch'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The epoch is deliberately independent of the stable instance ID.  Offline
 * restore will replace it before serving traffic so old idempotency keys and
 * clients can be fenced without changing the server's public identity.
 */
export async function getOrCreateSyncEpoch(database: DatabaseContext): Promise<string> {
  await database.db.insert(serverMetadata).values({ key: syncEpochKey, value: randomUUID() })
    .onConflictDoNothing({ target: serverMetadata.key })
  const [record] = await database.db.select({ value: serverMetadata.value }).from(serverMetadata)
    .where(eq(serverMetadata.key, syncEpochKey)).limit(1)
  if (record === undefined || !uuid.test(record.value)) throw new Error('Server sync epoch is missing or invalid')
  return record.value
}

/** Only offline restore sanitation may call this, before HTTP/workers start. */
export async function replaceSyncEpoch(database: DatabaseContext, value = randomUUID()): Promise<string> {
  if (!uuid.test(value)) throw new Error('Replacement sync epoch is invalid')
  await database.db.insert(serverMetadata).values({ key: syncEpochKey, value })
    .onConflictDoUpdate({ target: serverMetadata.key, set: { value } })
  return value
}
