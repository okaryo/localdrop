import { afterEach, expect, test, vi } from 'vitest'
import {
  advertisesLargeFiles, FileReceiver, maxFileSize, sendFile, sendLargeFile, type ReceiveUpdate,
} from './fileTransfer'

class TestChannel extends EventTarget {
  readonly bufferedAmount = 0
  readyState: RTCDataChannelState = 'open'
  onSend = (_frame: ArrayBuffer) => {}

  send(frame: Uint8Array) {
    this.onSend(Uint8Array.from(frame).buffer)
  }

  close() {
    this.readyState = 'closed'
  }

  get dataChannel() {
    return this as unknown as RTCDataChannel
  }
}

function connectReceiver() {
  const incoming = new TestChannel()
  const outgoing = new TestChannel()
  const updates: ReceiveUpdate[] = []
  const record = (update: ReceiveUpdate | null) => {
    if (update) updates.push(update)
  }
  const receiver = new FileReceiver(incoming.dataChannel, record)
  outgoing.onSend = (frame) => record(receiver.accept(frame))
  incoming.onSend = (frame) => outgoing.dispatchEvent(new MessageEvent('message', { data: frame }))
  return { receiver, outgoing, updates }
}

afterEach(() => vi.unstubAllGlobals())

test.each([0, 40_000])('transfers a %i-byte file in memory', async (size) => {
  vi.stubGlobal('window', { isSecureContext: false })
  const { outgoing, updates } = connectReceiver()
  const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251)
  const file = new File([bytes], '写真.bin')

  await sendFile(outgoing.dataChannel, file, new AbortController().signal)

  expect(updates[0]).toMatchObject({ status: 'receiving', name: file.name, size, received: 0 })
  const ready = updates.at(-1)
  expect(ready).toMatchObject({ status: 'ready', name: file.name, blob: expect.any(Blob) })
  if (ready?.status !== 'ready' || !ready.blob) throw new Error('Expected a download')
  expect(new Uint8Array(await ready.blob.arrayBuffer())).toEqual(bytes)
})

test('discards an incomplete file and accepts a subsequent transfer', async () => {
  vi.stubGlobal('window', { isSecureContext: false })
  const { receiver, outgoing, updates } = connectReceiver()
  const frames: ArrayBuffer[] = []
  const deliver = outgoing.onSend
  outgoing.onSend = (frame) => frames.push(frame)
  const file = new File(['attachment'], 'file.txt')
  await sendFile(outgoing.dataChannel, file, new AbortController().signal)
  const [start, chunk, finish] = frames

  deliver(start)
  deliver(finish)
  expect(updates.at(-1)).toEqual({ status: 'interrupted', message: 'incompleteFile' })

  deliver(start)
  deliver(chunk)
  deliver(finish)
  expect(updates.at(-1)).toMatchObject({ status: 'ready', name: file.name })
})

test('saves a large file over multiple write windows before reporting success', async () => {
  const size = maxFileSize + 1
  const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251)
  const file = new File([bytes], 'large.bin')
  let written = 0
  let matches = true
  let commit = () => {}
  const waitForCommit = new Promise<void>((resolve) => {
    commit = resolve
  })
  const close = vi.fn(() => waitForCommit)
  const picker = vi.fn().mockResolvedValue({
    name: 'saved.bin',
    createWritable: async () => new WritableStream<Uint8Array>({
      write(chunk) {
        matches &&= chunk.every((value, index) => value === bytes[written + index])
        written += chunk.length
      },
      close,
    }),
  })
  vi.stubGlobal('window', { isSecureContext: true, showSaveFilePicker: picker })
  const { receiver, outgoing, updates } = connectReceiver()
  const advertise = vi.fn((event: Event) => advertisesLargeFiles((event as MessageEvent<ArrayBuffer>).data))
  outgoing.addEventListener('message', advertise, { once: true })
  receiver.advertise()
  expect(advertise).toHaveReturnedWith(true)

  const accepted = vi.fn()
  const completed = vi.fn((result: boolean) => result)
  const sending = sendLargeFile(outgoing.dataChannel, file, AbortSignal.timeout(4000), accepted).then(completed)
  expect(updates.at(-1)).toEqual({ status: 'offered', name: file.name, size, choosing: false })
  expect(accepted).not.toHaveBeenCalled()
  await receiver.chooseDestination()

  try {
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(completed).not.toHaveBeenCalled()
    expect(updates.at(-1)).toEqual({ status: 'receiving', name: 'saved.bin', size, received: size })
  } finally {
    commit()
  }

  await expect(sending).resolves.toBe(true)
  expect(picker).toHaveBeenCalledWith({ suggestedName: file.name, startIn: 'downloads' })
  expect(accepted).toHaveBeenCalledTimes(1)
  expect(written).toBe(size)
  expect(matches).toBe(true)
  expect(updates.at(-1)).toEqual({ status: 'ready', name: 'saved.bin' })
})

test('skips a large file when the receiver cancels the save picker', async () => {
  const picker = vi.fn().mockRejectedValue(new DOMException('Canceled', 'AbortError'))
  vi.stubGlobal('window', { isSecureContext: true, showSaveFilePicker: picker })
  const { receiver, outgoing, updates } = connectReceiver()
  const file = new File([new Uint8Array(maxFileSize + 1)], 'large.bin')
  const accepted = vi.fn()
  const sending = sendLargeFile(outgoing.dataChannel, file, AbortSignal.timeout(4000), accepted)

  await receiver.chooseDestination()

  await expect(sending).resolves.toBe(false)
  expect(accepted).not.toHaveBeenCalled()
  expect(updates.at(-1)).toEqual({ status: 'interrupted', message: 'fileSkipped' })
})
