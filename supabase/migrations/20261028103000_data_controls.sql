create or replace function public.delete_my_financial_data()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requester uuid := auth.uid();
begin
  if requester is null then
    raise exception 'authentication required';
  end if;

  delete from public.messages where user_id = requester;
  delete from public.conversations where user_id = requester;
  delete from public.receipts where user_id = requester;
  delete from public.anomalies where user_id = requester;
  delete from public.rollups where user_id = requester;
  delete from public.subscriptions where user_id = requester;
  delete from public.transactions where user_id = requester;
  delete from public.import_jobs where user_id = requester;
  delete from public.ingest_errors where user_id = requester;
  delete from public.budgets where user_id = requester;
  delete from public.user_memory where user_id = requester;
  delete from public.financial_settings where user_id = requester;
  delete from public.profiles where id = requester;
end;
$$;

revoke all on function public.delete_my_financial_data() from public;
grant execute on function public.delete_my_financial_data() to authenticated;
