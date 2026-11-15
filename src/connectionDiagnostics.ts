type StateEntry = { state: string; elapsedMs: number }

export type ConnectionTrace = {
  startedAt: number
  answerAppliedAt?: number
  ice: StateEntry[]
  connection: StateEntry[]
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

export function createConnectionTrace(peer: RTCPeerConnection): ConnectionTrace {
  return {
    startedAt: performance.now(),
    ice: [{ state: peer.iceConnectionState, elapsedMs: 0 }],
    connection: [{ state: peer.connectionState, elapsedMs: 0 }],
  }
}

export function recordConnectionStates(trace: ConnectionTrace, peer: RTCPeerConnection, now = performance.now()) {
  const elapsedMs = Math.round(now - trace.startedAt)
  record(trace.ice, peer.iceConnectionState, elapsedMs)
  record(trace.connection, peer.connectionState, elapsedMs)
}

function record(history: StateEntry[], state: string, elapsedMs: number) {
  if (history.at(-1)?.state === state) return
  if (history.length >= maxEntries) history.shift()
  history.push({ state, elapsedMs })
}

export function connectionDiagnostics(
  trace: ConnectionTrace,
  peer: RTCPeerConnection,
  channel: RTCDataChannel | null,
  role: 'receiver' | 'sender',
  trigger: FailureTrigger,
): string {
  const now = performance.now()
  recordConnectionStates(trace, peer, now)
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
    `Connection state: ${format(trace.connection)}`,
    `Data channel state: ${channel?.readyState ?? 'not created'}`,
  ].join('\n')
}
