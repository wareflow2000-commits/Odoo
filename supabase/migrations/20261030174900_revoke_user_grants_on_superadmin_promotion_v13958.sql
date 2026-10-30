-- User-specific grants must not survive promotion to SUPER_ADMIN.
-- SUPER_ADMIN uses the audited global break-glass path, not delegated user grants.
DO $migration$
DECLARE
  v_definition text;
  v_updated text;
  v_old_guard text := 'IF NEW.custom_permissions IS NOT DISTINCT FROM OLD.custom_permissions THEN RETURN NEW; END IF;';
  v_new_guard text := 'IF NEW.custom_permissions IS NOT DISTINCT FROM OLD.custom_permissions AND NEW.role IS NOT DISTINCT FROM OLD.role THEN RETURN NEW; END IF;';
  v_superadmin_guard text := E'IF NEW.role = ''SUPER_ADMIN'' THEN\n' ||
    '    UPDATE public.authorization_grants' || E'\n' ||
    '       SET revoked_at = now(), revoked_by = auth.uid(),' || E'\n' ||
    '           revocation_reason = ''Revoked because the subject was promoted to SUPER_ADMIN''' || E'\n' ||
    '     WHERE subject_type = ''USER'' AND user_id = NEW.id AND revoked_at IS NULL;' || E'\n' ||
    '    RETURN NEW;' || E'\n' ||
    '  END IF;' || E'\n';
BEGIN
  SELECT pg_get_functiondef(
    'public.sync_profile_permissions_to_authorization_grants()'::regprocedure
  ) INTO v_definition;

  IF position(v_superadmin_guard IN v_definition) = 0 THEN
    IF position(v_old_guard IN v_definition) > 0 THEN
      v_updated := replace(v_definition, v_old_guard, v_new_guard || E'\n  ' || v_superadmin_guard);
      IF v_updated = v_definition THEN
        RAISE EXCEPTION 'Could not add SUPER_ADMIN user-grant guard';
      END IF;
      EXECUTE v_updated;
    ELSIF position(v_new_guard IN v_definition) = 0 THEN
      RAISE EXCEPTION 'User permission synchronization guard did not match';
    ELSE
      RAISE EXCEPTION 'Unexpected sync function state; refusing partial update';
    END IF;
  END IF;
END;
$migration$;

DROP TRIGGER IF EXISTS profiles_authorization_grants_sync ON public.profiles;
CREATE TRIGGER profiles_authorization_grants_sync
AFTER UPDATE OF custom_permissions, role ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.sync_profile_permissions_to_authorization_grants();

DO $verify$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.sync_profile_permissions_to_authorization_grants()'::regprocedure
  ) INTO v_definition;

  IF position('NEW.role = ''SUPER_ADMIN''' IN v_definition) = 0
     OR position('Revoked because the subject was promoted to SUPER_ADMIN' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'SUPER_ADMIN grant revocation verification failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    WHERE t.tgrelid = 'public.profiles'::regclass
      AND t.tgname = 'profiles_authorization_grants_sync'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Profile authorization grant synchronization trigger is missing';
  END IF;
END;
$verify$;
