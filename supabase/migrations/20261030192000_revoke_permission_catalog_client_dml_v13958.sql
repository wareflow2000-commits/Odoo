-- The permission catalogue is maintained by migrations, not by client CRUD.
-- Keep authenticated SELECT for permission-matrix rendering; remove unused DML.

REVOKE INSERT, UPDATE, DELETE ON TABLE public.permissions
FROM PUBLIC, anon, authenticated;

DO $verify$
BEGIN
  IF has_table_privilege('authenticated','public.permissions','INSERT')
     OR has_table_privilege('authenticated','public.permissions','UPDATE')
     OR has_table_privilege('authenticated','public.permissions','DELETE')
     OR has_table_privilege('anon','public.permissions','INSERT')
     OR has_table_privilege('anon','public.permissions','UPDATE')
     OR has_table_privilege('anon','public.permissions','DELETE') THEN
    RAISE EXCEPTION 'Client DML remains enabled on the permission catalogue';
  END IF;
  IF NOT has_table_privilege('authenticated','public.permissions','SELECT') THEN
    RAISE EXCEPTION 'Authenticated permission-catalogue SELECT was unexpectedly removed';
  END IF;
END;
$verify$;
