CREATE OR REPLACE FUNCTION reset_user_data(p_user_id UUID) RETURNS void AS $$
BEGIN
  DELETE FROM meals WHERE user_id = p_user_id;
  DELETE FROM weight_log WHERE user_id = p_user_id;
  DELETE FROM user_settings WHERE user_id = p_user_id;
  DELETE FROM conversation_context WHERE user_id = p_user_id;
  DELETE FROM llm_usage_log WHERE user_id = p_user_id;
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
