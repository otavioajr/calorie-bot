# Golden corpus conversacional (COST-18)

Esqueleto versionado de casos conversacionais para evals futuras (Fase 7).
**Nesta fase não há runner de LLM** — só o contrato, schema e casos de exemplo.

## Formato de um caso

Cada arquivo em `cases/*.json` deve validar contra [`schema.json`](./schema.json).

Campos obrigatórios:

| Campo | Descrição |
|---|---|
| `id` | Identificador estável (snake_case) |
| `description` | Resumo em português |
| `clock` | Instantâneo ISO-8601 da mensagem |
| `timezone` | Timezone do usuário (ex.: `America/Sao_Paulo`) |
| `initial_state` | Onboarding, contexto e refeições pré-existentes |
| `inbound` | Evento de entrada (`text` / `audio` / `image`) |
| `expected.structural` | Intent, escritas permitidas/proibidas |
| `expected.max_llm_calls` | Teto de chamadas LLM para o caso |
| `expected.terminal_response_contains` | *(opcional)* Fragmentos de texto que a resposta terminal deve conter |

## Como adicionar um caso

1. Copie um JSON existente em `cases/`.
2. Preencha `id`, estado inicial, mensagem e expectativas estruturais.
3. Rode `npm run test:unit` / o teste em `tests/corpus/corpus-schema.test.ts` para validar campos mínimos.
4. **Não** espere execução automática contra o bot até a Fase 7.

## Relação com a auditoria

Ver auditoria §15.2 e COST-18 em
[`docs/superpowers/specs/2026-07-11-auditoria-conversacional-e-registro-alimentos.md`](../../docs/superpowers/specs/2026-07-11-auditoria-conversacional-e-registro-alimentos.md).
