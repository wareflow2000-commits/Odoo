-- Keep the transaction status trigger aligned with the contextual authorization
-- engine used by approve_transaction. The trigger remains SECURITY INVOKER and
-- emits no duplicate decision record; the approval RPC records the decision.
DO $migration$
DECLARE
  v_guard text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef('public.guard_transaction_status_change()'::regprocedure)
    INTO v_guard;

  v_old := '    v_has_auto_approve_permission :=
      public.current_user_has_permission(''action:transaction:auto_approve'');';
  v_new := '    v_has_auto_approve_permission :=
      public.authorize_action(
        ''action:transaction:auto_approve'',
        ''transaction'',
        NEW.id,
        NEW.warehouse_id,
        jsonb_build_object(''owner_id'', NEW.created_by, ''status'', OLD.status,
                           ''transaction_type'', NEW.transaction_type),
        false
      );';

  IF position(v_new IN v_guard) = 0 THEN
    IF position(v_old IN v_guard) = 0 THEN
      RAISE EXCEPTION 'Self-approval status guard auto-approval check mismatch; no changes applied';
    END IF;
    v_guard := replace(v_guard, v_old, v_new);
  END IF;

  v_old := '    v_has_create_permission := public.current_user_has_permission(v_create_permission);';
  v_new := '    v_has_create_permission := public.authorize_action(
      v_create_permission,
      ''transaction'',
      NEW.id,
      NEW.warehouse_id,
      jsonb_build_object(''owner_id'', NEW.created_by, ''status'', OLD.status,
                         ''transaction_type'', NEW.transaction_type),
      false
    );';

  IF position(v_new IN v_guard) = 0 THEN
    IF position(v_old IN v_guard) = 0 THEN
      RAISE EXCEPTION 'Self-approval status guard create-permission check mismatch; no changes applied';
    END IF;
    v_guard := replace(v_guard, v_old, v_new);
  END IF;

  EXECUTE v_guard;
END;
$migration$;

DO $verify$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef('public.guard_transaction_status_change()'::regprocedure)
    INTO v_definition;

  IF position('public.authorize_action(''action:transaction:auto_approve'',' IN v_definition) = 0
     OR position('public.authorize_action(
      v_create_permission,' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Self-approval status guard is not using contextual authorization';
  END IF;

  IF position('public.current_user_has_permission(''action:transaction:auto_approve'')' IN v_definition) > 0
     OR position('public.current_user_has_permission(v_create_permission)' IN v_definition) > 0 THEN
    RAISE EXCEPTION 'Legacy context-free self-approval checks remain in the status guard';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.guard_transaction_status_change()'::regprocedure
      AND prosecdef = false
  ) THEN
    RAISE EXCEPTION 'Transaction status guard must remain SECURITY INVOKER';
  END IF;
END;
$verify$;
