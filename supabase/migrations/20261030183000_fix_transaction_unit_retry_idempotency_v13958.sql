-- A retry of an existing transaction must be read-only with respect to its
-- unit snapshot. The old wrapper re-applied entered_quantity on every retry;
-- the line normalization trigger then recalculated the base quantity, allowing
-- an idempotency retry to mutate a pending voucher without a new write request.
CREATE OR REPLACE FUNCTION public.create_transaction_with_lines_v2(
  p_transaction_id uuid,
  p_transaction jsonb,
  p_lines jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_result jsonb;
  v_line record;
  v_existing_line public.transaction_lines%ROWTYPE;
  v_current_factor numeric;
  v_current_base text;
  v_already_created boolean := false;
BEGIN
  IF p_transaction_id IS NULL THEN
    RAISE EXCEPTION 'p_transaction_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    RAISE EXCEPTION 'p_lines must be a JSON array' USING ERRCODE = '22023';
  END IF;

  -- The base writer remains the single authority for transaction ownership,
  -- authorization, line validation and idempotency of base quantities.
  v_result := public.create_transaction_with_lines(p_transaction_id, p_transaction, p_lines);
  v_already_created := COALESCE((v_result->>'already_created')::boolean, false);

  FOR v_line IN
    SELECT *
    FROM jsonb_to_recordset(p_lines) AS x(
      id uuid,
      item_id uuid,
      entered_quantity numeric,
      entered_unit text,
      conversion_factor numeric,
      base_unit text
    )
  LOOP
    IF v_line.id IS NULL THEN
      RAISE EXCEPTION 'Each transaction line must have an id' USING ERRCODE = '22023';
    END IF;

    SELECT tl.* INTO v_existing_line
    FROM public.transaction_lines tl
    WHERE tl.id = v_line.id
      AND tl.transaction_id = p_transaction_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Transaction line % does not belong to transaction %', v_line.id, p_transaction_id
        USING ERRCODE = '23514';
    END IF;

    IF v_already_created THEN
      -- Never rewrite a line on an idempotent retry. Compare any supplied unit
      -- evidence with the stored snapshot and reject a changed payload instead.
      -- Do not resolve against current conversion metadata here: a later
      -- conversion edit must not rewrite or invalidate the original snapshot.
      IF v_line.entered_unit IS NOT NULL AND btrim(v_line.entered_unit) <> '' THEN
        IF upper(COALESCE(v_existing_line.entered_unit, '')) IS DISTINCT FROM upper(btrim(v_line.entered_unit))
           OR (v_line.entered_quantity IS NOT NULL
               AND v_existing_line.entered_quantity IS DISTINCT FROM v_line.entered_quantity)
           OR (v_line.conversion_factor IS NOT NULL
               AND v_existing_line.conversion_factor IS DISTINCT FROM v_line.conversion_factor)
           OR (v_line.base_unit IS NOT NULL
               AND v_existing_line.base_unit IS DISTINCT FROM v_line.base_unit) THEN
          RAISE EXCEPTION 'Idempotency conflict: transaction line unit evidence differs from the original request'
            USING ERRCODE = '23505';
        END IF;
      END IF;
      CONTINUE;
    END IF;

    IF v_line.entered_unit IS NOT NULL AND btrim(v_line.entered_unit) <> '' THEN
      SELECT r.factor_to_base, r.base_unit
      INTO v_current_factor, v_current_base
      FROM public.resolve_item_unit(v_existing_line.item_id, v_line.entered_unit) r;

      IF v_line.conversion_factor IS NOT NULL AND v_line.conversion_factor <= 0 THEN
        RAISE EXCEPTION 'INVALID_CONVERSION_FACTOR: conversion factor must be greater than zero'
          USING ERRCODE = '22023';
      END IF;

      IF v_line.conversion_factor IS NOT NULL
         AND v_line.conversion_factor IS DISTINCT FROM v_current_factor THEN
        RAISE EXCEPTION 'UNIT_FACTOR_CHANGED: factor for unit % changed from % to %',
          v_line.entered_unit, v_line.conversion_factor, v_current_factor
          USING ERRCODE = '22023';
      END IF;

      IF v_line.base_unit IS NOT NULL
         AND v_line.base_unit IS DISTINCT FROM v_current_base THEN
        RAISE EXCEPTION 'BASE_UNIT_CHANGED: item base unit changed from % to %',
          v_line.base_unit, v_current_base
          USING ERRCODE = '22023';
      END IF;

      IF v_line.entered_quantity IS NOT NULL THEN
        IF v_line.entered_quantity <= 0
           OR v_line.entered_quantity::text IN ('NaN','Infinity','-Infinity') THEN
          RAISE EXCEPTION 'INVALID_ENTERED_QUANTITY: entered quantity must be finite and greater than zero'
            USING ERRCODE = '22023';
        END IF;
        IF abs((v_line.entered_quantity * v_current_factor) - v_existing_line.quantity) > 0.000000001 THEN
          RAISE EXCEPTION 'UNIT_QUANTITY_MISMATCH: entered quantity multiplied by its conversion factor must equal the supplied base quantity'
            USING ERRCODE = '22023';
        END IF;
      END IF;

      UPDATE public.transaction_lines
      SET entered_quantity = v_line.entered_quantity,
          entered_unit = v_line.entered_unit
      WHERE id = v_line.id
        AND transaction_id = p_transaction_id;
    END IF;
  END LOOP;

  RETURN v_result;
END;
$function$;


-- Transfer dispatch retries must preserve the unit snapshot on each transfer
-- line and its paired ledger metadata. The v2 writer verifies base quantities,
-- while this wrapper verifies the entered-unit evidence before any update.
DO $transfer_retry$
DECLARE
  d text;
  n text;
  decl_old text := '  v_st_base text;' || E'\\n' || 'BEGIN';
  decl_new text := '  v_st_base text;' || E'\\n' ||
    '  v_already_processed boolean := false;' || E'\\n' ||
    '  v_existing_transfer public.stock_transfers%ROWTYPE;' || E'\\n' ||
    'BEGIN';
  call_old text := '  v_result := public.dispatch_stock_transfer_order_v2(' || E'\\n' ||
    '    p_order_id, p_reference_no, p_source_warehouse_id,' || E'\\n' ||
    '    p_destination_warehouse_id, v_lines, p_notes' || E'\\n' ||
    '  );';
  call_new text := call_old || E'\\n' ||
    '  v_already_processed := COALESCE((v_result->>''already_processed'')::boolean,false);';
  loop_old text := '    IF v_transfer_id IS NULL THEN CONTINUE; END IF;' || E'\\n' || E'\\n' ||
    '    UPDATE public.stock_transfers';
  loop_new text := '    IF v_transfer_id IS NULL THEN CONTINUE; END IF;' || E'\\n' ||
    '    IF v_already_processed THEN' || E'\\n' ||
    '      SELECT st.* INTO v_existing_transfer' || E'\\n' ||
    '      FROM public.stock_transfers st' || E'\\n' ||
    '      WHERE st.id=v_transfer_id AND st.transfer_order_id=p_order_id;' || E'\\n' ||
    '      IF NOT FOUND THEN' || E'\\n' ||
    '        RAISE EXCEPTION ''Idempotency conflict: transfer line no longer belongs to the original order'' USING ERRCODE=''23505'';' || E'\\n' ||
    '      END IF;' || E'\\n' ||
    '      IF v_existing_transfer.entered_quantity IS DISTINCT FROM (v_line->>''entered_quantity'')::numeric' || E'\\n' ||
    '         OR upper(COALESCE(v_existing_transfer.entered_unit,'''')) IS DISTINCT FROM upper(COALESCE(v_line->>''entered_unit'',''''))' || E'\\n' ||
    '         OR v_existing_transfer.conversion_factor IS DISTINCT FROM (v_line->>''conversion_factor'')::numeric' || E'\\n' ||
    '         OR v_existing_transfer.base_unit IS DISTINCT FROM v_line->>''base_unit'' THEN' || E'\\n' ||
    '        RAISE EXCEPTION ''Idempotency conflict: transfer line unit evidence differs from the original dispatch request'' USING ERRCODE=''23505'';' || E'\\n' ||
    '      END IF;' || E'\\n' ||
    '      CONTINUE;' || E'\\n' ||
    '    END IF;' || E'\\n' || E'\\n' ||
    '    UPDATE public.stock_transfers';
BEGIN
  SELECT pg_get_functiondef(
    'public.dispatch_stock_transfer_order_v3(uuid,text,uuid,uuid,jsonb,text)'::regprocedure
  ) INTO d;

  IF position(decl_new IN d)=0 THEN
    IF position(decl_old IN d)=0 THEN RAISE EXCEPTION 'Transfer dispatch wrapper declaration anchor not found'; END IF;
    n:=replace(d,decl_old,decl_new);
    IF n=d THEN RAISE EXCEPTION 'Could not add transfer dispatch retry state'; END IF;
    d:=n;
  END IF;

  IF position(call_new IN d)=0 THEN
    IF position(call_old IN d)=0 THEN RAISE EXCEPTION 'Transfer dispatch wrapper v2 call anchor not found'; END IF;
    n:=replace(d,call_old,call_new);
    IF n=d THEN RAISE EXCEPTION 'Could not capture transfer dispatch idempotency result'; END IF;
    d:=n;
  END IF;

  IF position(loop_new IN d)=0 THEN
    IF position(loop_old IN d)=0 THEN RAISE EXCEPTION 'Transfer dispatch wrapper unit persistence anchor not found'; END IF;
    n:=replace(d,loop_old,loop_new);
    IF n=d THEN RAISE EXCEPTION 'Could not protect transfer unit snapshot on retry'; END IF;
    d:=n;
  END IF;

  EXECUTE d;
END;
$transfer_retry$;

DO $verify$
DECLARE
  d text;
BEGIN
  SELECT pg_get_functiondef(
    'public.create_transaction_with_lines_v2(uuid,jsonb,jsonb)'::regprocedure
  ) INTO d;

  IF position('v_already_created' IN d) = 0
     OR position('IF v_already_created THEN' IN d) = 0
     OR position('Idempotency conflict: transaction line unit evidence differs from the original request' IN d) = 0
     OR position('CONTINUE;' IN d) = 0
     OR position('UNIT_QUANTITY_MISMATCH' IN d) = 0
     OR position('v_existing_line.quantity' IN d) = 0 THEN
    RAISE EXCEPTION 'Transaction unit idempotency guard verification failed';
  END IF;

  SELECT pg_get_functiondef(
    'public.dispatch_stock_transfer_order_v3(uuid,text,uuid,uuid,jsonb,text)'::regprocedure
  ) INTO d;
  IF position('v_already_processed' IN d)=0
     OR position('Idempotency conflict: transfer line unit evidence differs from the original dispatch request' IN d)=0
     OR position('IF v_already_processed THEN' IN d)=0 THEN
    RAISE EXCEPTION 'Transfer unit idempotency guard verification failed';
  END IF;

END;
$verify$;
