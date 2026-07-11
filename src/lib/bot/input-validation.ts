import { MAX_INCOMING_TEXT_CHARS } from '@/lib/whatsapp/limits'

const ZERO_WIDTH_AND_BLANK = /^[\s\u200B-\u200D\uFEFF]*$/

/** True when the message has no visible content (whitespace / zero-width only). */
export function isBlankText(text: string): boolean {
  return ZERO_WIDTH_AND_BLANK.test(text)
}

/** True when text exceeds the WhatsApp channel limit. */
export function isTextTooLong(text: string): boolean {
  return text.length > MAX_INCOMING_TEXT_CHARS
}
