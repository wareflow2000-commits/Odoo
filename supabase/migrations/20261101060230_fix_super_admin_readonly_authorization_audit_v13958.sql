-- Fix SUPER_ADMIN RLS reads: preserve break-glass audit in writable
-- transactions, but never INSERT an audit row from a read-only PostgREST
-- transaction (RLS permission probes and STABLE read RPCs).
CREATE OR REPLACE FUNCTION public.authorize_action(
  p_action_key text,
  p_resource_type text DEFAULT NULL::text,
  p_resource_id uuid DEFAULT NULL::uuid,
  p_warehouse_id uuid DEFAULT NULL::uuid,
  p_context jsonb DEFAULT '{}'::jsonb,
  p_log_decision boolean DEFAULT true
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_role text;
  v_status text;
  v_allow_id uuid;
  v_deny_id uuid;
  v_decision text := 'DENY';
  v_reason text := 'NO_MATCHING_ALLOW_GRANT';
  v_break_glass boolean := false;
  v_context jsonb := COALESCE(p_context, '{}'::jsonb);
BEGIN
  IF v_user_id IS NULL OR p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(v_context) <> 'object' THEN
    RAISE EXCEPTION 'Authorization context must be a JSON object' USING ERRCODE='22023';
  END IF;

  SELECT p.role,p.status INTO v_role,v_status
  FROM public.profiles p
  WHERE p.id=v_user_id;

  IF NOT FOUND OR v_status <> 'ACTIVE' THEN
    v_reason := 'INACTIVE_OR_MISSING_PROFILE';
  ELSIF p_warehouse_id IS NOT NULL AND NOT public.current_user_can_access_warehouse(p_warehouse_id) THEN
    v_reason := 'WAREHOUSE_SCOPE_DENIED';
  ELSIF v_role='SUPER_ADMIN' THEN
    v_decision := 'ALLOW';
    v_reason := 'SUPER_ADMIN_BREAK_GLASS';
    v_break_glass := true;
  ELSE
    SELECT g.id INTO v_deny_id
    FROM public.authorization_grants g
    WHERE g.effect='DENY'
      AND g.permission_key=p_action_key
      AND g.revoked_at IS NULL
      AND g.valid_from <= now()
      AND (g.valid_until IS NULL OR g.valid_until > now())
      AND ((g.subject_type='USER' AND g.user_id=v_user_id)
        OR (g.subject_type='ROLE' AND g.role_name=v_role))
      AND (g.resource_type IS NULL OR g.resource_type=p_resource_type)
      AND (g.resource_id IS NULL OR g.resource_id=p_resource_id)
      AND (g.warehouse_id IS NULL OR g.warehouse_id=p_warehouse_id)
      AND (g.scope_type='ALL'
        OR (g.scope_type='OWN' AND v_context->>'owner_id'=v_user_id::text)
        OR (g.scope_type='WAREHOUSE' AND p_warehouse_id=g.warehouse_id)
        OR (g.scope_type='CONTEXT' AND COALESCE(g.conditions,'{}'::jsonb)<>'{}'::jsonb))
      AND (COALESCE(g.conditions,'{}'::jsonb)='{}'::jsonb OR v_context @> g.conditions)
    ORDER BY CASE WHEN g.subject_type='USER' THEN 0 ELSE 1 END,
             CASE WHEN g.warehouse_id IS NOT NULL THEN 0 ELSE 1 END
    LIMIT 1;

    IF v_deny_id IS NOT NULL THEN
      v_reason := 'EXPLICIT_DENY_GRANT';
    ELSE
      SELECT g.id INTO v_allow_id
      FROM public.authorization_grants g
      WHERE g.effect='ALLOW'
        AND g.permission_key=p_action_key
        AND g.revoked_at IS NULL
        AND g.valid_from <= now()
        AND (g.valid_until IS NULL OR g.valid_until > now())
        AND ((g.subject_type='USER' AND g.user_id=v_user_id)
          OR (g.subject_type='ROLE' AND g.role_name=v_role))
        AND (g.resource_type IS NULL OR g.resource_type=p_resource_type)
        AND (g.resource_id IS NULL OR g.resource_id=p_resource_id)
        AND (g.warehouse_id IS NULL OR g.warehouse_id=p_warehouse_id)
        AND (g.scope_type='ALL'
          OR (g.scope_type='OWN' AND v_context->>'owner_id'=v_user_id::text)
          OR (g.scope_type='WAREHOUSE' AND p_warehouse_id=g.warehouse_id)
          OR (g.scope_type='CONTEXT' AND COALESCE(g.conditions,'{}'::jsonb)<>'{}'::jsonb))
        AND (COALESCE(g.conditions,'{}'::jsonb)='{}'::jsonb OR v_context @> g.conditions)
      ORDER BY CASE WHEN g.subject_type='USER' THEN 0 ELSE 1 END,
               CASE WHEN g.warehouse_id IS NOT NULL THEN 0 ELSE 1 END
      LIMIT 1;

      IF v_allow_id IS NOT NULL THEN
        v_decision := 'ALLOW';
        v_reason := 'EXPLICIT_ALLOW_GRANT';
      END IF;
    END IF;
  END IF;

  -- Explicit authorization calls remain fully audited. RLS/read-only permission
  -- probes must not attempt INSERTs; PostgreSQL rejects writes in read-only
  -- PostgREST transactions. Preserve implicit break-glass audit in writable
  -- transactions only.
  IF p_log_decision OR (
    v_break_glass
    AND COALESCE(current_setting('transaction_read_only', true), 'off') <> 'on'
  ) THEN
    INSERT INTO public.authorization_decisions
      (transaction_id,decision_fingerprint,actor_user_id,action_key,resource_type,resource_id,warehouse_id,decision,decision_reason,matched_grant_id,break_glass,context)
    VALUES (
      txid_current(),
      md5(jsonb_build_object(
        'actor_user_id',v_user_id,
        'action_key',p_action_key,
        'resource_type',p_resource_type,
        'resource_id',p_resource_id,
        'warehouse_id',p_warehouse_id,
        'decision',v_decision,
        'decision_reason',v_reason,
        'matched_grant_id',COALESCE(v_deny_id,v_allow_id),
        'break_glass',v_break_glass,
        'context',v_context
      )::text),
      v_user_id,p_action_key,p_resource_type,p_resource_id,p_warehouse_id,
      v_decision,v_reason,COALESCE(v_deny_id,v_allow_id),v_break_glass,v_context
    )
    ON CONFLICT (transaction_id,decision_fingerprint) DO NOTHING;
  END IF;

  RETURN v_decision='ALLOW';
END;
$function$;
