create table public.user_ai_request_buckets (
  user_id uuid not null references auth.users(id) on delete cascade,
  bucket_start timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key (user_id, bucket_start)
);

create table public.user_ai_slots (
  user_id uuid primary key references auth.users(id) on delete cascade,
  slot_token uuid not null,
  expires_at timestamptz not null
);

alter table public.user_ai_request_buckets enable row level security;
alter table public.user_ai_slots enable row level security;
revoke all on public.user_ai_request_buckets, public.user_ai_slots from anon, authenticated;

create or replace function public.reserve_user_ai_request(
  p_user_id uuid,
  p_token uuid,
  p_max_requests integer,
  p_window_seconds integer,
  p_lease_seconds integer
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  acquired boolean := false;
  bucket timestamptz;
  counted integer;
begin
  if auth.uid() is distinct from p_user_id then
    raise exception 'cannot reserve another user AI request';
  end if;
  if p_max_requests < 1 or p_max_requests > 60
     or p_window_seconds < 60 or p_window_seconds > 86400
     or p_lease_seconds < 1 or p_lease_seconds > 60 then
    raise exception 'AI request limit configuration is outside its safe bounds';
  end if;

  insert into public.user_ai_slots (user_id, slot_token, expires_at)
  values (p_user_id, p_token, now() + make_interval(secs => p_lease_seconds))
  on conflict (user_id) do update
    set slot_token = excluded.slot_token,
        expires_at = excluded.expires_at
    where public.user_ai_slots.expires_at <= now()
       or public.user_ai_slots.slot_token = excluded.slot_token
  returning true into acquired;
  if not coalesce(acquired, false) then
    return 'busy';
  end if;

  bucket := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );
  insert into public.user_ai_request_buckets (user_id, bucket_start, request_count)
  values (p_user_id, bucket, 1)
  on conflict (user_id, bucket_start) do update
    set request_count = public.user_ai_request_buckets.request_count + 1
    where public.user_ai_request_buckets.request_count < p_max_requests
  returning request_count into counted;
  if counted is null then
    delete from public.user_ai_slots
    where user_id = p_user_id and slot_token = p_token;
    return 'limited';
  end if;
  return 'reserved';
end;
$$;

create or replace function public.release_user_ai_request(
  p_user_id uuid,
  p_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  rows_deleted integer := 0;
begin
  if auth.uid() is distinct from p_user_id then
    raise exception 'cannot release another user AI request';
  end if;
  delete from public.user_ai_slots
  where user_id = p_user_id and slot_token = p_token;
  get diagnostics rows_deleted = row_count;
  return rows_deleted = 1;
end;
$$;

revoke all on function public.reserve_user_ai_request(uuid, uuid, integer, integer, integer) from public, anon;
revoke all on function public.release_user_ai_request(uuid, uuid) from public, anon;
grant execute on function public.reserve_user_ai_request(uuid, uuid, integer, integer, integer) to authenticated;
grant execute on function public.release_user_ai_request(uuid, uuid) to authenticated;

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

  delete from public.analytics_events where user_id = requester;
  delete from public.user_ai_request_buckets where user_id = requester;
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
