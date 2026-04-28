# Frontend redesign editorial premium

## Contexto

O frontend do CalorieBot já cobre o painel autenticado, configurações, histórico e receitas, mas a apresentação ainda não comunica com força o diferencial do produto: registrar refeições pelo WhatsApp e revisar tudo no painel web. A home atual funciona mais como login do que como porta de entrada do produto, o metadata ainda é padrão do Next.js, e Receitas existe mas não aparece na navegação principal.

A direção aprovada é **Produto editorial completo** com estética **Editorial premium**: fundo creme/papel, verde profundo, acento tomate, composição assimétrica, tipografia marcante e sensação de “concierge nutricional no WhatsApp”.

## Objetivos

- Fazer o usuário entender rapidamente que o CalorieBot é WhatsApp-first.
- Tornar a home/login memorável e mais premium sem alterar o fluxo OTP.
- Aplicar coesão visual ao app autenticado inteiro.
- Expor Receitas como recurso principal do produto.
- Melhorar empty states para ensinar o comportamento esperado.
- Corrigir o uso de cores do Recharts com tokens OKLCH.

## Não objetivos

- Não alterar backend, banco, endpoints ou contratos de autenticação.
- Não adicionar deep link para WhatsApp sem número canônico configurado.
- Não criar nova biblioteca de animação.
- Não redesenhar por completo o wizard de receitas.
- Não implementar realtime nem novas consultas.

## Direção visual

O produto deve parecer um painel editorial de saúde e comida, não um dashboard SaaS genérico.

- **Base:** creme/papel quente.
- **Cor principal:** verde profundo culinário.
- **Acento:** tomate, usado com moderação para selos, detalhes e CTAs.
- **Apoio:** sage/oliva claro para superfícies secundárias.
- **Tipografia:** display expressiva para headings e uma fonte refinada para texto; mono apenas para detalhes técnicos.
- **Identidade:** reduzir emoji como marca principal. Emojis podem continuar como detalhes secundários quando ajudam a compreensão.
- **Composição:** hero assimétrico na home; cards autenticados com hierarquia mais editorial e menos aparência de template.

## Arquitetura e componentes

### Layout raiz e tokens

Arquivos:

- `src/app/layout.tsx`
- `src/app/globals.css`

Mudanças:

- Trocar `metadata` para título e descrição do CalorieBot.
- Alterar `lang="en"` para `lang="pt-BR"`.
- Configurar fontes via `next/font/google` com variáveis consistentes para `--font-sans`, `--font-heading` e `--font-mono`.
- Atualizar tokens globais mantendo o contrato shadcn/Tailwind v4 existente: `--background`, `--foreground`, `--card`, `--primary`, `--secondary`, `--accent`, `--muted`, `--border`, `--ring`, `--chart-*` e equivalentes.
- Adicionar polimento de base, como seleção de texto e fundo com textura/gradientes sutis, desde que não prejudique legibilidade.

### Home/login

Arquivo:

- `src/app/page.tsx`

Mudanças:

- Preservar toda a lógica de OTP atual:
  - `phone`, `code`, `step`, `loading`, `error`.
  - `handlePhoneChange`, `displayPhone`, `toE164`.
  - POST para `/api/auth/otp/send` e `/api/auth/otp/verify`.
  - Redirect para `/dashboard` após sucesso.
- Substituir o card central por hero editorial em duas colunas.
- Comunicar: “registre pelo WhatsApp, acompanhe no painel”.
- Incluir mock visual de conversa com exemplo realista de refeição e resposta do bot.
- Incluir cards curtos de valor: WhatsApp, progresso, receitas recorrentes.
- Renomear o bloco de login para “Entrar pelo WhatsApp”.
- Exibir erros com semântica acessível, usando `role="alert"` ou `aria-live`.

### Navegação autenticada e proteção de rotas

Arquivos:

- `src/app/(auth)/layout.tsx`
- `src/middleware.ts`

Mudanças:

- Adicionar `Receitas` à navegação desktop e mobile.
- Fazer rotas aninhadas de receitas manterem o item ativo:
  - `/recipes`
  - `/recipes/new`
  - `/recipes/[id]`
- Polir header autenticado com fundo creme translúcido, wordmark tipográfica e active state editorial.
- Adicionar `/recipes` à lista de caminhos protegidos no middleware.

### App autenticado

Arquivos principais:

- `src/app/(auth)/dashboard/page.tsx`
- `src/app/(auth)/history/page.tsx`
- `src/app/(auth)/settings/page.tsx`
- `src/app/(auth)/recipes/page.tsx`
- `src/components/dashboard/CalorieProgress.tsx`
- `src/components/dashboard/MealBreakdown.tsx`
- `src/components/dashboard/RecentMeals.tsx`
- `src/components/dashboard/WeeklyChart.tsx`
- `src/components/history/MealList.tsx`
- `src/components/recipes/RecipeList.tsx`

Mudanças:

- Aplicar hierarquia consistente: título editorial, subtítulo orientado a produto e cards com tom papel/verde/tomate.
- No dashboard, reforçar que o painel é o “retrovisor” do que acontece no WhatsApp.
- Transformar empty states em orientação prática:
  - Sem refeições: sugerir exemplo de mensagem para enviar no WhatsApp.
  - Sem refeições recentes: explicar que registros do WhatsApp aparecerão ali.
  - Sem receitas: incentivar cadastrar pratos caseiros recorrentes.
- Reduzir dependência de emojis como elementos primários.
- Corrigir `WeeklyChart.tsx` para usar `var(--primary)`, `var(--secondary)`, `var(--card)` e `var(--border)` diretamente, sem `hsl(var(...))`, porque os tokens são OKLCH.
- Não alterar queries, mutations, props ou contratos dos componentes.

## Fluxo e estados

### Login OTP

O fluxo de autenticação não muda. O redesign só altera apresentação, copy e acessibilidade visual. As validações atuais de telefone e código devem continuar funcionando.

### Rotas protegidas

`/recipes` passa a ser protegida no middleware junto de `/dashboard`, `/settings` e `/history`. Isso alinha a navegação com a existência das páginas de receita e evita inconsistência de proteção.

### Erros e empty states

Erros devem ser visíveis, acessíveis e manter mensagens claras. Empty states devem orientar o próximo passo, sem criar novas ações que dependam de backend não existente.

## Critérios de sucesso

- Em até 10 segundos, a home deixa claro que o CalorieBot registra refeições pelo WhatsApp e usa o web app para revisar progresso.
- O app autenticado parece parte do mesmo produto visual da home.
- Receitas aparece claramente na navegação.
- Rotas `/recipes*` ficam protegidas para usuários sem cookie.
- O chart renderiza com as cores novas sem tokens CSS inválidos.
- O fluxo OTP continua igual funcionalmente.

## Verificação

Executar:

```bash
npm run lint
npm run build
npm test
```

QA manual:

- Abrir `/` em mobile e desktop.
- Conferir que o input de telefone aceita apenas dígitos e limita 10–11 dígitos.
- Conferir que o input de código continua limitado a 6 dígitos.
- Conferir que erros aparecem visualmente e com semântica acessível.
- Conferir navegação autenticada com Dashboard, Receitas, Histórico e Configurações.
- Conferir active state em `/recipes`, `/recipes/new` e rota de detalhe.
- Conferir que `/recipes`, `/recipes/new` e rotas aninhadas redirecionam para `/` sem cookie.
- Conferir dashboard sem refeições, com refeições e com dados de chart.
- Conferir contraste de botões, links, texto muted e acento tomate.
