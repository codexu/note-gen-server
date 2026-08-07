import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { DatabaseContext } from './client.js'
import { serverMetadata } from './schema.js'

const instanceIdKey = 'instance_id'

export async function getOrCreateInstanceId(database: DatabaseContext): Promise<string> {
  await database.db.insert(serverMetadata).values({
    key: instanceIdKey,
    value: randomUUID(),
  }).onConflictDoNothing({ target: serverMetadata.key })
  const [record] = await database.db.select({ value: serverMetadata.value }).from(serverMetadata)
    .where(eq(serverMetadata.key, instanceIdKey)).limit(1)
  if (record === undefined) throw new Error('Server instance ID could not be initialized')
  return record.value
}
