-- Fail closed if the live function differs from the exact reviewed baseline.
DO $preflight$
DECLARE v_definition text; v_source_check_count integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_definition
  FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.dispatch_stock_transfer_order_v2(uuid,uuid,text,uuid,uuid,jsonb,text)');
  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'Expected dispatch_stock_transfer_order_v2 signature is missing; abort migration';
  END IF;
  IF position('current_user_can_access_warehouse(p_destination_warehouse_id)' IN v_definition) > 0 THEN
    RAISE EXCEPTION 'Destination-scope check already exists; review live definition instead of overwriting it';
  END IF;
  v_source_check_count :=
    (length(v_definition) - length(replace(v_definition, 'current_user_can_access_warehouse(p_source_warehouse_id)', '')))
    / length('current_user_can_access_warehouse(p_source_warehouse_id)');
  IF v_source_check_count <> 2 THEN
    RAISE EXCEPTION 'Live function differs from the reviewed duplicate-source-check baseline; abort migration';
  END IF;
END;
$preflight$;

-- ORSHAP WMS v13.9.58: enforce destination scope before transfer-order replay/creation.
-- Rebuilt from the current live function definition during read-only audit; review before applying.
CREATE OR REPLACE FUNCTION public.dispatch_stock_transfer_order_v2(p_order_id uuid, p_reference_no text, p_source_warehouse_id uuid, p_destination_warehouse_id uuid, p_lines jsonb, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  v_user uuid:=auth.uid(); v_profile public.profiles%ROWTYPE; v_existing public.stock_transfer_orders%ROWTYPE;
  v_line jsonb; v_line_no integer:=0; v_item uuid; v_qty numeric; v_batch text; v_expiry date;
  v_source_shelf uuid; v_destination_shelf uuid; v_transfer_id uuid; v_line_ref text; v_result jsonb;
  v_status text; v_count integer:=0; v_operation text;
BEGIN
  IF v_user IS NULL OR NOT public.current_user_is_active() THEN RAISE EXCEPTION 'An active authenticated user is required'; END IF;
  IF NOT public.current_user_has_permission('action:stock_transfer:create') THEN RAISE EXCEPTION 'Permission denied to create stock transfers'; END IF;
  IF p_order_id IS NULL OR NULLIF(btrim(COALESCE(p_reference_no,'')),'') IS NULL OR p_source_warehouse_id IS NULL OR p_destination_warehouse_id IS NULL THEN RAISE EXCEPTION 'Order ID, reference and warehouses are required'; END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines)=0 THEN RAISE EXCEPTION 'At least one transfer line is required'; END IF;
  SELECT * INTO v_profile FROM public.profiles WHERE id=v_user AND status='ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'Active user profile required'; END IF;
  IF NOT public.current_user_can_access_warehouse(p_source_warehouse_id) THEN RAISE EXCEPTION 'User is not assigned to the source warehouse' USING ERRCODE='42501'; END IF;
  IF NOT public.current_user_can_access_warehouse(p_destination_warehouse_id) THEN RAISE EXCEPTION 'User is not assigned to the destination warehouse' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_existing FROM public.stock_transfer_orders WHERE id=p_order_id;
  IF FOUND THEN
    IF v_existing.created_by IS DISTINCT FROM v_user OR v_existing.reference_no IS DISTINCT FROM btrim(p_reference_no) OR v_existing.source_warehouse_id IS DISTINCT FROM p_source_warehouse_id OR v_existing.destination_warehouse_id IS DISTINCT FROM p_destination_warehouse_id OR v_existing.notes IS DISTINCT FROM p_notes THEN RAISE EXCEPTION 'Idempotency conflict: order ID already exists with different data'; END IF;
    IF (SELECT count(*) FROM public.stock_transfers WHERE transfer_order_id=p_order_id) <> jsonb_array_length(p_lines)
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS j(line, ord)
         LEFT JOIN public.stock_transfers st ON st.transfer_order_id=p_order_id AND st.line_no=j.ord::integer
         WHERE st.id IS NULL OR st.item_id IS DISTINCT FROM NULLIF(j.line->>'item_id','')::uuid
            OR st.quantity IS DISTINCT FROM NULLIF(j.line->>'quantity','')::numeric
            OR st.batch_no IS DISTINCT FROM COALESCE(j.line->>'batch_no','')
            OR st.expiry_date IS DISTINCT FROM NULLIF(j.line->>'expiry_date','')::date
            OR st.source_shelf_id IS DISTINCT FROM NULLIF(j.line->>'source_shelf_id','')::uuid
            OR (NULLIF(j.line->>'destination_shelf_id','') IS NOT NULL AND st.requested_destination_shelf_id IS DISTINCT FROM NULLIF(j.line->>'destination_shelf_id','')::uuid)
            OR (NULLIF(j.line->>'transfer_id','') IS NOT NULL AND st.id IS DISTINCT FROM NULLIF(j.line->>'transfer_id','')::uuid)
       ) THEN RAISE EXCEPTION 'Idempotency conflict: order ID already exists with different lines';
    END IF;
    RETURN jsonb_build_object('success',true,'already_processed',true,'order_id',p_order_id,'status',v_existing.status);
  END IF;
  v_operation:=CASE WHEN COALESCE(p_notes,'') LIKE 'WAREHOUSE_RETURN%' THEN 'WAREHOUSE_RETURN' ELSE 'TRANSFER' END;
  IF v_operation='WAREHOUSE_RETURN' AND p_source_warehouse_id=p_destination_warehouse_id THEN RAISE EXCEPTION 'An inter-warehouse return must use two different warehouses'; END IF;
  INSERT INTO public.stock_transfer_orders(id,reference_no,source_warehouse_id,destination_warehouse_id,operation_type,status,notes,created_by)
  VALUES(p_order_id,btrim(p_reference_no),p_source_warehouse_id,p_destination_warehouse_id,v_operation,'DRAFT',p_notes,v_user);
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    v_line_no:=v_line_no+1;
    BEGIN v_item:=NULLIF(v_line->>'item_id','')::uuid; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Line %: invalid item ID',v_line_no; END;
    BEGIN v_qty:=NULLIF(v_line->>'quantity','')::numeric; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Line %: invalid quantity',v_line_no; END;
    BEGIN v_source_shelf:=NULLIF(v_line->>'source_shelf_id','')::uuid; v_destination_shelf:=NULLIF(v_line->>'destination_shelf_id','')::uuid; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Line %: invalid shelf ID',v_line_no; END;
    BEGIN v_expiry:=NULLIF(v_line->>'expiry_date','')::date; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Line %: invalid expiry date',v_line_no; END;
    v_batch:=COALESCE(v_line->>'batch_no','');
    IF v_item IS NULL OR v_qty IS NULL OR v_qty<=0 OR v_qty::text IN ('NaN','Infinity','-Infinity') OR v_source_shelf IS NULL OR (v_destination_shelf IS NULL AND p_source_warehouse_id=p_destination_warehouse_id) THEN RAISE EXCEPTION 'Line %: item, source shelf and positive quantity are required; same-warehouse transfers also require a destination shelf',v_line_no; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.shelves WHERE id=v_source_shelf AND warehouse_id=p_source_warehouse_id) THEN RAISE EXCEPTION 'Line %: source shelf does not belong to source warehouse',v_line_no; END IF;
    IF v_destination_shelf IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.shelves WHERE id=v_destination_shelf AND warehouse_id=p_destination_warehouse_id) THEN RAISE EXCEPTION 'Line %: destination shelf does not belong to destination warehouse',v_line_no; END IF;
    IF v_source_shelf=v_destination_shelf THEN RAISE EXCEPTION 'Line %: source and destination shelves must differ',v_line_no; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.items WHERE id=v_item) THEN RAISE EXCEPTION 'Line %: item not found',v_line_no; END IF;
    v_transfer_id:=COALESCE(NULLIF(v_line->>'transfer_id','')::uuid,gen_random_uuid());
    v_line_ref:=btrim(p_reference_no)||'-L'||lpad(v_line_no::text,3,'0');
    v_result:=public.dispatch_stock_transfer_order_line(v_transfer_id,v_line_ref,v_item,v_qty,v_batch,v_expiry,v_source_shelf,v_destination_shelf,COALESCE(p_notes,'Stock transfer'),p_destination_warehouse_id);
    UPDATE public.stock_transfers SET transfer_order_id=p_order_id,line_no=v_line_no,received_quantity=CASE WHEN status='COMPLETED' THEN quantity ELSE received_quantity END WHERE id=v_transfer_id;
    v_count:=v_count+1;
  END LOOP;
  v_status:=CASE WHEN p_source_warehouse_id=p_destination_warehouse_id THEN 'COMPLETED' ELSE 'IN_TRANSIT' END;
  UPDATE public.stock_transfer_orders SET status=v_status,updated_at=now() WHERE id=p_order_id;
  INSERT INTO public.audit_logs(user_id,action,entity,entity_id,warehouse_id,reference,details)
  VALUES(v_user,'STOCK_TRANSFER_ORDER_DISPATCHED','STOCK_TRANSFER_ORDER',p_order_id::text,p_source_warehouse_id,btrim(p_reference_no),jsonb_build_object('line_count',v_count,'destination_warehouse_id',p_destination_warehouse_id,'status',v_status,'operation_type',v_operation)::text);
  RETURN jsonb_build_object('success',true,'already_processed',false,'order_id',p_order_id,'status',v_status,'line_count',v_count,'operation_type',v_operation);
END;
$function$
;
