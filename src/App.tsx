import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { createLocalCode, readDescription } from './webrtc'

type Role = 'receiver' | 'sender'
type Lane = 'sent' | 'received'
type Message = { id: number; lane: Lane; text: string }
type Session = {
  peer: RTCPeerConnection
  controller: AbortController
  channel: RTCDataChannel | null
  connectionTimer?: number
}

const messageLimit = 500
const connectionError = 'Could not connect. Check that both devices are on the same Wi-Fi and can reach each other.'

export function App() {
  const [role, setRole] = useState<Role | null>(null)
  const supported = typeof RTCPeerConnection === 'function'

  return (
    <main className="shell">
      <header>
        <h1>LocalDrop</h1>
        <p>Send a short message between devices on the same Wi-Fi.</p>
      </header>
      {!supported ? (
        <p role="alert">This browser does not support WebRTC. Open LocalDrop in Chrome.</p>
      ) : role ? (
        <Connection role={role} onReset={() => setRole(null)} />
      ) : (
        <section className="card" aria-labelledby="device-heading">
          <h2 id="device-heading">Which device is this?</h2>
          <div className="actions">
            <button onClick={() => setRole('receiver')}>Receive on Mac</button>
            <button className="secondary" onClick={() => setRole('sender')}>Send from Android</button>
          </div>
        </section>
      )}
    </main>
  )
}

function Connection({ role, onReset }: { role: Role; onReset: () => void }) {
  const isReceiver = role === 'receiver'
  const session = useRef<Session | null>(null)
  const nextMessageId = useRef(0)
  const [busy, setBusy] = useState(false)
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

  useEffect(() => () => {
    if (session.current) closeSession(session.current)
  }, [])

  function addMessage(lane: Lane, text: string) {
    const entry = { id: nextMessageId.current++, lane, text }
    setMessages((previous) => [...previous.slice(-49), entry])
  }

  function end(active: Session, failure?: string) {
    closeSession(active)
    setConnected(false)
    setEnded(true)
    setStatus(failure ? 'Connection failed' : 'Disconnected')
    if (failure) setError(failure)
  }

  function watchChannel(active: Session, channel: RTCDataChannel) {
    active.channel = channel
    const { signal } = active.controller

    function onOpen() {
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
      }
    }, { signal })
    channel.addEventListener('close', () => end(active), { signal })
    if (channel.readyState === 'open') onOpen()
  }

  function startSession() {
    const peer = new RTCPeerConnection({ iceServers: [] })
    const active: Session = { peer, controller: new AbortController(), channel: null }
    session.current = active
    const { signal } = active.controller

    peer.addEventListener('connectionstatechange', () => {
      if (peer.connectionState === 'failed') {
        end(active, connectionError)
      } else if (peer.connectionState === 'disconnected') {
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

  async function exchange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || opened || ended) return
    setError('')
    setBusy(true)

    let active = session.current
    try {
      if (isReceiver && !localCode) {
        setStatus('Creating offer…')
        active = startSession()
        const code = await createLocalCode(active.peer, 'offer', active.controller.signal)
        setLocalCode(code)
        setStatus('Waiting for the answer')
      } else if (isReceiver && active) {
        const answer = readDescription(remoteCode, 'answer')
        try {
          await active.peer.setRemoteDescription(answer)
        } catch {
          throw new Error('Could not apply the answer. Check that it was created from this offer.')
        }
        if (active.controller.signal.aborted) return
        setAnswerApplied(true)
        if (active.channel?.readyState !== 'open') {
          setStatus('Connecting…')
          const pending = active
          pending.connectionTimer = window.setTimeout(() => end(pending, connectionError), 20_000)
        }
      } else if (!isReceiver) {
        const offer = readDescription(remoteCode, 'offer')
        setStatus('Creating answer…')
        active = startSession()
        try {
          await active.peer.setRemoteDescription(offer)
        } catch {
          throw new Error('Could not apply the offer. Ask the Mac to create a new offer.')
        }
        const code = await createLocalCode(active.peer, 'answer', active.controller.signal)
        setLocalCode(code)
        setStatus('Waiting for the Mac to apply the answer')
      }
    } catch (cause) {
      if (active?.controller.signal.aborted) return

      if (!localCode && session.current) {
        closeSession(session.current)
        session.current = null
      }
      setStatus(isReceiver && localCode ? 'Waiting for the answer' : '')
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

  const showRemoteInput = isReceiver ? Boolean(localCode) && !answerApplied : !localCode
  const showExchange = !opened && !ended

  return (
    <section className="card" aria-labelledby="connection-heading">
      <div className="card-heading">
        <h2 id="connection-heading">{isReceiver ? 'Receive on Mac' : 'Send from Android'}</h2>
        <button className="secondary" type="button" onClick={onReset}>
          {connected ? 'Disconnect' : 'Start over'}
        </button>
      </div>
      <div role="status">{status && <p className="status">{status}</p>}</div>
      {error && <p className="error" role="alert">{error}</p>}

      {showExchange && (
        <form onSubmit={exchange}>
          {localCode && (isReceiver ? !answerApplied : true) && (
            <LocalCode code={localCode} label={isReceiver ? 'Offer' : 'Answer'} />
          )}
          {showRemoteInput && (
            <label>
              {isReceiver ? 'Answer from Android' : 'Offer from Mac'}
              <textarea
                rows={4}
                maxLength={32_769}
                value={remoteCode}
                onChange={(event) => setRemoteCode(event.target.value)}
                disabled={busy}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>
          )}
          {(!localCode || showRemoteInput) && (
            <button type="submit" disabled={busy || (showRemoteInput && !remoteCode.trim())}>
              {isReceiver ? (localCode ? 'Apply answer' : 'Create offer') : 'Create answer'}
            </button>
          )}
        </form>
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
        </>
      )}
    </section>
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
