ALTER TABLE public.authorization_grants ADD COLUMN IF NOT EXISTS resource_id uuid;
ALTER TABLE public.authorization_grants DROP CONSTRAINT IF EXISTS authorization_grants_resource_shape;
ALTER TABLE public.authorization_grants ADD CONSTRAINT authorization_grants_resource_shape
CHECK (resource_id IS NULL OR resource_type IS NOT NULL);
CREATE INDEX IF NOT EXISTS authorization_grants_resource_lookup_idx
ON public.authorization_grants(resource_type,resource_id,permission_key)
WHERE resource_id IS NOT NULL AND revoked_at IS NULL;

DO $migration$
DECLARE d text; n text;
BEGIN
 SELECT pg_get_functiondef('public.authorize_action(text,text,uuid,uuid,jsonb,boolean)'::regprocedure) INTO d;
 n := replace(d,
   'AND (g.resource_type IS NULL OR g.resource_type=p_resource_type)',
   'AND (g.resource_type IS NULL OR g.resource_type=p_resource_type)' || E'\n' ||
   '      AND (g.resource_id IS NULL OR g.resource_id=p_resource_id)');
 IF n=d OR (length(n)-length(d)) < 100 THEN RAISE EXCEPTION 'authorization resource-id predicate insertion failed'; END IF;
 EXECUTE n;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.admin_create_authorization_grant_v2(
 p_subject_type text,p_role_name text,p_user_id uuid,p_permission_key text,p_effect text,
 p_resource_type text,p_resource_id uuid,p_warehouse_id uuid,p_scope_type text,
 p_conditions jsonb,p_valid_from timestamptz,p_valid_until timestamptz,p_reason text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_actor_role text; v_actor_status text; v_id uuid;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
 SELECT p.role,p.status INTO v_actor_role,v_actor_status FROM public.profiles p WHERE p.id=auth.uid();
 IF NOT FOUND OR v_actor_status<>'ACTIVE' OR v_actor_role<>'SUPER_ADMIN' THEN
  RAISE EXCEPTION 'Only an active SUPER_ADMIN may administer authorization grants' USING ERRCODE='42501';
 END IF;
 p_subject_type:=upper(COALESCE(p_subject_type,''));
 p_effect:=upper(COALESCE(p_effect,''));
 p_scope_type:=upper(COALESCE(p_scope_type,''));
 IF p_subject_type NOT IN ('ROLE','USER') OR p_effect NOT IN ('ALLOW','DENY') OR p_scope_type NOT IN ('ALL','OWN','WAREHOUSE','CONTEXT') THEN
  RAISE EXCEPTION 'Invalid authorization subject, effect, or scope';
 END IF;
 IF p_subject_type='ROLE' AND (p_role_name IS NULL OR p_user_id IS NOT NULL OR p_role_name='SUPER_ADMIN') THEN RAISE EXCEPTION 'A non-super-admin role subject is required'; END IF;
 IF p_subject_type='USER' AND (p_user_id IS NULL OR p_role_name IS NOT NULL) THEN RAISE EXCEPTION 'A user subject is required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.permissions p WHERE p.key=p_permission_key) THEN RAISE EXCEPTION 'Unknown permission key'; END IF;
 IF p_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=p_user_id) THEN RAISE EXCEPTION 'Target user profile not found'; END IF;
 IF p_warehouse_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.warehouses w WHERE w.id=p_warehouse_id) THEN RAISE EXCEPTION 'Target warehouse not found'; END IF;
 IF p_resource_id IS NOT NULL AND NULLIF(btrim(COALESCE(p_resource_type,'')),'') IS NULL THEN RAISE EXCEPTION 'Resource type is required when resource id is specified'; END IF;
 IF p_scope_type='WAREHOUSE' AND p_warehouse_id IS NULL THEN RAISE EXCEPTION 'WAREHOUSE scope requires a warehouse'; END IF;
 IF p_scope_type='CONTEXT' AND (p_conditions IS NULL OR jsonb_typeof(p_conditions)<>'object' OR p_conditions='{}'::jsonb) THEN RAISE EXCEPTION 'CONTEXT scope requires non-empty JSON conditions'; END IF;
 IF p_valid_from IS NULL OR (p_valid_until IS NOT NULL AND p_valid_until<=p_valid_from) THEN RAISE EXCEPTION 'Invalid authorization grant validity window'; END IF;
 IF NULLIF(btrim(COALESCE(p_reason,'')),'') IS NULL THEN RAISE EXCEPTION 'A reason is required for every authorization grant'; END IF;
 INSERT INTO public.authorization_grants
  (subject_type,role_name,user_id,permission_key,resource_type,resource_id,warehouse_id,effect,scope_type,conditions,valid_from,valid_until,granted_by,grant_reason)
 VALUES
  (p_subject_type,p_role_name,p_user_id,p_permission_key,NULLIF(btrim(p_resource_type),''),p_resource_id,p_warehouse_id,
   p_effect,p_scope_type,COALESCE(p_conditions,'{}'::jsonb),p_valid_from,p_valid_until,auth.uid(),btrim(p_reason))
 RETURNING id INTO v_id;
 RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_list_authorization_grants(
 p_subject_type text DEFAULT NULL,p_role_name text DEFAULT NULL,p_user_id uuid DEFAULT NULL,
 p_active_only boolean DEFAULT true,p_limit integer DEFAULT 250
) RETURNS TABLE(
 id uuid,subject_type text,role_name text,user_id uuid,permission_key text,resource_type text,resource_id uuid,
 warehouse_id uuid,effect text,scope_type text,conditions jsonb,valid_from timestamptz,valid_until timestamptz,
 granted_by uuid,grant_reason text,created_at timestamptz,revoked_at timestamptz,revoked_by uuid,revocation_reason text
) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_role text; v_status text;
BEGIN
 SELECT p.role,p.status INTO v_role,v_status FROM public.profiles p WHERE p.id=auth.uid();
 IF auth.uid() IS NULL OR NOT FOUND OR v_status<>'ACTIVE' OR v_role<>'SUPER_ADMIN' THEN
  RAISE EXCEPTION 'Only an active SUPER_ADMIN may list authorization grants' USING ERRCODE='42501';
 END IF;
 RETURN QUERY
 SELECT g.id,g.subject_type,g.role_name,g.user_id,g.permission_key,g.resource_type,g.resource_id,g.warehouse_id,
  g.effect,g.scope_type,g.conditions,g.valid_from,g.valid_until,g.granted_by,g.grant_reason,g.created_at,
  g.revoked_at,g.revoked_by,g.revocation_reason
 FROM public.authorization_grants g
 WHERE (p_subject_type IS NULL OR g.subject_type=upper(p_subject_type))
  AND (p_role_name IS NULL OR g.role_name=p_role_name)
  AND (p_user_id IS NULL OR g.user_id=p_user_id)
  AND (NOT COALESCE(p_active_only,true) OR g.revoked_at IS NULL)
 ORDER BY g.created_at DESC LIMIT GREATEST(1,LEAST(COALESCE(p_limit,250),1000));
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_list_authorization_decisions(
 p_since timestamptz DEFAULT now()-interval '30 days',p_actor_user_id uuid DEFAULT NULL,p_limit integer DEFAULT 250
) RETURNS TABLE(
 id bigint,actor_user_id uuid,action_key text,resource_type text,resource_id uuid,warehouse_id uuid,
 decision text,decision_reason text,matched_grant_id uuid,break_glass boolean,context jsonb,created_at timestamptz
) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_role text; v_status text;
BEGIN
 SELECT p.role,p.status INTO v_role,v_status FROM public.profiles p WHERE p.id=auth.uid();
 IF auth.uid() IS NULL OR NOT FOUND OR v_status<>'ACTIVE' OR v_role<>'SUPER_ADMIN' THEN
  RAISE EXCEPTION 'Only an active SUPER_ADMIN may list authorization decisions' USING ERRCODE='42501';
 END IF;
 RETURN QUERY
 SELECT d.id,d.actor_user_id,d.action_key,d.resource_type,d.resource_id,d.warehouse_id,d.decision,
  d.decision_reason,d.matched_grant_id,d.break_glass,d.context,d.created_at
 FROM public.authorization_decisions d
 WHERE d.created_at>=COALESCE(p_since,now()-interval '30 days')
  AND (p_actor_user_id IS NULL OR d.actor_user_id=p_actor_user_id)
 ORDER BY d.created_at DESC LIMIT GREATEST(1,LEAST(COALESCE(p_limit,250),1000));
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_create_authorization_grant_v2(text,text,uuid,text,text,text,uuid,uuid,text,jsonb,timestamptz,timestamptz,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.admin_list_authorization_grants(text,text,uuid,boolean,integer) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.admin_list_authorization_decisions(timestamptz,uuid,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_create_authorization_grant_v2(text,text,uuid,text,text,text,uuid,uuid,text,jsonb,timestamptz,timestamptz,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_authorization_grants(text,text,uuid,boolean,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_authorization_decisions(timestamptz,uuid,integer) TO authenticated;
