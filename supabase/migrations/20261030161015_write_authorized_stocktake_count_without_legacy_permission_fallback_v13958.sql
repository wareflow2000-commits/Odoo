DO $migration$
DECLARE d text; n text;
BEGIN
 SELECT pg_get_functiondef('public.save_stocktake_count_v3_internal(uuid,numeric,text,numeric,boolean)'::regprocedure) INTO d;
 n:=replace(d,
  '  -- The inner guarded routine repeats all authorization checks and performs the write.' || E'\n' ||
  '  v_result := public.save_stocktake_count_v2(p_line_id, p_entered_quantity, v_unit);' || E'\n' ||
  '  RETURN v_result || jsonb_build_object(''expected_factor'', p_expected_factor);',
  '  -- This routine has already locked the line/session and completed the contextual authorization.' || E'\n' ||
  '  -- Write the normalized unit snapshot directly; do not delegate to the legacy writer,' || E'\n' ||
  '  -- whose older role-permission fallback cannot express offline-only contextual grants.' || E'\n' ||
  '  UPDATE public.stocktake_lines' || E'\n' ||
  '  SET entered_quantity = p_entered_quantity,' || E'\n' ||
  '      entered_unit = v_unit,' || E'\n' ||
  '      conversion_factor = v_current_factor,' || E'\n' ||
  '      base_unit = v_base_unit,' || E'\n' ||
  '      counted_qty = p_entered_quantity * v_current_factor' || E'\n' ||
  '  WHERE id = p_line_id;' || E'\n' ||
  '  RETURN jsonb_build_object(''success'',true,''line_id'',p_line_id,''counted_qty'',p_entered_quantity*v_current_factor,' ||
  '''entered_quantity'',p_entered_quantity,''entered_unit'',v_unit,''conversion_factor'',v_current_factor,' ||
  '''base_unit'',v_base_unit,''expected_factor'',p_expected_factor);');
 IF n=d THEN RAISE EXCEPTION 'legacy stocktake writer delegation not found'; END IF;
 EXECUTE n;
END;
$migration$;
