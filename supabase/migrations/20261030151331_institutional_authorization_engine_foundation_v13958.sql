-- Institutional authorization foundation for Odoo WMS.
-- Additive phase: preserve the currently active authorization path until all
-- RPC/RLS/UI callers have been migrated and verified.

CREATE TABLE IF NOT EXISTS public.authorization_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('ROLE','USER')),
  role_name text,
  user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES public.permissions(key) ON UPDATE CASCADE,
  resource_type text,
  warehouse_id uuid REFERENCES public.warehouses(id) ON DELETE CASCADE,
  effect text NOT NULL DEFAULT 'ALLOW' CHECK (effect IN ('ALLOW','DENY')),
  scope_type text NOT NULL DEFAULT 'ALL'
    CHECK (scope_type IN ('ALL','OWN','WAREHOUSE','CONTEXT')),
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(conditions) = 'object'),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  granted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  grant_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT authorization_grants_subject_shape CHECK (
    (subject_type = 'ROLE' AND role_name IS NOT NULL AND user_id IS NULL)
    OR
    (subject_type = 'USER' AND user_id IS NOT NULL AND role_name IS NULL)
  ),
  CONSTRAINT authorization_grants_validity CHECK (
    valid_until IS NULL OR valid_until > valid_from
  ),
  CONSTRAINT authorization_grants_scope_shape CHECK (
    (scope_type <> 'WAREHOUSE' OR warehouse_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS authorization_grants_role_lookup_idx
  ON public.authorization_grants(role_name, permission_key, effect)
  WHERE subject_type = 'ROLE' AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS authorization_grants_user_lookup_idx
  ON public.authorization_grants(user_id, permission_key, effect)
  WHERE subject_type = 'USER' AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS authorization_grants_warehouse_lookup_idx
  ON public.authorization_grants(warehouse_id, permission_key)
  WHERE warehouse_id IS NOT NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.authorization_decisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  action_key text NOT NULL,
  resource_type text,
  resource_id uuid,
  warehouse_id uuid,
  decision text NOT NULL CHECK (decision IN ('ALLOW','DENY')),
  decision_reason text NOT NULL,
  matched_grant_id uuid REFERENCES public.authorization_grants(id) ON DELETE SET NULL,
  break_glass boolean NOT NULL DEFAULT false,
  context jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(context) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS authorization_decisions_actor_time_idx
  ON public.authorization_decisions(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS authorization_decisions_action_time_idx
  ON public.authorization_decisions(action_key, created_at DESC);
CREATE INDEX IF NOT EXISTS authorization_decisions_break_glass_idx
  ON public.authorization_decisions(created_at DESC)
  WHERE break_glass;

ALTER TABLE public.authorization_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.authorization_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.authorization_grants FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.authorization_decisions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.authorization_decisions_id_seq FROM PUBLIC, anon, authenticated;

-- Migrate existing explicit grants only. No implicit MANAGER/ADMIN grants are
-- created. SUPER_ADMIN remains the separately audited break-glass principal.
INSERT INTO public.authorization_grants
  (subject_type, role_name, permission_key, effect, scope_type, grant_reason)
SELECT 'ROLE', rp.role_name, rp.permission_key, 'ALLOW', 'ALL',
       'Imported from existing explicit role_permissions during authorization engine rollout'
FROM public.role_permissions rp
WHERE rp.role_name <> 'SUPER_ADMIN'
  AND NOT EXISTS (
    SELECT 1 FROM public.authorization_grants g
    WHERE g.subject_type = 'ROLE'
      AND g.role_name = rp.role_name
      AND g.permission_key = rp.permission_key
      AND g.effect = 'ALLOW'
      AND g.resource_type IS NULL
      AND g.warehouse_id IS NULL
      AND g.scope_type = 'ALL'
      AND g.revoked_at IS NULL
  );

INSERT INTO public.authorization_grants
  (subject_type, user_id, permission_key, effect, scope_type, grant_reason)
SELECT 'USER', p.id, cp.permission_key, 'ALLOW', 'ALL',
       'Imported from existing explicit profiles.custom_permissions during authorization engine rollout'
FROM public.profiles p
CROSS JOIN LATERAL unnest(COALESCE(p.custom_permissions, ARRAY[]::text[])) AS cp(permission_key)
JOIN public.permissions perm ON perm.key = cp.permission_key
WHERE p.status = 'ACTIVE'
  AND p.role <> 'SUPER_ADMIN'
  AND NOT EXISTS (
    SELECT 1 FROM public.authorization_grants g
    WHERE g.subject_type = 'USER'
      AND g.user_id = p.id
      AND g.permission_key = cp.permission_key
      AND g.effect = 'ALLOW'
      AND g.resource_type IS NULL
      AND g.warehouse_id IS NULL
      AND g.scope_type = 'ALL'
      AND g.revoked_at IS NULL
  );

CREATE OR REPLACE FUNCTION public.authorize_action(
  p_action_key text,
  p_resource_type text DEFAULT NULL,
  p_resource_id uuid DEFAULT NULL,
  p_warehouse_id uuid DEFAULT NULL,
  p_context jsonb DEFAULT '{}'::jsonb,
  p_log_decision boolean DEFAULT true
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
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
    RAISE EXCEPTION 'Authorization context must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  SELECT p.role, p.status INTO v_role, v_status
  FROM public.profiles p
  WHERE p.id = v_user_id;

  IF NOT FOUND OR v_status <> 'ACTIVE' THEN
    v_reason := 'INACTIVE_OR_MISSING_PROFILE';
  ELSIF p_warehouse_id IS NOT NULL
        AND NOT public.current_user_can_access_warehouse(p_warehouse_id) THEN
    v_reason := 'WAREHOUSE_SCOPE_DENIED';
  ELSIF v_role = 'SUPER_ADMIN' THEN
    v_decision := 'ALLOW';
    v_reason := 'SUPER_ADMIN_BREAK_GLASS';
    v_break_glass := true;
  ELSE
    SELECT g.id INTO v_deny_id
    FROM public.authorization_grants g
    WHERE g.effect = 'DENY'
      AND g.permission_key = p_action_key
      AND g.revoked_at IS NULL
      AND g.valid_from <= now()
      AND (g.valid_until IS NULL OR g.valid_until > now())
      AND (g.subject_type = 'USER' AND g.user_id = v_user_id
           OR g.subject_type = 'ROLE' AND g.role_name = v_role)
      AND (g.resource_type IS NULL OR g.resource_type = p_resource_type)
      AND (g.warehouse_id IS NULL OR g.warehouse_id = p_warehouse_id)
      AND (
        g.scope_type = 'ALL'
        OR (g.scope_type = 'OWN' AND v_context->>'owner_id' = v_user_id::text)
        OR (g.scope_type = 'WAREHOUSE' AND p_warehouse_id = g.warehouse_id)
        OR (g.scope_type = 'CONTEXT' AND v_context @> g.conditions)
      )
    ORDER BY CASE WHEN g.subject_type = 'USER' THEN 0 ELSE 1 END,
             CASE WHEN g.warehouse_id IS NOT NULL THEN 0 ELSE 1 END
    LIMIT 1;

    IF v_deny_id IS NOT NULL THEN
      v_reason := 'EXPLICIT_DENY_GRANT';
    ELSE
      SELECT g.id INTO v_allow_id
      FROM public.authorization_grants g
      WHERE g.effect = 'ALLOW'
        AND g.permission_key = p_action_key
        AND g.revoked_at IS NULL
        AND g.valid_from <= now()
        AND (g.valid_until IS NULL OR g.valid_until > now())
        AND (g.subject_type = 'USER' AND g.user_id = v_user_id
             OR g.subject_type = 'ROLE' AND g.role_name = v_role)
        AND (g.resource_type IS NULL OR g.resource_type = p_resource_type)
        AND (g.warehouse_id IS NULL OR g.warehouse_id = p_warehouse_id)
        AND (
          g.scope_type = 'ALL'
          OR (g.scope_type = 'OWN' AND v_context->>'owner_id' = v_user_id::text)
          OR (g.scope_type = 'WAREHOUSE' AND p_warehouse_id = g.warehouse_id)
          OR (g.scope_type = 'CONTEXT' AND v_context @> g.conditions)
        )
      ORDER BY CASE WHEN g.subject_type = 'USER' THEN 0 ELSE 1 END,
               CASE WHEN g.warehouse_id IS NOT NULL THEN 0 ELSE 1 END
      LIMIT 1;

      IF v_allow_id IS NOT NULL THEN
        v_decision := 'ALLOW';
        v_reason := 'EXPLICIT_ALLOW_GRANT';
      END IF;
    END IF;
  END IF;

  IF p_log_decision THEN
    INSERT INTO public.authorization_decisions
      (actor_user_id, action_key, resource_type, resource_id, warehouse_id,
       decision, decision_reason, matched_grant_id, break_glass, context)
    VALUES
      (v_user_id, p_action_key, p_resource_type, p_resource_id, p_warehouse_id,
       v_decision, v_reason, COALESCE(v_deny_id, v_allow_id), v_break_glass,
       v_context);
  END IF;

  RETURN v_decision = 'ALLOW';
END;
$function$;

REVOKE ALL ON FUNCTION public.authorize_action(text,text,uuid,uuid,jsonb,boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.authorize_action(text,text,uuid,uuid,jsonb,boolean)
  TO authenticated;
