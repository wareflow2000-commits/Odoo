-- Keep unit resolution available to trusted database routines only.
-- The client has no direct resolver call; SECURITY DEFINER transaction and
-- stocktake routines invoke it as their postgres function owner.
REVOKE EXECUTE ON FUNCTION public.resolve_item_unit(uuid, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.resolve_item_unit(uuid, text)
  TO service_role;
