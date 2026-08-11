import { constants } from 'node:fs'
import { access, link, mkdir, open, readdir, rm } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import type { BlobStorage, CompletedPart } from './blob-storage.js'

export class FilesystemBlobStorage implements BlobStorage {
  readonly #root: string

  constructor(root: string) {
    this.#root = resolve(root)
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true })
  }

  async check(): Promise<void> {
    await access(this.#root, constants.R_OK | constants.W_OK)
  }

  async beginUpload(_storageKey: string): Promise<string> {
    const uploadId = randomUUID()
    await mkdir(this.#uploadPath(uploadId), { recursive: true })
    return uploadId
  }

  async writePart(_storageKey: string, providerUploadId: string, partNumber: number, data: Buffer): Promise<string> {
    const partPath = this.#path(`.uploads/${providerUploadId}/${partNumber}`)
    const handle = await open(partPath, 'w')
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    return `part-${partNumber}-${data.byteLength}`
  }

  async completeUpload(storageKey: string, providerUploadId: string, parts: CompletedPart[]): Promise<void> {
    const target = this.#path(storageKey)
    const temporaryTarget = `${target}.assembling-${providerUploadId}`
    await mkdir(dirname(target), { recursive: true })
    const output = createWriteStream(temporaryTarget, { flags: 'wx' })
    try {
      for (const part of [...parts].sort((a, b) => a.partNumber - b.partNumber)) {
        await pipeline(createReadStream(this.#path(`.uploads/${providerUploadId}/${part.partNumber}`)), output, { end: false })
      }
      output.end()
      await new Promise<void>((resolvePromise, reject) => {
        output.once('finish', resolvePromise)
        output.once('error', reject)
      })
      // `rename` replaces an existing target on POSIX, which would violate the
      // immutable ready-object contract. A hard-link publish is atomic within
      // this filesystem and fails with EEXIST if another writer won the key.
      await link(temporaryTarget, target)
      await rm(temporaryTarget, { force: true })
      await this.abortUpload(storageKey, providerUploadId)
    } catch (error) {
      output.destroy()
      await rm(temporaryTarget, { force: true })
      throw error
    }
  }

  async abortUpload(_storageKey: string, providerUploadId: string): Promise<void> {
    await rm(this.#uploadPath(providerUploadId), { recursive: true, force: true })
  }

  async openReadStream(storageKey: string, range?: { start: number, end: number }) {
    return createReadStream(this.#path(storageKey), range)
  }

  async exists(storageKey: string): Promise<boolean> {
    const target = this.#path(storageKey)
    try {
      await access(target, constants.F_OK)
      return true
    } catch {
      return false
    }
  }

  async *listKeys(): AsyncIterable<string> {
    const walk = async function* (directory: string, prefix: string): AsyncIterable<string> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (prefix.length === 0 && entry.name === '.uploads') continue
        const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
        const absolute = resolve(directory, entry.name)
        if (entry.isDirectory()) yield* walk(absolute, relative)
        else if (entry.isFile() && !entry.name.includes('.assembling-')) yield relative
      }
    }
    yield* walk(this.#root, '')
  }

  async delete(storageKey: string): Promise<void> {
    await rm(this.#path(storageKey), { force: true })
  }

  #path(storageKey: string): string {
    const target = resolve(this.#root, storageKey)
    if (target !== this.#root && !target.startsWith(`${this.#root}${sep}`)) {
      throw new Error('Blob storage key escapes the configured root')
    }
    return target
  }

  #uploadPath(uploadId: string): string {
    return this.#path(`.uploads/${uploadId}`)
  }
}
