# Design Spec: Cálculo de Macros e Reformulação do TDEE

**Data:** 2026-03-29
**Status:** Aprovado

---

## Objetivo

Reformular o cálculo calórico do CalorieBot para incluir metas de macronutrientes (proteína, gordura, carboidrato) baseadas no peso máximo saudável do usuário (IMC 24.9). Atualizar fatores de atividade física, adicionar nível "atleta", e permitir edição manual de macros no site com reajuste automático.

---

## 1. Cálculos (`src/lib/calc/tdee.ts`)

### 1.1 Fatores de atividade (substituem os atuais)

| Nível       | Chave DB     | Fator |
|-------------|--------------|-------|
| Sedentário  | `sedentary`  | 1.4   |
| Leve        | `light`      | 1.5   |
| Moderado    | `moderate`   | 1.6   |
| Intenso     | `intense`    | 1.7   |
| Atleta      | `athlete`    | 1.8   |

### 1.2 Peso máximo saudável

```
maxWeightKg = 24.9 × (heightCm / 100)²
```

Exemplo: 175cm → 24.9 × 1.75² = 76.2 kg

### 1.3 Cálculo de macronutrientes

Constantes: 1g proteína = 4 kcal, 1g carbo = 4 kcal, 1g gordura = 9 kcal.

- **Proteína (g):** `maxWeightKg × 2` (masculino) ou `maxWeightKg × 1.6` (feminino)
- **Gordura (g):** `maxWeightKg` (1g por kg do peso máximo)
- **Carboidrato (g):** `(dailyTarget - proteinG×4 - fatG×9) / 4`
  - Se resultado negativo, seta 0

### 1.4 Funções novas/alteradas

- `calculateMaxWeight(heightCm: number): number` — retorna peso máximo via IMC 24.9
- `calculateMacros(params: { sex, maxWeightKg, dailyTarget }): { proteinG, fatG, carbsG }` — calcula macros
- `calculateAll(...)` — retorna também `maxWeightKg`, `proteinG`, `fatG`, `carbsG`
- `recalcMacrosFromTarget(currentMacros: { proteinG, fatG, carbsG }, oldTarget: number, newTarget: number): { proteinG, fatG, carbsG }` — recalcula todos os macros proporcionalmente quando a meta calórica muda

### 1.5 Ajustes por objetivo (mantidos)

| Objetivo | Ajuste |
|----------|--------|
| Perder   | -500   |
| Manter   | 0      |
| Ganhar   | +300   |

### 1.6 Tipo `ActivityLevel`

Atualizar para incluir `'athlete'`:
```typescript
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'intense' | 'athlete'
```

---

## 2. Banco de dados

### 2.1 Migration `00010_add_macros_and_athlete.sql`

```sql
-- Novas colunas
ALTER TABLE users ADD COLUMN max_weight_kg DECIMAL(5,2);
ALTER TABLE users ADD COLUMN daily_protein_g INTEGER;
ALTER TABLE users ADD COLUMN daily_fat_g INTEGER;
ALTER TABLE users ADD COLUMN daily_carbs_g INTEGER;

-- Atualizar constraint de activity_level para incluir 'athlete'
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_activity_level_check;
ALTER TABLE users ADD CONSTRAINT users_activity_level_check
  CHECK (activity_level IN ('sedentary','light','moderate','intense','athlete'));
```

Usuários existentes terão macros `NULL` até rodarem `/recalcular`.

### 2.2 Interface `User` (`src/lib/db/queries/users.ts`)

Adicionar campos:
```typescript
maxWeightKg: number | null
dailyProteinG: number | null
dailyFatG: number | null
dailyCarbsG: number | null
```

`activityLevel` atualizado para incluir `'athlete'`.

---

## 3. Onboarding (`src/lib/bot/flows/onboarding.ts`)

### 3.1 Step 6 — Atividade física

Mensagem atualizada:
```
Qual seu nível de atividade física?
1️⃣ Sedentário (pouco ou nenhum exercício)
2️⃣ Leve (1-3 dias/semana)
3️⃣ Moderado (3-5 dias/semana)
4️⃣ Intenso (6-7 dias/semana)
5️⃣ Atleta (treino intenso 2x/dia)
```

### 3.2 Step 8 — Finalização

`calculateAll` agora retorna macros. Persistir `max_weight_kg`, `daily_protein_g`, `daily_fat_g`, `daily_carbs_g` no `updateUser`.

### 3.3 Mensagem de conclusão

Formato:
```
Tudo pronto, {nome}! 🎉
Sua meta diária é de {target} kcal.
Proteína: {proteinG}g | Gordura: {fatG}g | Carbs: {carbsG}g

Agora é só me mandar o que comeu! ...
```

---

## 4. Comando `/recalcular`

### 4.1 Router

Adicionar keywords: `recalcular`, `/recalcular`, `recalcula`.
Tipo de intent: `recalculate`.

### 4.2 Flow (`src/lib/bot/flows/recalculate.ts`)

1. Busca dados do usuário no banco
2. Verifica se onboarding está completo — se não, pede pra terminar
3. Roda `calculateAll` com os dados atuais
4. Persiste `tmb`, `tdee`, `daily_calorie_target`, `max_weight_kg`, `daily_protein_g`, `daily_fat_g`, `daily_carbs_g`
5. Responde:
```
Recalculado! ✅
Meta: {target} kcal
Proteína: {proteinG}g | Gordura: {fatG}g | Carbs: {carbsG}g
```

---

## 5. Meal-log — Progresso com macros

### 5.1 Formatação (`src/lib/utils/formatters.ts`)

`formatProgress` e `formatMealBreakdown` passam a incluir macros:
```
📊 Hoje: 1200 / 1800 kcal
P: 80/152g | G: 40/76g | C: 90/148g
```

Isso requer que ao somar as refeições do dia, somemos também proteína, gordura e carbs consumidos.

### 5.2 Query de consumo diário

A query que soma calorias do dia precisa somar também `protein`, `carbs`, `fat` de `meal_items`.

---

## 6. Site — ProfileForm

### 6.1 Select de atividade

Adicionar opção: `Atleta (treino intenso 2x/dia)` com valor `athlete`.

### 6.2 Exibição de macros

Após salvar, exibir junto com TMB/TDEE/meta:
```
Proteína: 152g | Gordura: 76g | Carbs: 148g
```

### 6.3 Edição manual de macros

3 inputs numéricos (proteína g, gordura g, carbs g) editáveis:

**Regras de reajuste automático (client-side):**
- Editar **proteína** ou **gordura** → carboidrato reajusta: `carbsG = (dailyTarget - proteinG×4 - fatG×9) / 4`
- Editar **carboidrato** → proteína e gordura reajustam proporcionalmente entre si, mantendo a proporção relativa P:G
- Editar **meta calórica** → todos os 3 macros reajustam proporcionalmente: `novoMacro = macroAtual × (novaMeta / metaAnterior)`

A soma `proteinG×4 + fatG×9 + carbsG×4` sempre se mantém igual a `daily_calorie_target`.

### 6.4 API `/api/user/profile`

Aceitar e persistir: `maxWeightKg`, `dailyProteinG`, `dailyFatG`, `dailyCarbsG`.

---

## 7. Validators (`src/lib/utils/validators.ts`)

`validateActivityLevel` passa a aceitar:
- `5`, `atleta`, `athlete` → retorna `'athlete'`

---

## 8. Fora do escopo

- Dashboard de macros no site (futuro)
- Gráficos de progresso de macros
- Backfill automático de macros para usuários existentes (coberto pelo `/recalcular`)
