create table public.user_write_locks (
  user_id uuid primary key references auth.users(id) on delete cascade,
  lock_token uuid not null,
  generation bigint not null default 1,
  expires_at timestamptz not null
);

alter table public.user_write_locks enable row level security;
revoke all on public.user_write_locks from anon, authenticated;

create or replace function public.acquire_user_write_lock(
  p_user_id uuid,
  p_lock_token uuid,
  p_lease_seconds integer default 90
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  acquired boolean := false;
begin
  if auth.uid() is distinct from p_user_id then
    raise exception 'cannot acquire another user write lock';
  end if;
  if p_lease_seconds < 1 or p_lease_seconds > 90 then
    raise exception 'write lock lease must be between 1 and 90 seconds';
  end if;

  insert into public.user_write_locks (user_id, lock_token, expires_at)
  values (p_user_id, p_lock_token, now() + make_interval(secs => p_lease_seconds))
  on conflict (user_id) do update
    set lock_token = excluded.lock_token,
        generation = public.user_write_locks.generation + 1,
        expires_at = excluded.expires_at
    where public.user_write_locks.expires_at <= now()
       or public.user_write_locks.lock_token = excluded.lock_token
  returning true into acquired;

  return coalesce(acquired, false);
end;
$$;

create or replace function public.release_user_write_lock(
  p_user_id uuid,
  p_lock_token uuid
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
    raise exception 'cannot release another user write lock';
  end if;
  delete from public.user_write_locks
  where user_id = p_user_id and lock_token = p_lock_token;
  get diagnostics rows_deleted = row_count;
  return rows_deleted = 1;
end;
$$;

revoke all on function public.acquire_user_write_lock(uuid, uuid, integer) from public, anon;
revoke all on function public.release_user_write_lock(uuid, uuid) from public, anon;
grant execute on function public.acquire_user_write_lock(uuid, uuid, integer) to authenticated;
grant execute on function public.release_user_write_lock(uuid, uuid) to authenticated;

create or replace function public.replace_monthly_rollups(
  p_user_id uuid,
  p_period_start date,
  p_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  written integer := 0;
begin
  if auth.uid() is distinct from p_user_id then
    raise exception 'cannot replace another user rollup';
  end if;
  if p_period_start <> date_trunc('month', p_period_start)::date then
    raise exception 'rollup period must be the first day of a month';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'rollup replacement must be a JSON array';
  end if;

  delete from public.rollups
  where user_id = p_user_id
    and period_type = 'month'
    and period_start = p_period_start;

  insert into public.rollups (
    user_id,
    period_type,
    period_start,
    category,
    currency,
    total_spend_cents,
    total_refund_cents,
    net_spend_cents,
    total_income_cents,
    total_unknown_inflow_cents,
    txn_count
  )
  select
    p_user_id,
    'month',
    p_period_start,
    row_data.category,
    row_data.currency,
    row_data.total_spend_cents,
    row_data.total_refund_cents,
    row_data.net_spend_cents,
    row_data.total_income_cents,
    row_data.total_unknown_inflow_cents,
    row_data.txn_count
  from jsonb_to_recordset(p_rows) as row_data(
    category text,
    currency text,
    total_spend_cents bigint,
    total_refund_cents bigint,
    net_spend_cents bigint,
    total_income_cents bigint,
    total_unknown_inflow_cents bigint,
    txn_count integer
  );

  get diagnostics written = row_count;
  return written;
end;
$$;

revoke all on function public.replace_monthly_rollups(uuid, date, jsonb) from public, anon;
grant execute on function public.replace_monthly_rollups(uuid, date, jsonb) to authenticated;
