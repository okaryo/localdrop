type SignalType = 'offer' | 'answer'

export const maxCodeLength = 32_768

type Description = { type: SignalType; sdp: string; sessionId?: string }

export function readDescription(text: string, expectedType: SignalType): Description {
  const invalidCode = `Scan or paste the complete ${expectedType} from the other device.`
  if (text.length > maxCodeLength) throw new Error(invalidCode)

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(invalidCode)
  }

  if (
    typeof value !== 'object' ||
    value === null ||
    !('type' in value) ||
    value.type !== expectedType ||
    !('sdp' in value) ||
    typeof value.sdp !== 'string' ||
    !value.sdp.startsWith('v=0')
  ) {
    throw new Error(invalidCode)
  }

  const sessionId = 'sessionId' in value ? value.sessionId : undefined
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !/^[0-9a-f]{24}$/.test(sessionId))) {
    throw new Error(invalidCode)
  }

  return { type: expectedType, sdp: value.sdp, sessionId }
}

export async function createLocalCode(
  peer: RTCPeerConnection,
  type: SignalType,
  signal: AbortSignal,
  sessionId: string | undefined,
): Promise<string> {
  const description = type === 'offer' ? await peer.createOffer() : await peer.createAnswer()
  signal.throwIfAborted()
  await peer.setLocalDescription(description)
  await waitForIceGathering(peer, signal)

  const local = peer.localDescription
  if (!local?.sdp) throw new Error(`Could not create the ${type} code.`)
  if (!/^a=candidate:.* typ host(?: |\r?$)/m.test(local.sdp)) {
    throw new Error('No local connection candidates were found. Check your Wi-Fi and browser permissions.')
  }

  return JSON.stringify({ type: local.type, sdp: local.sdp, sessionId })
}

function waitForIceGathering(peer: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (peer.iceGatheringState === 'complete') return Promise.resolve()

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup()
      reject(new Error('Finding local connection candidates timed out. Start over and try again.'))
    }, 10_000)

    function cleanup() {
      window.clearTimeout(timeout)
      peer.removeEventListener('icegatheringstatechange', onStateChange)
      signal.removeEventListener('abort', onAbort)
    }

    function onStateChange() {
      if (peer.iceGatheringState !== 'complete') return
      cleanup()
      resolve()
    }

    function onAbort() {
      cleanup()
      reject(signal.reason)
    }

    peer.addEventListener('icegatheringstatechange', onStateChange)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
