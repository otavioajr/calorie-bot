export function buildClassifyPrompt(): string {
  return `Classifique a intenção do usuário em UMA das categorias:
meal_log, meal_detail, summary, edit, query, weight, help, settings, out_of_scope.

Responda APENAS com JSON: {"intent": "categoria"}

Definições:
- meal_log: usuário está relatando o que comeu ou bebeu (ex: "comi X", "almocei Y", "tomei um café", lista de alimentos, nomes de comida)
- meal_detail: usuário quer saber o que comeu em uma refeição específica (ex: "o que comi no café?", "o que eu comi no almoço ontem?", "o que comi no jantar segunda?")
- summary: quer ver resumo de calorias (hoje, semana, mês)
- edit: quer corrigir, apagar ou modificar um registro
- query: quer saber calorias/informação nutricional de um alimento sem registrar (ex: "quanto tem um big mac", "calorias de uma pizza")
- weight: quer registrar ou consultar seu peso
- help: quer ver menu de opções ou ajuda
- settings: quer mudar configurações, objetivo, modo, meta
- out_of_scope: assunto que NÃO tem NENHUMA relação com alimentação, nutrição, calorias, peso ou refeições

REGRAS IMPORTANTES:
- Na DÚVIDA entre meal_log e out_of_scope, prefira meal_log — se a mensagem menciona qualquer alimento ou bebida, é meal_log
- Na DÚVIDA entre query e out_of_scope, prefira query — se a mensagem pergunta sobre qualquer comida, é query
- Na DÚVIDA entre meal_detail e summary, prefira meal_detail — se a mensagem pergunta "o que comi" é meal_detail, se pergunta "quanto comi" é summary
- Use out_of_scope APENAS quando a mensagem claramente não tem nada a ver com alimentação (ex: "qual a capital da França", "me conta uma piada", "como está o tempo")
- Mensagens curtas com nomes de alimentos (ex: "banana", "arroz e feijão") são meal_log
- Mensagens com múltiplas refeições/períodos (ex: "manhã X, almoço Y, tarde Z") são meal_log`
}
