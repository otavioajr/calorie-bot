import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { RecipeWizard } from "@/components/recipes/RecipeWizard"

export default async function NewRecipePage() {
  const cookieStore = await cookies()
  const userId = cookieStore.get("caloriebot-user-id")?.value

  if (!userId) {
    redirect("/")
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Nova receita</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Cadastre ingredientes, rendimento e porções da receita.
        </p>
      </div>

      <RecipeWizard />
    </div>
  )
}
