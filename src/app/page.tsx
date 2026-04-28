"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"

export default function LoginPage() {
  const router = useRouter()
  const [phone, setPhone] = useState("")
  const [code, setCode] = useState("")
  const [step, setStep] = useState<"phone" | "code">("phone")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  function handlePhoneChange(value: string): string {
    // Allow only digits while typing
    return value.replace(/\D/g, "").slice(0, 11)
  }

  function displayPhone(digits: string): string {
    // Format for display only when complete (10-11 digits)
    if (digits.length >= 11)
      return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`
    if (digits.length >= 10)
      return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`
    return digits
  }

  function toE164(formatted: string): string {
    const digits = formatted.replace(/\D/g, "")
    return `+55${digits}`
  }

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setLoading(true)

    try {
      const res = await fetch("/api/auth/otp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: toE164(phone) }),
      })
      const data = (await res.json()) as { success?: boolean; error?: string }
      if (!res.ok || data.error) {
        setError(data.error ?? "Erro ao enviar código. Tente novamente.")
        return
      }
      setStep("code")
    } catch {
      setError("Erro de conexão. Tente novamente.")
    } finally {
      setLoading(false)
    }
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setLoading(true)

    try {
      const res = await fetch("/api/auth/otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: toE164(phone), code }),
      })
      const data = (await res.json()) as { success?: boolean; error?: string }
      if (!res.ok || !data.success) {
        setError(data.error ?? "Código inválido. Tente novamente.")
        return
      }
      router.push("/dashboard")
    } catch {
      setError("Erro de conexão. Tente novamente.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="relative min-h-screen overflow-hidden px-4 py-6 sm:px-6 lg:px-8">
      <div className="pointer-events-none absolute inset-0 -z-10 opacity-80">
        <div className="absolute left-[-10rem] top-24 h-80 w-80 rounded-full bg-accent/70 blur-3xl" />
        <div className="absolute right-[-8rem] top-10 h-72 w-72 rounded-full bg-secondary/20 blur-3xl" />
        <div className="absolute bottom-[-12rem] left-1/3 h-96 w-96 rounded-full bg-primary/10 blur-3xl" />
      </div>

      <div className="mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-7xl flex-col">
        <header className="flex items-center justify-between py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-primary/20 bg-card text-primary shadow-sm">
              <span className="h-2.5 w-2.5 rounded-full bg-secondary" />
            </div>
            <div>
              <p className="font-heading text-xl font-semibold tracking-tight text-primary">
                CalorieBot
              </p>
              <p className="text-xs uppercase tracking-[0.28em] text-muted-foreground">
                WhatsApp nutrition concierge
              </p>
            </div>
          </div>
          <span className="hidden rounded-full border border-border bg-card/70 px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm sm:inline-flex">
            Painel web + registro no WhatsApp
          </span>
        </header>

        <section className="grid flex-1 items-center gap-10 py-10 lg:grid-cols-[1.12fr_0.88fr] lg:py-16">
          <div className="space-y-8">
            <div className="inline-flex items-center gap-2 rounded-full border border-secondary/25 bg-card/70 px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-secondary shadow-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-secondary" />
              Sem abrir outro app
            </div>

            <div className="max-w-3xl space-y-5">
              <h1 className="font-heading text-5xl font-semibold leading-[0.9] tracking-tight text-foreground sm:text-6xl lg:text-7xl">
                Seu concierge nutricional mora no WhatsApp.
              </h1>
              <p className="max-w-2xl text-lg leading-8 text-muted-foreground sm:text-xl">
                Envie o que comeu em linguagem natural. O CalorieBot registra,
                estima calorias e deixa seu progresso pronto para revisar no painel.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              {[
                ["01", "Registre pelo WhatsApp", "almocei arroz, feijão e frango"],
                ["02", "Revise o dia", "calorias, refeições e histórico"],
                ["03", "Reutilize receitas", "pratos caseiros com mais precisão"],
              ].map(([number, title, description]) => (
                <div
                  key={number}
                  className="rounded-2xl border border-border bg-card/75 p-4 shadow-sm backdrop-blur"
                >
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-secondary">
                    {number}
                  </p>
                  <p className="mt-3 font-semibold text-foreground">{title}</p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {description}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div className="relative mx-auto w-full max-w-md lg:max-w-none">
            <div className="absolute -left-8 top-8 hidden w-56 rotate-[-4deg] rounded-3xl border border-primary/15 bg-primary p-5 text-primary-foreground shadow-2xl lg:block">
              <p className="text-xs uppercase tracking-[0.22em] text-primary-foreground/70">
                Exemplo
              </p>
              <p className="mt-4 text-sm leading-6">
                “almocei arroz, feijão, frango grelhado e salada”
              </p>
              <div className="mt-5 rounded-2xl bg-primary-foreground/10 p-3 text-sm">
                Almoço registrado: 510 kcal. Hoje: 1.230 / 2.000 kcal.
              </div>
            </div>

            <Card className="relative overflow-hidden border-border/80 bg-card/90 shadow-2xl backdrop-blur">
              <div className="absolute inset-x-0 top-0 h-1 bg-secondary" />
              <CardHeader className="space-y-3 pb-5 pt-8">
                <div className="inline-flex w-fit rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-foreground">
                  Login por código no WhatsApp
                </div>
                <CardTitle className="font-heading text-3xl font-semibold tracking-tight">
                  {step === "phone" ? "Entrar pelo WhatsApp" : "Verificar código"}
                </CardTitle>
                <CardDescription className="text-base leading-7">
                  {step === "phone"
                    ? "Digite seu número para receber o código de acesso no WhatsApp."
                    : `Código enviado para ${displayPhone(phone)}`}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {step === "phone" ? (
                  <form onSubmit={handleSendCode} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="phone">Número de WhatsApp</Label>
                      <Input
                        id="phone"
                        type="tel"
                        placeholder="11999999999"
                        value={phone}
                        onChange={(e) => setPhone(handlePhoneChange(e.target.value))}
                        required
                        className="h-12 bg-background/70 text-base"
                        maxLength={11}
                      />
                    </div>
                    {error && (
                      <p role="alert" className="text-sm font-medium text-destructive">
                        {error}
                      </p>
                    )}
                    <Button
                      type="submit"
                      className="h-12 w-full text-base"
                      disabled={loading || phone.length < 10}
                    >
                      {loading ? "Enviando..." : "Enviar código"}
                    </Button>
                  </form>
                ) : (
                  <form onSubmit={handleVerifyCode} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="code">Código de 6 dígitos</Label>
                      <Input
                        id="code"
                        type="text"
                        inputMode="numeric"
                        placeholder="000000"
                        value={code}
                        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                        required
                        className="h-12 bg-background/70 text-center text-2xl tracking-widest"
                        maxLength={6}
                        autoFocus
                      />
                    </div>
                    {error && (
                      <p role="alert" className="text-sm font-medium text-destructive">
                        {error}
                      </p>
                    )}
                    <Button
                      type="submit"
                      className="h-12 w-full text-base"
                      disabled={loading || code.length !== 6}
                    >
                      {loading ? "Verificando..." : "Entrar"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="w-full"
                      onClick={() => {
                        setStep("phone")
                        setCode("")
                        setError("")
                      }}
                    >
                      Alterar número
                    </Button>
                  </form>
                )}
              </CardContent>
            </Card>

            <p className="mt-5 text-center text-sm text-muted-foreground">
              Novo usuário? Inicie a conversa com o bot no WhatsApp primeiro.
            </p>
          </div>
        </section>
      </div>
    </main>
  )
}
