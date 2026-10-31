-- Close the remaining posted-line immutability gap.
-- INSERT was not covered by the prior UPDATE/DELETE trigger. Check both parent
-- vouchers on UPDATE so a line cannot be moved into or out of a posted voucher.
CREATE OR REPLACE FUNCTION public.guard_posted_transaction_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_old_status text;
  v_new_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT t.status INTO v_old_status
    FROM public.transactions t
    WHERE t.id = OLD.transaction_id;

    IF v_old_status = 'APPROVED' THEN
      RAISE EXCEPTION 'POSTED_TRANSACTION_LINE_IMMUTABLE: approved lines cannot be changed or deleted'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    SELECT t.status INTO v_new_status
    FROM public.transactions t
    WHERE t.id = NEW.transaction_id;

    IF v_new_status = 'APPROVED' THEN
      RAISE EXCEPTION 'POSTED_TRANSACTION_LINE_IMMUTABLE: lines cannot be inserted into or moved into an approved transaction'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_guard_posted_transaction_line ON public.transaction_lines;
CREATE TRIGGER trg_guard_posted_transaction_line
BEFORE INSERT OR UPDATE OR DELETE ON public.transaction_lines
FOR EACH ROW EXECUTE FUNCTION public.guard_posted_transaction_line();
