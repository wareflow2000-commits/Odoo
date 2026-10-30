-- This row writer is an internal implementation detail used by
-- dispatch_stock_transfer_order_v2(). Expose only the validated order-level RPC.
REVOKE ALL
ON FUNCTION public.dispatch_stock_transfer_order_line(
  uuid,text,uuid,numeric,text,date,uuid,uuid,text,uuid
)
FROM PUBLIC, anon, authenticated;
