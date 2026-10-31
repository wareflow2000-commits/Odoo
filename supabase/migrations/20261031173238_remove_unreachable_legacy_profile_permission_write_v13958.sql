-- Remove the unreachable legacy custom_permissions write from admin_update_profile.
-- The RPC rejects non-NULL p_custom_permissions above; user-specific access must use scoped grants.
DO $migration$
DECLARE
  v_definition text;
  v_updated text;
  v_pattern text := '-- Apply explicit user-level overrides after any role-change trigger has executed\.[[:space:]]*if p_custom_permissions is not null[[:space:]]+or p_can_approve_without_workflow is not null then[[:space:]]+update public\.profiles p[[:space:]]+set custom_permissions = coalesce\(p_custom_permissions, p\.custom_permissions\),[[:space:]]+can_approve_without_workflow =[[:space:]]+coalesce\(p_can_approve_without_workflow, p\.can_approve_without_workflow\)[[:space:]]+where p\.id = p_target_user_id;[[:space:]]+end if;';
  v_replacement text := 'IF p_can_approve_without_workflow IS NOT NULL THEN UPDATE public.profiles p SET can_approve_without_workflow = p_can_approve_without_workflow WHERE p.id = p_target_user_id; END IF;';
BEGIN
  SELECT pg_get_functiondef(
    'public.admin_update_profile(uuid,text,text,text[],boolean,uuid[])'::regprocedure
  ) INTO v_definition;

  v_updated := regexp_replace(v_definition, v_pattern, v_replacement, 'i');
  IF v_updated = v_definition THEN
    IF position('custom_permissions = coalesce(p_custom_permissions' IN v_definition) = 0 THEN
      RAISE EXCEPTION 'Legacy custom permission assignment is already absent; refusing unexpected function state';
    END IF;
    RAISE EXCEPTION 'Could not match legacy unreachable custom permission block';
  END IF;

  IF position('custom_permissions = coalesce(p_custom_permissions' IN v_updated) > 0
     OR (position('p_custom_permissions IS NOT NULL' IN v_updated) = 0
         AND position('p_custom_permissions is not null' IN v_updated) = 0)
     OR position('can_approve_without_workflow = p_can_approve_without_workflow' IN v_updated) = 0 THEN
    RAISE EXCEPTION 'admin_update_profile cleanup verification failed';
  END IF;

  EXECUTE v_updated;
END;
$migration$;

DO $verify$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.admin_update_profile(uuid,text,text,text[],boolean,uuid[])'::regprocedure
  ) INTO v_definition;

  IF position('custom_permissions = coalesce(p_custom_permissions' IN v_definition) > 0
     OR (position('p_custom_permissions IS NOT NULL' IN v_definition) = 0
         AND position('p_custom_permissions is not null' IN v_definition) = 0)
     OR position('can_approve_without_workflow = p_can_approve_without_workflow' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'admin_update_profile cleanup postcondition failed';
  END IF;
END;
$verify$;
