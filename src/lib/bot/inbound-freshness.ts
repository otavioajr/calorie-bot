export const INBOUND_REPLY_TTL_SECONDS = 90

export type InboundTtlResult =
  | { ok: true }
  | { ok: false; errorCode: 'stale_expired' }

export function evaluateInboundTtl(
  receivedAt: Date,
  now: Date = new Date(),
): InboundTtlResult {
  const ageMs = now.getTime() - receivedAt.getTime()
  if (ageMs > INBOUND_REPLY_TTL_SECONDS * 1000) {
    return { ok: false, errorCode: 'stale_expired' }
  }
  return { ok: true }
}
