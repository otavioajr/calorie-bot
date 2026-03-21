"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import type { UserSettings } from "@/lib/db/queries/users"

interface BotSettingsProps {
  settings: UserSettings | null
  calorieMode: string
}

interface SettingsSaveResult {
  success: boolean
  error?: string
}

export function BotSettings({ settings, calorieMode: initialCalorieMode }: BotSettingsProps) {
  const [calorieMode, setCalorieMode] = useState(initialCalorieMode)
  const [detailLevel, setDetailLevel] = useState<string>(settings?.detailLevel ?? "brief")
  const [weightUnit, setWeightUnit] = useState<string>(settings?.weightUnit ?? "kg")

  function handleSelectChange(setter: (v: string) => void, fallback: string) {
    return (value: string | null) => setter(value ?? fallback)
  }
  const [remindersEnabled, setRemindersEnabled] = useState(settings?.remindersEnabled ?? false)
  const [reminderTime, setReminderTime] = useState(settings?.reminderTime ?? "14:00")
  const [dailySummaryTime, setDailySummaryTime] = useState(settings?.dailySummaryTime ?? "21:00")
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setMessage(null)

    try {
      const res = await fetch("/api/user/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          calorieMode,
          detailLevel,
          weightUnit,
          remindersEnabled,
          reminderTime,
          dailySummaryTime,
        }),
      })
      const data = (await res.json()) as SettingsSaveResult
      if (!res.ok || !data.success) {
        setMessage({ type: "error", text: data.error ?? "Erro ao salvar. Tente novamente." })
        return
      }
      setMessage({ type: "success", text: "Configurações salvas!" })
    } catch {
      setMessage({ type: "error", text: "Erro de conexão. Tente novamente." })
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Calorie Mode */}
      <div className="space-y-2">
        <Label htmlFor="calorieMode">Modo de cálculo de calorias</Label>
        <Select value={calorieMode} onValueChange={handleSelectChange(setCalorieMode, "approximate")}>
          <SelectTrigger id="calorieMode">
            <SelectValue placeholder="Selecionar" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="approximate">Aproximado (IA)</SelectItem>
            <SelectItem value="taco">Tabela TACO</SelectItem>
            <SelectItem value="manual">Manual</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Como o bot calcula as calorias dos alimentos
        </p>
      </div>

      {/* Detail Level */}
      <div className="space-y-2">
        <Label htmlFor="detailLevel">Nível de detalhe das respostas</Label>
        <Select value={detailLevel} onValueChange={handleSelectChange(setDetailLevel, "brief")}>
          <SelectTrigger id="detailLevel">
            <SelectValue placeholder="Selecionar" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="brief">Resumido</SelectItem>
            <SelectItem value="detailed">Detalhado</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Weight Unit */}
      <div className="space-y-2">
        <Label htmlFor="weightUnit">Unidade de peso</Label>
        <Select value={weightUnit} onValueChange={handleSelectChange(setWeightUnit, "kg")}>
          <SelectTrigger id="weightUnit">
            <SelectValue placeholder="Selecionar" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="kg">Quilogramas (kg)</SelectItem>
            <SelectItem value="lb">Libras (lb)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Reminders */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <Label htmlFor="reminders" className="text-sm font-medium">
              Lembretes ativos
            </Label>
            <p className="text-xs text-muted-foreground">Receba lembretes para registrar refeições</p>
          </div>
          <Switch
            id="reminders"
            checked={remindersEnabled}
            onCheckedChange={setRemindersEnabled}
          />
        </div>

        {remindersEnabled && (
          <div className="grid grid-cols-2 gap-4 pl-4 border-l-2 border-primary/30">
            <div className="space-y-2">
              <Label htmlFor="reminderTime">Hora do lembrete</Label>
              <Input
                id="reminderTime"
                type="time"
                value={reminderTime}
                onChange={(e) => setReminderTime(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="summaryTime">Resumo diário</Label>
              <Input
                id="summaryTime"
                type="time"
                value={dailySummaryTime}
                onChange={(e) => setDailySummaryTime(e.target.value)}
              />
            </div>
          </div>
        )}
      </div>

      {/* Message */}
      {message && (
        <p className={`text-sm ${message.type === "success" ? "text-primary" : "text-destructive"}`}>
          {message.text}
        </p>
      )}

      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "Salvando..." : "Salvar configurações"}
      </Button>
    </form>
  )
}
