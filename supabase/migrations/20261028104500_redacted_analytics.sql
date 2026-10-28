create table public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  user_hash text not null check (user_hash ~ '^[0-9a-f]{64}$'),
  event_key text not null,
  event_name text not null,
  mode text not null,
  revision text,
  source text not null default 'direct',
  campaign text,
  duration_ms integer,
  error_code text,
  created_at timestamptz not null default now(),
  constraint analytics_events_name_chk check (
    event_name in (
      'first_view',
      'sample_view',
      'sign_in',
      'import_started',
      'import_succeeded',
      'import_failed',
      'report_completed',
      'explanation_succeeded',
      'explanation_failed',
      'next_review'
    )
  ),
  constraint analytics_events_mode_chk check (mode in ('sample', 'qa', 'personal')),
  constraint analytics_events_source_chk check (source in ('direct', 'referral', 'community', 'anna')),
  constraint analytics_events_campaign_chk check (campaign is null or campaign ~ '^[A-Za-z0-9_-]{1,40}$'),
  constraint analytics_events_duration_chk check (duration_ms is null or duration_ms between 0 and 600000),
  constraint analytics_events_uniq unique (user_id, event_key)
);

alter table public.analytics_events enable row level security;
create policy "analytics_events_own" on public.analytics_events
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create index analytics_events_name_created_idx
  on public.analytics_events (event_name, created_at);

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
