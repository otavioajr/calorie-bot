import Link from "next/link"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { RecipeList } from "@/components/recipes/RecipeList"
import { createServiceRoleClient } from "@/lib/db/supabase"
import { getRecipesByUser } from "@/lib/db/queries/recipes"

export default async function RecipesPage() {
  const cookieStore = await cookies()
  const userId = cookieStore.get("caloriebot-user-id")?.value

  if (!userId) {
    redirect("/")
  }

  const supabase = createServiceRoleClient()
  const recipes = await getRecipesByUser(supabase, userId)

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Minhas receitas</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Receitas salvas para registrar refeições com rendimento e macros.
          </p>
        </div>
        <Button render={<Link href="/recipes/new" />}>
          <Plus data-icon="inline-start" />
          Nova receita
        </Button>
      </div>

      <RecipeList recipes={recipes} />
    </div>
  )
}
