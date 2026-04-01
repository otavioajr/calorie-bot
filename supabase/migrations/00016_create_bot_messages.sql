-- supabase/migrations/00016_create_bot_messages.sql

CREATE TABLE bot_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  resource_type TEXT CHECK (resource_type IS NULL OR resource_type IN ('meal', 'summary', 'query', 'weight')),
  resource_id UUID,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bot_messages_message_id ON bot_messages(message_id);
CREATE INDEX idx_bot_messages_user_resource ON bot_messages(user_id, resource_type, resource_id);

-- RLS: service role only (bot writes via service role client)
ALTER TABLE bot_messages ENABLE ROW LEVEL SECURITY;
