-- Manual migration (psql, pattern 0009/0011/0012 -- NOT journaled).
-- Applied: 2026-07-09
--
-- user_profiles has an updated_at column but was missing from the trigger loop
-- in 0004_triggers_and_rls; updates never advanced that timestamp.

DROP TRIGGER IF EXISTS trg_updated_at_user_profiles ON user_profiles;
CREATE TRIGGER trg_updated_at_user_profiles
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
