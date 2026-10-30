DO $migration$
DECLARE d text; n text; p1 integer; p2 integer; p_end integer;
BEGIN
 SELECT pg_get_functiondef('public.approve_transaction(uuid)'::regprocedure) INTO d;
 p1 := position('''approval_mode'', CASE' in d);
 IF p1=0 THEN RAISE EXCEPTION 'approval_mode audit expression not found'; END IF;
 p2 := position('END)' in substring(d from p1));
 IF p2=0 THEN RAISE EXCEPTION 'approval_mode audit expression terminator not found'; END IF;
 p_end := p1 + p2 + 2;
 n := left(d,p1-1) ||
   '''approval_mode'', CASE WHEN v_tx_rec.created_by = v_user_id' || E'\n' ||
   '        THEN ''explicit_self_approval''' || E'\n' ||
   '        ELSE ''independent_approval''' || E'\n' ||
   '      END)' ||
   substr(d,p_end+1);
 IF position('v_require_approval' in n)>0 OR position('v_actor_role' in n)>0 THEN
   RAISE EXCEPTION 'Legacy approval role/settings references remain after cleanup';
 END IF;
 EXECUTE n;
END;
$migration$;
