import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type QrScanner from 'qr-scanner'
import { useLanguage } from './LanguageProvider'
import { errorMessage } from './i18n'
import type { Message } from './i18n'
import { makeQrImage } from './qr'

export async function prepareQrCamera(): Promise<void> {
  // Load the fallback decoder even when the browser has a native detector.
  await Promise.all([import('qr-scanner'), import('qr-scanner/qr-scanner-worker.min.js')])
}

export function PairingQr({ code, label }: { code: string; label: 'Offer' | 'Answer' }) {
  const { t } = useLanguage()
  const [image, setImage] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let disposed = false
    makeQrImage(code).then(
      (result) => { if (!disposed) setImage(result) },
      () => { if (!disposed) setFailed(true) },
    )
    return () => { disposed = true }
  }, [code])

  if (failed) return <p>{t('pairingQrUnavailable')}</p>
  if (!image) return <p role="status">{t('creatingQr')}</p>

  return <img className="pairing-qr" src={image} alt={t(label === 'Offer' ? 'offerQr' : 'answerQr')} />
}

export function QrCamera({
  continuous = false,
  decode,
  onReady,
  onScan,
  onError,
}: {
  continuous?: boolean
  decode?: (data: string) => Promise<string>
  onReady: () => void
  onScan: (data: string) => void
  onError: (message: Message) => void
}) {
  const { t } = useLanguage()
  const video = useRef<HTMLVideoElement>(null)
  const handleReady = useEffectEvent(onReady)
  const handleScan = useEffectEvent(onScan)
  const handleError = useEffectEvent(onError)

  useEffect(() => {
    let disposed = false
    let accepted = false
    let lastCode: string | undefined
    let scanner: QrScanner | undefined

    async function start() {
      try {
        const { default: Scanner } = await import('qr-scanner')
        if (disposed || !video.current) return
        scanner = new Scanner(video.current, ({ data }) => {
          if (disposed || accepted || data === lastCode) return
          accepted = !continuous
          lastCode = data
          if (!decode) {
            handleScan(data)
            return
          }
          void decode(data).then(
            (code) => { if (!disposed) handleScan(code) },
            (cause: unknown) => { if (!disposed) handleError(errorMessage(cause, 'invalidPairingQr')) },
          )
        }, {
          preferredCamera: 'environment',
          returnDetailedScanResult: true,
          highlightScanRegion: true,
          maxScansPerSecond: 8,
          // Keep more detail in dense pairing codes than the scanner's 400px default.
          calculateScanRegion: (frame) => {
            const size = Math.round(Math.min(frame.videoWidth, frame.videoHeight) * 0.8)
            const scanSize = Math.min(size, 800)
            return {
              x: Math.round((frame.videoWidth - size) / 2),
              y: Math.round((frame.videoHeight - size) / 2),
              width: size,
              height: size,
              downScaledWidth: scanSize,
              downScaledHeight: scanSize,
            }
          },
        })
        await scanner.start()
        if (!disposed && !accepted) handleReady()
      } catch {
        if (!disposed) handleError('cameraFailed')
      }
    }

    void start()
    return () => {
      disposed = true
      scanner?.destroy()
    }
  }, [continuous, decode])

  return (
    <div className="camera-preview">
      <video ref={video} autoPlay muted playsInline aria-label={t('cameraPreview')} />
    </div>
  )
}
