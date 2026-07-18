import { describe, expect, it, vi } from 'vitest'
import {
  applyOutboxCallback,
  beginOutboxFallbackAttempt,
  claimOutboxMessages,
  enqueueOutboxMessage,
  fenceOutboxFallback,
  finalizeOutboxScope,
  recordOutboxAttemptResult,
} from '@/lib/outbox/repository'
import type { EnqueueOutboxInput } from '@/lib/outbox/repository'

function enqueueInput(): EnqueueOutboxInput {
  return {
    provider: 'whatsapp_cloud',
    businessAccountId: 'pnid',
    recipient: '351900000001',
    userId: null,
    workId: null,
    emissionIndex: null,
    idempotencyKey: 'inbound:work-1:0',
    messageKind: 'terminal',
    payload: { type: 'text', text: 'hello' },
    payloadHash: 'a'.repeat(64),
    replyToMessageId: null,
    resourceType: null,
    resourceId: null,
    resourceMetadata: null,
    rolloutMode: 'active',
    rolloutGeneration: 'gen-1',
    maxAttempts: 5,
    expiresAt: '2026-07-13T12:15:00.000Z',
  }
}

describe('outbox repository', () => {
  it('maps enqueue input and detects an idempotency conflict', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          outbox_id: 'outbox-1',
          status: 'pending',
          sequence_no: 3,
          was_inserted: false,
          idempotency_conflict: true,
          provider_message_id: null,
        },
      ],
      error: null,
    })

    const result = await enqueueOutboxMessage(
      { rpc } as never,
      enqueueInput(),
    )

    expect(result).toMatchObject({
      ok: true,
      outboxId: 'outbox-1',
      idempotencyConflict: true,
    })
    expect(rpc).toHaveBeenCalledWith(
      'enqueue_outbox_message',
      expect.objectContaining({
        p_idempotency_key: 'inbound:work-1:0',
        p_message_kind: 'terminal',
        p_payload_hash: 'a'.repeat(64),
      }),
    )
  })

  it('returns a typed database error instead of an ambiguous empty result', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'database unavailable', code: 'XX000' },
    })

    const result = await claimOutboxMessages(
      { rpc } as never,
      'worker-1',
      'gen-1',
    )

    expect(result).toEqual({
      ok: false,
      error: { message: 'database unavailable', code: 'XX000' },
    })
  })

  it('passes an optional target outbox ID to an inline claim', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null })

    await claimOutboxMessages(
      { rpc } as never,
      'inline:worker-1',
      'gen-1',
      {
        limit: 1,
        leaseSeconds: 90,
        outboxId: 'outbox-1',
        allowUnfinalized: true,
      },
    )

    expect(rpc).toHaveBeenCalledWith('claim_outbox_messages', {
      p_owner: 'inline:worker-1',
      p_generation: 'gen-1',
      p_limit: 1,
      p_lease_seconds: 90,
      p_outbox_id: 'outbox-1',
      p_allow_unfinalized: true,
    })
  })

  it('maps a durable fallback fence result', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{
        safe_for_direct: true,
        outbox_id: 'outbox-1',
        status: 'suspended',
        provider_message_id: null,
        idempotency_conflict: false,
      }],
      error: null,
    })

    const result = await fenceOutboxFallback({ rpc } as never, {
      provider: 'whatsapp_cloud',
      businessAccountId: 'pnid',
      recipient: '351900000001',
      idempotencyKey: 'inbound:work-1:0',
      payloadHash: 'a'.repeat(64),
      rolloutGeneration: 'gen-1',
    })

    expect(result).toEqual({
      ok: true,
      safeForDirect: true,
      outboxId: 'outbox-1',
      status: 'suspended',
      providerMessageId: null,
      idempotencyConflict: false,
    })
    expect(rpc).toHaveBeenCalledWith('fence_outbox_fallback', {
      p_provider: 'whatsapp_cloud',
      p_business_account_id: 'pnid',
      p_recipient: '351900000001',
      p_idempotency_key: 'inbound:work-1:0',
      p_payload_hash: 'a'.repeat(64),
      p_rollout_generation: 'gen-1',
      p_reason: 'ambiguous_enqueue_result',
    })
  })

  it('reserves exactly one direct fallback attempt with a lease token', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{
        started: true,
        lease_token: 'fallback-lease-1',
        status: 'sending',
        attempt: 1,
      }],
      error: null,
    })

    const result = await beginOutboxFallbackAttempt({ rpc } as never, {
      outboxId: 'outbox-1',
      idempotencyKey: 'inbound:work-1:0',
      leaseSeconds: 90,
    })

    expect(result).toEqual({
      ok: true,
      started: true,
      leaseToken: 'fallback-lease-1',
      status: 'sending',
      attempt: 1,
    })
    expect(rpc).toHaveBeenCalledWith('begin_outbox_fallback_attempt', {
      p_outbox_id: 'outbox-1',
      p_idempotency_key: 'inbound:work-1:0',
      p_lease_seconds: 90,
    })
  })

  it('maps a fallback queued by recipient FIFO without adding a lease', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{
        started: false,
        lease_token: null,
        status: 'pending',
        attempt: 0,
      }],
      error: null,
    })

    expect(await beginOutboxFallbackAttempt({ rpc } as never, {
      outboxId: 'outbox-1',
      idempotencyKey: 'fallback-fifo:terminal',
      leaseSeconds: 90,
    })).toEqual({
      ok: true,
      started: false,
      leaseToken: null,
      status: 'pending',
      attempt: 0,
    })
  })

  it('maps claimed rows and attempt results', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            outbox_id: 'outbox-1',
            recipient: '351900000001',
            message_kind: 'terminal',
            payload_json: { type: 'text', text: 'hello' },
            payload_hash: 'a'.repeat(64),
            reply_to_message_id: null,
            sequence_no: 1,
            attempt: 1,
            max_attempts: 5,
            expires_at: '2026-07-13T12:15:00.000Z',
            lease_token: 'lease-1',
            user_id: null,
            work_id: null,
            resource_type: null,
            resource_id: null,
            resource_metadata: null,
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          {
            applied: true,
            status: 'api_accepted',
            attempt: 1,
            provider_message_id: 'wamid.1',
          },
        ],
        error: null,
      })

    const claimed = await claimOutboxMessages(
      { rpc } as never,
      'worker-1',
      'gen-1',
    )
    expect(claimed).toMatchObject({
      ok: true,
      rows: [{ outboxId: 'outbox-1', leaseToken: 'lease-1' }],
    })

    const recorded = await recordOutboxAttemptResult({ rpc } as never, {
      outboxId: 'outbox-1',
      leaseToken: 'lease-1',
      outcome: 'api_accepted',
      providerMessageId: 'wamid.1',
    })
    expect(recorded).toEqual({
      ok: true,
      applied: true,
      status: 'api_accepted',
      attempt: 1,
      providerMessageId: 'wamid.1',
    })
  })

  it('preserves an orphan callback as a successful ledger operation', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          applied: false,
          outbox_id: null,
          previous_status: null,
          status: null,
          orphaned: true,
        },
      ],
      error: null,
    })

    const result = await applyOutboxCallback({ rpc } as never, {
      providerMessageId: 'wamid.orphan',
      callbackStatus: 'delivered',
      eventAt: '2026-07-13T12:00:00.000Z',
      outboxId: null,
      metaCode: 131026,
      metaSubcode: 2494010,
      errorMessage: 'undeliverable',
      payload: { status: 'delivered' },
    })

    expect(rpc).toHaveBeenCalledWith('apply_outbox_callback', {
      p_provider_message_id: 'wamid.orphan',
      p_callback_status: 'delivered',
      p_event_at: '2026-07-13T12:00:00.000Z',
      p_outbox_id: null,
      p_meta_code: 131026,
      p_meta_subcode: 2494010,
      p_error_message: 'undeliverable',
      p_callback_json: { status: 'delivered' },
    })
    expect(result).toEqual({
      ok: true,
      applied: false,
      outboxId: null,
      previousStatus: null,
      status: null,
      orphaned: true,
    })
  })

  it('fails closed when an RPC returns an unknown projection state', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          applied: true,
          outbox_id: 'outbox-1',
          previous_status: 'pending',
          status: 'not-a-real-state',
          orphaned: false,
        },
      ],
      error: null,
    })

    const result = await applyOutboxCallback({ rpc } as never, {
      providerMessageId: 'wamid.invalid-state',
      callbackStatus: 'sent',
      eventAt: '2026-07-13T12:00:00.000Z',
    })

    expect(result).toEqual({
      ok: false,
      error: { message: 'apply_outbox_callback returned an invalid row' },
    })
  })

  it('rejects api acceptance without a provider message id before calling the RPC', async () => {
    const rpc = vi.fn()
    const result = await recordOutboxAttemptResult(
      { rpc } as never,
      {
        outboxId: 'outbox-1',
        leaseToken: 'lease-1',
        outcome: 'api_accepted',
        providerMessageId: null,
      } as never,
    )

    expect(result).toEqual({
      ok: false,
      error: { message: 'api_accepted requires a provider message id' },
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('rejects missing nullable fields instead of coercing undefined to null', async () => {
    const enqueueRpc = vi.fn().mockResolvedValue({
      data: [{
        outbox_id: 'outbox-1',
        status: 'pending',
        sequence_no: 1,
        was_inserted: true,
        idempotency_conflict: false,
      }],
      error: null,
    })
    const claimRpc = vi.fn().mockResolvedValue({
      data: [{
        outbox_id: 'outbox-1',
        recipient: '351900000001',
        message_kind: 'terminal',
        payload_json: { type: 'text', text: 'hello' },
        payload_hash: 'a'.repeat(64),
        sequence_no: 1,
        attempt: 1,
        max_attempts: 5,
        expires_at: '2026-07-13T12:15:00.000Z',
        lease_token: 'lease-1',
        user_id: null,
        work_id: null,
        resource_type: null,
        resource_id: null,
        resource_metadata: null,
      }],
      error: null,
    })
    const resultRpc = vi.fn().mockResolvedValue({
      data: [{ applied: false, status: null, attempt: null }],
      error: null,
    })
    const callbackRpc = vi.fn().mockResolvedValue({
      data: [{
        applied: false,
        outbox_id: null,
        status: null,
        orphaned: true,
      }],
      error: null,
    })
    const finalizeRpc = vi.fn().mockResolvedValue({
      data: [{ finalized: false, response_count: 0 }],
      error: null,
    })

    const enqueueResult = await enqueueOutboxMessage(
      { rpc: enqueueRpc } as never,
      enqueueInput(),
    )
    const claimResult = await claimOutboxMessages(
      { rpc: claimRpc } as never,
      'worker-1',
      'gen-1',
    )
    const attemptResult = await recordOutboxAttemptResult(
      { rpc: resultRpc } as never,
      {
        outboxId: 'outbox-1',
        leaseToken: 'lease-1',
        outcome: 'failed_terminal',
      },
    )
    const callbackResult = await applyOutboxCallback(
      { rpc: callbackRpc } as never,
      {
        providerMessageId: 'wamid.orphan',
        callbackStatus: 'failed',
        eventAt: '2026-07-13T12:00:00.000Z',
      },
    )
    const finalizeResult = await finalizeOutboxScope(
      { rpc: finalizeRpc } as never,
      {
        workId: 'work-1',
        lastOutboxId: 'outbox-1',
        messageKind: 'terminal',
        expiresAt: '2026-07-13T12:15:00.000Z',
      },
    )

    expect(enqueueResult).toMatchObject({ ok: false })
    expect(claimResult).toMatchObject({ ok: false })
    expect(attemptResult).toMatchObject({ ok: false })
    expect(callbackResult).toMatchObject({ ok: false })
    expect(finalizeResult).toMatchObject({ ok: false })
  })

  it('rejects invalid numeric claim options before calling the RPC', async () => {
    const rpc = vi.fn()
    const result = await claimOutboxMessages(
      { rpc } as never,
      'worker-1',
      'gen-1',
      { limit: Number.NaN },
    )

    expect(result).toEqual({
      ok: false,
      error: { message: 'invalid outbox claim input' },
    })
    expect(rpc).not.toHaveBeenCalled()
  })
})
