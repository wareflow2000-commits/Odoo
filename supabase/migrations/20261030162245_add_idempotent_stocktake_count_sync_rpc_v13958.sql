CREATE TABLE IF NOT EXISTS public.stocktake_count_sync_operations (
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
 operation_id text NOT NULL,
 session_id uuid NOT NULL REFERENCES public.stocktake_sessions(id) ON DELETE RESTRICT,
 line_id uuid NOT NULL REFERENCES public.stocktake_lines(id) ON DELETE RESTRICT,
 warehouse_id uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE RESTRICT,
 payload_hash text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,operation_id)
);
ALTER TABLE public.stocktake_count_sync_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.stocktake_count_sync_operations FROM PUBLIC,anon,authenticated;
COMMENT ON TABLE public.stocktake_count_sync_operations IS
'Internal server-only idempotency ledger for offline stocktake count synchronization. RLS is enabled and client table privileges are revoked; access is through save_offline_stocktake_count_v2 only.';

CREATE OR REPLACE FUNCTION public.save_offline_stocktake_count_v2(
 p_line_id uuid,p_entered_quantity numeric,p_entered_unit text,p_expected_factor numeric,p_operation_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
 v_user_id uuid:=auth.uid();
 v_assigned uuid[];
 v_session record;
 v_payload_hash text;
 v_existing public.stocktake_count_sync_operations%ROWTYPE;
 v_result jsonb;
BEGIN
 IF v_user_id IS NULL OR NOT public.current_user_is_active() THEN
  RAISE EXCEPTION 'An active authenticated user is required' USING ERRCODE='42501';
 END IF;
 IF p_operation_id IS NULL OR btrim(p_operation_id)='' OR length(p_operation_id)>200 THEN
  RAISE EXCEPTION 'A valid stocktake count operation id is required' USING ERRCODE='22023';
 END IF;
 SELECT s.id,s.warehouse_id,s.created_by,s.status,s.review_status
 INTO v_session
 FROM public.stocktake_lines l JOIN public.stocktake_sessions s ON s.id=l.session_id
 WHERE l.id=p_line_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Stocktake line not found'; END IF;

 -- Lock the user's profile row to serialize operation-id retries for this actor.
 SELECT COALESCE(p.assigned_warehouse_ids,ARRAY[]::uuid[])
 INTO v_assigned FROM public.profiles p
 WHERE p.id=v_user_id AND p.status='ACTIVE' FOR UPDATE;
 IF cardinality(v_assigned)<>1 OR v_assigned[1] IS DISTINCT FROM v_session.warehouse_id THEN
  RAISE EXCEPTION 'Offline stocktake count requires exactly one explicitly assigned warehouse matching the session'
   USING ERRCODE='42501';
 END IF;
 IF NOT public.current_user_can_access_warehouse(v_session.warehouse_id) THEN
  RAISE EXCEPTION 'Offline stocktake warehouse is outside the current user scope' USING ERRCODE='42501';
 END IF;

 v_payload_hash:=md5(jsonb_build_object(
  'line_id',p_line_id,'quantity',p_entered_quantity,
  'unit',p_entered_unit,'expected_factor',p_expected_factor
 )::text);
 SELECT * INTO v_existing FROM public.stocktake_count_sync_operations
 WHERE user_id=v_user_id AND operation_id=p_operation_id FOR UPDATE;
 IF FOUND THEN
  IF v_existing.line_id IS DISTINCT FROM p_line_id
     OR v_existing.session_id IS DISTINCT FROM v_session.id
     OR v_existing.payload_hash IS DISTINCT FROM v_payload_hash THEN
   RAISE EXCEPTION 'STOCKTAKE_OPERATION_ID_REUSED_WITH_DIFFERENT_PAYLOAD' USING ERRCODE='23505';
  END IF;
  RETURN v_existing.result || jsonb_build_object('idempotent',true,'operation_id',p_operation_id);
 END IF;

 v_result:=public.save_stocktake_count_v3_internal(
  p_line_id,p_entered_quantity,p_entered_unit,p_expected_factor,true
 );
 INSERT INTO public.stocktake_count_sync_operations
  (user_id,operation_id,session_id,line_id,warehouse_id,payload_hash,result)
 VALUES (v_user_id,p_operation_id,v_session.id,p_line_id,v_session.warehouse_id,v_payload_hash,v_result);
 RETURN v_result || jsonb_build_object('idempotent',false,'operation_id',p_operation_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.save_offline_stocktake_count(uuid,numeric,text,numeric) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.save_offline_stocktake_count_v2(uuid,numeric,text,numeric,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.save_offline_stocktake_count_v2(uuid,numeric,text,numeric,text) TO authenticated;
