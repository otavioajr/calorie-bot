# Reset Data Design Spec — CalorieBot

**Date:** 2026-03-23
**Status:** Approved

## Overview

Add a "reset all data" feature accessible from both the WhatsApp bot (settings menu) and the web settings page. When triggered, all user-associated data is deleted and profile fields are reset, forcing the user back through onboarding. The user record itself is preserved (soft reset).

## Scope

### In Scope
- Soft reset: delete all associated data, reset profile fields, restart onboarding
- Bot: new option 8 in settings menu with simple confirmation ("SIM")
- Web: new "Danger Zone" section on settings page with confirmation modal
- New API route `POST /api/user/reset-data`
- New DB query function `resetUserData`

### Out of Scope
- Hard delete (removing the user record entirely)
- Supabase Auth account deletion
- Exporting data before reset
- Admin-initiated resets

## Data Affected

### Tables — rows deleted

| Table | Deletion method | Notes |
|-------|----------------|-------|
| `meals` | DELETE WHERE user_id = ? | `meal_items` cascade-deleted via FK |
| `meal_items` | CASCADE from meals | No direct query needed |
| `weight_log` | DELETE WHERE user_id = ? | |
| `user_settings` | DELETE WHERE user_id = ? | Recreated during onboarding step 8 |
| `conversation_context` | DELETE WHERE user_id = ? | |
| `llm_usage_log` | DELETE WHERE user_id = ? | Optional user_id FK, no cascade |

### `users` table — fields reset

| Field | Reset value | Notes |
|-------|------------|-------|
| `name` | `''` | NOT NULL constraint requires empty string |
| `sex` | `null` | |
| `age` | `null` | |
| `weight_kg` | `null` | |
| `height_cm` | `null` | |
| `activity_level` | `null` | |
| `goal` | `null` | |
| `calorie_mode` | `'approximate'` | Default value |
| `daily_calorie_target` | `null` | |
| `calorie_target_manual` | `false` | |
| `tmb` | `null` | |
| `tdee` | `null` | |
| `onboarding_complete` | `false` | Triggers onboarding on next message |
| `onboarding_step` | `0` | |

### Preserved

- `users.id`, `users.phone`, `users.auth_id`, `users.timezone`, `users.created_at`
- `taco_foods`, `food_cache` (shared/system tables)
- `auth_codes` (indexed by phone, ephemeral)
- `processed_messages` (no user FK)

## Bot Flow

### Settings Menu Update

Add option 8 to the existing settings menu in `formatSettingsMenu`:

```
⚙️ Configurações:

1️⃣ Objetivo (atual: Perder peso)
2️⃣ Modo de cálculo (atual: Aproximado)
3️⃣ Meta calórica (atual: 2000 kcal)
4️⃣ Lembretes (atual: ✅ ligados)
5️⃣ Nível de detalhe (atual: brief)
6️⃣ Atualizar peso
7️⃣ Abrir painel completo na web
8️⃣ Limpar dados e recomeçar

Qual quer alterar?
```

### Confirmation Flow

1. User selects option 8
2. Bot sets context type `awaiting_reset_confirmation` (TTL: 5 min)
3. Bot responds: `⚠️ Isso vai apagar todas as suas refeições, peso e configurações. Você vai passar pelo cadastro de novo.\n\nTem certeza? Responda SIM para confirmar.`
4. User responds:
   - **"sim" / "SIM"**: Execute reset, respond `Dados apagados! Vamos recomeçar 🔄`, then trigger onboarding (step 0 welcome message)
   - **Anything else**: Cancel, clear state, respond `Cancelado. Seus dados continuam intactos! ✅`

### Context Type Addition

Add `awaiting_reset_confirmation` to `ContextType` union and `CONTEXT_TTLS` map with TTL of 5 minutes.

### Handler Integration

In `settings.ts`, the `handleSettings` function already handles `settings_menu` context. Add case 8 to `handleMenuSelection`. Add a new branch in `handleSettings` for `awaiting_reset_confirmation` context type.

## Web Flow

### Settings Page Update

Add a new section below the existing Tabs in `src/app/(auth)/settings/page.tsx`:

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

### ResetDataButton Component

New client component `src/components/settings/ResetDataButton.tsx`:
- Red button: "Limpar todos os dados e recomeçar"
- On click: opens confirmation dialog (shadcn AlertDialog)
- Dialog text: "Isso vai apagar todas as suas refeições, registros de peso e configurações. Você vai precisar refazer o cadastro. Essa ação não pode ser desfeita."
- Confirm button: calls `POST /api/user/reset-data`
- On success: redirect to `/` (landing/login page) — cookie is cleared server-side

## API Route

### `POST /api/user/reset-data`

**Location:** `src/app/api/user/reset-data/route.ts`

**Auth:** Reads `caloriebot-user-id` cookie. Returns 401 if missing.

**Logic:**
1. Get userId from cookie
2. Call `resetUserData(supabase, userId)` using service role client
3. Clear `caloriebot-user-id` cookie
4. Return `200 { success: true }`

**Error handling:** Returns `500 { error: 'Failed to reset data' }` on failure. Logs error server-side.

## Database Query

### `resetUserData` function

**Location:** `src/lib/db/queries/users.ts`

**Signature:**
```typescript
export async function resetUserData(
  supabase: SupabaseClient,
  userId: string
): Promise<void>
```

**Implementation:** Sequential deletes followed by user update. Order matters to respect FK constraints:
1. DELETE from `meal_items` via cascade (handled by deleting meals)
2. DELETE from `meals` WHERE user_id = userId
3. DELETE from `weight_log` WHERE user_id = userId
4. DELETE from `user_settings` WHERE user_id = userId
5. DELETE from `conversation_context` WHERE user_id = userId
6. DELETE from `llm_usage_log` WHERE user_id = userId
7. UPDATE `users` SET all profile fields to reset values WHERE id = userId

Uses service role client (not RLS) since this is a privileged operation initiated from an authenticated API route.

## Testing

### Unit Tests
- `resetUserData` correctly deletes all associated tables and resets user fields
- Bot settings menu shows option 8
- Confirmation flow: "sim" triggers reset, anything else cancels
- API route returns 401 without cookie, 200 on success

### Integration Tests
- Full reset cycle: create user → add meals/weight/settings → reset → verify all deleted and user in onboarding state
- Bot flow: settings → option 8 → confirm → verify onboarding restarts

## CLAUDE.md Updates

- Add `awaiting_reset_confirmation` to conversation_context types list
- Add option `8️⃣ Limpar dados e recomeçar` to settings flow description
- Add `ResetDataButton` to components structure
- Add `POST /api/user/reset-data` to API routes
