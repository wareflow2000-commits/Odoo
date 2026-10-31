-- ORSHAP WMS v13.9.58: enforce destination scope and close anonymous RPC execution.
-- Fail closed if production has drifted since this definition was reviewed.
DO $preflight$
DECLARE v_definition text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_definition
  FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.dispatch_stock_transfer_order_line(uuid,text,uuid,numeric,text,date,uuid,uuid,text,uuid)');
  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'Expected dispatch_stock_transfer_order_line signature is missing; abort migration';
  END IF;
  IF position('current_user_can_access_warehouse(p_destination_warehouse_id)' IN v_definition) > 0 THEN
    RAISE EXCEPTION 'Destination-scope check already exists; review live definition instead of overwriting it';
  END IF;
  IF position('current_user_can_access_warehouse(v_src.warehouse_id)' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Live function differs from the reviewed source-scope baseline; abort migration';
  END IF;
END;
$preflight$;

-- Generated from the live function definition during read-only audit; review before applying.
CREATE OR REPLACE FUNCTION public.dispatch_stock_transfer_order_line(p_transfer_id uuid, p_reference_no text, p_item_id uuid, p_quantity numeric, p_batch_no text, p_expiry_date date, p_source_shelf_id uuid, p_destination_shelf_id uuid, p_notes text, p_destination_warehouse_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  v_user uuid:=auth.uid(); v_profile public.profiles%ROWTYPE;
  v_src public.shelves%ROWTYPE; v_dst public.shelves%ROWTYPE; v_existing public.stock_transfers%ROWTYPE;
  v_batch text:=COALESCE(p_batch_no,'');
  v_src_qty numeric; v_dst_qty numeric:=0; v_src_after numeric; v_dst_after numeric;
  v_source_expiry date; v_dest_expiry date; v_effective_expiry date;
  v_src_tx uuid; v_dst_tx uuid; v_status text; v_src_area uuid; v_dst_area uuid; v_lock_key text;
BEGIN
  IF v_user IS NULL OR NOT public.current_user_is_active() THEN RAISE EXCEPTION 'An active authenticated user is required' USING ERRCODE='42501'; END IF;
  IF NOT public.current_user_has_permission('action:stock_transfer:create') THEN RAISE EXCEPTION 'Permission denied to create stock transfers' USING ERRCODE='42501'; END IF;
  IF p_transfer_id IS NULL OR NULLIF(btrim(COALESCE(p_reference_no,'')),'') IS NULL OR p_item_id IS NULL OR p_quantity IS NULL OR p_quantity<=0 OR p_quantity::text IN ('NaN','Infinity','-Infinity') OR p_source_shelf_id IS NULL OR p_destination_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'Transfer ID, reference, item, positive quantity, source shelf and destination warehouse are required';
  END IF;
  SELECT * INTO v_profile FROM public.profiles WHERE id=v_user AND status='ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'Active user profile required' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_src FROM public.shelves WHERE id=p_source_shelf_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source shelf not found'; END IF;
  IF v_src.storage_area_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.storage_areas a WHERE a.id=v_src.storage_area_id AND a.warehouse_id=v_src.warehouse_id) THEN RAISE EXCEPTION 'Source shelf must belong to a valid storage area'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.warehouses w WHERE w.id=p_destination_warehouse_id) THEN RAISE EXCEPTION 'Destination warehouse not found'; END IF;
  IF p_destination_shelf_id IS NOT NULL THEN
    SELECT * INTO v_dst FROM public.shelves WHERE id=p_destination_shelf_id AND warehouse_id=p_destination_warehouse_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Destination shelf does not belong to destination warehouse'; END IF;
    IF v_dst.storage_area_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.storage_areas a WHERE a.id=v_dst.storage_area_id AND a.warehouse_id=v_dst.warehouse_id) THEN RAISE EXCEPTION 'Destination shelf must belong to a valid storage area'; END IF;
    IF p_destination_shelf_id=p_source_shelf_id THEN RAISE EXCEPTION 'Source and destination shelves must differ'; END IF;
  ELSE
    v_dst.id:=NULL; v_dst.warehouse_id:=p_destination_warehouse_id; v_dst.storage_area_id:=NULL;
    IF v_src.warehouse_id=p_destination_warehouse_id THEN RAISE EXCEPTION 'Same-warehouse transfers require a destination shelf'; END IF;
  END IF;
  IF NOT public.current_user_can_access_warehouse(v_src.warehouse_id) THEN RAISE EXCEPTION 'User is not assigned to the source warehouse' USING ERRCODE='42501'; END IF;
  IF NOT public.current_user_can_access_warehouse(p_destination_warehouse_id) THEN RAISE EXCEPTION 'User is not assigned to the destination warehouse' USING ERRCODE='42501'; END IF;
 
  IF NOT EXISTS(SELECT 1 FROM public.items i WHERE i.id=p_item_id) THEN RAISE EXCEPTION 'Item not found'; END IF;

  SELECT * INTO v_existing FROM public.stock_transfers WHERE id=p_transfer_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.created_by IS DISTINCT FROM v_user OR v_existing.reference_no IS DISTINCT FROM btrim(p_reference_no) OR v_existing.item_id IS DISTINCT FROM p_item_id OR v_existing.quantity IS DISTINCT FROM p_quantity OR v_existing.source_shelf_id IS DISTINCT FROM p_source_shelf_id OR v_existing.source_warehouse_id IS DISTINCT FROM v_src.warehouse_id OR v_existing.destination_warehouse_id IS DISTINCT FROM p_destination_warehouse_id OR (p_destination_shelf_id IS NOT NULL AND v_existing.requested_destination_shelf_id IS DISTINCT FROM p_destination_shelf_id) OR v_existing.batch_no IS DISTINCT FROM v_batch OR v_existing.notes IS DISTINCT FROM p_notes OR v_existing.expiry_date IS DISTINCT FROM COALESCE(p_expiry_date,(SELECT s.expiry_date FROM public.stock s WHERE s.item_id=p_item_id AND s.shelf_id=p_source_shelf_id AND s.batch_no=v_batch)) THEN
      RAISE EXCEPTION 'Idempotency conflict: transfer ID was already used for different data';
    END IF;
    RETURN jsonb_build_object('success',true,'already_processed',true,'transfer_id',v_existing.id,'status',v_existing.status,'source_transaction_id',v_existing.source_transaction_id,'destination_transaction_id',v_existing.destination_transaction_id);
  END IF;

  FOR v_lock_key IN SELECT k FROM (
    SELECT p_item_id::text||':'||p_source_shelf_id::text||':'||v_batch AS k
    UNION SELECT p_item_id::text||':'||p_destination_shelf_id::text||':'||v_batch WHERE p_destination_shelf_id IS NOT NULL
  ) keys ORDER BY k LOOP PERFORM pg_advisory_xact_lock(hashtextextended(v_lock_key,0)); END LOOP;

  SELECT s.quantity,s.expiry_date INTO v_src_qty,v_source_expiry FROM public.stock s
  WHERE s.item_id=p_item_id AND s.shelf_id=p_source_shelf_id AND s.batch_no=v_batch FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No source stock exists for this owner, item and batch'; END IF;
  IF v_src_qty IS NULL OR v_src_qty<p_quantity THEN RAISE EXCEPTION 'Insufficient stock for transfer; available %, requested %',COALESCE(v_src_qty,0),p_quantity; END IF;
  IF p_expiry_date IS NOT NULL AND v_source_expiry IS NOT NULL AND p_expiry_date IS DISTINCT FROM v_source_expiry THEN RAISE EXCEPTION 'Expiry date does not match source batch'; END IF;
  IF p_destination_shelf_id IS NOT NULL THEN
    SELECT s.quantity,s.expiry_date INTO v_dst_qty,v_dest_expiry FROM public.stock s
    WHERE s.item_id=p_item_id AND s.shelf_id=p_destination_shelf_id AND s.batch_no=v_batch FOR UPDATE;
    v_dst_qty:=COALESCE(v_dst_qty,0);
    IF v_source_expiry IS NOT NULL AND v_dest_expiry IS NOT NULL AND v_source_expiry IS DISTINCT FROM v_dest_expiry THEN RAISE EXCEPTION 'Source and destination batch expiry dates differ'; END IF;
    IF p_expiry_date IS NOT NULL AND v_dest_expiry IS NOT NULL AND p_expiry_date IS DISTINCT FROM v_dest_expiry THEN RAISE EXCEPTION 'Expiry date does not match destination batch'; END IF;
  END IF;
  v_effective_expiry:=COALESCE(v_source_expiry,v_dest_expiry,p_expiry_date); v_src_after:=v_src_qty-p_quantity; v_src_area:=v_src.storage_area_id; v_dst_area:=v_dst.storage_area_id;
  v_src_tx:=gen_random_uuid();
  INSERT INTO public.transactions(id,reference_no,transaction_type,status,warehouse_id,storage_area_id,notes,created_by)
  VALUES(v_src_tx,btrim(p_reference_no)||'-OUT','ADJUSTMENT_OUT','APPROVED',v_src.warehouse_id,v_src_area,COALESCE(p_notes,'Stock transfer dispatch'),v_user);
  INSERT INTO public.transaction_lines(transaction_id,item_id,shelf_id,quantity,balance_before,balance_after,batch_no,expiry_date,storage_area_id,notes)
  VALUES(v_src_tx,p_item_id,p_source_shelf_id,p_quantity,v_src_qty,v_src_after,v_batch,v_effective_expiry,v_src_area,'Transfer='||p_transfer_id::text||'; direction=OUT');
  UPDATE public.stock SET quantity=v_src_after,storage_area_id=v_src_area,updated_at=now()
  WHERE item_id=p_item_id AND shelf_id=p_source_shelf_id AND batch_no=v_batch;
  PERFORM public.log_transaction_ledger(p_transaction_id:=v_src_tx,p_ledger_type:='STOCK_TRANSFER',p_user_id:=v_user,p_warehouse_id:=v_src.warehouse_id,p_zone_id:=NULL::uuid,p_section_id:=NULL::uuid,p_shelf_id:=p_source_shelf_id,p_item_id:=p_item_id,p_quantity:=-p_quantity,p_balance_before:=v_src_qty,p_balance_after:=v_src_after,p_transaction_type:='ADJUSTMENT_OUT',p_details:=jsonb_build_object('transfer_id',p_transfer_id,'destination_warehouse_id',p_destination_warehouse_id,'destination_shelf_id',p_destination_shelf_id,'batch_no',v_batch,'storage_area_id',v_src_area),p_reference:=btrim(p_reference_no),p_approved:=true,p_reference_type:='STOCK_TRANSFER',p_batch_no:=v_batch,p_expiry_date:=v_effective_expiry);

  IF v_src.warehouse_id=p_destination_warehouse_id THEN
    v_dst_after:=v_dst_qty+p_quantity; v_dst_tx:=gen_random_uuid();
    INSERT INTO public.transactions(id,reference_no,transaction_type,status,warehouse_id,storage_area_id,notes,created_by)
    VALUES(v_dst_tx,btrim(p_reference_no)||'-IN','ADJUSTMENT_IN','APPROVED',p_destination_warehouse_id,v_dst_area,COALESCE(p_notes,'Same-warehouse shelf transfer'),v_user);
    INSERT INTO public.transaction_lines(transaction_id,item_id,shelf_id,quantity,balance_before,balance_after,batch_no,expiry_date,storage_area_id,notes)
    VALUES(v_dst_tx,p_item_id,p_destination_shelf_id,p_quantity,v_dst_qty,v_dst_after,v_batch,v_effective_expiry,v_dst_area,'Transfer='||p_transfer_id::text||'; direction=IN');
    INSERT INTO public.stock(item_id,shelf_id,quantity,batch_no,expiry_date,storage_area_id,updated_at)
    VALUES(p_item_id,p_destination_shelf_id,v_dst_after,v_batch,v_effective_expiry,v_dst_area,now())
    ON CONFLICT(item_id,shelf_id,batch_no) DO UPDATE SET quantity=EXCLUDED.quantity,expiry_date=COALESCE(EXCLUDED.expiry_date,public.stock.expiry_date),storage_area_id=COALESCE(EXCLUDED.storage_area_id,public.stock.storage_area_id),updated_at=now();
    PERFORM public.log_transaction_ledger(p_transaction_id:=v_dst_tx,p_ledger_type:='STOCK_TRANSFER',p_user_id:=v_user,p_warehouse_id:=p_destination_warehouse_id,p_zone_id:=NULL::uuid,p_section_id:=NULL::uuid,p_shelf_id:=p_destination_shelf_id,p_item_id:=p_item_id,p_quantity:=p_quantity,p_balance_before:=v_dst_qty,p_balance_after:=v_dst_after,p_transaction_type:='ADJUSTMENT_IN',p_details:=jsonb_build_object('transfer_id',p_transfer_id,'source_warehouse_id',v_src.warehouse_id,'source_shelf_id',p_source_shelf_id,'batch_no',v_batch,'storage_area_id',v_dst_area),p_reference:=btrim(p_reference_no),p_approved:=true,p_reference_type:='STOCK_TRANSFER',p_batch_no:=v_batch,p_expiry_date:=v_effective_expiry);
    v_status:='COMPLETED';
  ELSE v_status:='IN_TRANSIT'; v_dst_tx:=NULL; END IF;

  INSERT INTO public.stock_transfers(id,reference_no,item_id,quantity,batch_no,expiry_date,source_warehouse_id,source_shelf_id,destination_warehouse_id,destination_shelf_id,requested_destination_shelf_id,status,notes,created_by,dispatched_by,source_transaction_id,destination_transaction_id,received_by,received_at,received_quantity,source_storage_area_id,destination_storage_area_id)
  VALUES(p_transfer_id,btrim(p_reference_no),p_item_id,p_quantity,v_batch,v_effective_expiry,v_src.warehouse_id,p_source_shelf_id,p_destination_warehouse_id,p_destination_shelf_id,p_destination_shelf_id,v_status,p_notes,v_user,v_user,v_src_tx,v_dst_tx,CASE WHEN v_status='COMPLETED' THEN v_user END,CASE WHEN v_status='COMPLETED' THEN now() END,CASE WHEN v_status='COMPLETED' THEN p_quantity ELSE 0 END,v_src_area,v_dst_area);
  INSERT INTO public.audit_logs(user_id,action,entity,entity_id,warehouse_id,reference,details)
  VALUES(v_user,'STOCK_TRANSFER_DISPATCH','STOCK_TRANSFER',p_transfer_id::text,v_src.warehouse_id,btrim(p_reference_no),jsonb_build_object('status',v_status,'item_id',p_item_id,'quantity',p_quantity,'batch_no',v_batch,'source_shelf_id',p_source_shelf_id,'destination_shelf_id',p_destination_shelf_id,'destination_warehouse_id',p_destination_warehouse_id));
  RETURN jsonb_build_object('success',true,'already_processed',false,'transfer_id',p_transfer_id,'status',v_status,'source_transaction_id',v_src_tx,'destination_transaction_id',v_dst_tx,'source_balance_after',v_src_after,'destination_balance_after',CASE WHEN v_status='COMPLETED' THEN v_dst_after ELSE NULL END);
END;
$function$
;

REVOKE EXECUTE ON FUNCTION public.dispatch_stock_transfer_order_line(uuid, text, uuid, numeric, text, date, uuid, uuid, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.dispatch_stock_transfer_order_line(uuid, text, uuid, numeric, text, date, uuid, uuid, text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.dispatch_stock_transfer_order_line(uuid, text, uuid, numeric, text, date, uuid, uuid, text, uuid) TO authenticated;
