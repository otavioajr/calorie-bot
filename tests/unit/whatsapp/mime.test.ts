import { describe, it, expect } from 'vitest'
import { detectMimeType } from '@/lib/whatsapp/mime'

describe('detectMimeType', () => {
  it('detects JPEG from magic bytes', () => {
    const buffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x00])
    expect(detectMimeType(buffer)).toBe('image/jpeg')
  })

  it('detects PNG from magic bytes', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A])
    expect(detectMimeType(buffer)).toBe('image/png')
  })

  it('detects WebP from magic bytes', () => {
    const buffer = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])
    expect(detectMimeType(buffer)).toBe('image/webp')
  })

  it('defaults to image/jpeg for unknown format', () => {
    const buffer = Buffer.from([0x00, 0x00, 0x00, 0x00])
    expect(detectMimeType(buffer)).toBe('image/jpeg')
  })

  it('defaults to image/jpeg for empty buffer', () => {
    const buffer = Buffer.from([])
    expect(detectMimeType(buffer)).toBe('image/jpeg')
  })
})
