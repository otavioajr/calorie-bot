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
  → Save to Postgres (VPS) → sendTextMessage() → Meta Cloud API
```

## Key Non-Obvious Details

**LLM:** Two providers via `LLM_PROVIDER` env var. OpenRouter is primary (supports vision for images); Ollama is local fallback. Auto-retries on failure. All responses validated with Zod in `src/lib/llm/schemas/`.

**Auth:** OTP delivered via WhatsApp, not email. Session stored in HTTP-only cookie `caloriebot-user-id`. Logic in `src/lib/auth/`.

**DB:** PostgreSQL self-hosted on the user's VPS — **not** Supabase Cloud. The app still uses `@supabase/supabase-js` via `NEXT_PUBLIC_SUPABASE_URL` / service-role key pointing at the VPS instance. Migrations live in `supabase/migrations/`. For production DB ops, use VPS access — do not assume Supabase Cloud dashboard or MCP.

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