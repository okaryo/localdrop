export const maxFileSize = 25 * 1024 * 1024
const chunkSize = 16 * 1024 - 1
const maxMetadataSize = 4096
const bufferLimit = 512 * 1024
const lowBuffer = 128 * 1024

// Binary frames carry files. Plain strings on the same channel are chat messages.
const frameType = { start: 1, chunk: 2, finish: 3, abort: 4 } as const

type FileMetadata = { name: string; size: number }
type IncomingFile = FileMetadata & { chunks: Uint8Array<ArrayBuffer>[]; received: number }
export type ReceiveUpdate =
  | { status: 'receiving'; name: string; size: number; received: number }
  | { status: 'ready'; name: string; blob: Blob }
  | { status: 'interrupted'; message: string }

function makeFrame(type: number, payload?: Uint8Array): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(1 + (payload?.byteLength ?? 0))
  frame[0] = type
  if (payload) frame.set(payload, 1)
  return frame
}

function waitForBuffer(channel: RTCDataChannel, threshold: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (channel.bufferedAmount <= threshold) return Promise.resolve()

  channel.bufferedAmountLowThreshold = threshold
  return new Promise((resolve, reject) => {
    function cleanup() {
      channel.removeEventListener('bufferedamountlow', onLow)
      signal.removeEventListener('abort', onAbort)
    }
    function onLow() {
      cleanup()
      resolve()
    }
    function onAbort() {
      cleanup()
      reject(signal.reason)
    }

    channel.addEventListener('bufferedamountlow', onLow)
    signal.addEventListener('abort', onAbort, { once: true })
    if (channel.bufferedAmount <= threshold) onLow()
  })
}

export async function sendFile(channel: RTCDataChannel, file: File, signal: AbortSignal): Promise<void> {
  if (file.size > maxFileSize) throw new Error('Choose a file up to 25 MiB.')

  const metadata = new TextEncoder().encode(JSON.stringify({ name: file.name, size: file.size }))
  if (metadata.byteLength > maxMetadataSize) throw new Error('The file name is too long.')

  signal.throwIfAborted()
  channel.send(makeFrame(frameType.start, metadata))
  try {
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      if (channel.bufferedAmount >= bufferLimit) await waitForBuffer(channel, lowBuffer, signal)
      signal.throwIfAborted()
      const chunk = await file.slice(offset, offset + chunkSize).arrayBuffer()
      signal.throwIfAborted()
      channel.send(makeFrame(frameType.chunk, new Uint8Array(chunk)))
    }
    channel.send(makeFrame(frameType.finish))
    await waitForBuffer(channel, 0, signal)
  } catch (error) {
    if (!signal.aborted && channel.readyState === 'open') {
      try {
        channel.send(makeFrame(frameType.abort))
      } catch {
        // Closing the connection also discards an incomplete transfer.
        channel.close()
      }
    }
    throw error
  }
}

export class FileReceiver {
  private active: IncomingFile | null = null

  accept(frame: ArrayBuffer): ReceiveUpdate | null {
    const bytes = new Uint8Array(frame)
    switch (bytes[0]) {
      case frameType.start: {
        const metadata = readMetadata(bytes.subarray(1))
        if (!metadata) {
          this.active = null
          return { status: 'interrupted', message: 'Could not accept the file information.' }
        }
        this.active = { ...metadata, chunks: [], received: 0 }
        return { status: 'receiving', ...metadata, received: 0 }
      }
      case frameType.chunk: {
        const file = this.active
        if (!file) return null
        const chunk = bytes.subarray(1)
        const received = file.received + chunk.byteLength
        if (chunk.byteLength === 0 || chunk.byteLength > chunkSize || received > file.size) {
          return this.interrupt('The incoming file data did not match the expected size.')
        }
        file.chunks.push(chunk)
        const previousPercent = Math.floor((file.received * 100) / file.size)
        file.received = received
        if (Math.floor((received * 100) / file.size) === previousPercent) return null
        return { status: 'receiving', name: file.name, size: file.size, received }
      }
      case frameType.finish: {
        const file = this.active
        if (!file) return null
        if (file.received !== file.size || bytes.byteLength !== 1) {
          return this.interrupt('The file ended before all its data arrived.')
        }
        this.active = null
        return { status: 'ready', name: file.name, blob: new Blob(file.chunks) }
      }
      case frameType.abort:
        return this.interrupt('File transfer interrupted.')
      default:
        return null
    }
  }

  interrupt(message = 'File transfer interrupted.'): ReceiveUpdate | null {
    if (!this.active) return null
    this.active = null
    return { status: 'interrupted', message }
  }
}

function readMetadata(bytes: Uint8Array): FileMetadata | null {
  if (bytes.byteLength > maxMetadataSize) return null

  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (
      typeof value === 'object' && value !== null &&
      'name' in value && typeof value.name === 'string' && value.name.length > 0 &&
      'size' in value && typeof value.size === 'number' && Number.isSafeInteger(value.size) &&
      value.size >= 0 && value.size <= maxFileSize
    ) {
      return { name: value.name, size: value.size }
    }
  } catch {
    return null
  }
  return null
}
