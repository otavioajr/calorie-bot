import { describe, expect, it, vi } from 'vitest'
import {
  createScopedSendOptions,
  getOutboxScopeSummary,
  isOutboxProjectedProviderMessage,
  recordScopedOutboxError,
  recordScopedOutboxResult,
  runWithOutboxScope,
  setOutboxScopeUser,
  withOutboxMessageKind,
  withOutboxResource,
} from '@/lib/outbox/scope'
import { OutboxIdempotencyConflictError } from '@/lib/outbox/service'
import type {
  OutboxRoute,
  OutboxSendResult,
  SendTextMessageOptions,
} from '@/lib/outbox/service'

const NOW = new Date('2026-07-13T12:00:00.000Z')

function requireOptions(
  options: SendTextMessageOptions | undefined,
): SendTextMessageOptions {
  if (!options) throw new Error('expected an active outbox scope')
  return options
}

function sendResult(
  overrides: Partial<OutboxSendResult> = {},
): OutboxSendResult {
  return {
    providerMessageId: null,
    outboxId: null,
    status: null,
    route: 'direct-off',
    durablyEnqueued: false,
    replayed: false,
    preventInboundReplay: false,
    attemptResultPersisted: false,
    ...overrides,
  }
}

function managedResult(
  outboxId: string,
  overrides: Partial<OutboxSendResult> = {},
): OutboxSendResult {
  return sendResult({
    outboxId,
    status: 'pending',
    route: 'active',
    durablyEnqueued: true,
    ...overrides,
  })
}

describe('inbound outbox emission scope', () => {
  it('keeps concurrent scopes independent with zero-based stable indexes', async () => {
    const [left, right] = await Promise.all([
      runWithOutboxScope(
        {
          workId: 'work-left',
          recipient: '5511999990001',
          now: () => NOW,
        },
        async () => {
          const first = requireOptions(createScopedSendOptions())
          await Promise.resolve()
          const second = requireOptions(createScopedSendOptions())
          return { first, second, summary: getOutboxScopeSummary() }
        },
      ),
      runWithOutboxScope(
        {
          workId: 'work-right',
          recipient: '5511999990002',
          now: () => NOW,
        },
        async () => {
          await Promise.resolve()
          const first = requireOptions(createScopedSendOptions())
          await Promise.resolve()
          const second = requireOptions(createScopedSendOptions())
          return { first, second, summary: getOutboxScopeSummary() }
        },
      ),
    ])

    expect(left.value.first).toMatchObject({
      workId: 'work-left',
      emissionIndex: 0,
      idempotencyKey: 'inbound:work-left:0',
    })
    expect(left.value.second).toMatchObject({
      workId: 'work-left',
      emissionIndex: 1,
      idempotencyKey: 'inbound:work-left:1',
    })
    expect(right.value.first).toMatchObject({
      workId: 'work-right',
      emissionIndex: 0,
      idempotencyKey: 'inbound:work-right:0',
    })
    expect(right.value.second).toMatchObject({
      workId: 'work-right',
      emissionIndex: 1,
      idempotencyKey: 'inbound:work-right:1',
    })
    expect(left.summary.emissions).toHaveLength(2)
    expect(right.summary.emissions).toHaveLength(2)
  })

  it('defaults to terminal semantics and scopes the progress TTL decorator', async () => {
    await runWithOutboxScope(
      {
        workId: 'work-kinds',
        recipient: '5511999990001',
        now: () => NOW,
      },
      async () => {
        const terminal = requireOptions(createScopedSendOptions())
        const progress = await withOutboxMessageKind('progress', async () =>
          requireOptions(createScopedSendOptions()),
        )
        const terminalAfterDecorator = requireOptions(createScopedSendOptions())

        expect(terminal).toMatchObject({
          source: 'bot',
          messageKind: 'terminal',
        })
        expect(terminal.expiresAt).toBeUndefined()
        expect(progress).toMatchObject({
          source: 'bot',
          messageKind: 'progress',
        })
        expect(progress.expiresAt).toEqual(
          new Date('2026-07-13T12:05:00.000Z'),
        )
        expect(progress.beforeUnsafeFallback).toBeUndefined()
        expect(terminal.beforeUnsafeFallback).toBeTypeOf('function')
        expect(terminalAfterDecorator).toMatchObject({
          messageKind: 'terminal',
        })
        expect(terminalAfterDecorator.expiresAt).toBeUndefined()
      },
    )
  })

  it('propagates user and resource metadata only within their decorators', async () => {
    await runWithOutboxScope(
      {
        workId: 'work-resource',
        recipient: '5511999990001',
        now: () => NOW,
      },
      async () => {
        setOutboxScopeUser('user-1')
        const decorated = await withOutboxResource(
          {
            resourceType: 'meal',
            resourceId: 'meal-1',
            resourceMetadata: { mealType: 'lunch', calories: 640 },
          },
          async () => requireOptions(createScopedSendOptions()),
        )
        const undecorated = requireOptions(createScopedSendOptions())

        expect(decorated).toMatchObject({
          userId: 'user-1',
          resourceType: 'meal',
          resourceId: 'meal-1',
          resourceMetadata: { mealType: 'lunch', calories: 640 },
        })
        expect(undecorated).toMatchObject({ userId: 'user-1' })
        expect(undecorated.resourceType).toBeUndefined()
        expect(undecorated.resourceId).toBeUndefined()
        expect(undecorated.resourceMetadata).toBeUndefined()
        expect(getOutboxScopeSummary()?.userId).toBe('user-1')
      },
    )
  })

  it('tracks progress separately and requires a durable non-progress result', async () => {
    await runWithOutboxScope(
      {
        workId: 'work-durable',
        recipient: '5511999990001',
        now: () => NOW,
      },
      async () => {
        const progress = await withOutboxMessageKind('progress', async () =>
          requireOptions(createScopedSendOptions()),
        )
        recordScopedOutboxResult(
          progress,
          managedResult('outbox-progress'),
        )

        expect(getOutboxScopeSummary()).toMatchObject({
          hasProgress: true,
          hasDurableTerminal: false,
          lastNonProgressOutboxId: null,
        })

        const directTerminal = requireOptions(createScopedSendOptions())
        recordScopedOutboxResult(
          directTerminal,
          sendResult({
            providerMessageId: 'wamid.direct',
            route: 'direct-off',
          }),
        )
        expect(getOutboxScopeSummary()?.hasDurableTerminal).toBe(false)

        const durableTerminal = requireOptions(createScopedSendOptions())
        recordScopedOutboxResult(
          durableTerminal,
          managedResult('outbox-terminal', { status: 'unknown' }),
        )

        expect(getOutboxScopeSummary()).toMatchObject({
          hasProgress: true,
          hasDurableTerminal: true,
          lastNonProgressOutboxId: 'outbox-terminal',
        })
        expect(getOutboxScopeSummary()?.emissions).toHaveLength(3)
      },
    )
  })

  it.each<OutboxRoute>(['shadow', 'active', 'enqueue-fallback'])(
    'recognizes %s WAMIDs as already projected by the outbox',
    async (route) => {
      await runWithOutboxScope(
        {
          workId: `work-${route}`,
          recipient: '5511999990001',
          now: () => NOW,
        },
        async () => {
          const options = requireOptions(createScopedSendOptions())
          const wamid = `wamid.${route}`
          recordScopedOutboxResult(
            options,
            managedResult(`outbox-${route}`, {
              providerMessageId: wamid,
              route,
              status: 'api_accepted',
              attemptResultPersisted: true,
            }),
          )

          expect(isOutboxProjectedProviderMessage(wamid)).toBe(true)
          expect(isOutboxProjectedProviderMessage('wamid.unknown')).toBe(false)
        },
      )
    },
  )

  it.each<OutboxRoute>(['direct-off', 'direct-ineligible'])(
    'keeps %s WAMIDs on the legacy outgoing projection path',
    async (route) => {
      await runWithOutboxScope(
        {
          workId: `work-${route}`,
          recipient: '5511999990001',
          now: () => NOW,
        },
        async () => {
          const options = requireOptions(createScopedSendOptions())
          const wamid = `wamid.${route}`
          recordScopedOutboxResult(
            options,
            sendResult({ providerMessageId: wamid, route }),
          )

          expect(isOutboxProjectedProviderMessage(wamid)).toBe(false)
        },
      )
    },
  )

  it('keeps the legacy outgoing path when Meta accepted but attempt result was not persisted', async () => {
    await runWithOutboxScope(
      {
        workId: 'work-unpersisted',
        recipient: '5511999990001',
        now: () => NOW,
      },
      async () => {
        const options = requireOptions(createScopedSendOptions())
        const wamid = 'wamid.unpersisted'
        recordScopedOutboxResult(
          options,
          managedResult('outbox-unpersisted', {
            providerMessageId: wamid,
            route: 'active',
            status: 'api_accepted',
            attemptResultPersisted: false,
          }),
        )

        expect(isOutboxProjectedProviderMessage(wamid)).toBe(false)
      },
    )
  })

  it('passes the durable fallback fence and marks the inbound as non-replayable', async () => {
    const beforeUnsafeFallback = vi.fn().mockResolvedValue(undefined)

    await runWithOutboxScope(
      {
        workId: 'work-fallback',
        recipient: '5511999990001',
        now: () => NOW,
        beforeUnsafeFallback,
      },
      async () => {
        const options = requireOptions(createScopedSendOptions())
        await options.beforeUnsafeFallback?.({
          workId: 'work-fallback',
          messageKind: 'terminal',
          error: { message: 'enqueue outcome uncertain' },
        })
        await options.beforeUnsafeFallback?.({
          workId: 'work-fallback',
          messageKind: 'terminal',
          error: { message: 'enqueue outcome uncertain' },
        })
        expect(beforeUnsafeFallback).toHaveBeenCalledOnce()

        recordScopedOutboxResult(
          options,
          managedResult('outbox-fallback', {
            providerMessageId: 'wamid.fallback',
            route: 'enqueue-fallback',
            status: 'api_accepted',
            preventInboundReplay: true,
          }),
        )

        expect(getOutboxScopeSummary()).toMatchObject({
          hasDurableTerminal: true,
          lastNonProgressOutboxId: 'outbox-fallback',
          unsafeFallbackFenced: true,
        })
      },
    )
  })

  it('fails closed after an idempotency conflict and reserves no later emission', async () => {
    await runWithOutboxScope(
      {
        workId: 'work-conflict',
        recipient: '5511999990001',
        now: () => NOW,
      },
      async () => {
        const first = requireOptions(createScopedSendOptions())
        recordScopedOutboxError(
          first,
          new OutboxIdempotencyConflictError('payload hash differs'),
        )

        expect(getOutboxScopeSummary()).toMatchObject({
          idempotencyConflict: true,
          conflictError: 'payload hash differs',
        })
        expect(() => createScopedSendOptions()).toThrow(
          OutboxIdempotencyConflictError,
        )
        expect(getOutboxScopeSummary()?.emissions).toHaveLength(1)
      },
    )
  })

  it('is inert when a caller is outside an inbound scope', () => {
    expect(createScopedSendOptions()).toBeUndefined()
    expect(getOutboxScopeSummary()).toBeNull()
    expect(isOutboxProjectedProviderMessage('wamid.any')).toBe(false)
  })
})
