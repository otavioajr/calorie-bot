import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { createServiceRoleClient } from "@/lib/db/supabase"
import { getUserWithSettings } from "@/lib/db/queries/users"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ProfileForm } from "@/components/settings/ProfileForm"
import { BotSettings } from "@/components/settings/BotSettings"
import { ResetDataButton } from "@/components/settings/ResetDataButton"

export default async function SettingsPage() {
  const cookieStore = await cookies()
  const userId = cookieStore.get("caloriebot-user-id")?.value

  if (!userId) {
    redirect("/")
  }

  const supabase = createServiceRoleClient()

  let userData
  try {
    userData = await getUserWithSettings(supabase, userId)
  } catch {
    redirect("/")
  }

  const { user, settings } = userData

  return (
    <div className="space-y-6">
      <div className="rounded-[2rem] border border-border bg-card/75 p-6 shadow-sm backdrop-blur sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-secondary">
          Concierge pessoal
        </p>
        <h1 className="mt-4 font-heading text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
          Configurações
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
          Ajuste os dados que orientam suas metas, lembretes e respostas do CalorieBot no WhatsApp.
        </p>
      </div>

      <Tabs defaultValue="profile" className="space-y-4">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="profile">Perfil</TabsTrigger>
          <TabsTrigger value="bot">Configurações do Bot</TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
          <Card>
            <CardHeader>
              <CardTitle className="font-heading text-2xl font-semibold">Dados pessoais</CardTitle>
              <CardDescription>
                Atualize suas informações para recalcular sua meta calórica
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ProfileForm user={user} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="bot">
          <Card>
            <CardHeader>
              <CardTitle className="font-heading text-2xl font-semibold">Preferências do bot</CardTitle>
              <CardDescription>
                Configure como o CalorieBot se comporta no WhatsApp
              </CardDescription>
            </CardHeader>
            <CardContent>
              <BotSettings settings={settings} calorieMode={user.calorieMode} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Card className="border-destructive/60 bg-card/85">
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
    </div>
  )
}
