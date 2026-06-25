# CLAUDE.md

## Commands

```bash
npm run dev               # Next.js dev server (localhost:3000, Turbopack via next.config.ts)
npm run build             # Production build
npm run lint              # ESLint (run before opening PRs)
npm test                  # Vitest — all tests
npm run test:unit         # Unit tests only (tests/unit/)
npm run test:integration  # Integration tests (tests/integration/)
npm run test:watch        # Vitest watch mode
npm run test:e2e          # Playwright E2E tests
```

## Message Flow

```
WhatsApp message
  → POST /api/webhook/whatsapp
  → parseWebhookPayload() + deduplication (processed_messages table)
  → handleIncomingMessage / handleIncomingAudio (Whisper) / handleIncomingImage
  → Find/create user → check onboarding → get conversation_state
  → Active context? → route to context flow (bot/flows/)
  → Otherwise → classify intent (rules-based keywords → LLM fallback)
  → Flow handler (meal-log, edit, summary, query, weight, settings,
                  meal-detail, onboarding, recalculate, help)
  → LLM analysis (OpenRouter primary, Ollama fallback — transparent to callers)
  → Save to Supabase → sendTextMessage() → Meta Cloud API
```

## Key Non-Obvious Details

**LLM:** Two providers via `LLM_PROVIDER` env var. OpenRouter is primary (supports vision for images); Ollama is local fallback. Auto-retries on failure. All responses validated with Zod in `src/lib/llm/schemas/`.

**Auth:** OTP delivered via WhatsApp, not email. Session stored in HTTP-only cookie `caloriebot-user-id`. Logic in `src/lib/auth/`.

**DB:** `src/lib/db/utils.ts` maps snake_case ↔ camelCase. Migrations in `supabase/migrations/`.

**Quoted messages:** `src/lib/bot/quote.ts` resolves replied-to messages to their resource (meal, query) before routing.

**Food matching:** `src/lib/utils/food-normalize.ts` normalizes food names and fuzzy-matches the TACO table.

## Local Development

```bash
# Terminal 1
npm run dev

# Terminal 2
ngrok http 3000   # Copy URL → WEBHOOK_BASE_URL in .env.local
                  # Also update webhook URL in Meta for Developers dashboard
```

ngrok URL changes on each restart. See `.env.example` for all required variables.

## Code Conventions

- TypeScript `strict`; `@/*` → `src/*`
- 2-space indent; thin route handlers delegate to `src/lib/`
- `PascalCase` components, `kebab-case` all other files
- Tests: `*.test.ts` in `tests/unit/<domain>/`; MSW mocks in `tests/mocks/`
- Commits: Conventional Commits (`feat:`, `fix:`, `chore:`, …)

## References

- Product requirements: `PRD.md`
- Implementation specs and plans: `docs/superpowers/`


## Additional Notes
- When the user says "Use the agent teams or in portuguese use "Use o times de agentes" always use TeamCreate."

## Cursor Cloud specific instructions

The startup update script only runs `npm install`. Lint (`npm run lint`), tests
(`npm test`/`test:unit`/`test:integration`), and build (`npm run build`) need no
external services — the WhatsApp send API is mocked with MSW in tests.

Running the app against data requires a **local Supabase stack (Docker)**, since
`@supabase/supabase-js` talks to the Supabase REST API, not raw Postgres. Docker
and the Supabase CLI (`/usr/local/bin/supabase`) are expected to be present in
the VM image; if Docker is missing, install Docker Engine + `fuse-overlayfs` and
the CLI. To run end to end:

1. Start the Docker daemon if it isn't running: `sudo dockerd > /tmp/dockerd.log 2>&1 &`
   then `sudo chmod 666 /var/run/docker.sock` so the CLI can reach it.
2. `supabase start` (uses `supabase/config.toml`, Postgres major_version 17,
   applies `supabase/migrations/`, then runs `supabase/seed.sql`).
3. Create `.env.local` (git-ignored) with the **local** stack values. The local
   anon/service_role keys are the standard, non-secret demo keys and are stable
   across restarts — get them anytime with `supabase status -o env`
   (`API_URL`→`NEXT_PUBLIC_SUPABASE_URL`, `ANON_KEY`→`NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SERVICE_ROLE_KEY`→`SUPABASE_SERVICE_ROLE_KEY`). WhatsApp/LLM vars can be
   placeholders for rules-based flows.
4. `npm run dev` (port 3000).

Non-obvious gotchas:

- `supabase/seed.sql` exists **only** for local dev: it `GRANT`s DML on the
  `public` tables to `anon`/`authenticated`/`service_role`. The migrations do not
  grant these (the cloud project relies on Supabase default privileges), so
  without the seed every DB call fails with `permission denied for table ...`
  even though `service_role` has `BYPASSRLS`. Seeds run on `supabase start`
  (first init) and `supabase db reset`.
- No real WhatsApp/Meta creds locally: `sendTextMessage` throws (HTTP 401) and
  the handler logs `[handler] Failed to send message`. This is expected and does
  NOT block DB writes — the bot's reply text is visible in the dev server log
  (`[handler] Sending onboarding response ...`). Simulate inbound messages by
  POSTing to `/api/webhook/whatsapp` (see `scripts/test-webhook.sh`); the POST
  webhook has no signature check.
- Onboarding and other rules-based flows need **no LLM**. Meal logging, intent
  classification, and image/vision flows DO need a real LLM (set
  `LLM_PROVIDER=openrouter` + `LLM_API_KEY`, or run Ollama locally and set
  `LLM_PROVIDER=ollama`).
- Docker here uses the `fuse-overlayfs` storage driver with
  `containerd-snapshotter` disabled (`/etc/docker/daemon.json`) and
  `iptables-legacy`; required for Docker-in-Docker in this environment.