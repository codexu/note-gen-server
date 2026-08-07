import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FilesystemBlobStorage } from '../src/storage/filesystem-blob-storage.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('FilesystemBlobStorage', () => {
  it('lists completed storage keys without exposing multipart temporary files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notegen-blobs-'))
    temporaryDirectories.push(root)
    const storage = new FilesystemBlobStorage(root)
    await storage.initialize()
    const uploadId = await storage.beginUpload('objects/example')
    await storage.writePart('objects/example', uploadId, 1, Buffer.from('example'))
    await storage.completeUpload('objects/example', uploadId, [{ partNumber: 1, etag: 'part-1-7' }])
    const keys: string[] = []
    for await (const key of storage.listKeys()) keys.push(key)
    expect(keys).toEqual(['objects/example'])
  })
  it('assembles ordered parts into an atomic final blob', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notegen-blob-test-'))
    temporaryDirectories.push(root)
    const storage = new FilesystemBlobStorage(root)
    await storage.initialize()
    const uploadId = await storage.beginUpload('workspace/blob')
    const secondEtag = await storage.writePart('workspace/blob', uploadId, 2, Buffer.from('world'))
    const firstEtag = await storage.writePart('workspace/blob', uploadId, 1, Buffer.from('hello '))

    await storage.completeUpload('workspace/blob', uploadId, [
      { partNumber: 2, etag: secondEtag },
      { partNumber: 1, etag: firstEtag },
    ])

    expect(await readFile(join(root, 'workspace/blob'), 'utf8')).toBe('hello world')
    expect(await storage.exists('workspace/blob')).toBe(true)
  })

  it('rejects storage keys that escape the configured root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notegen-blob-test-'))
    temporaryDirectories.push(root)
    const storage = new FilesystemBlobStorage(root)
    await storage.initialize()
    await expect(storage.exists('../outside')).rejects.toThrow('escapes')
  })
})
