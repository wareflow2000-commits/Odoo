-- Deduplicate repeated row-level break-glass checks within one transaction.
-- RLS may evaluate the same permission predicate once per visible row. Each
-- distinct action/resource/warehouse/context decision is retained once, while
-- repeated evaluations of that same decision do not flood the audit table.

ALTER TABLE public.authorization_decisions
  ADD COLUMN IF NOT EXISTS transaction_id bigint,
  ADD COLUMN IF NOT EXISTS decision_fingerprint text;

CREATE UNIQUE INDEX IF NOT EXISTS authorization_decisions_tx_fingerprint_uidx
  ON public.authorization_decisions (transaction_id, decision_fingerprint);

DO $rewrite$
DECLARE
  d text;
  n text;
  old_block text := $old$
INSERT INTO public.authorization_decisions
   (actor_user_id,action_key,resource_type,resource_id,warehouse_id,decision,decision_reason,matched_grant_id,break_glass,context)
  VALUES (v_user_id,p_action_key,p_resource_type,p_resource_id,p_warehouse_id,v_decision,v_reason,COALESCE(v_deny_id,v_allow_id),v_break_glass,v_context);
$old$;
  new_block text := $new$
INSERT INTO public.authorization_decisions
   (transaction_id,decision_fingerprint,actor_user_id,action_key,resource_type,resource_id,warehouse_id,decision,decision_reason,matched_grant_id,break_glass,context)
  VALUES (
    txid_current(),
    md5(jsonb_build_object(
      'actor_user_id',v_user_id,
      'action_key',p_action_key,
      'resource_type',p_resource_type,
      'resource_id',p_resource_id,
      'warehouse_id',p_warehouse_id,
      'decision',v_decision,
      'decision_reason',v_reason,
      'matched_grant_id',COALESCE(v_deny_id,v_allow_id),
      'break_glass',v_break_glass,
      'context',v_context
    )::text),
    v_user_id,p_action_key,p_resource_type,p_resource_id,p_warehouse_id,
    v_decision,v_reason,COALESCE(v_deny_id,v_allow_id),v_break_glass,v_context
  )
  ON CONFLICT (transaction_id,decision_fingerprint) DO NOTHING;
$new$;
BEGIN
  SELECT pg_get_functiondef(
    'public.authorize_action(text,text,uuid,uuid,jsonb,boolean)'::regprocedure
  ) INTO d;

  IF position('ON CONFLICT (transaction_id,decision_fingerprint) DO NOTHING' IN d)=0 THEN
    IF position(old_block IN d)=0 THEN
      RAISE EXCEPTION 'authorize_action audit insert anchor not found; refusing partial rewrite';
    END IF;
    n := replace(d,old_block,new_block);
    IF n=d THEN
      RAISE EXCEPTION 'authorize_action audit insert rewrite produced no change';
    END IF;
    d := n;
  END IF;

  EXECUTE d;
END;
$rewrite$;

DO $verify$
DECLARE
  d text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public'
      AND indexname='authorization_decisions_tx_fingerprint_uidx'
  ) THEN
    RAISE EXCEPTION 'Transaction-scoped authorization audit index is missing';
  END IF;

  SELECT pg_get_functiondef(
    'public.authorize_action(text,text,uuid,uuid,jsonb,boolean)'::regprocedure
  ) INTO d;
  IF position('transaction_id,decision_fingerprint' IN d)=0
     OR position('txid_current()' IN d)=0
     OR position('ON CONFLICT (transaction_id,decision_fingerprint) DO NOTHING' IN d)=0
     OR position('IF p_log_decision OR v_break_glass THEN' IN d)=0 THEN
    RAISE EXCEPTION 'authorize_action transaction audit deduplication verification failed';
  END IF;
END;
$verify$;
