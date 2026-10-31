DO $migration$
DECLARE d text; n text; old_scope text; new_scope text;
BEGIN
 SELECT pg_get_functiondef('public.authorize_action(text,text,uuid,uuid,jsonb,boolean)'::regprocedure) INTO d;
 old_scope :=
  'AND (g.scope_type=''ALL''' || E'\n' ||
  '     OR (g.scope_type=''OWN'' AND v_context->>''owner_id''=v_user_id::text)' || E'\n' ||
  '     OR (g.scope_type=''WAREHOUSE'' AND p_warehouse_id=g.warehouse_id)' || E'\n' ||
  '     OR (g.scope_type=''CONTEXT'' AND v_context @> g.conditions))';
 new_scope :=
  'AND (g.scope_type=''ALL''' || E'\n' ||
  '     OR (g.scope_type=''OWN'' AND v_context->>''owner_id''=v_user_id::text)' || E'\n' ||
  '     OR (g.scope_type=''WAREHOUSE'' AND p_warehouse_id=g.warehouse_id)' || E'\n' ||
  '     OR (g.scope_type=''CONTEXT'' AND COALESCE(g.conditions,''{}''::jsonb)<>''{}''::jsonb))' || E'\n' ||
  '   AND (COALESCE(g.conditions,''{}''::jsonb)=''{}''::jsonb OR v_context @> g.conditions)';
 n:=replace(d,old_scope,new_scope);
 IF n=d OR (length(d)-length(n))=0 THEN RAISE EXCEPTION 'authorization scope/condition clauses not found'; END IF;
 n:=replace(n,
  '-- Break-glass decisions are always recorded, even through legacy boolean' || E'\n' ||
  '-- permission helpers that suppress ordinary decision logging.' || E'\n',
  '-- Decision records are written only for explicit action checks, never UI probes.' || E'\n');
 EXECUTE n;
END;
$migration$;
