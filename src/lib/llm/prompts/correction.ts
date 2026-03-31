export function buildCorrectionPrompt(message: string): string {
  return `Analise a mensagem do usuário e extraia a intenção de CORREÇÃO de uma refeição já registrada.

MENSAGEM DO USUÁRIO: "${message}"

AÇÕES POSSÍVEIS:
- "update_quantity": mudar a quantidade de um item (ex: "o arroz era 2 escumadeiras", "era 200ml, não 100ml")
- "remove_item": remover um item (ex: "tira o queijo", "remove o suco")
- "add_item": adicionar um item que faltou (ex: "faltou o suco", "esqueci de colocar a salada")
- "replace_item": trocar um alimento por outro (ex: "era queijo cottage, não minas")
- "delete_meal": apagar a refeição inteira (ex: "apaga o almoço", "deleta tudo")

REGRAS:
- "target_meal_type": tipo da refeição alvo (breakfast, lunch, snack, dinner, supper). Se o usuário não especificou, deixe null.
- "target_food": nome do alimento alvo (o que está no registro atual). Para add_item, é o nome do item a adicionar.
- "new_quantity": nova quantidade descrita pelo usuário (texto livre, ex: "2 escumadeiras", "200ml"). Null se não aplicável.
- "new_food": novo alimento (para replace_item). Null se não aplicável.
- "confidence": "high" se a intenção é clara, "medium" se precisa confirmar, "low" se ambíguo.

Responda SOMENTE com JSON no formato:
{
  "action": "update_quantity|remove_item|add_item|replace_item|delete_meal",
  "target_meal_type": "breakfast|lunch|snack|dinner|supper|null",
  "target_food": "nome do alimento",
  "new_quantity": "quantidade nova ou null",
  "new_food": "novo alimento ou null",
  "confidence": "high|medium|low"
}`
}
