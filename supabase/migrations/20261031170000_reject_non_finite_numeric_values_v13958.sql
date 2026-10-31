-- Reject PostgreSQL numeric NaN and infinities at every public-table boundary.
-- CHECK (value > 0) is not sufficient: PostgreSQL treats numeric NaN as greater
-- than ordinary numbers, so NaN can pass existing quantity checks.
DO $migration$
DECLARE
  v_table record;
  v_constraint_name constant text := 'wms_finite_numeric_values';
BEGIN
  FOR v_table IN
    SELECT c.relname AS table_name,
           string_agg(
             format('(%1$I IS NULL OR %1$I::text NOT IN (''NaN'',''Infinity'',''-Infinity''))', ic.column_name),
             ' AND ' ORDER BY ic.ordinal_position
           ) AS check_expression
    FROM information_schema.columns ic
    JOIN pg_class c ON c.relname = ic.table_name
    JOIN pg_namespace n ON n.oid = c.relnamespace
                       AND n.nspname = ic.table_schema
    WHERE ic.table_schema = 'public'
      AND ic.data_type IN ('numeric','double precision','real')
      AND ic.is_generated = 'NEVER'
      AND c.relkind IN ('r','p')
    GROUP BY c.relname
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint con
      WHERE con.conrelid = format('public.%I', v_table.table_name)::regclass
        AND con.conname = v_constraint_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%s) NOT VALID',
        v_table.table_name, v_constraint_name, v_table.check_expression
      );
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I VALIDATE CONSTRAINT %I',
      v_table.table_name, v_constraint_name
    );
  END LOOP;
END;
$migration$;

-- Defense in depth at the transaction-line trigger boundary.
DO $trigger_guard$
DECLARE
  v_definition text;
  v_updated text;
  v_old text := E'BEGIN\n  SELECT i.base_unit INTO v_base';
  v_new text := E'BEGIN\n  IF (NEW.quantity IS NOT NULL AND NEW.quantity::text IN (''NaN'',''Infinity'',''-Infinity''))\n     OR (NEW.entered_quantity IS NOT NULL AND NEW.entered_quantity::text IN (''NaN'',''Infinity'',''-Infinity''))\n     OR (NEW.conversion_factor IS NOT NULL AND NEW.conversion_factor::text IN (''NaN'',''Infinity'',''-Infinity'')) THEN\n    RAISE EXCEPTION ''NON_FINITE_TRANSACTION_LINE_VALUE'' USING ERRCODE = ''22003'';\n  END IF;\n\n  SELECT i.base_unit INTO v_base';
BEGIN
  SELECT pg_get_functiondef('public.normalize_transaction_line_unit()'::regprocedure)
    INTO v_definition;

  IF position('NON_FINITE_TRANSACTION_LINE_VALUE' IN v_definition) = 0 THEN
    IF position(v_old IN v_definition) = 0 THEN
      RAISE EXCEPTION 'normalize_transaction_line_unit definition mismatch; refusing unsafe replacement';
    END IF;
    v_updated := replace(v_definition, v_old, v_new);
    IF v_updated = v_definition THEN
      RAISE EXCEPTION 'normalize_transaction_line_unit finite guard insertion made no change';
    END IF;
    EXECUTE v_updated;
  END IF;
END;
$trigger_guard$;

-- Reject non-finite offline ISSUE quantities before a pending voucher can be created.
DO $create_guard$
DECLARE
  v_definition text;
  v_updated text;
  v_old text := 'IF v_line.quantity IS NULL OR v_line.quantity <= 0 THEN';
  v_new text := 'IF v_line.quantity::text IN (''NaN'',''Infinity'',''-Infinity'') THEN'
    || E'\n      RAISE EXCEPTION ''NON_FINITE_TRANSACTION_QUANTITY'' USING ERRCODE = ''22003'';'
    || E'\n    END IF;'
    || E'\n    IF v_line.quantity IS NULL OR v_line.quantity <= 0 THEN';
BEGIN
  SELECT pg_get_functiondef(
    'public.create_transaction_with_lines_internal(uuid,jsonb,jsonb,boolean)'::regprocedure
  ) INTO v_definition;

  IF position('NON_FINITE_TRANSACTION_QUANTITY' IN v_definition) = 0 THEN
    IF position(v_old IN v_definition) = 0 THEN
      RAISE EXCEPTION 'create_transaction_with_lines_internal quantity guard mismatch';
    END IF;
    v_updated := replace(v_definition, v_old, v_new);
    IF v_updated = v_definition THEN
      RAISE EXCEPTION 'create_transaction_with_lines_internal finite guard insertion made no change';
    END IF;
    EXECUTE v_updated;
  END IF;
END;
$create_guard$;

-- Refuse any legacy/corrupt non-finite line at posting time as a second boundary.
DO $approval_guard$
DECLARE
  v_definition text;
  v_updated text;
  v_old text := 'IF v_rec.quantity IS NULL OR v_rec.quantity <= 0 THEN';
  v_new text := 'IF v_rec.quantity::text IN (''NaN'',''Infinity'',''-Infinity'') THEN'
    || E'\n      RAISE EXCEPTION ''NON_FINITE_TRANSACTION_QUANTITY'' USING ERRCODE = ''22003'';'
    || E'\n    END IF;'
    || E'\n    IF v_rec.quantity IS NULL OR v_rec.quantity <= 0 THEN';
BEGIN
  SELECT pg_get_functiondef('public.approve_transaction(uuid)'::regprocedure)
    INTO v_definition;

  IF position('NON_FINITE_TRANSACTION_QUANTITY' IN v_definition) = 0 THEN
    IF position(v_old IN v_definition) = 0 THEN
      RAISE EXCEPTION 'approve_transaction quantity guard mismatch';
    END IF;
    v_updated := replace(v_definition, v_old, v_new);
    IF v_updated = v_definition THEN
      RAISE EXCEPTION 'approve_transaction finite guard insertion made no change';
    END IF;
    EXECUTE v_updated;
  END IF;
END;
$approval_guard$;

DO $verify$
DECLARE
  v_numeric_tables integer;
  v_guarded_tables integer;
BEGIN
  SELECT count(DISTINCT c.oid)
    INTO v_numeric_tables
  FROM information_schema.columns ic
  JOIN pg_class c ON c.relname = ic.table_name
  JOIN pg_namespace n ON n.oid = c.relnamespace
                     AND n.nspname = ic.table_schema
  WHERE ic.table_schema = 'public'
    AND ic.data_type IN ('numeric','double precision','real')
    AND ic.is_generated = 'NEVER'
    AND c.relkind IN ('r','p');

  SELECT count(DISTINCT c.oid)
    INTO v_guarded_tables
  FROM information_schema.columns ic
  JOIN pg_class c ON c.relname = ic.table_name
  JOIN pg_namespace n ON n.oid = c.relnamespace
                     AND n.nspname = ic.table_schema
  JOIN pg_constraint con
    ON con.conrelid = c.oid
   AND con.conname = 'wms_finite_numeric_values'
   AND con.convalidated
  WHERE ic.table_schema = 'public'
    AND ic.data_type IN ('numeric','double precision','real')
    AND ic.is_generated = 'NEVER'
    AND c.relkind IN ('r','p');

  IF v_numeric_tables <> v_guarded_tables THEN
    RAISE EXCEPTION 'Finite numeric constraints incomplete: % numeric tables, % guarded tables',
      v_numeric_tables, v_guarded_tables;
  END IF;

  IF position('NON_FINITE_TRANSACTION_LINE_VALUE' IN
       pg_get_functiondef('public.normalize_transaction_line_unit()'::regprocedure)) = 0
     OR position('NON_FINITE_TRANSACTION_QUANTITY' IN
       pg_get_functiondef('public.create_transaction_with_lines_internal(uuid,jsonb,jsonb,boolean)'::regprocedure)) = 0
     OR position('NON_FINITE_TRANSACTION_QUANTITY' IN
       pg_get_functiondef('public.approve_transaction(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Non-finite transaction quantity function guards are incomplete';
  END IF;
END;
$verify$;