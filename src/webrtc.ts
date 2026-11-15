type SignalType = 'offer' | 'answer'

export function readDescription(text: string, expectedType: SignalType): RTCSessionDescriptionInit {
  const invalidCode = `Paste the complete ${expectedType} code from the other device.`
  if (text.length > 32_768) throw new Error(invalidCode)

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

  return { type: expectedType, sdp: value.sdp }
}

export async function createLocalCode(
  peer: RTCPeerConnection,
  type: SignalType,
  signal: AbortSignal,
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

  return JSON.stringify({ type: local.type, sdp: local.sdp })
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
