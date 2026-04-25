"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface LogRecipeModalProps {
  recipeId: string
  open: boolean
  onClose: () => void
}

const MEAL_TYPES = [
  { value: "breakfast", label: "Café da manhã" },
  { value: "lunch", label: "Almoço" },
  { value: "snack", label: "Lanche" },
  { value: "dinner", label: "Jantar" },
  { value: "supper", label: "Ceia" },
] as const
const MAX_SERVINGS_CONSUMED = 999.99

function getLocalDateTimeValue(date = new Date()) {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)

  return localDate.toISOString().slice(0, 16)
}

function sanitizeEndpointText(value: unknown) {
  if (typeof value !== "string") return null

  const sanitized = value
    .replace(/[^\p{L}\p{N}\s._:-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)

  return sanitized || null
}

async function readErrorMessage(response: Response) {
  try {
    const data = (await response.json()) as { error?: unknown; message?: unknown }
    const error = sanitizeEndpointText(data.error)
    const message = sanitizeEndpointText(data.message)

    if (error && message && error !== message) {
      return `Não foi possível registrar a receita. Código: ${error}. ${message}`
    }

    if (error) {
      return `Não foi possível registrar a receita. Código: ${error}`
    }

    if (message) {
      return `Não foi possível registrar a receita. ${message}`
    }
  } catch {
    // Fall back to the generic message below.
  }

  return "Não foi possível registrar a receita. Tente novamente."
}

function isValidLocalDateTime(value: string) {
  if (!value) return false

  return Number.isFinite(new Date(value).getTime())
}

export function LogRecipeModal({ recipeId, open, onClose }: LogRecipeModalProps) {
  const router = useRouter()
  const [servings, setServings] = useState("1")
  const [mealType, setMealType] = useState<(typeof MEAL_TYPES)[number]["value"]>("lunch")
  const [registeredAt, setRegisteredAt] = useState(() => getLocalDateTimeValue())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setServings("1")
      setMealType("lunch")
      setRegisteredAt(getLocalDateTimeValue())
      setError(null)
      setLoading(false)
    }
  }, [open])

  const servingsNumber = Number(servings)
  const isValid = useMemo(
    () =>
      Number.isFinite(servingsNumber) &&
      servingsNumber > 0 &&
      servingsNumber <= MAX_SERVINGS_CONSUMED &&
      isValidLocalDateTime(registeredAt),
    [registeredAt, servingsNumber]
  )

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!isValid || loading) return

    setLoading(true)
    setError(null)

    try {
      const response = await fetch(`/api/recipes/${recipeId}/log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          servingsConsumed: servingsNumber,
          mealType,
          registeredAt: new Date(registeredAt).toISOString(),
        }),
      })

      if (!response.ok) {
        setError(await readErrorMessage(response))
        return
      }

      onClose()
      router.push("/history")
    } catch {
      setError("Erro de conexão. Tente novamente.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Registrar receita</DialogTitle>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="recipe-servings">Porções consumidas</Label>
            <Input
              id="recipe-servings"
              type="number"
              min={0.01}
              max={MAX_SERVINGS_CONSUMED}
              step="0.01"
              inputMode="decimal"
              value={servings}
              onChange={(event) => setServings(event.target.value)}
              disabled={loading}
              aria-invalid={
                servings !== "" &&
                (!Number.isFinite(servingsNumber) ||
                  servingsNumber <= 0 ||
                  servingsNumber > MAX_SERVINGS_CONSUMED)
              }
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="recipe-meal-type">Tipo de refeição</Label>
            <Select
              value={mealType}
              onValueChange={(value) => {
                if (MEAL_TYPES.some((option) => option.value === value)) {
                  setMealType(value as typeof mealType)
                }
              }}
            >
              <SelectTrigger id="recipe-meal-type" className="w-full">
                <SelectValue placeholder="Selecionar" />
              </SelectTrigger>
              <SelectContent>
                {MEAL_TYPES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="recipe-registered-at">Data e hora</Label>
            <Input
              id="recipe-registered-at"
              type="datetime-local"
              value={registeredAt}
              onChange={(event) => setRegisteredAt(event.target.value)}
              disabled={loading}
              aria-invalid={registeredAt !== "" && !isValidLocalDateTime(registeredAt)}
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={loading}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={!isValid || loading}>
              {loading ? "Registrando..." : "Registrar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
