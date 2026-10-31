DO $migration$
DECLARE d text; n text;
BEGIN
 SELECT pg_get_functiondef('public.authorize_action(text,text,uuid,uuid,jsonb,boolean)'::regprocedure) INTO d;
 n:=replace(d,
  'OR (g.scope_type=''CONTEXT'' AND v_context @> g.conditions))',
  'OR (g.scope_type=''CONTEXT'' AND COALESCE(g.conditions,''{}''::jsonb)<>''{}''::jsonb))' || E'\n' ||
  '    AND (COALESCE(g.conditions,''{}''::jsonb)=''{}''::jsonb OR v_context @> g.conditions)');
 IF n=d THEN RAISE EXCEPTION 'allow grant contextual predicate not found'; END IF;
 EXECUTE n;
END;
$migration$;
