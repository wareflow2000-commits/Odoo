-- A rejected transfer receipt returns stock to its source warehouse.
-- It is a transfer-return movement, not an inventory adjustment.
DO $migration$
DECLARE
  d text;
  n text;
  old_header text := 'VALUES(v_tx,v_transfer.reference_no||''-REJECT-RETURN'',''ADJUSTMENT_IN'',''APPROVED''';
  new_header text := 'VALUES(v_tx,v_transfer.reference_no||''-REJECT-RETURN'',''TRANSFER_RETURN'',''APPROVED''';
  old_ledger text := 'p_transaction_type:=''ADJUSTMENT_IN''';
  new_ledger text := 'p_transaction_type:=''TRANSFER_RETURN''';
  profile_decl text := ' v_user uuid:=auth.uid(); v_profile public.profiles%ROWTYPE; v_transfer public.stock_transfers%ROWTYPE;';
  profile_read text := ' SELECT * INTO v_profile FROM public.profiles WHERE id=v_user AND status=''ACTIVE'';' || E'\n';
BEGIN
  SELECT pg_get_functiondef('public.reject_stock_transfer_receipt(uuid,text)'::regprocedure) INTO d;

  IF position(new_header IN d)=0 THEN
    IF position(old_header IN d)=0 THEN RAISE EXCEPTION 'Rejected transfer transaction header classification not found'; END IF;
    n := replace(d,old_header,new_header);
    IF n=d THEN RAISE EXCEPTION 'Could not classify rejected transfer header as TRANSFER_RETURN'; END IF;
    d := n;
  END IF;

  IF position(new_ledger IN d)=0 THEN
    IF position(old_ledger IN d)=0 THEN RAISE EXCEPTION 'Rejected transfer ledger classification not found'; END IF;
    n := replace(d,old_ledger,new_ledger);
    IF n=d THEN RAISE EXCEPTION 'Could not classify rejected transfer ledger as TRANSFER_RETURN'; END IF;
    d := n;
  END IF;

  IF position(profile_decl IN d)>0 THEN
    d := replace(d,profile_decl,
      ' v_user uuid:=auth.uid(); v_transfer public.stock_transfers%ROWTYPE;');
  END IF;
  IF position(profile_read IN d)>0 THEN
    d := replace(d,profile_read,'');
  END IF;

  EXECUTE d;
END;
$migration$;

DO $verify$
DECLARE
  d text;
BEGIN
  SELECT pg_get_functiondef('public.reject_stock_transfer_receipt(uuid,text)'::regprocedure) INTO d;
  IF position('''-REJECT-RETURN'',''ADJUSTMENT_IN''' IN d)>0
     OR position('p_transaction_type:=''ADJUSTMENT_IN''' IN d)>0
     OR position('''-REJECT-RETURN'',''TRANSFER_RETURN''' IN d)=0
     OR position('p_transaction_type:=''TRANSFER_RETURN''' IN d)=0
     OR position('v_profile' IN d)>0 THEN
    RAISE EXCEPTION 'Rejected transfer return accounting classification verification failed';
  END IF;
END;
$verify$;
