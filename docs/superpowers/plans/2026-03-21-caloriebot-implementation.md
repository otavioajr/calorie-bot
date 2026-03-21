# CalorieBot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a WhatsApp-based calorie tracking bot with LLM-powered meal analysis, conversation state machine, and a complementary web dashboard.

**Architecture:** Next.js App Router handles both the WhatsApp webhook API and the web UI. Supabase provides Postgres + Auth + Realtime. LLM providers (OpenRouter/Ollama) are abstracted behind a common interface. The bot operates as a state machine with conversation context stored in the database.

**Tech Stack:** Next.js 15, TypeScript (strict), Supabase, Zod, Vitest, Playwright, MSW, shadcn/ui, Tailwind CSS, recharts

**Spec:** `docs/superpowers/specs/2026-03-21-caloriebot-design.md`
**PRD:** `PRD.md`
**Conventions:** `CLAUDE.md`

---

## Phase 1: Project Setup + Database

### Task 1: Initialize Next.js Project

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`
- Create: `src/app/layout.tsx`, `src/app/page.tsx`
- Create: `.env.example`, `.gitignore`

- [ ] **Step 1: Create Next.js project**

```bash
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm
```

Select: App Router YES, `src/` directory YES, Turbopack YES.

- [ ] **Step 2: Enable TypeScript strict mode**

In `tsconfig.json`, verify `"strict": true` is set (it should be by default).

- [ ] **Step 3: Install core dependencies**

```bash
npm install @supabase/supabase-js @supabase/ssr zod recharts
npm install -D vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom msw playwright @playwright/test
```

- [ ] **Step 4: Create .env.example**

Create `.env.example` with all variables from `CLAUDE.md` "Variaveis de Ambiente" section, values blank.
Add `CRON_SECRET=` for Vercel Cron.

- [ ] **Step 5: Update .gitignore**

Ensure `.env.local`, `.env`, `node_modules/`, `.next/` are in `.gitignore` (create-next-app does this, but verify). Add `.vercel/`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: initialize Next.js project with core dependencies"
```

---

### Task 2: Configure Vitest + MSW

**Files:**
- Create: `vitest.config.ts`
- Create: `tests/setup.ts`
- Create: `tests/mocks/handlers.ts`
- Create: `tests/mocks/server.ts`
- Modify: `package.json` (add test scripts)

- [ ] **Step 1: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    globals: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
```

- [ ] **Step 2: Create tests/setup.ts**

```typescript
import '@testing-library/jest-dom'
```

- [ ] **Step 3: Create MSW mock handlers**

Create `tests/mocks/handlers.ts` — empty array for now, will add handlers per feature.

```typescript
import { http, HttpResponse } from 'msw'

export const handlers = [
  // WhatsApp Meta API mock
  http.post('https://graph.facebook.com/v21.0/*/messages', () => {
    return HttpResponse.json({ messages: [{ id: 'wamid.test' }] })
  }),
]
```

Create `tests/mocks/server.ts`:

```typescript
import { setupServer } from 'msw/node'
import { handlers } from './handlers'

export const server = setupServer(...handlers)
```

- [ ] **Step 4: Add test scripts to package.json**

Add to `"scripts"`:

```json
"test": "vitest run",
"test:watch": "vitest",
"test:unit": "vitest run tests/unit",
"test:integration": "vitest run tests/integration",
"test:e2e": "npx playwright test"
```

- [ ] **Step 5: Verify setup — create a smoke test**

Create `tests/unit/smoke.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'

describe('smoke test', () => {
  it('should pass', () => {
    expect(1 + 1).toBe(2)
  })
})
```

Run: `npm test`
Expected: 1 test passes.

- [ ] **Step 6: Delete smoke test and commit**

```bash
rm tests/unit/smoke.test.ts
git add -A
git commit -m "chore: configure Vitest, MSW, and test scripts"
```

---

### Task 3: Supabase Migrations — Core Tables

**Files:**
- Create: `supabase/migrations/00001_create_users.sql`
- Create: `supabase/migrations/00002_create_user_settings.sql`
- Create: `supabase/migrations/00003_create_meals.sql`
- Create: `supabase/migrations/00004_create_supporting_tables.sql`
- Create: `supabase/migrations/00005_create_triggers_and_rls.sql`

Reference: PRD section 6.1 for exact column definitions + design spec section 3.4 for additions (`sex`, `timezone`, `calorie_target_manual`, `auth_codes`, `processed_messages`).

- [ ] **Step 1: Create migration 00001_create_users.sql**

Create the `users` table exactly as defined in PRD section 6.1, including the additions:
- `sex VARCHAR(10) CHECK (sex IN ('male','female'))`
- `timezone VARCHAR(50) DEFAULT 'America/Sao_Paulo'`
- `calorie_target_manual BOOLEAN DEFAULT FALSE`

Columns: `id`, `auth_id`, `phone`, `name`, `sex`, `age`, `weight_kg`, `height_cm`, `activity_level`, `goal`, `calorie_mode`, `daily_calorie_target`, `calorie_target_manual`, `tmb`, `tdee`, `timezone`, `onboarding_complete`, `onboarding_step`, `created_at`, `updated_at`.

- [ ] **Step 2: Create migration 00002_create_user_settings.sql**

`user_settings` table with additions: `last_reminder_sent_at`, `last_summary_sent_at`.

Columns: `id`, `user_id` (FK users), `reminders_enabled`, `daily_summary_time`, `reminder_time`, `detail_level`, `weight_unit`, `last_reminder_sent_at`, `last_summary_sent_at`, `created_at`, `updated_at`.

- [ ] **Step 3: Create migration 00003_create_meals.sql**

Two tables: `meals` and `meal_items` exactly as PRD defines them.

`meals`: `id`, `user_id`, `meal_type`, `total_calories`, `original_message`, `llm_response`, `registered_at`, `created_at`.

`meal_items`: `id`, `meal_id` (FK meals), `food_name`, `quantity_grams`, `calories`, `protein_g`, `carbs_g`, `fat_g`, `source`, `taco_id`, `created_at`.

- [ ] **Step 4: Create migration 00004_create_supporting_tables.sql**

Create: `taco_foods`, `weight_log`, `conversation_context`, `llm_usage_log`, `food_cache`, `auth_codes`, `processed_messages`.

Use exact column definitions from PRD section 6.1 + design spec sections 2.2 and 3.6.

- [ ] **Step 5: Create migration 00005_create_triggers_and_rls.sql**

Part A — `updated_at` trigger function + apply to: `users`, `user_settings`, `meals`, `meal_items`, `food_cache`. Use SQL from design spec section 3.7.

Part B — RLS policies:
- Enable RLS on all tables
- `users`: `auth.uid() = auth_id` for SELECT/UPDATE
- `user_settings`: `user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())`
- `meals`, `meal_items` (via meal.user_id), `weight_log`, `conversation_context`: same pattern
- `taco_foods`: SELECT for all authenticated, no INSERT/UPDATE/DELETE for anon
- `food_cache`: SELECT for all authenticated, INSERT/UPDATE via service role only
- `auth_codes`: no RLS (accessed via service role in API routes)
- `llm_usage_log`: SELECT own records, INSERT via service role
- `processed_messages`: no RLS (accessed via service role in webhook)

- [ ] **Step 6: Apply migrations to Supabase**

```bash
npx supabase db push
```

Verify: no errors.

- [ ] **Step 7: Generate TypeScript types**

```bash
npx supabase gen types typescript --project-id <id> > src/lib/db/types.ts
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: create database schema with migrations, RLS, and triggers"
```

---

### Task 4: Supabase Client Helpers

**Files:**
- Create: `src/lib/db/supabase.ts`
- Test: `tests/unit/db/supabase.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/unit/db/supabase.test.ts`. Test that `createServerClient()` and `createBrowserClient()` are functions that return objects. Test that `createServiceRoleClient()` returns a client. Mock env vars with `vi.stubEnv`.

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run test:unit -- tests/unit/db/supabase.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/lib/db/supabase.ts**

Three exports:
- `createBrowserClient()` — uses `@supabase/supabase-js` `createClient` with `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `createServerClient()` — uses `@supabase/ssr` `createServerClient` with cookies from `next/headers`
- `createServiceRoleClient()` — uses `@supabase/supabase-js` `createClient` with `SUPABASE_SERVICE_ROLE_KEY`

All typed with `Database` from `./types`.

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run test:unit -- tests/unit/db/supabase.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Supabase client helpers (browser, server, service role)"
```

---

## Phase 2: Core Utilities

### Task 5: TDEE Calculator

**Files:**
- Create: `src/lib/calc/tdee.ts`
- Test: `tests/unit/calc/tdee.test.ts`

Reference: CLAUDE.md "Calculos (TMB / TDEE)" section for formulas.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/calc/tdee.test.ts` with these test cases:

```typescript
// TMB calculation
- Male 80kg, 175cm, 30yo → 10*80 + 6.25*175 - 5*30 + 5 = 1747.75
- Female 60kg, 165cm, 25yo → 10*60 + 6.25*165 - 5*25 - 161 = 1320.25

// TDEE calculation (TMB * activity factor)
- Sedentary (1.2), Light (1.375), Moderate (1.55), Intense (1.725)

// Daily calorie target
- Goal 'lose': TDEE - 500
- Goal 'maintain': TDEE
- Goal 'gain': TDEE + 300

// Edge cases
- Should throw on invalid sex
- Should throw on weight/height/age out of range
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test:unit -- tests/unit/calc/tdee.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement src/lib/calc/tdee.ts**

Exports:
- `calculateTMB(sex: 'male' | 'female', weightKg: number, heightCm: number, age: number): number`
- `calculateTDEE(tmb: number, activityLevel: ActivityLevel): number`
- `calculateDailyTarget(tdee: number, goal: Goal): number`
- `calculateAll(params): { tmb, tdee, dailyTarget }` — convenience wrapper

Types: `ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'intense'`, `Goal = 'lose' | 'maintain' | 'gain'`.

Use Mifflin-St Jeor formulas exactly as in CLAUDE.md.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test:unit -- tests/unit/calc/tdee.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add TDEE calculator with Mifflin-St Jeor formula"
```

---

### Task 6: Input Validators

**Files:**
- Create: `src/lib/utils/validators.ts`
- Test: `tests/unit/utils/validators.test.ts`

Reference: PRD section 5.3 for validation rules per onboarding step.

- [ ] **Step 1: Write the failing tests**

Test each validator:
- `validateName(input)` — min 2 chars, no numbers. Valid: "João", "Ana Maria". Invalid: "", "A", "Jo3o".
- `validateAge(input)` — integer 12-120. Valid: "25", "12", "120". Invalid: "5", "121", "abc", "25.5".
- `validateSex(input)` — accepts "1", "2", "masculino", "feminino", "m", "f". Returns `'male'` or `'female'`.
- `validateWeight(input)` — decimal 30-300, accepts comma or dot. Valid: "72.5", "72,5", "80". Invalid: "25", "301", "abc".
- `validateHeight(input)` — integer 100-250. Valid: "175", "100", "250". Invalid: "99", "251", "abc".
- `validateActivityLevel(input)` — accepts "1"-"4" or text ("sedentário", "leve", etc.). Returns ActivityLevel type.
- `validateGoal(input)` — accepts "1"-"3". Returns Goal type.
- `validateCalorieMode(input)` — accepts "1"-"3". Returns CalorieMode type.
- `validatePhone(input)` — Brazilian phone format. Valid: "+5511999887766", "11999887766".

Each validator returns `{ valid: true, value: T } | { valid: false, error: string }`.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement src/lib/utils/validators.ts**

Implement all validators. Parse input strings, normalize (trim, lowercase), validate range/format, return typed result.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add input validators for onboarding steps"
```

---

### Task 7: Message Formatters

**Files:**
- Create: `src/lib/utils/formatters.ts`
- Test: `tests/unit/utils/formatters.test.ts`

Reference: PRD sections 5.3-5.10 for exact message formats.

- [ ] **Step 1: Write the failing tests**

Test:
- `formatMealBreakdown(items, total, dailyConsumed, dailyTarget)` — produces the "🍽️ Almoço registrado!" format from PRD 5.4
- `formatDailySummary(mealsByType, consumed, target)` — produces "📊 Resumo de hoje" format from PRD 5.5
- `formatWeeklySummary(dailyData, target)` — produces weekly format from PRD 5.5
- `formatWeightUpdate(current, previous, daysSince)` — "Peso registrado! ⚖️" format from PRD 5.8
- `formatProgressBar(consumed, target)` — "📊 Hoje: X / Y kcal (restam Z)" inline
- `formatOnboardingComplete(name, target)` — "Tudo pronto!" message from PRD 5.3
- `formatHelpMenu()` — full menu from PRD 5.9
- `formatSettingsMenu(currentSettings)` — settings menu from PRD 5.10
- `formatOutOfScope()` — the standard out-of-scope message
- `formatError()` — the standard error message

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement src/lib/utils/formatters.ts**

All messages in PT-BR with emojis as defined in PRD. Max 300 chars per message (except meal breakdown).

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add bot message formatters (PT-BR)"
```

---

## Phase 3: WhatsApp Integration

### Task 8: WhatsApp Webhook Parser

**Files:**
- Create: `src/lib/whatsapp/webhook.ts`
- Test: `tests/unit/whatsapp/webhook.test.ts`

Reference: Meta Cloud API webhook payload format.

- [ ] **Step 1: Write the failing tests**

Test `parseWebhookPayload(body)`:
- Valid text message payload → returns `{ type: 'text', from: '5511...', messageId: 'wamid...', text: 'almocei arroz' }`
- Valid status update → returns `{ type: 'status', ... }` (we ignore these)
- Invalid/empty payload → returns `null`
- Multiple messages in one payload → returns first message only

Test `isVerificationRequest(params)`:
- Valid GET with correct verify_token → returns challenge string
- Wrong verify_token → returns null

Use real Meta webhook payload shapes from the Meta Cloud API docs.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement src/lib/whatsapp/webhook.ts**

Parse the nested Meta webhook format:
```
body.entry[0].changes[0].value.messages[0]
```

Extract: `from` (phone), `id` (message_id), `text.body` (message text), `type`, `timestamp`.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add WhatsApp webhook payload parser"
```

---

### Task 9: WhatsApp Client (Send Messages)

**Files:**
- Create: `src/lib/whatsapp/client.ts`
- Test: `tests/unit/whatsapp/client.test.ts`

- [ ] **Step 1: Write the failing tests**

Test `sendTextMessage(to, text)`:
- Calls Meta API with correct URL, headers, and body
- Returns message ID on success
- Throws on API error with details

Use MSW to mock `https://graph.facebook.com/v21.0/{PHONE_NUMBER_ID}/messages`.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement src/lib/whatsapp/client.ts**

```typescript
export async function sendTextMessage(to: string, text: string): Promise<string>
```

POST to `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages` with:
- Header: `Authorization: Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`
- Body: `{ messaging_product: "whatsapp", to, type: "text", text: { body: text } }`

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add WhatsApp client for sending messages"
```

---

### Task 10: Webhook API Route (Skeleton)

**Files:**
- Create: `src/app/api/webhook/whatsapp/route.ts`
- Test: `tests/e2e/webhook.test.ts`

- [ ] **Step 1: Write the failing test**

Test the route directly:
- GET with valid verify_token → 200 with challenge
- GET with invalid verify_token → 403
- POST with valid message payload → 200 (for now, just acknowledge)
- POST with empty body → 200 (never return non-200 to Meta)

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement route.ts**

```typescript
// GET handler — webhook verification
export async function GET(request: Request) { ... }

// POST handler — receive messages
export async function POST(request: Request) {
  // 1. Parse payload
  // 2. Deduplicate by message_id (INSERT INTO processed_messages ON CONFLICT)
  // 3. TODO: process message (will be filled in Task 14)
  // 4. ALWAYS return 200
  return new Response('OK', { status: 200 })
}
```

Include the deduplication logic using `processed_messages` table (design spec section 3.6).

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add WhatsApp webhook route with verification and deduplication"
```

---

## Phase 4: Bot State Machine + Onboarding

### Task 11: Conversation State Manager

**Files:**
- Create: `src/lib/bot/state.ts`
- Create: `src/lib/db/queries/context.ts`
- Test: `tests/unit/bot/state.test.ts`

Reference: PRD section 5.13 for context types and TTLs.

- [ ] **Step 1: Write the failing tests**

Test `getActiveContext(userId)`:
- Returns active (non-expired) context if exists
- Returns null if context expired
- Returns null if no context

Test `setContext(userId, type, data, ttlMinutes)`:
- Creates new context (upserts — one active per user)
- Sets expires_at = now + ttlMinutes

Test `clearContext(userId)`:
- Deletes active context

Test TTL constants:
- `CONTEXT_TTLS.onboarding` = 1440 (24h)
- `CONTEXT_TTLS.awaiting_confirmation` = 5
- `CONTEXT_TTLS.awaiting_clarification` = 10
- etc.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement state.ts and context.ts**

`context.ts` — Supabase queries for `conversation_context` table:
- `getActiveContext(supabase, userId)` — SELECT WHERE user_id AND expires_at > NOW()
- `upsertContext(supabase, userId, type, data, expiresAt)` — DELETE existing + INSERT new
- `deleteContext(supabase, userId)` — DELETE WHERE user_id

`state.ts` — Higher-level state management:
- `getActiveContext(userId)` — wraps queries, returns typed context or null
- `setContext(userId, type, data)` — auto-calculates TTL from CONTEXT_TTLS map
- `clearContext(userId)` — wraps delete

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add conversation state manager with TTL-based context"
```

---

### Task 12: Intent Classifier (Rules-Based)

**Files:**
- Create: `src/lib/bot/router.ts`
- Test: `tests/unit/bot/router.test.ts`

Reference: PRD section 5.12 for keyword rules.

- [ ] **Step 1: Write the failing tests**

Test `classifyByRules(message)`:

```typescript
// Exact matches
'menu' → 'help'
'ajuda' → 'help'
'help' → 'help'

// Contains
'resumo da semana' → 'summary'
'como tô hoje' → 'summary'
'config' → 'settings'
'configurações' → 'settings'
'apaga o último' → 'edit'
'corrigir' → 'edit'
'pesei 78' → 'weight'
'meu peso' → 'weight'
'quantas calorias tem uma coxinha' → 'query'
'meus dados' → 'user_data'
'mudar objetivo' → 'settings'

// No match
'almocei arroz e feijão' → null (needs LLM)
'olá' → null
```

Return type: `IntentType | null`.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement classifyByRules in router.ts**

Ordered list of rules (check exact matches first, then `includes`/regex). Normalize input: lowercase, trim, remove accents.

```typescript
export type IntentType = 'meal_log' | 'summary' | 'edit' | 'query' | 'weight' | 'help' | 'settings' | 'user_data' | 'out_of_scope'

export function classifyByRules(message: string): IntentType | null
```

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add rules-based intent classifier"
```

---

### Task 13: Database Queries — Users + Settings

**Files:**
- Create: `src/lib/db/queries/users.ts`
- Create: `src/lib/db/queries/settings.ts`
- Test: `tests/integration/db/queries.test.ts`

- [ ] **Step 1: Write the integration tests**

Test against Supabase local (`supabase start` required).

`users.ts`:
- `findUserByPhone(phone)` → returns user or null
- `createUser(phone, name)` → creates user with onboarding_step=1, returns user
- `updateUser(userId, data)` → updates fields, returns updated user
- `getUserWithSettings(userId)` → joins user + user_settings

`settings.ts`:
- `createDefaultSettings(userId)` → creates with defaults
- `updateSettings(userId, data)` → updates fields

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test:integration -- tests/integration/db/queries.test.ts
```

- [ ] **Step 3: Implement queries**

Both files use `createServiceRoleClient()` for the webhook context (no auth context available from WhatsApp messages — the bot acts on behalf of users identified by phone number).

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add user and settings database queries"
```

---

### Task 14: Onboarding Flow

**Files:**
- Create: `src/lib/bot/flows/onboarding.ts`
- Test: `tests/unit/bot/onboarding.test.ts`

Reference: PRD section 5.3 for the full 8-step flow.

- [ ] **Step 1: Write the failing tests**

Test `handleOnboarding(user, message, context)`:

Each step returns `{ response: string, nextStep: number | 'complete' }`.

```typescript
// Step 0 (no context) — welcome message, expect name
{ step: 0, message: 'oi' } → response includes 'Eu sou o CalorieBot', nextStep: 1

// Step 1 — validate name
{ step: 1, message: 'João' } → saves name, response includes 'Prazer, João', nextStep: 2
{ step: 1, message: 'A' } → error message, nextStep: 1 (stays)

// Step 2 — validate age
{ step: 2, message: '28' } → saves age, nextStep: 2.5
{ step: 2, message: 'abc' } → error, nextStep: 2

// Step 2.5 — validate sex
{ step: 2.5, message: '1' } → saves 'male', nextStep: 3
{ step: 2.5, message: 'feminino' } → saves 'female', nextStep: 3

// Step 3 — validate weight
{ step: 3, message: '72.5' } → saves weight + creates weight_log entry, nextStep: 4

// Step 4 — validate height
// Step 5 — validate activity_level
// Step 6 — validate goal
// Step 7 — validate calorie_mode

// Step 8 — finalization
→ calculates TMB/TDEE/target, saves all, sets onboarding_complete=true
→ response includes daily target
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement onboarding.ts**

```typescript
export async function handleOnboarding(
  userId: string,
  message: string,
  context: OnboardingContext | null
): Promise<{ response: string; completed: boolean }>
```

State machine with 8 steps. Each step:
1. Validate input using validators from Task 6
2. If invalid → return error message, keep same step
3. If valid → save to DB, advance step, return next question
4. On final step → calculate TMB/TDEE (Task 5), save, mark complete

Use `setContext` to persist onboarding progress between messages.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add onboarding flow (8-step conversational signup)"
```

---

### Task 15: Wire Bot Router into Webhook

**Files:**
- Modify: `src/app/api/webhook/whatsapp/route.ts`
- Create: `src/lib/bot/handler.ts`
- Test: `tests/e2e/flows/onboarding.test.ts`

- [ ] **Step 1: Write the e2e test**

Simulate a full onboarding flow by sending sequential webhook POST requests:

```typescript
// POST message "oi" from new number → expect welcome message sent via Meta API mock
// POST message "João" → expect age question
// POST message "28" → expect sex question
// ... all 8 steps
// POST final choice → expect "Tudo pronto!" message with calorie target
```

Use MSW to capture outgoing WhatsApp API calls and verify message content.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement handler.ts**

```typescript
export async function handleIncomingMessage(from: string, messageId: string, text: string): Promise<void>
```

Pipeline:
1. Deduplicate (already in route.ts)
2. `findUserByPhone(from)` — if null, create user + start onboarding
3. Check `onboarding_complete` — if false, delegate to `handleOnboarding`
4. If complete — check active `conversation_context`
   - If context exists and not expired → delegate to context flow handler
   - If no context → `classifyByRules(text)` → delegate to flow
   - If classifyByRules returns null → TODO (LLM classification, Task 18)
5. Send response via `sendTextMessage(from, response)`

Wire `handler.ts` into `route.ts` POST handler.

- [ ] **Step 4: Run the e2e test**

Expected: Full onboarding completes, user created in DB with TMB/TDEE calculated.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: wire bot handler into webhook — onboarding works end-to-end"
```

---

## Phase 5: LLM Service

### Task 16: Zod Schemas for LLM Output

**Files:**
- Create: `src/lib/llm/schemas/common.ts`
- Create: `src/lib/llm/schemas/meal-analysis.ts`
- Create: `src/lib/llm/schemas/intent.ts`
- Test: `tests/unit/llm/schemas.test.ts`

Reference: PRD "JSON esperado da LLM" section for MealAnalysis shape.

- [ ] **Step 1: Write the failing tests**

Test that Zod schemas correctly validate/reject:

```typescript
// MealAnalysis — valid
{ meal_type: 'lunch', confidence: 'high', items: [...], unknown_items: [], needs_clarification: false } → parse succeeds

// MealAnalysis — invalid (missing required field)
{ meal_type: 'lunch' } → parse fails

// MealAnalysis — invalid (bad meal_type)
{ meal_type: 'brunch', ... } → parse fails

// IntentClassification — valid
{ intent: 'meal_log' } → parse succeeds

// IntentClassification — invalid
{ intent: 'invalid_type' } → parse fails
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement schemas**

`common.ts`: shared types — `CalorieMode`, `MealType`, `Confidence`.
`meal-analysis.ts`: `MealAnalysisSchema` and `MealAnalysis` type.
`intent.ts`: `IntentClassificationSchema` and `IntentType`.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Zod schemas for LLM output validation"
```

---

### Task 17: System Prompts

**Files:**
- Create: `src/lib/llm/prompts/approximate.ts`
- Create: `src/lib/llm/prompts/taco.ts`
- Create: `src/lib/llm/prompts/manual.ts`
- Create: `src/lib/llm/prompts/classify.ts`
- Test: `tests/unit/llm/prompts.test.ts`

Reference: PRD sections 5.4 and 5.12 for exact prompt text.

- [ ] **Step 1: Write the failing tests**

Test that each prompt builder:
- Returns a string containing key constraints ("APENAS em JSON", "NUNCA dê conselhos")
- `buildMealPrompt('taco', tacoContext)` includes TACO data in prompt
- `buildMealPrompt('approximate')` does NOT include TACO data
- `buildClassifyPrompt()` lists all intent categories

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement prompts**

Each file exports a `buildXxxPrompt()` function. Use the exact system prompt text from PRD section 5.4 (meal analysis) and 5.12 (classify).

`taco.ts` receives `TacoFood[]` context and injects it into the prompt.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add LLM system prompts for all calorie modes"
```

---

### Task 18: LLM Provider — OpenRouter

**Files:**
- Create: `src/lib/llm/provider.ts`
- Create: `src/lib/llm/providers/openrouter.ts`
- Test: `tests/unit/llm/openrouter.test.ts`

- [ ] **Step 1: Write the failing tests**

Mock OpenRouter API with MSW. Test:
- `analyzeMeal(message, 'approximate')` — sends correct request, parses and validates JSON response
- `classifyIntent(message)` — sends correct request with classify prompt, returns IntentType
- Returns validated `MealAnalysis` on valid response
- Retries once on invalid JSON, then throws
- Sends correct headers (`HTTP-Referer`, `X-Title`, `Authorization`)
- Uses `LLM_MODEL_MEAL` for meal analysis, `LLM_MODEL_CLASSIFY` for classification

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement provider.ts and openrouter.ts**

`provider.ts` — interface:

```typescript
export interface LLMProvider {
  analyzeMeal(message: string, mode: CalorieMode, context?: TacoFood[]): Promise<MealAnalysis>
  classifyIntent(message: string): Promise<IntentType>
  chat(message: string, systemPrompt: string): Promise<string>
}
```

`openrouter.ts` — implementation:
- POST to `https://openrouter.ai/api/v1/chat/completions`
- Use `response_format: { type: "json_object" }` for structured output
- Parse response, validate with Zod, retry once on parse failure
- Log usage to `llm_usage_log` (tokens, cost, latency, model)

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add OpenRouter LLM provider with retry and validation"
```

---

### Task 19: LLM Provider — Ollama

**Files:**
- Create: `src/lib/llm/providers/ollama.ts`
- Test: `tests/unit/llm/ollama.test.ts`

- [ ] **Step 1: Write the failing tests**

Same test structure as OpenRouter but with Ollama API format:
- POST to `http://localhost:11434/api/chat`
- Uses `format: "json"` and `stream: false`
- Uses `OLLAMA_MODEL_MEAL` and `OLLAMA_MODEL_CLASSIFY` env vars

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement ollama.ts**

Same `LLMProvider` interface. Different API format/URL.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Ollama LLM provider"
```

---

### Task 20: LLM Factory + Fallback + Usage Logging

**Files:**
- Create: `src/lib/llm/index.ts`
- Create: `src/lib/db/queries/llm-usage.ts`
- Test: `tests/unit/llm/factory.test.ts`

- [ ] **Step 1: Write the failing tests**

Test `getLLMProvider()`:
- `LLM_PROVIDER=openrouter` → returns OpenRouter instance
- `LLM_PROVIDER=ollama` → returns Ollama instance
- Invalid provider → throws

Test fallback wrapper:
- If `LLM_FALLBACK_PROVIDER` is set and primary fails → calls fallback
- If `LLM_FALLBACK_PROVIDER` is empty and primary fails → throws

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement index.ts**

```typescript
export function getLLMProvider(): LLMProvider
```

Factory reads `LLM_PROVIDER` env var. If `LLM_FALLBACK_PROVIDER` is set, wraps in a fallback proxy that catches errors and retries with the fallback provider.

`llm-usage.ts` — `logLLMUsage(data)` inserts into `llm_usage_log`.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add LLM factory with provider fallback and usage logging"
```

---

## Phase 6: Meal Logging (Core Feature)

### Task 21: Food Cache Queries

**Files:**
- Create: `src/lib/db/queries/food-cache.ts`
- Test: `tests/unit/db/food-cache.test.ts`

- [ ] **Step 1: Write the failing tests**

Test:
- `lookupFood(name)` — normalizes name (lowercase, trim, remove accents), returns cached entry or null
- `cacheFood(data)` — inserts or updates, increments hit_count on duplicate
- `normalizeFoodName(name)` — "Arroz Branco " → "arroz branco"

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement food-cache.ts**

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add food cache queries with normalization"
```

---

### Task 22: Meal Log Flow

**Files:**
- Create: `src/lib/bot/flows/meal-log.ts`
- Create: `src/lib/db/queries/meals.ts`
- Test: `tests/unit/bot/meal-log.test.ts`

Reference: PRD section 5.4 for the full flow.

- [ ] **Step 1: Write the failing tests**

Test `handleMealLog(userId, message, context, userSettings)`:

```typescript
// New meal (no context)
// → calls LLM analyzeMeal, returns breakdown for confirmation
// → sets awaiting_confirmation context

// Awaiting confirmation + "sim"
// → saves to meals + meal_items, clears context
// → returns success message with daily progress

// Awaiting confirmation + "corrigir"
// → transitions to edit flow

// Awaiting clarification (unknown item)
// → re-calls LLM with extra context

// Low confidence item
// → asks user to confirm portion
```

Mock the LLM provider to return predetermined MealAnalysis.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement meal-log.ts and meals.ts**

`meals.ts` queries:
- `createMeal(userId, data)` — inserts into meals + meal_items
- `getDailyCalories(userId, date)` — SUM of today's meals
- `getRecentMeals(userId, limit)` — last N meals with items

`meal-log.ts` flow:
1. Check food cache first for all items
2. Call LLM for uncached items
3. Handle unknown_items → ask clarification
4. Handle low confidence → ask confirmation
5. Format breakdown → send for confirmation
6. On "sim" → save to DB + update food cache
7. Include daily progress in response

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add meal logging flow with LLM analysis and confirmation"
```

---

### Task 23: Wire LLM Classification into Bot Handler

**Files:**
- Modify: `src/lib/bot/handler.ts`
- Test: `tests/e2e/flows/meal-log.test.ts`

- [ ] **Step 1: Write the e2e test**

Simulate meal logging end-to-end:
1. POST "almocei arroz, feijão e frango" from registered user
2. Verify bot sends breakdown with confirmation prompt
3. POST "sim"
4. Verify bot sends success with daily progress
5. Verify meal + meal_items saved in DB

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Update handler.ts**

Add LLM classification as fallback when `classifyByRules` returns null:

```typescript
const intent = classifyByRules(text) ?? await llm.classifyIntent(text)
```

Route `meal_log` intent to `handleMealLog`.

- [ ] **Step 4: Run e2e tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: wire LLM intent classification and meal logging into bot"
```

---

## Phase 7: Secondary Bot Flows

### Task 24: Summary Flow

**Files:**
- Create: `src/lib/bot/flows/summary.ts`
- Test: `tests/unit/bot/summary.test.ts`

Reference: PRD section 5.5.

- [ ] **Step 1: Write failing tests**

Test:
- Daily summary — queries meals for today, formats by meal type
- Weekly summary — queries last 7 days, calculates daily totals + average
- Monthly summary — queries last 30 days
- No meals today → "Nenhum registro hoje"

- [ ] **Step 2-3: Run, implement, run, commit**

```bash
git commit -m "feat: add summary flow (daily, weekly, monthly)"
```

---

### Task 25: Query Flow

**Files:**
- Create: `src/lib/bot/flows/query.ts`
- Test: `tests/unit/bot/query.test.ts`

Reference: PRD section 5.7. Calls LLM but does NOT save to DB. Offers to register.

- [ ] **Step 1: Write failing tests**

- [ ] **Step 2-3: Implement and test**

```bash
git commit -m "feat: add calorie query flow (informational, no save)"
```

---

### Task 26: Edit Flow

**Files:**
- Create: `src/lib/bot/flows/edit.ts`
- Test: `tests/unit/bot/edit.test.ts`

Reference: PRD section 5.6. Three scenarios: correction after registration, delete last, correction without context.

- [ ] **Step 1: Write failing tests**

- [ ] **Step 2-3: Implement and test**

```bash
git commit -m "feat: add edit/correct/delete flow for meals"
```

---

### Task 27: Weight Flow

**Files:**
- Create: `src/lib/bot/flows/weight.ts`
- Create: `src/lib/db/queries/weight.ts`
- Test: `tests/unit/bot/weight.test.ts`

Reference: PRD section 5.8. No LLM. Save to weight_log + update users.weight_kg. Recalculate TMB/TDEE if `calorie_target_manual` is false.

- [ ] **Step 1: Write failing tests**

- [ ] **Step 2-3: Implement and test**

```bash
git commit -m "feat: add weight logging flow with TMB/TDEE recalculation"
```

---

### Task 28: Settings Flow

**Files:**
- Create: `src/lib/bot/flows/settings.ts`
- Test: `tests/unit/bot/settings.test.ts`

Reference: PRD section 5.10. No LLM. Menu-based with numbered options.

- [ ] **Step 1: Write failing tests**

Test all 7 settings options: objective, calorie mode, calorie target (manual override), reminders, detail level, weight update (redirects to weight flow), web link.

- [ ] **Step 2-3: Implement and test**

```bash
git commit -m "feat: add settings flow with numbered menu options"
```

---

### Task 29: Help Flow + User Data

**Files:**
- Create: `src/lib/bot/flows/help.ts`
- Test: `tests/unit/bot/help.test.ts`

Reference: PRD section 5.9.

- [ ] **Step 1: Write failing tests**

Test:
- `handleHelp()` → returns formatted help menu (PRD 5.9)
- `handleUserData(userId)` → returns user's weight, calorie target, mode, etc.

- [ ] **Step 2-3: Implement and test**

```bash
git commit -m "feat: add help menu and user data display"
```

---

### Task 30: Wire All Flows into Handler

**Files:**
- Modify: `src/lib/bot/handler.ts`

- [ ] **Step 1: Route all intents**

Update the handler switch to route every `IntentType` to its corresponding flow:

```typescript
switch (intent) {
  case 'meal_log': return handleMealLog(...)
  case 'summary': return handleSummary(...)
  case 'edit': return handleEdit(...)
  case 'query': return handleQuery(...)
  case 'weight': return handleWeight(...)
  case 'settings': return handleSettings(...)
  case 'help': return handleHelp(...)
  case 'user_data': return handleUserData(...)
  case 'out_of_scope': return formatOutOfScope()
}
```

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

All existing tests should still pass + new flows work.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: wire all bot flows into handler — bot feature-complete"
```

---

## Phase 8: Web App

### Task 31: Auth — OTP Logic

**Files:**
- Create: `src/lib/auth/otp.ts`
- Create: `src/lib/db/queries/auth-codes.ts`
- Test: `tests/unit/auth/otp.test.ts`
- Test: `tests/integration/auth/otp.test.ts`

Reference: Design spec section 2.2.

- [ ] **Step 1: Write failing tests**

Unit tests:
- `generateOTP()` → returns 6-digit string
- `isRateLimited(phone)` → true if 3+ codes in last 15 min

Integration tests:
- `sendOTP(phone)` → creates auth_code in DB, sends WhatsApp message
- `verifyOTP(phone, code)` → returns true if valid, marks as used
- `verifyOTP(phone, wrongCode)` → returns false
- `verifyOTP(phone, expiredCode)` → returns false
- Rate limit: 4th request in 15 min → throws

- [ ] **Step 2-3: Implement and test**

```bash
git commit -m "feat: add OTP auth logic with rate limiting"
```

---

### Task 32: Auth API Routes

**Files:**
- Create: `src/app/api/auth/otp/send/route.ts`
- Create: `src/app/api/auth/otp/verify/route.ts`

- [ ] **Step 1: Implement send/route.ts**

POST `{ phone }` → validate phone → check rate limit → generate OTP → save to DB → send via WhatsApp → return 200.

- [ ] **Step 2: Implement verify/route.ts**

POST `{ phone, code }` → verify OTP → find/create Supabase Auth user → create session → return session token.

- [ ] **Step 3: Test manually or write integration test**

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add OTP send and verify API routes"
```

---

### Task 33: shadcn/ui Setup + Landing Page

**Files:**
- Create: `src/app/page.tsx` (overwrite default)
- Create: `src/app/layout.tsx` (update with fonts/theme)
- Create: `src/app/globals.css` (update with custom palette)

- [ ] **Step 1: Initialize shadcn/ui**

```bash
npx shadcn@latest init
```

Select: New York style, CSS variables, custom colors.

- [ ] **Step 2: Add required components**

```bash
npx shadcn@latest add button input card label
```

- [ ] **Step 3: Configure custom color palette**

In `globals.css`, set CSS variables for the colorful theme:
- Primary green (health/food), orange (warning), red (exceeded)
- Warm, friendly palette with rounded components

- [ ] **Step 4: Build landing page**

`page.tsx`:
- CalorieBot logo/title
- Phone input with BR mask
- "Enviar codigo pelo WhatsApp" button
- OTP code input (6 digits)
- "Entrar" button
- Calls `/api/auth/otp/send` and `/api/auth/otp/verify`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add landing page with WhatsApp OTP login"
```

---

### Task 34: Auth Middleware + Layout

**Files:**
- Create: `src/middleware.ts`
- Create: `src/app/(auth)/layout.tsx`

- [ ] **Step 1: Create Next.js middleware**

Check Supabase session on `/(auth)/*` routes. If no session → redirect to `/`.

- [ ] **Step 2: Create authenticated layout**

Simple sidebar/nav with links: Dashboard, Settings, History. User name + logout button.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add auth middleware and authenticated layout"
```

---

### Task 35: Dashboard Page

**Files:**
- Create: `src/app/(auth)/dashboard/page.tsx`
- Create: `src/components/dashboard/CalorieProgress.tsx`
- Create: `src/components/dashboard/MealBreakdown.tsx`
- Create: `src/components/dashboard/WeeklyChart.tsx`
- Create: `src/components/dashboard/RecentMeals.tsx`

Reference: Design spec section 4.2.

- [ ] **Step 1: Add shadcn components**

```bash
npx shadcn@latest add progress tabs
```

- [ ] **Step 2: Build CalorieProgress component**

Large circular or bar progress showing consumed vs target. Color changes: green (< 80%), orange (80-100%), red (> 100%).

- [ ] **Step 3: Build MealBreakdown component**

4 cards (cafe, almoco, lanche, jantar) with icons and calories per meal type.

- [ ] **Step 4: Build WeeklyChart component**

recharts `LineChart` with 7/30 day toggle. Shows daily calories vs target line.

- [ ] **Step 5: Build RecentMeals component**

List of last 5 meals with expandable items.

- [ ] **Step 6: Compose dashboard page**

Server component that fetches data from Supabase, passes to client components.

- [ ] **Step 7: Add Supabase Realtime subscription**

Subscribe to `meals` table INSERT for live updates when bot registers a meal.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add dashboard with calorie progress, charts, and realtime"
```

---

### Task 36: Settings Page

**Files:**
- Create: `src/app/(auth)/settings/page.tsx`
- Create: `src/components/settings/ProfileForm.tsx`
- Create: `src/components/settings/BotSettings.tsx`

Reference: Design spec section 4.3.

- [ ] **Step 1: Add shadcn components**

```bash
npx shadcn@latest add select switch form toast
```

- [ ] **Step 2: Build ProfileForm**

Form with: name, age, sex, weight, height, activity level, goal. On save: update user + recalculate TMB/TDEE (unless calorie_target_manual).

- [ ] **Step 3: Build BotSettings**

Toggles: reminders on/off. Time pickers: summary time, reminder time. Selectors: calorie mode, detail level, weight unit.

- [ ] **Step 4: Compose settings page + save logic**

Server action or API call to update user + settings. Show toast on success.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add settings page with profile and bot configuration"
```

---

### Task 37: History Page

**Files:**
- Create: `src/app/(auth)/history/page.tsx`
- Create: `src/components/history/MealList.tsx`
- Create: `src/components/history/MealDetail.tsx`

Reference: Design spec section 4.4.

- [ ] **Step 1: Add shadcn components**

```bash
npx shadcn@latest add table dialog calendar popover
```

- [ ] **Step 2: Build MealList**

Table/list with columns: date, time, type, total calories. Date picker filter. Pagination.

- [ ] **Step 3: Build MealDetail**

Expandable row or dialog showing individual items with macros. Edit/delete buttons with confirmation dialog.

- [ ] **Step 4: Compose history page**

Server component fetching meals with pagination + filter.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add history page with meal list, detail, and edit/delete"
```

---

## Phase 9: Cron Jobs

### Task 38: Reminders Cron

**Files:**
- Create: `src/app/api/cron/reminders/route.ts`
- Create: `src/lib/whatsapp/templates.ts`
- Create: `vercel.json` (cron config)

Reference: Design spec sections 3.5 and 3.8.

- [ ] **Step 1: Create vercel.json with cron schedule**

```json
{
  "crons": [
    {
      "path": "/api/cron/reminders",
      "schedule": "*/15 * * * *"
    }
  ]
}
```

- [ ] **Step 2: Implement templates.ts**

Message templates for: daily_reminder, daily_summary, weekly_summary. For MVP, use regular text messages (templates need Meta approval — can migrate later).

- [ ] **Step 3: Implement reminders route**

POST handler (Vercel Cron calls POST):
1. Validate `CRON_SECRET` header
2. Process daily reminders: find users where `NOW() AT TIME ZONE timezone` is within 15min of `reminder_time`, no meal logged since last midnight, `last_reminder_sent_at` < today
3. Process daily summaries: same logic for `daily_summary_time`
4. Process weekly summaries: if Sunday + within 15min of summary time
5. Auto-confirm pending meals: find `awaiting_confirmation` contexts older than 2 min (design spec section 3.8)
6. Cleanup: DELETE from `processed_messages` WHERE `processed_at` < NOW() - INTERVAL '24 hours'

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add cron job for reminders, auto-confirm, and cleanup"
```

---

### Task 39: TACO Table Seed Script

**Files:**
- Create: `scripts/seed-taco.ts`
- Modify: `supabase/seed.sql`

- [ ] **Step 1: Obtain TACO data**

The Brazilian TACO table is publicly available. Create a TypeScript script that reads the TACO data (JSON or CSV format) and inserts into `taco_foods` table.

Source: UNICAMP TACO table (public domain nutritional data for ~600 Brazilian foods).

- [ ] **Step 2: Implement seed script**

```typescript
// scripts/seed-taco.ts
// Reads TACO data and inserts into Supabase taco_foods table
// Uses service role client
// Handles duplicates with ON CONFLICT
```

- [ ] **Step 3: Run seed**

```bash
npx tsx scripts/seed-taco.ts
```

Verify: `taco_foods` table has ~600 entries.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add TACO table seed script (~600 Brazilian foods)"
```

---

## Phase 10: Final Integration + Deploy

### Task 40: Full Integration Test

**Files:**
- Update: `tests/e2e/flows/meal-log.test.ts`
- Create: `tests/integration/db/rls.test.ts`

- [ ] **Step 1: RLS integration tests**

Test that user A cannot read user B's meals, settings, weight_log. Test that taco_foods is readable by all. Test that service role can write to food_cache.

- [ ] **Step 2: Full flow e2e test**

End-to-end test: onboarding → meal log → summary → edit → weight → settings. Verify all state transitions and data persistence.

- [ ] **Step 3: Run full suite**

```bash
npm test
npm run test:e2e
npx tsc --noEmit
```

All must pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: add RLS integration tests and full flow e2e test"
```

---

### Task 41: Deploy Configuration

**Files:**
- Verify: `vercel.json`
- Create: `.env.example` (final version with all vars)

- [ ] **Step 1: Verify all env vars documented**

Cross-check `.env.example` has every variable used in the codebase.

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Must complete without errors.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "chore: finalize deploy configuration"
```

- [ ] **Step 4: Deploy to Vercel**

```bash
vercel --prod
```

Set all environment variables in Vercel dashboard.

- [ ] **Step 5: Configure WhatsApp webhook URL**

Update webhook URL in Meta App Dashboard to point to the Vercel deployment URL:
`https://caloriebot.vercel.app/api/webhook/whatsapp`

---

## Summary

| Phase | Tasks | Description |
|-------|-------|-------------|
| 1 | 1-4 | Project setup, database schema, Supabase clients |
| 2 | 5-7 | TDEE calculator, validators, formatters |
| 3 | 8-10 | WhatsApp webhook parser, client, API route |
| 4 | 11-15 | State machine, intent classifier, onboarding, bot handler |
| 5 | 16-20 | Zod schemas, prompts, OpenRouter, Ollama, factory |
| 6 | 21-23 | Food cache, meal log flow, LLM wiring |
| 7 | 24-30 | Summary, query, edit, weight, settings, help flows |
| 8 | 31-37 | OTP auth, landing page, dashboard, settings, history |
| 9 | 38-39 | Cron jobs, TACO seed |
| 10 | 40-41 | Integration tests, deploy |

**Total: 41 tasks across 10 phases.**

Each phase builds on the previous and produces working, testable software. After Phase 4, the bot handles onboarding. After Phase 6, the core meal logging works. After Phase 7, the bot is feature-complete. After Phase 8, the web app is done. Phase 9-10 add polish and deploy.
