import QRCode from 'qrcode'
import { maxCodeLength } from './webrtc'

const prefix = 'LD1.'
// Version 40 at correction level M holds 2,331 bytes in byte mode.
const maxQrLength = 2331

export async function makeQrImage(code: string): Promise<string> {
  if (code.length > maxCodeLength) throw new Error('Connection code is too long.')

  const compressed = new Blob([code]).stream().pipeThrough(new CompressionStream('gzip'))
  const bytes = new Uint8Array(await new Response(compressed).arrayBuffer())
  const data = prefix + btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  if (data.length > maxQrLength) throw new Error('Connection code does not fit in one QR code.')
  return QRCode.toDataURL(data, { errorCorrectionLevel: 'M', margin: 4, scale: 6 })
}

export async function readQrCode(data: string): Promise<string> {
  const invalidQr = 'This is not a valid LocalDrop QR code. Scan the code from the other device.'
  const encoded = data.slice(prefix.length)
  if (data.length > maxQrLength || !data.startsWith(prefix) || !/^[\w-]+$/.test(encoded)) {
    throw new Error(invalidQr)
  }

  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
    const reader = stream.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let length = 0
    let text = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return text + decoder.decode()
        length += value.byteLength
        if (length > maxCodeLength) {
          await reader.cancel()
          throw new Error('Connection code is too long.')
        }
        text += decoder.decode(value, { stream: true })
      }
    } finally {
      reader.releaseLock()
    }
  } catch {
    throw new Error(invalidQr)
  }
}
