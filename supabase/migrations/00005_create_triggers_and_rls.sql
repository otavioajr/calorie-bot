-- ============================================
-- PART A: updated_at trigger
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON user_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON meals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON food_cache
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- PART B: Row Level Security
-- ============================================

-- Enable RLS on all tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE meals ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE taco_foods ENABLE ROW LEVEL SECURITY;
ALTER TABLE weight_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_usage_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_cache ENABLE ROW LEVEL SECURITY;

-- Users: access own data only
CREATE POLICY "Users can view own data" ON users
  FOR SELECT USING (auth.uid() = auth_id);
CREATE POLICY "Users can update own data" ON users
  FOR UPDATE USING (auth.uid() = auth_id);

-- User settings: access via user_id -> users.auth_id
CREATE POLICY "Users can view own settings" ON user_settings
  FOR SELECT USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));
CREATE POLICY "Users can update own settings" ON user_settings
  FOR UPDATE USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));
CREATE POLICY "Users can insert own settings" ON user_settings
  FOR INSERT WITH CHECK (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

-- Meals: access own meals
CREATE POLICY "Users can view own meals" ON meals
  FOR SELECT USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));
CREATE POLICY "Users can insert own meals" ON meals
  FOR INSERT WITH CHECK (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));
CREATE POLICY "Users can update own meals" ON meals
  FOR UPDATE USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));
CREATE POLICY "Users can delete own meals" ON meals
  FOR DELETE USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

-- Meal items: access via meal_id -> meals.user_id
CREATE POLICY "Users can view own meal items" ON meal_items
  FOR SELECT USING (meal_id IN (SELECT id FROM meals WHERE user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())));
CREATE POLICY "Users can insert own meal items" ON meal_items
  FOR INSERT WITH CHECK (meal_id IN (SELECT id FROM meals WHERE user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())));
CREATE POLICY "Users can update own meal items" ON meal_items
  FOR UPDATE USING (meal_id IN (SELECT id FROM meals WHERE user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())));
CREATE POLICY "Users can delete own meal items" ON meal_items
  FOR DELETE USING (meal_id IN (SELECT id FROM meals WHERE user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())));

-- TACO foods: read-only for all authenticated users
CREATE POLICY "Authenticated users can read taco foods" ON taco_foods
  FOR SELECT USING (auth.role() = 'authenticated');

-- Weight log: own data
CREATE POLICY "Users can view own weight log" ON weight_log
  FOR SELECT USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));
CREATE POLICY "Users can insert own weight log" ON weight_log
  FOR INSERT WITH CHECK (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

-- Conversation context: own data
CREATE POLICY "Users can view own context" ON conversation_context
  FOR SELECT USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));
CREATE POLICY "Users can manage own context" ON conversation_context
  FOR ALL USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

-- LLM usage log: view own usage
CREATE POLICY "Users can view own LLM usage" ON llm_usage_log
  FOR SELECT USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

-- Food cache: read for all authenticated
CREATE POLICY "Authenticated users can read food cache" ON food_cache
  FOR SELECT USING (auth.role() = 'authenticated');
