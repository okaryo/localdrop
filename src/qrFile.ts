import { fromBase64Url, toBase64Url } from './qr'

export const maxQrFileSize = 4 * 1024
const maxNameSize = 1024
const nameLengthSize = 2
const partSize = 360
const maxPartCount = Math.ceil((nameLengthSize + maxNameSize + maxQrFileSize) / partSize)
const maxPartLength = Math.ceil(partSize * 4 / 3)

// Each frame carries the file digest, its position, and a slice of the file and name.
const partPattern = /^LDF1\.([A-Za-z0-9_-]{43})\.([1-9][0-9]?)\.([1-9][0-9]?)\.([A-Za-z0-9_-]+)$/

export type QrFilePart = {
  digest: string
  number: number
  total: number
  bytes: Uint8Array<ArrayBuffer>
}

export type QrFile = { name: string; blob: Blob }

async function hash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

export async function splitQrFile(file: File): Promise<string[]> {
  if (file.size > maxQrFileSize) throw new Error('Choose a file up to 4 KiB for QR transfer.')
  const name = new TextEncoder().encode(file.name)
  if (!name.length || name.length > maxNameSize) throw new Error('Choose a file with a shorter name.')

  const bytes = new Uint8Array(nameLengthSize + name.length + file.size)
  new DataView(bytes.buffer).setUint16(0, name.length)
  bytes.set(name, nameLengthSize)
  bytes.set(new Uint8Array(await file.arrayBuffer()), nameLengthSize + name.length)

  const digest = await hash(bytes)
  const total = Math.ceil(bytes.length / partSize)
  return Array.from({ length: total }, (_, index) => {
    const data = toBase64Url(bytes.subarray(index * partSize, (index + 1) * partSize))
    return `LDF1.${digest}.${index + 1}.${total}.${data}`
  })
}

export function readQrFilePart(text: string): QrFilePart {
  const invalid = 'This is not a LocalDrop file QR code.'
  const match = text.length <= maxPartLength + 55 && partPattern.exec(text)
  if (!match) throw new Error(invalid)

  const [, digest, part, count, encoded] = match
  const number = Number(part)
  const total = Number(count)
  if (total > maxPartCount || number > total || encoded.length > maxPartLength) throw new Error(invalid)

  let bytes: Uint8Array<ArrayBuffer>
  try {
    bytes = fromBase64Url(encoded)
  } catch {
    throw new Error(invalid)
  }
  if (bytes.length < 1 || (number < total && bytes.length !== partSize)) throw new Error(invalid)

  return { digest, number, total, bytes }
}

export async function restoreQrFile(digest: string, parts: ReadonlyMap<number, Uint8Array<ArrayBuffer>>): Promise<QrFile> {
  const invalid = 'Could not verify the file. Scan all of its QR codes again.'
  const length = [...parts.values()].reduce((total, part) => total + part.length, 0)
  if (length < nameLengthSize + 1 || length > nameLengthSize + maxNameSize + maxQrFileSize) {
    throw new Error(invalid)
  }

  const bytes = new Uint8Array(length)
  let offset = 0
  for (let number = 1; number <= parts.size; number++) {
    const part = parts.get(number)
    if (!part) throw new Error(invalid)
    bytes.set(part, offset)
    offset += part.length
  }
  if (await hash(bytes) !== digest) throw new Error(invalid)

  const nameLength = new DataView(bytes.buffer).getUint16(0)
  const fileStart = nameLengthSize + nameLength
  if (!nameLength || nameLength > maxNameSize || fileStart > length || length - fileStart > maxQrFileSize) {
    throw new Error(invalid)
  }
  try {
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(nameLengthSize, fileStart))
    return { name, blob: new Blob([bytes.subarray(fileStart)]) }
  } catch {
    throw new Error(invalid)
  }
}
