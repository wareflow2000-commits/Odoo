CREATE OR REPLACE FUNCTION public.review_stocktake_session(
 p_session_id uuid,p_approve boolean,p_comment text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
 v_user uuid:=auth.uid();
 v_s public.stocktake_sessions%ROWTYPE;
BEGIN
 IF v_user IS NULL OR NOT public.current_user_is_active() THEN
  RAISE EXCEPTION 'Active authenticated user required' USING ERRCODE='42501';
 END IF;
 SELECT * INTO v_s FROM public.stocktake_sessions WHERE id=p_session_id FOR UPDATE;
 IF NOT FOUND OR v_s.status<>'IN_PROGRESS' THEN
  RAISE EXCEPTION 'Session not found or not in progress';
 END IF;
 IF v_s.review_status<>'PENDING_REVIEW' THEN
  RAISE EXCEPTION 'Only pending sessions can be reviewed';
 END IF;
 IF v_s.created_by=v_user OR v_s.submitted_by=v_user THEN
  RAISE EXCEPTION 'Creator/submitter cannot approve own session' USING ERRCODE='42501';
 END IF;
 IF EXISTS (
  SELECT 1 FROM public.authorization_decisions d
  WHERE d.actor_user_id=v_user
   AND d.action_key IN ('action:stocktake:count','action:stocktake:manage')
   AND d.resource_type='stocktake_session'
   AND d.resource_id=p_session_id
   AND d.decision='ALLOW'
   AND d.context ? 'line_id'
   AND d.created_at>=v_s.created_at
 ) THEN
  RAISE EXCEPTION 'A user who counted this stocktake session cannot review or approve it' USING ERRCODE='42501';
 END IF;
 IF NOT public.current_user_can_access_warehouse(v_s.warehouse_id) THEN
  RAISE EXCEPTION 'You cannot review a stocktake outside your assigned warehouses' USING ERRCODE='42501';
 END IF;
 IF NOT public.authorize_action(
  'action:stocktake:approve','stocktake_session',p_session_id,v_s.warehouse_id,
  jsonb_build_object('owner_id',v_s.created_by,'submitted_by',v_s.submitted_by,
    'status',v_s.status,'review_status',v_s.review_status),true
 ) THEN
  RAISE EXCEPTION 'Approval permission required for this stocktake session' USING ERRCODE='42501';
 END IF;
 UPDATE public.stocktake_sessions
 SET review_status=CASE WHEN p_approve THEN 'APPROVED' ELSE 'REJECTED' END,
     reviewed_by=v_user,reviewed_at=now(),
     review_comment=NULLIF(trim(COALESCE(p_comment,'')),'')
 WHERE id=p_session_id;
 RETURN jsonb_build_object('success',true,'session_id',p_session_id,
  'review_status',CASE WHEN p_approve THEN 'APPROVED' ELSE 'REJECTED' END);
END;
$function$;
