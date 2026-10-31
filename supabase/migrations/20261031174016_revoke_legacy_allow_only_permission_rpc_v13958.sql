-- The client now consumes current_user_authorization_grants(), which includes
-- ALLOW and DENY effects plus scope/condition metadata. This legacy helper
-- returns only ALLOW keys and cannot represent DENY precedence; it has no
-- application caller and must not remain an alternative authorization source.

REVOKE ALL ON FUNCTION public.current_user_authorization_permissions()
FROM PUBLIC, anon, authenticated;

DO $verify$
BEGIN
  IF has_function_privilege('authenticated','public.current_user_authorization_permissions()','EXECUTE')
     OR has_function_privilege('anon','public.current_user_authorization_permissions()','EXECUTE') THEN
    RAISE EXCEPTION 'Legacy allow-only permission RPC remains executable by clients';
  END IF;

  IF NOT has_function_privilege('authenticated','public.current_user_authorization_grants()','EXECUTE') THEN
    RAISE EXCEPTION 'Current scoped grant RPC was unexpectedly revoked';
  END IF;
END;
$verify$;
