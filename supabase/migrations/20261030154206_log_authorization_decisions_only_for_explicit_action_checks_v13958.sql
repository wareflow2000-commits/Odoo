DO $migration$
DECLARE d text; n text;
BEGIN
 SELECT pg_get_functiondef('public.authorize_action(text,text,uuid,uuid,jsonb,boolean)'::regprocedure) INTO d;
 n := replace(d,'IF p_log_decision OR v_break_glass THEN','IF p_log_decision THEN');
 IF n=d THEN RAISE EXCEPTION 'authorization decision logging condition not found'; END IF;
 EXECUTE n;
END;
$migration$;
