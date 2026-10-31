ALTER TABLE public.authorization_grants
  ADD COLUMN IF NOT EXISTS revocation_reason text;

CREATE TABLE IF NOT EXISTS public.authorization_grant_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  grant_id uuid REFERENCES public.authorization_grants(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN ('CREATED','REVOKED','UPDATED')),
  actor_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  subject_type text,
  role_name text,
  user_id uuid,
  permission_key text,
  effect text,
  reason text,
  old_values jsonb,
  new_values jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS authorization_grant_events_time_idx ON public.authorization_grant_events(created_at DESC);
CREATE INDEX IF NOT EXISTS authorization_grant_events_subject_idx ON public.authorization_grant_events(subject_type,role_name,user_id,created_at DESC);
ALTER TABLE public.authorization_grant_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.authorization_grant_events FROM PUBLIC,anon,authenticated;
REVOKE ALL ON SEQUENCE public.authorization_grant_events_id_seq FROM PUBLIC,anon,authenticated;
CREATE POLICY authorization_grant_events_deny_client_access
ON public.authorization_grant_events FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);

CREATE OR REPLACE FUNCTION public.log_authorization_grant_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_event text;
BEGIN
  IF TG_OP='INSERT' THEN
    v_event := 'CREATED';
    INSERT INTO public.authorization_grant_events
      (grant_id,event_type,actor_user_id,subject_type,role_name,user_id,permission_key,effect,reason,new_values)
    VALUES (NEW.id,v_event,auth.uid(),NEW.subject_type,NEW.role_name,NEW.user_id,NEW.permission_key,NEW.effect,NEW.grant_reason,to_jsonb(NEW));
    RETURN NEW;
  ELSIF TG_OP='UPDATE' THEN
    v_event := CASE WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN 'REVOKED' ELSE 'UPDATED' END;
    INSERT INTO public.authorization_grant_events
      (grant_id,event_type,actor_user_id,subject_type,role_name,user_id,permission_key,effect,reason,old_values,new_values)
    VALUES (NEW.id,v_event,auth.uid(),NEW.subject_type,NEW.role_name,NEW.user_id,NEW.permission_key,NEW.effect,
      COALESCE(NEW.revocation_reason,NEW.grant_reason),to_jsonb(OLD),to_jsonb(NEW));
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS authorization_grant_change_audit ON public.authorization_grants;
CREATE TRIGGER authorization_grant_change_audit AFTER INSERT OR UPDATE ON public.authorization_grants
FOR EACH ROW EXECUTE FUNCTION public.log_authorization_grant_change();

CREATE OR REPLACE FUNCTION public.sync_role_permission_to_authorization_grants()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP IN ('DELETE','UPDATE') THEN
    UPDATE public.authorization_grants
       SET revoked_at=now(),revoked_by=auth.uid(),
           revocation_reason='Revoked because the explicit role permission was removed'
     WHERE subject_type='ROLE' AND role_name=OLD.role_name AND permission_key=OLD.permission_key
       AND effect='ALLOW' AND resource_type IS NULL AND warehouse_id IS NULL AND scope_type='ALL'
       AND revoked_at IS NULL
       AND grant_reason IN (
         'Imported from existing explicit role_permissions during authorization engine rollout',
         'Synchronized from role_permissions'
       );
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') AND NEW.role_name <> 'SUPER_ADMIN' THEN
    INSERT INTO public.authorization_grants
      (subject_type,role_name,permission_key,effect,scope_type,granted_by,grant_reason)
    SELECT 'ROLE',NEW.role_name,NEW.permission_key,'ALLOW','ALL',auth.uid(),'Synchronized from role_permissions'
    WHERE NOT EXISTS (
      SELECT 1 FROM public.authorization_grants g
      WHERE g.subject_type='ROLE' AND g.role_name=NEW.role_name AND g.permission_key=NEW.permission_key
        AND g.effect='ALLOW' AND g.resource_type IS NULL AND g.warehouse_id IS NULL
        AND g.scope_type='ALL' AND g.revoked_at IS NULL
    );
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS role_permissions_authorization_grants_sync ON public.role_permissions;
CREATE TRIGGER role_permissions_authorization_grants_sync AFTER INSERT OR UPDATE OR DELETE ON public.role_permissions
FOR EACH ROW EXECUTE FUNCTION public.sync_role_permission_to_authorization_grants();

CREATE OR REPLACE FUNCTION public.sync_profile_permissions_to_authorization_grants()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
BEGIN
  IF NEW.custom_permissions IS NOT DISTINCT FROM OLD.custom_permissions THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(COALESCE(NEW.custom_permissions,ARRAY[]::text[])) AS cp(permission_key)
    WHERE NOT EXISTS (SELECT 1 FROM public.permissions p WHERE p.key=cp.permission_key)
  ) THEN RAISE EXCEPTION 'One or more user permissions are unknown'; END IF;

  UPDATE public.authorization_grants
     SET revoked_at=now(),revoked_by=auth.uid(),
         revocation_reason='Revoked because the explicit user permission was removed'
   WHERE subject_type='USER' AND user_id=NEW.id AND effect='ALLOW'
     AND resource_type IS NULL AND warehouse_id IS NULL AND scope_type='ALL' AND revoked_at IS NULL
     AND grant_reason IN (
       'Imported from existing explicit profiles.custom_permissions during authorization engine rollout',
       'Synchronized from profiles.custom_permissions'
     );

  INSERT INTO public.authorization_grants
    (subject_type,user_id,permission_key,effect,scope_type,granted_by,grant_reason)
  SELECT 'USER',NEW.id,cp.permission_key,'ALLOW','ALL',auth.uid(),'Synchronized from profiles.custom_permissions'
  FROM unnest(COALESCE(NEW.custom_permissions,ARRAY[]::text[])) AS cp(permission_key)
  JOIN public.permissions p ON p.key=cp.permission_key
  WHERE NOT EXISTS (
    SELECT 1 FROM public.authorization_grants g
    WHERE g.subject_type='USER' AND g.user_id=NEW.id AND g.permission_key=cp.permission_key
      AND g.effect='ALLOW' AND g.resource_type IS NULL AND g.warehouse_id IS NULL
      AND g.scope_type='ALL' AND g.revoked_at IS NULL
  );
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS profiles_authorization_grants_sync ON public.profiles;
CREATE TRIGGER profiles_authorization_grants_sync AFTER UPDATE OF custom_permissions ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.sync_profile_permissions_to_authorization_grants();

CREATE OR REPLACE FUNCTION public.admin_create_authorization_grant(
  p_subject_type text,p_role_name text,p_user_id uuid,p_permission_key text,
  p_effect text DEFAULT 'ALLOW',p_resource_type text DEFAULT NULL,p_warehouse_id uuid DEFAULT NULL,
  p_scope_type text DEFAULT 'ALL',p_conditions jsonb DEFAULT '{}'::jsonb,
  p_valid_from timestamptz DEFAULT now(),p_valid_until timestamptz DEFAULT NULL,p_reason text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_actor_role text; v_actor_status text; v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  SELECT p.role,p.status INTO v_actor_role,v_actor_status FROM public.profiles p WHERE p.id=auth.uid();
  IF NOT FOUND OR v_actor_status<>'ACTIVE' OR v_actor_role<>'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Only an active SUPER_ADMIN may administer authorization grants' USING ERRCODE='42501';
  END IF;
  p_subject_type := upper(COALESCE(p_subject_type,''));
  p_effect := upper(COALESCE(p_effect,''));
  p_scope_type := upper(COALESCE(p_scope_type,''));
  IF p_subject_type NOT IN ('ROLE','USER') THEN RAISE EXCEPTION 'Invalid authorization subject type'; END IF;
  IF p_effect NOT IN ('ALLOW','DENY') THEN RAISE EXCEPTION 'Invalid authorization effect'; END IF;
  IF p_scope_type NOT IN ('ALL','OWN','WAREHOUSE','CONTEXT') THEN RAISE EXCEPTION 'Invalid authorization scope'; END IF;
  IF p_subject_type='ROLE' AND (p_role_name IS NULL OR p_user_id IS NOT NULL OR p_role_name='SUPER_ADMIN') THEN
    RAISE EXCEPTION 'A non-super-admin role subject is required';
  END IF;
  IF p_subject_type='USER' AND (p_user_id IS NULL OR p_role_name IS NOT NULL) THEN RAISE EXCEPTION 'A user subject is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.permissions p WHERE p.key=p_permission_key) THEN RAISE EXCEPTION 'Unknown permission key'; END IF;
  IF p_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=p_user_id) THEN RAISE EXCEPTION 'Target user profile not found'; END IF;
  IF p_warehouse_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.warehouses w WHERE w.id=p_warehouse_id) THEN RAISE EXCEPTION 'Target warehouse not found'; END IF;
  IF p_scope_type='WAREHOUSE' AND p_warehouse_id IS NULL THEN RAISE EXCEPTION 'WAREHOUSE scope requires a warehouse'; END IF;
  IF p_scope_type='CONTEXT' AND (p_conditions IS NULL OR jsonb_typeof(p_conditions)<>'object' OR p_conditions='{}'::jsonb) THEN
    RAISE EXCEPTION 'CONTEXT scope requires non-empty JSON conditions';
  END IF;
  IF p_valid_from IS NULL OR (p_valid_until IS NOT NULL AND p_valid_until<=p_valid_from) THEN RAISE EXCEPTION 'Invalid authorization grant validity window'; END IF;
  IF NULLIF(btrim(COALESCE(p_reason,'')),'') IS NULL THEN RAISE EXCEPTION 'A reason is required for every authorization grant'; END IF;
  INSERT INTO public.authorization_grants
    (subject_type,role_name,user_id,permission_key,resource_type,warehouse_id,effect,scope_type,conditions,valid_from,valid_until,granted_by,grant_reason)
  VALUES
    (p_subject_type,p_role_name,p_user_id,p_permission_key,NULLIF(btrim(p_resource_type),''),p_warehouse_id,p_effect,p_scope_type,
     COALESCE(p_conditions,'{}'::jsonb),p_valid_from,p_valid_until,auth.uid(),btrim(p_reason))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_revoke_authorization_grant(p_grant_id uuid,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_actor_role text; v_actor_status text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  SELECT p.role,p.status INTO v_actor_role,v_actor_status FROM public.profiles p WHERE p.id=auth.uid();
  IF NOT FOUND OR v_actor_status<>'ACTIVE' OR v_actor_role<>'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Only an active SUPER_ADMIN may administer authorization grants' USING ERRCODE='42501';
  END IF;
  IF NULLIF(btrim(COALESCE(p_reason,'')),'') IS NULL THEN RAISE EXCEPTION 'A revocation reason is required'; END IF;
  UPDATE public.authorization_grants SET revoked_at=now(),revoked_by=auth.uid(),revocation_reason=btrim(p_reason)
  WHERE id=p_grant_id AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active authorization grant not found'; END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.log_authorization_grant_change() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.sync_role_permission_to_authorization_grants() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.sync_profile_permissions_to_authorization_grants() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.admin_create_authorization_grant(text,text,uuid,text,text,text,uuid,text,jsonb,timestamptz,timestamptz,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.admin_revoke_authorization_grant(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_create_authorization_grant(text,text,uuid,text,text,text,uuid,text,jsonb,timestamptz,timestamptz,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_revoke_authorization_grant(uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.current_user_can_create_warehouse()
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO ''
AS $function$
 SELECT EXISTS (
   SELECT 1 FROM public.profiles p
   WHERE p.id=(SELECT auth.uid()) AND p.status='ACTIVE'
     AND cardinality(COALESCE(p.assigned_warehouse_ids,ARRAY[]::uuid[]))=0
     AND public.current_user_has_permission('action:warehouse:manage')
 );
$function$;

DO $cleanup$
DECLARE d text; n text;
BEGIN
 SELECT pg_get_functiondef('public.approve_transaction(uuid)'::regprocedure) INTO d;
 n := replace(d, '  v_require_approval boolean := true;' || E'\n', '');
 IF n=d THEN RAISE EXCEPTION 'approval setting variable not found for cleanup'; END IF;
 d := n;
 n := regexp_replace(d,
   '  SELECT upper\(btrim\(COALESCE\(s\.value, ''TRUE''\)\)\) <> ''FALSE''\s+INTO v_require_approval\s+FROM public\.system_settings s\s+WHERE s\.key = ''REQUIRE_APPROVAL'';\s+v_require_approval := COALESCE\(v_require_approval, true\);\s+',
   '', 'g');
 IF n=d THEN RAISE EXCEPTION 'approval setting lookup not found for cleanup'; END IF;
 d := n;
 n := replace(d,
   '-- creator self-approval: elevated role only when workflow is globally disabled, otherwise explicit per-user grant',
   '-- Self-approval requires the explicit auto-approval grant and user-level flag.');
 IF n=d THEN RAISE EXCEPTION 'stale self-approval comment not found'; END IF;
 EXECUTE n;
END;
$cleanup$;
