INSERT INTO public.permissions(key,description) VALUES
 ('action:chat:manage','Manage chat channels and moderate messages'),
 ('action:transaction:opening_balance:create','Create warehouse opening-balance vouchers'),
 ('table:inventory_ledger:view','Read inventory movement ledger rows in authorized warehouses'),
 ('table:transaction_ledger:view','Read transaction ledger rows in authorized warehouses')
ON CONFLICT(key) DO UPDATE SET description=EXCLUDED.description;

ALTER POLICY audit_logs_select_policy ON public.audit_logs
 USING (
  public.current_user_is_active()
  AND public.current_user_has_permission('table:audit_logs:view')
  AND (
   (warehouse_id IS NOT NULL AND public.current_user_can_access_warehouse(warehouse_id))
   OR (warehouse_id IS NULL AND entity='TRANSACTION' AND EXISTS (
     SELECT 1 FROM public.transactions t
     WHERE t.id::text=audit_logs.entity_id AND public.current_user_can_access_warehouse(t.warehouse_id)
   ))
   OR (warehouse_id IS NULL AND entity IS DISTINCT FROM 'TRANSACTION'
       AND COALESCE(details,'') !~* '"(warehouse_id|warehouseId|tx_id|transaction_id)"[[:space:]]*:')
  )
 );

ALTER POLICY transaction_audit_select_policy ON public.transaction_audit
 USING (
  public.current_user_is_active()
  AND public.current_user_has_permission('table:audit_logs:view')
  AND EXISTS (
   SELECT 1 FROM public.transactions t
   WHERE t.id=transaction_audit.transaction_id
     AND public.current_user_can_access_warehouse(t.warehouse_id)
  )
 );

ALTER POLICY inventory_ledger_select_policy ON public.inventory_ledger
 USING (
  public.current_user_is_active()
  AND public.current_user_has_permission('table:inventory_ledger:view')
  AND public.current_user_can_access_warehouse(warehouse_id)
 );

ALTER POLICY transaction_ledger_authenticated_read ON public.transaction_ledger
 USING (
  public.current_user_is_active()
  AND (
   public.current_user_has_permission('table:transaction_ledger:view')
   OR public.current_user_has_permission('table:audit_logs:view')
  )
  AND public.current_user_can_access_warehouse(warehouse_id)
 );

ALTER POLICY chat_channels_update ON public.chat_channels
 USING (
  public.current_user_is_active()
  AND (created_by=auth.uid() OR public.current_user_has_permission('action:chat:manage'))
 )
 WITH CHECK (
  public.current_user_is_active()
  AND (created_by=auth.uid() OR public.current_user_has_permission('action:chat:manage'))
 );

ALTER POLICY chat_messages_update ON public.chat_messages
 USING (
  public.current_user_is_active()
  AND (sender_id=auth.uid() OR public.current_user_has_permission('action:chat:manage'))
 )
 WITH CHECK (
  public.current_user_is_active()
  AND (sender_id=auth.uid() OR public.current_user_has_permission('action:chat:manage'))
 );

ALTER POLICY chat_messages_delete ON public.chat_messages
 USING (
  public.current_user_is_active()
  AND (sender_id=auth.uid() OR public.current_user_has_permission('action:chat:manage'))
 );

ALTER POLICY transactions_permission_insert ON public.transactions
 WITH CHECK (
  created_by=(SELECT auth.uid())
  AND status='PENDING_APPROVAL'
  AND CASE transaction_type
   WHEN 'GRN' THEN public.current_user_has_permission('action:transaction:grn:create')
   WHEN 'RETURN_FROM_USAGE' THEN public.current_user_has_permission('action:transaction:grn:create')
   WHEN 'RETURN_FROM_CUSTOMER' THEN public.current_user_has_permission('action:transaction:grn:create')
   WHEN 'ISSUE' THEN public.current_user_has_permission('action:transaction:issue:create')
   WHEN 'RETURN_TO_SUPPLIER' THEN public.current_user_has_permission('action:transaction:issue:create')
   WHEN 'ADJUSTMENT_IN' THEN public.current_user_has_permission('action:transaction:adjustment:create')
   WHEN 'ADJUSTMENT_OUT' THEN public.current_user_has_permission('action:transaction:adjustment:create')
   WHEN 'OPENING_BALANCE' THEN public.current_user_has_permission('action:transaction:opening_balance:create')
   ELSE false
  END
  AND public.current_user_can_access_warehouse(warehouse_id)
 );

DO $migration$
DECLARE d text; n text;
BEGIN
 SELECT pg_get_functiondef('public.create_opening_balance_vouchers(jsonb)'::regprocedure) INTO d;
 n:=replace(d,
  'public.authorize_action(''action:transaction:adjustment:create'',''transaction'',NULL,v_warehouse',
  'public.authorize_action(''action:transaction:opening_balance:create'',''transaction'',NULL,v_warehouse');
 IF n=d THEN RAISE EXCEPTION 'opening balance authorization key not found'; END IF;
 EXECUTE n;
END;
$migration$;
