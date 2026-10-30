-- ORSHAP WMS v13.9.58
-- Route transaction writes through audited SECURITY DEFINER RPC workflows.
-- Freeze approved voucher headers and every line column after posting.
-- Pending voucher identity is immutable; workflow-owned status/rejection fields
-- remain governed by their existing RPC and status guard.

CREATE OR REPLACE FUNCTION public.guard_transaction_header_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  -- Trusted server maintenance without an end-user JWT remains available.
  IF (SELECT auth.uid()) IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'APPROVED' THEN
    RAISE EXCEPTION 'POSTED_TRANSACTION_IMMUTABLE: approved transaction headers cannot be changed or deleted'
      USING ERRCODE = '23514';
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

DROP TRIGGER IF EXISTS trg_guard_transaction_header_integrity ON public.transactions;
CREATE TRIGGER trg_guard_transaction_header_integrity
BEFORE UPDATE OR DELETE ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.guard_transaction_header_integrity();

CREATE OR REPLACE FUNCTION public.guard_posted_transaction_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_tx_id uuid;
  v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_tx_id := OLD.transaction_id;
  ELSE
    v_tx_id := NEW.transaction_id;
  END IF;

  SELECT t.status INTO v_status
  FROM public.transactions AS t
  WHERE t.id = v_tx_id;

  IF v_status = 'APPROVED' THEN
    RAISE EXCEPTION 'POSTED_TRANSACTION_LINE_IMMUTABLE: approved transaction lines cannot be changed or deleted'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

-- Authenticated clients must use create_transaction_with_lines_v2 and the
-- dedicated approve/reject RPCs. The v2 SECURITY DEFINER wrapper can still
-- invoke the legacy SECURITY DEFINER implementation as its owner.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.transactions FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.transaction_lines FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.create_transaction_with_lines(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;

-- Explicitly keep read access and the supported workflow entry points.
GRANT SELECT ON TABLE public.transactions, public.transaction_lines TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_transaction_with_lines_v2(uuid, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_transaction(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_transaction(uuid, text) TO authenticated;
