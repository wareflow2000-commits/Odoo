CREATE OR REPLACE FUNCTION public.current_user_authorization_permissions()
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE v_user_id uuid := auth.uid(); v_permissions text[];
BEGIN
 IF v_user_id IS NULL OR NOT public.current_user_is_active() THEN RETURN ARRAY[]::text[]; END IF;
 SELECT COALESCE(array_agg(DISTINCT g.permission_key ORDER BY g.permission_key),ARRAY[]::text[])
 INTO v_permissions
 FROM public.authorization_grants g
 JOIN public.profiles p ON p.id=v_user_id AND p.status='ACTIVE'
 WHERE g.effect='ALLOW' AND g.revoked_at IS NULL AND g.valid_from<=now()
 AND (g.valid_until IS NULL OR g.valid_until>now())
 AND ((g.subject_type='USER' AND g.user_id=v_user_id) OR (g.subject_type='ROLE' AND g.role_name=p.role));
 RETURN COALESCE(v_permissions,ARRAY[]::text[]);
END;
$function$;

REVOKE ALL ON FUNCTION public.current_user_authorization_permissions() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.current_user_authorization_permissions() TO authenticated;
