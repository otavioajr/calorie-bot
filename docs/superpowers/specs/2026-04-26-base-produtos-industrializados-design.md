# Spec: Base de Produtos Industrializados Autoalimentada

**Data:** 2026-04-26
**Status:** Aprovado

---

## Contexto

Hoje, quando um usuário registra um produto industrializado que não está na TACO (ex: "magic toast", "barra Trio", "iogurte Yopro"), o pipeline cai no fallback de estimativa via LLM (`src/lib/bot/flows/meal-log.ts:325-492`). A estimativa não é persistida — toda vez que qualquer usuário registrar o mesmo produto, gasta tokens de LLM novamente e pode dar resultados ligeiramente diferentes.

A proposta é introduzir uma **base de produtos industrializados que cresce com uso real**, alimentada por:
- **Open Food Facts (OFF)**: API pública, gratuita, com cobertura razoável de marcas brasileiras (~60-70% pra marcas grandes).
- **Cadastro manual via rótulo**: quando OFF não acha, usuário digita os macros direto do rótulo.

A base é **camada nova** entre TACO e o fallback de LLM, então não substitui nada — só preenche o vão atual e elimina chamadas repetidas de LLM pros mesmos produtos.

Escopo desta v1: **só produtos industrializados/de marca**. Receitas continuam privadas no fluxo `user_recipes` já existente. Genéricos sem marca seguem caindo no fluxo atual de LLM.

## Arquitetura

### Nova camada no pipeline de lookup

Ordem atual (`enrichItemsWithTaco` em `src/lib/bot/flows/meal-log.ts:191`):
1. User-provided macros
2. TACO base-name match
3. TACO token search
4. TACO fuzzy
5. LLM decomposition + ingredient re-match
6. LLM estimate direto (último recurso)

Nova ordem (passos 5-8 inseridos antes do LLM, **gated por classificador**):
1. User-provided macros
2. TACO base-name match
3. TACO token search
4. TACO fuzzy
5. **GUARDRAIL — `portion_type === 'packaged'` + filtros defensivos** (ver seção "Guardrail" abaixo)
6. **NOVO — Catálogo de produtos aprovados** (`products.status='aprovado'`) — **só se passou no guardrail**
7. **NOVO — Produtos privados do usuário** (`products.status='privado' AND created_by=userId`) — **só se passou no guardrail**
8. **NOVO — Open Food Facts** (busca por nome; se confirmado, salva como `aprovado`) — **só se passou no guardrail**
9. **NOVO — Cadastro manual via rótulo** (interativo; salva como `privado`) — **só se passou no guardrail**
10. LLM decomposition + ingredient re-match (existente) — caminho padrão pra `generic`/`unknown`
11. LLM estimate direto (existente)

A inserção é **antes** da decomposição LLM porque produto industrializado não deve ser decomposto em ingredientes. O guardrail garante que **só itens claramente industrializados** caem nessa rota — "arroz blanco" (typo de "arroz branco") **não** entra aqui, vai direto pra TACO fuzzy ampliada / decomposição LLM.

### Guardrail — quando disparar o fluxo de produto

O fluxo de produto só dispara quando o item é claramente industrializado/de marca. **Reutiliza o campo `portion_type` que já existe** no schema `MealItemSchema` (`src/lib/llm/schemas/meal-analysis.ts:4`) e que o prompt `analyze.ts:24-27` já classifica como `packaged` pra produtos industrializados ("Magic Toast, Yakult, Danone, whey, suplementos, produtos com nome de marca").

Não cria campo novo no schema. Em vez disso aplica três camadas de filtro sobre `portion_type === 'packaged'`:

**1. Sinal primário (já existe)**: se `portion_type !== 'packaged'`, **pula direto pra decomposição LLM** — não toca em produtos.

**2. Lista de palavras genéricas defensiva** (`src/lib/products/classify.ts`, ~50 itens em PT-BR: `arroz`, `feijão`, `frango`, `carne`, `peixe`, `banana`, `maçã`, `pão`, `leite`, `ovo`, `batata`, `tomate`, `cebola`, `alface`, `queijo`, `iogurte`, ...). Se o token base do `food` está nessa lista, **força saída do fluxo de produto** mesmo com `portion_type='packaged'`. Protege quando o LLM erra (ex: classifica "leite" como packaged só porque o usuário falou "1 caixa de leite").

**3. Verificação de proximidade TACO** (rede de segurança final): se passou nas camadas 1 e 2, mas `pg_trgm similarity(name_normalized, taco_food_name) > 0.5` retorna match na TACO, **força saída**. Cobre o caso "arroz blanco" (typo de "arroz branco") que poderia escapar — TACO deve resolver.

Resultado: pra cair no fluxo de produto industrializado, o item precisa: (a) ter `portion_type='packaged'` vindo do parser, (b) não estar na lista de genéricos, (c) não ter match de proximidade na TACO. Triple-gate.

**Observação sobre o prompt**: o prompt `analyze.ts` já está bem calibrado pra `packaged`. Não precisamos editá-lo nessa v1 — só adicionar exemplos novos (Yopro, barra Trio, Coca-Cola) **se** os testes mostrarem precisão ruim de classificação.

### Novas tabelas

**`products`** — catálogo de produtos industrializados.

```sql
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,                          -- "Magic Toast Tradicional"
  name_normalized TEXT NOT NULL,               -- "magic toast tradicional"
  brand TEXT,                                  -- "Marilan"
  brand_normalized TEXT,                       -- "marilan"
  barcode TEXT,                                -- código de barras (se houver)
  serving_size_g NUMERIC,                      -- ex: 30 (porção rotulada)
  serving_display TEXT,                        -- "4 unidades"
  calories_per_100g NUMERIC NOT NULL,
  protein_per_100g NUMERIC NOT NULL,
  carbs_per_100g NUMERIC NOT NULL,
  fat_per_100g NUMERIC NOT NULL,
  fiber_per_100g NUMERIC,
  sodium_per_100g NUMERIC,
  source TEXT NOT NULL CHECK (source IN ('open_food_facts', 'user_label', 'consenso_usuarios')),
  source_ref TEXT,                             -- URL OFF ou null
  status TEXT NOT NULL CHECK (status IN ('aprovado', 'privado')),
  created_by UUID REFERENCES users(id),        -- null se importado/promovido
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  promoted_at TIMESTAMPTZ,                     -- quando virou aprovado por consenso
  contributor_ids UUID[]                       -- usuários do cluster de consenso
);

CREATE UNIQUE INDEX idx_products_barcode_unique ON products (barcode) WHERE barcode IS NOT NULL;
CREATE INDEX idx_products_name_norm ON products USING gin (name_normalized gin_trgm_ops);
CREATE INDEX idx_products_brand_name_norm ON products (brand_normalized, name_normalized) WHERE status = 'aprovado';
CREATE INDEX idx_products_private_owner ON products (created_by, name_normalized) WHERE status = 'privado';
```

**`product_usage`** — pra rastrear consumo e aquecer cache do consenso.

```sql
CREATE TABLE product_usage (
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  used_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (product_id, user_id, used_at)
);
```

**`meal_items.source`** — adicionar valor novo: `'product'`.

```sql
ALTER TABLE meal_items DROP CONSTRAINT meal_items_source_check;
ALTER TABLE meal_items ADD CONSTRAINT meal_items_source_check
  CHECK (source IN ('approximate', 'taco', 'manual', 'taco_decomposed',
                    'user_provided', 'user_history', 'off', 'recipe', 'product'));
ALTER TABLE meal_items ADD COLUMN product_id UUID REFERENCES products(id);
```

### Componentes novos

**`src/lib/products/off-client.ts`** — cliente Open Food Facts.
- `searchByName(query: string): Promise<OffProduct[]>` — top 5 resultados via **`https://search.openfoodfacts.org/search`** (Search-A-Licious v2). **Importante**: o endpoint legacy `/cgi/search.pl` está aposentado/retornando 503 — usar o engine novo.
  - Query string: `?q={query}&page_size=10&fields=code,product_name,brands,nutriments,quantity,serving_size`
- `getByBarcode(barcode: string): Promise<OffProduct | null>` — via `https://world.openfoodfacts.org/api/v2/product/{code}.json`.
- User-Agent: `CalorieBot/1.0 (otavioajr@gmail.com)`.
- Timeout 3s, retry 1x com backoff de 500ms. Falha silenciosa (retorna `[]` ou `null` — não bloqueia o fluxo).
- Normaliza unidades: OFF retorna kcal e gramas; converte de kJ se vier nesse formato.
- **Filtros de plausibilidade pré-retorno** (testes locais mostraram dados sujos: ex. "Magic toast" com 64 kcal/100g — impossível pra biscoito):
  - `nutriments['energy-kcal_100g']` presente, entre 20 e 900.
  - Macros entre 0 e 100g por 100g.
  - Soma `(prot*4 + carbo*4 + gordura*9)` a ±30% das kcal declaradas (tolerância maior que cadastro manual porque OFF tem mais ruído).
  - Resultados que falharem nos filtros são descartados antes de chegar no usuário.
- **Ordenação dos top 5 retornados ao usuário**: produtos com `brands` preenchido primeiro, depois pelo tamanho do nome (proxy de especificidade).

**`src/lib/products/queries.ts`** — queries Supabase.
- `findApprovedProduct(supabase, name, brand?)` — usa `name_normalized` (gin_trgm) + filtro de marca opcional.
- `findPrivateProduct(supabase, userId, name)` — filtra `created_by` e `status='privado'`.
- `findByBarcode(supabase, barcode)`.
- `createProduct(supabase, payload)` — cria privado ou aprovado conforme origem.
- `recordUsage(supabase, productId, userId)`.

**`src/lib/products/lookup.ts`** — orquestra camadas 6-9 do pipeline.
- `tryProductLookup(supabase, item, userId): Promise<ProductLookupOutcome>` — **só executa se `shouldUseProductFlow(item, supabase)` retornar `true`**. Retorna `{kind:'matched', enriched}` (achou em catálogo aprovado/privado), `{kind:'needs_off_choice', candidates}` (achou no OFF, precisa interação), `{kind:'needs_label', food}` (não achou em lugar nenhum), ou `{kind:'skip'}` (guardrail rejeitou).
- Reaproveita `normalizeFoodNameForTaco()` de `src/lib/utils/food-normalize.ts` pra gerar `name_normalized`.

**`src/lib/products/classify.ts`** — guardrail de elegibilidade.
- `shouldUseProductFlow(item: MealItem, supabase): Promise<boolean>` — checa as três camadas do guardrail (`portion_type==='packaged'` + lista de genéricos + similarity TACO). Retorna `true` apenas se passou em todas.
- Lista `GENERIC_FOOD_TOKENS` exportada e versionada no arquivo.

**`src/lib/bot/flows/product-confirm.ts`** — fluxo de confirmação interativo (estado em `conversation_state`).
- Estados:
  - `awaiting_off_choice` — usuário escolhe entre top 5 OFF (ou "nenhum" pra cadastro manual).
  - `awaiting_off_brand` — produto OFF escolhido tem `brands` vazio, bot pergunta a marca.
  - `awaiting_off_confirm` — revisão final antes de salvar (após escolha + marca completada se necessário).
  - `awaiting_label_input` — usuário digita macros do rótulo.
  - `awaiting_label_confirm` — revisão antes de salvar cadastro manual.
- Mensagens em PT-BR seguindo o padrão dos outros flows em `src/lib/bot/flows/`.

**`src/lib/products/consensus.ts`** — job de promoção.
- Função `runConsensusPromotion(supabase): Promise<{promoted: number; clusters: number}>`.
- Query: agrupa `products` com `status='privado'` por `(brand_normalized, name_normalized)` onde ambos são `NOT NULL`.
- Para cada grupo com ≥3 `created_by` distintos:
  - Calcula mediana de `calories_per_100g`, `protein_per_100g`, `carbs_per_100g`, `fat_per_100g`.
  - Verifica desvio: `max(|kcal_i - mediana|) / mediana ≤ 0.15` E `max(|macro_i - mediana|) / mediana ≤ 0.20` pra cada macro.
  - Se passa: cria nova linha `status='aprovado'`, `source='consenso_usuarios'`, `contributor_ids=[ids]`, `created_by=NULL`, `promoted_at=now()` com macros medianos.
  - Privados originais permanecem (autores continuam vendo o "deles"; lookups públicos passam a achar o aprovado primeiro).
- **Não promove** se `brand` for nulo em qualquer membro do grupo.
- Trigger: cron diário (Vercel Cron `vercel.ts` ou rota `/api/cron/products-consensus` chamada por agendador externo).

**`src/lib/products/normalize.ts`** — utilitários específicos.
- `normalizeProductName(s)` — reusa lower+accent+trim de `food-normalize.ts`, mas mantém marcadores de marca (não aplica synonyms TACO).
- `normalizeBrand(s)` — lower + accent + trim.
- `convertLabelToPer100g(input)` — quando usuário digita macros por porção, converte pra base 100g usando `serving_size_g`.

### Fluxo de conversação

**Caso 1 — produto já no catálogo aprovado:**
> Usuário: "comi 1 pacote de magic toast"
> Bot: trata como qualquer outro item TACO, registra refeição. Sem prompts extras.

**Caso 2 — não está na base, encontrado em fonte externa:**
> Bot: "Não tenho 'magic toast' cadastrado ainda. Encontrei essas opções:
> 1. Magic Toast Tradicional (Marilan) — 420 kcal/100g
> 2. Magic Toast Integral (Marilan) — 410 kcal/100g
>
> Responda com o número, ou 'nenhum' pra cadastrar pelo rótulo."
>
> Usuário: "1"
> Bot: salva em `products` (status=`aprovado`, source=`open_food_facts`), registra refeição usando macros do produto.

**Caso 2.b — fonte externa retornou produto sem marca preenchida:**

OFF é colaborativo e ~1/3 dos resultados vêm com `brands` vazio mesmo quando o nome contém a marca. Como nossa regra de consenso exige `brand_normalized NOT NULL` e queremos evitar duplicatas no catálogo público, **completamos a marca antes de salvar**:

> Bot: "Encontrei 'Magic Toast' (420 kcal/100g, 9P/72C/10G). Qual a marca desse produto?"
>
> Usuário: "Marilan"
> Bot: "Confirma? Magic Toast (Marilan) — 420 kcal/100g."
> Usuário: "sim"
> Bot: salva como `aprovado` com `brand='Marilan'`, registra refeição.

A pergunta extra acontece **uma única vez por produto**: o segundo usuário (e o próprio que cadastrou, na próxima vez) batem na camada 6 (catálogo aprovado) e usam direto, sem chamar OFF nem perguntar marca.

**Caso 3 — não encontrado, cadastro manual:**
> Bot: "Não encontrei esse produto na minha base. Quer cadastrar pelo rótulo?
> Me passa: marca, valores por 100g (kcal, proteína, carbo, gordura)."
>
> Usuário: "Marilan, 420 kcal, 9g prot, 72g carbo, 10g gordura"
> Bot: parseia (regex + LLM se ambíguo), mostra resumo:
> "Confirma? Magic Toast (Marilan) — 420 kcal, 9P/72C/10G por 100g."
>
> Usuário: "sim"
> Bot: salva em `products` (status=`privado`, source=`user_label`), registra refeição.

**Caso 4 — fonte externa encontrou mas usuário rejeita todos:**
> Bot: vai pro fluxo do Caso 3.

**Diretriz de copy:** as mensagens do bot **nunca citam "Open Food Facts" por nome**. Termos genéricos: "minha base", "base de produtos", "encontrei", "não encontrei". A origem do dado (`source='open_food_facts'`) é interna, só pra rastreabilidade no banco.

### Limites e proteções

- **Rate limit OFF**: máx. 1 chamada por mensagem do usuário (sem retry). OFF não tem auth e o consumo é leve.
- **Timeout OFF**: 3s. Em caso de timeout/erro, bot trata como "não achei no OFF" e oferece cadastro manual.
- **Feature flag**: `PRODUCTS_BASE_ENABLED` (default `true`). Permite desligar sem deploy se a feature der problema.
- **Validação de macros manuais**: kcal entre 0 e 900, macros entre 0 e 100g por 100g, soma `(prot*4 + carbo*4 + gordura*9)` deve estar a ±20% das kcal declaradas. Se falhar, bot pede confirmação extra.
- **Privacidade**: produto privado nunca aparece em busca de outros usuários (RLS). Promoção pra aprovado cria linha **nova** — não muda visibilidade da contribuição original.

## Arquivos críticos a modificar

| Arquivo | Mudança |
|---|---|
| `supabase/migrations/00021_create_products.sql` | Novo: tabelas `products`, `product_usage`, índices, RLS, novo source em `meal_items` |
| `src/lib/products/off-client.ts` | Novo: cliente OFF |
| `src/lib/products/queries.ts` | Novo: queries Supabase |
| `src/lib/products/lookup.ts` | Novo: orquestração das camadas 6-9 (gated por `shouldUseProductFlow`) |
| `src/lib/products/classify.ts` | Novo: guardrail `shouldUseProductFlow` (`portion_type='packaged'` + lista genéricos + similarity TACO) |
| `src/lib/products/normalize.ts` | Novo: helpers de normalização |
| `src/lib/products/consensus.ts` | Novo: job de auto-promoção |
| `src/lib/bot/flows/product-confirm.ts` | Novo: fluxo conversacional de confirmação |
| `src/lib/bot/flows/meal-log.ts` | Modificar `enrichItemsWithTaco` em ~189 pra chamar `tryProductLookup` antes da decomposição LLM (~325) |
| `src/lib/db/queries/context.ts` | Adicionar tipos `awaiting_off_choice`, `awaiting_off_brand`, `awaiting_off_confirm`, `awaiting_label_input`, `awaiting_label_confirm` em `ContextType` e `CONTEXT_TTLS` |
| `src/lib/bot/router.ts` | Rotear novos context types pro `product-confirm.ts` |
| `src/app/api/cron/products-consensus/route.ts` | Novo: endpoint pra cron diário |
| `vercel.ts` | Adicionar `crons` entry pra `/api/cron/products-consensus` |
| `src/lib/db/types.ts` | Tipos do Supabase regenerados (`Product`, `ProductUsage`) |
| `tests/unit/products/lookup.test.ts` | Testes de cada camada e fallback |
| `tests/unit/products/consensus.test.ts` | Testes de cluster, mediana, threshold, exigência de marca |
| `tests/unit/products/off-client.test.ts` | Testes com MSW mockando OFF |
| `tests/integration/meal-log-product.test.ts` | E2E do fluxo de confirmação |

## Verificação

**Local:**
1. `npm run lint` e `npm run build` passam sem erro.
2. `npm run test:unit` cobre: lookup em cada camada, mediana com outlier, rejeição por marca ausente, threshold de 15/20%, parse de rótulo manual, validação de macros, **classificador `kind` (genérico/branded/unknown), guardrail de typos próximos a TACO ("arroz blanco" → generic), lista de palavras genéricas, heurística de capitalização**.
3. `npm run test:integration` roda fluxo completo com Supabase local: usuário registra produto → confirma OFF → próximo usuário acha direto na base.
4. Migração aplicada via `supabase db reset` em ambiente local.

**Ngrok + WhatsApp manual (cenários do PRD):**
1. **Caso 1**: criar produto aprovado seed (ex: "Yopro 25g"), enviar "comi 1 yopro" → registra direto sem prompts.
2. **Caso 2**: enviar "comi 1 magic toast" com base zerada → bot lista opções OFF → confirmar → próxima mensagem do mesmo produto cai direto no aprovado.
3. **Caso 3**: enviar produto inventado ("biscoito superx do bairro") → OFF retorna vazio → bot pede rótulo → cadastrar → registrar como privado.
4. **Caso 4**: como usuário B, registrar mesmo produto inventado do caso 3 com macros próximos → ainda fica privado pra ambos.
5. **Consenso**: rodar `runConsensusPromotion` manualmente após 3 usuários cadastrarem o mesmo produto privado com marca → confirmar criação de linha aprovada com macros medianos.
6. **Erro OFF**: simular timeout (mock) → bot oferece cadastro manual sem travar.
7. **Validação de macros**: digitar kcal/macros incoerentes → bot pede confirmação.
8. **Guardrail anti-falso-positivo**: enviar "arroz blanco" → cai em TACO fuzzy ("arroz, branco"), **não** dispara fluxo de produto. Enviar "frango grelhdo" (typo) → cai em TACO fuzzy ("frango, peito, grelhado"), **não** dispara fluxo de produto. Enviar "biscoito recheado" sem marca → `kind='unknown'`, vai pra decomposição LLM, **não** dispara fluxo de produto.

**Métricas pra acompanhar pós-deploy:**
- `SELECT source, count(*) FROM products GROUP BY source` — quantos vieram de OFF vs label.
- `SELECT count(*) FROM products WHERE status='privado' AND brand IS NOT NULL` — fila virtual de candidatos a consenso.
- Logs do cron em `/api/cron/products-consensus` — quantos clusters avaliados, quantos promovidos, motivos de rejeição.
- Comparar custo LLM mensal antes/depois (espera-se queda nas chamadas de fallback de estimativa).
