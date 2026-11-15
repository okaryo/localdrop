import { ArrowDown, ArrowUp, ExternalLink, Languages, LoaderCircle, QrCode, Wifi } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { FileDownload } from './FileDownload'
import { useLanguage } from './LanguageProvider'
import { PairingQr, QrCamera } from './QrExchange'
import { QrFiles } from './QrFiles'
import { advertisesLargeFiles, FileReceiver, maxFileSize, sendFile, sendLargeFile } from './fileTransfer'
import type { ReceiveUpdate } from './fileTransfer'
import { AppError, errorMessage } from './i18n'
import type { Message as UiMessage } from './i18n'
import { readQrCode } from './qr'
import { useScreenWakeLock } from './useScreenWakeLock'
import { createLocalCode, maxCodeLength, readDescription } from './webrtc'

type Role = 'receiver' | 'sender'
type ScanStage = 'starting' | 'scanning'
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

const fileLimitMiB = maxFileSize / (1024 * 1024)

export function App() {
  const { t } = useLanguage()
  const [role, setRole] = useState<Role | null>(null)
  const [qrFiles, setQrFiles] = useState(false)
  const supported = typeof RTCPeerConnection === 'function'
  const isHome = !role && !qrFiles

  return (
    <main className={isHome ? 'shell home-shell' : 'shell transfer-shell'}>
      <header>
        <div className="app-heading">
          <a
            className="brand"
            href={import.meta.env.BASE_URL}
            aria-label={t('homeLink')}
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
              event.preventDefault()
              setRole(null)
              setQrFiles(false)
              window.scrollTo(0, 0)
            }}
          >
            <img src={`${import.meta.env.BASE_URL}icon.png`} width={44} height={44} alt="" />
            <h1>LocalDrop</h1>
          </a>
          <LanguagePicker />
        </div>
        {isHome && <p className="tagline">{t('tagline')}</p>}
      </header>
      {qrFiles ? (
        <QrFiles onBack={() => setQrFiles(false)} />
      ) : role ? (
        <Connection role={role} onReset={() => setRole(null)} />
      ) : (
        <div className="mode-grid">
          <section className="card mode-card wifi-mode" aria-labelledby="device-heading">
            <div className="mode-icon"><Wifi size={25} aria-hidden="true" /></div>
            <h2 id="device-heading">{t('wifiTransfer')}</h2>
            {supported ? (
              <>
                <p className="mode-description">{t('wifiModeDescription')}</p>
                <p className="mode-note">{t('wifiStart')}</p>
                <div className="actions mode-actions">
                  <button onClick={() => setRole('receiver')}>
                    <ArrowDown size={17} aria-hidden="true" />
                    {t('receive')}
                  </button>
                  <button className="secondary" onClick={() => setRole('sender')}>
                    <ArrowUp size={17} aria-hidden="true" />
                    {t('send')}
                  </button>
                </div>
              </>
            ) : (
              <p role="alert">{t('unsupportedWebrtc')}</p>
            )}
          </section>
          <section className="card mode-card qr-mode" aria-labelledby="qr-heading">
            <div className="mode-icon"><QrCode size={25} aria-hidden="true" /></div>
            <h2 id="qr-heading">{t('transferByQr')}</h2>
            <p className="mode-description">{t('qrIntro')}</p>
            <div className="actions mode-actions">
              <button className="secondary" onClick={() => setQrFiles(true)}>{t('qrFileTransfer')}</button>
            </div>
          </section>
        </div>
      )}
      <footer className="app-footer">
        <p>{t('trademark')}</p>
        <a href="https://github.com/okaryo/localdrop" target="_blank" rel="noreferrer">
          {t('repository')}
          <ExternalLink size={15} aria-hidden="true" />
        </a>
      </footer>
    </main>
  )
}

function LanguagePicker() {
  const { language, setLanguage, t } = useLanguage()
  const [pointerFocus, setPointerFocus] = useState(false)

  return (
    <div className="language-control">
      <Languages size={17} aria-hidden="true" />
      <select
        className="language-select"
        aria-label={t('language')}
        data-pointer-focus={pointerFocus || undefined}
        value={language}
        onPointerDown={() => setPointerFocus(true)}
        onKeyDown={() => setPointerFocus(false)}
        onBlur={() => setPointerFocus(false)}
        onChange={(event) => setLanguage(event.currentTarget.value === 'ja' ? 'ja' : 'en')}
      >
        <option value="en" lang="en">English</option>
        <option value="ja" lang="ja">日本語</option>
      </select>
    </div>
  )
}

function Connection({ role, onReset }: { role: Role; onReset: () => void }) {
  const { t } = useLanguage()
  const isReceiver = role === 'receiver'
  const session = useRef<Session | null>(null)
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
  const [canSendLargeFiles, setCanSendLargeFiles] = useState(false)
  const [fileUpdate, setFileUpdate] = useState<ActiveFileUpdate | null>(null)
  const [completedFiles, setCompletedFiles] = useState<CompletedFile[]>([])
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [sendingFile, setSendingFile] = useState(false)
  const [fileStatus, setFileStatus] = useState<UiMessage | null>(null)
  const [fileError, setFileError] = useState<UiMessage | null>(null)
  const oversizedFile = canSendLargeFiles ? undefined : selectedFiles.find((file) => file.size > maxFileSize)
  const displayedFileError: UiMessage | null = fileError ?? (oversizedFile
    ? { key: 'fileTooLarge', values: { name: oversizedFile.name, limit: fileLimitMiB } }
    : null)
  const displayedStatus: UiMessage | null = scanStage === 'starting'
    ? 'cameraStarting'
    : scanStage === 'scanning' ? (isReceiver ? 'lookingForAnswer' : 'lookingForOffer') : status

  useScreenWakeLock(connected && (sendingFile || fileUpdate?.status === 'receiving'))

  useEffect(() => () => {
    const active = session.current
    session.current = null
    if (active) closeSession(active)
  }, [])

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
    showFileUpdate(closeSession(active))
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
    if (isReceiver) {
      active.fileReceiver = new FileReceiver(channel, (update) => {
        if (session.current === active) showFileUpdate(update)
      })
    }

    function onOpen() {
      if (active.channelOpened) return
      active.channelOpened = true
      window.clearTimeout(active.connectionTimer)
      setError(null)
      setOpened(true)
      setConnected(true)
      setStatus('connected')
      active.fileReceiver?.advertise()
    }

    channel.addEventListener('open', onOpen, { signal })
    channel.addEventListener('message', (event) => {
      if (!(event.data instanceof ArrayBuffer)) return
      if (active.fileReceiver) showFileUpdate(active.fileReceiver.accept(event.data))
      else if (advertisesLargeFiles(event.data)) setCanSendLargeFiles(true)
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
      fileReceiver: null,
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

  async function transferFiles(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const active = session.current
    const channel = active?.channel
    if (!connected || !active || channel?.readyState !== 'open' || !selectedFiles.length || oversizedFile || sendingFile) {
      return
    }

    setSendingFile(true)
    setFileError(null)
    let skipped = 0
    try {
      for (const [index, file] of selectedFiles.entries()) {
        const sendingStatus = {
          key: 'sendingFile', values: { index: index + 1, total: selectedFiles.length, name: file.name },
        } as const
        if (file.size > maxFileSize) {
          setFileStatus({ key: 'waitingForFileDestination', values: { name: file.name } })
          const saved = await sendLargeFile(channel, file, active.controller.signal, () => setFileStatus(sendingStatus))
          if (!saved) skipped++
        } else {
          setFileStatus(sendingStatus)
          await sendFile(channel, file, active.controller.signal)
        }
      }
      if (skipped) {
        setFileStatus({ key: 'filesSentWithSkipped', values: { sent: selectedFiles.length - skipped, skipped } })
      } else {
        setFileStatus(selectedFiles.length === 1
          ? 'fileSent'
          : { key: 'filesSent', values: { count: selectedFiles.length } })
      }
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
  const showConnected = displayedStatus === 'connected'

  return (
    <section className="card" aria-labelledby="connection-heading">
      <div className={showConnected ? 'connection-heading is-connected' : 'connection-heading'}>
        <h2 id="connection-heading">{t(isReceiver ? 'receiveWifi' : 'sendWifi')}</h2>
        <button className="secondary" type="button" onClick={() => {
          if (canDisconnect && session.current) end(session.current)
          else onReset()
        }}>
          {t(canDisconnect ? 'disconnect' : 'startOver')}
        </button>
        <div className="connection-status" role="status">
          {displayedStatus && <p className={showConnected ? 'connected-badge' : undefined}>{t(displayedStatus)}</p>}
        </div>
      </div>
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
          {isReceiver ? (
            <ReceivedFiles
              update={fileUpdate}
              completed={completedFiles}
              onChooseDestination={() => void session.current?.fileReceiver?.chooseDestination()}
              onDecline={() => session.current?.fileReceiver?.decline()}
            />
          ) : (
            <form className="file-transfer" onSubmit={transferFiles} aria-labelledby="file-heading">
              <h3 id="file-heading">{t('sendFiles')}</h3>
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
              <p id="file-size-limit">{t({
                key: canSendLargeFiles ? 'largeFileLimitHint' : 'fileLimit', values: { limit: fileLimitMiB },
              })}</p>
              {selectedFiles.length > 0 && (
                <ol className="file-list" aria-label={t('filesSendOrder')}>
                  {selectedFiles.map((file, index) => <li key={index}>{file.name}</li>)}
                </ol>
              )}
              <button type="submit" disabled={
                !connected || !selectedFiles.length || Boolean(oversizedFile) || sendingFile
              }>{t(selectedFiles.length > 1 ? 'sendFiles' : 'sendFile')}</button>
              <p className="file-send-status" role="status">
                {sendingFile && <LoaderCircle className="file-send-spinner" size={18} aria-hidden="true" />}
                {fileStatus && <span>{t(fileStatus)}</span>}
              </p>
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

function ReceivedFiles({ update, completed, onChooseDestination, onDecline }: {
  update: ActiveFileUpdate | null
  completed: CompletedFile[]
  onChooseDestination: () => void
  onDecline: () => void
}) {
  const { language, t } = useLanguage()
  return (
    <section className="file-transfer" aria-labelledby="file-heading">
      <h3 id="file-heading">{t('receiveFiles')}</h3>
      {!update && !completed.length && <p>{t('waitingForFiles')}</p>}
      {update?.status === 'interrupted' && <p className="error" role="alert">{t(update.message)}</p>}
      {update?.status === 'offered' && (
        <>
          <p role="status">{t({ key: 'largeFileOffer', values: {
            name: update.name, size: new Intl.NumberFormat(language, { maximumFractionDigits: 2 })
              .format(update.size / (1024 * 1024)),
          } })}</p>
          <div className="actions">
            <button type="button" disabled={update.choosing} onClick={onChooseDestination}>{t('chooseFileDestination')}</button>
            <button className="secondary" type="button" disabled={update.choosing} onClick={onDecline}>{t('skipFile')}</button>
          </div>
        </>
      )}
      {update?.status === 'receiving' && <FileProgress update={update} />}
      {completed.length > 0 && (
        <ul className="file-list" aria-label={t('receivedFiles')}>
          {completed.map((file, index) => (
            <li key={index}>
              {file.blob ? <FileDownload name={file.name} blob={file.blob} /> : (
                <span role="status">{t({ key: 'savedFile', values: { name: file.name } })}</span>
              )}
            </li>
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
  const interrupted = active.fileReceiver?.interrupt() ?? null
  active.controller.abort()
  window.clearTimeout(active.connectionTimer)
  active.channel?.close()
  active.peer.close()
  return interrupted
}
