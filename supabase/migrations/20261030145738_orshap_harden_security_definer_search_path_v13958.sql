-- ORSHAP WMS v13.9.58
-- Remove writable application schemas from SECURITY DEFINER name resolution.
-- These routines already schema-qualify application tables and auth helpers;
-- built-in functions/types remain available through implicit pg_catalog lookup.

ALTER FUNCTION public.admin_link_profile(text, text, text, text, uuid[])
  SET search_path = '';

ALTER FUNCTION public.export_wms_snapshot()
  SET search_path = '';

ALTER FUNCTION public.import_wms_snapshot(jsonb, text)
  SET search_path = '';
