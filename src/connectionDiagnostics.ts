type StateEntry = { state: string; elapsedMs: number }
type DebugEntry = { label: string; elapsedMs: number; details: Promise<string> }

export type ConnectionTrace = {
  startedAt: number
  answerAppliedAt?: number
  ice: StateEntry[]
  dtls: StateEntry[]
  connection: StateEntry[]
  capture: (now?: number) => void
  debug?: {
    entries: DebugEntry[]
    camera: (label: string) => void
    description: (label: string, sdp?: string) => void
  }
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
const periodicIceCheck = 'periodic ICE check'

export function createConnectionTrace(peer: RTCPeerConnection, signal: AbortSignal, debug = false): ConnectionTrace {
  let dtlsTransport: RTCDtlsTransport | undefined
  let observedIceTransport: RTCIceTransport | undefined
  const trace: ConnectionTrace = {
    startedAt: performance.now(),
    ice: [],
    dtls: [],
    connection: [],
    capture,
  }

  function addDebugEntry(label: string, details: Promise<string>) {
    if (!trace.debug || signal.aborted) return
    const { entries } = trace.debug
    if (entries.length >= maxEntries) {
      const periodic = entries.findIndex((entry) => entry.label === periodicIceCheck)
      if (periodic === -1 && label === periodicIceCheck) return
      entries.splice(Math.max(periodic, 0), 1)
    }
    entries.push({ label, details, elapsedMs: Math.round(performance.now() - trace.startedAt) })
  }

  function sample(label: string) {
    if (trace.debug && !signal.aborted) addDebugEntry(label, readIceStats(peer, true))
  }

  if (debug) {
    trace.debug = {
      entries: [],
      camera: (label) => addDebugEntry(label, readCameraPermission()),
      description: (label, sdp) => addDebugEntry(label, Promise.resolve(describeHostCandidates(sdp))),
    }
    const timer = window.setInterval(() => {
      if (peer.iceConnectionState !== 'new' && peer.sctp?.state !== 'connected') sample(periodicIceCheck)
    }, 1000)
    signal.addEventListener('abort', () => window.clearInterval(timer), { once: true })
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
    const iceTransport = trace.debug ? dtlsTransport?.iceTransport : undefined
    if (iceTransport !== observedIceTransport) {
      observedIceTransport?.removeEventListener('selectedcandidatepairchange', onSelectedPairChange)
      observedIceTransport = iceTransport
      observedIceTransport?.addEventListener('selectedcandidatepairchange', onSelectedPairChange, { signal })
    }
  }

  function onStateChange(event: Event) {
    capture()
    if (event.type === 'iceconnectionstatechange') sample(`ICE: ${peer.iceConnectionState}`)
    if (event.type === 'statechange') sample(`DTLS: ${dtlsTransport?.state ?? 'not available'}`)
  }

  function onSelectedPairChange() {
    sample('selected ICE pair changed')
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
  const finalStats = readIceStats(peer, Boolean(trace.debug))
  const timeline = trace.debug?.entries.slice()
  if (timeline) {
    lines.push('Debug timeline (relative to session start)')
    lines.push(...await Promise.all(timeline.map(async ({ label, elapsedMs, details }) =>
      `+${elapsedMs} ms ${label}\n${await details}`)))
    lines.push('ICE statistics at failure')
  }
  return [...lines, await finalStats].join('\n')
}

async function withinStatsDeadline<T>(request: () => Promise<T>): Promise<T | null> {
  let timer: number | undefined
  try {
    return await Promise.race([
      request(),
      new Promise<null>((resolve) => { timer = window.setTimeout(() => resolve(null), 250) }),
    ])
  } finally {
    window.clearTimeout(timer)
  }
}

async function readIceStats(peer: RTCPeerConnection, debug: boolean): Promise<string> {
  try {
    const report = await withinStatsDeadline(() => peer.getStats())
    return report ? formatIceStats(report, debug) : 'ICE statistics: not available (timed out)'
  } catch {
    return 'ICE statistics: not available'
  }
}

async function readCameraPermission(): Promise<string> {
  try {
    const permission = await withinStatsDeadline(() => navigator.permissions.query({ name: 'camera' }))
    return `Camera permission: ${permission?.state ?? 'not available'}`
  } catch {
    return 'Camera permission: not available'
  }
}

type IceStatsEntry = RTCStats & {
  state?: string
  requestsSent?: number
  responsesReceived?: number
  selectedCandidatePairId?: string
  localCandidateId?: string
  remoteCandidateId?: string
  candidateType?: string
  protocol?: string
  address?: string | null
}

function formatIceStats(report: RTCStatsReport, debug: boolean): string {
  const states = new Map([
    ['frozen', 0], ['waiting', 0], ['in-progress', 0], ['succeeded', 0], ['failed', 0], ['unknown', 0],
  ])
  let pairs = 0
  let requests = 0
  let responses = 0
  let requestCounters = 0
  let responseCounters = 0
  let transportReported = false
  let selectedPairId: string | undefined

  report.forEach((entry: IceStatsEntry) => {
    if (entry.type === 'transport') {
      transportReported = true
      selectedPairId ||= entry.selectedCandidatePairId
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

  const lines = [
    `ICE candidate pairs: ${pairs}${breakdown.length ? ` (${breakdown.join(', ')})` : ''}`,
    `ICE checks sent: ${counter(requests, requestCounters)}`,
    `ICE check responses received: ${counter(responses, responseCounters)}`,
    `ICE selected pair: ${transportReported ? (selectedPairId ? 'yes' : 'no') : 'not available'}`,
  ]
  if (debug && selectedPairId) {
    const pair: IceStatsEntry | undefined = report.get(selectedPairId)
    lines.push(`Selected ICE route: ${describeCandidate(report, pair?.localCandidateId)} → ${describeCandidate(report, pair?.remoteCandidateId)}`)
    lines.push(`Selected pair checks sent/answered: ${pair?.requestsSent ?? 'not available'}/${pair?.responsesReceived ?? 'not available'}`)
  }
  return lines.join('\n')
}

function describeCandidate(report: RTCStatsReport, id?: string): string {
  const candidate: IceStatsEntry | undefined = id === undefined ? undefined : report.get(id)
  const type = candidate?.candidateType ?? ''
  const protocol = candidate?.protocol ?? ''
  return [
    ['host', 'srflx', 'prflx', 'relay'].includes(type) ? type : 'unknown candidate type',
    ['udp', 'tcp'].includes(protocol) ? protocol : 'unknown protocol',
    addressType(candidate?.address ?? ''),
  ].join(', ')
}

function describeHostCandidates(sdp?: string): string {
  if (!sdp) return 'Host candidates: not available'
  const counts = new Map<string, number>()
  for (const line of sdp.split('\n')) {
    if (!line.startsWith('a=candidate:')) continue
    const fields = line.trim().split(/\s+/)
    if (fields[6] !== 'typ' || fields[7] !== 'host') continue
    const type = addressType(fields[4] ?? '')
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  return `Host candidates: ${Array.from(counts, ([type, count]) => `${type}: ${count}`).join(', ') || '0'}`
}

function addressType(address: string): string {
  if (/\.local\.?$/i.test(address)) return 'mDNS'
  if (address.includes(':')) return 'IPv6'
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address)) return 'IPv4'
  return 'unknown address type'
}
