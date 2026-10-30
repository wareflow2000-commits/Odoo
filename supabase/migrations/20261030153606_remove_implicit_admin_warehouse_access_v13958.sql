DO $migration$
DECLARE d text; n text;
BEGIN
 SELECT pg_get_functiondef('public.current_user_can_access_warehouse(uuid)'::regprocedure) INTO d;
 n := replace(d,'p.role IN (''SUPER_ADMIN'',''ADMIN'')','p.role = ''SUPER_ADMIN''');
 IF n=d THEN RAISE EXCEPTION 'legacy ADMIN implicit warehouse access not found'; END IF;
 n := replace(n,
  '-- ALL is an explicit role-level choice; INHERIT preserves legacy admin-only global access.',
  '-- ALL is an explicit role-level choice; INHERIT preserves only SUPER_ADMIN global access.');
 EXECUTE n;
END;
$migration$;
