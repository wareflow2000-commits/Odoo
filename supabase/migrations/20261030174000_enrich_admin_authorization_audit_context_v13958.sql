-- Record the requested profile and role-scope changes in the authorization
-- decision context. The authorization_decisions row is committed atomically with
-- the administrative mutation and identifies the actor, action, and target.
DO $migration$
DECLARE
  d text;
  n text;
  old_fragment text;
  new_fragment text;
BEGIN
  SELECT pg_get_functiondef('public.admin_update_profile(uuid,text,text,text[],boolean,uuid[])'::regprocedure) INTO d;
  old_fragment := 'jsonb_build_object(''operation'',''update_profile'')';
  new_fragment := 'jsonb_build_object(
      ''operation'',''update_profile'',
      ''requested_role'',p_role,
      ''requested_status'',p_status,
      ''requested_can_approve_without_workflow'',p_can_approve_without_workflow,
      ''requested_assigned_warehouse_ids'',to_jsonb(COALESCE(p_assigned_warehouse_ids,ARRAY[]::uuid[]))
    )';
  IF position(new_fragment IN d)=0 THEN
    IF position(old_fragment IN d)=0 THEN RAISE EXCEPTION 'admin_update_profile audit context mismatch'; END IF;
    d:=replace(d,old_fragment,new_fragment);
  END IF;
  EXECUTE d;

  SELECT pg_get_functiondef('public.admin_link_profile(text,text,text,text,uuid[])'::regprocedure) INTO d;
  old_fragment := 'jsonb_build_object(''operation'',''link_profile'',''email'',lower(btrim(p_email)))';
  new_fragment := 'jsonb_build_object(
      ''operation'',''link_profile'',
      ''email'',lower(btrim(p_email)),
      ''requested_role'',COALESCE(p_role,''CLERK''),
      ''requested_status'',COALESCE(p_status,''PENDING''),
      ''requested_warehouse_ids'',to_jsonb(COALESCE(p_warehouse_ids,ARRAY[]::uuid[]))
    )';
  IF position(new_fragment IN d)=0 THEN
    IF position(old_fragment IN d)=0 THEN RAISE EXCEPTION 'admin_link_profile audit context mismatch'; END IF;
    d:=replace(d,old_fragment,new_fragment);
  END IF;
  EXECUTE d;

  SELECT pg_get_functiondef('public.admin_replace_role_warehouse_scope(text,text,uuid[])'::regprocedure) INTO d;
  old_fragment := 'jsonb_build_object(''role_name'',p_role_name,''scope_mode'',p_scope_mode)';
  new_fragment := 'jsonb_build_object(
      ''role_name'',p_role_name,
      ''scope_mode'',p_scope_mode,
      ''requested_warehouse_ids'',to_jsonb(COALESCE(p_warehouse_ids,ARRAY[]::uuid[]))
    )';
  IF position(new_fragment IN d)=0 THEN
    IF position(old_fragment IN d)=0 THEN RAISE EXCEPTION 'admin_replace_role_warehouse_scope audit context mismatch'; END IF;
    d:=replace(d,old_fragment,new_fragment);
  END IF;
  EXECUTE d;

  SELECT pg_get_functiondef('public.admin_save_role_access_config(text,text[],text,uuid[])'::regprocedure) INTO d;
  old_fragment := 'jsonb_build_object(''role_name'',p_role_name,''scope_mode'',p_scope_mode)';
  new_fragment := 'jsonb_build_object(
      ''role_name'',p_role_name,
      ''scope_mode'',p_scope_mode,
      ''requested_permission_keys'',to_jsonb(COALESCE(p_permission_keys,ARRAY[]::text[])),
      ''requested_warehouse_ids'',to_jsonb(COALESCE(p_warehouse_ids,ARRAY[]::uuid[]))
    )';
  IF position(new_fragment IN d)=0 THEN
    IF position(old_fragment IN d)=0 THEN RAISE EXCEPTION 'admin_save_role_access_config audit context mismatch'; END IF;
    d:=replace(d,old_fragment,new_fragment);
  END IF;
  EXECUTE d;
END;
$migration$;

DO $verify$
DECLARE
  profile_def text;
  link_def text;
  warehouse_def text;
  role_config_def text;
BEGIN
  SELECT pg_get_functiondef('public.admin_update_profile(uuid,text,text,text[],boolean,uuid[])'::regprocedure) INTO profile_def;
  SELECT pg_get_functiondef('public.admin_link_profile(text,text,text,text,uuid[])'::regprocedure) INTO link_def;
  SELECT pg_get_functiondef('public.admin_replace_role_warehouse_scope(text,text,uuid[])'::regprocedure) INTO warehouse_def;
  SELECT pg_get_functiondef('public.admin_save_role_access_config(text,text[],text,uuid[])'::regprocedure) INTO role_config_def;

  IF position('requested_can_approve_without_workflow' IN profile_def)=0
     OR position('requested_assigned_warehouse_ids' IN profile_def)=0
     OR position('requested_role' IN link_def)=0
     OR position('requested_warehouse_ids' IN warehouse_def)=0
     OR position('requested_permission_keys' IN role_config_def)=0
     OR position('requested_warehouse_ids' IN role_config_def)=0 THEN
    RAISE EXCEPTION 'Administrative authorization audit context verification failed';
  END IF;
END;
$verify$;
