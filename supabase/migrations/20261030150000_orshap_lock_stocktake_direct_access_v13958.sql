-- Stocktake tables are a controlled workflow, not client-managed CRUD.
-- Read access is authenticated + permission + warehouse scope. Mutations are
-- performed only through guarded SECURITY DEFINER RPCs.
REVOKE INSERT, UPDATE, DELETE ON TABLE
  public.stocktake_sessions,
  public.stocktake_lines,
  public.stocktake_logs
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE
  public.stocktake_sessions,
  public.stocktake_lines,
  public.stocktake_logs
TO authenticated;

DROP POLICY IF EXISTS stocktake_sessions_permission_select ON public.stocktake_sessions;
CREATE POLICY stocktake_sessions_permission_select
ON public.stocktake_sessions
FOR SELECT
TO authenticated
USING (
  (
    public.current_user_has_permission('page:stocktake:access')
    OR public.current_user_has_permission('table:stocktake:view')
  )
  AND public.current_user_can_access_warehouse(warehouse_id)
);

DROP POLICY IF EXISTS stocktake_lines_permission_select ON public.stocktake_lines;
CREATE POLICY stocktake_lines_permission_select
ON public.stocktake_lines
FOR SELECT
TO authenticated
USING (
  (
    public.current_user_has_permission('page:stocktake:access')
    OR public.current_user_has_permission('table:stocktake:view')
  )
  AND EXISTS (
    SELECT 1
    FROM public.stocktake_sessions s
    WHERE s.id = stocktake_lines.session_id
      AND public.current_user_can_access_warehouse(s.warehouse_id)
  )
);

DROP POLICY IF EXISTS stocktake_logs_permission_select ON public.stocktake_logs;
CREATE POLICY stocktake_logs_permission_select
ON public.stocktake_logs
FOR SELECT
TO authenticated
USING (
  (
    public.current_user_has_permission('page:stocktake:access')
    OR public.current_user_has_permission('table:stocktake:view')
  )
  AND EXISTS (
    SELECT 1
    FROM public.stocktake_sessions s
    WHERE s.id = stocktake_logs.session_id
      AND public.current_user_can_access_warehouse(s.warehouse_id)
  )
);
