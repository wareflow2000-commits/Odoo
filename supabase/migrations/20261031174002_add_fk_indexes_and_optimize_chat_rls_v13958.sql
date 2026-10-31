-- Performance-only hardening for foreign-key maintenance and chat RLS predicates.
-- No rows, grants, or authorization semantics are changed.

CREATE INDEX IF NOT EXISTS authorization_decisions_matched_grant_id_idx
  ON public.authorization_decisions (matched_grant_id);
CREATE INDEX IF NOT EXISTS authorization_grant_events_actor_user_id_idx
  ON public.authorization_grant_events (actor_user_id);
CREATE INDEX IF NOT EXISTS authorization_grant_events_grant_id_idx
  ON public.authorization_grant_events (grant_id);
CREATE INDEX IF NOT EXISTS authorization_grants_granted_by_idx
  ON public.authorization_grants (granted_by);
CREATE INDEX IF NOT EXISTS authorization_grants_permission_key_idx
  ON public.authorization_grants (permission_key);
CREATE INDEX IF NOT EXISTS authorization_grants_revoked_by_idx
  ON public.authorization_grants (revoked_by);
CREATE INDEX IF NOT EXISTS chat_channels_created_by_idx
  ON public.chat_channels (created_by);
CREATE INDEX IF NOT EXISTS chat_messages_sender_id_idx
  ON public.chat_messages (sender_id);
CREATE INDEX IF NOT EXISTS item_unit_conversions_unit_code_idx
  ON public.item_unit_conversions (unit_code);
CREATE INDEX IF NOT EXISTS items_base_unit_idx
  ON public.items (base_unit);
CREATE INDEX IF NOT EXISTS items_purchase_unit_idx
  ON public.items (purchase_unit);
CREATE INDEX IF NOT EXISTS role_warehouse_scopes_updated_by_idx
  ON public.role_warehouse_scopes (updated_by);
CREATE INDEX IF NOT EXISTS stocktake_count_sync_operations_line_id_idx
  ON public.stocktake_count_sync_operations (line_id);
CREATE INDEX IF NOT EXISTS stocktake_count_sync_operations_session_id_idx
  ON public.stocktake_count_sync_operations (session_id);
CREATE INDEX IF NOT EXISTS stocktake_count_sync_operations_warehouse_id_idx
  ON public.stocktake_count_sync_operations (warehouse_id);

-- Hoist invariant auth/helper calls out of per-row RLS evaluation. Predicates
-- are semantically identical; only scalar evaluation strategy is changed.
DROP POLICY IF EXISTS chat_channels_insert ON public.chat_channels;
CREATE POLICY chat_channels_insert ON public.chat_channels
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.current_user_is_active())
    AND created_by = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS chat_channels_update ON public.chat_channels;
CREATE POLICY chat_channels_update ON public.chat_channels
  FOR UPDATE TO authenticated
  USING (
    (SELECT public.current_user_is_active())
    AND (
      created_by = (SELECT auth.uid())
      OR (SELECT public.current_user_has_permission('action:chat:manage'))
    )
  )
  WITH CHECK (
    (SELECT public.current_user_is_active())
    AND (
      created_by = (SELECT auth.uid())
      OR (SELECT public.current_user_has_permission('action:chat:manage'))
    )
  );

DROP POLICY IF EXISTS chat_messages_insert ON public.chat_messages;
CREATE POLICY chat_messages_insert ON public.chat_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.current_user_is_active())
    AND sender_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.chat_channels c
      WHERE c.id = chat_messages.channel_id
        AND c.is_archived = false
    )
  );

DROP POLICY IF EXISTS chat_messages_update ON public.chat_messages;
CREATE POLICY chat_messages_update ON public.chat_messages
  FOR UPDATE TO authenticated
  USING (
    (SELECT public.current_user_is_active())
    AND (
      sender_id = (SELECT auth.uid())
      OR (SELECT public.current_user_has_permission('action:chat:manage'))
    )
  )
  WITH CHECK (
    (SELECT public.current_user_is_active())
    AND (
      sender_id = (SELECT auth.uid())
      OR (SELECT public.current_user_has_permission('action:chat:manage'))
    )
  );

DROP POLICY IF EXISTS chat_messages_delete ON public.chat_messages;
CREATE POLICY chat_messages_delete ON public.chat_messages
  FOR DELETE TO authenticated
  USING (
    (SELECT public.current_user_is_active())
    AND (
      sender_id = (SELECT auth.uid())
      OR (SELECT public.current_user_has_permission('action:chat:manage'))
    )
  );

DO $verify$
DECLARE
  v_index_count integer;
BEGIN
  SELECT count(*) INTO v_index_count
  FROM pg_class i
  JOIN pg_namespace n ON n.oid = i.relnamespace
  WHERE n.nspname = 'public'
    AND i.relkind = 'i'
    AND i.relname IN (
      'authorization_decisions_matched_grant_id_idx',
      'authorization_grant_events_actor_user_id_idx',
      'authorization_grant_events_grant_id_idx',
      'authorization_grants_granted_by_idx',
      'authorization_grants_permission_key_idx',
      'authorization_grants_revoked_by_idx',
      'chat_channels_created_by_idx',
      'chat_messages_sender_id_idx',
      'item_unit_conversions_unit_code_idx',
      'items_base_unit_idx',
      'items_purchase_unit_idx',
      'role_warehouse_scopes_updated_by_idx',
      'stocktake_count_sync_operations_line_id_idx',
      'stocktake_count_sync_operations_session_id_idx',
      'stocktake_count_sync_operations_warehouse_id_idx'
    );
  IF v_index_count <> 15 THEN
    RAISE EXCEPTION 'Expected 15 foreign-key indexes, found %', v_index_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='chat_messages'
      AND policyname='chat_messages_insert'
      AND with_check LIKE '%SELECT auth.uid()%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='chat_channels'
      AND policyname='chat_channels_update'
      AND qual LIKE '%SELECT auth.uid()%'
  ) THEN
    RAISE EXCEPTION 'Chat RLS initplan policy verification failed';
  END IF;
END;
$verify$;
