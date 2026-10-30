-- ORSHAP WMS v13.9.58
-- Application JWT roles must not receive PostgreSQL maintenance privileges.
-- MAINTAIN is unrelated to business read/write permissions and is reserved
-- for database operators and trusted maintenance roles.

REVOKE MAINTAIN ON TABLE
  public.transactions,
  public.transaction_lines,
  public.inventory_ledger,
  public.transaction_ledger,
  public.transaction_audit
FROM PUBLIC, anon, authenticated;
