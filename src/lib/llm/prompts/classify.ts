export function buildClassifyPrompt(): string {
  return `Classifique a intenção do usuário em UMA das categorias:
meal_log, summary, edit, query, weight, help, settings, out_of_scope.

Responda APENAS com JSON: {"intent": "categoria"}

Definições:
- meal_log: usuário está relatando o que comeu ou bebeu
- summary: quer ver resumo de calorias (hoje, semana, mês)
- edit: quer corrigir, apagar ou modificar um registro
- query: quer saber calorias de um alimento sem registrar
- weight: quer registrar ou consultar seu peso
- help: quer ver menu de opções ou ajuda
- settings: quer mudar configurações, objetivo, modo, meta
- out_of_scope: assunto não relacionado a calorias/nutrição`
}
