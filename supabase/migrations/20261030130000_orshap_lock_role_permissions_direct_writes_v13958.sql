-- Restrict role-permission writes to the audited SECURITY DEFINER RPC.
-- The application already saves the permission matrix through
-- admin_replace_role_permissions(), which independently requires an active
-- SUPER_ADMIN. Direct PostgREST DML is not part of the supported write path.

REVOKE INSERT, UPDATE, DELETE ON TABLE public.role_permissions
  FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS role_permissions_manager_insert ON public.role_permissions;
DROP POLICY IF EXISTS role_permissions_manager_update ON public.role_permissions;
DROP POLICY IF EXISTS role_permissions_manager_delete ON public.role_permissions;

-- Keep authenticated read access for the permission matrix and UI hydration.
GRANT SELECT ON TABLE public.role_permissions TO authenticated;
