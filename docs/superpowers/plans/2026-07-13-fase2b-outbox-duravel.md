# Fase 2b — Outbox durável e callbacks da Meta — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Every task follows RED → GREEN → REFACTOR → focused verification → commit.

**Goal:** Persist every bot, OTP, and reminder outbound message before delivery; recover explicit transient failures without replaying domain handlers; and project Meta callbacks monotonically while preserving FIFO per recipient.

**Architecture:** An additive Postgres outbox and append-only event ledger expose service-role-only RPCs. A low-level Meta client owns HTTP semantics, while an outbox service owns persistence, rollout, delivery, retry, and redaction. Inbound handlers receive an `AsyncLocalStorage` emission scope keyed by `workId + emissionIndex`; OTP and reminders use source-specific keys. Webhook parsing emits both inbound messages and delivery statuses from the same payload.

**Tech Stack:** Next.js 16, TypeScript strict, Supabase JS against self-hosted PostgreSQL, PostgreSQL PL/pgSQL, Vitest/MSW, VPS cron.

**Spec:** [2026-07-13-fase2b-outbox-duravel-design.md](../specs/2026-07-13-fase2b-outbox-duravel-design.md)

## Non-negotiable invariants

- The migration is additive and deploys with `OUTBOX_MODE=off`.
- `shadow` rows are permanently non-claimable; changing the runtime mode must never send them later.
- Bot `active` mode requires `INBOUND_WORK_ENABLED=true`; OTP/reminders have their own durable identities.
- Enqueue is idempotent by logical key and rejects the same key with a different payload hash.
- A stale `sending` lease becomes `unknown`, never `retryable` and never automatically re-claimed.
- FIFO means Meta submission order. `api_accepted` releases the next message; a later callback `failed` is terminal + alert and never triggers automatic retry.
- Only a synchronous rejection proven to precede `api_accepted` can become `retryable`.
- `unknown` blocks its recipient only for the five-minute reconciliation window, then releases FIFO without becoming retryable; later positive proof may still advance it.
- Callbacks are processed even while `OUTBOX_MODE=off`, including callback-before-result and fallback correlation by any historical `wamid`.
- `bot_messages` remains a separate quote/resource projection; do not add a risky production uniqueness constraint in this phase.
- The webhook health alert calls the low-level Meta client directly.
- Preserve the existing positional `sendTextMessage(to, text, replyTo?)` compatibility; semantic options are additive.
- Preserve `.cursor/settings.json` untouched and untracked.

## File map

```text
supabase/migrations/20260713120000_outbox_messages.sql     CREATE
src/lib/outbox/types.ts                                    CREATE
src/lib/outbox/policy.ts                                   CREATE
src/lib/outbox/repository.ts                               CREATE
src/lib/outbox/service.ts                                  CREATE
src/lib/outbox/scope.ts                                    CREATE
src/lib/outbox/callbacks.ts                                CREATE
src/lib/whatsapp/meta-client.ts                            CREATE
src/lib/whatsapp/client.ts                                 MODIFY
src/lib/whatsapp/webhook.ts                                MODIFY
src/lib/bot/inbound-processor.ts                           MODIFY
src/lib/bot/handler.ts                                     MODIFY
src/lib/bot/flows/meal-log.ts                              MODIFY
src/lib/db/queries/context.ts                              MODIFY/REUSE
src/lib/db/queries/auth-codes.ts                           MODIFY
src/lib/db/queries/bot-messages.ts                         MODIFY
src/lib/auth/otp.ts                                        MODIFY
src/app/api/webhook/whatsapp/route.ts                      MODIFY
src/app/api/cron/outbox-sweeper/route.ts                   CREATE
src/app/api/cron/reminders/route.ts                        MODIFY
src/app/api/cron/webhook-health/route.ts                   MODIFY
tests/unit/outbox/*.test.ts                                CREATE
tests/unit/whatsapp/client.test.ts                         MODIFY
tests/unit/whatsapp/webhook.test.ts                        MODIFY
tests/unit/bot/inbound-processor.test.ts                   MODIFY
tests/unit/auth/otp.test.ts                                MODIFY
tests/unit/cron/reminders.test.ts                          MODIFY
tests/unit/cron/outbox-sweeper.test.ts                     CREATE
tests/integration/outbox-rpcs.test.ts                      CREATE
tests/mocks/handlers.ts                                    MODIFY
tests/helpers/*                                            MODIFY AS NEEDED
.env.example                                               MODIFY
vercel.json                                                MODIFY
docs/ops/vps-outbox-sweeper.md                             CREATE
```

---

### Task 1: Pure policy, configuration, hashing, and rollout

**Files:**
- Create: `src/lib/outbox/types.ts`
- Create: `src/lib/outbox/policy.ts`
- Create: `tests/unit/outbox/policy.test.ts`

- [ ] **Step 1: Write failing policy tests**

Cover canonical JSON hashing; `workId:emissionIndex`, `otp:<authCodeId>`, and reminder keys; TTLs; max attempts; `1m → 2m → 5m → 5m`; error classification; deterministic percentage selection; allowlist precedence; and monotonic callback transitions for every projection state.

Required assertions:

```ts
expect(buildInboundKey('work-1', 0)).toBe('inbound:work-1:0')
expect(policyFor('progress').maxAttempts).toBe(1)
expect(policyFor('otp').maxAttempts).toBe(3)
expect(nextProjection('read', { status: 'sent' })).toBe('read')
expect(nextProjection('unknown', { status: 'delivered' })).toBe('delivered')
expect(nextProjection('api_accepted', { status: 'failed' })).toBe('failed_terminal')
expect(nextProjection('failed_terminal', { status: 'delivered' })).toBe('delivered')
expect(classifySynchronousFailure({ httpStatus: 429 }).retryable).toBe(true)
expect(classifyCallbackFailure({ code: 130429 }).retryable).toBe(false)
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:unit -- tests/unit/outbox/policy.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement the minimum pure domain layer**

Define the 12 projection states, five message kinds, typed Meta outcomes/events, canonical serialization + SHA-256 hashing, TTL/backoff helpers, normalized error policy, rollout config parsing, and deterministic recipient bucketing. Reject invalid `OUTBOX_MODE`, blank active generation, or active bot mode without inbound work.

- [ ] **Step 4: Verify GREEN and refactor**

Run: `npm run test:unit -- tests/unit/outbox/policy.test.ts`

Expected: PASS with no timers or network.

- [ ] **Step 5: Commit**

```bash
git add src/lib/outbox/types.ts src/lib/outbox/policy.ts tests/unit/outbox/policy.test.ts
git commit -m "feat: add durable outbox policies"
```

---

### Task 2: Additive Postgres schema and service-role RPCs

**Files:**
- Create: `supabase/migrations/20260713120000_outbox_messages.sql`
- Create: `src/lib/outbox/repository.ts`
- Create: `tests/integration/outbox-rpcs.test.ts`
- Modify: integration database reset/grant helpers discovered by `rg "inbound_work|TRUNCATE|ensure.*grant" tests`

- [ ] **Step 1: Write failing real-Postgres tests**

Exercise, from independent clients/transactions:

1. concurrent enqueue returns one row for identical key/hash;
2. same key/different hash reports `idempotency_conflict` without overwrite;
3. recipient sequence is monotonic under concurrency;
4. claim returns at most the FIFO head per recipient and honors TTL, attempt cap, generation, `next_attempt_at`, and leases;
5. `api_accepted` releases the next sequence;
6. stale `sending` is reconciled to `unknown`, not re-claimed;
7. callbacks arrive out of order, before send-result persistence, and with multiple historical `wamid` values;
8. positive late callback advances `unknown`; lower-precedence callback never regresses;
9. callback `failed` after acceptance becomes terminal + alert with no retry schedule, while later `delivered`/`read` proof may still advance it;
10. generation suspension and redaction are idempotent;
11. shadow rows never appear in claims, including after mode/generation changes;
12. `anon`, `authenticated`, and `PUBLIC` cannot read tables or execute RPCs; `service_role` can execute approved RPCs but cannot access outbox tables directly.
13. concurrent prompt/terminal enqueue and progress claim serialize on the same recipient lock: progress becomes `superseded` before it can be claimed after the terminal exists;
14. concurrent send-result and callback projection create exactly one outgoing `bot_messages` row, including callback-before-result recovery.

- [ ] **Step 2: Verify RED**

Run: `npm run test:integration -- tests/integration/outbox-rpcs.test.ts`

Expected: FAIL because migration/RPCs are absent. If Docker is unavailable, record that infrastructure blocker but continue unit work; do not mark this task verified until it runs against real Postgres.

- [ ] **Step 3: Implement schema and RPCs**

Create `outbox_messages` and `outbox_status_events` with constraints, indexes, timestamps, rollout mode/generation, immutable logical identity/hash, recipient sequence, leases, attempts, status, all provider IDs, correlation fields, errors, TTL, redaction marker, outgoing quote/resource projection data, and a `bot_message_projected_at` coordination marker. Permit orphan callback ledger rows (`outbox_id NULL`) so they can be linked later.

Implement `SECURITY DEFINER SET search_path = ''` RPCs with fully-qualified objects:

- `enqueue_outbox_message`
- `claim_outbox_messages`
- `record_outbox_attempt_result`
- `apply_outbox_callback`
- `finalize_outbox_scope`
- `list_outbox_sweeper_work`
- `suspend_outbox_generation`
- `redact_outbox_payloads`

Enable RLS with no table policies; revoke direct outbox-table access from `PUBLIC`, `anon`, `authenticated`, **and `service_role`**; grant `service_role` execution only on the approved RPCs. Use function-owner privileges behind `SECURITY DEFINER`. Make enqueue, supersede, and claim acquire the same per-recipient advisory/row lock so a prompt/terminal atomically supersedes unsent progress before a competing claim. In `record_outbox_attempt_result` and `apply_outbox_callback`, lock the outbox row and insert the outgoing `bot_messages` projection plus `bot_message_projected_at` in the same transaction, so acceptance by inline send, sweeper, or recovery callback cannot duplicate the projection without adding a production uniqueness constraint.

Update `tests/integration/helpers/ensure-grants.ts` so its broad legacy grants do not re-grant direct access to the two outbox tables after migrations. The privilege test must separately prove that `service_role` can execute every approved RPC and cannot `SELECT`, `INSERT`, `UPDATE`, or `DELETE` either outbox table directly.

- [ ] **Step 4: Add a thin typed repository**

Wrap each RPC, validate returned shapes, distinguish “not found” from database failure, and expose no direct table mutations to runtime code.

- [ ] **Step 5: Verify GREEN**

Run: `npm run test:integration -- tests/integration/outbox-rpcs.test.ts`

Expected: PASS against the local PostgreSQL/Supabase stack.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260713120000_outbox_messages.sql src/lib/outbox/repository.ts tests/integration tests/helpers
git commit -m "feat: add durable outbox schema and rpcs"
```

---

### Task 3: Low-level Meta client and durable delivery service

**Files:**
- Create: `src/lib/whatsapp/meta-client.ts`
- Create: `src/lib/outbox/service.ts`
- Modify: `src/lib/whatsapp/client.ts`
- Modify: `tests/unit/whatsapp/client.test.ts`
- Create: `tests/unit/outbox/service.test.ts`
- Modify: `tests/mocks/handlers.ts`

- [ ] **Step 1: Write failing Meta-client tests**

Verify payload formatting, reply context, `biz_opaque_callback_data`, accepted `messages[0].id`, normalized 429/5xx/transient and permanent 4xx errors, malformed acceptance, and abort/socket failures as `outcome_unknown` once POST begins.

- [ ] **Step 2: Write failing service tests**

Verify persist-before-POST; idempotent replay; return type `wamid | null`; inline claim/delivery; attempt result persistence; progress single attempt; OTP caps; explicit transient scheduling; permanent failure; unknown with five-minute reconciliation and no retry; superseding earlier progress; and `bot_messages` projection only when a `wamid` exists.

Also test rollout:

- `off`: direct Meta, no outbox;
- `shadow`: ledger/correlation row plus one authoritative direct send, permanently nonclaimable;
- `active`: outbox authoritative only for eligible recipients;
- enqueue failure after possible mutation: exactly one direct attempt, critical alert result, and a scope marker that prevents inbound replay.

Preserve legacy failure contracts: a direct Meta failure in `off` or `shadow` rejects the promise, so reminders/OTP cannot mark themselves sent. In `active`, after durable enqueue, `null` is a valid delivery result for pending/retryable/unknown/terminal failure and the source records success according to durable outbox semantics.

- [ ] **Step 3: Verify RED**

Run: `npm run test:unit -- tests/unit/whatsapp/client.test.ts tests/unit/outbox/service.test.ts`

Expected: FAIL on missing modules/behavior.

- [ ] **Step 4: Implement the split**

Move raw Graph HTTP into `meta-client.ts`. Keep `sendTextMessage(to, text, replyTo?)` source-compatible, adding an optional options object only in a backward-compatible position. The outbox service must call the repository first, send `outbox_id` as opaque callback data, classify the typed result, persist it, and never auto-resend unknown outcomes.

Expose an explicit `sendTextMessageDirect`/low-level call for webhook health. Do not upgrade the Graph API version in this phase.

- [ ] **Step 5: Verify GREEN and regressions**

Run: `npm run test:unit -- tests/unit/whatsapp/client.test.ts tests/unit/outbox/service.test.ts`

Run: `npm run test:unit -- tests/unit/bot/handler.test.ts`

Expected: PASS, including existing exact positional-call expectations.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp src/lib/outbox/service.ts tests/unit/whatsapp tests/unit/outbox/service.test.ts tests/mocks/handlers.ts
git commit -m "feat: route WhatsApp delivery through outbox"
```

---

### Task 4: Inbound emission scope and durable completion semantics

**Files:**
- Create: `src/lib/outbox/scope.ts`
- Modify: `src/lib/bot/inbound-processor.ts`
- Modify: `src/lib/bot/handler.ts`
- Modify: `src/lib/bot/flows/meal-log.ts`
- Modify: `src/lib/db/queries/bot-messages.ts`
- Modify: `tests/unit/bot/inbound-processor.test.ts`
- Modify: `tests/unit/bot/handler.test.ts`
- Create: `tests/unit/outbox/scope.test.ts`

- [ ] **Step 1: Write failing scope tests**

Test independent concurrent `AsyncLocalStorage` scopes, stable zero-based emission indexes, semantic kind/TTL metadata, terminal tracking, progress supersede, resource metadata propagation, and replay hash conflict reporting.

- [ ] **Step 2: Write failing inbound completion tests**

Prove:

- active mode refuses to start when `INBOUND_WORK_ENABLED` is not true;
- inbound becomes `committed` after a prompt/terminal is durably enqueued even if Meta delivery remains pending/retryable/unknown;
- progress-only completion becomes `missing_terminal_outbox` and alerts;
- enqueue failure fallback is attempted once and records “do not replay handler” completion;
- replay reuses each `workId + emissionIndex` and makes no second Meta POST;
- audio/image progress followed by terminal/prompt supersedes progress;
- existing incoming `bot_messages` behavior remains intact and outgoing projection is idempotent without a new uniqueness constraint.
- after the handler, the last non-progress emission uses the real active `conversation_context.expires_at`; an active context other than isolated `recent_meal` makes it a `prompt`, while no qualifying context makes it `terminal` with the 15-minute TTL. The ten-minute prompt fallback applies only when a caller explicitly declares prompt semantics without an associated context.

- [ ] **Step 3: Verify RED**

Run: `npm run test:unit -- tests/unit/outbox/scope.test.ts tests/unit/bot/inbound-processor.test.ts tests/unit/bot/handler.test.ts`

- [ ] **Step 4: Implement scope and migrate bot callers**

Wrap handler dispatch in a Node-runtime outbound scope carrying `workId`, recipient, user, emission counter, and result summary. Classify the three explicit progress messages separately and initially persist other bot emissions as provisional `terminal` rows, which immediately supersede pending progress. After handler completion, query the active context through `getActiveContext` and call `finalize_outbox_scope` to atomically reclassify the last non-progress emission as prompt/terminal with the exact deadline. Treat isolated `recent_meal` as terminal. This makes the context TTL executable without changing `setState()`'s public return type or dozens of positional calls. Carry optional resource metadata into the outbox.

Update completion logic to depend on durable prompt/terminal representation, not Meta acceptance. Keep `processed_messages` unchanged.

- [ ] **Step 5: Verify GREEN**

Run the focused tests above, then:

Run: `npm run test:unit -- tests/unit/bot`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/outbox/scope.ts src/lib/bot src/lib/db/queries/bot-messages.ts tests/unit/outbox/scope.test.ts tests/unit/bot
git commit -m "feat: scope durable outbound emissions per inbound"
```

---

### Task 5: Combined webhook parser and monotonic callback projection

**Files:**
- Create: `src/lib/outbox/callbacks.ts`
- Modify: `src/lib/whatsapp/webhook.ts`
- Modify: `src/app/api/webhook/whatsapp/route.ts`
- Modify: `tests/unit/whatsapp/webhook.test.ts`
- Modify: `tests/unit/webhook/route.test.ts`
- Create: `tests/unit/outbox/callbacks.test.ts`

- [ ] **Step 1: Write failing parser tests**

Use fixtures with multiple entries/changes where each value may contain both `messages[]` and `statuses[]`. Assert every event is preserved with timestamp, `wamid`, recipient, phone/WABA identifiers, `biz_opaque_callback_data`, and normalized errors; unknown status strings remain ledger events.

- [ ] **Step 2: Write failing callback/route tests**

Assert opaque outbox ID correlation first, historical `wamid` fallback second, orphan append when neither is currently linkable, later relinking, duplicates, out-of-order monotonicity, positive resolution of `unknown`, no callback retry after `api_accepted`, and callback processing while `OUTBOX_MODE=off`.

The signed route must process messages and statuses independently. Projection DB failure returns 503 so Meta can retry; unmatched legacy callback is acknowledged with an alert/metric rather than an infinite 5xx loop.

- [ ] **Step 3: Verify RED**

Run: `npm run test:unit -- tests/unit/whatsapp/webhook.test.ts tests/unit/outbox/callbacks.test.ts tests/unit/webhook/route.test.ts`

- [ ] **Step 4: Implement combined parsing and callback application**

Introduce a discriminated `WhatsAppWebhookEvent` union. Preserve the current message parser contract through a compatibility wrapper where necessary. Route status events to the repository regardless of rollout mode and inbound messages to the existing enqueue/processor flow.

- [ ] **Step 5: Verify GREEN**

Run the focused tests above, then rerun `tests/integration/outbox-rpcs.test.ts` for callback ordering and orphan relinking.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/webhook.ts src/lib/outbox/callbacks.ts src/app/api/webhook/whatsapp/route.ts tests/unit/whatsapp tests/unit/outbox/callbacks.test.ts tests/unit/webhook/route.test.ts
git commit -m "feat: project Meta delivery callbacks"
```

---

### Task 6: Sweeper, OTP, reminders, redaction, and health bypass

**Files:**
- Create: `src/app/api/cron/outbox-sweeper/route.ts`
- Modify: `src/lib/db/queries/auth-codes.ts`
- Modify: `src/lib/auth/otp.ts`
- Modify: `src/app/api/cron/reminders/route.ts`
- Modify: `src/app/api/cron/webhook-health/route.ts`
- Create: `tests/unit/cron/outbox-sweeper.test.ts`
- Modify: `tests/unit/auth/otp.test.ts`
- Modify: `tests/unit/cron/reminders.test.ts`
- Modify: webhook-health tests discovered with `rg "webhook-health" tests`

- [ ] **Step 1: Write failing sweeper tests**

Assert cron authentication, bounded claims, independent leases, one recipient head per pass, backoff/attempt cap/TTL, unknown reconciliation without resend, expired-head release, progress no retry, supersede, common-payload redaction after seven days, and safe partial batch failures.

- [ ] **Step 2: Write failing source-specific tests**

OTP: make `createAuthCode` return its ID; use `otp:<id>`, five-minute expiry, max three attempts, redact at `api_accepted` or expiry, and require a new OTP after asynchronous failure.

Reminders: use stable `reminder:<user>:<type>:<local-window>` keys with 15-minute TTL so replay creates no duplicate.

Health: prove it calls the direct Meta client and never touches the outbox.

- [ ] **Step 3: Verify RED**

Run: `npm run test:unit -- tests/unit/cron/outbox-sweeper.test.ts tests/unit/auth/otp.test.ts tests/unit/cron/reminders.test.ts`

- [ ] **Step 4: Implement delivery recovery and source migrations**

Build the one-minute sweeper endpoint around repository claims and the shared delivery service. Ensure runtime/config guards make `off` and suspended generations non-sending. Migrate OTP/reminders to explicit semantic send options and keys. Point webhook-health at direct Meta delivery.

- [ ] **Step 5: Verify GREEN**

Run focused unit tests and `tests/integration/outbox-rpcs.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/cron src/lib/auth/otp.ts src/lib/db/queries/auth-codes.ts tests/unit/cron tests/unit/auth
git commit -m "feat: recover outbox delivery for otp and reminders"
```

---

### Task 7: Fault injection, rollout operations, and release verification

**Files:**
- Modify: `.env.example`
- Modify: `vercel.json` only if the project intentionally schedules the endpoint there; otherwise document VPS cron only
- Create: `docs/ops/vps-outbox-sweeper.md`
- Create/Modify: `tests/unit/outbox/fault-injection.test.ts`
- Create/Modify: end-to-end MSW tests in the repository's existing webhook test area
- Modify: integration reset helpers

- [ ] **Step 1: Add failing story/fault tests**

Cover signed webhook → enqueue → Meta accepted → callback; inbound replay; 429; permanent rejection; timeout/socket unknown; OTP; reminder; and progress supersede. Inject crashes/failures:

1. after enqueue and before POST;
2. after Meta acceptance and before persisting `wamid`;
3. after callback append and before projection completion;
4. during outbox insert after a possible domain mutation;
5. during a sweeper lease.

Assert no duplicate automatic send, no handler replay caused by delivery, and recoverability/correlation through opaque ID or historical `wamid`.

- [ ] **Step 2: Verify RED, then implement only missing seams**

Run focused story/fault tests. Add dependency injection or narrow hooks only where required; do not add production-only fault branches.

- [ ] **Step 3: Document rollout and rollback**

Add all env vars with safe defaults (`OUTBOX_MODE=off`). Document VPS migration, one-minute authenticated cron, dashboards/queries, shadow ≥24h and ≥20 sends, allowlist → 10% → 50% → 100% with 24h per step, gates, generation suspension RPC, new generation for reactivation, redaction, and callback handling while off.

- [ ] **Step 4: Run complete automated verification**

```bash
npm test
npm run test:integration
npm run lint
npx tsc --noEmit
npm run build
```

Expected: all pass. If the current shell lacks `npm`, invoke the matching local Node binaries without changing dependencies. Integration verification requires a running local Docker/Postgres stack; never replace it with mocks in the final report.

- [ ] **Step 5: Run release smokes or explicitly record environment blockers**

With `OUTBOX_MODE=off`, smoke text, audio, image, OTP, reminder, and health alert. After migration in a non-production environment, smoke `shadow` and an allowlisted `active` recipient. Do not activate production or apply the VPS migration without explicit user authorization.

- [ ] **Step 6: Final self-review and commit**

Review the entire diff against the spec and invariants; scan for secrets, placeholders, direct outbox table writes, unexpected legacy path changes, and `.cursor/settings.json` staging.

```bash
git add .env.example vercel.json docs/ops tests src supabase/migrations/20260713120000_outbox_messages.sql
git restore --staged .cursor/settings.json 2>/dev/null || true
git commit -m "test: verify durable outbox rollout"
```

## Final acceptance checklist

- [ ] No idempotency key/hash conflicts in tests.
- [ ] No retry path exists for unknown outcomes or post-acceptance callback failures.
- [ ] No progress can be sent after its prompt/terminal.
- [ ] No shadow or suspended generation row is claimable.
- [ ] Every accepted attempt retains a correlatable `wamid` in the ledger.
- [ ] Callback parsing works with mixed payloads and mode `off`.
- [ ] RLS/grants are verified against real Postgres roles.
- [ ] Unit/corpus, integration, lint, TypeScript, and build pass freshly.
- [ ] Production migration/activation remains a separate, explicit operational action.
