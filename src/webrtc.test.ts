import { expect, test, vi } from 'vitest'
import { createLocalCode, maxCodeLength, readDescription } from './webrtc'

const sdp = 'v=0\r\na=candidate:1 1 udp 2122260223 192.0.2.1 12345 typ host\r\n'

test('accepts an answer from a peer that omits the session ID', () => {
  const answer = { type: 'answer', sdp }
  expect(readDescription(JSON.stringify(answer), 'answer')).toEqual({ ...answer, sessionId: undefined })
})

test.each([
  'not JSON',
  JSON.stringify({ type: 'answer', sdp }),
  JSON.stringify({ type: 'offer', sdp: 'missing SDP version' }),
  JSON.stringify({ type: 'offer', sdp, sessionId: 'invalid' }),
  'x'.repeat(maxCodeLength + 1),
])('rejects malformed or mismatched offers (%#)', (code) => {
  expect(() => readDescription(code, 'offer')).toThrow('invalidOffer')
})

test('serializes the local description with the gathered host candidate', async () => {
  const offer = { type: 'offer', sdp: 'v=0\r\n' }
  const localDescription = { ...offer, sdp }
  const peer = {
    createOffer: vi.fn().mockResolvedValue(offer),
    setLocalDescription: vi.fn().mockResolvedValue(undefined),
    iceGatheringState: 'complete',
    localDescription,
  }
  const sessionId = '0123456789abcdef01234567'
  const code = await createLocalCode(peer as unknown as RTCPeerConnection, 'offer', new AbortController().signal, sessionId)

  expect(peer.setLocalDescription).toHaveBeenCalledWith(offer)
  expect(readDescription(code, 'offer')).toEqual({ ...localDescription, sessionId })
})
