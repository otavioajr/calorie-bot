# VPS cron — inbox sweeper (Fase 2)

O plano Hobby da Vercel só permite cron **diário**. Para retomar trabalhos órfãos a cada ~2 minutos, use a **mesma VPS do Postgres** (`ubuntu@147.15.89.175`) apenas como **alarme**: um `curl` autenticado chama o endpoint na Vercel. A VPS não executa lógica do bot — só acorda o sweeper.

Tudo do Calorie Bot nesta máquina: banco (Supabase self-hosted) + crontab do sweeper. Não usar uma segunda VPS só para o cron.

## 0. Pré-requisito: pacote `cron`

Na VPS Ubuntu mínima o pacote pode não estar instalado:

```bash
sudo apt-get install -y cron
sudo systemctl enable --now cron
```

## 1. Arquivo de env na VPS

```bash
ssh ubuntu@147.15.89.175

cat > ~/.caloriebot-cron.env <<'EOF'
CRON_SECRET=<mesmo valor da Vercel>
SWEEPER_URL=https://caloriebot.app/api/cron/inbox-sweeper
EOF
chmod 600 ~/.caloriebot-cron.env
```

Substitua `caloriebot.app` pelo domínio de produção real se diferente.

## 2. Crontab

```bash
crontab -e
```

Adicione:

```cron
*/2 * * * * . $HOME/.caloriebot-cron.env && curl -fsS -H "Authorization: Bearer $CRON_SECRET" "$SWEEPER_URL" >> $HOME/caloriebot-sweeper.log 2>&1
```

## 3. Verificação

```bash
. ~/.caloriebot-cron.env
curl -i -H "Authorization: Bearer $CRON_SECRET" "$SWEEPER_URL"
```

Esperado: `200` com JSON `{ processed, skipped, errors, candidates }`.

## 4. Rollout

1. Aplicar migration `20260712140000_inbound_work.sql` no Postgres desta mesma VPS.
2. Deploy do código com `INBOUND_WORK_ENABLED=false` (fail-closed no legado já vale).
3. Configurar crontab nesta VPS.
4. Ligar `INBOUND_WORK_ENABLED=true` na Vercel.

Rollback: desligar a flag; crontab pode permanecer (no-op se não houver órfãos).
