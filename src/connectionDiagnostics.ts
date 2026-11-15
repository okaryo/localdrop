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

export async function connectionDiagnostics(
  trace: ConnectionTrace,
  peer: RTCPeerConnection,
  channel: RTCDataChannel | null,
  role: 'receiver' | 'sender',
  trigger: FailureTrigger,
): Promise<string> {
  const now = performance.now()
  trace.capture(now)
  const elapsed = trace.answerAppliedAt === undefined
    ? (role === 'sender' ? 'not available on the sender' : 'answer not applied')
    : `${Math.round(now - trace.answerAppliedAt)} ms`
  const format = (history: StateEntry[]) => history.map(({ state, elapsedMs }) => `${state} (+${elapsedMs} ms)`).join(' → ')

  const lines = [
    'LocalDrop connection diagnostics',
    `Role: ${role}`,
    `Failure event: ${trigger}`,
    `Time since remote answer applied: ${elapsed}`,
    `ICE connection state: ${format(trace.ice)}`,
    `DTLS state: ${format(trace.dtls) || 'not available'}`,
    `Connection state: ${format(trace.connection)}`,
    `Data channel state: ${channel?.readyState ?? 'not created'}`,
  ]
  return [...lines, await readIceStats(peer)].join('\n')
}

async function readIceStats(peer: RTCPeerConnection): Promise<string> {
  let timer: number | undefined
  try {
    const report = await Promise.race([
      peer.getStats(),
      new Promise<null>((resolve) => { timer = window.setTimeout(() => resolve(null), 250) }),
    ])
    return report ? formatIceStats(report) : 'ICE statistics: not available (timed out)'
  } catch {
    return 'ICE statistics: not available'
  } finally {
    window.clearTimeout(timer)
  }
}

type IceStatsEntry = RTCStats & {
  state?: string
  requestsSent?: number
  responsesReceived?: number
  selectedCandidatePairId?: string
}

function formatIceStats(report: RTCStatsReport): string {
  const states = new Map([
    ['frozen', 0], ['waiting', 0], ['in-progress', 0], ['succeeded', 0], ['failed', 0], ['unknown', 0],
  ])
  let pairs = 0
  let requests = 0
  let responses = 0
  let requestCounters = 0
  let responseCounters = 0
  let transportReported = false
  let pairSelected = false

  report.forEach((entry: IceStatsEntry) => {
    if (entry.type === 'transport') {
      transportReported = true
      pairSelected ||= Boolean(entry.selectedCandidatePairId)
    } else if (entry.type === 'candidate-pair') {
      pairs++
      const state = entry.state && states.has(entry.state) ? entry.state : 'unknown'
      states.set(state, (states.get(state) ?? 0) + 1)
      if (typeof entry.requestsSent === 'number') {
        requests += entry.requestsSent
        requestCounters++
      }
      if (typeof entry.responsesReceived === 'number') {
        responses += entry.responsesReceived
        responseCounters++
      }
    }
  })

  const breakdown = Array.from(states, ([state, count]) => count ? `${state}: ${count}` : '').filter(Boolean)
  const counter = (total: number, reported: number) => {
    if (!reported) return 'not available'
    return reported === pairs ? String(total) : `${total} (${reported}/${pairs} pairs reported)`
  }

  return [
    `ICE candidate pairs: ${pairs}${breakdown.length ? ` (${breakdown.join(', ')})` : ''}`,
    `ICE checks sent: ${counter(requests, requestCounters)}`,
    `ICE check responses received: ${counter(responses, responseCounters)}`,
    `ICE selected pair: ${transportReported ? (pairSelected ? 'yes' : 'no') : 'not available'}`,
  ].join('\n')
}
