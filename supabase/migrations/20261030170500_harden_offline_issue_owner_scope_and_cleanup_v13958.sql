DO $migration$
DECLARE d text; n text;
BEGIN
 SELECT pg_get_functiondef('public.process_sync_batch_v2_impl(text,jsonb)'::regprocedure) INTO d;

 n := regexp_replace(d,
   '      IF v_operation_type <> ''ISSUE'' THEN\s+RAISE EXCEPTION ''Unsupported offline operation_type: %'', v_operation_type;\s+END IF;\s+',
   '', 'g');
 IF n = d THEN RAISE EXCEPTION 'redundant offline operation check not found'; END IF;
 d := n;

 n := replace(d,
   'v_permission := CASE v_operation_type' || E'\n' ||
   '        WHEN ''ISSUE'' THEN ''action:transaction:issue:create''' || E'\n' ||
   '        WHEN ''RETURN_FROM_USAGE'' THEN ''action:transaction:grn:create''' || E'\n' ||
   '        WHEN ''GRN'' THEN ''action:transaction:grn:create''' || E'\n' ||
   '        WHEN ''OPENING_BALANCE'' THEN ''action:transaction:adjustment:create''' || E'\n' ||
   '        WHEN ''ADJUSTMENT_IN'' THEN ''action:transaction:adjustment:create''' || E'\n' ||
   '        WHEN ''ADJUSTMENT_OUT'' THEN ''action:transaction:adjustment:create''' || E'\n' ||
   '        WHEN ''STOCKTAKE'' THEN ''action:stocktake:settle''' || E'\n' ||
   '      END;',
   'v_permission := ''action:transaction:issue:create'';');
 IF n = d THEN RAISE EXCEPTION 'offline permission mapping not found'; END IF;
 d := n;

 n := replace(d,
   'IF cardinality(COALESCE(v_assigned_warehouses, ARRAY[]::uuid[])) <> 1' || E'\n' ||
   '                     OR v_assigned_warehouses[1] IS DISTINCT FROM v_warehouse_id THEN' || E'\n' ||
   '                    RAISE EXCEPTION ''Offline ISSUE requires exactly one explicitly assigned warehouse'' USING ERRCODE = ''42501'';' || E'\n' ||
   '                  END IF;',
   'IF cardinality(COALESCE(v_assigned_warehouses, ARRAY[]::uuid[])) <> 1' || E'\n' ||
   '                     OR v_assigned_warehouses[1] IS DISTINCT FROM v_warehouse_id' || E'\n' ||
   '                     OR NOT public.current_user_can_access_warehouse(v_warehouse_id) THEN' || E'\n' ||
   '                    RAISE EXCEPTION ''Offline ISSUE requires exactly one explicitly assigned and accessible warehouse'' USING ERRCODE = ''42501'';' || E'\n' ||
   '                  END IF;');
 IF n = d THEN RAISE EXCEPTION 'single warehouse guard not found for effective-scope hardening'; END IF;
 d := n;

 n := replace(d,
   '      SELECT EXISTS(SELECT 1 FROM public.transactions WHERE id = v_transaction_id) INTO v_tx_exists;',
   '      SELECT EXISTS(SELECT 1 FROM public.transactions WHERE id = v_transaction_id) INTO v_tx_exists;' || E'\n' ||
   '      IF v_tx_exists AND NOT EXISTS (' || E'\n' ||
   '        SELECT 1 FROM public.transactions t' || E'\n' ||
   '        WHERE t.id = v_transaction_id' || E'\n' ||
   '          AND t.created_by = v_user_id' || E'\n' ||
   '          AND t.transaction_type = ''ISSUE''' || E'\n' ||
   '          AND t.warehouse_id = v_warehouse_id' || E'\n' ||
   '      ) THEN' || E'\n' ||
   '        RAISE EXCEPTION ''Offline ISSUE transaction is not owned by this user or warehouse'' USING ERRCODE = ''42501'';' || E'\n' ||
   '      END IF;');
 IF n = d THEN RAISE EXCEPTION 'offline transaction ownership insertion point not found'; END IF;
 d := n;

 n := regexp_replace(d,
   '      IF v_operation_type IN \(''ISSUE'',''ADJUSTMENT_OUT''\) THEN\s+v_delta := -abs\(v_delta\);\s+ELSE\s+v_delta := abs\(v_delta\);\s+END IF;',
   '      v_delta := -abs(v_delta);',
   'g');
 IF n = d THEN RAISE EXCEPTION 'offline delta direction block not found'; END IF;
 EXECUTE n;
END;
$migration$;
