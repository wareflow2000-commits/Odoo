-- Harden wrapper RPC entry points before any privileged lookup.
-- dispatch_stock_transfer_order_v3 performs unit/item lookups before delegating
-- to the fully guarded v2 writer, so enforce identity, permission and both
-- warehouse scopes before those lookups.
CREATE OR REPLACE FUNCTION public.dispatch_stock_transfer_order_v3(
  p_order_id uuid,
  p_reference_no text,
  p_source_warehouse_id uuid,
  p_destination_warehouse_id uuid,
  p_lines jsonb,
  p_notes text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_result jsonb;
  v_line jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_item uuid;
  v_base text;
  v_unit text;
  v_factor numeric;
  v_entered numeric;
  v_base_qty numeric;
  v_transfer_id uuid;
  v_source_tx uuid;
  v_st_item uuid;
  v_st_qty numeric;
  v_st_base text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.current_user_is_active() THEN
    RAISE EXCEPTION 'An active authenticated user is required' USING ERRCODE='42501';
  END IF;
  IF NOT public.current_user_has_permission('action:stock_transfer:create') THEN
    RAISE EXCEPTION 'Permission denied to create stock transfers' USING ERRCODE='42501';
  END IF;
  IF p_source_warehouse_id IS NULL OR p_destination_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'Source and destination warehouses are required' USING ERRCODE='22023';
  END IF;
  IF NOT public.current_user_can_access_warehouse(p_source_warehouse_id) THEN
    RAISE EXCEPTION 'User is not assigned to the source warehouse' USING ERRCODE='42501';
  END IF;
  IF NOT public.current_user_can_access_warehouse(p_destination_warehouse_id) THEN
    RAISE EXCEPTION 'User is not assigned to the destination warehouse' USING ERRCODE='42501';
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_TRANSFER_LINES: lines must be an array'
      USING ERRCODE = '22023';
  END IF;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    v_item := NULLIF(v_line->>'item_id', '')::uuid;
    IF v_item IS NULL THEN
      RAISE EXCEPTION 'ITEM_REQUIRED: every transfer line needs an item'
        USING ERRCODE = '22023';
    END IF;

    SELECT i.base_unit INTO v_base FROM public.items i WHERE i.id = v_item;
    IF v_base IS NULL THEN
      RAISE EXCEPTION 'ITEM_NOT_FOUND: item % does not exist', v_item
        USING ERRCODE = 'P0002';
    END IF;

    v_unit := COALESCE(NULLIF(btrim(v_line->>'entered_unit'), ''), v_base);
    SELECT r.factor_to_base, r.base_unit
    INTO v_factor, v_base
    FROM public.resolve_item_unit(v_item, v_unit) r;

    v_entered := COALESCE(
      NULLIF(v_line->>'entered_quantity', '')::numeric,
      (v_line->>'quantity')::numeric / v_factor
    );
    IF v_entered IS NULL OR v_entered <= 0
       OR v_entered::text IN ('NaN','Infinity','-Infinity') THEN
      RAISE EXCEPTION 'INVALID_ENTERED_QUANTITY: entered quantity must be a finite positive number'
        USING ERRCODE = '22023';
    END IF;
    v_base_qty := v_entered * v_factor;

    v_lines := v_lines || jsonb_build_array(v_line || jsonb_build_object(
      'quantity', v_base_qty,
      'entered_quantity', v_entered,
      'entered_unit', v_unit,
      'conversion_factor', v_factor,
      'base_unit', v_base
    ));
  END LOOP;

  v_result := public.dispatch_stock_transfer_order_v2(
    p_order_id, p_reference_no, p_source_warehouse_id,
    p_destination_warehouse_id, v_lines, p_notes
  );

  -- Persist the entered evidence on the rows that belong to this order. The
  -- trigger above verifies that the resulting base quantity is unchanged.
  FOR v_line IN SELECT value FROM jsonb_array_elements(v_lines) LOOP
    v_transfer_id := NULLIF(v_line->>'transfer_id', '')::uuid;
    IF v_transfer_id IS NULL THEN CONTINUE; END IF;
    UPDATE public.stock_transfers
    SET entered_quantity = (v_line->>'entered_quantity')::numeric,
        entered_unit = v_line->>'entered_unit',
        conversion_factor = (v_line->>'conversion_factor')::numeric,
        base_unit = v_line->>'base_unit'
    WHERE id = v_transfer_id
      AND transfer_order_id = p_order_id
      AND status IN ('IN_TRANSIT', 'PARTIALLY_RECEIVED');

    SELECT st.source_transaction_id, st.item_id, st.quantity, st.base_unit
    INTO v_source_tx, v_st_item, v_st_qty, v_st_base
    FROM public.stock_transfers st
    WHERE st.id = v_transfer_id;

    IF v_source_tx IS NOT NULL THEN
      UPDATE public.inventory_ledger l
      SET metadata = COALESCE(l.metadata, '{}'::jsonb) || jsonb_build_object(
        'entered_quantity', (v_line->>'entered_quantity')::numeric,
        'entered_unit', v_line->>'entered_unit',
        'conversion_factor', (v_line->>'conversion_factor')::numeric,
        'base_quantity', v_st_qty,
        'base_unit', v_st_base
      )
      WHERE l.source_id = v_source_tx
        AND l.item_id = v_st_item
        AND (l.metadata->>'transfer_id' IS NULL
             OR l.metadata->>'transfer_id' = v_transfer_id::text);

      UPDATE public.transaction_ledger tl
      SET details = COALESCE(tl.details, '{}'::jsonb) || jsonb_build_object(
        'entered_quantity', (v_line->>'entered_quantity')::numeric,
        'entered_unit', v_line->>'entered_unit',
        'conversion_factor', (v_line->>'conversion_factor')::numeric,
        'base_quantity', v_st_qty,
        'base_unit', v_st_base
      )
      WHERE tl.transaction_id = v_source_tx
        AND tl.item_id = v_st_item
        AND (tl.details->>'transfer_id' IS NULL
             OR tl.details->>'transfer_id' = v_transfer_id::text);
    END IF;
  END LOOP;

  RETURN v_result || jsonb_build_object('unit_normalized', true);
END;
$function$;

-- save_stocktake_count_v2 is an internal helper called by the guarded v3 RPC.
-- The browser calls save_stocktake_count or save_stocktake_count_v3 only.
REVOKE EXECUTE ON FUNCTION public.save_stocktake_count_v2(uuid, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_stocktake_count_v2(uuid, numeric, text)
  TO service_role;
