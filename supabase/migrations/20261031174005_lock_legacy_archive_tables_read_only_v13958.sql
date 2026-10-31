-- Archived legacy balance/movement tables are read-only client data.
-- The client has no write path for these tables; their legacy MANAGER-only
-- policies bypass the explicit authorization grant model. Close direct DML.

REVOKE INSERT, UPDATE, DELETE ON TABLE
  public.archive_balances,
  public.archive_movements
FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS archive_balances_manager_insert ON public.archive_balances;
DROP POLICY IF EXISTS archive_balances_manager_update ON public.archive_balances;
DROP POLICY IF EXISTS archive_balances_manager_delete ON public.archive_balances;

DROP POLICY IF EXISTS archive_movements_manager_insert ON public.archive_movements;
DROP POLICY IF EXISTS archive_movements_manager_update ON public.archive_movements;
DROP POLICY IF EXISTS archive_movements_manager_delete ON public.archive_movements;

DO $verify$
BEGIN
  IF has_table_privilege('authenticated','public.archive_balances','INSERT')
     OR has_table_privilege('authenticated','public.archive_balances','UPDATE')
     OR has_table_privilege('authenticated','public.archive_balances','DELETE')
     OR has_table_privilege('authenticated','public.archive_movements','INSERT')
     OR has_table_privilege('authenticated','public.archive_movements','UPDATE')
     OR has_table_privilege('authenticated','public.archive_movements','DELETE') THEN
    RAISE EXCEPTION 'Authenticated direct DML remains on legacy archive tables';
  END IF;

  IF has_table_privilege('anon','public.archive_balances','INSERT')
     OR has_table_privilege('anon','public.archive_balances','UPDATE')
     OR has_table_privilege('anon','public.archive_balances','DELETE')
     OR has_table_privilege('anon','public.archive_movements','INSERT')
     OR has_table_privilege('anon','public.archive_movements','UPDATE')
     OR has_table_privilege('anon','public.archive_movements','DELETE') THEN
    RAISE EXCEPTION 'Anon direct DML remains on legacy archive tables';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public'
      AND tablename IN ('archive_balances','archive_movements')
      AND cmd IN ('INSERT','UPDATE','DELETE')
  ) THEN
    RAISE EXCEPTION 'Legacy archive DML policies remain installed';
  END IF;
END;
$verify$;
