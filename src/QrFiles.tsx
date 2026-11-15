import { useEffect, useRef, useState } from 'react'
import { FileDownload } from './FileDownload'
import { prepareQrCamera, QrCamera } from './QrExchange'
import { renderQrImage } from './qr'
import { maxQrFileSize, readQrFilePart, restoreQrFile, splitQrFile } from './qrFile'
import type { QrFile } from './qrFile'

type Parts = { digest: string; total: number; data: Map<number, Uint8Array<ArrayBuffer>> }

export function QrFiles({ onBack }: { onBack: () => void }) {
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
        <h2 id="qr-files-heading">QR file transfer</h2>
        <button className="secondary" type="button" onClick={role ? () => setRole(null) : onBack}>
          Back
        </button>
      </div>
      {!supported ? (
        <p role="alert">QR file transfer needs HTTPS or localhost. Open LocalDrop over a secure connection.</p>
      ) : preparation === 'failed' ? (
        <p role="alert">Could not prepare the QR reader. Reload this page while online.</p>
      ) : preparation === 'loading' ? (
        <p role="status">Preparing offline transfer…</p>
      ) : role === 'send' ? (
        <SendByQr />
      ) : role === 'receive' ? (
        <ReceiveByQr />
      ) : (
        <>
          <p role="status">Ready for offline transfer. Keep this page open on both devices.</p>
          <div className="actions">
            <button type="button" onClick={() => setRole('send')}>Send by QR</button>
            <button className="secondary" type="button" onClick={() => setRole('receive')}>Receive by QR</button>
          </div>
        </>
      )}
    </section>
  )
}

function SendByQr() {
  const [images, setImages] = useState<string[]>([])
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function selectFile(file: File) {
    setImages([])
    setIndex(0)
    setError('')
    setBusy(true)
    try {
      const parts = await splitQrFile(file)
      setImages(await Promise.all(parts.map(renderQrImage)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not prepare the file QR codes.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <label>
        File up to {maxQrFileSize / 1024} KiB
        <input
          type="file"
          disabled={busy}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            if (file) void selectFile(file)
          }}
        />
      </label>
      {busy && <p role="status">Preparing file QR codes…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {images.length > 0 && (
        <div className="pairing">
          <p role="status">QR code {index + 1} of {images.length}</p>
          <img className="pairing-qr" src={images[index]} alt={`File QR code ${index + 1}`} />
          {images.length > 1 && (
            <>
              <p>Show the next code after the receiver scans this one.</p>
              <div className="actions">
                <button className="secondary" type="button" disabled={index === 0} onClick={() => setIndex(index - 1)}>
                  Previous code
                </button>
                <button type="button" disabled={index === images.length - 1} onClick={() => setIndex(index + 1)}>
                  Next code
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
  const incoming = useRef<Parts | null>(null)
  const [scan, setScan] = useState<'starting' | 'scanning' | null>(null)
  const [missing, setMissing] = useState<number[]>([])
  const [total, setTotal] = useState(0)
  const [file, setFile] = useState<QrFile | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState('')

  function reset() {
    incoming.current = null
    setMissing([])
    setTotal(0)
    setFile(null)
    setError('')
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
        setError('This code is for a different file. Continue with the current file or start over.')
        return
      }
      setError('')
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
      setError(cause instanceof Error ? cause.message : 'Could not read the file QR code.')
    }
  }

  return (
    <>
      {total > 0 && (
        <div className="pairing" role="status">
          <p>{total - missing.length} of {total} QR codes scanned</p>
          {missing.length > 0 && <p>Still needed: {missing.join(', ')}</p>}
        </div>
      )}
      {scan ? (
        <div className="pairing">
          <p role="status">{scan === 'starting' ? 'Starting camera…' : 'Keep each QR code inside the camera guide.'}</p>
          <QrCamera
            continuous
            onReady={() => setScan('scanning')}
            onScan={(data) => void accept(data)}
            onError={(message) => {
              setScan(null)
              setError(message)
            }}
          />
          <button className="secondary" type="button" onClick={() => setScan(null)}>Pause scan</button>
        </div>
      ) : verifying ? (
        <p role="status">Verifying file…</p>
      ) : file ? (
        <FileDownload name={file.name} blob={file.blob} />
      ) : (
        <button type="button" onClick={() => {
          setError('')
          setScan('starting')
        }}>{total ? 'Resume scan' : 'Scan file QR codes'}</button>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {total > 0 && !verifying && (
        <button className="secondary" type="button" onClick={() => {
          setScan(null)
          reset()
        }}>Start over</button>
      )}
    </>
  )
}
