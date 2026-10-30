-- Keep authorization engine tables and evaluator internal to trusted
-- SECURITY DEFINER entrypoints. Client roles cannot query or invoke them.
CREATE POLICY authorization_grants_deny_client_access
ON public.authorization_grants
FOR ALL TO anon, authenticated
USING (false) WITH CHECK (false);

CREATE POLICY authorization_decisions_deny_client_access
ON public.authorization_decisions
FOR ALL TO anon, authenticated
USING (false) WITH CHECK (false);

REVOKE ALL ON FUNCTION public.authorize_action(text,text,uuid,uuid,jsonb,boolean)
FROM PUBLIC, anon, authenticated;
