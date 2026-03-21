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

  function formatPhone(value: string): string {
    // Strip non-digits
    const digits = value.replace(/\D/g, "")
    // Format as Brazilian number
    if (digits.length <= 2) return digits
    if (digits.length <= 7) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`
    if (digits.length <= 11)
      return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7, 11)}`
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
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-accent to-background px-4">
      <div className="w-full max-w-md">
        {/* Logo / Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary mb-4">
            <span className="text-3xl">🥗</span>
          </div>
          <h1 className="text-3xl font-bold text-foreground">CalorieBot</h1>
          <p className="text-muted-foreground mt-2">
            Acompanhe suas calorias de forma simples e inteligente
          </p>
        </div>

        <Card className="shadow-lg border-border">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl">
              {step === "phone" ? "Entrar na sua conta" : "Verificar código"}
            </CardTitle>
            <CardDescription>
              {step === "phone"
                ? "Digite seu número de WhatsApp para receber o código de acesso"
                : `Código enviado para (${phone.slice(0, 4)}) ****-${phone.slice(-4)}`}
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
                    placeholder="(11) 99999-9999"
                    value={phone}
                    onChange={(e) => setPhone(formatPhone(e.target.value))}
                    required
                    className="h-11"
                    maxLength={15}
                  />
                </div>
                {error && (
                  <p className="text-sm text-destructive">{error}</p>
                )}
                <Button
                  type="submit"
                  className="w-full h-11 text-base"
                  disabled={loading || phone.replace(/\D/g, "").length < 10}
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
                    className="h-11 text-center text-2xl tracking-widest"
                    maxLength={6}
                    autoFocus
                  />
                </div>
                {error && (
                  <p className="text-sm text-destructive">{error}</p>
                )}
                <Button
                  type="submit"
                  className="w-full h-11 text-base"
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

        <p className="text-center text-xs text-muted-foreground mt-6">
          Novo usuário? Inicie uma conversa com o bot no WhatsApp primeiro.
        </p>
      </div>
    </div>
  )
}
