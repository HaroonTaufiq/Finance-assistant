alter table public.user_write_locks
  add column updated_at timestamptz not null default now();

update public.user_write_locks
set updated_at = now();

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

  insert into public.user_write_locks (user_id, lock_token, expires_at, updated_at)
  values (p_user_id, p_lock_token, now() + make_interval(secs => p_lease_seconds), now())
  on conflict (user_id) do update
    set lock_token = excluded.lock_token,
        generation = public.user_write_locks.generation + 1,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
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
  rows_updated integer := 0;
begin
  if auth.uid() is distinct from p_user_id then
    raise exception 'cannot release another user write lock';
  end if;

  update public.user_write_locks
  set expires_at = now()
  where user_id = p_user_id and lock_token = p_lock_token;
  get diagnostics rows_updated = row_count;
  return rows_updated = 1;
end;
$$;

create or replace function public.renew_user_write_lock(
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
  rows_updated integer := 0;
begin
  if auth.uid() is distinct from p_user_id then
    raise exception 'cannot renew another user write lock';
  end if;
  if p_lease_seconds < 1 or p_lease_seconds > 90 then
    raise exception 'write lock lease must be between 1 and 90 seconds';
  end if;

  update public.user_write_locks
  set expires_at = now() + make_interval(secs => p_lease_seconds)
  where user_id = p_user_id
    and lock_token = p_lock_token
    and expires_at > now();
  get diagnostics rows_updated = row_count;
  return rows_updated = 1;
end;
$$;

create or replace function public.read_user_dataset_snapshot(p_user_id uuid)
returns table (generation bigint, write_in_progress boolean, updated_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is distinct from p_user_id then
    raise exception 'cannot read another user dataset snapshot';
  end if;

  return query
  select
    coalesce(lock_row.generation, 0)::bigint,
    coalesce(lock_row.expires_at > now(), false),
    lock_row.updated_at
  from (select 1) as singleton
  left join public.user_write_locks as lock_row on lock_row.user_id = p_user_id;
end;
$$;

revoke all on function public.renew_user_write_lock(uuid, uuid, integer) from public, anon;
revoke all on function public.read_user_dataset_snapshot(uuid) from public, anon;
grant execute on function public.renew_user_write_lock(uuid, uuid, integer) to authenticated;
grant execute on function public.read_user_dataset_snapshot(uuid) to authenticated;
