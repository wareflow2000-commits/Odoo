-- SUPER_ADMIN uses the audited global break-glass path and must not be
-- assigned a configurable role warehouse scope.
DO $migration$
DECLARE
  v_definition text;
  v_updated text;
  v_old text := E'    ''SUPER_ADMIN'',''ADMIN'',''MANAGER'',''WAREHOUSE_MANAGER'',\n    ''WAREHOUSE_KEEPER'',''STOREKEEPER'',''CLERK'',''AUDITOR'',''VIEWER''';
  v_new text := E'    ''ADMIN'',''MANAGER'',''WAREHOUSE_MANAGER'',\n    ''WAREHOUSE_KEEPER'',''STOREKEEPER'',''CLERK'',''AUDITOR'',''VIEWER''';
BEGIN
  SELECT pg_get_functiondef(
    'public.admin_replace_role_warehouse_scope(text,text,uuid[])'::regprocedure
  ) INTO v_definition;

  IF position(v_new IN v_definition) = 0 THEN
    IF position(v_old IN v_definition) = 0 THEN
      RAISE EXCEPTION 'Role warehouse scope allowlist mismatch; no changes applied';
    END IF;
    v_updated := replace(v_definition, v_old, v_new);
    IF v_updated = v_definition THEN
      RAISE EXCEPTION 'Role warehouse scope replacement made no change';
    END IF;
    EXECUTE v_updated;
  END IF;
END;
$migration$;

DO $verify$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.admin_replace_role_warehouse_scope(text,text,uuid[])'::regprocedure
  ) INTO v_definition;

  IF position('''SUPER_ADMIN'',''ADMIN'',''MANAGER'',''WAREHOUSE_MANAGER''' IN v_definition) > 0
     OR position('Only an active SUPER_ADMIN may edit role warehouse scopes' IN v_definition) = 0
     OR position('action:authorization:manage' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Role warehouse scope privilege guard verification failed';
  END IF;
END;
$verify$;
