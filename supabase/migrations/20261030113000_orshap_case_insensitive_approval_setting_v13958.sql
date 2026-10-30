-- REQUIRE_APPROVAL is written by the settings UI as lowercase "true"/"false".
-- Normalize it at read time in both the posting workflow and the SoD guard.
CREATE OR REPLACE FUNCTION public.approve_transaction(p_transaction_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_actor_role text;
  v_actor_status text;
  v_actor_permissions text[];
  v_can_auto_approve boolean := false;
  v_require_approval boolean := true;
  v_tx_rec record;
  v_rec record;
  v_item record;
  v_old_qty numeric;
  v_new_qty numeric;
  v_is_inbound boolean;
  v_delta numeric;
  v_has_create_permission boolean := false;
  v_has_approve_permission boolean := false;
  v_has_auto_permission boolean := false;
  v_line_count integer := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required to approve transactions';
  END IF;

  SELECT p.role, p.status, COALESCE(p.custom_permissions, ARRAY[]::text[]),
         COALESCE(p.can_approve_without_workflow, false)
    INTO v_actor_role, v_actor_status, v_actor_permissions, v_can_auto_approve
  FROM public.profiles p
  WHERE p.id = v_user_id;

  IF NOT FOUND OR v_actor_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Active user profile required';
  END IF;

  SELECT upper(btrim(COALESCE(s.value, 'TRUE'))) <> 'FALSE'
    INTO v_require_approval
  FROM public.system_settings s
  WHERE s.key = 'REQUIRE_APPROVAL';
  v_require_approval := COALESCE(v_require_approval, true);

  SELECT t.id, t.transaction_type, t.warehouse_id, NULL::uuid AS zone_id, NULL::uuid AS section_id,
         t.created_by, t.reference_no, t.status
    INTO v_tx_rec
  FROM public.transactions t
  WHERE t.id = p_transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction % not found', p_transaction_id;
  END IF;

  IF NOT public.current_user_can_access_warehouse(v_tx_rec.warehouse_id) THEN
    RAISE EXCEPTION 'User is not assigned to the transaction warehouse' USING ERRCODE='42501';
  END IF;

  IF v_tx_rec.status = 'APPROVED' THEN
    RAISE EXCEPTION 'Transaction % has already been approved; duplicate posting blocked', p_transaction_id;
  END IF;
  IF v_tx_rec.status <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'Transaction must be PENDING_APPROVAL before posting; current status: %', v_tx_rec.status;
  END IF;

  -- Apply the same guard at posting time, so an already-created request cannot bypass it.
  IF v_tx_rec.transaction_type = 'OPENING_BALANCE'
     AND v_actor_role NOT IN ('SUPER_ADMIN', 'MANAGER') THEN
    RAISE EXCEPTION 'Only a manager or super administrator may approve an opening balance';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.role_permissions rp
    WHERE rp.role_name = v_actor_role
      AND rp.permission_key = CASE v_tx_rec.transaction_type
        WHEN 'GRN' THEN 'action:transaction:grn:create'
        WHEN 'ISSUE' THEN 'action:transaction:issue:create'
                                                                                                      WHEN 'RETURN_TO_SUPPLIER' THEN 'action:transaction:issue:create'
                                                                                                              WHEN 'RETURN_FROM_CUSTOMER' THEN 'action:transaction:grn:create'
        WHEN 'ADJUSTMENT_IN' THEN 'action:transaction:adjustment:create'
        WHEN 'ADJUSTMENT_OUT' THEN 'action:transaction:adjustment:create'
        WHEN 'OPENING_BALANCE' THEN 'action:transaction:adjustment:create'
        WHEN 'RETURN_FROM_USAGE' THEN 'action:transaction:grn:create'
        ELSE NULL
      END
  ) OR v_actor_permissions @> ARRAY[
      CASE v_tx_rec.transaction_type
        WHEN 'GRN' THEN 'action:transaction:grn:create'
        WHEN 'ISSUE' THEN 'action:transaction:issue:create'
                                                                                                      WHEN 'RETURN_TO_SUPPLIER' THEN 'action:transaction:issue:create'
                                                                                                              WHEN 'RETURN_FROM_CUSTOMER' THEN 'action:transaction:grn:create'
        WHEN 'ADJUSTMENT_IN' THEN 'action:transaction:adjustment:create'
        WHEN 'ADJUSTMENT_OUT' THEN 'action:transaction:adjustment:create'
        WHEN 'OPENING_BALANCE' THEN 'action:transaction:adjustment:create'
        WHEN 'RETURN_FROM_USAGE' THEN 'action:transaction:grn:create'
        ELSE 'action:transaction:never'
      END
  ]::text[]
  INTO v_has_create_permission;

  SELECT EXISTS (
    SELECT 1 FROM public.role_permissions rp
    WHERE rp.role_name = v_actor_role
      AND rp.permission_key = 'action:transaction:approve'
  ) OR v_actor_permissions @> ARRAY['action:transaction:approve']::text[]
  INTO v_has_approve_permission;

  SELECT EXISTS (
    SELECT 1 FROM public.role_permissions rp
    WHERE rp.role_name = v_actor_role
      AND rp.permission_key = 'action:transaction:auto_approve'
  ) OR v_actor_permissions @> ARRAY['action:transaction:auto_approve']::text[]
  INTO v_has_auto_permission;

  IF v_actor_role IN ('SUPER_ADMIN', 'MANAGER', 'ADMIN') THEN
    NULL; -- privileged manager path
  ELSIF NOT v_require_approval
        AND v_tx_rec.created_by = v_user_id
        AND v_has_create_permission THEN
    NULL; -- global direct-execution mode, limited to the creator's permitted transaction type
  ELSIF v_tx_rec.created_by = v_user_id
        AND v_can_auto_approve
        AND v_has_auto_permission
        AND v_has_create_permission THEN
    NULL; -- per-user direct-execution permission
  ELSIF v_has_approve_permission THEN
    NULL; -- explicit approver permission
  ELSE
    RAISE EXCEPTION 'You do not have permission to post this transaction';
  END IF;

  SELECT count(*) INTO v_line_count
  FROM public.transaction_lines
  WHERE transaction_id = p_transaction_id;
  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'Cannot approve a transaction without lines';
  END IF;

  v_is_inbound := v_tx_rec.transaction_type IN ('GRN', 'RETURN_FROM_USAGE', 'RETURN_FROM_CUSTOMER', 'ADJUSTMENT_IN', 'OPENING_BALANCE');
  IF v_tx_rec.transaction_type = 'ISSUE' THEN
    IF NULLIF(btrim(COALESCE((SELECT t.usage_party FROM public.transactions t WHERE t.id = p_transaction_id), '')), '') IS NULL THEN RAISE EXCEPTION 'Usage party is required for issues'; END IF;
    IF NULLIF(btrim((SELECT t.receiver_name FROM public.transactions t WHERE t.id = p_transaction_id)), '') IS NULL THEN RAISE EXCEPTION 'Physical receiver name is required for issues'; END IF;
  END IF;
  IF v_tx_rec.transaction_type = 'GRN' AND NULLIF(btrim((SELECT t.supplier FROM public.transactions t WHERE t.id = p_transaction_id)), '') IS NULL THEN RAISE EXCEPTION 'Supplier is required for goods receipts'; END IF;
  IF v_tx_rec.transaction_type IN ('ADJUSTMENT_IN', 'ADJUSTMENT_OUT') AND NULLIF(btrim((SELECT t.adjustment_reason FROM public.transactions t WHERE t.id = p_transaction_id)), '') IS NULL THEN RAISE EXCEPTION 'Adjustment reason is required'; END IF;

  FOR v_rec IN
    SELECT tl.*
    FROM public.transaction_lines tl
    WHERE tl.transaction_id = p_transaction_id
    ORDER BY tl.item_id, tl.shelf_id, COALESCE(tl.batch_no, ''), tl.id
    FOR UPDATE
  LOOP
    IF v_rec.shelf_id IS NULL THEN
      RAISE EXCEPTION 'Shelf ID missing for line item %', v_rec.item_id;
    END IF;
    IF v_rec.quantity IS NULL OR v_rec.quantity <= 0 THEN
      RAISE EXCEPTION 'Transaction line quantity must be greater than zero for item %', v_rec.item_id;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.items i WHERE i.id = v_rec.item_id
    ) THEN
      RAISE EXCEPTION 'Transaction line item % does not exist', v_rec.item_id;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.shelves sh
      WHERE sh.id = v_rec.shelf_id
        AND sh.warehouse_id = v_tx_rec.warehouse_id
    ) THEN
      RAISE EXCEPTION 'Transaction line shelf % does not belong to transaction warehouse %', v_rec.shelf_id, v_tx_rec.warehouse_id;
    END IF;
    IF v_rec.storage_area_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.shelves sh
      WHERE sh.id = v_rec.shelf_id
        AND sh.warehouse_id = v_tx_rec.warehouse_id
        AND sh.storage_area_id = v_rec.storage_area_id
    ) THEN
      RAISE EXCEPTION 'Transaction line storage area does not match its shelf';
    END IF;

    -- Lock the canonical stock key before reading it. FOR UPDATE alone cannot lock
    -- a missing row, so concurrent inbound approvals could otherwise log stale balances.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      v_rec.item_id::text || ':' || v_rec.shelf_id::text || ':' ||
      COALESCE(v_rec.batch_no, ''),
      0
    ));
    v_old_qty := 0;
    SELECT s.quantity INTO v_old_qty
    FROM public.stock s
    WHERE s.item_id = v_rec.item_id
      AND s.shelf_id = v_rec.shelf_id
      AND s.batch_no = COALESCE(v_rec.batch_no, '')
    FOR UPDATE;
    v_old_qty := COALESCE(v_old_qty, 0);

    IF v_is_inbound THEN
      INSERT INTO public.stock (item_id, shelf_id, storage_area_id, quantity, updated_at, created_at, batch_no, expiry_date)
      VALUES (v_rec.item_id, v_rec.shelf_id,
              COALESCE(v_rec.storage_area_id, (SELECT sh.storage_area_id FROM public.shelves sh WHERE sh.id=v_rec.shelf_id)),
              v_rec.quantity, NOW(), NOW(), COALESCE(v_rec.batch_no, ''), v_rec.expiry_date)
      ON CONFLICT (item_id, shelf_id, batch_no)
      DO UPDATE SET quantity = public.stock.quantity + EXCLUDED.quantity,
                    storage_area_id = COALESCE(EXCLUDED.storage_area_id, public.stock.storage_area_id),
                    expiry_date = COALESCE(EXCLUDED.expiry_date, public.stock.expiry_date),
                    updated_at = NOW();

      SELECT s.quantity INTO v_new_qty
      FROM public.stock s
      WHERE s.item_id = v_rec.item_id
        AND s.shelf_id = v_rec.shelf_id
        AND s.batch_no = COALESCE(v_rec.batch_no, '');
      v_delta := v_rec.quantity;
    ELSE
      v_new_qty := v_old_qty - v_rec.quantity;
      IF v_new_qty < 0 THEN
        RAISE EXCEPTION 'Insufficient stock for item % at shelf % and batch %',
          v_rec.item_id, v_rec.shelf_id, COALESCE(v_rec.batch_no, '');
      END IF;
      IF v_new_qty = 0 THEN
        UPDATE public.stock
        SET quantity = 0,
            storage_area_id = COALESCE(v_rec.storage_area_id, (SELECT sh.storage_area_id FROM public.shelves sh WHERE sh.id=v_rec.shelf_id), storage_area_id),
            updated_at = NOW()
        WHERE item_id = v_rec.item_id
          AND shelf_id = v_rec.shelf_id
          AND batch_no = COALESCE(v_rec.batch_no, '');
      ELSE
        UPDATE public.stock
        SET quantity = v_new_qty,
            storage_area_id = COALESCE(v_rec.storage_area_id, (SELECT sh.storage_area_id FROM public.shelves sh WHERE sh.id=v_rec.shelf_id), storage_area_id),
            updated_at = NOW()
        WHERE item_id = v_rec.item_id
          AND shelf_id = v_rec.shelf_id
          AND batch_no = COALESCE(v_rec.batch_no, '');
      END IF;
      v_delta := -v_rec.quantity;
    END IF;

    UPDATE public.transaction_lines
    SET balance_before = v_old_qty, balance_after = v_new_qty
    WHERE id = v_rec.id;

    PERFORM public.log_transaction_ledger(
      p_transaction_id := p_transaction_id,
      p_ledger_type := 'TRANSACTION',
      p_user_id := v_tx_rec.created_by,
      p_warehouse_id := v_tx_rec.warehouse_id,
      p_zone_id := NULL::uuid,
      p_section_id := NULL::uuid,
      p_shelf_id := v_rec.shelf_id,
      p_item_id := v_rec.item_id,
      p_quantity := v_delta,
      p_balance_before := v_old_qty,
      p_balance_after := v_new_qty,
      p_transaction_type := v_tx_rec.transaction_type,
      p_details := jsonb_build_object('tx_line_id', v_rec.id, 'notes', v_rec.notes, 'storage_area_id', COALESCE(v_rec.storage_area_id, (SELECT sh.storage_area_id FROM public.shelves sh WHERE sh.id = v_rec.shelf_id))),
      p_reference := v_tx_rec.reference_no,
      p_reference_type := 'APPROVAL',
      p_batch_no := COALESCE(v_rec.batch_no, ''),
      p_expiry_date := v_rec.expiry_date
    );

    SELECT i.code, i.name_en INTO v_item
    FROM public.items i WHERE i.id = v_rec.item_id;

    INSERT INTO public.audit_logs (
      user_id, action, entity, entity_id, item_id, item_code, item_name,
      warehouse_id, quantity_before, quantity_after,
      reference, details
    ) VALUES (
      v_tx_rec.created_by, 'STOCK_UPDATE', 'ITEM', v_rec.item_id::text,
      v_rec.item_id, v_item.code, v_item.name_en,
      v_tx_rec.warehouse_id,
      v_old_qty, v_new_qty, v_tx_rec.reference_no,
      jsonb_build_object('tx_id', p_transaction_id, 'type', v_tx_rec.transaction_type,
        'qty', v_rec.quantity, 'delta', v_delta, 'before', v_old_qty, 'after', v_new_qty,
        'shelf_id', v_rec.shelf_id, 'batch_no', v_rec.batch_no)
    );
  END LOOP;

  UPDATE public.transactions
  SET status = 'APPROVED'
  WHERE id = p_transaction_id AND status = 'PENDING_APPROVAL';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction state changed before posting; no approval applied';
  END IF;

  INSERT INTO public.audit_logs (
    user_id, action, entity, entity_id, warehouse_id, reference, details
  ) VALUES (
    v_user_id, 'APPROVE_TRANSACTION', 'TRANSACTION', p_transaction_id::text,
    v_tx_rec.warehouse_id, v_tx_rec.reference_no,
    jsonb_build_object('message', 'Transaction approved and stock updated',
      'warehouse_id', v_tx_rec.warehouse_id, 'reference', v_tx_rec.reference_no,
      'approval_mode', CASE
        WHEN v_actor_role IN ('SUPER_ADMIN', 'MANAGER', 'ADMIN') THEN 'manager'
        WHEN NOT v_require_approval THEN 'global_direct'
        WHEN v_tx_rec.created_by = v_user_id THEN 'user_direct'
        ELSE 'approval'
      END)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_transaction_status_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_require_approval boolean := true;
  v_can_auto_approve boolean := false;
  v_has_auto_approve_permission boolean := false;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'APPROVED'
     AND OLD.status = 'PENDING_APPROVAL'
     AND v_user_id IS NOT NULL
     AND NEW.created_by = v_user_id THEN
    SELECT
      COALESCE(p.can_approve_without_workflow, false),
      (
        EXISTS (
          SELECT 1 FROM public.role_permissions rp
          WHERE rp.role_name = p.role
            AND rp.permission_key = 'action:transaction:auto_approve'
        )
        OR COALESCE(p.custom_permissions, ARRAY[]::text[])
             @> ARRAY['action:transaction:auto_approve']::text[]
      )
    INTO v_can_auto_approve, v_has_auto_approve_permission
    FROM public.profiles p
    WHERE p.id = v_user_id AND p.status = 'ACTIVE';

    SELECT COALESCE(
      (SELECT upper(btrim(s.value)) <> 'FALSE'
       FROM public.system_settings s
       WHERE s.key = 'REQUIRE_APPROVAL'),
      true
    ) INTO v_require_approval;

    IF v_require_approval
       AND NOT (v_can_auto_approve AND v_has_auto_approve_permission) THEN
      RAISE EXCEPTION 'Transaction creator cannot approve their own transaction without explicit auto-approval authorization'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF current_setting('request.jwt.claim.role', true) = 'service_role'
     OR current_user IN ('postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'PENDING_APPROVAL'
     AND NEW.status = 'REJECTED'
     AND (SELECT public.current_user_has_permission('action:transaction:reject')) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Transaction status can only be changed through an authorized posting or rejection workflow';
END;
$function$;
