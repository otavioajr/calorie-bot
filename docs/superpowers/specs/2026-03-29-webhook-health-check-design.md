# Webhook Health Check — Design Spec

**Data:** 2026-03-29
**Objetivo:** Detectar e auto-corrigir quando a subscription do webhook do WhatsApp cair, evitando que o bot pare de receber mensagens silenciosamente.

---

## Problema

A subscription do webhook do Meta pode ser desativada sem aviso (motivo ainda não determinado). Quando isso acontece, o bot para de receber mensagens e não há nenhum alerta — o usuário só descobre quando manda mensagem e não recebe resposta. Re-salvar manualmente no painel do Meta resolve, mas depende de intervenção humana.

## Solução

Um cron job diário que:
1. Consulta a Graph API do Meta para verificar se a subscription do webhook está ativa
2. Se estiver inativa, tenta re-registrar automaticamente
3. Notifica o admin via WhatsApp sobre o resultado

## Fluxo

```
Cron dispara (09:00 BRT / 12:00 UTC)
  │
  ├─ Valida CRON_SECRET (mesmo padrão do cron de lembretes)
  │
  ├─ GET Graph API: verificar subscription do app
  │   URL: https://graph.facebook.com/v21.0/{META_APP_ID}/subscriptions
  │   Auth: app access token ({META_APP_ID}|{META_APP_SECRET})
  │
  ├─ Subscription ativa com campo "messages"?
  │   │
  │   ├─ SIM → loga "[webhook-health] Subscription OK" e encerra
  │   │
  │   └─ NÃO → tenta re-registrar
  │       │
  │       ├─ POST Graph API: re-registrar webhook
  │       │   URL: https://graph.facebook.com/v21.0/{META_APP_ID}/subscriptions
  │       │   Body:
  │       │     object: "whatsapp_business_account"
  │       │     callback_url: "{WEBHOOK_BASE_URL}/api/webhook/whatsapp"
  │       │     verify_token: "{WHATSAPP_VERIFY_TOKEN}"
  │       │     fields: "messages"
  │       │   Auth: app access token
  │       │
  │       ├─ Sucesso?
  │       │   ├─ SIM → avisa admin + loga sucesso
  │       │   └─ NÃO → avisa admin com erro + loga falha
  │       │
  │       └─ fim
```

## Detalhes Técnicos

### Autenticação na Graph API
- O endpoint de subscriptions usa **app access token**
- App access token = `{META_APP_ID}|{META_APP_SECRET}` (concatenação simples, sem chamada extra à API)
- Diferente do `WHATSAPP_ACCESS_TOKEN` que é usado para enviar mensagens

### Verificação da Subscription
- `GET /{APP_ID}/subscriptions` retorna array de subscriptions
- Procurar por `object: "whatsapp_business_account"` com `active: true`
- Verificar que o campo `"messages"` está presente nos fields inscritos

### Re-registro
- `POST /{APP_ID}/subscriptions` com os parâmetros do webhook
- A callback_url é construída a partir de `WEBHOOK_BASE_URL` + `/api/webhook/whatsapp`
- O verify_token reutiliza o `WHATSAPP_VERIFY_TOKEN` existente
- O Meta fará um GET de verificação no endpoint do webhook antes de confirmar

### Mensagens de Alerta
- **Re-registro com sucesso:** `"⚠️ O webhook do WhatsApp estava inativo e foi reativado automaticamente às {hora}. Fique atento se as mensagens estão chegando."`
- **Falha no re-registro:** `"🚨 O webhook do WhatsApp está inativo e não consegui reativar. Erro: {mensagem}. Acesse o painel do Meta para corrigir manualmente."`

## Arquivos

### Novo
- `src/app/api/cron/webhook-health/route.ts` — endpoint do cron

### Alterações
- `vercel.json` — adicionar segundo cron: `{ "path": "/api/cron/webhook-health", "schedule": "0 12 * * *" }`
- `.env.example` — documentar as 3 envs novas

## Variáveis de Ambiente Novas

| Variável | Descrição |
|----------|-----------|
| `ADMIN_PHONE_NUMBER` | Número WhatsApp do admin que recebe alertas (formato internacional, ex: 5511999999999) |
| `META_APP_ID` | ID do app no Meta Developer Console |
| `META_APP_SECRET` | App Secret do Meta (Settings > Basic no painel do app) |

## Sem Banco de Dados

Não precisa de tabela nova. O estado da subscription é consultado direto na Graph API a cada execução.

## Segurança

- Autenticação do cron via Bearer token (`CRON_SECRET`), mesmo padrão do cron de lembretes
- `META_APP_SECRET` nunca exposto ao client — usado apenas server-side no cron

## Limitações e Futuro

- No plano Hobby da Vercel, roda 1x/dia apenas
- Quando migrar para VPS, pode aumentar a frequência (a cada 5-15 min) sem mudança no código — só ajustar o schedule
