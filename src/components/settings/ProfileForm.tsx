"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { User } from "@/lib/db/queries/users"

interface ProfileFormProps {
  user: User
}

interface ProfileSaveResult {
  success: boolean
  tmb?: number
  tdee?: number
  dailyTarget?: number
  maxWeightKg?: number
  proteinG?: number
  fatG?: number
  carbsG?: number
  error?: string
}

export function ProfileForm({ user }: ProfileFormProps) {
  const [name, setName] = useState(user.name ?? "")
  const [age, setAge] = useState(String(user.age ?? ""))
  const [sex, setSex] = useState<string>(user.sex ?? "")
  const [weight, setWeight] = useState(String(user.weightKg ?? ""))
  const [height, setHeight] = useState(String(user.heightCm ?? ""))
  const [activityLevel, setActivityLevel] = useState<string>(user.activityLevel ?? "")
  const [goal, setGoal] = useState<string>(user.goal ?? "")
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null)
  const [result, setResult] = useState<{ tmb?: number; tdee?: number; dailyTarget?: number } | null>(null)
  const [proteinG, setProteinG] = useState<number | null>(user.dailyProteinG ?? null)
  const [fatG, setFatG] = useState<number | null>(user.dailyFatG ?? null)
  const [carbsG, setCarbsG] = useState<number | null>(user.dailyCarbsG ?? null)
  const [editingMacros, setEditingMacros] = useState(false)

  function handleSelectChange(setter: (v: string) => void) {
    return (value: string | null) => setter(value ?? "")
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setMessage(null)

    try {
      const res = await fetch("/api/user/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          age: age ? Number(age) : null,
          sex: sex || null,
          weightKg: weight ? Number(weight) : null,
          heightCm: height ? Number(height) : null,
          activityLevel: activityLevel || null,
          goal: goal || null,
        }),
      })
      const data = (await res.json()) as ProfileSaveResult
      if (!res.ok || !data.success) {
        setMessage({ type: "error", text: data.error ?? "Erro ao salvar. Tente novamente." })
        return
      }
      setMessage({ type: "success", text: "Perfil salvo com sucesso!" })
      if (data.tmb) {
        setResult({ tmb: data.tmb, tdee: data.tdee, dailyTarget: data.dailyTarget })
      }
      if (data.proteinG !== undefined) {
        setProteinG(data.proteinG ?? null)
        setFatG(data.fatG ?? null)
        setCarbsG(data.carbsG ?? null)
      }
    } catch {
      setMessage({ type: "error", text: "Erro de conexão. Tente novamente." })
    } finally {
      setLoading(false)
    }
  }

  function rebalanceCarbsFromProteinFat(newProtein: number, newFat: number) {
    const target = result?.dailyTarget ?? user.dailyCalorieTarget ?? 2000
    const remaining = target - newProtein * 4 - newFat * 9
    setCarbsG(Math.max(0, Math.round(remaining / 4)))
  }

  function rebalanceProteinFatFromCarbs(newCarbs: number) {
    const target = result?.dailyTarget ?? user.dailyCalorieTarget ?? 2000
    const currentProtein = proteinG ?? 0
    const currentFat = fatG ?? 0
    const oldPFKcal = currentProtein * 4 + currentFat * 9
    if (oldPFKcal === 0) return
    const newPFKcal = target - newCarbs * 4
    if (newPFKcal <= 0) return
    const ratio = newPFKcal / oldPFKcal
    setProteinG(Math.round(currentProtein * ratio))
    setFatG(Math.round(currentFat * ratio))
  }

  async function saveMacros() {
    setLoading(true)
    try {
      const res = await fetch("/api/user/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dailyProteinG: proteinG,
          dailyFatG: fatG,
          dailyCarbsG: carbsG,
        }),
      })
      const data = (await res.json()) as ProfileSaveResult
      if (!res.ok || !data.success) {
        setMessage({ type: "error", text: data.error ?? "Erro ao salvar macros." })
        return
      }
      setMessage({ type: "success", text: "Macros salvos com sucesso!" })
      setEditingMacros(false)
    } catch {
      setMessage({ type: "error", text: "Erro de conexão." })
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Name */}
      <div className="space-y-2">
        <Label htmlFor="name">Nome</Label>
        <Input
          id="name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Seu nome"
        />
      </div>

      {/* Age + Sex */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="age">Idade</Label>
          <Input
            id="age"
            type="number"
            min={10}
            max={120}
            value={age}
            onChange={(e) => setAge(e.target.value)}
            placeholder="Anos"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="sex">Sexo</Label>
          <Select value={sex} onValueChange={handleSelectChange(setSex)}>
            <SelectTrigger id="sex">
              <SelectValue placeholder="Selecionar" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="male">Masculino</SelectItem>
              <SelectItem value="female">Feminino</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Weight + Height */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="weight">Peso (kg)</Label>
          <Input
            id="weight"
            type="number"
            min={20}
            max={500}
            step="0.1"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            placeholder="kg"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="height">Altura (cm)</Label>
          <Input
            id="height"
            type="number"
            min={100}
            max={250}
            value={height}
            onChange={(e) => setHeight(e.target.value)}
            placeholder="cm"
          />
        </div>
      </div>

      {/* Activity Level */}
      <div className="space-y-2">
        <Label htmlFor="activity">Nível de atividade</Label>
        <Select value={activityLevel} onValueChange={handleSelectChange(setActivityLevel)}>
          <SelectTrigger id="activity">
            <SelectValue placeholder="Selecionar" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="sedentary">Sedentário (sem exercício)</SelectItem>
            <SelectItem value="light">Leve (1-3x por semana)</SelectItem>
            <SelectItem value="moderate">Moderado (3-5x por semana)</SelectItem>
            <SelectItem value="intense">Intenso (6-7x por semana)</SelectItem>
            <SelectItem value="athlete">Atleta (treino intenso 2x/dia)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Goal */}
      <div className="space-y-2">
        <Label htmlFor="goal">Objetivo</Label>
        <Select value={goal} onValueChange={handleSelectChange(setGoal)}>
          <SelectTrigger id="goal">
            <SelectValue placeholder="Selecionar" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="lose">Perder peso</SelectItem>
            <SelectItem value="maintain">Manter peso</SelectItem>
            <SelectItem value="gain">Ganhar peso</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Message */}
      {message && (
        <p className={`text-sm ${message.type === "success" ? "text-primary" : "text-destructive"}`}>
          {message.text}
        </p>
      )}

      {/* TDEE Result */}
      {result && (
        <div className="bg-accent/50 rounded-lg p-4 space-y-1 text-sm">
          <p className="font-medium text-accent-foreground">Cálculo atualizado:</p>
          <p className="text-muted-foreground">TMB: <span className="font-semibold text-foreground">{result.tmb?.toLocaleString("pt-BR")} kcal</span></p>
          <p className="text-muted-foreground">TDEE: <span className="font-semibold text-foreground">{result.tdee?.toLocaleString("pt-BR")} kcal</span></p>
          <p className="text-muted-foreground">Meta diária: <span className="font-semibold text-primary">{result.dailyTarget?.toLocaleString("pt-BR")} kcal</span></p>
        </div>
      )}

      {/* Macros Display / Edit */}
      {(proteinG !== null || fatG !== null || carbsG !== null) && (
        <div className="bg-accent/50 rounded-lg p-4 space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <p className="font-medium text-accent-foreground">Macros diários:</p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditingMacros(!editingMacros)}
            >
              {editingMacros ? "Cancelar" : "Editar"}
            </Button>
          </div>

          {editingMacros ? (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="protein" className="text-xs">Proteína (g)</Label>
                  <Input
                    id="protein"
                    type="number"
                    min={0}
                    value={String(proteinG ?? 0)}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      setProteinG(v)
                      rebalanceCarbsFromProteinFat(v, fatG ?? 0)
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="fat" className="text-xs">Gordura (g)</Label>
                  <Input
                    id="fat"
                    type="number"
                    min={0}
                    value={String(fatG ?? 0)}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      setFatG(v)
                      rebalanceCarbsFromProteinFat(proteinG ?? 0, v)
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="carbs" className="text-xs">Carbs (g)</Label>
                  <Input
                    id="carbs"
                    type="number"
                    min={0}
                    value={String(carbsG ?? 0)}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      setCarbsG(v)
                      rebalanceProteinFatFromCarbs(v)
                    }}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Total: {((proteinG ?? 0) * 4 + (fatG ?? 0) * 9 + (carbsG ?? 0) * 4).toLocaleString("pt-BR")} kcal
              </p>
              <Button type="button" size="sm" onClick={saveMacros} disabled={loading}>
                {loading ? "Salvando..." : "Salvar macros"}
              </Button>
            </div>
          ) : (
            <div className="space-y-1">
              <p className="text-muted-foreground">Proteína: <span className="font-semibold text-foreground">{proteinG}g</span></p>
              <p className="text-muted-foreground">Gordura: <span className="font-semibold text-foreground">{fatG}g</span></p>
              <p className="text-muted-foreground">Carbs: <span className="font-semibold text-foreground">{carbsG}g</span></p>
            </div>
          )}
        </div>
      )}

      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "Salvando..." : "Salvar perfil"}
      </Button>
    </form>
  )
}
