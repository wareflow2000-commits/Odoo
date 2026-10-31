-- Offline transaction synchronization is restricted to ISSUE only.
-- ISSUE must remain owned by the authenticated creator and bound to exactly
-- one explicitly assigned warehouse; no role-based warehouse bypass is allowed.
DO $migration$
DECLARE d text; n text;
BEGIN
 SELECT pg_get_functiondef('public.process_sync_batch_v2_impl(text,jsonb)'::regprocedure) INTO d;

 n := regexp_replace(d,
   'IF v_operation_type IN \(''STOCKTAKE'',''OPENING_BALANCE''\) THEN\s+RAISE EXCEPTION ''% must use its approved accounting workflow and cannot be posted directly by offline sync'',\s+v_operation_type;\s+END IF;',
   'IF v_operation_type <> ''ISSUE'' THEN' || E'\n' ||
   '        RAISE EXCEPTION ''Only ISSUE transactions may be synchronized offline'';' || E'\n' ||
   '      END IF;',
   'g');
 IF n = d THEN RAISE EXCEPTION 'offline operation type guard not found'; END IF;
 d := n;

 n := regexp_replace(d,
   'IF v_operation_type NOT IN \(''ISSUE'',''GRN'',''ADJUSTMENT_IN'',''ADJUSTMENT_OUT'',\s+''STOCKTAKE'',''OPENING_BALANCE'',''RETURN_FROM_USAGE''\) THEN\s+RAISE EXCEPTION ''Unsupported operation_type: %'', v_operation_type;\s+END IF;',
   'IF v_operation_type <> ''ISSUE'' THEN' || E'\n' ||
   '        RAISE EXCEPTION ''Unsupported offline operation_type: %'', v_operation_type;' || E'\n' ||
   '      END IF;',
   'g');
 IF n = d THEN RAISE EXCEPTION 'offline operation allow-list not found'; END IF;
 d := n;

 n := regexp_replace(d,
   '      -- Offline sync must enforce the same privileged opening-balance rule as the online transaction path\.\s+IF v_operation_type = ''OPENING_BALANCE''\s+AND v_user_role NOT IN \(''SUPER_ADMIN'', ''MANAGER''\) THEN\s+RAISE EXCEPTION ''Only a manager or super administrator may create an opening balance'';\s+END IF;\s+',
   '', 'g');
 IF n = d THEN RAISE EXCEPTION 'offline opening-balance role guard not found'; END IF;
 d := n;

 n := regexp_replace(d,
   'IF v_user_role NOT IN \(''SUPER_ADMIN'',''MANAGER'',''ADMIN''\)\s+AND NOT \(\s+v_warehouse_id = ANY\(\s+COALESCE\(v_assigned_warehouses, ARRAY\[\]::uuid\[\]\)\s+\)\s+\)\s+THEN\s+RAISE EXCEPTION ''User is not assigned to the requested warehouse'';\s+END IF;',
   'IF cardinality(COALESCE(v_assigned_warehouses, ARRAY[]::uuid[])) <> 1' || E'\n' ||
   '                     OR v_assigned_warehouses[1] IS DISTINCT FROM v_warehouse_id THEN' || E'\n' ||
   '                    RAISE EXCEPTION ''Offline ISSUE requires exactly one explicitly assigned warehouse'' USING ERRCODE = ''42501'';' || E'\n' ||
   '                  END IF;',
   'gs');
 IF n = d THEN RAISE EXCEPTION 'offline warehouse bypass guard not found'; END IF;

 EXECUTE n;
END;
$migration$;
