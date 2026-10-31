-- A completed transfer-receipt rejection is idempotent only for its original
-- actor, with the same reason and while the actor retains destination scope.
-- Do not reveal an already-rejected transfer to arbitrary authenticated users.

DO $migration$
DECLARE
  v_definition text;
  v_updated text;
BEGIN
  SELECT pg_get_functiondef(
    'public.reject_stock_transfer_receipt(uuid,text)'::regprocedure
  ) INTO v_definition;

  v_updated := replace(
    v_definition,
    $old$IF v_transfer.status='REJECTED' THEN RETURN jsonb_build_object('success',true,'already_rejected',true,'transfer_id',p_transfer_id,'status','REJECTED'); END IF;$old$,
    $new$IF v_transfer.status='REJECTED' THEN
   IF v_transfer.rejected_by IS DISTINCT FROM v_user
      OR btrim(COALESCE(v_transfer.rejection_reason,'')) IS DISTINCT FROM btrim(COALESCE(p_reason,''))
      OR NOT public.current_user_can_access_warehouse(v_transfer.destination_warehouse_id) THEN
     RAISE EXCEPTION 'Only the original rejecting user with destination warehouse access may replay this rejection'
       USING ERRCODE='42501';
   END IF;
   RETURN jsonb_build_object('success',true,'already_rejected',true,'transfer_id',p_transfer_id,'status','REJECTED');
 END IF;$new$
  );

  IF v_updated = v_definition THEN
    RAISE EXCEPTION 'Transfer rejection idempotency anchor not found; migration aborted';
  END IF;

  EXECUTE v_updated;
END;
$migration$;

DO $verify$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.reject_stock_transfer_receipt(uuid,text)'::regprocedure
  ) INTO v_definition;

  IF position('v_transfer.rejected_by IS DISTINCT FROM v_user' IN v_definition)=0
     OR position('v_transfer.rejection_reason' IN v_definition)=0
     OR position('Only the original rejecting user' IN v_definition)=0 THEN
    RAISE EXCEPTION 'Transfer rejection replay ownership verification failed';
  END IF;
END;
$verify$;
