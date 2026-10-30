-- Prevent the SECURITY DEFINER unit-count wrapper from reading item conversion
-- metadata before enforcing the same session, permission, ownership and warehouse
-- guards as the authoritative stocktake count RPC.
CREATE OR REPLACE FUNCTION public.save_stocktake_count_v3(
  p_line_id uuid,
  p_entered_quantity numeric,
  p_entered_unit text,
  p_expected_factor numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_line public.stocktake_lines%ROWTYPE;
  v_session public.stocktake_sessions%ROWTYPE;
  v_base_unit text;
  v_unit text;
  v_current_factor numeric;
  v_result jsonb;
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL OR NOT public.current_user_is_active() THEN
    RAISE EXCEPTION 'Active authenticated user required' USING ERRCODE='42501';
  END IF;

  IF p_entered_quantity IS NULL OR p_entered_quantity < 0
     OR p_entered_quantity::text IN ('NaN','Infinity','-Infinity')
     OR p_expected_factor IS NULL OR p_expected_factor <= 0
     OR p_expected_factor::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'Invalid quantity or expected conversion factor' USING ERRCODE='22023';
  END IF;

  -- Lock the count line and session before any privileged item/unit lookup.
  -- Keep lock order aligned with save_stocktake_count().
  SELECT * INTO v_line
  FROM public.stocktake_lines
  WHERE id = p_line_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Line not found' USING ERRCODE='P0002'; END IF;

  SELECT * INTO v_session
  FROM public.stocktake_sessions
  WHERE id = v_line.session_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stocktake session not found'; END IF;

  IF v_session.status <> 'IN_PROGRESS'
     OR v_session.review_status NOT IN ('DRAFT','REJECTED')
     OR COALESCE(v_line.is_settled, false) THEN
    RAISE EXCEPTION 'Session is locked';
  END IF;

  IF NOT public.current_user_has_permission('action:stocktake:count')
     AND NOT public.current_user_has_permission('action:stocktake:start') THEN
    RAISE EXCEPTION 'Count permission required' USING ERRCODE='42501';
  END IF;

  IF v_session.created_by IS DISTINCT FROM v_user_id
     AND NOT public.current_user_is_manager() THEN
    RAISE EXCEPTION 'Only the stocktake creator or a manager may count this session'
      USING ERRCODE='42501';
  END IF;

  IF NOT public.current_user_can_access_warehouse(v_session.warehouse_id) THEN
    RAISE EXCEPTION 'Warehouse not assigned' USING ERRCODE='42501';
  END IF;

  -- Authorization is complete before reading the item's conversion metadata.
  SELECT i.base_unit INTO v_base_unit
  FROM public.items i
  WHERE i.id = v_line.item_id;
  IF v_base_unit IS NULL OR btrim(v_base_unit) = '' THEN
    RAISE EXCEPTION 'ITEM_BASE_UNIT_MISSING: item has no base unit' USING ERRCODE='23514';
  END IF;

  v_unit := COALESCE(NULLIF(btrim(p_entered_unit), ''), v_base_unit);
  IF upper(v_unit) = upper(v_base_unit) THEN
    v_current_factor := 1;
  ELSE
    SELECT c.factor_to_base INTO v_current_factor
    FROM public.item_unit_conversions c
    WHERE c.item_id = v_line.item_id
      AND upper(c.unit_code) = upper(v_unit)
    FOR SHARE;
    IF NOT FOUND OR v_current_factor IS NULL OR v_current_factor <= 0 THEN
      RAISE EXCEPTION 'UNIT_NOT_CONFIGURED: unit is not approved for item' USING ERRCODE='22023';
    END IF;
  END IF;

  IF v_current_factor IS DISTINCT FROM p_expected_factor THEN
    RAISE EXCEPTION 'UNIT_CONVERSION_CHANGED: conversion factor changed; review and re-enter this count'
      USING ERRCODE='40001';
  END IF;

  -- The inner guarded routine repeats all authorization checks and performs the write.
  v_result := public.save_stocktake_count_v2(p_line_id, p_entered_quantity, v_unit);
  RETURN v_result || jsonb_build_object('expected_factor', p_expected_factor);
END;
$function$;
