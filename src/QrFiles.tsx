import { useEffect, useRef, useState } from 'react'
import { FileDownload } from './FileDownload'
import { useLanguage } from './LanguageProvider'
import { prepareQrCamera, QrCamera } from './QrExchange'
import { errorMessage } from './i18n'
import type { Message } from './i18n'
import { renderQrImage } from './qr'
import { maxQrFileSize, readQrFilePart, restoreQrFile, splitQrFile } from './qrFile'
import type { QrFile } from './qrFile'

type Parts = { digest: string; total: number; data: Map<number, Uint8Array<ArrayBuffer>> }

export function QrFiles({ onBack }: { onBack: () => void }) {
  const { t } = useLanguage()
  const [role, setRole] = useState<'send' | 'receive' | null>(null)
  const [preparation, setPreparation] = useState<'loading' | 'ready' | 'failed'>('loading')
  const supported = window.isSecureContext && Boolean(crypto.subtle)

  useEffect(() => {
    if (!supported) return
    let disposed = false
    prepareQrCamera().then(
      () => { if (!disposed) setPreparation('ready') },
      () => { if (!disposed) setPreparation('failed') },
    )
    return () => { disposed = true }
  }, [supported])

  return (
    <section className="card" aria-labelledby="qr-files-heading">
      <div className="card-heading">
        <h2 id="qr-files-heading">{t('qrFileTransfer')}</h2>
        <button className="secondary" type="button" onClick={role ? () => setRole(null) : onBack}>
          {t('back')}
        </button>
      </div>
      {!supported ? (
        <p role="alert">{t('qrSecureContext')}</p>
      ) : preparation === 'failed' ? (
        <p role="alert">{t('qrPreparationFailed')}</p>
      ) : preparation === 'loading' ? (
        <p role="status">{t('preparingOffline')}</p>
      ) : role === 'send' ? (
        <SendByQr />
      ) : role === 'receive' ? (
        <ReceiveByQr />
      ) : (
        <>
          <p role="status">{t('offlineReady')}</p>
          <div className="actions">
            <button type="button" onClick={() => setRole('send')}>{t('sendByQr')}</button>
            <button className="secondary" type="button" onClick={() => setRole('receive')}>{t('receiveByQr')}</button>
          </div>
        </>
      )}
    </section>
  )
}

function SendByQr() {
  const { t } = useLanguage()
  const [images, setImages] = useState<string[]>([])
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Message | null>(null)

  async function selectFile(file: File) {
    setImages([])
    setIndex(0)
    setError(null)
    setBusy(true)
    try {
      const parts = await splitQrFile(file)
      setImages(await Promise.all(parts.map(renderQrImage)))
    } catch (cause) {
      setError(errorMessage(cause, 'qrFilePrepareFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <label>
        {t({ key: 'qrFileLimit', values: { limit: maxQrFileSize / 1024 } })}
        <input
          type="file"
          disabled={busy}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            if (file) void selectFile(file)
          }}
        />
      </label>
      {busy && <p role="status">{t('preparingQrFiles')}</p>}
      {error && <p className="error" role="alert">{t(error)}</p>}
      {images.length > 0 && (
        <div className="pairing">
          <p role="status">{t({ key: 'qrFilePosition', values: { index: index + 1, total: images.length } })}</p>
          <img className="pairing-qr" src={images[index]} alt={t({ key: 'fileQrAlt', values: { index: index + 1 } })} />
          {images.length > 1 && (
            <>
              <p>{t('advanceQr')}</p>
              <div className="actions">
                <button className="secondary" type="button" disabled={index === 0} onClick={() => setIndex(index - 1)}>
                  {t('previousQr')}
                </button>
                <button type="button" disabled={index === images.length - 1} onClick={() => setIndex(index + 1)}>
                  {t('nextQr')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  )
}

function ReceiveByQr() {
  const { t } = useLanguage()
  const incoming = useRef<Parts | null>(null)
  const [scan, setScan] = useState<'starting' | 'scanning' | null>(null)
  const [missing, setMissing] = useState<number[]>([])
  const [total, setTotal] = useState(0)
  const [file, setFile] = useState<QrFile | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState<Message | null>(null)

  function reset() {
    incoming.current = null
    setMissing([])
    setTotal(0)
    setFile(null)
    setError(null)
  }

  async function accept(code: string) {
    if (incoming.current && incoming.current.data.size === incoming.current.total) return
    try {
      const part = readQrFilePart(code)
      const transfer = incoming.current ?? {
        digest: part.digest,
        total: part.total,
        data: new Map<number, Uint8Array<ArrayBuffer>>(),
      }
      if (transfer.digest !== part.digest || transfer.total !== part.total) {
        setError('otherFileQr')
        return
      }
      setError(null)
      if (transfer.data.has(part.number)) return
      incoming.current = transfer
      transfer.data.set(part.number, part.bytes)
      setTotal(transfer.total)
      setMissing(
        Array.from({ length: transfer.total }, (_, index) => index + 1)
          .filter((number) => !transfer.data.has(number)),
      )
      if (transfer.data.size < transfer.total) return

      setScan(null)
      setVerifying(true)
      try {
        setFile(await restoreQrFile(transfer.digest, transfer.data))
      } catch (cause) {
        reset()
        throw cause
      } finally {
        incoming.current = null
        setVerifying(false)
      }
    } catch (cause) {
      setError(errorMessage(cause, 'fileQrReadFailed'))
    }
  }

  return (
    <>
      {total > 0 && (
        <div className="pairing" role="status">
          <p>{t({ key: 'qrCodesScanned', values: { count: total - missing.length, total } })}</p>
          {missing.length > 0 && <p>{t({ key: 'missingQrCodes', values: { numbers: missing.join(', ') } })}</p>}
        </div>
      )}
      {scan ? (
        <div className="pairing">
          <p role="status">{t(scan === 'starting' ? 'cameraStarting' : 'fitFileQr')}</p>
          <QrCamera
            continuous
            onReady={() => setScan('scanning')}
            onScan={(data) => void accept(data)}
            onError={(message) => {
              setScan(null)
              setError(message)
            }}
          />
          <button className="secondary" type="button" onClick={() => setScan(null)}>{t('pauseScan')}</button>
        </div>
      ) : verifying ? (
        <p role="status">{t('verifyingFile')}</p>
      ) : file ? (
        <FileDownload name={file.name} blob={file.blob} />
      ) : (
        <button type="button" onClick={() => {
          setError(null)
          setScan('starting')
        }}>{t(total ? 'resumeScan' : 'scanFileQr')}</button>
      )}
      {error && <p className="error" role="alert">{t(error)}</p>}
      {total > 0 && !verifying && (
        <button className="secondary" type="button" onClick={() => {
          setScan(null)
          reset()
        }}>{t('startOver')}</button>
      )}
    </>
  )
}
