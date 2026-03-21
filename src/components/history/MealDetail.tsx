"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface MealItem {
  id?: string
  foodName: string
  quantityGrams: number
  calories: number
  proteinG: number
  carbsG: number
  fatG: number
}

interface MealDetailData {
  id: string
  mealType: string
  totalCalories: number
  registeredAt: string
  items: MealItem[]
}

interface MealDetailProps {
  meal: MealDetailData
  onDelete: (mealId: string) => void
}

export function MealDetail({ meal, onDelete }: MealDetailProps) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function handleDelete() {
    setDeleting(true)
    try {
      const res = await fetch(`/api/meals/${meal.id}`, { method: "DELETE" })
      if (res.ok) {
        onDelete(meal.id)
        setConfirmOpen(false)
      }
    } catch {
      // ignore
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Items table */}
      {meal.items.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 text-muted-foreground font-medium">Alimento</th>
                <th className="text-right py-2 text-muted-foreground font-medium">Qtd (g)</th>
                <th className="text-right py-2 text-muted-foreground font-medium">Kcal</th>
                <th className="text-right py-2 text-muted-foreground font-medium hidden sm:table-cell">Prot</th>
                <th className="text-right py-2 text-muted-foreground font-medium hidden sm:table-cell">Carb</th>
                <th className="text-right py-2 text-muted-foreground font-medium hidden sm:table-cell">Gord</th>
              </tr>
            </thead>
            <tbody>
              {meal.items.map((item, idx) => (
                <tr key={idx} className="border-b border-border/50 last:border-0">
                  <td className="py-2 text-foreground">{item.foodName}</td>
                  <td className="py-2 text-right text-muted-foreground">{item.quantityGrams}g</td>
                  <td className="py-2 text-right font-medium text-primary">{item.calories}</td>
                  <td className="py-2 text-right text-muted-foreground hidden sm:table-cell">{item.proteinG}g</td>
                  <td className="py-2 text-right text-muted-foreground hidden sm:table-cell">{item.carbsG}g</td>
                  <td className="py-2 text-right text-muted-foreground hidden sm:table-cell">{item.fatG}g</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Sem detalhes de itens disponíveis.</p>
      )}

      {/* Delete button */}
      <div className="flex justify-end pt-2">
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setConfirmOpen(true)}
        >
          Excluir refeição
        </Button>
      </div>

      {/* Confirm dialog */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirmar exclusão</DialogTitle>
            <DialogDescription>
              Tem certeza que deseja excluir esta refeição? Esta ação não pode ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? "Excluindo..." : "Excluir"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
