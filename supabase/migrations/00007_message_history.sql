-- Create message_history table
CREATE TABLE message_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_message_history_user_created ON message_history (user_id, created_at);

ALTER TABLE message_history ENABLE ROW LEVEL SECURITY;

-- Only service role manages this table (bot uses createServiceRoleClient)
-- No policies for authenticated web users

-- Update reset_user_data to also clear message history
CREATE OR REPLACE FUNCTION reset_user_data(p_user_id UUID) RETURNS void AS $$
BEGIN
  DELETE FROM meals WHERE user_id = p_user_id;
  DELETE FROM weight_log WHERE user_id = p_user_id;
  DELETE FROM user_settings WHERE user_id = p_user_id;
  DELETE FROM conversation_context WHERE user_id = p_user_id;
  DELETE FROM llm_usage_log WHERE user_id = p_user_id;
  DELETE FROM message_history WHERE user_id = p_user_id;
  UPDATE users SET
    name = '',
    sex = NULL,
    age = NULL,
    weight_kg = NULL,
    height_cm = NULL,
    activity_level = NULL,
    goal = NULL,
    calorie_mode = 'approximate',
    daily_calorie_target = NULL,
    calorie_target_manual = false,
    tmb = NULL,
    tdee = NULL,
    onboarding_complete = false,
    onboarding_step = 0,
    updated_at = NOW()
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
