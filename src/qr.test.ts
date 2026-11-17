import QRCode from 'qrcode'
import { expect, test, vi } from 'vitest'
import { makeQrImage, readQrCode, toBase64Url } from './qr'
import { maxCodeLength, readDescription } from './webrtc'

test('renders a pairing QR whose payload restores the original offer', async () => {
  const offer = {
    type: 'offer',
    sdp: 'v=0\r\ns=ローカル接続\r\n',
    sessionId: '0123456789abcdef01234567',
  }
  const toDataURL = vi.spyOn(QRCode, 'toDataURL')
  try {
    const image = await makeQrImage(JSON.stringify(offer))
    expect(image).toMatch(/^data:image\/png;base64,/)
    expect(toDataURL).toHaveBeenCalledTimes(1)
    const payload = toDataURL.mock.calls[0][0]
    if (typeof payload !== 'string') throw new Error('Expected a text payload')
    const code = await readQrCode(payload)
    expect(readDescription(code, 'offer')).toEqual(offer)
  } finally {
    toDataURL.mockRestore()
  }
})

test.each(['LDF1.AAAA', 'LD1.***', 'LD1.AAAA'])('rejects invalid pairing QR data %s', async (payload) => {
  await expect(readQrCode(payload)).rejects.toThrow('invalidPairingQr')
})

test('enforces the pairing QR limit after decompression', async () => {
  const atLimit = 'a'.repeat(maxCodeLength)
  async function payload(code: string) {
    const stream = new Blob([code]).stream().pipeThrough(new CompressionStream('gzip'))
    return 'LD1.' + toBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()))
  }
  await expect(readQrCode(await payload(atLimit))).resolves.toBe(atLimit)
  await expect(readQrCode(await payload(atLimit + 'a'))).rejects.toThrow('invalidPairingQr')
  await expect(makeQrImage(atLimit + 'a')).rejects.toThrow('Connection code is too long.')
})
