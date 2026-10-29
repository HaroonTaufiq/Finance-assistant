-- Add revision-aware imports, explicit classifications, and single-currency
-- report settings without rewriting or deleting existing transaction data.

create table public.financial_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  currency text check (currency in ('USD', 'PKR', 'EUR', 'GBP')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.financial_settings enable row level security;
create policy "financial_settings_own" on public.financial_settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

insert into public.financial_settings (user_id, currency)
select
  user_id,
  case when count(distinct currency) = 1 then min(currency) else null end
from public.transactions
group by user_id
on conflict (user_id) do nothing;

create table public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  file_fingerprint text not null,
  status text not null default 'processing',
  affected_months date[] not null default '{}',
  row_count integer not null default 0,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint import_jobs_status_chk check (status in ('processing', 'failed', 'complete')),
  constraint import_jobs_fingerprint_uniq unique (user_id, file_fingerprint)
);

create index import_jobs_user_status_idx on public.import_jobs (user_id, status, updated_at);
alter table public.import_jobs enable row level security;
create policy "import_jobs_own" on public.import_jobs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.transactions
  add column transaction_kind text not null default 'unknown',
  add column transaction_kind_override text,
  add column category_override text,
  add column source_category text,
  add column classification_source text not null default 'legacy',
  add column source_account_id text,
  add column source_transaction_id text,
  add column import_fingerprint text,
  add column import_job_id uuid references public.import_jobs(id) on delete set null;

update public.transactions
set
  source_category = category,
  transaction_kind = case
    when category in ('transfers', 'transfer') then 'transfer'
    when amount_cents < 0 then 'expense'
    when category = 'income' then 'income'
    else 'unknown'
  end,
  classification_source = 'legacy';

alter table public.transactions
  add constraint transactions_kind_chk
    check (transaction_kind in ('expense', 'refund', 'income', 'transfer', 'unknown')),
  add constraint transactions_kind_override_chk
    check (transaction_kind_override is null or transaction_kind_override in ('expense', 'refund', 'income', 'transfer', 'unknown')),
  add constraint transactions_currency_chk
    check (currency in ('USD', 'PKR', 'EUR', 'GBP')) not valid;

create index transactions_user_import_job_idx on public.transactions (user_id, import_job_id);
create index transactions_source_identity_idx
  on public.transactions (user_id, source_account_id, currency, source_transaction_id)
  where source_transaction_id is not null;

alter table public.subscriptions
  add column lifecycle_status text not null default 'active',
  add column occurrence_count integer not null default 0,
  add column evidence jsonb not null default '[]'::jsonb,
  add column currency text,
  add column uncertainty text not null default 'legacy evidence unavailable',
  add column amount_change_cents bigint;

alter table public.subscriptions
  add constraint subscriptions_lifecycle_status_chk
    check (lifecycle_status in ('active', 'stale'));

update public.subscriptions
set lifecycle_status = 'stale'
where occurrence_count = 0;

create or replace function public.enforce_transaction_dataset_currency()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  configured_currency text;
begin
  select currency into configured_currency
  from public.financial_settings
  where user_id = new.user_id;

  if configured_currency is null then
    raise exception 'dataset currency must be confirmed before saving transactions';
  end if;
  if new.currency <> configured_currency then
    raise exception 'transaction currency does not match the confirmed dataset currency';
  end if;
  return new;
end;
$$;

create trigger transactions_dataset_currency
  before insert or update of currency on public.transactions
  for each row execute function public.enforce_transaction_dataset_currency();

alter table public.rollups
  add column total_refund_cents bigint not null default 0,
  add column net_spend_cents bigint not null default 0,
  add column total_unknown_inflow_cents bigint not null default 0,
  add column currency text;

update public.rollups
set
  net_spend_cents = total_spend_cents,
  currency = (
    select case when count(distinct t.currency) = 1 then min(t.currency) else null end
    from public.transactions t
    where t.user_id = rollups.user_id
      and t.txn_date >= rollups.period_start
      and t.txn_date < (rollups.period_start + interval '1 month')::date
  )
where period_type = 'month';
