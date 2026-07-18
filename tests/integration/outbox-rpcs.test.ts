import { execFile, execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashPayload } from '@/lib/outbox/policy'
import { createOutboxDeliveryService } from '@/lib/outbox/service'
import {
  beginOutboxFallbackAttempt,
  claimOutboxMessages,
  enqueueOutboxMessage,
  fenceOutboxFallback,
  recordOutboxAttemptResult,
} from '@/lib/outbox/repository'
import { resetIntegrationDb } from './helpers/db-reset'
import { getDbContainerName } from './helpers/ensure-grants'
import { getIntegrationSupabase } from './helpers/supabase-local'

type RpcRow = Record<string, unknown>

type AdminExecOutcome =
  | { status: 'fulfilled' }
  | { status: 'rejected'; reason: unknown }

type TrackedAdminExec = {
  readonly settled: Promise<AdminExecOutcome>
  readonly outcome: AdminExecOutcome | undefined
}

type ExplicitAdminGate = {
  readonly ready: Promise<void>
  release(): Promise<void>
  close(): Promise<void>
}

const execFileAsync = promisify(execFile)

const GENERATION = 'outbox-test-gen'
const RECIPIENT = '351900000001'
const OUTBOX_MIGRATION_PATH = 'supabase/migrations/20260713120000_outbox_messages.sql'

const privilegedRpcs = [
  'public.enqueue_outbox_message(text,text,text,text,text,jsonb,text,text,text,integer,timestamptz,uuid,uuid,integer,text,text,uuid,jsonb)',
  'public.fence_outbox_fallback(text,text,text,text,text,text,text)',
  'public.begin_outbox_fallback_attempt(uuid,text,integer)',
  'public.claim_outbox_messages(text,text,integer,integer,uuid,boolean)',
  'public.record_outbox_attempt_result(uuid,uuid,text,text,timestamptz,integer,integer,integer,text,text,jsonb)',
  'public.apply_outbox_callback(text,text,timestamptz,uuid,integer,integer,text,jsonb)',
  'public.finalize_outbox_scope(uuid,uuid,text,timestamptz)',
  'public.list_outbox_sweeper_work(text,integer)',
  'public.suspend_outbox_generation(text,text)',
  'public.redact_outbox_payloads(integer)',
] as const

const migrationFunctionSignatures = [
  'private.project_outbox_bot_message(uuid,text)',
  ...privilegedRpcs,
] as const

function stripSqlComments(sql: string): string {
  let result = ''
  let index = 0
  let quoted: "'" | '"' | undefined
  let dollarTag: string | undefined

  while (index < sql.length) {
    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        result += dollarTag
        index += dollarTag.length
        dollarTag = undefined
      } else {
        result += sql[index]
        index += 1
      }
      continue
    }

    if (quoted) {
      result += sql[index]
      if (sql[index] === quoted) {
        if (sql[index + 1] === quoted) {
          result += sql[index + 1]
          index += 2
          continue
        }
        quoted = undefined
      }
      index += 1
      continue
    }

    if (sql.startsWith('--', index)) {
      const newlineIndex = sql.indexOf('\n', index + 2)
      if (newlineIndex === -1) break
      result += '\n'
      index = newlineIndex + 1
      continue
    }

    if (sql.startsWith('/*', index)) {
      let depth = 1
      index += 2
      while (index < sql.length && depth > 0) {
        if (sql.startsWith('/*', index)) {
          depth += 1
          index += 2
        } else if (sql.startsWith('*/', index)) {
          depth -= 1
          index += 2
        } else {
          if (sql[index] === '\n') result += '\n'
          index += 1
        }
      }
      if (depth > 0) throw new Error('Unterminated SQL block comment')
      result += ' '
      continue
    }

    if (sql[index] === "'" || sql[index] === '"') {
      quoted = sql[index] as "'" | '"'
      result += sql[index]
      index += 1
      continue
    }

    if (sql[index] === '$') {
      const tag = sql.slice(index).match(/^\$(?:[a-z_][a-z0-9_]*)?\$/i)?.[0]
      if (tag) {
        dollarTag = tag
        result += tag
        index += tag.length
        continue
      }
    }

    result += sql[index]
    index += 1
  }

  return result
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  const withoutComments = stripSqlComments(sql)
  let current = ''
  let quoted: "'" | '"' | undefined
  let dollarTag: string | undefined

  for (let index = 0; index < withoutComments.length; index += 1) {
    if (dollarTag) {
      if (withoutComments.startsWith(dollarTag, index)) {
        current += dollarTag
        index += dollarTag.length - 1
        dollarTag = undefined
      } else {
        current += withoutComments[index]
      }
      continue
    }

    if (quoted) {
      current += withoutComments[index]
      if (withoutComments[index] === quoted) {
        if (withoutComments[index + 1] === quoted) {
          current += withoutComments[index + 1]
          index += 1
        } else {
          quoted = undefined
        }
      }
      continue
    }

    if (withoutComments[index] === "'" || withoutComments[index] === '"') {
      quoted = withoutComments[index] as "'" | '"'
      current += withoutComments[index]
      continue
    }

    if (withoutComments[index] === '$') {
      const tag = withoutComments.slice(index)
        .match(/^\$(?:[a-z_][a-z0-9_]*)?\$/i)?.[0]
      if (tag) {
        dollarTag = tag
        current += tag
        index += tag.length - 1
        continue
      }
    }

    current += withoutComments[index]
    if (withoutComments[index] === ';') {
      statements.push(current.trim())
      current = ''
    }
  }

  if (current.trim()) statements.push(current.trim())
  return statements
}

function splitSqlArguments(argumentsSql: string): string[] {
  const argumentsList: string[] = []
  let current = ''
  let depth = 0
  let quoted: "'" | '"' | undefined
  let dollarTag: string | undefined

  for (let index = 0; index < argumentsSql.length; index += 1) {
    if (dollarTag) {
      if (argumentsSql.startsWith(dollarTag, index)) {
        current += dollarTag
        index += dollarTag.length - 1
        dollarTag = undefined
      } else {
        current += argumentsSql[index]
      }
      continue
    }

    if (quoted) {
      current += argumentsSql[index]
      if (argumentsSql[index] === quoted) {
        if (argumentsSql[index + 1] === quoted) {
          current += argumentsSql[index + 1]
          index += 1
        } else {
          quoted = undefined
        }
      }
      continue
    }

    if (argumentsSql[index] === "'" || argumentsSql[index] === '"') {
      quoted = argumentsSql[index] as "'" | '"'
      current += argumentsSql[index]
      continue
    }

    if (argumentsSql[index] === '$') {
      const tag = argumentsSql.slice(index)
        .match(/^\$(?:[a-z_][a-z0-9_]*)?\$/i)?.[0]
      if (tag) {
        dollarTag = tag
        current += tag
        index += tag.length - 1
        continue
      }
    }

    if (argumentsSql[index] === '(') depth += 1
    if (argumentsSql[index] === ')') depth -= 1

    if (argumentsSql[index] === ',' && depth === 0) {
      argumentsList.push(current.trim())
      current = ''
    } else {
      current += argumentsSql[index]
    }
  }

  if (current.trim()) argumentsList.push(current.trim())
  return argumentsList
}

function extractFunctionSignatures(sql: string): string[] {
  const definitionPrefix = /^CREATE\s+OR\s+REPLACE\s+FUNCTION\b/i
  const definitionPattern = /^CREATE\s+OR\s+REPLACE\s+FUNCTION\s+([a-z_][a-z0-9_$]*\s*\.\s*[a-z_][a-z0-9_$]*)\s*\(([\s\S]*?)\)\s*RETURNS\b/i

  return splitSqlStatements(sql)
    .filter((statement) => definitionPrefix.test(statement))
    .map((statement) => {
      const match = statement.match(definitionPattern)
      if (!match) {
        throw new Error('Unable to parse top-level function definition')
      }
      const qualifiedName = match[1].toLowerCase().replace(/\s*\.\s*/g, '.')
      const argumentTypes = splitSqlArguments(match[2]).map((argument) => {
        const declaration = argument
          .replace(/\s+(?:DEFAULT\b|=)[\s\S]*$/i, '')
          .trim()
        const declarationMatch = declaration.match(
          /^(?:(?:IN|OUT|INOUT|VARIADIC)\s+)?(?:[a-z_][a-z0-9_$]*|"(?:[^"]|"")+")\s+(.+)$/i,
        )
        if (!declarationMatch) {
          throw new Error(`Unable to parse function argument: ${argument}`)
        }
        return declarationMatch[1].toLowerCase().replace(/\s+/g, ' ').trim()
      })

      return `${qualifiedName}(${argumentTypes.join(',')})`
    })
}

function expiresIn(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

async function createInboundWork(
  providerMessageId: string,
  recipient: string,
): Promise<string> {
  const supabase = getIntegrationSupabase()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('enqueue_inbound_work', {
    p_provider: 'whatsapp_cloud',
    p_business_account_id: 'PHONE_NUMBER_ID',
    p_provider_message_id: providerMessageId,
    p_user_phone: recipient,
    p_event_at: new Date().toISOString(),
    p_payload_json: { type: 'text', text: providerMessageId },
  })
  if (error) throw new Error(error.message)
  return data[0].work_id as string
}

function adminRows(sql: string): RpcRow[] {
  const wrapped = `SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json)::text FROM (${sql}) q;`
  const stdout = execFileSync(
    'docker',
    [
      'exec',
      '-i',
      getDbContainerName(),
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      wrapped,
    ],
    { encoding: 'utf8' },
  ).trim()
  return JSON.parse(stdout || '[]') as RpcRow[]
}

function adminPlan(sql: string): string {
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      getDbContainerName(),
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `SET enable_seqscan = off; EXPLAIN (COSTS OFF) ${sql}`,
    ],
    { encoding: 'utf8' },
  ).trim()
}

function adminExec(sql: string): void {
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      getDbContainerName(),
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

async function adminExecAsync(sql: string): Promise<void> {
  await execFileAsync(
    'docker',
    [
      'exec',
      '-i',
      getDbContainerName(),
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { encoding: 'utf8', timeout: 7_500, killSignal: 'SIGKILL' },
  )
}

function trackAdminExec(sql: string): TrackedAdminExec {
  let outcome: AdminExecOutcome | undefined
  const settled = adminExecAsync(sql).then<
    AdminExecOutcome,
    AdminExecOutcome
  >(
    () => {
      outcome = { status: 'fulfilled' }
      return outcome
    },
    (reason: unknown) => {
      outcome = { status: 'rejected', reason }
      return outcome
    },
  )

  return {
    settled,
    get outcome() {
      return outcome
    },
  }
}

function openExplicitAdminGate(
  lockKey: string,
  readyMarker: string,
  timeoutMs: number = 3_000,
): ExplicitAdminGate {
  const child = spawn(
    'docker',
    [
      'exec',
      '-i',
      getDbContainerName(),
      'psql',
      '-X',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  let stdout = ''
  let stderr = ''
  let readyObserved = false
  let finishPromise: Promise<void> | undefined

  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  child.stdin.on('error', (error: Error) => {
    stderr += `stdin error: ${error.message}\n`
  })

  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', (error) => {
      reject(new Error(`Failed to start database gate: ${readyMarker}`, {
        cause: error,
      }))
    })
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(
        `Database gate exited unexpectedly: ${readyMarker}; `
          + `code=${String(code)} signal=${String(signal)} stderr=${stderr.trim()}`,
      ))
    })
  })

  const ready = new Promise<void>((resolve, reject) => {
    const observeReady = (): void => {
      if (!stdout.includes(readyMarker)) return
      readyObserved = true
      clearTimeout(timeout)
      child.stdout.off('data', observeReady)
      resolve()
    }
    const timeout = setTimeout(() => {
      child.stdout.off('data', observeReady)
      reject(new Error(
        `Timed out waiting for database gate readiness: ${readyMarker}; `
          + `stdout=${stdout.trim()} stderr=${stderr.trim()}`,
      ))
    }, timeoutMs)

    child.stdout.on('data', observeReady)
    void exited.then(
      () => {
        if (readyObserved) return
        clearTimeout(timeout)
        child.stdout.off('data', observeReady)
        reject(new Error(
          `Database gate exited before readiness: ${readyMarker}; `
            + `stdout=${stdout.trim()} stderr=${stderr.trim()}`,
        ))
      },
      (error: unknown) => {
        if (readyObserved) return
        clearTimeout(timeout)
        child.stdout.off('data', observeReady)
        reject(error)
      },
    )
  })

  const escapedLockKey = lockKey.replaceAll("'", "''")
  const escapedReadyMarker = readyMarker.replaceAll("'", "''")
  child.stdin.write(`
    SET statement_timeout = '5s';
    BEGIN;
    SELECT pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('${escapedLockKey}', 0)
    );
    SELECT '${escapedReadyMarker}';
  `)

  const finish = (command: 'COMMIT' | 'ROLLBACK'): Promise<void> => {
    if (finishPromise) return finishPromise

    finishPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.stdin.destroy()
        child.kill('SIGKILL')
        reject(new Error(
          `Timed out closing database gate with ${command}: ${readyMarker}; `
            + `stdout=${stdout.trim()} stderr=${stderr.trim()}`,
        ))
      }, timeoutMs)

      void exited.then(
        () => {
          clearTimeout(timeout)
          resolve()
        },
        (error: unknown) => {
          clearTimeout(timeout)
          reject(error)
        },
      )
      child.stdin.write(`${command};\n\\q\n`)
    })
    return finishPromise
  }

  return {
    ready,
    release: () => finish('COMMIT'),
    close: () => finish('ROLLBACK'),
  }
}

function sessionEndedBeforeActivity(
  marker: string,
  session: TrackedAdminExec,
): void {
  if (session.outcome?.status === 'fulfilled') {
    throw new Error(
      `Database session completed before activity was observed: ${marker}`,
    )
  }
  if (session.outcome?.status === 'rejected') {
    throw new Error(
      `Database session failed before activity was observed: ${marker}`,
      { cause: session.outcome.reason },
    )
  }
}

function assertAdminExecSucceeded(
  marker: string,
  outcome: AdminExecOutcome,
): void {
  if (outcome.status === 'rejected') {
    throw new Error(`Database session failed after activity: ${marker}`, {
      cause: outcome.reason,
    })
  }
}

async function waitForDbActivity(
  marker: string,
  waitEvent: string,
  session: TrackedAdminExec,
  timeoutMs: number = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const escapedMarker = marker.replaceAll("'", "''")
  const escapedEvent = waitEvent.replaceAll("'", "''")

  while (Date.now() < deadline) {
    sessionEndedBeforeActivity(marker, session)
    const observed = adminRows(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_stat_activity
        WHERE query ILIKE '%${escapedMarker}%'
          AND pid <> pg_backend_pid()
          AND wait_event = '${escapedEvent}'
      ) AS observed
    `)[0]?.observed
    if (observed === true) return
    await Promise.race([
      session.settled,
      new Promise((resolve) => setTimeout(resolve, 25)),
    ])
  }

  sessionEndedBeforeActivity(marker, session)
  throw new Error(`Timed out waiting for database activity: ${marker}`)
}

async function enqueue(
  key: string,
  overrides: Partial<{
    recipient: string
    userId: string | null
    workId: string | null
    emissionIndex: number | null
    kind: 'progress' | 'prompt' | 'terminal' | 'otp' | 'reminder'
    payload: Record<string, unknown>
    payloadHash: string
    rolloutMode: 'shadow' | 'active'
    generation: string
    maxAttempts: number
    expiresAt: string
    resourceType: string | null
    resourceId: string | null
    resourceMetadata: Record<string, unknown> | null
  }> = {},
): Promise<RpcRow> {
  const payload = overrides.payload ?? { type: 'text', text: key }
  const supabase = getIntegrationSupabase()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('enqueue_outbox_message', {
    p_provider: 'whatsapp_cloud',
    p_business_account_id: 'PHONE_NUMBER_ID',
    p_recipient: overrides.recipient ?? RECIPIENT,
    p_user_id: overrides.userId ?? null,
    p_work_id: overrides.workId ?? null,
    p_emission_index: overrides.emissionIndex ?? null,
    p_idempotency_key: key,
    p_message_kind: overrides.kind ?? 'terminal',
    p_payload_json: payload,
    p_payload_hash: overrides.payloadHash ?? hashPayload(payload),
    p_reply_to_message_id: null,
    p_resource_type: overrides.resourceType ?? null,
    p_resource_id: overrides.resourceId ?? null,
    p_resource_metadata: overrides.resourceMetadata ?? null,
    p_rollout_mode: overrides.rolloutMode ?? 'active',
    p_rollout_generation: overrides.generation ?? GENERATION,
    p_max_attempts: overrides.maxAttempts ?? 5,
    p_expires_at: overrides.expiresAt ?? expiresIn(15),
  })
  if (error) throw new Error(error.message)
  return data[0] as RpcRow
}

async function claim(
  owner: string,
  generation: string = GENERATION,
  leaseSeconds: number = 90,
  outboxId: string | null = null,
  allowUnfinalized: boolean = false,
): Promise<RpcRow[]> {
  const supabase = getIntegrationSupabase()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('claim_outbox_messages', {
    p_owner: owner,
    p_generation: generation,
    p_limit: 10,
    p_lease_seconds: leaseSeconds,
    p_outbox_id: outboxId,
    p_allow_unfinalized: allowUnfinalized,
  })
  if (error) throw new Error(error.message)
  return data as RpcRow[]
}

async function recordResult(
  claimed: RpcRow,
  outcome: 'api_accepted' | 'retryable' | 'failed_terminal' | 'unknown',
  providerMessageId: string | null = null,
): Promise<RpcRow> {
  const supabase = getIntegrationSupabase()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc(
    'record_outbox_attempt_result',
    {
      p_outbox_id: claimed.outbox_id,
      p_lease_token: claimed.lease_token,
      p_outcome: outcome,
      p_provider_message_id: providerMessageId,
      p_next_attempt_at:
        outcome === 'retryable' ? new Date(Date.now() - 1_000).toISOString() : null,
      p_http_status: outcome === 'retryable' ? 429 : 200,
      p_meta_code: outcome === 'retryable' ? 130429 : null,
      p_meta_subcode: null,
      p_error_code: outcome === 'retryable' ? 'meta:130429' : null,
      p_error_message: outcome === 'retryable' ? 'rate limited' : null,
      p_response_json: { outcome },
    },
  )
  if (error) throw new Error(error.message)
  return data[0] as RpcRow
}

async function fenceFallback(
  key: string,
  payloadHash: string,
  overrides: Partial<{
    recipient: string
    generation: string
  }> = {},
): Promise<RpcRow> {
  const supabase = getIntegrationSupabase()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc(
    'fence_outbox_fallback',
    {
      p_provider: 'whatsapp_cloud',
      p_business_account_id: 'PHONE_NUMBER_ID',
      p_recipient: overrides.recipient ?? RECIPIENT,
      p_idempotency_key: key,
      p_payload_hash: payloadHash,
      p_rollout_generation: overrides.generation ?? GENERATION,
      p_reason: 'ambiguous_enqueue_result',
    },
  )
  if (error) throw new Error(error.message)
  return data[0] as RpcRow
}

async function beginFallbackAttempt(
  row: RpcRow,
  key: string,
  leaseSeconds: number = 90,
): Promise<RpcRow> {
  const supabase = getIntegrationSupabase()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc(
    'begin_outbox_fallback_attempt',
    {
      p_outbox_id: row.outbox_id,
      p_idempotency_key: key,
      p_lease_seconds: leaseSeconds,
    },
  )
  if (error) throw new Error(error.message)
  return data[0] as RpcRow
}

async function suspendGeneration(
  generation: string,
  reason: string,
): Promise<RpcRow> {
  const supabase = getIntegrationSupabase()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc(
    'suspend_outbox_generation',
    {
      p_generation: generation,
      p_reason: reason,
    },
  )
  if (error) throw new Error(error.message)
  return data[0] as RpcRow
}

async function callback(
  providerMessageId: string,
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'unknown',
  outboxId: string | null = null,
  overrides: Partial<{
    eventAt: string
    metaCode: number | null
    metaSubcode: number | null
    errorMessage: string | null
  }> = {},
): Promise<RpcRow> {
  const supabase = getIntegrationSupabase()
  const args: Record<string, unknown> = {
    p_provider_message_id: providerMessageId,
    p_callback_status: status,
    p_event_at: overrides.eventAt ?? new Date().toISOString(),
    p_outbox_id: outboxId,
    p_meta_code: overrides.metaCode ?? (status === 'failed' ? 131026 : null),
    p_error_message:
      overrides.errorMessage ?? (status === 'failed' ? 'undeliverable' : null),
    p_callback_json: { id: providerMessageId, status },
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'metaSubcode')) {
    args.p_meta_subcode = overrides.metaSubcode ?? null
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc(
    'apply_outbox_callback',
    args,
  )
  if (error) throw new Error(error.message)
  return data[0] as RpcRow
}

describe('durable outbox RPCs', () => {
  beforeEach(() => {
    resetIntegrationDb()
  })

  it('keeps maintenance predicates planner-usable without weakening claims', () => {
    const predicates = adminRows(`
      SELECT index_class.relname AS index_name,
        pg_catalog.pg_get_expr(index_catalog.indpred, index_catalog.indrelid)
          AS predicate
      FROM pg_catalog.pg_index AS index_catalog
      JOIN pg_catalog.pg_class AS index_class
        ON index_class.oid = index_catalog.indexrelid
      WHERE index_class.relname IN (
        'outbox_messages_claim_idx',
        'outbox_messages_expiry_idx',
        'outbox_messages_stale_lease_idx',
        'outbox_messages_terminal_lease_idx',
        'outbox_messages_unknown_reconcile_idx'
      )
      ORDER BY index_class.relname
    `)
    const claimDefinition = String(adminRows(`
      SELECT pg_catalog.pg_get_functiondef(
        'public.claim_outbox_messages(text,text,integer,integer,uuid,boolean)'
          ::regprocedure
      ) AS definition
    `)[0]?.definition)
    const normalizedClaimDefinition = claimDefinition.replace(/\s+/g, ' ')
    const eligibility = adminRows(`
      SELECT label,
        (
          status IN ('sending', 'unknown')
          OR (delivery_authority AND status IN ('pending', 'retryable'))
        ) AS expiry_eligible
      FROM (
        VALUES
          ('shadow_pending', 'pending'::text, FALSE),
          ('active_pending', 'pending'::text, TRUE),
          ('shadow_sending', 'sending'::text, FALSE)
      ) AS cases(label, status, delivery_authority)
      ORDER BY label
    `)
    const expiryPlan = adminPlan(`
      SELECT om.id, om.recipient
      FROM public.outbox_messages AS om
      WHERE om.rollout_generation = 'planner-expiry-generation'
        AND (NULL::UUID IS NULL OR om.id = NULL::UUID)
        AND (
          om.status IN ('sending', 'unknown')
          OR (
            om.delivery_authority
            AND om.status IN ('pending', 'retryable')
          )
        )
        AND om.expires_at <= NOW()
      ORDER BY om.expires_at, om.id
      LIMIT 10
    `)

    expect(predicates).toEqual([
      {
        index_name: 'outbox_messages_claim_idx',
        predicate: 'delivery_authority',
      },
      {
        index_name: 'outbox_messages_expiry_idx',
        predicate:
          "((status = ANY (ARRAY['sending'::text, 'unknown'::text])) OR (delivery_authority AND (status = ANY (ARRAY['pending'::text, 'retryable'::text]))))",
      },
      {
        index_name: 'outbox_messages_stale_lease_idx',
        predicate: "(status = 'sending'::text)",
      },
      {
        index_name: 'outbox_messages_terminal_lease_idx',
        predicate:
          "((lease_token IS NOT NULL) AND (status = ANY (ARRAY['api_accepted'::text, 'sent'::text, 'delivered'::text, 'read'::text, 'failed_terminal'::text, 'expired'::text, 'superseded'::text, 'suspended'::text])))",
      },
      {
        index_name: 'outbox_messages_unknown_reconcile_idx',
        predicate: "((status = 'unknown'::text) AND (terminal_at IS NULL))",
      },
    ])
    expect(normalizedClaimDefinition).toContain(
      "AND ( om.status IN ('sending', 'unknown') OR ( om.delivery_authority AND om.status IN ('pending', 'retryable') ) ) AND om.expires_at <= v_now",
    )
    expect(normalizedClaimDefinition).toContain(
      "OR NOT ( v_row.status IN ('sending', 'unknown') OR ( v_row.delivery_authority AND v_row.status IN ('pending', 'retryable') ) ) OR v_row.expires_at > v_now",
    )
    expect(eligibility).toEqual([
      { label: 'active_pending', expiry_eligible: true },
      { label: 'shadow_pending', expiry_eligible: false },
      { label: 'shadow_sending', expiry_eligible: true },
    ])
    expect(expiryPlan).toContain(
      'Index Scan using outbox_messages_expiry_idx',
    )
  })

  it('enqueues idempotently and rejects a key reused with another hash', async () => {
    const first = await enqueue('inbound:work-1:0')
    const duplicate = await enqueue('inbound:work-1:0')
    const conflict = await enqueue('inbound:work-1:0', {
      payload: { type: 'text', text: 'different' },
    })

    expect(first).toMatchObject({ was_inserted: true, idempotency_conflict: false })
    expect(duplicate).toMatchObject({
      outbox_id: first.outbox_id,
      was_inserted: false,
      idempotency_conflict: false,
    })
    expect(conflict).toMatchObject({
      outbox_id: first.outbox_id,
      was_inserted: false,
      idempotency_conflict: true,
    })
  })

  it('allocates one monotonic recipient sequence under concurrency', async () => {
    const rows = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        enqueue(`inbound:concurrent:${index}`),
      ),
    )
    const sequences = rows
      .map((row) => Number(row.sequence_no))
      .sort((left, right) => left - right)

    expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('claims FIFO, one head per recipient, and never claims shadow rows', async () => {
    const first = await enqueue('fifo:1')
    const second = await enqueue('fifo:2')
    await enqueue('shadow:1', {
      recipient: '351900000002',
      rolloutMode: 'shadow',
    })

    const firstClaim = await claim('worker-a')
    expect(firstClaim.map((row) => row.outbox_id)).toEqual([first.outbox_id])

    await recordResult(firstClaim[0], 'api_accepted', 'wamid.fifo-1')
    const secondClaim = await claim('worker-b')
    expect(secondClaim.map((row) => row.outbox_id)).toEqual([second.outbox_id])
  })

  it('targets an inline claim without bypassing recipient FIFO', async () => {
    const first = await enqueue('targeted:1', {
      recipient: '351900000041',
    })
    const second = await enqueue('targeted:2', {
      recipient: '351900000041',
    })
    const other = await enqueue('targeted:other', {
      recipient: '351900000042',
    })

    expect(
      await claim(
        'inline:blocked-head',
        GENERATION,
        90,
        second.outbox_id as string,
      ),
    ).toEqual([])
    const targeted = await claim(
      'inline:other-recipient',
      GENERATION,
      90,
      other.outbox_id as string,
    )
    expect(targeted.map((row) => row.outbox_id)).toEqual([other.outbox_id])
    expect(
      adminRows(
        `SELECT status FROM public.outbox_messages WHERE id = '${first.outbox_id}'`,
      )[0],
    ).toMatchObject({ status: 'pending' })
  })

  it('derives claim start headroom from the requested lease', async () => {
    const row = await enqueue('claim:dynamic-headroom', {
      recipient: '351900000061',
      expiresAt: expiresIn(20),
    })

    expect(await claim(
      'claim-headroom-too-short',
      GENERATION,
      900,
      row.outbox_id as string,
    )).toEqual([])
    expect(adminRows(`
      SELECT status, attempt, lease_token, lease_expires_at
      FROM public.outbox_messages
      WHERE id = '${row.outbox_id}'
    `)[0]).toEqual({
      status: 'pending',
      attempt: 0,
      lease_token: null,
      lease_expires_at: null,
    })

    const accepted = await claim(
      'claim-headroom-safe',
      GENERATION,
      90,
      row.outbox_id as string,
    )
    expect(accepted.map((claimed) => claimed.outbox_id)).toEqual([
      row.outbox_id,
    ])
    expect(accepted[0]).toMatchObject({ attempt: 1 })
    expect(accepted[0]?.lease_token).toEqual(expect.any(String))
  })

  it('fences a committed pending enqueue before direct fallback', async () => {
    const key = 'fallback:committed-before-drop'
    const payload = { type: 'text', text: key }
    const row = await enqueue(key, { payload })

    const fenced = await fenceFallback(key, hashPayload(payload))

    expect(fenced).toMatchObject({
      safe_for_direct: true,
      outbox_id: row.outbox_id,
      status: 'suspended',
      idempotency_conflict: false,
    })
    expect(await claim('worker-after-fallback-fence')).toEqual([])
    expect(await enqueue(key, { payload })).toMatchObject({
      outbox_id: row.outbox_id,
      was_inserted: false,
      status: 'suspended',
    })
  })

  it('makes a late enqueue born suspended when the fence wins first', async () => {
    const key = 'fallback:fence-before-enqueue'
    const payload = { type: 'text', text: key }

    expect(await fenceFallback(key, hashPayload(payload))).toMatchObject({
      safe_for_direct: true,
      outbox_id: null,
      status: null,
      idempotency_conflict: false,
    })
    const row = await enqueue(key, { payload })

    expect(row).toMatchObject({
      was_inserted: true,
      status: 'suspended',
    })
    expect(await claim('worker-after-late-enqueue')).toEqual([])
  })

  it('refuses an existing fallback fence after generation suspension', async () => {
    const generation = 'outbox-fallback-fenced-generation'
    const key = 'fallback:fenced-generation'
    const payload = { type: 'text', text: key }

    expect(await fenceFallback(key, hashPayload(payload), { generation }))
      .toMatchObject({ safe_for_direct: true, outbox_id: null })
    await suspendGeneration(generation, 'rollback-after-fence')

    expect(await fenceFallback(key, hashPayload(payload), { generation }))
      .toMatchObject({
        safe_for_direct: false,
        outbox_id: null,
        idempotency_conflict: false,
      })
  })

  it('starts a newly inserted shadow row only through a durable lease', async () => {
    const key = 'shadow-direct:start'
    const row = await enqueue(key, { rolloutMode: 'shadow' })
    const begun = await beginFallbackAttempt(row, key)

    expect(begun).toMatchObject({
      started: true,
      status: 'sending',
      attempt: 1,
    })
    expect(begun.lease_token).toEqual(expect.any(String))
    expect(adminRows(`
      SELECT status, lease_token IS NOT NULL AS leased
      FROM public.outbox_messages
      WHERE id = '${row.outbox_id}'
    `)[0]).toMatchObject({ status: 'sending', leased: true })
    expect(adminRows(`
      SELECT event_type, previous_status, new_status
      FROM public.outbox_status_events
      WHERE outbox_id = '${row.outbox_id}'
        AND event_type = 'fallback_started'
    `)[0]).toMatchObject({
      event_type: 'fallback_started',
      previous_status: 'pending',
      new_status: 'sending',
    })
  })

  it('derives begin start headroom from the requested lease', async () => {
    const key = 'shadow-direct:dynamic-headroom'
    const row = await enqueue(key, {
      recipient: '351900000062',
      rolloutMode: 'shadow',
      expiresAt: expiresIn(20),
    })

    expect(await beginFallbackAttempt(row, key, 900)).toMatchObject({
      started: false,
      lease_token: null,
    })
    expect(adminRows(`
      SELECT status, attempt, lease_token, lease_expires_at
      FROM public.outbox_messages
      WHERE id = '${row.outbox_id}'
    `)[0]).toEqual({
      status: 'pending',
      attempt: 0,
      lease_token: null,
      lease_expires_at: null,
    })

    const accepted = await beginFallbackAttempt(row, key, 90)
    expect(accepted).toMatchObject({
      started: true,
      status: 'sending',
      attempt: 1,
    })
    expect(accepted.lease_token).toEqual(expect.any(String))
  })

  it('queues an active fallback behind an unresolved predecessor', async () => {
    const predecessor = await enqueue('fallback-fifo:predecessor')
    await claim(
      'fallback-fifo-owner',
      GENERATION,
      90,
      predecessor.outbox_id as string,
      true,
    )

    const key = 'fallback-fifo:terminal'
    const payload = { type: 'text', text: key }
    await fenceFallback(key, hashPayload(payload))
    const tombstone = await enqueue(key, { payload })
    const begun = await beginFallbackAttempt(tombstone, key)

    expect(begun).toMatchObject({
      started: false,
      lease_token: null,
      status: 'pending',
      attempt: 0,
    })
    expect(adminRows(`
      SELECT status, suspended_reason, delivery_authority,
        terminal_at IS NULL AS terminal_cleared,
        suspended_at IS NULL AS suspension_cleared
      FROM public.outbox_messages
      WHERE id = '${tombstone.outbox_id}'
    `)[0]).toMatchObject({
      status: 'pending',
      suspended_reason: null,
      delivery_authority: true,
      terminal_cleared: true,
      suspension_cleared: true,
    })
    expect(adminRows(`
      SELECT event_type, previous_status, new_status
      FROM public.outbox_status_events
      WHERE outbox_id = '${tombstone.outbox_id}'
        AND event_type = 'fallback_queued'
    `)[0]).toMatchObject({
      event_type: 'fallback_queued',
      previous_status: 'suspended',
      new_status: 'pending',
    })
  })

  it('terminal fallback supersedes an earlier retryable progress', async () => {
    const recipient = '351900000053'
    const workId = await createInboundWork(
      'wamid.fallback-supersedes-progress',
      recipient,
    )
    const progress = await enqueue('fallback-progress:retryable', {
      recipient,
      workId,
      emissionIndex: 0,
      kind: 'progress',
    })
    const [progressClaim] = await claim(
      'fallback-progress-owner',
      GENERATION,
      90,
      progress.outbox_id as string,
      true,
    )
    await recordResult(progressClaim, 'retryable')

    const key = 'fallback-progress:terminal'
    const payload = { type: 'text', text: key }
    await fenceFallback(key, hashPayload(payload), { recipient })
    const tombstone = await enqueue(key, {
      recipient,
      workId,
      emissionIndex: 1,
      kind: 'terminal',
      payload,
    })
    const begun = await beginFallbackAttempt(tombstone, key)

    expect(adminRows(`
      SELECT status, next_attempt_at
      FROM public.outbox_messages
      WHERE id = '${progress.outbox_id}'
    `)[0]).toEqual({ status: 'superseded', next_attempt_at: null })
    expect(adminRows(`
      SELECT event_type, previous_status, new_status
      FROM public.outbox_status_events
      WHERE outbox_id = '${progress.outbox_id}'
        AND event_type = 'superseded_by_response'
    `)).toEqual([{
      event_type: 'superseded_by_response',
      previous_status: 'retryable',
      new_status: 'superseded',
    }])
    expect(begun).toMatchObject({
      started: true,
      status: 'sending',
      attempt: 1,
    })
    expect(begun.lease_token).toEqual(expect.any(String))
  })

  it('keeps same-work progress outside the fallback recipient and rollout unchanged', async () => {
    const recipient = '351900000056'
    const otherRecipient = '351900000057'
    const otherGeneration = 'outbox-other-generation'
    const workId = await createInboundWork(
      'wamid.fallback-supersession-scope',
      recipient,
    )
    const foreignRecipientProgress = await enqueue(
      'fallback-progress:foreign-recipient',
      {
        recipient: otherRecipient,
        workId,
        emissionIndex: 0,
        kind: 'progress',
      },
    )
    const foreignGenerationProgress = await enqueue(
      'fallback-progress:foreign-generation',
      {
        recipient,
        workId,
        emissionIndex: 1,
        kind: 'progress',
        generation: otherGeneration,
      },
    )
    const shadowProgress = await enqueue('fallback-progress:shadow', {
      recipient,
      workId,
      emissionIndex: 2,
      kind: 'progress',
      rolloutMode: 'shadow',
    })
    const [foreignRecipientClaim] = await claim(
      'fallback-foreign-recipient-owner',
      GENERATION,
      90,
      foreignRecipientProgress.outbox_id as string,
      true,
    )
    const [foreignGenerationClaim] = await claim(
      'fallback-foreign-generation-owner',
      otherGeneration,
      90,
      foreignGenerationProgress.outbox_id as string,
      true,
    )
    await recordResult(foreignRecipientClaim, 'retryable')
    await recordResult(foreignGenerationClaim, 'retryable')

    const key = 'fallback-progress:scoped-terminal'
    const payload = { type: 'text', text: key }
    await fenceFallback(key, hashPayload(payload), { recipient })
    await enqueue(key, {
      recipient,
      workId,
      emissionIndex: 3,
      kind: 'terminal',
      payload,
    })

    expect(adminRows(`
      SELECT id, status
      FROM public.outbox_messages
      WHERE id IN (
        '${foreignRecipientProgress.outbox_id}',
        '${foreignGenerationProgress.outbox_id}',
        '${shadowProgress.outbox_id}'
      )
      ORDER BY id
    `)).toEqual(expect.arrayContaining([
      { id: foreignRecipientProgress.outbox_id, status: 'retryable' },
      { id: foreignGenerationProgress.outbox_id, status: 'retryable' },
      { id: shadowProgress.outbox_id, status: 'pending' },
    ]))
  })

  it('sweeper claims a queued fallback only after its predecessor resolves', async () => {
    const recipient = '351900000054'
    const predecessor = await enqueue('fallback-sweeper:predecessor', {
      recipient,
    })
    const [predecessorClaim] = await claim(
      'fallback-sweeper-predecessor',
      GENERATION,
      90,
      predecessor.outbox_id as string,
      true,
    )

    const key = 'fallback-sweeper:terminal'
    const payload = { type: 'text', text: key }
    await fenceFallback(key, hashPayload(payload), { recipient })
    const tombstone = await enqueue(key, { recipient, payload })
    expect(await beginFallbackAttempt(tombstone, key)).toMatchObject({
      started: false,
      status: 'pending',
      attempt: 0,
      lease_token: null,
    })

    expect(await claim(
      'fallback-sweeper-blocked',
      GENERATION,
      90,
      tombstone.outbox_id as string,
    )).toEqual([])
    await recordResult(
      predecessorClaim,
      'api_accepted',
      'wamid.fallback-sweeper-predecessor',
    )

    const claimed = await claim(
      'fallback-sweeper-released',
      GENERATION,
      90,
      tombstone.outbox_id as string,
    )
    expect(claimed.map((row) => row.outbox_id)).toEqual([tombstone.outbox_id])
  })

  it('unknown fallback blocks its successor until reconciliation', async () => {
    const recipient = '351900000055'
    const key = 'fallback-unknown:predecessor'
    const payload = { type: 'text', text: key }
    await fenceFallback(key, hashPayload(payload), { recipient })
    const tombstone = await enqueue(key, { recipient, payload })
    const begun = await beginFallbackAttempt(tombstone, key)
    expect(begun).toMatchObject({ started: true, status: 'sending' })
    expect(adminRows(`
      SELECT status, terminal_at IS NULL AS terminal_pending,
        suspended_at IS NULL AS suspension_cleared
      FROM public.outbox_messages
      WHERE id = '${tombstone.outbox_id}'
    `)[0]).toEqual({
      status: 'sending',
      terminal_pending: true,
      suspension_cleared: true,
    })
    await recordResult({
      outbox_id: tombstone.outbox_id,
      lease_token: begun.lease_token,
    }, 'unknown')

    expect(adminRows(`
      SELECT status, terminal_at IS NULL AS terminal_pending,
        unknown_reconcile_at IS NOT NULL AS reconcile_scheduled
      FROM public.outbox_messages
      WHERE id = '${tombstone.outbox_id}'
    `)[0]).toEqual({
      status: 'unknown',
      terminal_pending: true,
      reconcile_scheduled: true,
    })

    adminExec(`
      UPDATE public.outbox_messages
      SET unknown_reconcile_at = NOW() - INTERVAL '1 second'
      WHERE id = '${tombstone.outbox_id}'
    `)

    const successorKey = 'fallback-unknown:successor-after-deadline'
    const successorPayload = { type: 'text', text: successorKey }
    await fenceFallback(successorKey, hashPayload(successorPayload), {
      recipient,
    })
    const successor = await enqueue(successorKey, {
      recipient,
      payload: successorPayload,
    })
    expect(await beginFallbackAttempt(successor, successorKey)).toMatchObject({
      started: false,
      lease_token: null,
      status: 'pending',
      attempt: 0,
    })
    expect(await claim(
      'fallback-unknown-blocked-after-deadline',
      GENERATION,
      90,
      successor.outbox_id as string,
    )).toEqual([])
    expect(adminRows(`
      SELECT status, terminal_at IS NULL AS terminal_pending
      FROM public.outbox_messages
      WHERE id = '${tombstone.outbox_id}'
    `)[0]).toEqual({ status: 'unknown', terminal_pending: true })
    expect(adminRows(`
      SELECT status, attempt, lease_token,
        terminal_at IS NULL AS terminal_pending
      FROM public.outbox_messages
      WHERE id = '${successor.outbox_id}'
    `)[0]).toEqual({
      status: 'pending',
      attempt: 0,
      lease_token: null,
      terminal_pending: true,
    })

    const maintenance = await claimOutboxMessages(
      getIntegrationSupabase(),
      'fallback-unknown-maintenance',
      GENERATION,
      { limit: 0, leaseSeconds: 90 },
    )
    expect(maintenance).toEqual({ ok: true, rows: [] })
    expect(adminRows(`
      SELECT status, terminal_at IS NOT NULL AS terminal_reconciled
      FROM public.outbox_messages
      WHERE id = '${tombstone.outbox_id}'
    `)[0]).toEqual({ status: 'unknown', terminal_reconciled: true })
    expect(adminRows(`
      SELECT event_type, previous_status, new_status
      FROM public.outbox_status_events
      WHERE outbox_id = '${tombstone.outbox_id}'
        AND event_type = 'unknown_reconciled'
    `)).toEqual([{
      event_type: 'unknown_reconciled',
      previous_status: 'unknown',
      new_status: 'unknown',
    }])

    const claims = await claim(
      'fallback-unknown-reconciled',
      GENERATION,
      90,
      successor.outbox_id as string,
    )

    expect(claims.map((row) => row.outbox_id)).toEqual([successor.outbox_id])
  })

  it('refuses a fallback tombstone enqueued after generation suspension', async () => {
    const generation = 'outbox-fallback-after-rollback'
    const key = 'fallback:rollback-before-tombstone'
    const payload = { type: 'text', text: key }

    await fenceFallback(key, hashPayload(payload), { generation })
    await suspendGeneration(generation, 'rollback-before-tombstone')
    const row = await enqueue(key, { payload, generation })
    const begun = await beginOutboxFallbackAttempt(getIntegrationSupabase(), {
      outboxId: row.outbox_id as string,
      idempotencyKey: key,
    })

    expect(row).toMatchObject({ status: 'suspended', was_inserted: true })
    expect(begun).toMatchObject({
      ok: true,
      started: false,
      leaseToken: null,
      status: 'suspended',
      attempt: 0,
    })
    expect(adminRows(`
      SELECT attempt, lease_token, suspended_reason
      FROM public.outbox_messages
      WHERE id = '${row.outbox_id}'
    `)[0]).toEqual({
      attempt: 0,
      lease_token: null,
      suspended_reason: 'rollback-before-tombstone',
    })
    expect(adminRows(`
      SELECT COUNT(*)::integer AS count
      FROM public.outbox_status_events
      WHERE outbox_id = '${row.outbox_id}'
        AND event_type = 'fallback_started'
    `)[0]).toEqual({ count: 0 })
  })

  it('refuses an existing fallback tombstone after generation suspension', async () => {
    const generation = 'outbox-tombstone-before-rollback'
    const key = 'fallback:tombstone-before-rollback'
    const payload = { type: 'text', text: key }

    await fenceFallback(key, hashPayload(payload), { generation })
    const row = await enqueue(key, { payload, generation })
    await suspendGeneration(generation, '  rollback-after-tombstone  ')
    const begun = await beginOutboxFallbackAttempt(getIntegrationSupabase(), {
      outboxId: row.outbox_id as string,
      idempotencyKey: key,
    })

    expect(begun).toMatchObject({
      ok: true,
      started: false,
      leaseToken: null,
      status: 'suspended',
      attempt: 0,
    })
    expect(adminRows(`
      SELECT attempt, lease_token, suspended_reason
      FROM public.outbox_messages
      WHERE id = '${row.outbox_id}'
    `)[0]).toEqual({
      attempt: 0,
      lease_token: null,
      suspended_reason: 'rollback-after-tombstone',
    })
    expect(adminRows(`
      SELECT COUNT(*)::integer AS count
      FROM public.outbox_status_events
      WHERE outbox_id = '${row.outbox_id}'
        AND event_type = 'fallback_started'
    `)[0]).toEqual({ count: 0 })
  })

  it('records and correlates the single direct result on a fallback tombstone', async () => {
    const key = 'fallback:correlated-direct'
    const payload = { type: 'text', text: key }
    const row = await enqueue(key, { payload })
    await fenceFallback(key, hashPayload(payload))
    const supabase = getIntegrationSupabase()
    const begun = await beginOutboxFallbackAttempt(supabase, {
      outboxId: row.outbox_id as string,
      idempotencyKey: key,
    })
    expect(begun).toMatchObject({
      ok: true,
      started: true,
      status: 'sending',
      attempt: 1,
    })
    if (!begun.ok || !begun.leaseToken) {
      throw new Error('fallback attempt did not return a lease token')
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc(
      'record_outbox_attempt_result',
      {
        p_outbox_id: row.outbox_id,
        p_lease_token: begun.leaseToken,
        p_outcome: 'api_accepted',
        p_provider_message_id: 'wamid.fallback-correlated',
        p_next_attempt_at: null,
        p_http_status: 200,
        p_meta_code: null,
        p_meta_subcode: null,
        p_error_code: null,
        p_error_message: null,
        p_response_json: {
          messages: [{ id: 'wamid.fallback-correlated' }],
        },
      },
    )

    expect(error).toBeNull()
    expect(data[0]).toMatchObject({
      applied: true,
      status: 'api_accepted',
      provider_message_id: 'wamid.fallback-correlated',
    })
    expect(await fenceFallback(key, hashPayload(payload))).toMatchObject({
      safe_for_direct: false,
      outbox_id: row.outbox_id,
      status: 'api_accepted',
      provider_message_id: 'wamid.fallback-correlated',
    })
    expect(
      adminRows(`
        SELECT event_type, provider_message_id
        FROM public.outbox_status_events
        WHERE outbox_id = '${row.outbox_id}'
        ORDER BY created_at
      `),
    ).toContainEqual(expect.objectContaining({
      event_type: 'attempt_result',
      provider_message_id: 'wamid.fallback-correlated',
    }))
    expect(await claim('worker-after-fallback-result')).toEqual([])
  })

  it('prevents sweeper duplication after committed enqueue plus connection drop', async () => {
    const supabase = getIntegrationSupabase()
    const sendMeta = vi.fn().mockResolvedValue({
      kind: 'accepted' as const,
      providerMessageId: 'wamid.single-fallback',
      httpStatus: 200,
      response: { messages: [{ id: 'wamid.single-fallback' }] },
    })
    let firstEnqueue = true
    const ambiguousEnqueue: typeof enqueueOutboxMessage = async (
      client,
      input,
    ) => {
      const result = await enqueueOutboxMessage(client, input)
      if (firstEnqueue) {
        firstEnqueue = false
        expect(result.ok).toBe(true)
        throw new Error('connection dropped after commit')
      }
      return result
    }
    const service = createOutboxDeliveryService({
      getSupabase: () => supabase,
      enqueue: ambiguousEnqueue,
      claim: claimOutboxMessages,
      fenceFallback: fenceOutboxFallback,
      beginFallback: beginOutboxFallbackAttempt,
      recordAttempt: recordOutboxAttemptResult,
      sendMeta,
      now: () => new Date(),
      createOwner: () => 'inline:integration-fallback',
      readEnv: () => ({
        OUTBOX_MODE: 'active',
        OUTBOX_GENERATION: GENERATION,
        OUTBOX_CANARY_PERCENT: '100',
        WHATSAPP_PHONE_NUMBER_ID: 'PHONE_NUMBER_ID',
      }),
      reportCritical: vi.fn(),
    })

    const result = await service.sendText({
      to: RECIPIENT,
      text: 'single fallback after ambiguous commit',
      options: {
        source: 'reminder',
        messageKind: 'reminder',
        idempotencyKey: 'fallback:service-commit-drop',
        beforeUnsafeFallback: async () => undefined,
      },
    })

    expect(result).toMatchObject({
      providerMessageId: 'wamid.single-fallback',
      status: 'api_accepted',
      route: 'enqueue-fallback',
    })
    expect(sendMeta).toHaveBeenCalledOnce()
    expect(await claim('worker-after-service-fallback')).toEqual([])
    expect(
      adminRows(`
        SELECT status, provider_message_id, suspended_reason
        FROM public.outbox_messages
        WHERE idempotency_key = 'fallback:service-commit-drop'
      `)[0],
    ).toMatchObject({
      status: 'api_accepted',
      provider_message_id: 'wamid.single-fallback',
      suspended_reason: null,
    })
  })

  it('does not repeat fallback after crash between POST and result persistence', async () => {
    const supabase = getIntegrationSupabase()
    const sendMeta = vi.fn().mockResolvedValue({
      kind: 'accepted' as const,
      providerMessageId: 'wamid.accepted-before-crash',
      httpStatus: 200,
    })
    let enqueueCall = 0
    const ambiguousEnqueue: typeof enqueueOutboxMessage = async (
      client,
      input,
    ) => {
      enqueueCall += 1
      const result = await enqueueOutboxMessage(client, input)
      if (enqueueCall === 1 || enqueueCall === 3) {
        throw new Error('connection dropped after commit')
      }
      return result
    }
    const service = createOutboxDeliveryService({
      getSupabase: () => supabase,
      enqueue: ambiguousEnqueue,
      claim: claimOutboxMessages,
      fenceFallback: fenceOutboxFallback,
      beginFallback: beginOutboxFallbackAttempt,
      recordAttempt: vi.fn().mockRejectedValue(
        new Error('crash before result persistence'),
      ),
      sendMeta,
      now: () => new Date(),
      createOwner: () => 'inline:integration-fallback-crash',
      readEnv: () => ({
        OUTBOX_MODE: 'active',
        OUTBOX_GENERATION: GENERATION,
        OUTBOX_CANARY_PERCENT: '100',
        WHATSAPP_PHONE_NUMBER_ID: 'PHONE_NUMBER_ID',
      }),
      reportCritical: vi.fn(),
    })
    const input = {
      to: RECIPIENT,
      text: 'fallback accepted before persistence crash',
      options: {
        source: 'reminder' as const,
        messageKind: 'reminder' as const,
        idempotencyKey: 'fallback:post-before-record-crash',
        beforeUnsafeFallback: async () => undefined,
      },
    }

    const first = await service.sendText(input)
    const replay = await service.sendText(input)

    expect(first.providerMessageId).toBe('wamid.accepted-before-crash')
    expect(replay).toMatchObject({
      providerMessageId: null,
      status: 'sending',
      route: 'active',
      durablyEnqueued: true,
    })
    expect(sendMeta).toHaveBeenCalledOnce()
    expect(await claim('worker-after-fallback-crash')).toEqual([])
    expect(
      adminRows(`
        SELECT status, attempt, provider_message_id,
          lease_token IS NOT NULL AS leased
        FROM public.outbox_messages
        WHERE idempotency_key = 'fallback:post-before-record-crash'
      `)[0],
    ).toMatchObject({
      status: 'sending',
      attempt: 1,
      provider_message_id: null,
      leased: true,
    })
  })

  it('does not duplicate recipient heads across concurrent claims', async () => {
    const first = await enqueue('claim-race:a:1', {
      recipient: '351900000021',
    })
    await enqueue('claim-race:a:2', { recipient: '351900000021' })
    const other = await enqueue('claim-race:b:1', {
      recipient: '351900000022',
    })

    const [left, right] = await Promise.all([
      claim('worker-claim-left'),
      claim('worker-claim-right'),
    ])
    const claimedIds = [...left, ...right].map((row) => row.outbox_id)

    expect(new Set(claimedIds).size).toBe(claimedIds.length)
    expect(new Set(claimedIds)).toEqual(
      new Set([first.outbox_id, other.outbox_id]),
    )
  })

  it('records the authoritative direct result for shadow without making it claimable', async () => {
    const shadow = await enqueue('shadow:direct-result', {
      recipient: '351900000011',
      rolloutMode: 'shadow',
    })
    const supabase = getIntegrationSupabase()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recorded = await (supabase as any).rpc(
      'record_outbox_attempt_result',
      {
        p_outbox_id: shadow.outbox_id,
        p_lease_token: null,
        p_outcome: 'api_accepted',
        p_provider_message_id: 'wamid.shadow',
        p_next_attempt_at: null,
        p_http_status: 200,
        p_meta_code: null,
        p_meta_subcode: null,
        p_error_code: null,
        p_error_message: null,
        p_response_json: { messages: [{ id: 'wamid.shadow' }] },
      },
    )

    expect(recorded.error).toBeNull()
    expect(recorded.data[0]).toMatchObject({
      applied: true,
      status: 'api_accepted',
      attempt: 1,
      provider_message_id: 'wamid.shadow',
    })
    expect(await claim('worker-shadow')).toEqual([])
  })

  it('rejects api acceptance without a non-empty provider message id', async () => {
    await enqueue('accepted:missing-wamid')
    const [claimed] = await claim('worker-missing-wamid')
    const supabase = getIntegrationSupabase()
    for (const providerMessageId of [null, '   ']) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (supabase as any).rpc(
        'record_outbox_attempt_result',
        {
          p_outbox_id: claimed.outbox_id,
          p_lease_token: claimed.lease_token,
          p_outcome: 'api_accepted',
          p_provider_message_id: providerMessageId,
          p_next_attempt_at: null,
          p_http_status: 200,
          p_meta_code: null,
          p_meta_subcode: null,
          p_error_code: null,
          p_error_message: null,
          p_response_json: { messages: [] },
        },
      )
      expect(result.error?.message).toMatch(/provider message id/i)
    }
    expect(
      adminRows(
        `SELECT status, lease_token IS NOT NULL AS leased FROM public.outbox_messages WHERE id = '${claimed.outbox_id}'`,
      )[0],
    ).toMatchObject({ status: 'sending', leased: true })
  })

  it('turns a stale sending lease into unknown without reclaiming it', async () => {
    const enqueued = await enqueue('stale:1')
    const [claimed] = await claim('worker-stale', GENERATION, 1)
    expect(claimed.outbox_id).toBe(enqueued.outbox_id)

    adminExec(
      `UPDATE public.outbox_messages SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = '${enqueued.outbox_id}'`,
    )
    expect(await claim('worker-next')).toEqual([])
    expect(
      adminRows(
        `SELECT status, attempt FROM public.outbox_messages WHERE id = '${enqueued.outbox_id}'`,
      )[0],
    ).toMatchObject({ status: 'unknown', attempt: 1 })
  })

  it('limits maintenance reconciliation to the claimed generation', async () => {
    const oldGeneration = 'outbox-old-generation'
    const old = await enqueue('generation:old', {
      recipient: '351900000029',
      generation: oldGeneration,
    })
    await claim('worker-old-generation', oldGeneration, 1)
    adminExec(
      `UPDATE public.outbox_messages SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = '${old.outbox_id}'`,
    )

    const current = await enqueue('generation:current', {
      recipient: '351900000030',
    })
    expect(
      (await claim('worker-current-generation')).map((row) => row.outbox_id),
    ).toEqual([current.outbox_id])
    expect(
      adminRows(
        `SELECT status, lease_token IS NOT NULL AS leased FROM public.outbox_messages WHERE id = '${old.outbox_id}'`,
      )[0],
    ).toMatchObject({ status: 'sending', leased: true })

    await claim('worker-old-reconcile', oldGeneration)
    expect(
      adminRows(
        `SELECT status, lease_token FROM public.outbox_messages WHERE id = '${old.outbox_id}'`,
      )[0],
    ).toMatchObject({ status: 'unknown', lease_token: null })
  })

  it('bounds unknown reconciliation by the message TTL', async () => {
    const row = await enqueue('unknown:ttl', { expiresAt: expiresIn(5) })
    const [claimed] = await claim(
      'worker-unknown-ttl',
      GENERATION,
      30,
      row.outbox_id as string,
    )
    adminExec(
      `UPDATE public.outbox_messages SET expires_at = NOW() + INTERVAL '1 minute' WHERE id = '${row.outbox_id}'`,
    )
    await recordResult(claimed, 'unknown')

    const unknown = adminRows(
      `SELECT unknown_reconcile_at, expires_at FROM public.outbox_messages WHERE id = '${row.outbox_id}'`,
    )[0]
    expect(
      new Date(unknown.unknown_reconcile_at as string).getTime(),
    ).toBeLessThanOrEqual(new Date(unknown.expires_at as string).getTime())

    adminExec(
      `UPDATE public.outbox_messages SET expires_at = NOW() - INTERVAL '1 second' WHERE id = '${row.outbox_id}'`,
    )
    await claim('worker-unknown-expiry')
    expect(
      adminRows(
        `SELECT status FROM public.outbox_messages WHERE id = '${row.outbox_id}'`,
      )[0],
    ).toMatchObject({ status: 'expired' })
  })

  it('releases an expired terminal lease after a callback wins the race', async () => {
    const row = await enqueue('callback:lease-cleanup')
    const [claimed] = await claim('worker-callback-crash', GENERATION, 1)
    expect(claimed.outbox_id).toBe(row.outbox_id)
    await callback('wamid.callback-first', 'sent', row.outbox_id as string)

    adminExec(
      `UPDATE public.outbox_messages SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = '${row.outbox_id}'`,
    )
    await claim('worker-terminal-lease-cleanup')

    expect(
      adminRows(
        `SELECT status, lease_owner, lease_token, lease_expires_at FROM public.outbox_messages WHERE id = '${row.outbox_id}'`,
      )[0],
    ).toMatchObject({
      status: 'sent',
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
    })
  })

  it('reconciles unknown after five minutes without retrying or hiding sweeper work', async () => {
    const unknownRow = await enqueue('unknown:reconcile', {
      recipient: '351900000027',
    })
    const [unknownClaim] = await claim('worker-unknown-reconcile')
    await recordResult(unknownClaim, 'unknown')
    const next = await enqueue('unknown:next', {
      recipient: '351900000027',
    })

    adminExec(
      `UPDATE public.outbox_messages SET unknown_reconcile_at = NOW() - INTERVAL '1 second' WHERE id = '${unknownRow.outbox_id}'`,
    )
    const claims = await claim('worker-after-unknown-window')
    expect(claims.map((row) => row.outbox_id)).toEqual([next.outbox_id])
    expect(
      adminRows(
        `SELECT status, terminal_at IS NOT NULL AS terminal FROM public.outbox_messages WHERE id = '${unknownRow.outbox_id}'`,
      )[0],
    ).toMatchObject({ status: 'unknown', terminal: true })

    const supabase = getIntegrationSupabase()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listed = await (supabase as any).rpc('list_outbox_sweeper_work', {
      p_generation: GENERATION,
      p_limit: 100,
    })
    expect(listed.error).toBeNull()
    expect(
      listed.data.map((listedRow: RpcRow) => listedRow.outbox_id),
    ).not.toContain(unknownRow.outbox_id)
  })

  it('supersedes unsent progress when prompt or terminal is enqueued', async () => {
    const progress = await enqueue('scope:progress', { kind: 'progress' })
    const terminal = await enqueue('scope:terminal', { kind: 'terminal' })

    expect(
      adminRows(
        `SELECT status FROM public.outbox_messages WHERE id = '${progress.outbox_id}'`,
      )[0],
    ).toMatchObject({ status: 'superseded' })
    expect((await claim('worker-terminal'))[0].outbox_id).toBe(terminal.outbox_id)
  })

  it('serializes a terminal enqueue against a competing progress claim', async () => {
    const progress = await enqueue('scope-race:progress', {
      recipient: '351900000023',
      kind: 'progress',
      maxAttempts: 1,
    })

    const [racedClaims, terminal] = await Promise.all([
      claim('worker-scope-race'),
      enqueue('scope-race:terminal', {
        recipient: '351900000023',
        kind: 'terminal',
      }),
    ])
    expect(racedClaims.length).toBeLessThanOrEqual(1)

    const progressStatus = adminRows(
      `SELECT status FROM public.outbox_messages WHERE id = '${progress.outbox_id}'`,
    )[0].status
    if (racedClaims[0]?.outbox_id === progress.outbox_id) {
      expect(progressStatus).toBe('sending')
      await recordResult(racedClaims[0], 'api_accepted', 'wamid.scope-progress')
    } else {
      expect(progressStatus).toBe('superseded')
    }

    if (racedClaims[0]?.outbox_id !== terminal.outbox_id) {
      const next = await claim('worker-scope-terminal')
      expect(next.map((row) => row.outbox_id)).toEqual([terminal.outbox_id])
    }
  })

  it('skips expiry maintenance while a terminal enqueue owns the recipient', async () => {
    const recipient = '351900000056'
    const expired = await enqueue('maintenance-enqueue:expired-reminder', {
      recipient,
      kind: 'reminder',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })
    const terminalKey = 'maintenance-enqueue:terminal'
    const terminalPayload = { type: 'text', text: terminalKey }
    const enqueueSession = trackAdminExec(`
      SET statement_timeout = '5s';
      SET lock_timeout = '1s';
      SET ROLE service_role;
      BEGIN;
      SELECT pg_catalog.pg_advisory_xact_lock_shared(
        pg_catalog.hashtextextended('outbox-generation:${GENERATION}', 0)
      );
      SELECT pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('outbox-key:${terminalKey}', 0)
      );
      SELECT pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('outbox-recipient:${recipient}', 0)
      );
      SELECT pg_catalog.pg_sleep(2) /* test_enqueue_recipient_lock */;
      SELECT * FROM public.enqueue_outbox_message(
        'whatsapp_cloud',
        'PHONE_NUMBER_ID',
        '${recipient}',
        '${terminalKey}',
        'terminal',
        pg_catalog.jsonb_build_object('type', 'text', 'text', '${terminalKey}'),
        '${hashPayload(terminalPayload)}',
        'active',
        '${GENERATION}',
        5,
        pg_catalog.now() + INTERVAL '15 minutes',
        NULL::UUID,
        NULL::UUID,
        NULL::INTEGER,
        NULL::TEXT,
        NULL::TEXT,
        NULL::UUID,
        NULL::JSONB
      );
      COMMIT;
      RESET ROLE;
    `)
    try {
      await waitForDbActivity(
        'test_enqueue_recipient_lock',
        'PgSleep',
        enqueueSession,
      )

      const skipped = await claim('worker-maintenance-enqueue-blocked')
      const statusWhileLocked = adminRows(`
        SELECT status
        FROM public.outbox_messages
        WHERE id = '${expired.outbox_id}'
      `)[0]
      const enqueueOutcome = await enqueueSession.settled
      assertAdminExecSucceeded(
        'test_enqueue_recipient_lock',
        enqueueOutcome,
      )

      expect(skipped).toEqual([])
      expect(statusWhileLocked).toEqual({ status: 'pending' })
      const terminal = adminRows(`
        SELECT id, status
        FROM public.outbox_messages
        WHERE idempotency_key = '${terminalKey}'
      `)[0]
      const claimed = await claim('worker-maintenance-enqueue-released')

      expect(claimed.map((row) => row.outbox_id)).toEqual([terminal.id])
      expect(adminRows(`
        SELECT id, status
        FROM public.outbox_messages
        WHERE id IN ('${expired.outbox_id}', '${terminal.id}')
        ORDER BY sequence_no
      `)).toEqual([
        { id: expired.outbox_id, status: 'expired' },
        { id: terminal.id, status: 'sending' },
      ])
    } finally {
      await enqueueSession.settled
    }
  }, 10_000)

  it('skips expiry maintenance while scope finalization owns the recipient', async () => {
    const recipient = '351900000057'
    const workId = await createInboundWork(
      'wamid.maintenance-finalize',
      recipient,
    )
    const expiring = await enqueue('maintenance-finalize:expiring-response', {
      recipient,
      workId,
      emissionIndex: 0,
      kind: 'terminal',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })
    const deadline = expiresIn(15)
    const finalizeSession = trackAdminExec(`
      SET statement_timeout = '5s';
      SET lock_timeout = '1s';
      SET ROLE service_role;
      BEGIN;
      SELECT pg_catalog.pg_advisory_xact_lock_shared(
        pg_catalog.hashtextextended('outbox-generation:${GENERATION}', 0)
      );
      SELECT pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('outbox-recipient:${recipient}', 0)
      );
      SELECT pg_catalog.pg_sleep(2) /* test_finalize_recipient_lock */;
      SELECT * FROM public.finalize_outbox_scope(
        '${workId}'::UUID,
        '${expiring.outbox_id}'::UUID,
        'terminal',
        '${deadline}'::TIMESTAMPTZ
      );
      COMMIT;
      RESET ROLE;
    `)
    try {
      await waitForDbActivity(
        'test_finalize_recipient_lock',
        'PgSleep',
        finalizeSession,
      )

      const skipped = await claim('worker-maintenance-finalize-blocked')
      const statusWhileLocked = adminRows(`
        SELECT status
        FROM public.outbox_messages
        WHERE id = '${expiring.outbox_id}'
      `)[0]
      const finalizeOutcome = await finalizeSession.settled
      assertAdminExecSucceeded(
        'test_finalize_recipient_lock',
        finalizeOutcome,
      )

      expect(skipped).toEqual([])
      expect(statusWhileLocked).toEqual({ status: 'pending' })
      const claimed = await claim(
        'worker-maintenance-finalize-released',
        GENERATION,
        90,
        expiring.outbox_id as string,
      )

      expect(claimed.map((row) => row.outbox_id)).toEqual([expiring.outbox_id])
      expect(adminRows(`
        SELECT status
        FROM public.outbox_messages
        WHERE id = '${expiring.outbox_id}'
      `)[0]).toEqual({ status: 'sending' })
      expect(adminRows(`
        SELECT COUNT(*)::integer AS count
        FROM public.outbox_status_events
        WHERE outbox_id = '${expiring.outbox_id}'
          AND event_type = 'scope_finalized'
      `)[0]).toEqual({ count: 1 })
    } finally {
      await finalizeSession.settled
    }
  }, 10_000)

  it('applies callbacks monotonically, including failed then positive proof', async () => {
    const row = await enqueue('callback:ordering')
    const outboxId = row.outbox_id as string

    await callback('wamid.ordering', 'delivered', outboxId)
    await callback('wamid.ordering', 'read', outboxId)
    await callback('wamid.ordering', 'sent', outboxId)
    expect(
      adminRows(
        `SELECT status FROM public.outbox_messages WHERE id = '${outboxId}'`,
      )[0],
    ).toMatchObject({ status: 'read' })

    const failedRow = await enqueue('callback:failed', {
      recipient: '351900000003',
    })
    const [failedClaim] = await claim('worker-failed')
    await recordResult(failedClaim, 'api_accepted', 'wamid.failed')
    await callback('wamid.failed', 'failed', failedRow.outbox_id as string)
    expect(
      adminRows(
        `SELECT status, next_attempt_at FROM public.outbox_messages WHERE id = '${failedRow.outbox_id}'`,
      )[0],
    ).toMatchObject({ status: 'failed_terminal', next_attempt_at: null })
    await callback('wamid.failed', 'delivered', failedRow.outbox_id as string)
    expect(
      adminRows(
        `SELECT status FROM public.outbox_messages WHERE id = '${failedRow.outbox_id}'`,
      )[0],
    ).toMatchObject({ status: 'delivered' })
  })

  it('projects a failed callback exactly once before a late attempt result', async () => {
    const supabase = getIntegrationSupabase()
    // Database types are intentionally a placeholder in this repository.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: user, error: userError } = await (supabase as any)
      .from('users')
      .insert({ phone: '351900000058', name: 'Failed Callback User' })
      .select('id')
      .single()
    expect(userError).toBeNull()

    const row = await enqueue('callback:failed-first-projection', {
      recipient: '351900000058',
      userId: user!.id,
    })
    const [claimed] = await claim(
      'worker-failed-first-projection',
      GENERATION,
      90,
      row.outbox_id as string,
    )

    await callback(
      'wamid.failed-first',
      'failed',
      row.outbox_id as string,
    )
    expect(adminRows(`
      SELECT COUNT(*)::integer AS count
      FROM public.bot_messages
      WHERE user_id = '${user!.id}'
        AND message_id = 'wamid.failed-first'
        AND direction = 'outgoing'
    `)[0]).toMatchObject({ count: 1 })

    await recordResult(claimed, 'api_accepted', 'wamid.failed-first')
    expect(adminRows(`
      SELECT COUNT(*)::integer AS count
      FROM public.bot_messages
      WHERE user_id = '${user!.id}'
        AND message_id = 'wamid.failed-first'
        AND direction = 'outgoing'
    `)[0]).toMatchObject({ count: 1 })
  })

  it('rolls back callback status, ledger, projection, and redaction together', async () => {
    const supabase = getIntegrationSupabase()
    // Database types are intentionally a placeholder in this repository.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: user, error: userError } = await (supabase as any)
      .from('users')
      .insert({ phone: '351900000059', name: 'Projection Rollback User' })
      .select('id')
      .single()
    expect(userError).toBeNull()

    const row = await enqueue('callback:rollback-projection', {
      recipient: '351900000059',
      userId: user!.id,
      kind: 'otp',
      payload: { type: 'text', text: 'code 654321' },
      maxAttempts: 3,
      expiresAt: expiresIn(5),
    })
    await claim(
      'worker-rollback-projection',
      GENERATION,
      90,
      row.outbox_id as string,
    )

    adminExec(`
      CREATE OR REPLACE FUNCTION public.test_fail_bot_projection()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $trigger$
      BEGIN
        IF NEW.message_id = 'wamid.rollback-projection' THEN
          RAISE EXCEPTION 'forced bot projection failure';
        END IF;
        RETURN NEW;
      END;
      $trigger$;
      CREATE TRIGGER test_fail_bot_projection
      BEFORE INSERT ON public.bot_messages
      FOR EACH ROW EXECUTE FUNCTION public.test_fail_bot_projection();
    `)

    try {
      await expect(callback(
        'wamid.rollback-projection',
        'delivered',
        row.outbox_id as string,
      )).rejects.toThrow('forced bot projection failure')
    } finally {
      adminExec(`
        DROP TRIGGER IF EXISTS test_fail_bot_projection
          ON public.bot_messages;
        DROP FUNCTION IF EXISTS public.test_fail_bot_projection();
      `)
    }

    expect(adminRows(`
      SELECT status, provider_message_id, last_error_code, terminal_at,
        payload_json IS NULL AS payload_redacted,
        payload_redacted_at,
        bot_message_projected_at
      FROM public.outbox_messages
      WHERE id = '${row.outbox_id}'
    `)[0]).toEqual({
      status: 'sending',
      provider_message_id: null,
      last_error_code: null,
      terminal_at: null,
      payload_redacted: false,
      payload_redacted_at: null,
      bot_message_projected_at: null,
    })
    expect(adminRows(`
      SELECT COUNT(*)::integer AS count
      FROM public.outbox_status_events
      WHERE outbox_id = '${row.outbox_id}'
        AND event_type = 'callback'
    `)[0]).toEqual({ count: 0 })
    expect(adminRows(`
      SELECT COUNT(*)::integer AS count
      FROM public.bot_messages
      WHERE user_id = '${user!.id}'
        AND message_id = 'wamid.rollback-projection'
        AND direction = 'outgoing'
    `)[0]).toEqual({ count: 0 })
  })

  it('redacts OTP when a positive callback arrives before wamid persistence', async () => {
    const otp = await enqueue('otp:callback-first-redaction', {
      recipient: '351900000053',
      kind: 'otp',
      payload: { type: 'text', text: 'code 123456' },
      maxAttempts: 3,
      expiresAt: expiresIn(5),
    })
    expect(adminRows(`
      SELECT provider_message_id, payload_json IS NULL AS redacted
      FROM public.outbox_messages
      WHERE id = '${otp.outbox_id}'
    `)[0]).toEqual({ provider_message_id: null, redacted: false })

    await callback(
      'wamid.otp-callback-first',
      'delivered',
      otp.outbox_id as string,
      { eventAt: '2026-07-13T12:03:00.000Z' },
    )

    expect(adminRows(`
      SELECT status, provider_message_id, payload_json,
        payload_redacted_at IS NOT NULL AS redacted
      FROM public.outbox_messages
      WHERE id = '${otp.outbox_id}'
    `)[0]).toEqual({
      status: 'delivered',
      provider_message_id: 'wamid.otp-callback-first',
      payload_json: null,
      redacted: true,
    })
  })

  it('preserves callback code and subcode when relinking an orphan', async () => {
    const providerMessageId = 'wamid.orphan-code-subcode'
    await callback(providerMessageId, 'failed', null, {
      eventAt: '2026-07-13T12:04:00.000Z',
      metaCode: 131026,
      metaSubcode: 2494010,
      errorMessage: 'recipient unavailable',
    })
    const row = await enqueue('callback:orphan-code-subcode', {
      recipient: '351900000054',
    })
    const [claimed] = await claim(
      'worker-orphan-code-subcode',
      GENERATION,
      90,
      row.outbox_id as string,
    )
    await recordResult(claimed, 'api_accepted', providerMessageId)

    expect(adminRows(`
      SELECT outbox_id, meta_code, meta_subcode
      FROM public.outbox_status_events
      WHERE provider_message_id = '${providerMessageId}'
        AND event_type = 'callback'
      ORDER BY outbox_id NULLS FIRST
    `)).toEqual([
      { outbox_id: null, meta_code: 131026, meta_subcode: 2494010 },
      {
        outbox_id: row.outbox_id,
        meta_code: 131026,
        meta_subcode: 2494010,
      },
    ])
  })

  it('keeps the earliest evidence timestamps from out-of-order callbacks', async () => {
    const row = await enqueue('callback:earliest-evidence', {
      recipient: '351900000055',
    })
    const outboxId = row.outbox_id as string

    await callback('wamid.earliest-evidence', 'read', outboxId, {
      eventAt: '2026-07-13T12:03:00.000Z',
    })
    await callback('wamid.earliest-evidence', 'delivered', outboxId, {
      eventAt: '2026-07-13T12:02:00.000Z',
    })
    await callback('wamid.earliest-evidence', 'sent', outboxId, {
      eventAt: '2026-07-13T12:01:00.000Z',
    })

    const stored = adminRows(`
      SELECT status, accepted_at, sent_at, delivered_at, read_at
      FROM public.outbox_messages
      WHERE id = '${outboxId}'
    `)[0]
    expect(stored.status).toBe('read')
    expect(new Date(stored.accepted_at as string).toISOString())
      .toBe('2026-07-13T12:01:00.000Z')
    expect(new Date(stored.sent_at as string).toISOString())
      .toBe('2026-07-13T12:01:00.000Z')
    expect(new Date(stored.delivered_at as string).toISOString())
      .toBe('2026-07-13T12:02:00.000Z')
    expect(new Date(stored.read_at as string).toISOString())
      .toBe('2026-07-13T12:03:00.000Z')
  })

  it('prefers opaque outbox correlation over a wamid linked to another row', async () => {
    const first = await enqueue('callback:opaque-priority:first', {
      recipient: '351900000040',
    })
    const [firstClaim] = await claim(
      'worker-opaque-first',
      GENERATION,
      90,
      first.outbox_id as string,
    )
    await recordResult(firstClaim, 'api_accepted', 'wamid.opaque-first')

    const second = await enqueue('callback:opaque-priority:second', {
      recipient: '351900000041',
    })
    const [secondClaim] = await claim(
      'worker-opaque-second',
      GENERATION,
      90,
      second.outbox_id as string,
    )
    await recordResult(secondClaim, 'api_accepted', 'wamid.opaque-second')

    const applied = await callback(
      'wamid.opaque-first',
      'delivered',
      second.outbox_id as string,
    )

    expect(applied.outbox_id).toBe(second.outbox_id)
    expect(adminRows(`
      SELECT id, status
      FROM public.outbox_messages
      WHERE id IN ('${first.outbox_id}', '${second.outbox_id}')
      ORDER BY id
    `)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.outbox_id, status: 'api_accepted' }),
      expect.objectContaining({ id: second.outbox_id, status: 'delivered' }),
    ]))
  })

  it('keeps duplicate callbacks append-only without regressing projection', async () => {
    const row = await enqueue('callback:duplicate-ledger', {
      recipient: '351900000042',
    })
    const outboxId = row.outbox_id as string

    await callback('wamid.duplicate-ledger', 'delivered', outboxId)
    await callback('wamid.duplicate-ledger', 'delivered', outboxId)

    expect(
      adminRows(`SELECT status FROM public.outbox_messages WHERE id = '${outboxId}'`)[0],
    ).toMatchObject({ status: 'delivered' })
    expect(adminRows(`
      SELECT COUNT(*)::integer AS count
      FROM public.outbox_status_events
      WHERE outbox_id = '${outboxId}'
        AND event_type = 'callback'
    `)[0]).toMatchObject({ count: 2 })
  })

  it('reconciles orphan callbacks and correlates historical wamid values', async () => {
    expect(await callback('wamid.orphan', 'delivered')).toMatchObject({
      applied: false,
      orphaned: true,
    })
    const orphanRow = await enqueue('callback:orphan', {
      recipient: '351900000004',
    })
    const [orphanClaim] = await claim('worker-orphan')
    await recordResult(orphanClaim, 'api_accepted', 'wamid.orphan')
    expect(
      adminRows(
        `SELECT status FROM public.outbox_messages WHERE id = '${orphanRow.outbox_id}'`,
      )[0],
    ).toMatchObject({ status: 'delivered' })

    const historical = await enqueue('callback:historical', {
      recipient: '351900000005',
    })
    const [firstClaim] = await claim('worker-history-1')
    await recordResult(firstClaim, 'retryable', 'wamid.old')
    const [retryClaim] = await claim('worker-history-2')
    await recordResult(retryClaim, 'api_accepted', 'wamid.new')
    await callback('wamid.old', 'delivered')
    expect(
      adminRows(
        `SELECT status, provider_message_id FROM public.outbox_messages WHERE id = '${historical.outbox_id}'`,
      )[0],
    ).toMatchObject({ status: 'delivered', provider_message_id: 'wamid.new' })
  })

  it('serializes an uncorrelated callback with acceptance by wamid', async () => {
    const row = await enqueue('callback:wamid-race', {
      recipient: '351900000024',
    })
    const [claimed] = await claim('worker-wamid-race')

    adminExec(`
      CREATE OR REPLACE FUNCTION public.test_gate_orphan_callback()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $trigger$
      BEGIN
        IF NEW.event_type = 'callback'
           AND NEW.outbox_id IS NULL
           AND NEW.provider_message_id = 'wamid.race' THEN
          PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended('test-wamid-race-gate', 0)
          );
        END IF;
        RETURN NEW;
      END;
      $trigger$;
      CREATE TRIGGER test_gate_orphan_callback
      BEFORE INSERT ON public.outbox_status_events
      FOR EACH ROW EXECUTE FUNCTION public.test_gate_orphan_callback();
    `)

    let gateSession: ExplicitAdminGate | undefined
    let callbackSession: TrackedAdminExec | undefined
    let resultSession: TrackedAdminExec | undefined

    try {
      gateSession = openExplicitAdminGate(
        'test-wamid-race-gate',
        'test_wamid_race_gate_ready',
      )
      await gateSession.ready
      callbackSession = trackAdminExec(`
        SET statement_timeout = '5s';
        SET ROLE service_role;
        SELECT * FROM public.apply_outbox_callback(
          'wamid.race',
          'delivered',
          NOW(),
          NULL::UUID,
          NULL::INTEGER,
          NULL::INTEGER,
          NULL::TEXT,
          pg_catalog.jsonb_build_object('id', 'wamid.race', 'status', 'delivered')
        ) /* test_callback_reaches_wamid_race */;
        RESET ROLE;
      `)
      await waitForDbActivity(
        'test_callback_reaches_wamid_race',
        'advisory',
        callbackSession,
      )
      resultSession = trackAdminExec(`
        SET statement_timeout = '5s';
        SET ROLE service_role;
        SELECT * FROM public.record_outbox_attempt_result(
          '${claimed.outbox_id}'::UUID,
          '${claimed.lease_token}'::UUID,
          'api_accepted',
          'wamid.race',
          NULL::TIMESTAMPTZ,
          200,
          NULL::INTEGER,
          NULL::INTEGER,
          NULL::TEXT,
          NULL::TEXT,
          pg_catalog.jsonb_build_object('outcome', 'api_accepted')
        ) /* test_result_waits_for_wamid */;
        RESET ROLE;
      `)
      await waitForDbActivity(
        'test_result_waits_for_wamid',
        'advisory',
        resultSession,
      )

      await gateSession.release()
      const [callbackOutcome, resultOutcome] = await Promise.all([
        callbackSession.settled,
        resultSession.settled,
      ])
      assertAdminExecSucceeded(
        'test_callback_reaches_wamid_race',
        callbackOutcome,
      )
      assertAdminExecSucceeded('test_result_waits_for_wamid', resultOutcome)
    } finally {
      let gateCleanupError: unknown
      if (gateSession) {
        try {
          await gateSession.close()
        } catch (error) {
          gateCleanupError = error
        }
      }
      if (callbackSession) await callbackSession.settled
      if (resultSession) await resultSession.settled
      adminExec(`
        DROP TRIGGER IF EXISTS test_gate_orphan_callback
          ON public.outbox_status_events;
        DROP FUNCTION IF EXISTS public.test_gate_orphan_callback();
      `)
      if (gateCleanupError) throw gateCleanupError
    }

    expect(
      adminRows(
        `SELECT status FROM public.outbox_messages WHERE id = '${row.outbox_id}'`,
      )[0],
    ).toMatchObject({ status: 'delivered' })
    const orphans = adminRows(`
      SELECT id
      FROM public.outbox_status_events
      WHERE outbox_id IS NULL
        AND event_type = 'callback'
        AND provider_message_id = 'wamid.race'
    `)
    expect(orphans).toHaveLength(1)
    const [orphan] = orphans
    expect(adminRows(`
      SELECT COUNT(*)::integer AS count
      FROM public.outbox_status_events
      WHERE outbox_id = '${row.outbox_id}'
        AND event_type = 'orphan_callback_linked'
        AND related_event_id = '${orphan.id}'
    `)[0]).toEqual({ count: 1 })
  }, 20_000)

  it('projects bot_messages exactly once under callback/result concurrency', async () => {
    const supabase = getIntegrationSupabase()
    // Database types are intentionally a placeholder in this repository.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: user, error: userError } = await (supabase as any)
      .from('users')
      .insert({ phone: '351900000006', name: 'Outbox User' })
      .select('id')
      .single()
    expect(userError).toBeNull()

    const row = await enqueue('bot-message:once', {
      recipient: '351900000006',
      userId: user!.id,
      resourceType: 'summary',
      resourceMetadata: { source: 'integration' },
    })
    const [claimed] = await claim('worker-bot-message')

    await Promise.all([
      callback('wamid.concurrent', 'sent', row.outbox_id as string),
      recordResult(claimed, 'api_accepted', 'wamid.concurrent'),
    ])

    expect(
      adminRows(
        `SELECT COUNT(*)::integer AS count FROM public.bot_messages WHERE user_id = '${user!.id}' AND direction = 'outgoing'`,
      )[0],
    ).toMatchObject({ count: 1 })
  })

  it('redacts OTP on acceptance and suspends an active generation', async () => {
    const pending = await enqueue('suspend:1', {
      recipient: '351900000007',
    })
    const otp = await enqueue('otp:code-1', {
      recipient: '351900000008',
      kind: 'otp',
      maxAttempts: 3,
      expiresAt: expiresIn(5),
    })
    const claims = await claim(
      'worker-otp',
      GENERATION,
      90,
      otp.outbox_id as string,
    )
    const otpClaim = claims.find((row) => row.outbox_id === otp.outbox_id)
    expect(otpClaim).toBeDefined()
    await recordResult(otpClaim!, 'api_accepted', 'wamid.otp')
    expect(
      adminRows(
        `SELECT payload_json, payload_redacted_at IS NOT NULL AS redacted FROM public.outbox_messages WHERE id = '${otp.outbox_id}'`,
      )[0],
    ).toMatchObject({ payload_json: null, redacted: true })

    const supabase = getIntegrationSupabase()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const suspended = await (supabase as any).rpc('suspend_outbox_generation', {
      p_generation: GENERATION,
      p_reason: 'rollback-test',
    })
    expect(suspended.error).toBeNull()
    expect(suspended.data[0].suspended_count).toBe(1)
    expect(adminRows(`
      SELECT status, suspended_reason
      FROM public.outbox_messages
      WHERE id = '${pending.outbox_id}'
    `)[0]).toEqual({
      status: 'suspended',
      suspended_reason: 'rollback-test',
    })
    expect(await claim('worker-after-suspend')).toEqual([])
  })

  it('preserves an active claim that starts before the generation fence', async () => {
    const generation = 'outbox-claim-before-suspend'
    const row = await enqueue('suspend-race:claim-first', {
      recipient: '351900000025',
      generation,
    })
    const claimSession = trackAdminExec(`
      SET statement_timeout = '5s';
      SET ROLE service_role;
      BEGIN;
      SELECT * FROM public.claim_outbox_messages(
        'worker-suspend-race',
        '${generation}',
        1,
        90,
        '${row.outbox_id}'::UUID,
        FALSE
      );
      SELECT pg_catalog.pg_sleep(2) /* test_claim_before_suspend */;
      COMMIT;
      RESET ROLE;
    `)
    let suspendSession: TrackedAdminExec | undefined

    try {
      await waitForDbActivity(
        'test_claim_before_suspend',
        'PgSleep',
        claimSession,
      )
      suspendSession = trackAdminExec(`
        SET statement_timeout = '5s';
        SET ROLE service_role;
        SELECT * FROM public.suspend_outbox_generation(
          '${generation}',
          'concurrent-rollback'
        ) /* test_suspend_waits_for_claim */;
        RESET ROLE;
      `)
      await waitForDbActivity(
        'test_suspend_waits_for_claim',
        'advisory',
        suspendSession,
      )

      const [claimOutcome, suspendOutcome] = await Promise.all([
        claimSession.settled,
        suspendSession.settled,
      ])
      assertAdminExecSucceeded('test_claim_before_suspend', claimOutcome)
      assertAdminExecSucceeded('test_suspend_waits_for_claim', suspendOutcome)

      expect(adminRows(`
        SELECT om.status, om.attempt,
          om.lease_token IS NOT NULL AS leased,
          started.event_at <= fence.suspended_at AS started_before_fence
        FROM public.outbox_messages AS om
        JOIN private.outbox_suspended_generations AS fence
          ON fence.generation = om.rollout_generation
        JOIN LATERAL (
          SELECT ose.event_at
          FROM public.outbox_status_events AS ose
          WHERE ose.outbox_id = om.id
            AND ose.event_type = 'claimed'
          ORDER BY ose.event_at DESC, ose.id DESC
          LIMIT 1
        ) AS started ON TRUE
        WHERE om.id = '${row.outbox_id}'
      `)[0]).toEqual({
        status: 'sending',
        attempt: 1,
        leased: true,
        started_before_fence: true,
      })
      expect(await claim('worker-after-fence', generation)).toEqual([])
    } finally {
      await claimSession.settled
      if (suspendSession) await suspendSession.settled
    }
  }, 10_000)

  it('prevents a shadow begin when the generation fence wins first', async () => {
    const generation = 'outbox-suspend-before-begin'
    const key = 'suspend-race:begin-after-fence'
    const row = await enqueue(key, {
      recipient: '351900000026',
      rolloutMode: 'shadow',
      generation,
    })
    const suspendSession = trackAdminExec(`
      SET statement_timeout = '5s';
      SET ROLE service_role;
      BEGIN;
      SELECT * FROM public.suspend_outbox_generation(
        '${generation}',
        'fence-before-begin'
      );
      SELECT pg_catalog.pg_sleep(2) /* test_suspend_before_begin */;
      COMMIT;
      RESET ROLE;
    `)
    let beginSession: TrackedAdminExec | undefined

    try {
      await waitForDbActivity(
        'test_suspend_before_begin',
        'PgSleep',
        suspendSession,
      )
      beginSession = trackAdminExec(`
        SET statement_timeout = '5s';
        SET ROLE service_role;
        SELECT * FROM public.begin_outbox_fallback_attempt(
          '${row.outbox_id}'::UUID,
          '${key}',
          90
        ) /* test_begin_waits_for_suspend */;
        RESET ROLE;
      `)
      await waitForDbActivity(
        'test_begin_waits_for_suspend',
        'advisory',
        beginSession,
      )

      const [suspendOutcome, beginOutcome] = await Promise.all([
        suspendSession.settled,
        beginSession.settled,
      ])
      assertAdminExecSucceeded('test_suspend_before_begin', suspendOutcome)
      assertAdminExecSucceeded('test_begin_waits_for_suspend', beginOutcome)

      expect(adminRows(`
        SELECT status, attempt, lease_token, suspended_reason
        FROM public.outbox_messages
        WHERE id = '${row.outbox_id}'
      `)[0]).toEqual({
        status: 'suspended',
        attempt: 0,
        lease_token: null,
        suspended_reason: 'fence-before-begin',
      })
      expect(adminRows(`
        SELECT COUNT(*)::integer AS count
        FROM public.outbox_status_events
        WHERE outbox_id = '${row.outbox_id}'
          AND event_type = 'fallback_started'
      `)[0]).toEqual({ count: 0 })
    } finally {
      await suspendSession.settled
      if (beginSession) await beginSession.settled
    }
  }, 10_000)

  it('drains an expired active sending lease after suspension without claiming', async () => {
    const generation = 'outbox-suspended-active-drain'
    const row = await enqueue('suspend-drain:active', {
      recipient: '351900000058',
      generation,
    })
    const [sending] = await claim(
      'worker-active-before-suspend',
      generation,
      90,
      row.outbox_id as string,
    )
    expect(sending.outbox_id).toBe(row.outbox_id)

    await suspendGeneration(generation, 'active-drain')
    expect(adminRows(`
      SELECT status, attempt, lease_token IS NOT NULL AS leased
      FROM public.outbox_messages
      WHERE id = '${row.outbox_id}'
    `)[0]).toEqual({ status: 'sending', attempt: 1, leased: true })

    adminExec(`
      UPDATE public.outbox_messages
      SET lease_expires_at = NOW() - INTERVAL '1 minute'
      WHERE id = '${row.outbox_id}'
    `)
    const supabase = getIntegrationSupabase()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const maintenance = await (supabase as any).rpc('claim_outbox_messages', {
      p_owner: 'maintenance-active-drain',
      p_generation: generation,
      p_limit: 0,
      p_lease_seconds: 90,
    })

    expect(maintenance.error).toBeNull()
    expect(maintenance.data).toEqual([])
    expect(adminRows(`
      SELECT status, attempt, lease_token,
        unknown_reconcile_at IS NOT NULL AS reconcile_scheduled,
        terminal_at IS NULL AS reconciliation_pending
      FROM public.outbox_messages
      WHERE id = '${row.outbox_id}'
    `)[0]).toEqual({
      status: 'unknown',
      attempt: 1,
      lease_token: null,
      reconcile_scheduled: true,
      reconciliation_pending: true,
    })
    expect(await claim('worker-new-after-fence', generation)).toEqual([])
  })

  it('drains and reconciles an in-flight shadow without delivery authority', async () => {
    const generation = 'outbox-suspended-shadow-drain'
    const key = 'suspend-drain:shadow'
    const row = await enqueue(key, {
      recipient: '351900000059',
      rolloutMode: 'shadow',
      generation,
    })
    const sending = await beginFallbackAttempt(row, key)
    expect(sending).toMatchObject({ started: true, status: 'sending' })

    await suspendGeneration(generation, 'shadow-drain')
    expect(adminRows(`
      SELECT status, delivery_authority,
        lease_token IS NOT NULL AS leased
      FROM public.outbox_messages
      WHERE id = '${row.outbox_id}'
    `)[0]).toEqual({
      status: 'sending',
      delivery_authority: false,
      leased: true,
    })

    adminExec(`
      UPDATE public.outbox_messages
      SET lease_expires_at = NOW() - INTERVAL '1 minute'
      WHERE id = '${row.outbox_id}'
    `)
    const supabase = getIntegrationSupabase()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const staleMaintenance = await (supabase as any).rpc(
      'claim_outbox_messages',
      {
        p_owner: 'maintenance-shadow-stale',
        p_generation: generation,
        p_limit: 0,
        p_lease_seconds: 90,
      },
    )
    expect(staleMaintenance.error).toBeNull()
    expect(staleMaintenance.data).toEqual([])
    expect(adminRows(`
      SELECT status, delivery_authority, lease_token,
        unknown_reconcile_at IS NOT NULL AS reconcile_scheduled,
        terminal_at IS NULL AS reconciliation_pending
      FROM public.outbox_messages
      WHERE id = '${row.outbox_id}'
    `)[0]).toEqual({
      status: 'unknown',
      delivery_authority: false,
      lease_token: null,
      reconcile_scheduled: true,
      reconciliation_pending: true,
    })

    adminExec(`
      UPDATE public.outbox_messages
      SET unknown_reconcile_at = NOW() - INTERVAL '1 second'
      WHERE id = '${row.outbox_id}'
    `)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reconcileMaintenance = await (supabase as any).rpc(
      'claim_outbox_messages',
      {
        p_owner: 'maintenance-shadow-reconcile',
        p_generation: generation,
        p_limit: 0,
        p_lease_seconds: 90,
      },
    )
    expect(reconcileMaintenance.error).toBeNull()
    expect(reconcileMaintenance.data).toEqual([])
    expect(adminRows(`
      SELECT status, terminal_at IS NOT NULL AS reconciled
      FROM public.outbox_messages
      WHERE id = '${row.outbox_id}'
    `)[0]).toEqual({ status: 'unknown', reconciled: true })
  })

  it('durably fences concurrent and late enqueue for a suspended generation', async () => {
    const generation = 'outbox-suspended-generation'
    const key = 'suspend-enqueue-race:1'
    const payload = { type: 'text', text: key }
    const suspendSession = trackAdminExec(`
      SET statement_timeout = '5s';
      SET ROLE service_role;
      BEGIN;
      SELECT * FROM public.suspend_outbox_generation(
        '${generation}',
        'durable-fence'
      );
      SELECT pg_catalog.pg_sleep(2) /* test_suspend_before_enqueue */;
      COMMIT;
      RESET ROLE;
    `)
    let enqueueSession: TrackedAdminExec | undefined

    try {
      await waitForDbActivity(
        'test_suspend_before_enqueue',
        'PgSleep',
        suspendSession,
      )
      enqueueSession = trackAdminExec(`
        SET statement_timeout = '5s';
        SET ROLE service_role;
        SELECT * FROM public.enqueue_outbox_message(
          'whatsapp_cloud',
          'PHONE_NUMBER_ID',
          '351900000031',
          '${key}',
          'terminal',
          pg_catalog.jsonb_build_object('type', 'text', 'text', '${key}'),
          '${hashPayload(payload)}',
          'active',
          '${generation}',
          5,
          pg_catalog.now() + INTERVAL '15 minutes',
          NULL::UUID,
          NULL::UUID,
          NULL::INTEGER,
          NULL::TEXT,
          NULL::TEXT,
          NULL::UUID,
          NULL::JSONB
        ) /* test_enqueue_waits_for_suspend */;
        RESET ROLE;
      `)
      await waitForDbActivity(
        'test_enqueue_waits_for_suspend',
        'advisory',
        enqueueSession,
      )

      const [suspendOutcome, enqueueOutcome] = await Promise.all([
        suspendSession.settled,
        enqueueSession.settled,
      ])
      assertAdminExecSucceeded('test_suspend_before_enqueue', suspendOutcome)
      assertAdminExecSucceeded('test_enqueue_waits_for_suspend', enqueueOutcome)
      expect(adminRows(`
        SELECT om.status, om.attempt, om.suspended_reason,
          om.created_at >= fence.suspended_at AS enqueued_after_fence
        FROM public.outbox_messages AS om
        JOIN private.outbox_suspended_generations AS fence
          ON fence.generation = om.rollout_generation
        WHERE om.idempotency_key = '${key}'
      `)[0]).toEqual({
        status: 'suspended',
        attempt: 0,
        suspended_reason: 'durable-fence',
        enqueued_after_fence: true,
      })
    } finally {
      await suspendSession.settled
      if (enqueueSession) await enqueueSession.settled
    }

    const late = await enqueue('suspend-enqueue-race:late', {
      recipient: '351900000032',
      generation,
    })
    expect(late).toMatchObject({
      was_inserted: true,
      status: 'suspended',
    })
    expect(await claim('worker-suspended-generation', generation)).toEqual([])
  })

  it('clears terminal leases during suspension without regressing delivery evidence', async () => {
    const generation = 'outbox-terminal-lease-generation'
    const row = await enqueue('suspend-terminal-lease:1', {
      recipient: '351900000033',
      generation,
    })
    await claim('worker-terminal-before-suspend', generation, 1)
    await callback('wamid.terminal-before-suspend', 'sent', row.outbox_id as string)

    const supabase = getIntegrationSupabase()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const suspended = await (supabase as any).rpc('suspend_outbox_generation', {
      p_generation: generation,
      p_reason: 'terminal-lease-cleanup',
    })
    expect(suspended.error).toBeNull()
    expect(
      adminRows(
        `SELECT status, lease_owner, lease_token, lease_expires_at FROM public.outbox_messages WHERE id = '${row.outbox_id}'`,
      )[0],
    ).toMatchObject({
      status: 'sent',
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
    })
  })

  it('records an accepted result after suspension without revoking its active lease', async () => {
    const generation = 'outbox-late-acceptance-generation'
    const row = await enqueue('suspend-late-acceptance:1', {
      recipient: '351900000034',
      generation,
    })
    const [claimed] = await claim('worker-late-acceptance', generation, 1)

    const supabase = getIntegrationSupabase()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const suspended = await (supabase as any).rpc('suspend_outbox_generation', {
      p_generation: generation,
      p_reason: 'acceptance-race',
    })
    expect(suspended.error).toBeNull()
    expect(adminRows(`
      SELECT status, lease_token
      FROM public.outbox_messages
      WHERE id = '${row.outbox_id}'
    `)[0]).toEqual({
      status: 'sending',
      lease_token: claimed.lease_token,
    })

    const accepted = await recordResult(
      claimed,
      'api_accepted',
      'wamid.after-suspend',
    )
    expect(accepted).toMatchObject({
      applied: true,
      status: 'api_accepted',
      provider_message_id: 'wamid.after-suspend',
    })
    expect(
      adminRows(
        `SELECT status, provider_message_id, lease_token FROM public.outbox_messages WHERE id = '${row.outbox_id}'`,
      )[0],
    ).toMatchObject({
      status: 'api_accepted',
      provider_message_id: 'wamid.after-suspend',
      lease_token: null,
    })
    expect(
      await recordResult(claimed, 'api_accepted', 'wamid.after-suspend'),
    ).toMatchObject({ applied: false, status: 'api_accepted' })
    expect(
      adminRows(`
        SELECT COUNT(*)::integer AS count
        FROM public.outbox_status_events
        WHERE outbox_id = '${row.outbox_id}'
          AND event_type = 'attempt_result'
          AND provider_message_id = 'wamid.after-suspend'
      `)[0],
    ).toMatchObject({ count: 1 })
  })

  it('finalizes the last scoped response with the exact context deadline', async () => {
    const supabase = getIntegrationSupabase()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inbound = await (supabase as any).rpc('enqueue_inbound_work', {
      p_provider: 'whatsapp_cloud',
      p_business_account_id: 'PHONE_NUMBER_ID',
      p_provider_message_id: 'wamid.scope-finalize',
      p_user_phone: '351900000009',
      p_event_at: new Date().toISOString(),
      p_payload_json: { type: 'text', text: 'scope' },
    })
    expect(inbound.error).toBeNull()
    const workId = inbound.data[0].work_id as string

    await enqueue('scope:finalize:progress', {
      recipient: '351900000009',
      workId,
      emissionIndex: 0,
      kind: 'progress',
    })
    const response = await enqueue('scope:finalize:response', {
      recipient: '351900000009',
      workId,
      emissionIndex: 1,
      kind: 'terminal',
    })
    const deadline = expiresIn(7)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const finalized = await (supabase as any).rpc('finalize_outbox_scope', {
      p_work_id: workId,
      p_last_outbox_id: response.outbox_id,
      p_message_kind: 'prompt',
      p_expires_at: deadline,
    })

    expect(finalized.error).toBeNull()
    expect(finalized.data[0]).toMatchObject({
      finalized: true,
      response_count: 1,
    })
    const stored = adminRows(
      `SELECT message_kind, expires_at FROM public.outbox_messages WHERE id = '${response.outbox_id}'`,
    )[0]
    expect(stored.message_kind).toBe('prompt')
    expect(new Date(stored.expires_at as string).toISOString()).toBe(deadline)
  })

  it('supersedes an earlier retryable response before releasing the final response', async () => {
    const recipient = '351900000050'
    const workId = await createInboundWork('wamid.scope-multi-response', recipient)
    const first = await enqueue('scope:multi-response:first', {
      recipient,
      workId,
      emissionIndex: 0,
      kind: 'terminal',
    })
    const [firstClaim] = await claim(
      'inline:scope-multi-response:first',
      GENERATION,
      90,
      first.outbox_id as string,
      true,
    )
    await recordResult(firstClaim, 'retryable')
    const final = await enqueue('scope:multi-response:final', {
      recipient,
      workId,
      emissionIndex: 1,
      kind: 'terminal',
    })

    const supabase = getIntegrationSupabase()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc('finalize_outbox_scope', {
      p_work_id: workId,
      p_last_outbox_id: final.outbox_id,
      p_message_kind: 'terminal',
      p_expires_at: expiresIn(15),
    })

    expect(error).toBeNull()
    expect(data[0]).toMatchObject({ finalized: true, response_count: 1 })
    expect(adminRows(`
      SELECT id, status, next_attempt_at
      FROM public.outbox_messages
      WHERE id IN ('${first.outbox_id}', '${final.outbox_id}')
      ORDER BY sequence_no
    `)).toEqual([
      expect.objectContaining({
        id: first.outbox_id,
        status: 'superseded',
        next_attempt_at: null,
      }),
      expect.objectContaining({ id: final.outbox_id, status: 'pending' }),
    ])
    expect(adminRows(`
      SELECT COUNT(*)::integer AS count
      FROM public.outbox_status_events
      WHERE outbox_id = '${first.outbox_id}'
        AND event_type = 'superseded_by_scope'
    `)[0]).toEqual({ count: 1 })

    const claimed = await claim(
      'sweeper:scope-multi-response:final',
      GENERATION,
      90,
      final.outbox_id as string,
    )
    expect(claimed.map((row) => row.outbox_id)).toEqual([final.outbox_id])
  })

  it('preserves earlier sending and accepted responses during finalization', async () => {
    for (const state of ['sending', 'api_accepted'] as const) {
      const suffix = state === 'sending' ? 'sending' : 'accepted'
      const recipient = state === 'sending' ? '351900000051' : '351900000052'
      const workId = await createInboundWork(`wamid.scope-preserve-${suffix}`, recipient)
      const first = await enqueue(`scope:preserve:${suffix}:first`, {
        recipient,
        workId,
        emissionIndex: 0,
        kind: 'terminal',
      })
      const [firstClaim] = await claim(
        `inline:scope-preserve:${suffix}`,
        GENERATION,
        90,
        first.outbox_id as string,
        true,
      )
      if (state === 'api_accepted') {
        await recordResult(firstClaim, 'api_accepted', `wamid.scope-preserve-${suffix}`)
      }
      const final = await enqueue(`scope:preserve:${suffix}:final`, {
        recipient,
        workId,
        emissionIndex: 1,
        kind: 'terminal',
      })

      const supabase = getIntegrationSupabase()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc('finalize_outbox_scope', {
        p_work_id: workId,
        p_last_outbox_id: final.outbox_id,
        p_message_kind: 'terminal',
        p_expires_at: expiresIn(15),
      })

      expect(error).toBeNull()
      expect(data[0]).toMatchObject({ finalized: true, response_count: 2 })
      expect(adminRows(`
        SELECT status
        FROM public.outbox_messages
        WHERE id = '${first.outbox_id}'
      `)[0]).toEqual({ status: state })
      expect(adminRows(`
        SELECT COUNT(*)::integer AS count
        FROM public.outbox_status_events
        WHERE outbox_id = '${first.outbox_id}'
          AND event_type = 'superseded_by_scope'
      `)[0]).toEqual({ count: 0 })
    }
  })

  it('quarantines an unfinalized scoped retry until scope finalization succeeds', async () => {
    const recipient = '351900000039'
    const supabase = getIntegrationSupabase()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inbound = await (supabase as any).rpc('enqueue_inbound_work', {
      p_provider: 'whatsapp_cloud',
      p_business_account_id: 'PHONE_NUMBER_ID',
      p_provider_message_id: 'wamid.scope-quarantine',
      p_user_phone: recipient,
      p_event_at: new Date().toISOString(),
      p_payload_json: { type: 'text', text: 'scope quarantine' },
    })
    expect(inbound.error).toBeNull()
    const workId = inbound.data[0].work_id as string
    const response = await enqueue('scope:quarantine:response', {
      recipient,
      workId,
      emissionIndex: 0,
      kind: 'terminal',
    })

    const inline = await claim(
      'inline:scope-quarantine',
      GENERATION,
      90,
      response.outbox_id as string,
      true,
    )
    expect(inline).toHaveLength(1)
    await recordResult(inline[0], 'retryable')

    expect(await claim(
      'inline:replay-before-finalize',
      GENERATION,
      90,
      response.outbox_id as string,
      true,
    )).toEqual([])
    expect(await claim('sweeper:before-finalize')).toEqual([])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listedBefore = await (supabase as any).rpc('list_outbox_sweeper_work', {
      p_generation: GENERATION,
      p_limit: 100,
    })
    expect(listedBefore.error).toBeNull()
    expect(listedBefore.data).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outbox_id: response.outbox_id }),
      ]),
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const finalized = await (supabase as any).rpc('finalize_outbox_scope', {
      p_work_id: workId,
      p_last_outbox_id: response.outbox_id,
      p_message_kind: 'terminal',
      p_expires_at: expiresIn(15),
    })
    expect(finalized.error).toBeNull()
    expect(finalized.data[0].finalized).toBe(true)

    const afterFinalize = await claim('sweeper:after-finalize')
    expect(afterFinalize.map((row) => row.outbox_id)).toContain(response.outbox_id)
  })

  it('serializes scope finalization against generation suspension', async () => {
    const generation = 'outbox-finalize-suspend-generation'
    const supabase = getIntegrationSupabase()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inbound = await (supabase as any).rpc('enqueue_inbound_work', {
      p_provider: 'whatsapp_cloud',
      p_business_account_id: 'PHONE_NUMBER_ID',
      p_provider_message_id: 'wamid.finalize-suspend',
      p_user_phone: '351900000035',
      p_event_at: new Date().toISOString(),
      p_payload_json: { type: 'text', text: 'scope race' },
    })
    expect(inbound.error).toBeNull()
    const workId = inbound.data[0].work_id as string

    await enqueue('scope-race:progress-1', {
      recipient: '351900000035',
      workId,
      emissionIndex: 0,
      kind: 'progress',
      generation,
    })
    await enqueue('scope-race:progress-2', {
      recipient: '351900000035',
      workId,
      emissionIndex: 1,
      kind: 'progress',
      generation,
    })
    const response = await enqueue('scope-race:response', {
      recipient: '351900000035',
      workId,
      emissionIndex: 2,
      kind: 'progress',
      generation,
    })
    const deadline = expiresIn(6)

    const [finalized, suspended] = await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase as any).rpc('finalize_outbox_scope', {
        p_work_id: workId,
        p_last_outbox_id: response.outbox_id,
        p_message_kind: 'prompt',
        p_expires_at: deadline,
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase as any).rpc('suspend_outbox_generation', {
        p_generation: generation,
        p_reason: 'finalize-race',
      }),
    ])

    expect(finalized.error).toBeNull()
    expect(finalized.data[0].finalized).toBe(true)
    expect(suspended.error).toBeNull()
    expect(
      adminRows(`
        SELECT COUNT(*)::integer AS count
        FROM public.outbox_messages
        WHERE rollout_generation = '${generation}'
          AND status IN ('pending', 'sending', 'retryable', 'unknown')
      `)[0],
    ).toMatchObject({ count: 0 })
    expect(
      adminRows(`
        SELECT COUNT(*)::integer AS count
        FROM public.outbox_messages
        WHERE rollout_generation = '${generation}'
          AND lease_token IS NOT NULL
      `)[0],
    ).toMatchObject({ count: 0 })
    expect(
      adminRows(`
        SELECT COUNT(*)::integer AS count
        FROM private.outbox_suspended_generations
        WHERE generation = '${generation}'
      `)[0],
    ).toMatchObject({ count: 1 })
    expect(
      adminRows(
        `SELECT message_kind FROM public.outbox_messages WHERE id = '${response.outbox_id}'`,
      )[0],
    ).toMatchObject({ message_kind: 'prompt' })
  })

  it('marks accepted delivery terminal and redacts common payload after seven days', async () => {
    const row = await enqueue('redact:common', {
      recipient: '351900000010',
    })
    const [claimed] = await claim('worker-redact')
    await recordResult(claimed, 'api_accepted', 'wamid.redact')

    expect(
      adminRows(
        `SELECT terminal_at IS NOT NULL AS terminal FROM public.outbox_messages WHERE id = '${row.outbox_id}'`,
      )[0],
    ).toMatchObject({ terminal: true })
    adminExec(
      `UPDATE public.outbox_messages SET created_at = NOW() - INTERVAL '8 days', expires_at = NOW() - INTERVAL '7 days', terminal_at = NOW() - INTERVAL '7 days' WHERE id = '${row.outbox_id}'`,
    )

    const supabase = getIntegrationSupabase()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const redacted = await (supabase as any).rpc('redact_outbox_payloads', {
      p_limit: 10,
    })
    expect(redacted.error).toBeNull()
    expect(redacted.data[0].redacted_count).toBe(1)
    expect(
      adminRows(
        `SELECT payload_json, payload_hash, payload_redacted_at IS NOT NULL AS redacted FROM public.outbox_messages WHERE id = '${row.outbox_id}'`,
      )[0],
    ).toMatchObject({ payload_json: null, payload_hash: expect.any(String), redacted: true })
  })

  it('redacts abandoned common payload seven days after creation', async () => {
    const row = await enqueue('redact:abandoned-shadow', {
      recipient: '351900000012',
      rolloutMode: 'shadow',
    })
    adminExec(
      `UPDATE public.outbox_messages SET created_at = NOW() - INTERVAL '8 days', expires_at = NOW() - INTERVAL '7 days' WHERE id = '${row.outbox_id}'`,
    )

    const supabase = getIntegrationSupabase()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const redacted = await (supabase as any).rpc('redact_outbox_payloads', {
      p_limit: 10,
    })

    expect(redacted.error).toBeNull()
    expect(redacted.data[0].redacted_count).toBe(1)
    expect(
      adminRows(
        `SELECT payload_json, payload_hash, payload_redacted_at IS NOT NULL AS redacted FROM public.outbox_messages WHERE id = '${row.outbox_id}'`,
      )[0],
    ).toMatchObject({ payload_json: null, payload_hash: expect.any(String), redacted: true })
  })

  it('rejects null limits instead of turning bounded maintenance into unbounded work', async () => {
    const row = await enqueue('null-limit:row', {
      recipient: '351900000028',
    })
    const supabase = getIntegrationSupabase()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const claimResult = await (supabase as any).rpc('claim_outbox_messages', {
      p_owner: 'worker-null-limit',
      p_generation: GENERATION,
      p_limit: null,
      p_lease_seconds: 90,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listResult = await (supabase as any).rpc('list_outbox_sweeper_work', {
      p_generation: GENERATION,
      p_limit: null,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const redactResult = await (supabase as any).rpc('redact_outbox_payloads', {
      p_limit: null,
    })

    expect(claimResult.error).not.toBeNull()
    expect(listResult.error).not.toBeNull()
    expect(redactResult.error).not.toBeNull()
    expect(
      adminRows(
        `SELECT status, attempt FROM public.outbox_messages WHERE id = '${row.outbox_id}'`,
      )[0],
    ).toMatchObject({ status: 'pending', attempt: 0 })
  })

  it('denies every direct DML privilege on outbox tables to API roles and PUBLIC', () => {
    const roleMatrix = adminRows(`
      WITH target_tables(table_name) AS (
        VALUES
          ('public.outbox_messages'),
          ('public.outbox_status_events')
      ), api_roles(role_name) AS (
        VALUES ('anon'), ('authenticated'), ('service_role')
      ), operations(privilege_type) AS (
        VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')
      )
      SELECT table_name, role_name, privilege_type,
        pg_catalog.has_table_privilege(
          role_name,
          table_name,
          privilege_type
        ) AS allowed
      FROM target_tables
      CROSS JOIN api_roles
      CROSS JOIN operations
      ORDER BY table_name, role_name, privilege_type
    `)

    expect(roleMatrix).toHaveLength(24)
    for (const row of roleMatrix) {
      expect(row.allowed).toBe(false)
    }

    const publicMatrix = adminRows(`
      WITH target_tables(table_name) AS (
        VALUES
          ('public.outbox_messages'),
          ('public.outbox_status_events')
      ), operations(privilege_type) AS (
        VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')
      )
      SELECT target_tables.table_name, operations.privilege_type,
        (
          SELECT COUNT(*)::integer
          FROM pg_catalog.aclexplode(
            COALESCE(
              target_class.relacl,
              pg_catalog.acldefault('r', target_class.relowner)
            )
          ) AS acl
          WHERE acl.grantee = 0
            AND acl.privilege_type = operations.privilege_type
        ) AS public_grants
      FROM target_tables
      JOIN pg_catalog.pg_class AS target_class
        ON target_class.oid = pg_catalog.to_regclass(target_tables.table_name)
      CROSS JOIN operations
      ORDER BY target_tables.table_name, operations.privilege_type
    `)

    expect(publicMatrix).toHaveLength(8)
    for (const row of publicMatrix) {
      expect(row.public_grants).toBe(0)
    }
  })

  it('exposes all privileged RPCs only to service_role with hardened definitions', () => {
    const rpcValues = privilegedRpcs
      .map((signature) => `('${signature}')`)
      .join(',\n')
    const rpcPrivileges = adminRows(`
      WITH target_rpcs(signature) AS (
        VALUES ${rpcValues}
      ), resolved AS (
        SELECT signature, pg_catalog.to_regprocedure(signature) AS oid
        FROM target_rpcs
      )
      SELECT resolved.signature,
        resolved.oid IS NOT NULL AS exact_signature_exists,
        COALESCE(pg_catalog.has_function_privilege(
          'service_role', resolved.oid, 'EXECUTE'
        ), FALSE) AS service_can_execute,
        COALESCE(pg_catalog.has_function_privilege(
          'anon', resolved.oid, 'EXECUTE'
        ), FALSE) AS anon_can_execute,
        COALESCE(pg_catalog.has_function_privilege(
          'authenticated', resolved.oid, 'EXECUTE'
        ), FALSE) AS authenticated_can_execute,
        (
          SELECT COUNT(*)::integer
          FROM pg_catalog.pg_proc AS public_proc
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(
              public_proc.proacl,
              pg_catalog.acldefault('f', public_proc.proowner)
            )
          ) AS acl
          WHERE public_proc.oid = resolved.oid
            AND acl.grantee = 0
            AND acl.privilege_type = 'EXECUTE'
        ) AS public_execute,
        COALESCE(target_proc.prosecdef, FALSE) AS security_definer,
        COALESCE(EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(target_proc.proconfig) AS config(setting)
          WHERE setting LIKE 'search_path=%'
        ), FALSE) AS pinned_search_path
      FROM resolved
      LEFT JOIN pg_catalog.pg_proc AS target_proc
        ON target_proc.oid = resolved.oid
      ORDER BY resolved.signature
    `)
    expect(rpcPrivileges).toHaveLength(privilegedRpcs.length)
    for (const signature of privilegedRpcs) {
      expect(rpcPrivileges.find((row) => row.signature === signature)).toEqual({
        signature,
        exact_signature_exists: true,
        service_can_execute: true,
        anon_can_execute: false,
        authenticated_can_execute: false,
        public_execute: 0,
        security_definer: true,
        pinned_search_path: true,
      })
    }
  })

  it('revokes every migration function immediately after its definition', () => {
    const migrationSource = readFileSync(OUTBOX_MIGRATION_PATH, 'utf8')
    const actualSignatures = extractFunctionSignatures(migrationSource)
    const expectedSignatures = [...migrationFunctionSignatures].sort()

    expect(actualSignatures).toHaveLength(expectedSignatures.length)
    expect(new Set(actualSignatures).size).toBe(actualSignatures.length)
    expect([...actualSignatures].sort()).toEqual(expectedSignatures)

    const bodyDdlMutation = migrationSource.replace(
      'BEGIN\n  SELECT * INTO v_row',
      "BEGIN\n  PERFORM 'CREATE OR REPLACE FUNCTION public.fake() RETURNS void';\n  SELECT * INTO v_row",
    )
    expect(bodyDdlMutation).not.toBe(migrationSource)
    expect(extractFunctionSignatures(bodyDdlMutation)).toEqual(actualSignatures)

    const migration = migrationSource
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/\s*\(\s*/g, '(')
      .replace(/\s*,\s*/g, ',')
      .replace(/\s+\)/g, ')')
      .replace(/;\s*/g, ';')

    for (const signature of migrationFunctionSignatures) {
      const functionName = signature.slice(0, signature.indexOf('('))
      const createMarker = `create or replace function ${functionName}(`
      const createIndex = migration.indexOf(createMarker)
      expect(createIndex, `missing definition for ${signature}`).toBeGreaterThan(-1)

      const nextCreateIndex = migration.indexOf(
        'create or replace function ',
        createIndex + createMarker.length,
      )
      const functionSection = migration.slice(
        createIndex,
        nextCreateIndex === -1 ? migration.length : nextCreateIndex,
      )
      const bodyEnd = functionSection.lastIndexOf('$$;')
      expect(bodyEnd, `missing body terminator for ${signature}`).toBeGreaterThan(-1)

      const expectedRevoke = `revoke all on function ${signature} from public,anon,authenticated,service_role;`
      expect(
        functionSection.slice(bodyEnd + '$$;'.length).trimStart()
          .startsWith(expectedRevoke),
        `REVOKE must immediately follow ${signature}`,
      ).toBe(true)
    }
  })

  it('keeps table revokes and RPC grants before the final schema reload', () => {
    const migrationSource = readFileSync(OUTBOX_MIGRATION_PATH, 'utf8')
    const nonCommentedMigration = stripSqlComments(migrationSource)
    const migration = nonCommentedMigration
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/\s*\(\s*/g, '(')
      .replace(/\s*,\s*/g, ',')
      .replace(/\s+\)/g, ')')
      .replace(/;\s*/g, ';')
    const tableRevoke = 'revoke select,insert,update,delete on table '
      + 'public.outbox_messages,public.outbox_status_events '
      + 'from public,anon,authenticated,service_role;'
    expect(migration).toContain(tableRevoke)

    const revokeIndexes = privilegedRpcs.map((signature) => migration.indexOf(
      `revoke all on function ${signature} from public,anon,authenticated,service_role;`,
    ))
    const grantIndexes = privilegedRpcs.map((signature) => migration.indexOf(
      `grant execute on function ${signature} to service_role;`,
    ))
    for (const [index, signature] of privilegedRpcs.entries()) {
      expect(revokeIndexes[index], `missing REVOKE for ${signature}`).toBeGreaterThan(-1)
      expect(grantIndexes[index], `missing GRANT for ${signature}`).toBeGreaterThan(-1)
    }

    expect(Math.min(...grantIndexes)).toBeGreaterThan(Math.max(...revokeIndexes))
    const normalizedStatements = splitSqlStatements(migrationSource).map(
      (statement) => statement
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/\s*,\s*/g, ',')
        .replace(/;\s*$/g, ';')
        .trim(),
    )
    const reloadStatement = "notify pgrst,'reload schema';"
    const reloadIndexes = normalizedStatements.flatMap((statement, index) => (
      statement === reloadStatement ? [index] : []
    ))
    expect(reloadIndexes).toHaveLength(1)
    expect(reloadIndexes[0]).toBe(normalizedStatements.length - 1)
  })

  it('runs the full quality gate while preserving local Supabase integration', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8')
      .replaceAll('\r\n', '\n')

    expect(workflow).toContain('name: lint · tsc · corpus · build')
    expect(workflow).not.toContain('npm run test:unit')
    expect(workflow).toMatch(/\n {6}- run: npm test\n\n {6}- run: npm run build\n/)
    expect(workflow).toContain('name: integration · supabase local')
    expect(workflow).toContain('run: supabase start')
    expect(workflow).toContain('npm run test:integration')
  })

  it('allows service-role RPCs but denies direct outbox table access', async () => {
    const service = getIntegrationSupabase()
    const direct = await service.from('outbox_messages').select('id').limit(1)
    expect(direct.error?.message).toMatch(/permission denied/i)

    expect(
      adminRows(`
        SELECT
          has_table_privilege('service_role', 'public.outbox_messages', 'SELECT') AS can_select,
          has_table_privilege('service_role', 'public.outbox_messages', 'INSERT') AS can_insert,
          has_table_privilege('service_role', 'public.outbox_messages', 'UPDATE') AS can_update,
          has_table_privilege('service_role', 'public.outbox_messages', 'DELETE') AS can_delete,
          has_table_privilege('service_role', 'private.outbox_suspended_generations', 'SELECT') AS can_read_generation_fence,
          has_table_privilege('service_role', 'private.outbox_fallback_fences', 'SELECT') AS can_read_fallback_fence
      `)[0],
    ).toEqual({
      can_select: false,
      can_insert: false,
      can_update: false,
      can_delete: false,
      can_read_generation_fence: false,
      can_read_fallback_fence: false,
    })

    const callbackPrivileges = adminRows(`
      WITH target AS (
        SELECT pg_catalog.to_regprocedure(
          'public.apply_outbox_callback(text,text,timestamptz,uuid,integer,integer,text,jsonb)'
        ) AS oid
      )
      SELECT
        oid IS NOT NULL AS exact_signature_exists,
        COALESCE(pg_catalog.has_function_privilege(
          'service_role', oid, 'EXECUTE'
        ), FALSE) AS service_can_execute,
        COALESCE(pg_catalog.has_function_privilege(
          'anon', oid, 'EXECUTE'
        ), FALSE) AS anon_can_execute,
        COALESCE(pg_catalog.has_function_privilege(
          'authenticated', oid, 'EXECUTE'
        ), FALSE) AS authenticated_can_execute,
        oid IS NOT NULL AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_proc AS p,
            LATERAL pg_catalog.aclexplode(
              COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
            ) AS acl
          WHERE p.oid = target.oid
            AND acl.grantee = 0
            AND acl.privilege_type = 'EXECUTE'
        ) AS public_revoked
      FROM target
    `)[0]
    expect(callbackPrivileges).toEqual({
      exact_signature_exists: true,
      service_can_execute: true,
      anon_can_execute: false,
      authenticated_can_execute: false,
      public_revoked: true,
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internalHelper = await (service as any).rpc(
      'project_outbox_bot_message',
      { p_outbox_id: null, p_provider_message_id: 'wamid.denied' },
    )
    expect(internalHelper.error).not.toBeNull()

    const anon = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false } },
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const denied = await (anon as any).rpc('enqueue_outbox_message', {
      p_provider: 'whatsapp_cloud',
      p_business_account_id: 'PHONE_NUMBER_ID',
      p_recipient: RECIPIENT,
      p_idempotency_key: 'anon:denied',
      p_message_kind: 'terminal',
      p_payload_json: { text: 'denied' },
      p_payload_hash: hashPayload({ text: 'denied' }),
      p_rollout_mode: 'active',
      p_rollout_generation: GENERATION,
      p_max_attempts: 5,
      p_expires_at: expiresIn(15),
    })
    expect(denied.error).not.toBeNull()
  })
})
