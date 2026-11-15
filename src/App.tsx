import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { FileDownload } from './FileDownload'
import { PairingQr, QrCamera } from './QrExchange'
import { QrFiles } from './QrFiles'
import { FileReceiver, maxFileSize, sendFile } from './fileTransfer'
import type { ReceiveUpdate } from './fileTransfer'
import { readQrCode } from './qr'
import { createLocalCode, maxCodeLength, readDescription } from './webrtc'

type Role = 'receiver' | 'sender'
type ScanStage = 'starting' | 'scanning'
type Lane = 'sent' | 'received'
type Message = { id: number; lane: Lane; text: string }
type ConnectionFailure = { status: string; message: string }
type Session = {
  peer: RTCPeerConnection
  controller: AbortController
  channel: RTCDataChannel | null
  fileReceiver: FileReceiver | null
  sessionId?: string
  connectionTimer?: number
  answerApplied?: boolean
  iceConnected?: boolean
  channelOpened?: boolean
}

const messageLimit = 500

export function App() {
  const [role, setRole] = useState<Role | null>(null)
  const [qrFiles, setQrFiles] = useState(false)
  const supported = typeof RTCPeerConnection === 'function'

  return (
    <main className={role ? 'shell wifi-shell' : 'shell'}>
      <header>
        <h1>LocalDrop</h1>
        <p>Send files and messages between nearby devices.</p>
      </header>
      {qrFiles ? (
        <QrFiles onBack={() => setQrFiles(false)} />
      ) : role ? (
        <Connection role={role} onReset={() => setRole(null)} />
      ) : (
        <>
          <section className="card" aria-labelledby="device-heading">
            <h2 id="device-heading">Transfer over Wi-Fi</h2>
            {supported ? (
              <>
                <p>Connect both devices to the same Wi-Fi. Start on the device receiving the file.</p>
                <div className="actions">
                  <button onClick={() => setRole('receiver')}>Receive</button>
                  <button className="secondary" onClick={() => setRole('sender')}>Send</button>
                </div>
              </>
            ) : (
              <p role="alert">This browser does not support WebRTC. Open LocalDrop in Chrome to use Wi-Fi transfer.</p>
            )}
          </section>
          <section className="card" aria-labelledby="qr-heading">
            <h2 id="qr-heading">Transfer by QR code</h2>
            <p>Send a file up to 4 KiB without a network connection.</p>
            <button className="secondary" onClick={() => setQrFiles(true)}>QR file transfer</button>
          </section>
        </>
      )}
      <footer className="trademark">
        QR Code is a registered trademark of DENSO WAVE INCORPORATED in Japan and in other countries.
      </footer>
    </main>
  )
}

function Connection({ role, onReset }: { role: Role; onReset: () => void }) {
  const isReceiver = role === 'receiver'
  const session = useRef<Session | null>(null)
  const nextMessageId = useRef(0)
  const [busy, setBusy] = useState(false)
  const [scanStage, setScanStage] = useState<ScanStage | null>(null)
  const [remoteCode, setRemoteCode] = useState('')
  const [localCode, setLocalCode] = useState('')
  const [answerApplied, setAnswerApplied] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [ended, setEnded] = useState(false)
  const [opened, setOpened] = useState(false)
  const [connected, setConnected] = useState(false)
  const [message, setMessage] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [fileUpdate, setFileUpdate] = useState<ReceiveUpdate | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [sendingFile, setSendingFile] = useState(false)
  const [fileStatus, setFileStatus] = useState('')
  const [fileError, setFileError] = useState('')
  const remoteLabel = isReceiver ? 'answer' : 'offer'
  const displayedStatus = scanStage === 'starting'
    ? 'Starting camera…'
    : scanStage === 'scanning' ? `Looking for the ${remoteLabel} QR code…` : status

  useEffect(() => () => {
    if (session.current) closeSession(session.current)
  }, [])

  function addMessage(lane: Lane, text: string) {
    const entry = { id: nextMessageId.current++, lane, text }
    setMessages((previous) => [...previous.slice(-49), entry])
  }

  function end(active: Session, failure?: ConnectionFailure) {
    if (active.controller.signal.aborted) return
    closeSession(active)
    const interrupted = active.fileReceiver?.interrupt()
    if (interrupted) setFileUpdate(interrupted)
    setScanStage(null)
    setConnected(false)
    setEnded(true)
    setStatus(failure?.status ?? 'Disconnected')
    setError(failure?.message ?? '')
  }

  function failConnection(active: Session, timedOut = false) {
    const iceState = active.peer.iceConnectionState
    if (active.channelOpened) {
      end(active, {
        status: 'WebRTC connection lost',
        message: 'Start over on both devices to reconnect.',
      })
    } else if (active.iceConnected || iceState === 'connected' || iceState === 'completed') {
      end(active, {
        status: 'Data channel did not open',
        message: 'WebRTC found a network path, but the data channel never opened. Start over on both devices.',
      })
    } else {
      end(active, {
        status: timedOut ? 'WebRTC connection timed out' : 'WebRTC connection failed',
        message: (active.answerApplied ? 'The answer was applied. ' : '')
          + `No direct connection was established (ICE state: ${iceState}). `
          + 'Check that both devices can reach each other on the same Wi-Fi, then start over.',
      })
    }
  }

  function watchChannel(active: Session, channel: RTCDataChannel) {
    active.channel = channel
    channel.binaryType = 'arraybuffer'
    const { signal } = active.controller

    function onOpen() {
      active.channelOpened = true
      window.clearTimeout(active.connectionTimer)
      setError('')
      setOpened(true)
      setConnected(true)
      setStatus('Connected')
    }

    channel.addEventListener('open', onOpen, { signal })
    channel.addEventListener('message', (event) => {
      if (typeof event.data === 'string' && event.data.length <= messageLimit) {
        addMessage('received', event.data)
      } else if (event.data instanceof ArrayBuffer) {
        const update = active.fileReceiver?.accept(event.data)
        if (update) setFileUpdate(update)
      }
    }, { signal })
    channel.addEventListener('close', () => {
      if (active.channelOpened) end(active)
      else failConnection(active)
    }, { signal })
    if (channel.readyState === 'open') onOpen()
  }

  function startSession(sessionId?: string) {
    const peer = new RTCPeerConnection({ iceServers: [] })
    const active: Session = {
      peer,
      controller: new AbortController(),
      channel: null,
      sessionId,
      fileReceiver: isReceiver ? new FileReceiver() : null,
    }
    session.current = active
    const { signal } = active.controller

    peer.addEventListener('iceconnectionstatechange', () => {
      if (peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed') {
        active.iceConnected = true
        if (!active.channelOpened) setStatus('Opening data channel…')
      }
    }, { signal })
    peer.addEventListener('connectionstatechange', () => {
      if (peer.connectionState === 'failed') {
        failConnection(active)
      } else if (peer.connectionState === 'disconnected' && active.channelOpened) {
        setConnected(false)
        setStatus('Connection interrupted')
      } else if (peer.connectionState === 'connected' && active.channel?.readyState === 'open') {
        setConnected(true)
        setStatus('Connected')
      }
    }, { signal })

    if (isReceiver) {
      watchChannel(active, peer.createDataChannel('localdrop'))
    } else {
      peer.addEventListener('datachannel', (event) => {
        if (active.channel || event.channel.label !== 'localdrop') {
          event.channel.close()
          return
        }
        watchChannel(active, event.channel)
      }, { signal })
    }

    return active
  }

  async function exchange(code: string, source: 'text' | 'qr') {
    if (busy || opened || ended || (source === 'text' && scanStage)) return
    setScanStage(null)
    setError('')
    setBusy(true)

    let active = session.current
    let failureStatus = `Invalid ${remoteLabel} ${source === 'qr' ? 'QR code' : 'text code'}`
    try {
      if (isReceiver && !localCode) {
        failureStatus = 'Could not create the offer'
        setStatus('Creating offer…')
        const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('')
        active = startSession(sessionId)
        setLocalCode(await createLocalCode(active.peer, 'offer', active.controller.signal, sessionId))
        setStatus('Waiting for the answer')
        return
      }

      const description = readDescription(code, isReceiver ? 'answer' : 'offer')
      if (source === 'qr' && !description.sessionId) {
        throw new Error('This QR code is missing a pairing ID. Create a new code and try again.')
      }

      if (isReceiver && active) {
        if (description.sessionId && description.sessionId !== active.sessionId) {
          throw new Error('This answer is for a different offer. Scan or paste the answer for this session.')
        }
        failureStatus = 'Could not apply the answer'
        setStatus('Applying answer…')
        try {
          await active.peer.setRemoteDescription(description)
        } catch {
          throw new Error('Check that the answer was created from the offer shown on this page.')
        }
        if (active.controller.signal.aborted) return
        active.answerApplied = true
        setAnswerApplied(true)
        if (active.channel?.readyState !== 'open') {
          setStatus(active.iceConnected ? 'Opening data channel…' : 'Checking WebRTC connection…')
          const pending = active
          pending.connectionTimer = window.setTimeout(() => failConnection(pending, true), 20_000)
        }
      } else if (!isReceiver) {
        failureStatus = 'Could not apply the offer'
        setStatus('Applying offer…')
        active = startSession(description.sessionId)
        try {
          await active.peer.setRemoteDescription(description)
        } catch {
          throw new Error('Ask the receiving device to create a new offer.')
        }
        if (active.controller.signal.aborted) return
        failureStatus = 'Could not create the answer'
        setStatus('Creating answer…')
        setLocalCode(await createLocalCode(
          active.peer, 'answer', active.controller.signal, description.sessionId,
        ))
        setStatus('Waiting for the receiving device to connect')
      }
    } catch (cause) {
      if (active?.controller.signal.aborted) return

      if (!localCode && session.current) {
        closeSession(session.current)
        session.current = null
      }
      setStatus(failureStatus)
      setError(cause instanceof Error ? cause.message : 'Could not set up the connection.')
    } finally {
      setBusy(false)
    }
  }

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const channel = session.current?.channel
    const text = message.trim()
    if (!connected || channel?.readyState !== 'open' || !text || text.length > messageLimit) return

    try {
      channel.send(text)
      addMessage('sent', text)
      setMessage('')
      setError('')
    } catch {
      setError('Could not send the message. Try again or reconnect.')
    }
  }

  async function transferFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const active = session.current
    const file = selectedFile
    if (!connected || active?.channel?.readyState !== 'open' || !file || sendingFile) return

    setSendingFile(true)
    setFileError('')
    setFileStatus('Sending file…')
    try {
      await sendFile(active.channel, file, active.controller.signal)
      setFileStatus('File sent.')
    } catch (cause) {
      setFileStatus('')
      setFileError(active.controller.signal.aborted
        ? 'File transfer interrupted.'
        : cause instanceof Error ? cause.message : 'Could not send the file.')
    } finally {
      setSendingFile(false)
    }
  }

  const showRemoteInput = isReceiver ? Boolean(localCode) && !answerApplied : !localCode
  const showExchange = !opened && !ended
  const showLocalCode = Boolean(localCode) && !answerApplied
  const canScan = window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia)
  const localLabel = isReceiver ? 'Offer' : 'Answer'

  return (
    <section className="card" aria-labelledby="connection-heading">
      <div className="card-heading">
        <h2 id="connection-heading">{isReceiver ? 'Receive over Wi-Fi' : 'Send over Wi-Fi'}</h2>
        <button className="secondary" type="button" onClick={onReset}>
          {connected ? 'Disconnect' : 'Start over'}
        </button>
      </div>
      <div role="status">{displayedStatus && <p className="status">{displayedStatus}</p>}</div>
      {error && <p className="error" role="alert">{error}</p>}

      {showExchange && (
        <>
          {isReceiver && !localCode && (
            <div className="pairing">
              <p>Create a pairing code to show to the sending device.</p>
              <button type="button" disabled={busy} onClick={() => void exchange('', 'text')}>
                Create offer
              </button>
            </div>
          )}
          {!scanStage && showLocalCode && session.current?.sessionId && (
            <div className="pairing">
              <PairingHint device={isReceiver ? 'sending' : 'receiving'}>
                {isReceiver ? (
                  <>Choose <strong>Send</strong>, then <strong>Scan offer QR code</strong>. Scan the code below.</>
                ) : (
                  <>Choose <strong>Scan answer QR code</strong> on the Receive screen. Scan the code below.</>
                )}
              </PairingHint>
              <PairingQr code={localCode} label={localLabel} />
            </div>
          )}
          {showRemoteInput && !isReceiver && canScan && (
            <PairingHint device="receiving">
              Choose <strong>Receive</strong>, then <strong>Create offer</strong> to show the code.
            </PairingHint>
          )}
          {showRemoteInput && (
            scanStage ? (
              <div className="pairing">
                <p>
                  {isReceiver
                    ? 'Fit the answer QR code from the sending device inside the camera guide.'
                    : 'Fit the offer QR code from the receiving device inside the camera guide.'}
                </p>
                <QrCamera
                  decode={readQrCode}
                  onReady={() => setScanStage('scanning')}
                  onScan={(data) => void exchange(data, 'qr')}
                  onError={(message) => {
                    setScanStage(null)
                    setStatus(`Could not scan the ${remoteLabel} QR code`)
                    setError(message)
                  }}
                />
                <button className="secondary" type="button" onClick={() => setScanStage(null)}>
                  Cancel scan
                </button>
              </div>
            ) : canScan ? (
              <div className="pairing">
                {isReceiver && <p>When the sending device shows its answer, scan it here.</p>}
                <button type="button" disabled={busy} onClick={() => {
                  setError('')
                  setStatus(isReceiver ? 'Waiting for the answer' : '')
                  setScanStage('starting')
                }}>
                  Scan {remoteLabel} QR code
                </button>
              </div>
            ) : (
              <p>QR scanning requires camera access on an HTTPS page. You can use a text code here.</p>
            )
          )}
          {!scanStage && (showLocalCode || showRemoteInput) && (
            <details open={showRemoteInput && !canScan ? true : undefined}>
              <summary>Use a text code</summary>
              <form className="manual-code" onSubmit={(event) => {
                event.preventDefault()
                void exchange(remoteCode, 'text')
              }}>
                {showLocalCode && <LocalCode code={localCode} label={localLabel} />}
                {showRemoteInput && (
                  <>
                    <label>
                      {isReceiver ? 'Answer from the sending device' : 'Offer from the receiving device'}
                      <textarea
                        rows={4}
                        maxLength={maxCodeLength + 1}
                        value={remoteCode}
                        onChange={(event) => setRemoteCode(event.target.value)}
                        disabled={busy}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                      />
                    </label>
                    <button type="submit" disabled={busy || !remoteCode.trim()}>
                      {isReceiver ? 'Apply answer' : 'Create answer'}
                    </button>
                  </>
                )}
              </form>
            </details>
          )}
        </>
      )}

      {opened && (
        <>
          {messages.length > 0 && (
            <ul className="messages" aria-label="Messages" aria-live="polite">
              {messages.map((entry) => (
                <li key={entry.id}>
                  <strong>{entry.lane === 'sent' ? 'You' : 'Other device'}</strong>
                  <span>{entry.text}</span>
                </li>
              ))}
            </ul>
          )}
          <form className="message-form" onSubmit={send}>
            <label>
              Message
              <input
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                maxLength={messageLimit}
                disabled={!connected}
              />
            </label>
            <button type="submit" disabled={!connected || !message.trim()}>Send</button>
          </form>
          {isReceiver ? (
            <section className="file-transfer" aria-labelledby="file-heading">
              <h2 id="file-heading">Receive a file</h2>
              <ReceivedFile update={fileUpdate} />
            </section>
          ) : (
            <form className="file-transfer" onSubmit={transferFile} aria-labelledby="file-heading">
              <h2 id="file-heading">Send a file</h2>
              <label>
                File
                <input
                  type="file"
                  aria-describedby="file-size-limit"
                  disabled={!connected || sendingFile}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0] ?? null
                    setSelectedFile(file)
                    setFileStatus('')
                    setFileError(file && file.size > maxFileSize ? 'Choose a file up to 25 MiB.' : '')
                  }}
                />
              </label>
              <p id="file-size-limit">Up to 25 MiB per file.</p>
              <button type="submit" disabled={
                !connected || !selectedFile || selectedFile.size > maxFileSize || sendingFile
              }>Send file</button>
              <p role="status">{fileStatus}</p>
              {fileError && <p className="error" role="alert">{fileError}</p>}
            </form>
          )}
        </>
      )}
    </section>
  )
}

function PairingHint({ device, children }: { device: 'sending' | 'receiving'; children: ReactNode }) {
  return (
    <div className="pairing-hint">
      <p className="pairing-hint-label">On the {device} device</p>
      <p>{children}</p>
    </div>
  )
}

function ReceivedFile({ update }: { update: ReceiveUpdate | null }) {
  if (!update) return <p>Files appear here when the other device sends them.</p>
  if (update.status === 'interrupted') {
    return <p className="error" role="alert">{update.message}</p>
  }
  if (update.status === 'ready') {
    return <FileDownload name={update.name} blob={update.blob} />
  }

  const percent = update.size ? Math.floor((update.received * 100) / update.size) : 0
  return (
    <div className="file-progress">
      <p>Receiving {update.name} · {percent}%</p>
      <progress aria-label="File receive progress" value={update.received} max={update.size || 1} />
    </div>
  )
}

function LocalCode({ code, label }: { code: string; label: 'Offer' | 'Answer' }) {
  const field = useRef<HTMLTextAreaElement>(null)
  const [copyStatus, setCopyStatus] = useState('')

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopyStatus('Copied.')
    } catch {
      field.current?.focus()
      field.current?.select()
      setCopyStatus('Selected. Use your device’s copy command.')
    }
  }

  return (
    <div className="code">
      <label>
        {label} code
        <textarea ref={field} readOnly value={code} rows={4} spellCheck={false} />
      </label>
      <div className="actions">
        <button className="secondary" type="button" onClick={copy}>
          {navigator.clipboard ? `Copy ${label.toLowerCase()}` : `Select ${label.toLowerCase()}`}
        </button>
        <span role="status">{copyStatus}</span>
      </div>
    </div>
  )
}

function closeSession(active: Session) {
  active.controller.abort()
  window.clearTimeout(active.connectionTimer)
  active.channel?.close()
  active.peer.close()
}
