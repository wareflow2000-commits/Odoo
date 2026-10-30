-- A rejected/accepted return request may be followed by a new request for
-- the remaining quantity. Reset the review state whenever a fresh remainder
-- is requested; preserve the prior request in audit_logs.

DO $migration$
DECLARE
  d text;
  n text;
  old_fragment text :=
    'return_requested_at=CASE WHEN v_return>0 THEN now() ELSE return_requested_at END,';
  new_fragment text :=
    'return_requested_at=CASE WHEN v_return>0 THEN now() ELSE return_requested_at END,' ||
    'return_review_status=CASE WHEN v_return>0 THEN ''PENDING'' ELSE return_review_status END,' ||
    'return_reviewed_by=CASE WHEN v_return>0 THEN NULL ELSE return_reviewed_by END,' ||
    'return_reviewed_at=CASE WHEN v_return>0 THEN NULL ELSE return_reviewed_at END,' ||
    'return_review_note=CASE WHEN v_return>0 THEN NULL ELSE return_review_note END,';
BEGIN
  SELECT pg_get_functiondef(
    'public.receive_stock_transfer_quantity_at_shelf_v2(uuid,numeric,uuid,boolean,text)'::regprocedure
  ) INTO d;

  IF position(new_fragment IN d)=0 THEN
    IF position(old_fragment IN d)=0 THEN
      RAISE EXCEPTION 'Transfer return-request review reset anchor not found; refusing partial rewrite';
    END IF;
    n:=replace(d,old_fragment,new_fragment);
    IF n=d THEN
      RAISE EXCEPTION 'Could not reset transfer return review state for a new request';
    END IF;
    d:=n;
  END IF;

  EXECUTE d;
END;
$migration$;

DO $verify$
DECLARE
  d text;
BEGIN
  SELECT pg_get_functiondef(
    'public.receive_stock_transfer_quantity_at_shelf_v2(uuid,numeric,uuid,boolean,text)'::regprocedure
  ) INTO d;

  IF position('return_review_status=CASE WHEN v_return>0 THEN ''PENDING'' ELSE return_review_status END' IN d)=0
     OR position('return_reviewed_by=CASE WHEN v_return>0 THEN NULL ELSE return_reviewed_by END' IN d)=0
     OR position('return_reviewed_at=CASE WHEN v_return>0 THEN NULL ELSE return_reviewed_at END' IN d)=0
     OR position('return_review_note=CASE WHEN v_return>0 THEN NULL ELSE return_review_note END' IN d)=0 THEN
    RAISE EXCEPTION 'New transfer return request does not reset prior review state';
  END IF;
END;
$verify$;
