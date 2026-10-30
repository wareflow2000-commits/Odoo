-- Enforce scoped user grants and keep the role permission matrix synchronized
-- with the authorization_grants policy engine.

-- Migrate legacy per-user action grants only when the profile has exactly one
-- explicit warehouse and the action has a known resource type. Ambiguous legacy
-- grants are revoked rather than widened.
UPDATE public.authorization_grants g
SET resource_type=CASE
      WHEN g.permission_key LIKE 'action:transaction:%' THEN 'transaction'
      WHEN g.permission_key LIKE 'action:stocktake:%' THEN 'stocktake_session'
      WHEN g.permission_key LIKE 'action:stock_transfer:%' THEN 'stock_transfer'
      WHEN g.permission_key LIKE 'action:item:%' THEN 'item'
      WHEN g.permission_key LIKE 'action:warehouse:%' THEN 'warehouse'
      WHEN g.permission_key LIKE 'action:users:%' THEN 'profile'
      WHEN g.permission_key LIKE 'action:settings:%' THEN 'system_settings'
      ELSE NULL
    END,
    warehouse_id=p.assigned_warehouse_ids[1],
    scope_type='WAREHOUSE',
    valid_until=COALESCE(g.valid_until,now()+interval '90 days'),
    grant_reason='Migrated legacy custom permission to a warehouse-scoped grant with 90-day review expiry'
FROM public.profiles p
WHERE g.subject_type='USER' AND g.user_id=p.id
  AND g.effect IN ('ALLOW','DENY') AND g.revoked_at IS NULL
  AND g.scope_type='ALL' AND g.resource_type IS NULL AND g.warehouse_id IS NULL
  AND cardinality(COALESCE(p.assigned_warehouse_ids,ARRAY[]::uuid[]))=1
  AND g.permission_key LIKE 'action:%'
  AND CASE
      WHEN g.permission_key LIKE 'action:transaction:%' THEN true
      WHEN g.permission_key LIKE 'action:stocktake:%' THEN true
      WHEN g.permission_key LIKE 'action:stock_transfer:%' THEN true
      WHEN g.permission_key LIKE 'action:item:%' THEN true
      WHEN g.permission_key LIKE 'action:warehouse:%' THEN true
      WHEN g.permission_key LIKE 'action:users:%' THEN true
      WHEN g.permission_key LIKE 'action:settings:%' THEN true
      ELSE false
    END;

UPDATE public.authorization_grants g
SET revoked_at=now(),revoked_by=NULL,
    revocation_reason='Revoked by least-privilege migration; regrant with explicit resource and warehouse scope'
WHERE g.subject_type='USER' AND g.effect IN ('ALLOW','DENY') AND g.revoked_at IS NULL
  AND g.scope_type='ALL'
  AND (g.resource_type IS NULL OR g.warehouse_id IS NULL);

UPDATE public.profiles
SET custom_permissions=ARRAY[]::text[]
WHERE cardinality(COALESCE(custom_permissions,ARRAY[]::text[]))>0;

DO $migration$
DECLARE d text; n text; anchor text;
BEGIN
 SELECT pg_get_functiondef('public.admin_create_authorization_grant_v2(text,text,uuid,text,text,text,uuid,uuid,text,jsonb,timestamptz,timestamptz,text)'::regprocedure) INTO d;
 anchor:='  IF p_subject_type=''USER'' AND (p_user_id IS NULL OR p_role_name IS NOT NULL) THEN' || E'\n' ||
         '    RAISE EXCEPTION ''A user subject is required'';' || E'\n' ||
         '  END IF;';
 n:=replace(d,anchor,anchor || E'\n' ||
   '  IF p_subject_type=''USER'' AND (p_scope_type=''ALL'' OR p_warehouse_id IS NULL OR NULLIF(btrim(COALESCE(p_resource_type,'''')),'''') IS NULL OR p_valid_until IS NULL OR p_valid_until<=now()) THEN' || E'\n' ||
   '    RAISE EXCEPTION ''User grants require a resource type, one warehouse, a bounded data scope, and a future expiry'';' || E'\n' ||
   '  END IF;');
 IF n=d THEN RAISE EXCEPTION 'USER grant scope validation anchor not found'; END IF;
 EXECUTE n;

 SELECT pg_get_functiondef('public.admin_create_authorization_grant_v2(text,text,uuid,text,text,text,uuid,uuid,text,jsonb,timestamptz,timestamptz,text)'::regprocedure) INTO d;
 anchor:='  IF p_subject_type=''USER'' AND (p_scope_type=''ALL'' OR p_warehouse_id IS NULL OR NULLIF(btrim(COALESCE(p_resource_type,'''')),'''') IS NULL) THEN' || E'\\n' ||
         '    RAISE EXCEPTION ''User grants require a resource type, one warehouse, a bounded data scope, and a future expiry'';' || E'\\n' ||
         '  END IF;';
 n:=replace(d,anchor,anchor || E'\\n' ||
   '  IF p_subject_type=''USER'' AND NOT (' || E'\\n' ||
   '    (p_permission_key LIKE ''action:transaction:%'' AND p_resource_type=''transaction'') OR' || E'\\n' ||
   '    (p_permission_key LIKE ''action:stocktake:%'' AND p_resource_type=''stocktake_session'') OR' || E'\\n' ||
   '    (p_permission_key=''action:stock_transfer:create'' AND p_resource_type=''stock_transfer_order'') OR' || E'\\n' ||
   '    (p_permission_key LIKE ''action:stock_transfer:%'' AND p_permission_key<>''action:stock_transfer:create'' AND p_resource_type=''stock_transfer'')' || E'\\n' ||
   '  ) THEN' || E'\\n' ||
   '    RAISE EXCEPTION ''This user permission does not support the selected resource type; use a contextual transaction, stocktake or transfer action'';' || E'\\n' ||
   '  END IF;');
 IF n=d THEN RAISE EXCEPTION 'user permission resource mapping anchor not found'; END IF;
 EXECUTE n;

 EXECUTE $fn$
 CREATE OR REPLACE FUNCTION public.admin_replace_role_permissions(
   p_role_name text,p_permission_keys text[]
 ) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
 AS $body$
 DECLARE
   v_actor_id uuid:=auth.uid();
   v_actor_role text;
   v_actor_status text;
   v_unknown_count integer;
 BEGIN
   PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('orshap:admin_replace_role_permissions'));
   IF v_actor_id IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
   SELECT p.role,p.status INTO v_actor_role,v_actor_status FROM public.profiles p WHERE p.id=v_actor_id;
   IF NOT FOUND OR v_actor_status<>'ACTIVE' OR v_actor_role<>'SUPER_ADMIN' THEN
     RAISE EXCEPTION 'Only an active SUPER_ADMIN may edit role permissions' USING ERRCODE='42501';
   END IF;
   IF p_role_name IS NULL OR p_role_name NOT IN
     ('ADMIN','MANAGER','WAREHOUSE_MANAGER','WAREHOUSE_KEEPER','STOREKEEPER','CLERK','AUDITOR','VIEWER') THEN
     RAISE EXCEPTION 'Unsupported role; SUPER_ADMIN uses the audited break-glass path';
   END IF;
   PERFORM public.authorize_action(
     'action:authorization:manage','role_permissions',NULL,NULL,
     jsonb_build_object('role_name',p_role_name,'operation','replace_role_permissions',
       'permission_keys',to_jsonb(COALESCE(p_permission_keys,ARRAY[]::text[]))),true
   );
   SELECT count(*) INTO v_unknown_count
   FROM (
     SELECT DISTINCT u.k FROM pg_catalog.unnest(COALESCE(p_permission_keys,ARRAY[]::text[])) u(k)
     WHERE u.k IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.permissions p WHERE p.key=u.k)
   ) unknown_keys;
   IF v_unknown_count>0 THEN RAISE EXCEPTION 'One or more permission keys are unknown'; END IF;

   -- The AFTER trigger on role_permissions is the single synchronization
   -- path into authorization_grants, including revocation history.
   DELETE FROM public.role_permissions rp WHERE rp.role_name=p_role_name;
   INSERT INTO public.role_permissions(role_name,permission_key)
   SELECT p_role_name,keys.k
   FROM (SELECT DISTINCT u.k FROM pg_catalog.unnest(COALESCE(p_permission_keys,ARRAY[]::text[])) u(k)
         WHERE u.k IS NOT NULL) keys;
 END;
 $body$;
 $fn$;

 SELECT pg_get_functiondef('public.admin_update_profile(uuid,text,text,text[],boolean,uuid[])'::regprocedure) INTO d;
 anchor:='    PERFORM public.authorize_action(''action:users:manage'',''profile'',p_target_user_id,NULL,jsonb_build_object(''operation'',''update_profile''),true);';
 n:=replace(d,anchor,anchor || E'\n' ||
   '    IF p_custom_permissions IS NOT NULL THEN' || E'\n' ||
   '      RAISE EXCEPTION ''Per-user permissions must be created as scoped authorization grants'' USING ERRCODE=''42501'';' || E'\n' ||
   '    END IF;');
 IF n=d THEN RAISE EXCEPTION 'admin_update_profile custom permission rejection anchor not found'; END IF;
 EXECUTE n;

 SELECT pg_get_functiondef('public.admin_save_role_access_config(text,text[],text,uuid[])'::regprocedure) INTO d;
 n:=replace(d,'''SUPER_ADMIN'',''ADMIN'',''MANAGER'',''WAREHOUSE_MANAGER'',','''ADMIN'',''MANAGER'',''WAREHOUSE_MANAGER'',');
 IF n=d THEN RAISE EXCEPTION 'role access SUPER_ADMIN exclusion anchor not found'; END IF;
 EXECUTE n;

 EXECUTE $replace$
 CREATE OR REPLACE FUNCTION public.sync_profile_permissions_to_authorization_grants()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
 AS $body$
 BEGIN
   IF NEW.custom_permissions IS DISTINCT FROM OLD.custom_permissions THEN
     RAISE EXCEPTION 'Legacy custom_permissions are disabled; create a scoped authorization grant instead'
       USING ERRCODE='42501';
   END IF;
   RETURN NEW;
 END;
 $body$;
 $replace$;
END;
$migration$;
