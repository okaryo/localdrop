import { expect, test } from 'vitest'
import { isTextTooLarge, maxTextBytes } from './textTransfer'

test('accepts text at the byte limit and rejects text above it', () => {
  const atLimit = 'a'.repeat(maxTextBytes)
  expect(isTextTooLarge(atLimit)).toBe(false)
  expect(isTextTooLarge(atLimit + 'a')).toBe(true)
})

test('counts UTF-8 bytes for multibyte characters', () => {
  const atLimit = '📷'.repeat(maxTextBytes / 4)
  expect(isTextTooLarge(atLimit)).toBe(false)
  expect(isTextTooLarge(atLimit + 'a')).toBe(true)
})
