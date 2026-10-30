DO $migration$
DECLARE d text; n text;
BEGIN
 SELECT pg_get_functiondef('public.admin_create_authorization_grant_v2(text,text,uuid,text,text,text,uuid,uuid,text,jsonb,timestamptz,timestamptz,text)'::regprocedure) INTO d;
 n := replace(d,
  'IF p_subject_type=''ROLE'' AND (p_role_name IS NULL OR p_user_id IS NOT NULL OR p_role_name=''SUPER_ADMIN'') THEN',
  'IF p_subject_type=''ROLE'' AND (p_role_name IS NULL OR p_user_id IS NOT NULL OR p_role_name NOT IN (''ADMIN'',''MANAGER'',''WAREHOUSE_MANAGER'',''WAREHOUSE_KEEPER'',''STOREKEEPER'',''CLERK'',''AUDITOR'',''VIEWER'')) THEN');
 IF n=d THEN RAISE EXCEPTION 'authorization role subject validation not found'; END IF;
 d:=n;
 n:=replace(d,
  '  IF p_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=p_user_id) THEN' || E'\n' ||
  '    RAISE EXCEPTION ''Target user profile not found'';' || E'\n' ||
  '  END IF;',
  '  IF p_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=p_user_id AND p.role<>''SUPER_ADMIN'') THEN' || E'\n' ||
  '    RAISE EXCEPTION ''Target user profile not found or is a SUPER_ADMIN'';' || E'\n' ||
  '  END IF;');
 IF n=d THEN RAISE EXCEPTION 'authorization target user validation not found'; END IF;
 EXECUTE n;
END;
$migration$;
