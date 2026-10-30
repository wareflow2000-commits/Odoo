REVOKE ALL ON FUNCTION public.save_stocktake_count(uuid,numeric) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.admin_create_authorization_grant(text,text,uuid,text,text,text,uuid,text,jsonb,timestamptz,timestamptz,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.current_user_accessible_warehouse_ids() FROM PUBLIC,anon,authenticated;
