-- Allow an active authenticated user to read only the warehouse scope
-- configured for their own role. This table remains read-only to application
-- users; mutations are reserved for trusted administrative tooling.
GRANT SELECT ON TABLE public.role_warehouse_scopes TO authenticated;

DROP POLICY IF EXISTS role_warehouse_scopes_select_own_role
  ON public.role_warehouse_scopes;

CREATE POLICY role_warehouse_scopes_select_own_role
  ON public.role_warehouse_scopes
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.status = 'ACTIVE'
        AND p.role = role_warehouse_scopes.role_name
    )
  );
