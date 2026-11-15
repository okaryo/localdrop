import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { FileDownload } from './FileDownload'
import { useLanguage } from './LanguageProvider'
import { PairingQr, QrCamera } from './QrExchange'
import { QrFiles } from './QrFiles'
import { FileReceiver, maxFileSize, sendFile } from './fileTransfer'
import type { ReceiveUpdate } from './fileTransfer'
import { AppError, errorMessage } from './i18n'
import type { Message as UiMessage } from './i18n'
import { readQrCode } from './qr'
import { createLocalCode, maxCodeLength, readDescription } from './webrtc'

type Role = 'receiver' | 'sender'
type ScanStage = 'starting' | 'scanning'
type Lane = 'sent' | 'received'
type Message = { id: number; lane: Lane; text: string }
type ConnectionFailure = { status: UiMessage; message: UiMessage }
type CompletedFile = Extract<ReceiveUpdate, { status: 'ready' }>
type ActiveFileUpdate = Exclude<ReceiveUpdate, CompletedFile>
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
const fileLimitMiB = maxFileSize / (1024 * 1024)

export function App() {
  const { language, setLanguage, t } = useLanguage()
  const [role, setRole] = useState<Role | null>(null)
  const [qrFiles, setQrFiles] = useState(false)
  const supported = typeof RTCPeerConnection === 'function'

  return (
    <main className={role ? 'shell wifi-shell' : 'shell'}>
      <header>
        <div className="app-heading">
          <h1>LocalDrop</h1>
          <select
            className="language-select"
            aria-label={t('language')}
            value={language}
            onChange={(event) => setLanguage(event.currentTarget.value === 'ja' ? 'ja' : 'en')}
          >
            <option value="en" lang="en">English</option>
            <option value="ja" lang="ja">日本語</option>
          </select>
        </div>
        <p>{t('tagline')}</p>
      </header>
      {qrFiles ? (
        <QrFiles onBack={() => setQrFiles(false)} />
      ) : role ? (
        <Connection role={role} onReset={() => setRole(null)} />
      ) : (
        <>
          <section className="card" aria-labelledby="device-heading">
            <h2 id="device-heading">{t('wifiTransfer')}</h2>
            {supported ? (
              <>
                <p>{t('wifiStart')}</p>
                <div className="actions">
                  <button onClick={() => setRole('receiver')}>{t('receive')}</button>
                  <button className="secondary" onClick={() => setRole('sender')}>{t('send')}</button>
                </div>
              </>
            ) : (
              <p role="alert">{t('unsupportedWebrtc')}</p>
            )}
          </section>
          <section className="card" aria-labelledby="qr-heading">
            <h2 id="qr-heading">{t('transferByQr')}</h2>
            <p>{t('qrIntro')}</p>
            <button className="secondary" onClick={() => setQrFiles(true)}>{t('qrFileTransfer')}</button>
          </section>
        </>
      )}
      <footer className="trademark">
        {t('trademark')}
      </footer>
    </main>
  )
}

function Connection({ role, onReset }: { role: Role; onReset: () => void }) {
  const { t } = useLanguage()
  const isReceiver = role === 'receiver'
  const session = useRef<Session | null>(null)
  const nextMessageId = useRef(0)
  const [busy, setBusy] = useState(false)
  const [scanStage, setScanStage] = useState<ScanStage | null>(null)
  const [remoteCode, setRemoteCode] = useState('')
  const [localCode, setLocalCode] = useState('')
  const [answerApplied, setAnswerApplied] = useState(false)
  const [status, setStatus] = useState<UiMessage | null>(null)
  const [error, setError] = useState<UiMessage | null>(null)
  const [ended, setEnded] = useState(false)
  const [opened, setOpened] = useState(false)
  const [connected, setConnected] = useState(false)
  const [message, setMessage] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [fileUpdate, setFileUpdate] = useState<ActiveFileUpdate | null>(null)
  const [completedFiles, setCompletedFiles] = useState<CompletedFile[]>([])
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [sendingFile, setSendingFile] = useState(false)
  const [fileStatus, setFileStatus] = useState<UiMessage | null>(null)
  const [fileError, setFileError] = useState<UiMessage | null>(null)
  const oversizedFile = selectedFiles.find((file) => file.size > maxFileSize)
  const displayedFileError: UiMessage | null = fileError ?? (oversizedFile
    ? { key: 'fileTooLarge', values: { name: oversizedFile.name, limit: fileLimitMiB } }
    : null)
  const displayedStatus: UiMessage | null = scanStage === 'starting'
    ? 'cameraStarting'
    : scanStage === 'scanning' ? (isReceiver ? 'lookingForAnswer' : 'lookingForOffer') : status

  useEffect(() => () => {
    if (session.current) closeSession(session.current)
  }, [])

  function addMessage(lane: Lane, text: string) {
    const entry = { id: nextMessageId.current++, lane, text }
    setMessages((previous) => [...previous.slice(-49), entry])
  }

  function showFileUpdate(update: ReceiveUpdate | null) {
    if (!update) return
    if (update.status === 'ready') {
      setFileUpdate(null)
      setCompletedFiles((files) => [...files, update])
    } else {
      setFileUpdate(update)
    }
  }

  function end(active: Session, failure?: ConnectionFailure) {
    if (active.controller.signal.aborted) return
    closeSession(active)
    if (active.fileReceiver) showFileUpdate(active.fileReceiver.interrupt())
    setScanStage(null)
    setConnected(false)
    setEnded(true)
    setStatus(failure?.status ?? 'disconnected')
    setError(failure?.message ?? null)
  }

  function failConnection(active: Session, timedOut = false) {
    const iceState = active.peer.iceConnectionState
    if (active.channelOpened) {
      end(active, {
        status: 'connectionLost',
        message: 'reconnect',
      })
    } else if (active.iceConnected || iceState === 'connected' || iceState === 'completed') {
      end(active, {
        status: 'channelNotOpen',
        message: 'channelNotOpenHelp',
      })
    } else {
      end(active, {
        status: timedOut ? 'connectionTimedOut' : 'connectionFailed',
        message: { key: active.answerApplied ? 'noConnectionAfterAnswer' : 'noConnection', values: { state: iceState } },
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
      setError(null)
      setOpened(true)
      setConnected(true)
      setStatus('connected')
    }

    channel.addEventListener('open', onOpen, { signal })
    channel.addEventListener('message', (event) => {
      if (typeof event.data === 'string' && event.data.length <= messageLimit) {
        addMessage('received', event.data)
      } else if (event.data instanceof ArrayBuffer) {
        if (active.fileReceiver) showFileUpdate(active.fileReceiver.accept(event.data))
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
        if (!active.channelOpened) setStatus('openingChannel')
      }
    }, { signal })
    peer.addEventListener('connectionstatechange', () => {
      if (peer.connectionState === 'failed') {
        failConnection(active)
      } else if (peer.connectionState === 'disconnected' && active.channelOpened) {
        setConnected(false)
        setStatus('connectionInterrupted')
      } else if (peer.connectionState === 'connected' && active.channel?.readyState === 'open') {
        setConnected(true)
        setStatus('connected')
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
    setError(null)
    setBusy(true)

    let active = session.current
    let failureStatus: UiMessage = source === 'qr'
      ? (isReceiver ? 'invalidAnswerQr' : 'invalidOfferQr')
      : (isReceiver ? 'invalidAnswerText' : 'invalidOfferText')
    try {
      if (isReceiver && !localCode) {
        failureStatus = 'offerFailed'
        setStatus('creatingOffer')
        const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('')
        active = startSession(sessionId)
        setLocalCode(await createLocalCode(active.peer, 'offer', active.controller.signal, sessionId))
        setStatus('waitingForAnswer')
        return
      }

      const description = readDescription(code, isReceiver ? 'answer' : 'offer')
      if (source === 'qr' && !description.sessionId) {
        throw new AppError('missingPairingId')
      }

      if (isReceiver && active) {
        if (description.sessionId && description.sessionId !== active.sessionId) {
          throw new AppError('wrongAnswer')
        }
        failureStatus = 'answerApplyFailed'
        setStatus('applyingAnswer')
        try {
          await active.peer.setRemoteDescription(description)
        } catch {
          throw new AppError('answerApplyHelp')
        }
        if (active.controller.signal.aborted) return
        active.answerApplied = true
        setAnswerApplied(true)
        if (active.channel?.readyState !== 'open') {
          setStatus(active.iceConnected ? 'openingChannel' : 'checkingConnection')
          const pending = active
          pending.connectionTimer = window.setTimeout(() => failConnection(pending, true), 20_000)
        }
      } else if (!isReceiver) {
        failureStatus = 'offerApplyFailed'
        setStatus('applyingOffer')
        active = startSession(description.sessionId)
        try {
          await active.peer.setRemoteDescription(description)
        } catch {
          throw new AppError('offerApplyHelp')
        }
        if (active.controller.signal.aborted) return
        failureStatus = 'answerFailed'
        setStatus('creatingAnswer')
        setLocalCode(await createLocalCode(
          active.peer, 'answer', active.controller.signal, description.sessionId,
        ))
        setStatus('waitingForReceiver')
      }
    } catch (cause) {
      if (active?.controller.signal.aborted) return

      if (!localCode && session.current) {
        closeSession(session.current)
        session.current = null
      }
      setStatus(failureStatus)
      setError(errorMessage(cause, 'setupFailed'))
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
      setError(null)
    } catch {
      setError('messageFailed')
    }
  }

  async function transferFiles(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const active = session.current
    const channel = active?.channel
    if (!connected || !active || channel?.readyState !== 'open' || !selectedFiles.length || oversizedFile || sendingFile) {
      return
    }

    setSendingFile(true)
    setFileError(null)
    try {
      for (const [index, file] of selectedFiles.entries()) {
        setFileStatus({
          key: 'sendingFile', values: { index: index + 1, total: selectedFiles.length, name: file.name },
        })
        await sendFile(channel, file, active.controller.signal)
      }
      setFileStatus(selectedFiles.length === 1
        ? 'fileSent'
        : { key: 'filesSent', values: { count: selectedFiles.length } })
    } catch (cause) {
      setFileStatus(null)
      setFileError(active.controller.signal.aborted
        ? 'fileInterrupted'
        : errorMessage(cause, 'fileSendFailed'))
    } finally {
      setSendingFile(false)
    }
  }

  const showRemoteInput = isReceiver ? Boolean(localCode) && !answerApplied : !localCode
  const showExchange = !opened && !ended
  const showLocalCode = Boolean(localCode) && !answerApplied
  const canScan = window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia)
  const localLabel = isReceiver ? 'Offer' : 'Answer'
  const canDisconnect = opened && !ended

  return (
    <section className="card" aria-labelledby="connection-heading">
      <div className="card-heading">
        <h2 id="connection-heading">{t(isReceiver ? 'receiveWifi' : 'sendWifi')}</h2>
        <button className="secondary" type="button" onClick={() => {
          if (canDisconnect && session.current) end(session.current)
          else onReset()
        }}>
          {t(canDisconnect ? 'disconnect' : 'startOver')}
        </button>
      </div>
      <div role="status">{displayedStatus && <p className="status">{t(displayedStatus)}</p>}</div>
      {error && <p className="error" role="alert">{t(error)}</p>}

      {showExchange && (
        <>
          {isReceiver && !localCode && (
            <div className="pairing">
              <p>{t('createPairingCode')}</p>
              <button type="button" disabled={busy} onClick={() => void exchange('', 'text')}>
                {t('createOffer')}
              </button>
            </div>
          )}
          {!scanStage && showLocalCode && session.current?.sessionId && (
            <div className="pairing">
              <PairingHint device={isReceiver ? 'sending' : 'receiving'}>
                {isReceiver
                  ? t({ key: 'showOfferHint', values: { send: t('send'), scan: t('scanOffer') } })
                  : t({ key: 'showAnswerHint', values: { scan: t('scanAnswer') } })}
              </PairingHint>
              <PairingQr code={localCode} label={localLabel} />
            </div>
          )}
          {showRemoteInput && !isReceiver && canScan && (
            <PairingHint device="receiving">
              {t({ key: 'getOfferHint', values: { receive: t('receive'), create: t('createOffer') } })}
            </PairingHint>
          )}
          {showRemoteInput && (
            scanStage ? (
              <div className="pairing">
                <p>{t(isReceiver ? 'fitAnswer' : 'fitOffer')}</p>
                <QrCamera
                  decode={readQrCode}
                  onReady={() => setScanStage('scanning')}
                  onScan={(data) => void exchange(data, 'qr')}
                  onError={(message) => {
                    setScanStage(null)
                    setStatus(isReceiver ? 'answerScanFailed' : 'offerScanFailed')
                    setError(message)
                  }}
                />
                <button className="secondary" type="button" onClick={() => setScanStage(null)}>
                  {t('cancelScan')}
                </button>
              </div>
            ) : canScan ? (
              <div className="pairing">
                {isReceiver && <p>{t('scanAnswerHere')}</p>}
                <button type="button" disabled={busy} onClick={() => {
                  setError(null)
                  setStatus(isReceiver ? 'waitingForAnswer' : null)
                  setScanStage('starting')
                }}>
                  {t(isReceiver ? 'scanAnswer' : 'scanOffer')}
                </button>
              </div>
            ) : (
              <p>{t('useTextCodeInsecure')}</p>
            )
          )}
          {!scanStage && (showLocalCode || showRemoteInput) && (
            <details open={showRemoteInput && !canScan ? true : undefined}>
              <summary>{t('useTextCode')}</summary>
              <form className="manual-code" onSubmit={(event) => {
                event.preventDefault()
                void exchange(remoteCode, 'text')
              }}>
                {showLocalCode && <LocalCode code={localCode} label={localLabel} />}
                {showRemoteInput && (
                  <>
                    <label>
                      {t(isReceiver ? 'answerFromSender' : 'offerFromReceiver')}
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
                      {t(isReceiver ? 'applyAnswer' : 'createAnswer')}
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
            <ul className="messages" aria-label={t('messages')} aria-live="polite">
              {messages.map((entry) => (
                <li key={entry.id}>
                  <strong>{t(entry.lane === 'sent' ? 'you' : 'otherDevice')}</strong>
                  <span>{entry.text}</span>
                </li>
              ))}
            </ul>
          )}
          <form className="message-form" onSubmit={send}>
            <label>
              {t('message')}
              <input
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                maxLength={messageLimit}
                disabled={!connected}
              />
            </label>
            <button type="submit" disabled={!connected || !message.trim()}>{t('send')}</button>
          </form>
          {isReceiver ? (
            <ReceivedFiles update={fileUpdate} completed={completedFiles} />
          ) : (
            <form className="file-transfer" onSubmit={transferFiles} aria-labelledby="file-heading">
              <h2 id="file-heading">{t('sendFiles')}</h2>
              <label>
                {t('files')}
                <input
                  type="file"
                  multiple
                  aria-describedby="file-size-limit"
                  disabled={!connected || sendingFile}
                  onChange={(event) => {
                    const files = Array.from(event.currentTarget.files ?? [])
                    setSelectedFiles(files)
                    setFileStatus(null)
                    setFileError(null)
                  }}
                />
              </label>
              <p id="file-size-limit">{t({ key: 'fileLimit', values: { limit: fileLimitMiB } })}</p>
              {selectedFiles.length > 0 && (
                <ol className="file-list" aria-label={t('filesSendOrder')}>
                  {selectedFiles.map((file, index) => <li key={index}>{file.name}</li>)}
                </ol>
              )}
              <button type="submit" disabled={
                !connected || !selectedFiles.length || Boolean(oversizedFile) || sendingFile
              }>{t(selectedFiles.length > 1 ? 'sendFiles' : 'sendFile')}</button>
              <p role="status">{fileStatus && t(fileStatus)}</p>
              {displayedFileError && <p className="error" role="alert">{t(displayedFileError)}</p>}
            </form>
          )}
        </>
      )}
    </section>
  )
}

function PairingHint({ device, children }: { device: 'sending' | 'receiving'; children: string }) {
  const { t } = useLanguage()
  return (
    <div className="pairing-hint">
      <p className="pairing-hint-label">{t(device === 'sending' ? 'sendingDevice' : 'receivingDevice')}</p>
      <p>{children}</p>
    </div>
  )
}

function ReceivedFiles({ update, completed }: { update: ActiveFileUpdate | null; completed: CompletedFile[] }) {
  const { t } = useLanguage()
  return (
    <section className="file-transfer" aria-labelledby="file-heading">
      <h2 id="file-heading">{t('receiveFiles')}</h2>
      {!update && !completed.length && <p>{t('waitingForFiles')}</p>}
      {update?.status === 'interrupted' && <p className="error" role="alert">{t(update.message)}</p>}
      {update?.status === 'receiving' && <FileProgress update={update} />}
      {completed.length > 0 && (
        <ul className="file-list" aria-label={t('receivedFiles')}>
          {completed.map((file, index) => (
            <li key={index}><FileDownload name={file.name} blob={file.blob} /></li>
          ))}
        </ul>
      )}
    </section>
  )
}

function FileProgress({ update }: { update: Extract<ActiveFileUpdate, { status: 'receiving' }> }) {
  const { t } = useLanguage()
  const percent = update.size ? Math.floor((update.received * 100) / update.size) : 0
  return (
    <div className="file-progress">
      <p>{t({ key: 'receivingFile', values: { name: update.name, percent } })}</p>
      <progress aria-label={t('fileProgress')} value={update.received} max={update.size || 1} />
    </div>
  )
}

function LocalCode({ code, label }: { code: string; label: 'Offer' | 'Answer' }) {
  const { t } = useLanguage()
  const field = useRef<HTMLTextAreaElement>(null)
  const [copyStatus, setCopyStatus] = useState<UiMessage | null>(null)
  const copyLabel = label === 'Offer' ? 'copyOffer' : 'copyAnswer'
  const selectLabel = label === 'Offer' ? 'selectOffer' : 'selectAnswer'

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopyStatus('copied')
    } catch {
      field.current?.focus()
      field.current?.select()
      setCopyStatus('selectedCopy')
    }
  }

  return (
    <div className="code">
      <label>
        {t(label === 'Offer' ? 'offerCode' : 'answerCode')}
        <textarea ref={field} readOnly value={code} rows={4} spellCheck={false} />
      </label>
      <div className="actions">
        <button className="secondary" type="button" onClick={copy}>
          {t(navigator.clipboard ? copyLabel : selectLabel)}
        </button>
        <span role="status">{copyStatus && t(copyStatus)}</span>
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
