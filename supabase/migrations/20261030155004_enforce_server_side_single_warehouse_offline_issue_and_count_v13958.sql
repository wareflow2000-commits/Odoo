DO $migration$
DECLARE d text; n text;
BEGIN
 SELECT pg_get_functiondef('public.create_transaction_with_lines(uuid,jsonb,jsonb)'::regprocedure) INTO d;
 n:=replace(d,'FUNCTION public.create_transaction_with_lines(','FUNCTION public.create_transaction_with_lines_internal(');
 n:=replace(n,'p_lines jsonb)','p_lines jsonb, p_offline boolean)');
 n:=replace(n,'  v_role text;' || E'\n' || '  v_status text;' || E'\n' || '  v_assigned uuid[];','  v_status text;');
 n:=replace(n,
  '  SELECT p.role, p.status, COALESCE(p.assigned_warehouse_ids, ARRAY[]::uuid[])' || E'\n' ||
  '    INTO v_role, v_status, v_assigned' || E'\n' ||
  '  FROM public.profiles p WHERE p.id = v_user_id;',
  '  SELECT p.status INTO v_status FROM public.profiles p WHERE p.id = v_user_id;');
 n:=regexp_replace(n,E'\\s*WHEN ''RETURN_FROM_USAGE'' THEN ''action:transaction:grn:create''','', 'g');
 n:=regexp_replace(n,E'\\s*WHEN ''RETURN_FROM_CUSTOMER'' THEN ''action:transaction:grn:create''','', 'g');
 n:=regexp_replace(n,E'\\s*WHEN ''RETURN_TO_SUPPLIER'' THEN ''action:transaction:issue:create''','', 'g');
 n:=regexp_replace(n,E'\\s*WHEN ''OPENING_BALANCE'' THEN ''action:transaction:adjustment:create''','', 'g');
 n:=replace(n,
  'jsonb_build_object(''owner_id'',auth.uid(),''transaction_type'',v_type),true)',
  'jsonb_build_object(''owner_id'',auth.uid(),''transaction_type'',v_type,''offline'',p_offline),true)');
 IF n=d OR position('p_offline boolean' in n)=0 OR position('offline'',p_offline' in n)=0 THEN
  RAISE EXCEPTION 'transaction internal function transformation failed';
 END IF;
 EXECUTE n;

 EXECUTE $wrapper$
  CREATE OR REPLACE FUNCTION public.create_transaction_with_lines(
   p_transaction_id uuid,p_transaction jsonb,p_lines jsonb
  ) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO ''
  AS $function$
   SELECT public.create_transaction_with_lines_internal($1,$2,$3,false);
  $function$;
 $wrapper$;
 REVOKE ALL ON FUNCTION public.create_transaction_with_lines_internal(uuid,jsonb,jsonb,boolean) FROM PUBLIC,anon,authenticated;

 EXECUTE $offline_issue$
  CREATE OR REPLACE FUNCTION public.create_offline_issue_bundle(
   p_transaction_id uuid,p_transaction jsonb,p_lines jsonb
  ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
  AS $function$
  DECLARE
   v_user_id uuid := auth.uid();
   v_assigned uuid[];
   v_warehouse_id uuid;
   v_status text;
  BEGIN
   IF v_user_id IS NULL OR NOT public.current_user_is_active() THEN
    RAISE EXCEPTION 'An active authenticated user is required' USING ERRCODE='42501';
   END IF;
   IF p_transaction IS NULL OR jsonb_typeof(p_transaction)<>'object'
      OR upper(COALESCE(p_transaction->>'transaction_type',''))<>'ISSUE' THEN
    RAISE EXCEPTION 'Offline synchronization supports ISSUE transactions only' USING ERRCODE='42501';
   END IF;
   SELECT p.status,COALESCE(p.assigned_warehouse_ids,ARRAY[]::uuid[])
    INTO v_status,v_assigned FROM public.profiles p WHERE p.id=v_user_id;
   IF v_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'Active user profile required' USING ERRCODE='42501';
   END IF;
   v_warehouse_id:=NULLIF(p_transaction->>'warehouse_id','')::uuid;
   IF cardinality(v_assigned)<>1 OR v_warehouse_id IS NULL
      OR v_assigned[1] IS DISTINCT FROM v_warehouse_id THEN
    RAISE EXCEPTION 'Offline ISSUE requires exactly one explicitly assigned warehouse matching the voucher warehouse'
     USING ERRCODE='42501';
   END IF;
   IF NOT public.current_user_can_access_warehouse(v_warehouse_id) THEN
    RAISE EXCEPTION 'Offline ISSUE warehouse is outside the current user scope' USING ERRCODE='42501';
   END IF;
   RETURN public.create_transaction_with_lines_internal(p_transaction_id,p_transaction,p_lines,true);
  END;
  $function$;
 $offline_issue$;

 SELECT pg_get_functiondef('public.save_stocktake_count_v3(uuid,numeric,text,numeric)'::regprocedure) INTO d;
 n:=replace(d,'FUNCTION public.save_stocktake_count_v3(','FUNCTION public.save_stocktake_count_v3_internal(');
 n:=replace(n,'p_expected_factor numeric)','p_expected_factor numeric, p_offline boolean)');
 n:=replace(n,
  'jsonb_build_object(''owner_id'',v_session.created_by,''status'',v_session.status,''review_status'',v_session.review_status)',
  'jsonb_build_object(''owner_id'',v_session.created_by,''status'',v_session.status,''review_status'',v_session.review_status,''offline'',p_offline)');
 IF n=d OR position('p_offline boolean' in n)=0 OR position('offline'',p_offline' in n)=0 THEN
  RAISE EXCEPTION 'stocktake internal function transformation failed';
 END IF;
 EXECUTE n;

 EXECUTE $wrapper$
  CREATE OR REPLACE FUNCTION public.save_stocktake_count_v3(
   p_line_id uuid,p_entered_quantity numeric,p_entered_unit text,p_expected_factor numeric
  ) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO ''
  AS $function$
   SELECT public.save_stocktake_count_v3_internal($1,$2,$3,$4,false);
  $function$;
 $wrapper$;
 REVOKE ALL ON FUNCTION public.save_stocktake_count_v3_internal(uuid,numeric,text,numeric,boolean) FROM PUBLIC,anon,authenticated;

 EXECUTE $offline_count$
  CREATE OR REPLACE FUNCTION public.save_offline_stocktake_count(
   p_line_id uuid,p_entered_quantity numeric,p_entered_unit text,p_expected_factor numeric
  ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
  AS $function$
  DECLARE
   v_user_id uuid := auth.uid();
   v_assigned uuid[];
   v_session record;
  BEGIN
   IF v_user_id IS NULL OR NOT public.current_user_is_active() THEN
    RAISE EXCEPTION 'An active authenticated user is required' USING ERRCODE='42501';
   END IF;
   SELECT s.id,s.warehouse_id,s.created_by,s.status,s.review_status INTO v_session
   FROM public.stocktake_lines l JOIN public.stocktake_sessions s ON s.id=l.session_id
   WHERE l.id=p_line_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'Stocktake line not found'; END IF;
   SELECT COALESCE(p.assigned_warehouse_ids,ARRAY[]::uuid[]) INTO v_assigned
   FROM public.profiles p WHERE p.id=v_user_id AND p.status='ACTIVE';
   IF cardinality(v_assigned)<>1 OR v_assigned[1] IS DISTINCT FROM v_session.warehouse_id THEN
    RAISE EXCEPTION 'Offline stocktake count requires exactly one explicitly assigned warehouse matching the session'
     USING ERRCODE='42501';
   END IF;
   IF v_session.created_by IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'Offline stocktake count must remain bound to the session creator' USING ERRCODE='42501';
   END IF;
   IF NOT public.current_user_can_access_warehouse(v_session.warehouse_id) THEN
    RAISE EXCEPTION 'Offline stocktake warehouse is outside the current user scope' USING ERRCODE='42501';
   END IF;
   RETURN public.save_stocktake_count_v3_internal(
    p_line_id,p_entered_quantity,p_entered_unit,p_expected_factor,true
   );
  END;
  $function$;
 $offline_count$;

 REVOKE ALL ON FUNCTION public.create_offline_issue_bundle(uuid,jsonb,jsonb) FROM PUBLIC,anon;
 GRANT EXECUTE ON FUNCTION public.create_offline_issue_bundle(uuid,jsonb,jsonb) TO authenticated;
 REVOKE ALL ON FUNCTION public.save_offline_stocktake_count(uuid,numeric,text,numeric) FROM PUBLIC,anon;
 GRANT EXECUTE ON FUNCTION public.save_offline_stocktake_count(uuid,numeric,text,numeric) TO authenticated;
END;
$migration$;
