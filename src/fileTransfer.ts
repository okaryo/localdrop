import { AppError } from './i18n'
import type { Message } from './i18n'

export const maxFileSize = 25 * 1024 * 1024
const chunkSize = 16 * 1024 - 1
const maxMetadataSize = 4096
const bufferLimit = 512 * 1024
const lowBuffer = 128 * 1024
const legacyWriteWindow = 32 * chunkSize
const wideWriteWindow = 128 * chunkSize
const writeBatchSize = 16 * chunkSize

// The original frames still work with older peers for files up to 25 MiB.
const frameType = {
  start: 1, chunk: 2, finish: 3, abort: 4,
  canSave: 5, offer: 6, accepted: 7, declined: 8, written: 9, saved: 10, failed: 11,
  acceptedWideWindow: 12,
} as const

type FileMetadata = { name: string; size: number }
type MemoryFile = FileMetadata & { mode: 'memory'; chunks: Uint8Array<ArrayBuffer>[]; received: number }
type OfferedFile = FileMetadata & { mode: 'offer'; id: number; wideWindow: boolean; choosing: boolean }
type DiskFile = FileMetadata & {
  mode: 'disk'
  id: number
  writer: WritableStreamDefaultWriter
  queued: number
  received: number
  writeWindow: number
  windowEnd: number
  batch: Uint8Array<ArrayBuffer> | null
  saving: boolean
}

type SavePicker = (options: { suggestedName: string; startIn: 'downloads' }) => Promise<FileSystemFileHandle>

export type ReceiveUpdate =
  | { status: 'offered'; name: string; size: number; choosing: boolean }
  | { status: 'receiving'; name: string; size: number; received: number }
  | { status: 'ready'; name: string; blob?: Blob }
  | { status: 'interrupted'; message: Message }

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
  if (file.size > maxFileSize) throw new AppError({ key: 'selectSmallerFile', values: { limit: maxFileSize / (1024 * 1024) } })

  const metadata = new TextEncoder().encode(JSON.stringify({ name: file.name, size: file.size }))
  if (metadata.byteLength > maxMetadataSize) throw new AppError('fileNameTooLong')

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
    if (!signal.aborted) sendControl(channel, frameType.abort)
    throw error
  }
}

export function advertisesLargeFiles(frame: ArrayBuffer): boolean {
  return frame.byteLength === 1 && new Uint8Array(frame)[0] === frameType.canSave
}

function sendControl(channel: RTCDataChannel, type: number, id?: number) {
  if (channel.readyState !== 'open') return
  const frame = new Uint8Array(id === undefined ? 1 : 5)
  frame[0] = type
  if (id !== undefined) new DataView(frame.buffer).setUint32(1, id)
  try {
    channel.send(frame)
  } catch {
    // Closing the channel also tells the peer to discard an incomplete transfer.
    channel.close()
  }
}

function waitForFileReply(
  channel: RTCDataChannel, signal: AbortSignal, id: number, expected: number, send: () => void,
): Promise<number> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    function cleanup() {
      channel.removeEventListener('message', onMessage)
      signal.removeEventListener('abort', onAbort)
    }
    function onAbort() {
      cleanup()
      reject(signal.reason)
    }
    function onMessage(event: MessageEvent) {
      if (!(event.data instanceof ArrayBuffer) || event.data.byteLength !== 5) return
      const reply = new DataView(event.data)
      if (reply.getUint32(1) !== id) return
      const type = reply.getUint8(0)
      if (type === expected || (expected === frameType.accepted &&
        (type === frameType.declined || type === frameType.acceptedWideWindow))) {
        cleanup()
        resolve(type)
      } else if (type === frameType.failed) {
        cleanup()
        reject(new AppError('remoteFileSaveFailed'))
      }
    }

    channel.addEventListener('message', onMessage)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      send()
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}

export async function sendLargeFile(
  channel: RTCDataChannel, file: File, signal: AbortSignal, onAccepted: () => void,
): Promise<boolean> {
  const id = crypto.getRandomValues(new Uint32Array(1))[0]
  const metadata = new TextEncoder().encode(JSON.stringify({ name: file.name, size: file.size, id, wideWindow: true }))
  if (metadata.byteLength > maxMetadataSize) throw new AppError('fileNameTooLong')

  try {
    const reply = await waitForFileReply(channel, signal, id, frameType.accepted, () => {
      channel.send(makeFrame(frameType.offer, metadata))
    })
    if (reply === frameType.declined) return false
    onAccepted()

    // Older receivers ignore the extra offer field and acknowledge the original window size.
    const writeWindow = reply === frameType.acceptedWideWindow ? wideWriteWindow : legacyWriteWindow
    for (let offset = 0; offset < file.size; offset += writeWindow) {
      signal.throwIfAborted()
      const data = new Uint8Array(await file.slice(offset, offset + writeWindow).arrayBuffer())
      await waitForFileReply(channel, signal, id, frameType.written, () => {
        for (let index = 0; index < data.length; index += chunkSize) {
          channel.send(makeFrame(frameType.chunk, data.subarray(index, index + chunkSize)))
        }
      })
    }

    // A drained data channel does not tell us whether the destination was saved.
    await waitForFileReply(channel, signal, id, frameType.saved, () => {
      channel.send(makeFrame(frameType.finish))
    })
    return true
  } catch (error) {
    if (!signal.aborted) sendControl(channel, frameType.abort)
    throw error
  }
}

export class FileReceiver {
  private active: MemoryFile | OfferedFile | DiskFile | null = null
  private readonly savePicker = window.isSecureContext
    ? (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker
    : undefined

  constructor(private readonly channel: RTCDataChannel, private readonly update: (update: ReceiveUpdate | null) => void) {}

  advertise() {
    if (typeof this.savePicker === 'function') sendControl(this.channel, frameType.canSave)
  }

  decline() {
    const file = this.active
    if (!file || file.mode !== 'offer') return
    this.active = null
    sendControl(this.channel, frameType.declined, file.id)
    this.update({ status: 'interrupted', message: 'fileSkipped' })
  }

  async chooseDestination() {
    const file = this.active
    if (!file || file.mode !== 'offer' || file.choosing || !this.savePicker) return
    file.choosing = true
    this.update({ status: 'offered', name: file.name, size: file.size, choosing: true })

    let handle: FileSystemFileHandle
    try {
      const suggestedName = file.name.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/, '') || 'download'
      handle = await this.savePicker.call(window, { suggestedName, startIn: 'downloads' })
    } catch (error) {
      if (this.active !== file) return
      if (error instanceof DOMException && error.name === 'AbortError') this.decline()
      else this.failDiskFile(file, 'fileSaveFailed')
      return
    }

    if (this.active !== file) return
    try {
      const writer = (await handle.createWritable()).getWriter()
      if (this.active !== file) {
        await writer.abort()
        return
      }
      const writeWindow = file.wideWindow ? wideWriteWindow : legacyWriteWindow
      this.active = {
        mode: 'disk', id: file.id, name: handle.name, size: file.size, writer,
        queued: 0, received: 0, writeWindow, windowEnd: Math.min(writeWindow, file.size), batch: null, saving: false,
      }
      this.update({ status: 'receiving', name: handle.name, size: file.size, received: 0 })
      sendControl(this.channel, file.wideWindow ? frameType.acceptedWideWindow : frameType.accepted, file.id)
    } catch {
      this.failDiskFile(file, 'fileSaveFailed')
    }
  }

  accept(frame: ArrayBuffer): ReceiveUpdate | null {
    const bytes = new Uint8Array(frame)
    switch (bytes[0]) {
      case frameType.start: {
        const metadata = readMetadata(bytes.subarray(1))
        if (this.active || !metadata || metadata.size > maxFileSize) {
          return { status: 'interrupted', message: 'invalidFileInfo' }
        }
        this.active = { ...metadata, mode: 'memory', chunks: [], received: 0 }
        return { status: 'receiving', ...metadata, received: 0 }
      }
      case frameType.offer: {
        const metadata = readMetadata(bytes.subarray(1))
        if (metadata?.id === undefined) {
          this.channel.close()
          return { status: 'interrupted', message: 'invalidFileInfo' }
        }
        if (this.active || typeof this.savePicker !== 'function' || metadata.size <= maxFileSize) {
          sendControl(this.channel, frameType.failed, metadata.id)
          return { status: 'interrupted', message: 'invalidFileInfo' }
        }
        this.active = { ...metadata, id: metadata.id, mode: 'offer', choosing: false }
        return { status: 'offered', name: metadata.name, size: metadata.size, choosing: false }
      }
      case frameType.chunk: {
        const file = this.active
        if (!file || file.mode === 'offer') return null
        const chunk = bytes.subarray(1)
        if (file.mode === 'disk') {
          this.bufferChunk(file, chunk)
          return null
        }
        const received = file.received + chunk.byteLength
        if (chunk.byteLength === 0 || chunk.byteLength > chunkSize || received > file.size) {
          return this.interrupt('fileSizeMismatch')
        }
        file.chunks.push(chunk)
        const previousPercent = Math.floor((file.received * 100) / file.size)
        file.received = received
        if (Math.floor((received * 100) / file.size) === previousPercent) return null
        return { status: 'receiving', name: file.name, size: file.size, received }
      }
      case frameType.finish: {
        const file = this.active
        if (!file || file.mode === 'offer') return null
        if (file.mode === 'disk') {
          if (bytes.byteLength !== 1 || file.received !== file.size) this.failDiskFile(file, 'incompleteFile')
          else if (!file.saving) void this.finishDiskFile(file)
          return null
        }
        if (file.received !== file.size || bytes.byteLength !== 1) {
          return this.interrupt('incompleteFile')
        }
        this.active = null
        return { status: 'ready', name: file.name, blob: new Blob(file.chunks) }
      }
      case frameType.abort:
        return this.interrupt()
      default:
        return null
    }
  }

  interrupt(message: Message = 'fileInterrupted'): ReceiveUpdate | null {
    const file = this.active
    if (!file || (file.mode === 'disk' && file.saving)) return null
    this.active = null
    if (file.mode === 'disk') void file.writer.abort().catch(() => {})
    return { status: 'interrupted', message }
  }

  private bufferChunk(file: DiskFile, chunk: Uint8Array<ArrayBuffer>) {
    const expectedSize = Math.min(chunkSize, file.size - file.queued)
    if (!expectedSize || chunk.byteLength !== expectedSize || file.queued + chunk.byteLength > file.windowEnd) {
      this.failDiskFile(file, 'fileSizeMismatch')
      return
    }
    const batch = file.batch ??= new Uint8Array(Math.min(writeBatchSize, file.size - file.queued))
    const batchOffset = file.queued % writeBatchSize
    batch.set(chunk, batchOffset)
    file.queued += chunk.byteLength
    if (batchOffset + chunk.byteLength !== batch.byteLength) return

    file.batch = null
    void file.writer.write(batch).then(() => {
      if (this.active !== file) return
      const previousPercent = Math.floor((file.received / file.size) * 100)
      file.received += batch.byteLength
      if (Math.floor((file.received / file.size) * 100) !== previousPercent) {
        this.update({ status: 'receiving', name: file.name, size: file.size, received: file.received })
      }
      // Only grant another window after every byte of this one has been written.
      if (file.received === file.windowEnd) {
        file.windowEnd = Math.min(file.size, file.windowEnd + file.writeWindow)
        sendControl(this.channel, frameType.written, file.id)
      }
    }, () => this.failDiskFile(file, 'fileSaveFailed'))
  }

  private async finishDiskFile(file: DiskFile) {
    file.saving = true
    try {
      await file.writer.close()
    } catch {
      file.saving = false
      this.failDiskFile(file, 'fileSaveFailed')
      return
    }
    this.active = null
    this.update({ status: 'ready', name: file.name })
    sendControl(this.channel, frameType.saved, file.id)
  }

  private failDiskFile(file: OfferedFile | DiskFile, message: Message) {
    if (this.active !== file || (file.mode === 'disk' && file.saving)) return
    this.update(this.interrupt(message))
    sendControl(this.channel, frameType.failed, file.id)
  }
}

function readMetadata(bytes: Uint8Array): (FileMetadata & { id?: number; wideWindow: boolean }) | null {
  if (bytes.byteLength > maxMetadataSize) return null

  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (
      typeof value === 'object' && value !== null &&
      'name' in value && typeof value.name === 'string' && value.name.length > 0 &&
      'size' in value && typeof value.size === 'number' && Number.isSafeInteger(value.size) &&
      value.size >= 0
    ) {
      const id = 'id' in value && typeof value.id === 'number' && Number.isInteger(value.id) &&
        value.id >= 0 && value.id <= 0xffffffff ? value.id : undefined
      return { name: value.name, size: value.size, id, wideWindow: 'wideWindow' in value && value.wideWindow === true }
    }
  } catch {
    return null
  }
  return null
}
