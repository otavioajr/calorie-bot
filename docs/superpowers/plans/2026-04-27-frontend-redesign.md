# Frontend Redesign Editorial Premium Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the CalorieBot frontend into a cohesive editorial premium experience that foregrounds WhatsApp-first nutrition tracking while preserving current auth and data contracts.

**Architecture:** Apply the redesign in layers: first update global metadata/fonts/tokens, then rebuild the public login page around the existing OTP state machine, then update authenticated navigation/route protection, then polish authenticated pages and empty states. Existing shadcn-style UI primitives, server data fetching, Supabase queries, and auth endpoints remain unchanged.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, Tailwind CSS v4 CSS-first tokens, shadcn/base-nova UI primitives, Recharts, Vitest, ESLint.

---

## File structure

### Modify

- `src/app/layout.tsx` — root metadata, locale, and font variables.
- `src/app/globals.css` — Tailwind v4 theme mappings, editorial color tokens, base body/selection polish.
- `src/app/page.tsx` — public landing/login page; preserve OTP handlers and endpoint calls.
- `src/app/(auth)/layout.tsx` — authenticated shell nav, Recipes link, active-route logic, header styling.
- `src/middleware.ts` — protected route list includes `/recipes`.
- `src/app/(auth)/dashboard/page.tsx` — editorial page heading and card framing, no query changes.
- `src/app/(auth)/history/page.tsx` — editorial page heading and date-selector card polish.
- `src/app/(auth)/settings/page.tsx` — editorial page heading and settings card copy polish.
- `src/app/(auth)/recipes/page.tsx` — editorial page heading and recipes value copy.
- `src/components/dashboard/CalorieProgress.tsx` — premium copy/hierarchy, remove primary emoji status.
- `src/components/dashboard/MealBreakdown.tsx` — quieter meal cards and instructive empty labels.
- `src/components/dashboard/RecentMeals.tsx` — instructive empty state and refined list rows.
- `src/components/dashboard/WeeklyChart.tsx` — replace invalid `hsl(var(...))` inline colors with direct CSS variables.
- `src/components/history/MealList.tsx` — instructive empty state and quieter list styling.
- `src/components/recipes/RecipeList.tsx` — recipe empty state becomes value-led.

### Do not modify

- Auth endpoints under `src/app/api/auth/*`.
- Supabase query functions under `src/lib/db/queries/*`.
- Recipe wizard internals unless TypeScript requires a className consistency fix.
- Database migrations.

---

## Task 1: Global brand foundation

**Files:**
- Modify: `src/app/layout.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Inspect current files**

Read:

```bash
# Use Read tool, not shell cat
src/app/layout.tsx
src/app/globals.css
```

Expected: `layout.tsx` imports `Geist`/`Geist_Mono`, metadata is `Create Next App`, and `<html lang="en">`. `globals.css` defines OKLCH shadcn/Tailwind tokens.

- [ ] **Step 2: Update root metadata, language, and fonts**

In `src/app/layout.tsx`, replace the current file with:

```tsx
import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Mono, Source_Serif_4 } from "next/font/google";
import "./globals.css";

const display = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
  axes: ["SOFT", "WONK", "opsz"],
});

const body = Source_Serif_4({
  variable: "--font-body",
  subsets: ["latin"],
});

const mono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "CalorieBot | Nutrição pelo WhatsApp",
  description:
    "Registre refeições pelo WhatsApp e acompanhe calorias, histórico e receitas no painel.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="pt-BR"
      className={`${display.variable} ${body.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
```

- [ ] **Step 3: Update font mappings in globals**

In `src/app/globals.css`, change the `@theme inline` font lines to:

```css
  --font-sans: var(--font-body);
  --font-mono: var(--font-mono);
  --font-heading: var(--font-display);
```

Expected: Tailwind `font-sans`, `font-mono`, and `font-heading` resolve to the variables declared in `layout.tsx`.

- [ ] **Step 4: Replace light theme tokens**

In `src/app/globals.css`, replace the entire `:root { ... }` block with:

```css
:root {
  --radius: 0.85rem;
  --background: oklch(0.965 0.025 86);
  --foreground: oklch(0.22 0.055 151);
  --card: oklch(0.985 0.018 88);
  --card-foreground: oklch(0.22 0.055 151);
  --popover: oklch(0.985 0.018 88);
  --popover-foreground: oklch(0.22 0.055 151);
  --primary: oklch(0.32 0.095 151);
  --primary-foreground: oklch(0.97 0.023 88);
  --secondary: oklch(0.64 0.16 38);
  --secondary-foreground: oklch(0.985 0.018 88);
  --muted: oklch(0.91 0.035 92);
  --muted-foreground: oklch(0.46 0.045 128);
  --accent: oklch(0.9 0.055 118);
  --accent-foreground: oklch(0.25 0.07 151);
  --destructive: oklch(0.56 0.18 31);
  --border: oklch(0.82 0.04 91);
  --input: oklch(0.82 0.04 91);
  --ring: oklch(0.64 0.16 38);
  --chart-1: oklch(0.35 0.1 151);
  --chart-2: oklch(0.64 0.16 38);
  --chart-3: oklch(0.54 0.09 112);
  --chart-4: oklch(0.48 0.075 196);
  --chart-5: oklch(0.72 0.12 78);
  --sidebar: oklch(0.955 0.026 86);
  --sidebar-foreground: oklch(0.22 0.055 151);
  --sidebar-primary: oklch(0.32 0.095 151);
  --sidebar-primary-foreground: oklch(0.97 0.023 88);
  --sidebar-accent: oklch(0.9 0.055 118);
  --sidebar-accent-foreground: oklch(0.25 0.07 151);
  --sidebar-border: oklch(0.82 0.04 91);
  --sidebar-ring: oklch(0.64 0.16 38);
  --paper: oklch(0.985 0.018 88);
  --paper-deep: oklch(0.91 0.035 92);
  --ink-green: oklch(0.22 0.055 151);
  --tomato: oklch(0.64 0.16 38);
  --whatsapp: oklch(0.68 0.16 150);
}
```

- [ ] **Step 5: Replace dark theme tokens**

In `src/app/globals.css`, replace the entire `.dark { ... }` block with:

```css
.dark {
  --background: oklch(0.18 0.04 151);
  --foreground: oklch(0.94 0.028 88);
  --card: oklch(0.22 0.045 151);
  --card-foreground: oklch(0.94 0.028 88);
  --popover: oklch(0.22 0.045 151);
  --popover-foreground: oklch(0.94 0.028 88);
  --primary: oklch(0.78 0.11 125);
  --primary-foreground: oklch(0.18 0.04 151);
  --secondary: oklch(0.68 0.15 38);
  --secondary-foreground: oklch(0.17 0.04 151);
  --muted: oklch(0.28 0.035 151);
  --muted-foreground: oklch(0.75 0.035 95);
  --accent: oklch(0.31 0.05 138);
  --accent-foreground: oklch(0.94 0.028 88);
  --destructive: oklch(0.62 0.18 31);
  --border: oklch(1 0 0 / 14%);
  --input: oklch(1 0 0 / 18%);
  --ring: oklch(0.68 0.15 38);
  --chart-1: oklch(0.78 0.11 125);
  --chart-2: oklch(0.68 0.15 38);
  --chart-3: oklch(0.72 0.1 84);
  --chart-4: oklch(0.65 0.085 196);
  --chart-5: oklch(0.76 0.13 62);
  --sidebar: oklch(0.22 0.045 151);
  --sidebar-foreground: oklch(0.94 0.028 88);
  --sidebar-primary: oklch(0.78 0.11 125);
  --sidebar-primary-foreground: oklch(0.18 0.04 151);
  --sidebar-accent: oklch(0.31 0.05 138);
  --sidebar-accent-foreground: oklch(0.94 0.028 88);
  --sidebar-border: oklch(1 0 0 / 14%);
  --sidebar-ring: oklch(0.68 0.15 38);
  --paper: oklch(0.24 0.045 151);
  --paper-deep: oklch(0.28 0.035 151);
  --ink-green: oklch(0.94 0.028 88);
  --tomato: oklch(0.68 0.15 38);
  --whatsapp: oklch(0.72 0.14 150);
}
```

- [ ] **Step 6: Add base page polish**

In `src/app/globals.css`, after the existing `@layer base { ... }` block or inside it if it already contains body styles, ensure these rules exist:

```css
@layer base {
  * {
    @apply border-border outline-ring/50;
  }

  html {
    scroll-behavior: smooth;
  }

  body {
    @apply bg-background text-foreground;
    background-image:
      radial-gradient(circle at 8% 8%, color-mix(in oklch, var(--accent) 42%, transparent) 0 22rem, transparent 38rem),
      radial-gradient(circle at 92% 4%, color-mix(in oklch, var(--secondary) 18%, transparent) 0 18rem, transparent 32rem),
      linear-gradient(135deg, color-mix(in oklch, var(--background) 94%, white), var(--background));
    font-feature-settings: "kern", "liga", "calt";
    text-rendering: optimizeLegibility;
  }

  ::selection {
    background: color-mix(in oklch, var(--secondary) 30%, transparent);
    color: var(--foreground);
  }
}
```

If the existing base block already contains `*` and `body`, merge the new properties into the existing selectors instead of duplicating selectors.

- [ ] **Step 7: Run lint for global foundation**

Run:

```bash
npm run lint
```

Expected: PASS. If it fails because `Fraunces` axes are not supported by `next/font/google`, remove the `axes` property and rerun.

- [ ] **Step 8: Commit global foundation**

Run:

```bash
git add src/app/layout.tsx src/app/globals.css
git commit -m "style: update editorial brand foundation"
```

Expected: new commit with only `layout.tsx` and `globals.css`.

---

## Task 2: Editorial landing/login page

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Preserve current OTP logic**

Before editing, confirm `src/app/page.tsx` still has these functions and state values:

```tsx
const [phone, setPhone] = useState("")
const [code, setCode] = useState("")
const [step, setStep] = useState<"phone" | "code">("phone")
const [loading, setLoading] = useState(false)
const [error, setError] = useState("")

function handlePhoneChange(value: string): string {
  return value.replace(/\D/g, "").slice(0, 11)
}

function displayPhone(digits: string): string {
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
```

Expected: these remain functionally unchanged after the task.

- [ ] **Step 2: Replace only the returned JSX**

In `src/app/page.tsx`, keep imports, state, and handlers. Replace the `return (...)` block with:

```tsx
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
```

- [ ] **Step 3: Run lint for landing page**

Run:

```bash
npm run lint
```

Expected: PASS. If ESLint flags the inline array mapping as needing a more specific tuple type, introduce this constant above `return`:

```tsx
const valueCards: Array<[string, string, string]> = [
  ["01", "Registre pelo WhatsApp", "almocei arroz, feijão e frango"],
  ["02", "Revise o dia", "calorias, refeições e histórico"],
  ["03", "Reutilize receitas", "pratos caseiros com mais precisão"],
]
```

Then map over `valueCards` instead of the inline array.

- [ ] **Step 4: Commit landing page**

Run:

```bash
git add src/app/page.tsx
git commit -m "feat: redesign landing login experience"
```

Expected: one commit containing only `src/app/page.tsx`.

---

## Task 3: Authenticated shell and route protection

**Files:**
- Modify: `src/app/(auth)/layout.tsx`
- Modify: `src/middleware.ts`

- [ ] **Step 1: Update nav links and active route helper**

In `src/app/(auth)/layout.tsx`, replace `navLinks` with:

```tsx
const navLinks = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/recipes", label: "Receitas" },
  { href: "/history", label: "Histórico" },
  { href: "/settings", label: "Configurações" },
]

function isActivePath(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`)
}
```

- [ ] **Step 2: Replace authenticated layout JSX**

In `src/app/(auth)/layout.tsx`, keep imports, `handleLogout`, and state. Replace the `return (...)` block with:

```tsx
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-50 border-b border-border/80 bg-background/85 shadow-sm backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
          <Link href="/dashboard" className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-full border border-primary/20 bg-card text-primary shadow-sm">
              <span className="h-2.5 w-2.5 rounded-full bg-secondary" />
            </span>
            <span className="font-heading text-xl font-semibold tracking-tight text-primary">
              CalorieBot
            </span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {navLinks.map((link) => {
              const active = isActivePath(pathname, link.href)
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={cn(
                    "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
                    active
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  {link.label}
                </Link>
              )
            })}
          </nav>

          <div className="hidden items-center gap-3 md:flex">
            <span className="rounded-full border border-border bg-card/70 px-3 py-1 text-xs text-muted-foreground">
              Painel do WhatsApp
            </span>
            <button
              onClick={handleLogout}
              className="rounded-full px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              Sair
            </button>
          </div>

          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
            aria-label="Abrir menu"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              {menuOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>
        </div>

        {menuOpen && (
          <div className="border-t border-border bg-background/95 px-4 py-3 backdrop-blur md:hidden">
            <nav className="mx-auto flex max-w-6xl flex-col gap-1">
              {navLinks.map((link) => {
                const active = isActivePath(pathname, link.href)
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => setMenuOpen(false)}
                    className={cn(
                      "rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                      active
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                  >
                    {link.label}
                  </Link>
                )
              })}
              <button
                onClick={handleLogout}
                className="rounded-lg px-3 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                Sair
              </button>
            </nav>
          </div>
        )}
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        {children}
      </main>
    </div>
  )
```

- [ ] **Step 3: Protect recipes in middleware**

In `src/middleware.ts`, replace:

```ts
// Protected routes: /dashboard, /settings, /history
const protectedPaths = ['/dashboard', '/settings', '/history']
```

with:

```ts
// Protected routes: /dashboard, /settings, /history, /recipes
const protectedPaths = ['/dashboard', '/settings', '/history', '/recipes']
```

- [ ] **Step 4: Run lint for shell**

Run:

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 5: Commit shell and middleware**

Run:

```bash
git add "src/app/(auth)/layout.tsx" src/middleware.ts
git commit -m "feat: expose recipes in authenticated navigation"
```

Expected: one commit with shell and middleware only.

---

## Task 4: Dashboard editorial polish

**Files:**
- Modify: `src/app/(auth)/dashboard/page.tsx`
- Modify: `src/components/dashboard/CalorieProgress.tsx`
- Modify: `src/components/dashboard/MealBreakdown.tsx`
- Modify: `src/components/dashboard/RecentMeals.tsx`
- Modify: `src/components/dashboard/WeeklyChart.tsx`

- [ ] **Step 1: Update dashboard page heading and card framing**

In `src/app/(auth)/dashboard/page.tsx`, replace the JSX from `return (` through the closing `</div>` with:

```tsx
  return (
    <div className="space-y-6">
      <div className="rounded-[2rem] border border-border bg-card/75 p-6 shadow-sm backdrop-blur sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-secondary">
          Painel do dia
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="font-heading text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
              Olá, {firstName}.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
              O registro acontece no WhatsApp. Este painel é o retrovisor do seu dia:
              calorias, refeições recentes e tendências em um só lugar.
            </p>
          </div>
          <p className="text-sm capitalize text-muted-foreground">
            {new Date().toLocaleDateString("pt-BR", {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </p>
        </div>
      </div>

      <Card className="overflow-hidden bg-card/85">
        <CardHeader>
          <CardTitle className="font-heading text-2xl font-semibold">Progresso de hoje</CardTitle>
        </CardHeader>
        <CardContent>
          <CalorieProgress consumed={todayCalories} target={target} />
        </CardContent>
      </Card>

      <Card className="bg-card/85">
        <CardHeader>
          <CardTitle className="font-heading text-2xl font-semibold">Refeições de hoje</CardTitle>
        </CardHeader>
        <CardContent>
          <MealBreakdown meals={todayMeals} />
        </CardContent>
      </Card>

      <Card className="bg-card/85">
        <CardHeader>
          <CardTitle className="font-heading text-2xl font-semibold">Histórico de calorias</CardTitle>
        </CardHeader>
        <CardContent>
          <WeeklyChart data={weeklyData} target={target} />
        </CardContent>
      </Card>

      <Card className="bg-card/85">
        <CardHeader>
          <CardTitle className="font-heading text-2xl font-semibold">Últimas refeições</CardTitle>
        </CardHeader>
        <CardContent>
          <RecentMeals meals={recentMeals} />
        </CardContent>
      </Card>
    </div>
  )
```

Do not change the data fetching above the return.

- [ ] **Step 2: Update calorie progress status copy**

In `src/components/dashboard/CalorieProgress.tsx`, replace the status message block:

```tsx
      <p className={cn("text-sm text-center font-medium", colorClass)}>
        {displayPercentage > 100
          ? "⚠️ Meta diária excedida!"
          : displayPercentage >= 80
            ? "⚡ Quase atingindo a meta"
            : displayPercentage >= 50
              ? "👍 No caminho certo"
              : "🌱 Começando o dia"}
      </p>
```

with:

```tsx
      <p className={cn("rounded-full bg-muted px-4 py-2 text-center text-sm font-medium", colorClass)}>
        {displayPercentage > 100
          ? "Meta diária ultrapassada"
          : displayPercentage >= 80
            ? "Perto da meta diária"
            : displayPercentage >= 50
              ? "Ritmo consistente"
              : "Primeiros registros do dia"}
      </p>
```

- [ ] **Step 3: Refine meal breakdown cards**

In `src/components/dashboard/MealBreakdown.tsx`, replace the `Card` className and content block with:

```tsx
          <Card
            key={config.key}
            className={cn(
              "border transition-colors",
              hasData
                ? "border-primary/25 bg-accent/60 shadow-sm"
                : "border-border bg-card/70"
            )}
          >
            <CardContent className="flex flex-col items-center gap-2 p-4 text-center">
              <span className="text-xl" aria-hidden="true">{config.icon}</span>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground leading-tight">
                {config.label}
              </p>
              {hasData ? (
                <p className="font-heading text-2xl font-semibold text-primary">
                  {calories.toLocaleString("pt-BR")}
                  <span className="ml-1 font-sans text-xs font-normal text-muted-foreground">kcal</span>
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">Aguardando registro</p>
              )}
            </CardContent>
          </Card>
```

Expected: meal aliases and aggregation stay unchanged.

- [ ] **Step 4: Improve recent meals empty state and rows**

In `src/components/dashboard/RecentMeals.tsx`, replace the empty state:

```tsx
      <div className="py-8 text-center text-muted-foreground text-sm">
        Nenhuma refeição registrada recentemente.
      </div>
```

with:

```tsx
      <div className="rounded-2xl border border-dashed border-border bg-muted/40 px-4 py-8 text-center">
        <p className="font-medium text-foreground">Nenhuma refeição recente ainda.</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Quando você registrar pelo WhatsApp, seus últimos registros aparecem aqui.
          Exemplo: “jantar: omelete com salada”.
        </p>
      </div>
```

Then replace the `<ul>` opening and `<li>` classNames with:

```tsx
    <ul className="divide-y divide-border/70">
      {meals.map((meal) => (
        <li key={meal.id} className="flex items-center justify-between gap-3 py-3">
```

- [ ] **Step 5: Fix Recharts OKLCH color usage**

In `src/components/dashboard/WeeklyChart.tsx`, replace every inline color string wrapped in `hsl(var(...))`:

```tsx
backgroundColor: "hsl(var(--card))",
border: "1px solid hsl(var(--border))",
color: "hsl(var(--foreground))",
stroke="hsl(var(--primary))"
stroke="hsl(var(--secondary))"
fill="hsl(var(--primary))"
```

with direct variables:

```tsx
backgroundColor: "var(--card)",
border: "1px solid var(--border)",
color: "var(--foreground)",
stroke="var(--primary)"
stroke="var(--secondary)"
fill="var(--primary)"
```

Expected: no `hsl(var(` remains in `WeeklyChart.tsx`.

- [ ] **Step 6: Run lint for dashboard**

Run:

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 7: Commit dashboard polish**

Run:

```bash
git add "src/app/(auth)/dashboard/page.tsx" src/components/dashboard/CalorieProgress.tsx src/components/dashboard/MealBreakdown.tsx src/components/dashboard/RecentMeals.tsx src/components/dashboard/WeeklyChart.tsx
git commit -m "style: polish dashboard editorial experience"
```

Expected: one commit with dashboard-only changes.

---

## Task 5: History, settings, and recipes polish

**Files:**
- Modify: `src/app/(auth)/history/page.tsx`
- Modify: `src/app/(auth)/settings/page.tsx`
- Modify: `src/app/(auth)/recipes/page.tsx`
- Modify: `src/components/history/MealList.tsx`
- Modify: `src/components/recipes/RecipeList.tsx`

- [ ] **Step 1: Polish history page heading and date card**

In `src/app/(auth)/history/page.tsx`, replace the top heading block:

```tsx
      <div>
        <h1 className="text-2xl font-bold text-foreground">Histórico</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Consulte e gerencie suas refeições anteriores
        </p>
      </div>
```

with:

```tsx
      <div className="rounded-[2rem] border border-border bg-card/75 p-6 shadow-sm backdrop-blur sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-secondary">
          Linha do tempo
        </p>
        <h1 className="mt-4 font-heading text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
          Histórico
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
          Revise os registros que chegaram pelo WhatsApp e confira os detalhes de cada refeição.
        </p>
      </div>
```

Replace the date selector `Card` opening and title:

```tsx
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Selecionar data</CardTitle>
```

with:

```tsx
      <Card className="bg-card/85">
        <CardHeader>
          <CardTitle className="font-heading text-2xl font-semibold">Selecionar data</CardTitle>
```

Replace the input className:

```tsx
className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
```

with:

```tsx
className="flex h-10 w-full rounded-lg border border-input bg-background/70 px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
```

Replace the button className:

```tsx
className="inline-flex items-center justify-center h-10 px-4 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
```

with:

```tsx
className="inline-flex h-10 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
```

- [ ] **Step 2: Improve history empty state**

In `src/components/history/MealList.tsx`, replace the empty state:

```tsx
      <div className="py-12 text-center text-muted-foreground text-sm">
        Nenhuma refeição registrada nesta data.
      </div>
```

with:

```tsx
      <div className="rounded-2xl border border-dashed border-border bg-muted/40 px-4 py-10 text-center">
        <p className="font-medium text-foreground">Nenhuma refeição nesta data.</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Quando você registrar uma refeição pelo WhatsApp, ela aparece no histórico do dia correspondente.
        </p>
      </div>
```

- [ ] **Step 3: Polish settings page heading and card titles**

In `src/app/(auth)/settings/page.tsx`, replace the top heading block:

```tsx
      <div>
        <h1 className="text-2xl font-bold text-foreground">Configurações</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Gerencie seu perfil e preferências do bot
        </p>
      </div>
```

with:

```tsx
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
```

In the profile card, replace:

```tsx
<CardTitle>Dados pessoais</CardTitle>
```

with:

```tsx
<CardTitle className="font-heading text-2xl font-semibold">Dados pessoais</CardTitle>
```

In the bot settings card, replace:

```tsx
<CardTitle>Preferências do bot</CardTitle>
```

with:

```tsx
<CardTitle className="font-heading text-2xl font-semibold">Preferências do bot</CardTitle>
```

In the danger-zone card, replace:

```tsx
<Card className="border-destructive">
```

with:

```tsx
<Card className="border-destructive/60 bg-card/85">
```

- [ ] **Step 4: Polish recipes page heading**

In `src/app/(auth)/recipes/page.tsx`, replace the heading block inside the top flex container:

```tsx
        <div>
          <h1 className="text-2xl font-bold text-foreground">Minhas receitas</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Receitas salvas para registrar refeições com rendimento e macros.
          </p>
        </div>
```

with:

```tsx
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-secondary">
            Pratos recorrentes
          </p>
          <h1 className="mt-3 font-heading text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            Minhas receitas
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
            Cadastre receitas caseiras uma vez e registre porções depois com calorias e macros mais consistentes.
          </p>
        </div>
```

Replace the page wrapper opening:

```tsx
    <div className="space-y-6">
```

with:

```tsx
    <div className="space-y-6">
```

No visual change is needed for the wrapper; this step exists to confirm the page remains scoped.

- [ ] **Step 5: Improve recipes empty state**

In `src/components/recipes/RecipeList.tsx`, replace the empty-state card content:

```tsx
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">
            Você ainda não cadastrou nenhuma receita.
          </p>
          <Button className="mt-4" render={<Link href="/recipes/new" />}>
            <Plus data-icon="inline-start" />
            Criar primeira receita
          </Button>
        </CardContent>
      </Card>
```

with:

```tsx
      <Card className="border-dashed bg-card/85">
        <CardContent className="px-6 py-10 text-center">
          <p className="font-heading text-2xl font-semibold text-foreground">
            Salve uma receita que você repete.
          </p>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
            Pratos caseiros ficam mais fáceis de registrar quando rendimento, porção e macros já estão calculados.
          </p>
          <Button className="mt-5" render={<Link href="/recipes/new" />}>
            <Plus data-icon="inline-start" />
            Criar primeira receita
          </Button>
        </CardContent>
      </Card>
```

- [ ] **Step 6: Run lint for secondary pages**

Run:

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 7: Commit secondary page polish**

Run:

```bash
git add "src/app/(auth)/history/page.tsx" "src/app/(auth)/settings/page.tsx" "src/app/(auth)/recipes/page.tsx" src/components/history/MealList.tsx src/components/recipes/RecipeList.tsx
git commit -m "style: align authenticated pages with editorial design"
```

Expected: one commit with secondary authenticated page changes.

---

## Task 6: Final verification and cleanup

**Files:**
- Inspect: all modified files

- [ ] **Step 1: Check for accidental untracked generated files**

Run:

```bash
git status --short
```

Expected: no modified tracked files. Untracked `.openclaude-profile.json` or `.superpowers/brainstorm/...` may exist from tooling; do not add them.

- [ ] **Step 2: Check Recharts color fix**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
p = Path('src/components/dashboard/WeeklyChart.tsx')
text = p.read_text()
assert 'hsl(var(' not in text, 'WeeklyChart still wraps CSS variables in hsl()'
print('WeeklyChart color tokens OK')
PY
```

Expected output:

```text
WeeklyChart color tokens OK
```

- [ ] **Step 3: Run lint**

Run:

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 4: Run unit/integration tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Run production build**

Run:

```bash
npm run build
```

Expected: PASS. If the build fails because a Google font option is unsupported, adjust only `src/app/layout.tsx` font configuration and rerun lint/build.

- [ ] **Step 6: Manual QA checklist**

Start the dev server:

```bash
npm run dev
```

Open `http://localhost:3000` and verify:

- `/` shows editorial hero and login card on desktop.
- `/` stacks cleanly on mobile width.
- Phone input accepts only digits and max 11 digits.
- Code input accepts only digits and max 6 digits.
- OTP errors render with `role="alert"`.
- Authenticated nav contains Dashboard, Receitas, Histórico, Configurações.
- `/recipes`, `/recipes/new`, and `/recipes/example-id` redirect to `/` when no `caloriebot-user-id` cookie exists.
- Dashboard headings and empty states use WhatsApp-first copy.
- Chart line, tooltip, reference line, and dots render in the new palette.

Stop the dev server after QA.

- [ ] **Step 7: Run final git status**

Run:

```bash
git status --short
```

Expected: clean tracked state. If only `.openclaude-profile.json` or `.superpowers/brainstorm/...` are untracked, leave them uncommitted.

- [ ] **Step 8: Verification agent gate**

Because this implementation touches more than 3 files and includes route/middleware changes, dispatch the `verification` agent with:

```text
Original request: improve the CalorieBot frontend using the approved editorial premium redesign spec.
Spec: docs/superpowers/specs/2026-04-27-frontend-redesign-design.md
Plan: docs/superpowers/plans/2026-04-27-frontend-redesign.md
Files changed: list all modified files from git diff/log.
Approach: global brand tokens/fonts, redesigned landing/login preserving OTP, authenticated nav with Recipes, protected /recipes, dashboard/history/settings/recipes polish, Recharts OKLCH color fix.
```

Expected: verifier returns PASS or PARTIAL. If FAIL, fix the reported issue and rerun this step.

---

## Self-review

- Spec coverage: all spec objectives map to Tasks 1–6. WhatsApp-first home is Task 2; global metadata/fonts/tokens Task 1; Recipes navigation/protection Task 3; authenticated app polish Tasks 4–5; Recharts OKLCH fix Task 4; verification Task 6.
- Placeholder scan: no TBD/TODO/fill-later instructions are present.
- Type consistency: no new exported types or props are introduced; all tasks reuse existing component props and endpoint contracts.
