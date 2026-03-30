# Design Spec: Refinamento das Mensagens de Onboarding

**Data:** 2026-03-30
**Status:** Aprovado

---

## Objetivo

Simplificar o onboarding do CalorieBot removendo a etapa de escolha entre TACO e manual, que deixou de fazer sentido para o usuário, e reescrever todas as mensagens do fluxo com um tom mais amigável, elegante e acolhedor. O onboarding deve soar como um assistente pessoal guiando uma configuração rápida, e não como um formulário técnico.

---

## 1. Resultado esperado

O onboarding passa a ter um passo a menos e termina logo após o usuário informar o objetivo:

1. Nome
2. Idade
3. Sexo
4. Peso
5. Altura
6. Atividade física
7. Objetivo
8. Conclusão automática

Após salvar o objetivo, o sistema já calcula TMB, TDEE, meta calórica e macros, cria as configurações padrão e encerra o onboarding sem expor nenhum "modo de cálculo" para o usuário.

---

## 2. Comportamento nutricional

O comportamento interno do pipeline nutricional permanece exatamente o já existente no produto.

Ordem de fallback:

1. TACO
2. TACO fuzzy
3. Decomposição via LLM
4. Estimativa aproximada via LLM

Esse comportamento deixa de ser apresentado como escolha de produto durante o cadastro. Ele passa a ser um detalhe interno do sistema.

---

## 3. Fluxo conversacional

### 3.1 Boas-vindas

A abertura deve dar contexto rápido e transmitir cuidado, sem soar técnica demais. A mensagem deve comunicar que a configuração será breve e que ao final o usuário já terá a meta pronta.

Direção:

- acolhedora, mas sem excesso de informalidade
- confiante e clara
- sem menções a "Tabela TACO", "modo manual", "precisão" ou outros termos internos

### 3.2 Transições entre passos

Cada resposta do bot deve fazer duas coisas:

1. reconhecer o dado anterior de forma natural, quando fizer sentido
2. puxar a próxima pergunta com clareza

O objetivo é reduzir a sensação de checklist. Em vez de perguntas soltas e secas, o fluxo deve parecer contínuo.

### 3.3 Perguntas com formato rígido

Nos passos em que o formato da resposta importa, a instrução deve continuar objetiva:

- peso com exemplo em kg
- altura com exemplo em cm
- atividade e objetivo com opções numeradas

O tom pode ser mais humano, mas sem perder legibilidade ou aumentar ambiguidade.

### 3.4 Conclusão

Ao final, a mensagem deve soar como fechamento de setup, não só como retorno de cálculo. A resposta precisa:

- confirmar que a configuração foi concluída
- apresentar a meta calórica diária
- mostrar macros
- convidar o usuário a começar a registrar refeições

---

## 4. Direção de voz

O tom desejado é:

- amigável
- elegante
- calmo
- próximo de "assistente pessoal"

O tom a evitar:

- técnico demais
- excessivamente casual
- brincalhão
- robótico
- "formulário"

Critérios de escrita:

- frases curtas e naturais para WhatsApp
- vocabulário simples, mas não simplório
- segurança no texto, sem floreio desnecessário
- quando houver instrução operacional, priorizar clareza sobre personalidade

---

## 5. Mudanças em `src/lib/bot/flows/onboarding.ts`

### 5.1 Remoção da etapa de modo calórico

Remover:

- a mensagem `MSG_ASK_CALORIE_MODE`
- o uso de `validateCalorieMode` dentro do onboarding
- a etapa final que depende de resposta do usuário para encerrar o fluxo

### 5.2 Novo encerramento

Após o passo do objetivo:

1. validar o objetivo
2. persistir o objetivo
3. buscar os dados completos do usuário
4. calcular TMB, TDEE, meta diária e macros
5. persistir os cálculos
6. criar settings padrão
7. limpar estado de onboarding
8. responder com a mensagem final

### 5.3 Numeração de passos

O fluxo continua começando em `step 0` para o primeiro contato, mas deixa de exigir o passo adicional de seleção de modo. A lógica interna deve refletir o novo fim do onboarding sem criar passo fantasma.

---

## 6. Persistência e compatibilidade

### 6.1 `calorieMode`

O onboarding deixa de perguntar isso ao usuário, mas o campo pode continuar existindo no banco por compatibilidade com o restante do sistema.

Direção:

- não transformar essa tarefa numa refatoração ampla de modelo de dados
- manter compatibilidade com os fluxos atuais
- se o sistema depende de um valor padrão, usar o comportamento default já compatível com o pipeline atual

### 6.2 Configurações futuras

Não faz parte desta mudança redesenhar a tela de configurações ou remover por completo o conceito de modo do restante do produto. O foco aqui é apenas o onboarding conversacional.

---

## 7. Testes

Atualizar `tests/unit/bot/onboarding.test.ts` para cobrir:

- nova quantidade efetiva de etapas
- conclusão do onboarding imediatamente após o objetivo
- ausência da pergunta sobre TACO/manual
- novas mensagens com tom revisado
- manutenção dos comportamentos de validação já existentes

Também verificar se existem outros testes ou snapshots que dependem de textos antigos do onboarding.

---

## 8. Fora do escopo

- remover `calorieMode` do banco de dados
- redesenhar o pipeline nutricional
- mudar o comportamento de cálculo após o onboarding
- revisar todo o copywriting do produto fora do fluxo de onboarding
- alterar menu de configurações web ou bot, exceto se houver dependência direta do texto do onboarding

---

## 9. Critérios de sucesso

- o usuário não escolhe mais entre TACO e manual no onboarding
- o fluxo fica um passo mais curto
- o comportamento nutricional interno continua igual ao atual
- as mensagens soam mais humanas e mais elegantes
- o onboarding continua claro e fácil de responder no WhatsApp
- os testes do fluxo são ajustados e passam
