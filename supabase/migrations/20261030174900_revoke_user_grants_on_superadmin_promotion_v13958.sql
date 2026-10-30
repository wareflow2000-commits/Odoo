-- User-specific grants must not survive promotion to SUPER_ADMIN.
-- Serialize grant creation against profile promotion to close the check/write race.
CREATE OR REPLACE FUNCTION public.revoke_user_authorization_grants_on_superadmin_promotion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NEW.role = 'SUPER_ADMIN' AND OLD.role IS DISTINCT FROM NEW.role THEN
    UPDATE public.authorization_grants
       SET revoked_at = now(),
           revoked_by = auth.uid(),
           revocation_reason = 'Revoked because the subject was promoted to SUPER_ADMIN'
     WHERE subject_type = 'USER'
       AND user_id = NEW.id
       AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.revoke_user_authorization_grants_on_superadmin_promotion()
FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_revoke_user_grants_on_superadmin_promotion ON public.profiles;
CREATE TRIGGER profiles_revoke_user_grants_on_superadmin_promotion
AFTER UPDATE OF role ON public.profiles
FOR EACH ROW
WHEN (OLD.role IS DISTINCT FROM NEW.role AND NEW.role = 'SUPER_ADMIN')
EXECUTE FUNCTION public.revoke_user_authorization_grants_on_superadmin_promotion();

DO $migration$
DECLARE
  v_definition text;
  v_updated text;
  v_old_declaration text := 'DECLARE v_actor_role text; v_actor_status text; v_id uuid;';
  v_new_declaration text := 'DECLARE v_actor_role text; v_actor_status text; v_target_role text; v_id uuid;';
  v_user_subject_guard text := E'  IF p_subject_type=''USER'' AND (p_user_id IS NULL OR p_role_name IS NOT NULL) THEN\n' ||
    '    RAISE EXCEPTION ''A user subject is required'';' || E'\n' ||
    '  END IF;';
  v_locked_target_guard text := E'  IF p_subject_type=''USER'' THEN\n' ||
    '    SELECT p.role INTO v_target_role FROM public.profiles p WHERE p.id=p_user_id FOR UPDATE;' || E'\n' ||
    '    IF NOT FOUND OR v_target_role=''SUPER_ADMIN'' THEN' || E'\n' ||
    '      RAISE EXCEPTION ''Target user profile not found or is a SUPER_ADMIN'' USING ERRCODE=''42501'';' || E'\n' ||
    '    END IF;' || E'\n' ||
    '  END IF;';
BEGIN
  SELECT pg_get_functiondef(
    'public.admin_create_authorization_grant_v2(text,text,uuid,text,text,text,uuid,uuid,text,jsonb,timestamptz,timestamptz,text)'::regprocedure
  ) INTO v_definition;

  IF position('FOR UPDATE' IN v_definition) = 0 THEN
    IF position(v_old_declaration IN v_definition) = 0 THEN
      RAISE EXCEPTION 'Authorization grant function declaration did not match';
    END IF;
    v_updated := replace(v_definition, v_old_declaration, v_new_declaration);
    IF v_updated = v_definition THEN
      RAISE EXCEPTION 'Could not add target-role lock variable';
    END IF;

    IF position(v_user_subject_guard IN v_updated) = 0 THEN
      RAISE EXCEPTION 'Authorization user-subject guard did not match';
    END IF;
    v_updated := replace(v_updated, v_user_subject_guard, v_user_subject_guard || E'\n' || v_locked_target_guard);
    IF v_updated = v_definition THEN
      RAISE EXCEPTION 'Could not add serialized target-role validation';
    END IF;
    EXECUTE v_updated;
  END IF;
END;
$migration$;

DO $verify$
DECLARE
  v_grant_definition text;
  v_trigger_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.admin_create_authorization_grant_v2(text,text,uuid,text,text,text,uuid,uuid,text,jsonb,timestamptz,timestamptz,text)'::regprocedure
  ) INTO v_grant_definition;

  IF position('FOR UPDATE' IN v_grant_definition) = 0
     OR position('v_target_role=''SUPER_ADMIN''' IN v_grant_definition) = 0 THEN
    RAISE EXCEPTION 'Concurrent SUPER_ADMIN grant-creation guard verification failed';
  END IF;

  SELECT pg_get_triggerdef(t.oid)
    INTO v_trigger_definition
  FROM pg_trigger t
  WHERE t.tgrelid = 'public.profiles'::regclass
    AND t.tgname = 'profiles_revoke_user_grants_on_superadmin_promotion'
    AND NOT t.tgisinternal;

  IF v_trigger_definition IS NULL
     OR position('UPDATE OF role' IN v_trigger_definition) = 0
     OR position('SUPER_ADMIN' IN v_trigger_definition) = 0 THEN
    RAISE EXCEPTION 'SUPER_ADMIN promotion grant-revocation trigger verification failed';
  END IF;
END;
$verify$;
