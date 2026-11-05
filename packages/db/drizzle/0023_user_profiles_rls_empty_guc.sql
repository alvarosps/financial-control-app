-- Manual corrective migration: transaction-pooler connections retain a
-- transaction-local custom GUC as an empty string after COMMIT. The profile
-- bootstrap sets only app.current_auth_user_id, so the RLS policy must treat
-- an empty app.current_user_id as unset before casting it to uuid.

DROP POLICY IF EXISTS user_profiles_isolation ON public.user_profiles;
CREATE POLICY user_profiles_isolation ON public.user_profiles
  USING (
    id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    OR auth_user_id = current_setting('app.current_auth_user_id', true)
  )
  WITH CHECK (
    id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  );
