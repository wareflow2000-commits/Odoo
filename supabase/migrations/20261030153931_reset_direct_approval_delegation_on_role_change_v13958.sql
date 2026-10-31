CREATE OR REPLACE FUNCTION public.reset_self_approval_flag_on_role_change()
RETURNS trigger LANGUAGE plpgsql SET search_path TO ''
AS $function$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    NEW.can_approve_without_workflow := false;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS reset_self_approval_flag_on_role_change ON public.profiles;
CREATE TRIGGER reset_self_approval_flag_on_role_change
BEFORE UPDATE OF role ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.reset_self_approval_flag_on_role_change();

REVOKE ALL ON FUNCTION public.reset_self_approval_flag_on_role_change() FROM PUBLIC,anon,authenticated;
