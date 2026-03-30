# Onboarding Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remover a escolha entre TACO e manual do onboarding e reescrever as mensagens do fluxo com um tom mais amigável e elegante, sem alterar o comportamento nutricional interno do produto.

**Architecture:** A mudança fica concentrada no fluxo conversacional de onboarding. O passo final de seleção de modo deixa de existir, a conclusão passa a acontecer imediatamente após o objetivo, e a mensagem final continua usando o formatter existente com copy revisado; os testes unitários do onboarding passam a ser a proteção principal contra regressão de fluxo e de texto.

**Tech Stack:** Next.js/TypeScript, Vitest, Supabase query layer, utilitários locais de formatação e validação

---

## File Structure

- Modify: `src/lib/bot/flows/onboarding.ts`
  Responsável por encurtar o fluxo, remover a dependência de `validateCalorieMode`, concluir o onboarding após o objetivo e atualizar o copy das mensagens intermediárias.

- Modify: `src/lib/utils/formatters.ts`
  Responsável por revisar a mensagem de conclusão para o tom aprovado, mantendo os dados exibidos e os exemplos de uso.

- Modify: `tests/unit/bot/onboarding.test.ts`
  Responsável por refletir o novo fluxo, validar a ausência da etapa `TACO/manual`, garantir a nova finalização no passo 7 e cobrir o novo texto de onboarding.

- Check only: `src/lib/utils/validators.ts`
  Confirmar que nenhuma validação precisa mudar além da remoção do uso de `validateCalorieMode` dentro do onboarding.

Recommended supporting skills during execution:

- `@superpowers:test-driven-development`
- `@superpowers:verification-before-completion`

---

### Task 1: Atualizar os testes para o novo fluxo de onboarding

**Files:**
- Modify: `tests/unit/bot/onboarding.test.ts`
- Check only: `src/lib/bot/flows/onboarding.ts`

- [ ] **Step 1: Escrever os testes primeiro para o novo comportamento**

Atualize os cenários de onboarding para refletir:

- o passo 7 (`goal`) finaliza o onboarding
- a resposta do passo 7 contém a mensagem final, não a pergunta de modo calórico
- `createDefaultSettings`, `clearState` e `getUserWithSettings` passam a ser esperados no passo 7
- não existem mais asserts sobre `calorieMode` no onboarding
- as mensagens iniciais/intermediárias usam o novo tom aprovado

Adicionar pelo menos um teste explícito garantindo que a resposta final não menciona `TACO` nem `manual`.

- [ ] **Step 2: Rodar o arquivo de teste e confirmar a falha**

Run: `npm run test:unit -- tests/unit/bot/onboarding.test.ts`

Expected: FAIL com asserts antigos esperando a pergunta de modo calórico ou a finalização no passo 8.

- [ ] **Step 3: Commitar o avanço de teste vermelho**

```bash
git add tests/unit/bot/onboarding.test.ts
git commit -m "test: ajusta onboarding para concluir sem escolha de modo"
```

---

### Task 2: Implementar o novo fluxo em `onboarding.ts`

**Files:**
- Modify: `src/lib/bot/flows/onboarding.ts`
- Check only: `src/lib/utils/validators.ts`
- Test: `tests/unit/bot/onboarding.test.ts`

- [ ] **Step 1: Remover a dependência do modo calórico no fluxo**

Em `src/lib/bot/flows/onboarding.ts`:

- remova `validateCalorieMode` do import
- remova a constante `MSG_ASK_CALORIE_MODE`
- reescreva as mensagens de boas-vindas e perguntas intermediárias no tom aprovado

Manter:

- uma pergunta por vez
- exemplos claros para peso e altura
- opções numeradas para sexo, atividade e objetivo

- [ ] **Step 2: Fazer o passo 7 concluir o onboarding**

No bloco `if (currentStep === 7)`:

- valide `goal`
- persista `goal`
- busque o usuário com `getUserWithSettings`
- chame `calculateAll`
- persista `tmb`, `tdee`, `dailyCalorieTarget`, `maxWeightKg`, `dailyProteinG`, `dailyFatG`, `dailyCarbsG`, `onboardingComplete`
- crie as settings padrão
- limpe o estado
- retorne `{ completed: true }` com a mensagem final

O `onboardingStep` persistido deve refletir o novo fim real do fluxo, sem manter um passo artificial só para modo calórico.

- [ ] **Step 3: Eliminar o bloco antigo do passo 8**

Remova a finalização baseada em `currentStep === 8`, junto com qualquer validação e resposta associadas ao modo calórico.

- [ ] **Step 4: Rodar o teste focal e confirmar verde**

Run: `npm run test:unit -- tests/unit/bot/onboarding.test.ts`

Expected: PASS

- [ ] **Step 5: Commitar a mudança de fluxo**

```bash
git add src/lib/bot/flows/onboarding.ts tests/unit/bot/onboarding.test.ts
git commit -m "feat: simplifica fluxo de onboarding"
```

---

### Task 3: Refinar a mensagem final e verificar regressões adjacentes

**Files:**
- Modify: `src/lib/utils/formatters.ts`
- Test: `tests/unit/bot/onboarding.test.ts`
- Check only: `tests/unit/utils/formatters.test.ts`

- [ ] **Step 1: Ajustar `formatOnboardingComplete` para o novo tom**

Atualize `formatOnboardingComplete` para soar mais como assistente pessoal:

- manter confirmação de conclusão
- manter meta diária e macros
- manter convite para começar a registrar refeições
- evitar tom seco ou técnico

Não introduza texto excessivamente longo; continue otimizado para WhatsApp.

- [ ] **Step 2: Validar se existe teste dedicado do formatter**

Se `tests/unit/utils/formatters.test.ts` já cobre `formatOnboardingComplete`, atualize o teste.
Se não cobre, adicione um caso mínimo que valide:

- presença do nome
- presença da meta calórica
- presença das macros
- convite para registrar refeições

- [ ] **Step 3: Rodar os testes relacionados**

Run: `npm run test:unit -- tests/unit/bot/onboarding.test.ts tests/unit/utils/formatters.test.ts`

Expected: PASS

- [ ] **Step 4: Commitar o refinamento de copy**

```bash
git add src/lib/utils/formatters.ts tests/unit/bot/onboarding.test.ts tests/unit/utils/formatters.test.ts
git commit -m "feat: deixa onboarding mais amigavel"
```

---

### Task 4: Verificação final do fluxo completo

**Files:**
- Check only: `src/lib/bot/flows/onboarding.ts`
- Check only: `src/lib/utils/formatters.ts`
- Check only: `tests/unit/bot/onboarding.test.ts`

- [ ] **Step 1: Rodar a suíte final dos arquivos afetados**

Run: `npm run test:unit -- tests/unit/bot/onboarding.test.ts tests/unit/utils/formatters.test.ts`

Expected: PASS

- [ ] **Step 2: Fazer uma revisão rápida de texto**

Conferir manualmente no código:

- nenhuma mensagem do onboarding menciona `TACO`
- nenhuma mensagem do onboarding menciona `manual`
- a abertura, transições e conclusão seguem o tom aprovado
- o fluxo continua claro para respostas numéricas

- [ ] **Step 3: Commit final de verificação, se necessário**

Se houver ajustes finais de copy ou teste, commitá-los:

```bash
git add src/lib/bot/flows/onboarding.ts src/lib/utils/formatters.ts tests/unit/bot/onboarding.test.ts tests/unit/utils/formatters.test.ts
git commit -m "test: valida fluxo final do onboarding"
```

Se não houver mudanças novas, não criar commit extra.
