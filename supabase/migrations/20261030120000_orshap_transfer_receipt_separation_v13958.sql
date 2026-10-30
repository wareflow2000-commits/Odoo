-- A transfer dispatcher/requester must not also attest physical receipt.
-- Apply this at the row boundary so every receipt RPC shares the same rule.

CREATE OR REPLACE FUNCTION public.guard_stock_transfer_receipt_separation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
BEGIN
  IF v_actor IS NOT NULL
     AND NEW.received_quantity > OLD.received_quantity
     AND v_actor IN (OLD.created_by, OLD.dispatched_by) THEN
    RAISE EXCEPTION 'Transfer creator/dispatcher cannot receive their own transfer'
      USING ERRCODE = '42501';
  END IF;

  IF v_actor IS NOT NULL
     AND NEW.return_confirmed_by IS DISTINCT FROM OLD.return_confirmed_by
     AND NEW.return_confirmed_by = v_actor
     AND OLD.return_requested_by = v_actor THEN
    RAISE EXCEPTION 'Return requester cannot confirm physical receipt of their own return'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_guard_stock_transfer_receipt_separation
  ON public.stock_transfers;

CREATE TRIGGER trg_guard_stock_transfer_receipt_separation
BEFORE UPDATE OF received_quantity, return_confirmed_by
ON public.stock_transfers
FOR EACH ROW
EXECUTE FUNCTION public.guard_stock_transfer_receipt_separation();
