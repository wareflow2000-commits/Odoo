-- Posted vouchers are immutable regardless of caller JWT context.
-- A service-role/server maintenance request must not silently bypass the
-- accounting freeze. Pending-record maintenance remains available to trusted
-- server routines when auth.uid() is NULL.
CREATE OR REPLACE FUNCTION public.guard_transaction_header_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF OLD.status = 'APPROVED' THEN
    RAISE EXCEPTION 'POSTED_TRANSACTION_IMMUTABLE: approved transaction headers cannot be changed or deleted'
      USING ERRCODE = '23514';
  END IF;

  IF (SELECT auth.uid()) IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.reference_no IS DISTINCT FROM OLD.reference_no
     OR NEW.transaction_type IS DISTINCT FROM OLD.transaction_type
     OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'TRANSACTION_IDENTITY_IMMUTABLE: voucher identity fields cannot be rewritten'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;
