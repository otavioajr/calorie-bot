# Fase 2b — Correções pós-auditoria — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` task-by-task. Every behavior change follows RED → GREEN → focused verification → review → commit.

**Goal:** Remove the rollout, fallback, FIFO, callback-privacy, and observability defects found in the final Fase 2b audit without expanding the approved product scope.

**Architecture:** Preserve the approved outbox design. Split fallback policy into delivery authority and inbound-replay fencing, make `off` tolerate only the pre-migration missing-RPC condition, and keep Postgres as the source of truth for generation fences, FIFO finalization, callbacks, and redaction.

**Tech Stack:** Next.js 16, TypeScript strict, Vitest/MSW, Supabase JS against self-hosted PostgreSQL, PL/pgSQL.

## Global Constraints

- Work on `codex/fase2b-outbox-duravel`; do not create a worktree.
- Preserve `.cursor/settings.json` untouched and untracked.
- Do not apply the migration to the production VPS and do not activate rollout modes.
- Keep `OUTBOX_MODE=off` deployable before the additive migration.
- A suspended generation must never start a Meta POST, including fallback POSTs.
- `unknown` and post-acceptance callback failures never become retryable.
- Shadow remains direct-authoritative and must not depend on an outbox RPC after enqueue fails.
- Active fallback must remain one-shot; bot prompt/terminal fallback must fence inbound replay before POST.
- All SQL RPCs remain `SECURITY DEFINER SET search_path = ''`, revoked from `PUBLIC`, `anon`, and `authenticated`, with execute granted only to `service_role`.

---

### Task 1: Runtime fallback, pre-migration callbacks, and sweeper truthfulness

**Files:**
- Modify: `src/lib/outbox/service.ts`
- Modify: `src/app/api/webhook/whatsapp/route.ts`
- Modify: `src/app/api/cron/outbox-sweeper/route.ts`
- Modify: `tests/unit/outbox/service.test.ts`
- Modify: `tests/unit/outbox/fault-injection.test.ts`
- Modify: `tests/unit/webhook/route.test.ts`
- Modify: `tests/unit/cron/outbox-sweeper.test.ts`

**Interfaces:**
- Preserve `sendTextMessage(...): Promise<string | null>`.
- Add an outbox result boolean named `attemptResultPersisted` so the sweeper can distinguish delivery work whose DB result was not saved.
- Keep repository errors' existing optional `code` field.

- [ ] **Step 1: Write failing runtime tests**

Add tests proving:

```ts
// active OTP/reminder: a confirmed tombstone permits exactly one direct POST
expect(beforeUnsafeFallback).not.toHaveBeenCalled()
expect(sendMeta).toHaveBeenCalledOnce()
expect(result).toMatchObject({ route: 'enqueue-fallback', preventInboundReplay: false })

// active bot: completion fence happens before the fallback POST
expect(order).toEqual(['inbound-fence', 'begin-fallback', 'post', 'record'])

// bot progress never uses direct fallback
expect(sendMeta).not.toHaveBeenCalled()

// shadow: enqueue/RPC failure still uses the legacy direct authority
expect(result).toMatchObject({ route: 'enqueue-fallback', outboxId: null })
```

Add route tests where `projectOutboxCallback` returns `{ ok: false, error: { code: 'PGRST202' } }`:

```ts
OUTBOX_MODE='off'; OUTBOX_GENERATION='';  // response 200
OUTBOX_MODE='off'; OUTBOX_GENERATION='known-generation'; // response 503
```

Add a sweeper test where delivery resolves with `attemptResultPersisted: false`; assert `processed: 0` and `errors: 1`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm run test:unit -- tests/unit/outbox/service.test.ts tests/unit/outbox/fault-injection.test.ts tests/unit/webhook/route.test.ts tests/unit/cron/outbox-sweeper.test.ts
```

Expected: failures demonstrate the source/mode conflation, pre-migration 503, and false sweeper success.

- [ ] **Step 3: Implement the minimal runtime fixes**

In the service, separate:

```ts
const deliveryAuthority = config.mode === 'active'
const requiresInboundReplayFence =
  options.source === 'bot' && options.messageKind !== 'progress'
```

- Shadow enqueue failure: alert, fence inbound replay for bot prompt/terminal, then perform one legacy direct call without requiring an outbox tombstone. Direct failure still rejects.
- Active enqueue failure: keep the DB fallback fence/tombstone. Require the inbound callback only for bot prompt/terminal; OTP/reminder use the one-shot DB fence without an inbound callback; progress fails closed.
- Set `preventInboundReplay` from `requiresInboundReplayFence`, not from rollout mode.
- Set `attemptResultPersisted` from the actual `record_outbox_attempt_result` result.
- In the webhook, acknowledge a missing callback RPC only when mode is `off`, generation is blank, and the error code is `PGRST202` or `42883`; all other projection failures remain 503.
- Count sweeper success only when the promise fulfilled and `attemptResultPersisted` is true.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/outbox/service.ts src/app/api/webhook/whatsapp/route.ts src/app/api/cron/outbox-sweeper/route.ts tests/unit/outbox tests/unit/webhook/route.test.ts tests/unit/cron/outbox-sweeper.test.ts
git commit -m "fix: harden outbox runtime fallbacks"
```

---

### Task 2: Postgres rollback fence, FIFO finalization, callbacks, and lock ordering

**Files:**
- Modify: `supabase/migrations/20260713120000_outbox_messages.sql`
- Modify: `src/lib/outbox/repository.ts`
- Modify: `src/lib/outbox/callbacks.ts`
- Modify: `tests/integration/outbox-rpcs.test.ts`
- Modify: `tests/unit/outbox/repository.test.ts`
- Modify: `tests/unit/outbox/callbacks.test.ts`

**Interfaces:**
- Extend `ApplyCallbackInput` with `metaSubcode?: number | null`.
- Extend `apply_outbox_callback` with `p_meta_subcode INTEGER DEFAULT NULL`, and update its exact revoke/grant signature.
- Keep all existing RPC result shapes.

- [ ] **Step 1: Write failing database and adapter tests**

Add real-Postgres tests proving:

1. fallback fence → suspend generation → tombstone enqueue → begin fallback returns `started=false` and no lease;
2. tombstone enqueue → suspend generation → begin fallback also returns `started=false`;
3. callback-first positive OTP clears `payload_json` and sets `payload_redacted_at` in the callback transaction;
4. callback `error_subcode` is stored in `outbox_status_events.meta_subcode`;
5. finalizing the last response supersedes every earlier `pending`/`retryable` emission for the same work, not only progress, and the last response becomes claimable;
6. out-of-order callback timestamps retain the earliest evidence with `LEAST(existing, event_at)`;
7. maintenance and concurrent enqueue/finalize complete without deadlock.

Add unit adapter assertions that `metaSubcode` travels parser callback → repository RPC argument.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm run test:unit -- tests/unit/outbox/repository.test.ts tests/unit/outbox/callbacks.test.ts
npm run test:integration -- tests/integration/outbox-rpcs.test.ts
```

Expected: new assertions fail on the audited behavior.

- [ ] **Step 3: Implement the minimal SQL and adapter fixes**

- `begin_outbox_fallback_attempt`: read immutable generation, acquire the shared generation advisory lock before key/row locks, re-read the row, and return `started=false` when the generation exists in `private.outbox_suspended_generations`.
- `enqueue_outbox_message`: generation suspension reason has precedence over fallback-fence reason.
- `finalize_outbox_scope`: supersede all earlier `pending`/`retryable` rows for the work; keep already sending/accepted evidence monotonic; count only non-superseded prompt/terminal responses.
- `apply_outbox_callback`: store `meta_subcode`; redact OTP payload atomically on `sent`, `delivered`, or `read`; use `LEAST` for projected evidence timestamps.
- `record_outbox_attempt_result`: pass orphan `meta_subcode` when replaying callbacks.
- Claim maintenance: acquire the recipient advisory lock before each row lock/update (or an equivalent ordering that never holds a row while waiting for the recipient lock). Keep bounded `SKIP LOCKED` behavior.
- Update repository/callback adapter and exact function grants for the new callback parameter.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 commands. Expected: PASS against real Postgres.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260713120000_outbox_messages.sql src/lib/outbox/repository.ts src/lib/outbox/callbacks.ts tests/integration/outbox-rpcs.test.ts tests/unit/outbox/repository.test.ts tests/unit/outbox/callbacks.test.ts
git commit -m "fix: close outbox database races"
```

---

### Task 3: Fault matrix, operational gate, and release verification

**Files:**
- Modify: `tests/unit/outbox/fault-injection.test.ts`
- Modify: `tests/integration/webhook/webhook-e2e.test.ts`
- Modify: `tests/integration/outbox-rpcs.test.ts` only for atomic callback fault injection if not covered in Task 2
- Modify: `docs/ops/vps-outbox-sweeper.md`
- Modify: `.superpowers/sdd/progress.md`

- [ ] **Step 1: Complete the promised fault/story matrix**

Ensure executable coverage exists for webhook → enqueue → Meta → callback/replay plus synchronous 429, permanent rejection, socket/timeout unknown, OTP, reminder, and progress supersede. Add explicit crash assertions for:

1. enqueue before POST;
2. acceptance before WAMID persistence;
3. callback transaction rollback before projection completion (assert ledger and projection roll back together);
4. ambiguous enqueue after domain mutation;
5. abandoned sweeper lease becoming `unknown` without another POST.

Do not add production-only fault branches.

- [ ] **Step 2: Fix the operational progress gate**

Change `progress_after_response` to compare progress acceptance with the response's `scope_finalized` event time, including responses whose `accepted_at` is still null.

- [ ] **Step 3: Run complete verification**

```bash
npm test
npm run test:integration
npm run lint
npx tsc --noEmit
npm run build
```

Expected: all pass. Record exact counts and pre-existing warnings. Do not claim production smokes; production credentials, migration, cron, and rollout remain explicitly unexecuted.

- [ ] **Step 4: Final review and commit**

Run a whole-branch review against `main...HEAD`, fix every Critical/Important finding, verify `.cursor/settings.json` remains untracked, then:

```bash
git add tests docs/ops/vps-outbox-sweeper.md .superpowers/sdd/progress.md
git commit -m "test: close durable outbox audit gaps"
```
