# Reset Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "reset all data" feature accessible from both the WhatsApp bot settings menu and the web settings page, performing a soft reset that clears all user data and restarts onboarding.

**Architecture:** A PostgreSQL function (`reset_user_data`) handles atomic multi-table deletion + user field reset via a Supabase migration. The bot adds option 8 to the settings menu with a confirmation context type. The web adds a danger zone card with an AlertDialog. Both call a shared API route (`POST /api/user/reset-data`).

**Tech Stack:** Next.js App Router, TypeScript, Supabase (PostgreSQL RPC), shadcn/ui AlertDialog, Vitest

**Spec:** `docs/superpowers/specs/2026-03-23-reset-data-design.md`

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `supabase/migrations/00006_reset_user_data.sql` | PostgreSQL function for atomic reset |
| Create | `src/app/api/user/reset-data/route.ts` | API route — auth + call RPC + clear cookie |
| Create | `src/components/settings/ResetDataButton.tsx` | Client component — button + AlertDialog |
| Modify | `src/lib/db/queries/users.ts` | Add `resetUserData()` wrapper |
| Modify | `src/lib/db/queries/context.ts:2-22` | Add `awaiting_reset_confirmation` to types/TTLs |
| Modify | `src/lib/bot/handler.ts:62-89` | Route `awaiting_reset_confirmation` to settings |
| Modify | `src/lib/bot/flows/settings.ts:40-148` | Handle option 8 + reset confirmation branch |
| Modify | `src/lib/utils/formatters.ts:176-198` | Add option 8 to `formatSettingsMenu` |
| Modify | `src/app/(auth)/settings/page.tsx` | Add danger zone card |
| Modify | `tests/unit/bot/settings.test.ts` | Tests for option 8 + confirmation flow |
| Modify | `tests/unit/bot/handler.test.ts` | Test routing for `awaiting_reset_confirmation` |

---

### Task 1: Database migration — `reset_user_data` PostgreSQL function

**Files:**
- Create: `supabase/migrations/00006_reset_user_data.sql`

- [ ] **Step 1: Create migration file**

```sql
-- supabase/migrations/00006_reset_user_data.sql
CREATE OR REPLACE FUNCTION reset_user_data(p_user_id UUID) RETURNS void AS $$
BEGIN
  DELETE FROM meals WHERE user_id = p_user_id;
  DELETE FROM weight_log WHERE user_id = p_user_id;
  DELETE FROM user_settings WHERE user_id = p_user_id;
  DELETE FROM conversation_context WHERE user_id = p_user_id;
  DELETE FROM llm_usage_log WHERE user_id = p_user_id;
  UPDATE users SET
    name = '',
    sex = NULL,
    age = NULL,
    weight_kg = NULL,
    height_cm = NULL,
    activity_level = NULL,
    goal = NULL,
    calorie_mode = 'approximate',
    daily_calorie_target = NULL,
    calorie_target_manual = false,
    tmb = NULL,
    tdee = NULL,
    onboarding_complete = false,
    onboarding_step = 0,
    updated_at = NOW()
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/00006_reset_user_data.sql
git commit -m "feat: add reset_user_data PostgreSQL function"
```

---

### Task 2: Add `resetUserData` to queries + `awaiting_reset_confirmation` context type

**Files:**
- Modify: `src/lib/db/queries/users.ts`
- Modify: `src/lib/db/queries/context.ts`

- [ ] **Step 1: Write test for `resetUserData`**

Add to `tests/unit/bot/settings.test.ts` (or create a new test — see Task 4 for the full test additions). For now, we'll test `resetUserData` inline:

The function is a thin wrapper around `supabase.rpc()`, so it will be tested through integration with the settings flow tests in Task 4.

- [ ] **Step 2: Add `resetUserData` to `src/lib/db/queries/users.ts`**

Add at the end of the file:

```typescript
/**
 * Reset all user data and restart onboarding.
 * Calls the `reset_user_data` PostgreSQL function for atomic execution.
 * Deletes: meals, meal_items (cascade), weight_log, user_settings,
 * conversation_context, llm_usage_log.
 * Resets user profile fields and sets onboarding_complete = false.
 */
export async function resetUserData(
  supabase: SupabaseClient,
  userId: string
): Promise<void> {
  const { error } = await supabase.rpc('reset_user_data', { p_user_id: userId })
  if (error) throw new Error(`Failed to reset user data: ${error.message}`)
}
```

- [ ] **Step 3: Add `awaiting_reset_confirmation` to context types**

In `src/lib/db/queries/context.ts`:

Add `awaiting_reset_confirmation: 5,` to `CONTEXT_TTLS` (after `settings_change: 5,`).

Add `| 'awaiting_reset_confirmation'` to the `ContextType` union type.

- [ ] **Step 4: Commit**

```bash
git add src/lib/db/queries/users.ts src/lib/db/queries/context.ts
git commit -m "feat: add resetUserData query and awaiting_reset_confirmation context type"
```

---

### Task 3: Bot settings flow — option 8 + confirmation

**Files:**
- Modify: `src/lib/utils/formatters.ts:176-198`
- Modify: `src/lib/bot/flows/settings.ts:40-148`
- Modify: `src/lib/bot/handler.ts:62-89`

- [ ] **Step 1: Write failing tests for option 8 and confirmation flow**

Add these tests to `tests/unit/bot/settings.test.ts`. First, add `mockResetUserData` to the hoisted mocks:

```typescript
// Add to vi.hoisted() return object (line ~16):
mockResetUserData: vi.fn().mockResolvedValue(undefined),
```

Update the existing `vi.mock('@/lib/db/queries/users', ...)` block (line ~24) to include `resetUserData`:

```typescript
vi.mock('@/lib/db/queries/users', () => ({
  updateUser: mockUpdateUser,
  resetUserData: mockResetUserData,
}))
```

Add a helper to build the reset confirmation context:

```typescript
function buildResetConfirmationContext(): ConversationContext {
  return {
    id: 'ctx-reset',
    userId: USER_ID,
    contextType: 'awaiting_reset_confirmation',
    contextData: {},
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  }
}
```

Add these test cases inside the `describe('handleSettings', ...)` block:

```typescript
describe('option 8 — reset data', () => {
  it('shows confirmation prompt when option 8 is selected', async () => {
    const context = buildSettingsMenuContext()
    const result = await handleSettings(supabase, USER_ID, '8', mockUser, mockSettings, context)

    expect(result).toMatch(/apagar/)
    expect(result).toMatch(/SIM/)
    expect(mockSetState).toHaveBeenCalledWith(USER_ID, 'awaiting_reset_confirmation', {})
  })

  it('executes reset when user confirms with "sim"', async () => {
    const context = buildResetConfirmationContext()
    const result = await handleSettings(supabase, USER_ID, 'sim', mockUser, mockSettings, context)

    expect(mockResetUserData).toHaveBeenCalledWith(supabase, USER_ID)
    expect(result).toMatch(/apagados/i)
    expect(result).toMatch(/recomeçar/i)
  })

  it('executes reset when user confirms with "SIM"', async () => {
    const context = buildResetConfirmationContext()
    const result = await handleSettings(supabase, USER_ID, 'SIM', mockUser, mockSettings, context)

    expect(mockResetUserData).toHaveBeenCalledWith(supabase, USER_ID)
  })

  it('cancels reset when user sends anything other than "sim"', async () => {
    const context = buildResetConfirmationContext()
    const result = await handleSettings(supabase, USER_ID, 'não', mockUser, mockSettings, context)

    expect(mockResetUserData).not.toHaveBeenCalled()
    expect(mockClearState).toHaveBeenCalledWith(USER_ID)
    expect(result).toMatch(/cancelado|intactos/i)
  })
})
```

Also update the existing invalid option test to expect "1 a 8":

```typescript
it('handles invalid option gracefully', async () => {
  const context = buildSettingsMenuContext()
  const result = await handleSettings(supabase, USER_ID, '99', mockUser, mockSettings, context)

  expect(result).toMatch(/opção|inválid|1.*8/i)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/bot/settings.test.ts`
Expected: FAIL — option 8 not handled, `awaiting_reset_confirmation` not recognized

- [ ] **Step 3: Update `formatSettingsMenu` in `src/lib/utils/formatters.ts`**

Add option 8 line to the array in `formatSettingsMenu` (after the `7️⃣` line, before the empty string `''`):

```typescript
`8️⃣ Limpar dados e recomeçar`,
```

- [ ] **Step 4: Implement option 8 and confirmation in `src/lib/bot/flows/settings.ts`**

**4a.** Add import for `resetUserData`:

```typescript
import { updateUser, resetUserData } from '@/lib/db/queries/users'
```

**4b.** In `handleSettings`, add a new branch for `awaiting_reset_confirmation` BEFORE the `settings_change` check (before line 53):

```typescript
if (context?.contextType === 'awaiting_reset_confirmation') {
  return handleResetConfirmation(supabase, userId, trimmed)
}
```

**4c.** In `handleMenuSelection`, update validation from `> 7` to `> 8` and error messages from `"1 a 7"` to `"1 a 8"` (lines 112 and 146).

**4d.** Add case 8 in the switch statement (before `default:`):

```typescript
case 8:
  await setState(userId, 'awaiting_reset_confirmation', {})
  return '⚠️ Isso vai apagar todas as suas refeições, peso e configurações. Você vai passar pelo cadastro de novo.\n\nTem certeza? Responda SIM para confirmar.'
```

**4e.** Add the `handleResetConfirmation` function:

```typescript
async function handleResetConfirmation(
  supabase: SupabaseClient,
  userId: string,
  message: string,
): Promise<string> {
  if (message.toLowerCase() === 'sim') {
    await resetUserData(supabase, userId)
    return 'Dados apagados! Vamos recomeçar 🔄 Me manda qualquer mensagem pra iniciar o cadastro.'
  }

  await clearState(userId)
  return 'Cancelado. Seus dados continuam intactos! ✅'
}
```

Note: The reset function clears `conversation_context` via the PostgreSQL function. After reset, `onboarding_complete = false` and `onboarding_step = 0`, so the next message the user sends will trigger `handleOnboarding` at step 0 which sends the welcome message and asks for their name. Do NOT include the welcome message inline here — it would duplicate when `handleOnboarding` runs.

- [ ] **Step 5: Route `awaiting_reset_confirmation` in handler.ts**

In `src/lib/bot/handler.ts`, add a new case in the context switch block (~line 62), alongside `settings_menu` and `settings_change`:

```typescript
case 'settings_menu':
case 'settings_change':
case 'awaiting_reset_confirmation': {
```

This groups it with the existing settings routing.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/unit/bot/settings.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/bot/flows/settings.ts src/lib/bot/handler.ts src/lib/utils/formatters.ts tests/unit/bot/settings.test.ts
git commit -m "feat: add reset data option to bot settings menu with confirmation flow"
```

---

### Task 4: Handler test — route `awaiting_reset_confirmation`

**Files:**
- Modify: `tests/unit/bot/handler.test.ts`

- [ ] **Step 1: Add test for `awaiting_reset_confirmation` routing**

Add this test **inside** the existing `describe('handleIncomingMessage — context-based routing', ...)` block in `tests/unit/bot/handler.test.ts` (around line 575). This block already has a `beforeEach` that sets `mockFindUserByPhone.mockResolvedValue(completedUser)` and the global `beforeEach` sets up `mockGetUserWithSettings`. Use the `FROM` and `MESSAGE_ID` constants already defined in the file.

```typescript
it('routes to handleSettings when context is awaiting_reset_confirmation', async () => {
  const mockContext = {
    contextType: 'awaiting_reset_confirmation',
    contextData: {},
  }
  mockGetState.mockResolvedValue(mockContext)
  mockHandleSettings.mockResolvedValue('reset response')

  await handleIncomingMessage(FROM, MESSAGE_ID, 'sim')

  expect(mockHandleSettings).toHaveBeenCalled()
  expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'reset response')
})
```

- [ ] **Step 2: Run test**

Run: `npx vitest run tests/unit/bot/handler.test.ts`
Expected: ALL PASS (handler already updated in Task 3)

- [ ] **Step 3: Commit**

```bash
git add tests/unit/bot/handler.test.ts
git commit -m "test: add handler routing test for awaiting_reset_confirmation"
```

---

### Task 5: API route — `POST /api/user/reset-data`

**Files:**
- Create: `src/app/api/user/reset-data/route.ts`

- [ ] **Step 1: Create the API route**

Follow the pattern from `src/app/api/user/profile/route.ts`:

```typescript
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServiceRoleClient } from '@/lib/db/supabase'
import { resetUserData } from '@/lib/db/queries/users'

export async function POST(): Promise<NextResponse> {
  const cookieStore = await cookies()
  const userId = cookieStore.get('caloriebot-user-id')?.value

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = createServiceRoleClient()
    await resetUserData(supabase, userId)

    cookieStore.delete('caloriebot-user-id')

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[reset-data] error:', err)
    return NextResponse.json({ error: 'Failed to reset data' }, { status: 500 })
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/user/reset-data/route.ts
git commit -m "feat: add POST /api/user/reset-data API route"
```

---

### Task 6: Web UI — ResetDataButton + AlertDialog + settings page

**Files:**
- Create: `src/components/settings/ResetDataButton.tsx`
- Modify: `src/app/(auth)/settings/page.tsx`

- [ ] **Step 1: Install AlertDialog component if not present**

The `src/components/ui/` directory has `dialog.tsx` but no `alert-dialog.tsx`. Install it:

```bash
npx shadcn@latest add alert-dialog
```

- [ ] **Step 2: Create `ResetDataButton` component**

```typescript
"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"

export function ResetDataButton() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleReset() {
    setLoading(true)
    setError(null)

    try {
      const res = await fetch("/api/user/reset-data", { method: "POST" })
      if (!res.ok) {
        setError("Erro ao limpar dados. Tente novamente.")
        return
      }
      router.push("/")
    } catch {
      setError("Erro de conexão. Tente novamente.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Isso vai apagar todas as suas refeições, registros de peso e configurações.
        Você vai precisar refazer o cadastro. Essa ação não pode ser desfeita.
      </p>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="destructive" className="w-full">
            Limpar todos os dados e recomeçar
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Tem certeza?</AlertDialogTitle>
            <AlertDialogDescription>
              Todas as suas refeições, registros de peso e configurações serão
              apagados permanentemente. Você precisará refazer o cadastro.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleReset}
              disabled={loading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {loading ? "Apagando..." : "Confirmar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
```

- [ ] **Step 3: Update settings page**

In `src/app/(auth)/settings/page.tsx`, add the import at the top:

```typescript
import { ResetDataButton } from "@/components/settings/ResetDataButton"
```

Add the danger zone card after the closing `</Tabs>` tag (before the closing `</div>`):

```tsx
<Card className="border-destructive">
  <CardHeader>
    <CardTitle className="text-destructive">Zona de Perigo</CardTitle>
    <CardDescription>
      Ações irreversíveis na sua conta
    </CardDescription>
  </CardHeader>
  <CardContent>
    <ResetDataButton />
  </CardContent>
</Card>
```

- [ ] **Step 4: Commit**

```bash
git add src/components/ui/alert-dialog.tsx src/components/settings/ResetDataButton.tsx src/app/\(auth\)/settings/page.tsx
git commit -m "feat: add danger zone with reset data button to web settings page"
```

---

### Task 7: Run full test suite + CLAUDE.md updates

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run
```

Expected: ALL PASS

- [ ] **Step 2: Run TypeScript type check**

```bash
npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 3: Update CLAUDE.md**

Add `awaiting_reset_confirmation` to the conversation_context types list in the Estado da conversa section.

Update the `settings` flow description: the settings menu now has 8 options (currently says `Configurações via menu numerado`).

Add `POST /api/user/reset-data` under `api/user/` in the project structure section (add `│   │   │   │   └── reset-data/route.ts # Limpa dados do usuário e reinicia onboarding`).

Add `ResetDataButton` component path under `components/settings/`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with reset data feature references"
```
