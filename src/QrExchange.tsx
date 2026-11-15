import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type QrScanner from 'qr-scanner'
import { makeQrImage, readQrCode } from './qr'

export function PairingQr({ code, label }: { code: string; label: 'Offer' | 'Answer' }) {
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

  if (failed) return <p>Could not show a QR code. Use the text code instead.</p>
  if (!image) return <p role="status">Creating QR code…</p>

  return <img className="pairing-qr" src={image} alt={`${label} QR code`} />
}

export function QrCamera({
  onScan,
  onError,
}: {
  onScan: (data: string) => void
  onError: (message: string) => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const handleScan = useEffectEvent(onScan)
  const handleError = useEffectEvent(onError)

  useEffect(() => {
    let disposed = false
    let accepted = false
    let scanner: QrScanner | undefined

    async function start() {
      try {
        const { default: Scanner } = await import('qr-scanner')
        if (disposed || !video.current) return
        scanner = new Scanner(video.current, ({ data }) => {
          if (disposed || accepted) return
          accepted = true
          void readQrCode(data).then(
            (code) => { if (!disposed) handleScan(code) },
            (error: Error) => { if (!disposed) handleError(error.message) },
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
      } catch {
        if (!disposed) handleError('Could not start the camera. Check camera permissions or use a text code.')
      }
    }

    void start()
    return () => {
      disposed = true
      scanner?.destroy()
    }
  }, [])

  return (
    <div className="camera-preview">
      <video ref={video} autoPlay muted playsInline aria-label="Camera preview" />
    </div>
  )
}
