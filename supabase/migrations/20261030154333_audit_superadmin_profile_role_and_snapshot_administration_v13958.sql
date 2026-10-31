INSERT INTO public.permissions(key,description) VALUES
 ('action:authorization:manage','Administer institutional authorization grants and role access policies'),
 ('action:system:snapshot:export','Export a full WMS database snapshot'),
 ('action:system:snapshot:import','Restore a full WMS database snapshot')
ON CONFLICT(key) DO UPDATE SET description=EXCLUDED.description;

DO $migration$
DECLARE d text; n text; p1 integer; p2 integer; p_end integer;
BEGIN
 SELECT pg_get_functiondef('public.admin_link_profile(text,text,text,text,uuid[])'::regprocedure) INTO d;
 p1:=position(lower('Only SUPER_ADMIN may link profiles') in lower(d));
 p2:=position('end if;' in lower(substring(d from p1)));
 IF p1=0 OR p2=0 THEN RAISE EXCEPTION 'admin_link_profile role guard not found'; END IF;
 p_end:=p1+p2+6;
 n:=left(d,p_end)||E'\n PERFORM public.authorize_action(''action:users:manage'',''profile'',NULL,NULL,jsonb_build_object(''operation'',''link_profile'',''email'',lower(btrim(p_email))),true);'||substr(d,p_end+1);
 EXECUTE n;

 SELECT pg_get_functiondef('public.admin_update_profile(uuid,text,text,text[],boolean,uuid[])'::regprocedure) INTO d;
 p1:=position(lower('Only SUPER_ADMIN may administer profiles') in lower(d));
 p2:=position('end if;' in lower(substring(d from p1)));
 IF p1=0 OR p2=0 THEN RAISE EXCEPTION 'admin_update_profile role guard not found'; END IF;
 p_end:=p1+p2+6;
 n:=left(d,p_end)||E'\n PERFORM public.authorize_action(''action:users:manage'',''profile'',p_target_user_id,NULL,jsonb_build_object(''operation'',''update_profile''),true);'||substr(d,p_end+1);
 EXECUTE n;

 SELECT pg_get_functiondef('public.admin_replace_role_permissions(text,text[])'::regprocedure) INTO d;
 p1:=position(lower('Only SUPER_ADMIN may edit role permissions') in lower(d));
 p2:=position('end if;' in lower(substring(d from p1)));
 IF p1=0 OR p2=0 THEN RAISE EXCEPTION 'admin_replace_role_permissions role guard not found'; END IF;
 p_end:=p1+p2+6;
 n:=left(d,p_end)||E'\n PERFORM public.authorize_action(''action:authorization:manage'',''role_permissions'',NULL,NULL,jsonb_build_object(''role_name'',p_role_name,''operation'',''replace_role_permissions''),true);'||substr(d,p_end+1);
 EXECUTE n;

 SELECT pg_get_functiondef('public.admin_replace_role_warehouse_scope(text,text,uuid[])'::regprocedure) INTO d;
 p1:=position(lower('Only an active SUPER_ADMIN may edit role warehouse scopes') in lower(d));
 p2:=position('end if;' in lower(substring(d from p1)));
 IF p1=0 OR p2=0 THEN RAISE EXCEPTION 'admin_replace_role_warehouse_scope role guard not found'; END IF;
 p_end:=p1+p2+6;
 n:=left(d,p_end)||E'\n PERFORM public.authorize_action(''action:authorization:manage'',''role_warehouse_scope'',NULL,NULL,jsonb_build_object(''role_name'',p_role_name,''scope_mode'',p_scope_mode),true);'||substr(d,p_end+1);
 EXECUTE n;

 SELECT pg_get_functiondef('public.admin_save_role_access_config(text,text[],text,uuid[])'::regprocedure) INTO d;
 p1:=position(lower('Only an active SUPER_ADMIN may edit role access configuration') in lower(d));
 p2:=position('end if;' in lower(substring(d from p1)));
 IF p1=0 OR p2=0 THEN RAISE EXCEPTION 'admin_save_role_access_config role guard not found'; END IF;
 p_end:=p1+p2+6;
 n:=left(d,p_end)||E'\n PERFORM public.authorize_action(''action:authorization:manage'',''role_access_config'',NULL,NULL,jsonb_build_object(''role_name'',p_role_name,''scope_mode'',p_scope_mode),true);'||substr(d,p_end+1);
 EXECUTE n;

 SELECT pg_get_functiondef('public.admin_create_authorization_grant(text,text,uuid,text,text,text,uuid,text,jsonb,timestamptz,timestamptz,text)'::regprocedure) INTO d;
 p1:=position(lower('Only an active SUPER_ADMIN may administer authorization grants') in lower(d));
 p2:=position('end if;' in lower(substring(d from p1)));
 IF p1=0 OR p2=0 THEN RAISE EXCEPTION 'admin_create_authorization_grant role guard not found'; END IF;
 p_end:=p1+p2+6;
 n:=left(d,p_end)||E'\n PERFORM public.authorize_action(''action:authorization:manage'',''authorization_grant'',NULL,NULL,jsonb_build_object(''operation'',''create'',''permission_key'',p_permission_key),true);'||substr(d,p_end+1);
 EXECUTE n;

 SELECT pg_get_functiondef('public.admin_create_authorization_grant_v2(text,text,uuid,text,text,text,uuid,uuid,text,jsonb,timestamptz,timestamptz,text)'::regprocedure) INTO d;
 p1:=position(lower('Only an active SUPER_ADMIN may administer authorization grants') in lower(d));
 p2:=position('end if;' in lower(substring(d from p1)));
 IF p1=0 OR p2=0 THEN RAISE EXCEPTION 'admin_create_authorization_grant_v2 role guard not found'; END IF;
 p_end:=p1+p2+6;
 n:=left(d,p_end)||E'\n PERFORM public.authorize_action(''action:authorization:manage'',''authorization_grant'',NULL,NULL,jsonb_build_object(''operation'',''create'',''permission_key'',p_permission_key),true);'||substr(d,p_end+1);
 EXECUTE n;

 SELECT pg_get_functiondef('public.admin_revoke_authorization_grant(uuid,text)'::regprocedure) INTO d;
 p1:=position(lower('Only an active SUPER_ADMIN may administer authorization grants') in lower(d));
 p2:=position('end if;' in lower(substring(d from p1)));
 IF p1=0 OR p2=0 THEN RAISE EXCEPTION 'admin_revoke_authorization_grant role guard not found'; END IF;
 p_end:=p1+p2+6;
 n:=left(d,p_end)||E'\n PERFORM public.authorize_action(''action:authorization:manage'',''authorization_grant'',p_grant_id,NULL,jsonb_build_object(''operation'',''revoke''),true);'||substr(d,p_end+1);
 EXECUTE n;

 SELECT pg_get_functiondef('public.export_wms_snapshot()'::regprocedure) INTO d;
 p1:=position('SNAPSHOT_SUPER_ADMIN_REQUIRED' in d);
 p2:=position('end if;' in lower(substring(d from p1)));
 IF p1=0 OR p2=0 THEN RAISE EXCEPTION 'export snapshot role guard not found'; END IF;
 p_end:=p1+p2+6;
 n:=left(d,p_end)||E'\n PERFORM public.authorize_action(''action:system:snapshot:export'',''system_snapshot'',NULL,NULL,jsonb_build_object(''operation'',''export''),true);'||substr(d,p_end+1);
 EXECUTE n;

 SELECT pg_get_functiondef('public.import_wms_snapshot(jsonb,text)'::regprocedure) INTO d;
 p1:=position('SNAPSHOT_SUPER_ADMIN_REQUIRED' in d);
 p2:=position('end if;' in lower(substring(d from p1)));
 IF p1=0 OR p2=0 THEN RAISE EXCEPTION 'import snapshot role guard not found'; END IF;
 p_end:=p1+p2+6;
 n:=left(d,p_end)||E'\n PERFORM public.authorize_action(''action:system:snapshot:import'',''system_snapshot'',NULL,NULL,jsonb_build_object(''operation'',''import''),true);'||substr(d,p_end+1);
 EXECUTE n;
END;
$migration$;
