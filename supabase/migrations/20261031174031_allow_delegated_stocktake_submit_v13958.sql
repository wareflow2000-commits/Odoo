-- Honor explicit contextual submit delegation for stocktake sessions.
-- The session creator retains the start-permission fallback; an independent
-- user may submit only with an explicit submit or manage grant. The reviewer
-- remains separated from both creator and submitter by review_stocktake_session.

CREATE OR REPLACE FUNCTION public.submit_stocktake_for_review(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_s public.stocktake_sessions%ROWTYPE;
  v_total integer;
  v_counted integer;
  v_can_submit boolean;
  v_can_manage boolean;
  v_context jsonb;
BEGIN
  IF v_user IS NULL OR NOT public.current_user_is_active() THEN
    RAISE EXCEPTION 'Active authenticated user required' USING ERRCODE='42501';
  END IF;

  SELECT * INTO v_s
  FROM public.stocktake_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND OR v_s.status <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'Only in-progress sessions can be submitted';
  END IF;
  IF v_s.review_status NOT IN ('DRAFT','REJECTED') THEN
    RAISE EXCEPTION 'Session already submitted';
  END IF;

  IF NOT public.current_user_can_access_warehouse(v_s.warehouse_id) THEN
    RAISE EXCEPTION 'Warehouse not assigned' USING ERRCODE='42501';
  END IF;

  v_context := jsonb_build_object(
    'owner_id',v_s.created_by,
    'submitted_by',v_s.submitted_by,
    'status',v_s.status,
    'review_status',v_s.review_status,
    'offline',false
  );

  v_can_manage := public.authorize_action(
    'action:stocktake:manage','stocktake_session',p_session_id,
    v_s.warehouse_id,v_context,true
  );
  v_can_submit := public.authorize_action(
    'action:stocktake:submit','stocktake_session',p_session_id,
    v_s.warehouse_id,v_context,true
  );

  -- Starting a session also permits its creator to submit it, but does not
  -- grant that fallback to another user. Delegated submitters need the
  -- distinct submit permission on this session and warehouse.
  IF v_s.created_by = v_user THEN
    v_can_submit := v_can_submit OR public.authorize_action(
      'action:stocktake:start','stocktake_session',p_session_id,
      v_s.warehouse_id,v_context,true
    );
  END IF;

  IF NOT v_can_submit AND NOT v_can_manage THEN
    RAISE EXCEPTION 'Submit permission required for this stocktake session'
      USING ERRCODE='42501';
  END IF;

  SELECT count(*), count(*) FILTER (WHERE counted_qty IS NOT NULL)
  INTO v_total, v_counted
  FROM public.stocktake_lines
  WHERE session_id = p_session_id;

  IF v_total = 0 OR v_total <> v_counted THEN
    RAISE EXCEPTION 'All stocktake lines must be counted before submission';
  END IF;

  UPDATE public.stocktake_sessions
  SET review_status = 'PENDING_REVIEW',
      submitted_by = v_user,
      submitted_at = now(),
      reviewed_by = NULL,
      reviewed_at = NULL,
      review_comment = NULL
  WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'success',true,
    'session_id',p_session_id,
    'review_status','PENDING_REVIEW',
    'lines_counted',v_counted
  );
END;
$function$;

DO $verify$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef('public.submit_stocktake_for_review(uuid)'::regprocedure)
  INTO v_def;

  IF position('action:stocktake:submit' IN v_def)=0
     OR position('v_s.created_by = v_user' IN v_def)=0
     OR position('action:stocktake:start' IN v_def)=0
     OR position('action:stocktake:manage' IN v_def)=0
     OR position('submitted_by' IN v_def)=0
     OR position('offline' IN v_def)=0 THEN
    RAISE EXCEPTION 'Delegated stocktake submit authorization contract verification failed';
  END IF;
END;
$verify$;
