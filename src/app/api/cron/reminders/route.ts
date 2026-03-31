import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/db/supabase'
import { sendTextMessage } from '@/lib/whatsapp/client'
import { createMeal } from '@/lib/db/queries/meals'
import { getDailyCalories } from '@/lib/db/queries/meals'
import {
  buildDailyReminderMessage,
  buildDailySummaryMessage,
  buildWeeklySummaryMessage,
} from '@/lib/whatsapp/templates'
import type { MealAnalysis } from '@/lib/llm/schemas/meal-analysis'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UserRow {
  id: string
  phone: string
  timezone: string
  daily_calorie_target: number | null
}

interface UserSettingsRow {
  user_id: string
  reminders_enabled: boolean
  reminder_time: string
  daily_summary_time: string
  last_reminder_sent_at: string | null
  last_summary_sent_at: string | null
  last_weekly_summary_sent_at: string | null
}

interface UserWithSettings {
  user: UserRow
  settings: UserSettingsRow
}

interface ContextRow {
  id: string
  user_id: string
  context_data: Record<string, unknown>
  created_at: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a HH:MM time string to total minutes since midnight.
 */
function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number)
  return (hours ?? 0) * 60 + (minutes ?? 0)
}

/**
 * Get the current time in minutes since midnight for a given IANA timezone.
 */
function nowInTimezoneMinutes(timezone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    const parts = formatter.formatToParts(new Date())
    const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10)
    const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10)
    return hour * 60 + minute
  } catch {
    // Fallback to UTC if timezone is invalid
    const now = new Date()
    return now.getUTCHours() * 60 + now.getUTCMinutes()
  }
}

/**
 * Get the current date string (YYYY-MM-DD) in a given IANA timezone.
 */
function nowDateInTimezone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())
  } catch {
    return new Date().toISOString().split('T')[0]!
  }
}

/**
 * Check whether a time (in minutes) falls within a 15-minute window ending at targetMinutes.
 */
function isInWindow(nowMinutes: number, targetMinutes: number): boolean {
  const diff = nowMinutes - targetMinutes
  // Allow window: [target - 14, target] to avoid double-firing
  return diff >= -14 && diff <= 0
}

/**
 * Return true when the given date string is today or in the future relative to todayStr.
 */
function alreadySentToday(lastSentAt: string | null, todayStr: string): boolean {
  if (!lastSentAt) return false
  const lastDate = lastSentAt.split('T')[0] ?? lastSentAt.slice(0, 10)
  return lastDate >= todayStr
}

// ---------------------------------------------------------------------------
// Step 2: Daily reminders (lunch)
// ---------------------------------------------------------------------------

async function processDailyReminders(
  users: UserWithSettings[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
): Promise<number> {
  let sent = 0

  for (const { user, settings } of users) {
    if (!settings.reminders_enabled) continue

    const nowMinutes = nowInTimezoneMinutes(user.timezone)
    const reminderMinutes = timeToMinutes(settings.reminder_time)
    const todayStr = nowDateInTimezone(user.timezone)

    if (!isInWindow(nowMinutes, reminderMinutes)) continue
    if (alreadySentToday(settings.last_reminder_sent_at, todayStr)) continue

    // Check if user already registered lunch today
    const startOfDay = new Date(`${todayStr}T00:00:00.000Z`)
    const endOfDay = new Date(`${todayStr}T23:59:59.999Z`)

    const { data: lunchMeals } = await supabase
      .from('meals')
      .select('id')
      .eq('user_id', user.id)
      .eq('meal_type', 'almoco')
      .gte('registered_at', startOfDay.toISOString())
      .lte('registered_at', endOfDay.toISOString())
      .limit(1)

    if (lunchMeals && lunchMeals.length > 0) continue

    try {
      await sendTextMessage(user.phone, buildDailyReminderMessage())

      await supabase
        .from('user_settings')
        .update({ last_reminder_sent_at: new Date().toISOString() })
        .eq('user_id', user.id)

      sent++
    } catch (err) {
      console.error(`[cron] Failed to send reminder to user ${user.id}:`, err)
    }
  }

  return sent
}

// ---------------------------------------------------------------------------
// Step 3: Daily summaries
// ---------------------------------------------------------------------------

async function processDailySummaries(
  users: UserWithSettings[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
): Promise<number> {
  let sent = 0

  for (const { user, settings } of users) {
    if (!settings.reminders_enabled) continue

    const nowMinutes = nowInTimezoneMinutes(user.timezone)
    const summaryMinutes = timeToMinutes(settings.daily_summary_time)
    const todayStr = nowDateInTimezone(user.timezone)

    if (!isInWindow(nowMinutes, summaryMinutes)) continue
    if (alreadySentToday(settings.last_summary_sent_at, todayStr)) continue

    try {
      const consumed = await getDailyCalories(supabase, user.id, undefined, user.timezone)
      const target = user.daily_calorie_target ?? 2000

      await sendTextMessage(user.phone, buildDailySummaryMessage(consumed, target))

      await supabase
        .from('user_settings')
        .update({ last_summary_sent_at: new Date().toISOString() })
        .eq('user_id', user.id)

      sent++
    } catch (err) {
      console.error(`[cron] Failed to send daily summary to user ${user.id}:`, err)
    }
  }

  return sent
}

// ---------------------------------------------------------------------------
// Step 4: Weekly summaries (Sunday only)
// ---------------------------------------------------------------------------

async function processWeeklySummaries(
  users: UserWithSettings[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
): Promise<number> {
  let sent = 0

  // Check globally if it's Sunday (use UTC for simplicity — good enough for weekly)
  const nowUTC = new Date()
  if (nowUTC.getUTCDay() !== 0) return 0

  for (const { user, settings } of users) {
    if (!settings.reminders_enabled) continue

    const todayStr = nowDateInTimezone(user.timezone)

    // Use last_weekly_summary_sent_at if the column exists, else fall back to last_summary_sent_at
    const lastSent =
      settings.last_weekly_summary_sent_at ?? settings.last_summary_sent_at ?? null

    if (alreadySentToday(lastSent, todayStr)) continue

    try {
      // Fetch last 7 days of calorie data
      const sevenDaysAgo = new Date(nowUTC)
      sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7)

      const { data: weekMeals } = await supabase
        .from('meals')
        .select('total_calories, registered_at')
        .eq('user_id', user.id)
        .gte('registered_at', sevenDaysAgo.toISOString())
        .lte('registered_at', nowUTC.toISOString())

      const totalCaloriesWeek: number = (
        (weekMeals as Array<{ total_calories: number }>) ?? []
      ).reduce((sum: number, row) => sum + (row.total_calories ?? 0), 0)

      const avgCalories = weekMeals && weekMeals.length > 0
        ? Math.round(totalCaloriesWeek / 7)
        : 0

      const target = user.daily_calorie_target ?? 2000

      await sendTextMessage(user.phone, buildWeeklySummaryMessage(avgCalories, target))

      // Update whichever column exists
      await supabase
        .from('user_settings')
        .update({ last_summary_sent_at: new Date().toISOString() })
        .eq('user_id', user.id)

      sent++
    } catch (err) {
      console.error(`[cron] Failed to send weekly summary to user ${user.id}:`, err)
    }
  }

  return sent
}

// ---------------------------------------------------------------------------
// Step 5: Auto-confirm pending meals (context older than 2 minutes)
// ---------------------------------------------------------------------------

async function processAutoConfirm(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
): Promise<number> {
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString()

  const { data: pendingContexts, error } = await supabase
    .from('conversation_context')
    .select('id, user_id, context_data, created_at')
    .eq('context_type', 'awaiting_confirmation')
    .lt('created_at', twoMinutesAgo)

  if (error) {
    console.error('[cron] Failed to fetch pending contexts:', error)
    return 0
  }

  if (!pendingContexts || pendingContexts.length === 0) return 0

  let confirmed = 0

  for (const ctx of pendingContexts as ContextRow[]) {
    try {
      const analysis = ctx.context_data.mealAnalysis as MealAnalysis
      const originalMessage = (ctx.context_data.originalMessage as string) ?? ''

      if (!analysis || !analysis.items) {
        // Malformed context — just delete it
        await supabase.from('conversation_context').delete().eq('id', ctx.id)
        continue
      }

      const totalCals = Math.round(
        analysis.items.reduce((sum, item) => sum + (item.calories ?? 0), 0),
      )

      // Fetch user to get daily_calorie_target (needed for logging, not critical here)
      await createMeal(supabase, {
        userId: ctx.user_id,
        mealType: analysis.meal_type ?? 'outro',
        totalCalories: totalCals,
        originalMessage,
        llmResponse: analysis as unknown as Record<string, unknown>,
        items: analysis.items.map((item) => ({
          foodName: item.food,
          quantityGrams: item.quantity_grams,
          calories: item.calories ?? 0,
          proteinG: item.protein ?? 0,
          carbsG: item.carbs ?? 0,
          fatG: item.fat ?? 0,
          source: item.quantity_source,
        })),
      })

      await supabase.from('conversation_context').delete().eq('id', ctx.id)

      confirmed++
    } catch (err) {
      console.error(`[cron] Failed to auto-confirm meal for user ${ctx.user_id}:`, err)
      // Delete the context anyway to avoid infinite retries
      await supabase.from('conversation_context').delete().eq('id', ctx.id)
    }
  }

  return confirmed
}

// ---------------------------------------------------------------------------
// POST /api/cron/reminders
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createServiceRoleClient() as any

  try {
    // --- Fetch all users with reminders enabled ---
    const { data: settingsRows, error: settingsError } = await supabase
      .from('user_settings')
      .select('*')
      .eq('reminders_enabled', true)

    if (settingsError) {
      throw new Error(`Failed to fetch user_settings: ${settingsError.message}`)
    }

    const settings = (settingsRows ?? []) as UserSettingsRow[]
    const userIds = settings.map((s) => s.user_id)

    let users: UserWithSettings[] = []

    if (userIds.length > 0) {
      const { data: userRows, error: usersError } = await supabase
        .from('users')
        .select('id, phone, timezone, daily_calorie_target')
        .in('id', userIds)

      if (usersError) {
        throw new Error(`Failed to fetch users: ${usersError.message}`)
      }

      const userMap = new Map<string, UserRow>(
        ((userRows ?? []) as UserRow[]).map((u) => [u.id, u]),
      )

      users = settings
        .map((s) => {
          const user = userMap.get(s.user_id)
          if (!user) return null
          return { user, settings: s }
        })
        .filter((x): x is UserWithSettings => x !== null)
    }

    // --- Step 2: Daily reminders ---
    const remindersSent = await processDailyReminders(users, supabase)

    // --- Step 3: Daily summaries ---
    const summariesSent = await processDailySummaries(users, supabase)

    // --- Step 4: Weekly summaries ---
    const weeklySent = await processWeeklySummaries(users, supabase)

    // --- Step 5: Auto-confirm pending meals ---
    const autoConfirmed = await processAutoConfirm(supabase)

    // --- Step 6: Cleanup processed_messages older than 24h ---
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    await supabase.from('processed_messages').delete().lt('processed_at', cutoff)

    return NextResponse.json({
      success: true,
      remindersSent,
      summariesSent,
      weeklySent,
      autoConfirmed,
    })
  } catch (error) {
    console.error('[cron] Error:', error)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
