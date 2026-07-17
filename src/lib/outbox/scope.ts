import { AsyncLocalStorage } from 'node:async_hooks'
import type { ResourceType } from './repository'
import { buildInboundKey } from './policy'
import type {
  OutboxSendResult,
  SendTextMessageOptions,
  UnsafeFallbackIncident,
} from './service'
import { OutboxIdempotencyConflictError } from './service'
import type { OutboxMessageKind } from './types'

export interface OutboxResourceMetadata {
  resourceType: ResourceType | null
  resourceId: string | null
  resourceMetadata?: Record<string, unknown> | null
}

export interface OutboxScopeInput {
  workId: string
  recipient: string
  userId?: string | null
  now?: () => Date
  beforeUnsafeFallback?: (
    incident: UnsafeFallbackIncident,
  ) => Promise<void>
}

export interface ScopedOutboxEmission {
  emissionIndex: number
  messageKind: OutboxMessageKind
  outboxId: string | null
  providerMessageId: string | null
  durablyEnqueued: boolean
  preventInboundReplay: boolean
  error: string | null
}

export interface OutboxScopeSummary {
  workId: string
  recipient: string
  userId: string | null
  emissions: readonly ScopedOutboxEmission[]
  hasProgress: boolean
  hasDurableTerminal: boolean
  lastNonProgressOutboxId: string | null
  unsafeFallbackFenced: boolean
  idempotencyConflict: boolean
  conflictError: string | null
}

interface MutableEmission extends ScopedOutboxEmission {
  options: SendTextMessageOptions
}

interface OutboxScopeStore {
  workId: string
  recipient: string
  userId: string | null
  nextIndex: number
  emissions: MutableEmission[]
  projectedProviderMessages: Set<string>
  sendChain: Promise<void>
  unsafeFallbackFenced: boolean
  unsafeFallbackFence: Promise<void> | null
  idempotencyConflict: boolean
  conflictError: string | null
  now: () => Date
  beforeUnsafeFallback?: (
    incident: UnsafeFallbackIncident,
  ) => Promise<void>
}

interface OutboxDecoration {
  messageKind?: OutboxMessageKind
  resource?: OutboxResourceMetadata
}

const scopeStorage = new AsyncLocalStorage<OutboxScopeStore>()
const decorationStorage = new AsyncLocalStorage<OutboxDecoration>()

function snapshot(store: OutboxScopeStore): OutboxScopeSummary {
  const emissions = store.emissions.map((emission) => ({
    emissionIndex: emission.emissionIndex,
    messageKind: emission.messageKind,
    outboxId: emission.outboxId,
    providerMessageId: emission.providerMessageId,
    durablyEnqueued: emission.durablyEnqueued,
    preventInboundReplay: emission.preventInboundReplay,
    error: emission.error,
  }))
  const durableNonProgress = emissions.filter(
    (emission) => emission.messageKind !== 'progress' &&
      emission.durablyEnqueued &&
      emission.outboxId !== null,
  )

  return {
    workId: store.workId,
    recipient: store.recipient,
    userId: store.userId,
    emissions,
    hasProgress: emissions.some((emission) => emission.messageKind === 'progress'),
    hasDurableTerminal: durableNonProgress.length > 0,
    lastNonProgressOutboxId:
      durableNonProgress.at(-1)?.outboxId ?? null,
    unsafeFallbackFenced: store.unsafeFallbackFenced,
    idempotencyConflict: store.idempotencyConflict,
    conflictError: store.conflictError,
  }
}

export class OutboxScopeExecutionError extends Error {
  readonly summary: OutboxScopeSummary
  override readonly cause: unknown

  constructor(cause: unknown, summary: OutboxScopeSummary) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'OutboxScopeExecutionError'
    this.cause = cause
    this.summary = summary
  }
}

export async function runWithOutboxScope<T>(
  input: OutboxScopeInput,
  fn: () => Promise<T>,
): Promise<{ value: T; summary: OutboxScopeSummary }> {
  const store: OutboxScopeStore = {
    workId: input.workId,
    recipient: input.recipient,
    userId: input.userId ?? null,
    nextIndex: 0,
    emissions: [],
    projectedProviderMessages: new Set(),
    sendChain: Promise.resolve(),
    unsafeFallbackFenced: false,
    unsafeFallbackFence: null,
    idempotencyConflict: false,
    conflictError: null,
    now: input.now ?? (() => new Date()),
    beforeUnsafeFallback: input.beforeUnsafeFallback,
  }

  return scopeStorage.run(store, async () => {
    try {
      const value = await fn()
      await store.sendChain
      return { value, summary: snapshot(store) }
    } catch (error) {
      await store.sendChain
      throw new OutboxScopeExecutionError(error, snapshot(store))
    }
  })
}

export function setOutboxScopeUser(userId: string): void {
  const store = scopeStorage.getStore()
  if (store) store.userId = userId
}

export function getOutboxScopeSummary(): OutboxScopeSummary | null {
  const store = scopeStorage.getStore()
  return store ? snapshot(store) : null
}

export function withOutboxMessageKind<T>(
  messageKind: OutboxMessageKind,
  fn: () => T,
): T {
  const current = decorationStorage.getStore() ?? {}
  return decorationStorage.run({ ...current, messageKind }, fn)
}

export function withOutboxResource<T>(
  resource: OutboxResourceMetadata,
  fn: () => T,
): T {
  const current = decorationStorage.getStore() ?? {}
  return decorationStorage.run({ ...current, resource }, fn)
}

async function fenceUnsafeFallback(
  store: OutboxScopeStore,
  incident: UnsafeFallbackIncident,
): Promise<void> {
  if (!store.beforeUnsafeFallback) {
    throw new Error('Inbound scope has no durable unsafe-fallback fence')
  }
  if (!store.unsafeFallbackFence) {
    store.unsafeFallbackFence = store.beforeUnsafeFallback(incident).then(() => {
      store.unsafeFallbackFenced = true
    })
  }
  await store.unsafeFallbackFence
}

export function createScopedSendOptions(): SendTextMessageOptions | undefined {
  const store = scopeStorage.getStore()
  if (!store) return undefined
  if (store.idempotencyConflict) {
    throw new OutboxIdempotencyConflictError(
      store.conflictError ?? 'Inbound outbox scope is blocked by an idempotency conflict',
    )
  }

  const decoration = decorationStorage.getStore() ?? {}
  const emissionIndex = store.nextIndex++
  const messageKind = decoration.messageKind ?? 'terminal'
  const resource = decoration.resource
  const options: SendTextMessageOptions = {
    source: 'bot',
    messageKind,
    idempotencyKey: buildInboundKey(store.workId, emissionIndex),
    userId: store.userId,
    workId: store.workId,
    emissionIndex,
    ...(resource
      ? {
          resourceType: resource.resourceType,
          resourceId: resource.resourceId,
          resourceMetadata: resource.resourceMetadata ?? null,
        }
      : {}),
    ...(messageKind === 'progress'
      ? { expiresAt: new Date(store.now().getTime() + 5 * 60_000) }
      : {}),
    ...(messageKind === 'progress'
      ? {}
      : {
          beforeUnsafeFallback: (incident: UnsafeFallbackIncident) =>
            fenceUnsafeFallback(store, incident),
        }),
  }

  store.emissions.push({
    emissionIndex,
    messageKind,
    options,
    outboxId: null,
    providerMessageId: null,
    durablyEnqueued: false,
    preventInboundReplay: false,
    error: null,
  })
  return options
}

function emissionFor(
  store: OutboxScopeStore,
  options: SendTextMessageOptions,
): MutableEmission | undefined {
  return store.emissions.find(
    (emission) => emission.emissionIndex === options.emissionIndex &&
      emission.options.idempotencyKey === options.idempotencyKey,
  )
}

export function recordScopedOutboxResult(
  options: SendTextMessageOptions,
  result: OutboxSendResult,
): void {
  const store = scopeStorage.getStore()
  if (!store) return
  const emission = emissionFor(store, options)
  if (!emission) return

  emission.outboxId = result.outboxId
  emission.providerMessageId = result.providerMessageId
  emission.durablyEnqueued = result.durablyEnqueued
  emission.preventInboundReplay = result.preventInboundReplay
  if (result.preventInboundReplay) store.unsafeFallbackFenced = true
  // Only suppress the legacy outgoing insert when the outbox attempt result
  // was actually persisted (and thus projected). Meta acceptance alone is not enough.
  if (
    result.attemptResultPersisted &&
    result.outboxId &&
    result.providerMessageId
  ) {
    store.projectedProviderMessages.add(result.providerMessageId)
  }
}

export function recordScopedOutboxError(
  options: SendTextMessageOptions,
  error: unknown,
): void {
  const store = scopeStorage.getStore()
  if (!store) return
  const emission = emissionFor(store, options)
  const message = error instanceof Error ? error.message : String(error)
  if (emission) {
    emission.error = message
  }
  if (
    error instanceof OutboxIdempotencyConflictError ||
    (error instanceof Error && error.name === 'OutboxIdempotencyConflictError')
  ) {
    store.idempotencyConflict = true
    store.conflictError = message
  }
}

export function scheduleScopedOutboxSend<T>(
  task: () => Promise<T>,
): Promise<T> {
  const store = scopeStorage.getStore()
  if (!store) return task()

  const result = store.sendChain.then(task)
  store.sendChain = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export function isOutboxProjectedProviderMessage(
  providerMessageId: string,
): boolean {
  return scopeStorage.getStore()?.projectedProviderMessages.has(providerMessageId) ?? false
}
