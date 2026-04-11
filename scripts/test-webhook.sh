#!/bin/bash
# Simula uma mensagem do WhatsApp no webhook local.
# Uso: ./scripts/test-webhook.sh "almocei arroz e feijão"
# Ou sem argumento para modo interativo.

FROM="5511987545336"
URL="http://localhost:3000/api/webhook/whatsapp"

if [ -n "$1" ]; then
  MSG="$1"
else
  echo -n "Mensagem: "
  read MSG
fi

curl -s -X POST "$URL" \
  -H "Content-Type: application/json" \
  -d "$(cat <<EOF
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "0",
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "metadata": {
          "display_phone_number": "5511999999999",
          "phone_number_id": "${WHATSAPP_PHONE_NUMBER_ID:-123456789}"
        },
        "messages": [{
          "from": "$FROM",
          "id": "wamid.test$(date +%s)",
          "timestamp": "$(date +%s)",
          "type": "text",
          "text": {
            "body": "$MSG"
          }
        }]
      },
      "field": "messages"
    }]
  }]
}
EOF
)" | jq . 2>/dev/null || cat

echo ""
