-- Manual corrective migration: Better Auth tables must be readable before a
-- user-scoped RLS context exists. The server-only app_user role is the sole
-- application runtime role and Better Auth performs its own session isolation.

ALTER TABLE public."user"         NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public."account"      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public."session"      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public."verification" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public."user"         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public."account"      DISABLE ROW LEVEL SECURITY;
ALTER TABLE public."session"      DISABLE ROW LEVEL SECURITY;
ALTER TABLE public."verification" DISABLE ROW LEVEL SECURITY;
