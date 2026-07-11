# Correção das mudanças antigas — plano de implementação

> **Para a execução:** usar `superpowers:test-driven-development` em cada mudança de comportamento e `superpowers:verification-before-completion` antes de publicar. A PR alvo é a #20; não fazer merge.

**Objetivo:** tornar seguro o conjunto de mudanças locais anterior à auditoria, sem implementar ainda a arquitetura completa de idempotência, preservando repetição legítima de alimentos, alvo exato de correções e baixo uso de LLM.

**Arquitetura:** o patch remove deduplicação por conteúdo, limita a análise de append à mensagem atual, ancora correções contextuais no `mealId` já resolvido e restringe verbos de adição ao contexto de refeição recente ou resposta citada. A idempotência forte por identidade de operação permanece documentada como trabalho futuro.

**Stack:** TypeScript, Vitest, Zod, PostgreSQL via cliente Supabase, OpenRouter/Ollama por abstração LLM.

## Restrições globais

- Trabalhar somente em `fix/fase0-perimetro`, que alimenta a PR #20.
- Preservar os commits já publicados; não reescrever histórico nem usar force-push.
- Não fazer merge: `main` dispara produção.
- Não criar migration nem implementar `operation_id`/outbox nesta fase.
- Nunca considerar dois consumos duplicados apenas porque alimento e gramas são iguais.
- Em append, enviar à análise apenas a instrução atual; não enviar histórico bruto.
- Uma correção contextual deve atuar no `mealId` que o gatekeeper já resolveu.
- Fora de contexto recente/citação, verbos como “adicionar” não devem editar automaticamente a última refeição.
- Alterar testes primeiro, confirmar que falham pelo motivo esperado, e só então mudar produção.

## Tarefa 1: preservar repetições legítimas no registro

**Arquivos:**

- Modificar: `tests/unit/bot/log-food-to-meal.test.ts`
- Modificar: `tests/unit/bot/meal-log-consolidation.test.ts`
- Modificar: `src/lib/bot/flows/meal-log.ts`
- Modificar: `src/lib/utils/formatters.ts`

### Passo 1: escrever regressões que expressem o contrato correto

- Substituir os testes que esperam supressão por alimento + gramas por casos em que uma segunda banana idêntica é inserida.
- Exigir recálculo dos totais após o segundo consumo.
- Exigir que o recibo liste somente os itens efetivamente persistidos.
- Remover a expectativa da resposta “já está registrado” baseada apenas em igualdade de conteúdo.

### Passo 2: executar os testes e confirmar RED

```bash
npm test -- tests/unit/bot/log-food-to-meal.test.ts tests/unit/bot/meal-log-consolidation.test.ts
```

Falha esperada: o filtro semântico ainda remove o segundo consumo ou retorna recibo incorreto.

### Passo 3: remover a deduplicação semântica

- Excluir `mealItemDedupeKey` e `filterDuplicateMealItems`.
- Em `logFoodToMeal`, inserir todos os itens analisados válidos, também quando a refeição já existe.
- Recalcular totais sempre que houver inserção.
- Contabilizar uso TACO somente para itens efetivamente inseridos.
- Remover a branch de resposta “Esses itens já estão registrados...”.
- Retirar o export/import de `translateMealType` se ele ficar sem consumidor.

### Passo 4: executar os testes e confirmar GREEN

Executar o mesmo comando do Passo 2 e conferir saída sem falhas.

## Tarefa 2: analisar append apenas pela instrução atual

**Arquivos:**

- Modificar: `tests/unit/bot/append-items-routing.test.ts`
- Modificar: `tests/unit/bot/meal-log-consolidation.test.ts`
- Modificar: `src/lib/bot/flows/meal-log.ts`
- Modificar: `src/lib/llm/prompts/analyze.ts`

### Passo 1: escrever regressões de isolamento e roteamento

- Exigir que `appendItemsToMeal` chame `llm.analyzeMeal(message, [], currentTime)`.
- Cobrir que “mais uma banana” pode inserir outra banana de mesma quantidade.
- Exigir que o append tenha um único destino: o `mealId` resolvido.
- Exigir que tipo explicitamente diferente seja rejeitado por esse seam e retorne ao roteamento normal, sem escrita parcial em vários destinos.
- Exigir que `addedItems` e `newTotal` pertençam ao mesmo destino persistido.

### Passo 2: executar os testes e confirmar RED

```bash
npm test -- tests/unit/bot/append-items-routing.test.ts tests/unit/bot/meal-log-consolidation.test.ts
```

Falha esperada: o histórico ainda é enviado, ou a resposta usa a lista analisada em vez dos resultados persistidos.

### Passo 3: simplificar o append

- Remover a leitura de histórico de `appendItemsToMeal`.
- Analisar somente `message` com histórico vazio.
- Acrescentar todos os itens ao único alvo autorizado, sem filtro por conteúdo e sem confiar em tipo inferido pela LLM para dividir a escrita.
- Se a mensagem nomear um tipo diferente do alvo, não persistir no append; o handler deve liberar o contexto e processar a mensagem original pelo roteamento normal.
- Ajustar o exemplo contraditório de `analyze.ts` para que o tipo de refeição venha explicitamente da mensagem atual.

### Passo 4: executar os testes e confirmar GREEN

Executar o mesmo comando do Passo 2.

## Tarefa 3: ancorar correções na refeição exata

**Arquivos:**

- Modificar: `src/lib/bot/flows/edit.ts`
- Modificar: `src/lib/bot/handler.ts`
- Modificar: `src/lib/llm/prompts/contextual-correction.ts`
- Modificar: testes unitários existentes de `edit` e `handler`

### Passo 1: escrever regressões do alvo e da semântica de adição

- Criar caso com duas refeições recentes e exigir que a correção altere exatamente o `mealId` resolvido pelo gatekeeper.
- Cobrir que `add_item` com alimento já existente acrescenta um novo consumo, sem converter a intenção em alteração absoluta de quantidade.
- Cobrir que a classificação contextual recebe o tipo atual da refeição.
- Cobrir que baixa confiança não executa remoção, exclusão, troca ou reclassificação.
- Distinguir destino explícito (“no almoço”) de alimento/menção (“um lanche natural”) e preservar “era no almoço”/“muda pro almoço” como reclassificação.

### Passo 2: executar os testes focados e confirmar RED

```bash
npm test -- tests/unit/bot/edit.test.ts tests/unit/bot/handler.test.ts tests/unit/llm/prompts.test.ts
```

### Passo 3: criar a entrada de edição ancorada

- Extrair/exportar uma função de edição que receba `mealId` explícito e reutilize o fluxo interno de correção.
- Fazer o gatekeeper de `recent_meal` chamar essa função em vez de reiniciar a busca pela refeição mais recente.
- Antes do gatekeeper, encaminhar tipo explicitamente diferente ao roteamento normal; preservar no gatekeeper apenas pedidos explícitos de reclassificação da refeição atual.
- No caso `add_item`, sempre construir o item adicional e delegar ao append; não atualizar o item existente nem pedir uma quantidade absoluta só porque os nomes coincidem.
- Passar `context.contextData.mealType` ao prompt contextual.

### Passo 4: tornar o prompt contextual verificável

- Acrescentar o tipo da refeição atual à assinatura e ao texto do prompt.
- Determinar que apenas um tipo explicitamente diferente na mensagem atual autoriza outra refeição.
- Manter respostas estruturadas já validadas por schema.

### Passo 5: executar os testes e confirmar GREEN

Executar o comando focado ajustado no Passo 2.

## Tarefa 4: impedir edição global por palavras amplas

**Arquivos:**

- Modificar: `tests/unit/bot/router.test.ts`
- Modificar: `src/lib/bot/router.ts`
- Modificar: testes do prompt contextual, se houver

### Passo 1: escrever regressões do roteador

- Exigir que “adicionar banana” sem contexto não seja classificado deterministicamente como `edit`.
- Cobrir negação: “não adiciona banana”.
- Cobrir colisão de substring: “inclusive”.
- Manter comandos inequívocos de edição existentes, como remover, corrigir e trocar.

### Passo 2: executar e confirmar RED

```bash
npm test -- tests/unit/bot/router.test.ts tests/unit/llm/prompts.test.ts
```

### Passo 3: restringir os keywords

- Remover `adicionar`, `adiciona`, `acrescenta` e `inclui` do conjunto global de edição.
- Deixar a interpretação de continuação para o gatekeeper contextual e, sem contexto, para a classificação normal de intenção.

### Passo 4: executar e confirmar GREEN

Executar o mesmo comando do Passo 2.

## Tarefa 5: limpar ruído e manter a auditoria rastreável

**Arquivos:**

- Modificar: `package-lock.json`
- Modificar: `docs/superpowers/specs/2026-07-11-auditoria-conversacional-e-registro-alimentos.md`
- Modificar: fixtures TypeScript relacionadas, se necessário

### Passo 1: retirar mudanças acidentais

- Remover somente o `dev: true` acidental de `fsevents` no lockfile.
- Corrigir fixtures afetadas para o contrato atual de `MealItem`, sem relaxar tipos de produção.

### Passo 2: atualizar o documento

- Registrar quais correções mínimas foram efetivamente aplicadas na PR #20.
- Manter explícito que a alternativa completa de idempotência continua mapeada e não foi implementada.
- Não marcar os riscos de concorrência/replay como resolvidos.

### Passo 3: conferir higiene do diff

```bash
git diff --check
git status --short
```

## Tarefa 6: verificação, revisão e publicação na PR #20

### Passo 1: rodar testes afetados

```bash
npm test -- \
  tests/unit/bot/append-items-routing.test.ts \
  tests/unit/bot/log-food-to-meal.test.ts \
  tests/unit/bot/meal-log-consolidation.test.ts \
  tests/unit/bot/meal-log.test.ts \
  tests/unit/bot/query.test.ts \
  tests/unit/bot/router.test.ts \
  tests/unit/bot/edit.test.ts \
  tests/unit/bot/handler.test.ts \
  tests/unit/llm/prompts.test.ts \
  tests/unit/llm/contextual-correction-schema.test.ts \
  tests/unit/utils/meal-time.test.ts
```

### Passo 2: rodar as verificações completas

```bash
npm test
./node_modules/.bin/tsc --noEmit
npm run lint
npm run build
```

- Se alguma verificação falhar por defeito preexistente e não relacionado, registrar evidência exata e garantir que não houve regressão no subconjunto alterado.
- Fazer revisão final independente do diff, com atenção a perda silenciosa, alvo incorreto, recibo falso e custo extra de LLM.

### Passo 3: confirmar o escopo antes do commit

```bash
git diff --stat
git diff --check
git status --short
```

- Incluir somente os arquivos desta correção, o plano e a auditoria.
- Não incluir artefatos de build ou segredos.

### Passo 4: commit e push sem merge

```bash
git add \
  docs/superpowers/plans/2026-07-11-correcao-mudancas-antigas.md \
  docs/superpowers/specs/2026-07-11-auditoria-conversacional-e-registro-alimentos.md \
  src/lib/bot/flows/meal-log.ts \
  src/lib/bot/flows/edit.ts \
  src/lib/bot/handler.ts \
  src/lib/llm/prompts/analyze.ts \
  src/lib/llm/prompts/contextual-correction.ts \
  src/lib/llm/schemas/contextual-correction.ts \
  src/lib/utils/meal-time.ts \
  tests/unit/bot/append-items-routing.test.ts \
  tests/unit/bot/log-food-to-meal.test.ts \
  tests/unit/bot/meal-log-consolidation.test.ts \
  tests/unit/bot/meal-log.test.ts \
  tests/unit/bot/query.test.ts \
  tests/unit/bot/router.test.ts \
  tests/unit/bot/edit.test.ts \
  tests/unit/bot/handler.test.ts \
  tests/unit/llm/prompts.test.ts \
  tests/unit/llm/contextual-correction-schema.test.ts \
  tests/unit/utils/meal-time.test.ts
git diff --cached --name-status
git diff --cached --stat
git diff --cached --check
git diff --cached
git commit -m "fix(bot): tornar append e correções contextuais seguros"
git push origin fix/fase0-perimetro
```

- Antes do commit, inspecionar a lista e o patch staged completos; cada arquivo deve pertencer explicitamente ao escopo acima e não pode haver alteração inesperada, artefato de build ou segredo.
- Se a inspeção staged divergir do escopo, corrigir o stage e repetir os quatro comandos `git diff --cached` antes de continuar.

### Passo 5: verificar a PR

- Confirmar que a PR #20 aponta para o novo SHA.
- Confirmar estado dos checks e relatar qualquer pendência real.
- Não aprovar nem fazer merge automaticamente.
