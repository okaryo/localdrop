// Older peers ignore string messages, so advertising this does not affect file transfers.
export const textCapability = 'localdrop:text:v1'
export const maxTextBytes = 16 * 1024

const encoder = new TextEncoder()

export function isTextTooLarge(value: string): boolean {
  return value.length > maxTextBytes || encoder.encode(value).byteLength > maxTextBytes
}
