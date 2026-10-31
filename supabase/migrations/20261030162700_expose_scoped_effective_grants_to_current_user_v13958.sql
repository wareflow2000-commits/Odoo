CREATE OR REPLACE FUNCTION public.current_user_authorization_grants()
RETURNS TABLE(
 id uuid,
 subject_type text,
 permission_key text,
 effect text,
 resource_type text,
 resource_id uuid,
 warehouse_id uuid,
 scope_type text,
 conditions jsonb,
 valid_from timestamptz,
 valid_until timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE v_user_id uuid:=auth.uid();
BEGIN
 IF v_user_id IS NULL OR NOT public.current_user_is_active() THEN RETURN; END IF;
 RETURN QUERY
 SELECT g.id,g.subject_type,g.permission_key,g.effect,g.resource_type,g.resource_id,
        g.warehouse_id,g.scope_type,g.conditions,g.valid_from,g.valid_until
 FROM public.authorization_grants g
 JOIN public.profiles p ON p.id=v_user_id AND p.status='ACTIVE'
 WHERE g.revoked_at IS NULL
   AND g.valid_from<=now() AND (g.valid_until IS NULL OR g.valid_until>now())
   AND ((g.subject_type='USER' AND g.user_id=v_user_id)
     OR (g.subject_type='ROLE' AND g.role_name=p.role))
 ORDER BY CASE WHEN g.subject_type='USER' THEN 0 ELSE 1 END,g.created_at DESC;
END;
$function$;
REVOKE ALL ON FUNCTION public.current_user_authorization_grants() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.current_user_authorization_grants() TO authenticated;
COMMENT ON FUNCTION public.current_user_authorization_grants() IS
'Returns only active role and user authorization grants applicable to auth.uid(); used for client-side contextual UI hints. Database authorization remains authoritative.';
