type StateEntry = { state: string; elapsedMs: number }

export type ConnectionTrace = {
  startedAt: number
  answerAppliedAt?: number
  ice: StateEntry[]
  dtls: StateEntry[]
  connection: StateEntry[]
  capture: (now?: number) => void
}

export type FailureTrigger =
  | 'connectionstatechange: failed'
  | 'datachannel: closed before opening'
  | 'connection timeout'
  | 'create offer or gather ICE candidates'
  | 'create answer or gather ICE candidates'
  | 'setRemoteDescription: offer rejected'
  | 'setRemoteDescription: answer rejected'

const maxEntries = 32

export function createConnectionTrace(peer: RTCPeerConnection, signal: AbortSignal): ConnectionTrace {
  let dtlsTransport: RTCDtlsTransport | undefined
  const trace: ConnectionTrace = {
    startedAt: performance.now(),
    ice: [],
    dtls: [],
    connection: [],
    capture,
  }

  function capture(now = performance.now()) {
    const elapsedMs = Math.round(now - trace.startedAt)
    record(trace.ice, peer.iceConnectionState, elapsedMs)
    record(trace.connection, peer.connectionState, elapsedMs)

    // The data channel's DTLS transport may only appear during SDP negotiation.
    const transport = peer.sctp?.transport
    if (transport !== dtlsTransport) {
      dtlsTransport?.removeEventListener('statechange', onStateChange)
      dtlsTransport = transport
      dtlsTransport?.addEventListener('statechange', onStateChange, { signal })
    }
    if (dtlsTransport || trace.dtls.length) {
      record(trace.dtls, dtlsTransport?.state ?? 'not available', elapsedMs)
    }
  }

  function onStateChange() {
    capture()
  }

  capture(trace.startedAt)
  for (const event of ['signalingstatechange', 'iceconnectionstatechange', 'connectionstatechange']) {
    peer.addEventListener(event, onStateChange, { signal })
  }
  return trace
}

function record(history: StateEntry[], state: string, elapsedMs: number) {
  if (history.at(-1)?.state === state) return
  if (history.length >= maxEntries) history.shift()
  history.push({ state, elapsedMs })
}

export function connectionDiagnostics(
  trace: ConnectionTrace,
  channel: RTCDataChannel | null,
  role: 'receiver' | 'sender',
  trigger: FailureTrigger,
): string {
  const now = performance.now()
  trace.capture(now)
  const elapsed = trace.answerAppliedAt === undefined
    ? (role === 'sender' ? 'not available on the sender' : 'answer not applied')
    : `${Math.round(now - trace.answerAppliedAt)} ms`
  const format = (history: StateEntry[]) => history.map(({ state, elapsedMs }) => `${state} (+${elapsedMs} ms)`).join(' → ')

  return [
    'LocalDrop connection diagnostics',
    `Role: ${role}`,
    `Failure event: ${trigger}`,
    `Time since remote answer applied: ${elapsed}`,
    `ICE connection state: ${format(trace.ice)}`,
    `DTLS state: ${format(trace.dtls) || 'not available'}`,
    `Connection state: ${format(trace.connection)}`,
    `Data channel state: ${channel?.readyState ?? 'not created'}`,
  ].join('\n')
}
