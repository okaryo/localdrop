import { expect, test } from 'vitest'
import { maxQrFileSize, readQrFilePart, restoreQrFile, splitQrFile } from './qrFile'

test('restores a maximum-size file with a Unicode name when QR frames arrive out of order', async () => {
  const bytes = Uint8Array.from({ length: maxQrFileSize }, (_, index) => index % 251)
  const file = new File([bytes], '写真-📷.bin')
  const frames = await splitQrFile(file)
  const parts = frames.reverse().map(readQrFilePart)
  const digest = parts[0].digest

  expect(parts.length).toBeGreaterThan(1)
  expect(parts.every((part) => part.total === parts.length && part.digest === digest)).toBe(true)
  const restored = await restoreQrFile(digest, new Map(parts.map((part) => [part.number, part.bytes])))
  expect(restored.name).toBe(file.name)
  expect(new Uint8Array(await restored.blob.arrayBuffer())).toEqual(bytes)
})

test('rejects missing QR frames and data that fails digest verification', async () => {
  const frames = await splitQrFile(new File([new Uint8Array(750)], 'file.bin'))
  const parsed = frames.map(readQrFilePart)
  const digest = parsed[0].digest
  const parts = new Map(parsed.map((part) => [part.number, part.bytes]))

  parts.delete(2)
  await expect(restoreQrFile(digest, parts)).rejects.toThrow('qrFileVerifyFailed')

  const changed = parsed[1].bytes.slice()
  changed[0] ^= 1
  parts.set(2, changed)
  await expect(restoreQrFile(digest, parts)).rejects.toThrow('qrFileVerifyFailed')
})

test('rejects invalid frame numbering', async () => {
  const [frame] = await splitQrFile(new File(['data'], 'file.txt'))
  const [prefix, digest, , total, payload] = frame.split('.')
  expect(() => readQrFilePart(`${prefix}.${digest}.2.${total}.${payload}`)).toThrow('invalidFileQr')
})

test('rejects files over the QR transfer size limit', async () => {
  const file = new File([new Uint8Array(maxQrFileSize + 1)], 'large.bin')
  await expect(splitQrFile(file)).rejects.toThrow('selectSmallerQrFile')
})
