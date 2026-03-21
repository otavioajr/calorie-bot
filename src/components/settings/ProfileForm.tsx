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
    } catch {
      setMessage({ type: "error", text: "Erro de conexão. Tente novamente." })
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

      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "Salvando..." : "Salvar perfil"}
      </Button>
    </form>
  )
}
