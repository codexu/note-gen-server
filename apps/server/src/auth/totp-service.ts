import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export class TotpService {
  readonly #encryptionKey: Buffer

  constructor(authSecret: string) {
    this.#encryptionKey = createHash('sha256').update(`notegen-totp\0${authSecret}`).digest()
  }

  createSecret(): string {
    return encodeBase32(randomBytes(20))
  }

  encrypt(secret: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#encryptionKey, iv)
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')
  }

  decrypt(value: string): string {
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.length < 29) throw new Error('Invalid encrypted TOTP secret')
    const decipher = createDecipheriv('aes-256-gcm', this.#encryptionKey, bytes.subarray(0, 12))
    decipher.setAuthTag(bytes.subarray(12, 28))
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
  }

  verify(secret: string, code: string, now = Date.now()): boolean {
    if (!/^\d{6}$/.test(code)) return false
    for (let offset = -1; offset <= 1; offset += 1) {
      const expected = generateCode(secret, Math.floor(now / 30_000) + offset)
      if (timingSafeEqual(Buffer.from(code), Buffer.from(expected))) return true
    }
    return false
  }

  uri(login: string, secret: string): string {
    const label = encodeURIComponent(`NoteGen:${login}`)
    return `otpauth://totp/${label}?secret=${secret}&issuer=NoteGen&algorithm=SHA1&digits=6&period=30`
  }
}

function generateCode(secret: string, counter: number): string {
  const value = Buffer.alloc(8)
  value.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', decodeBase32(secret)).update(value).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const binary = (digest.readUInt32BE(offset) & 0x7fff_ffff) % 1_000_000
  return binary.toString().padStart(6, '0')
}

function encodeBase32(value: Buffer): string {
  let bits = 0
  let buffer = 0
  let output = ''
  for (const byte of value) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += alphabet[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 31]
  return output
}

function decodeBase32(value: string): Buffer {
  let bits = 0
  let buffer = 0
  const output: number[] = []
  for (const character of value.toUpperCase().replaceAll('=', '')) {
    const index = alphabet.indexOf(character)
    if (index < 0) throw new Error('Invalid Base32 value')
    buffer = (buffer << 5) | index
    bits += 5
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(output)
}
