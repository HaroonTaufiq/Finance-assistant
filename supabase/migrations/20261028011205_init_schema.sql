-- ============================================================================
-- Personal Finance Assistant — Database Schema (Supabase / Postgres)
-- ============================================================================
-- Run this in the Supabase SQL editor (or via migration) on a fresh project.
-- Conventions:
--   * Money is stored as integer minor units (cents) -> bigint amount_cents.
--     Negative = spend, positive = income. Never use float for money.
--   * Every user-scoped table has user_id uuid and RLS = (user_id = auth.uid()).
--   * Request paths use the user's JWT-bound client so auth.uid() resolves.
--     The service-role key bypasses RLS — never expose it to the client.
-- ============================================================================

-- gen_random_uuid() is available by default on Supabase. (pgcrypto enabled.)
create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- profiles : app-level user data (auth.users itself is managed by Supabase)
-- ----------------------------------------------------------------------------
create table public.profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  display_name     text,
  default_currency text not null default 'USD',
  created_at       timestamptz not null default now()
);

-- Auto-create a profile row whenever a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- transactions : the raw rows. Heavy table; rarely read row-by-row on requests.
-- ----------------------------------------------------------------------------
create table public.transactions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  txn_date      date not null,
  amount_cents  bigint not null,                  -- negative = spend, positive = income
  currency      text not null default 'USD',
  merchant_raw  text,
  merchant_norm text,                             -- normalized for grouping/matching
  category      text not null default 'uncategorized',
  description   text,
  source        text not null,                    -- 'csv' | 'bank' | 'receipt' | 'manual'
  content_hash  text not null,                    -- dedup key (see ingest pipeline)
  metadata      jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  constraint transactions_source_chk check (source in ('csv','bank','receipt','manual')),
  constraint transactions_uniq unique (user_id, content_hash)  -- idempotent ingest
);
create index transactions_user_date_idx     on public.transactions (user_id, txn_date);
create index transactions_user_cat_date_idx on public.transactions (user_id, category, txn_date);
create index transactions_user_merchant_idx on public.transactions (user_id, merchant_norm);

-- ----------------------------------------------------------------------------
-- rollups : precomputed time-bucketed aggregates (the read path's workhorse).
--   Per (period, category) plus a '__all__' category row per period.
--   Size scales with TIME PERIODS, not row count -> survives 10x-100x data.
-- ----------------------------------------------------------------------------
create table public.rollups (
  user_id            uuid not null references auth.users(id) on delete cascade,
  period_type        text not null,               -- 'month' (ship); 'week'/'day' optional
  period_start       date not null,
  category           text not null,               -- '__all__' or a specific category
  total_spend_cents  bigint not null default 0,   -- spend as a positive number
  total_income_cents bigint not null default 0,
  txn_count          int not null default 0,
  primary key (user_id, period_type, period_start, category),
  constraint rollups_period_chk check (period_type in ('day','week','month'))
);

-- ----------------------------------------------------------------------------
-- subscriptions : detected recurring charges.
-- ----------------------------------------------------------------------------
create table public.subscriptions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  merchant_norm    text not null,
  cadence_days     int,                            -- ~7 weekly, ~30 monthly, ~365 annual
  avg_amount_cents bigint not null,
  last_seen        date not null,
  next_expected    date,
  confidence       real not null default 0,        -- 0..1
  status           text not null default 'active', -- 'active' | 'dismissed'
  constraint subscriptions_status_chk check (status in ('active','dismissed')),
  constraint subscriptions_uniq unique (user_id, merchant_norm)
);

-- ----------------------------------------------------------------------------
-- anomalies : precomputed out-of-pattern flags.
-- ----------------------------------------------------------------------------
create table public.anomalies (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  transaction_id uuid references public.transactions(id) on delete cascade,
  type           text not null,                    -- 'amount_spike'|'new_merchant'|'category_spike'
  score          real not null,
  reason         text not null,                    -- human-readable
  status         text not null default 'new',      -- 'new' | 'seen' | 'dismissed'
  created_at     timestamptz not null default now(),
  constraint anomalies_type_chk check (type in ('amount_spike','new_merchant','category_spike')),
  constraint anomalies_status_chk check (status in ('new','seen','dismissed'))
);
create index anomalies_user_status_idx on public.anomalies (user_id, status);

-- ----------------------------------------------------------------------------
-- budgets : per-category (or '__all__') monthly limits.
-- ----------------------------------------------------------------------------
create table public.budgets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  category    text not null,                        -- '__all__' for a total budget
  period_type text not null default 'month',
  limit_cents bigint not null,
  created_at  timestamptz not null default now(),
  constraint budgets_period_chk check (period_type in ('month')),
  constraint budgets_uniq unique (user_id, category, period_type)
);

-- ----------------------------------------------------------------------------
-- user_memory : deterministic rules + soft facts (the "remember context" feature).
--   kind='rule'  -> reconfigures the query layer, e.g. exclude rent from food budget
--   kind='fact'  -> structured/soft context, e.g. {"day":1} for "I get paid on the 1st"
-- ----------------------------------------------------------------------------
create table public.user_memory (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  kind       text not null,                         -- 'rule' | 'fact'
  type       text not null,                         -- 'exclude_category_from_budget'|'income_day'|'free_text'|...
  params     jsonb not null default '{}',
  text       text,                                  -- original phrasing (for fact/free_text)
  created_at timestamptz not null default now(),
  constraint user_memory_kind_chk check (kind in ('rule','fact'))
);
create index user_memory_user_kind_idx on public.user_memory (user_id, kind);

-- ----------------------------------------------------------------------------
-- conversations / messages : chat history.
-- ----------------------------------------------------------------------------
create table public.conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  title      text,
  created_at timestamptz not null default now()
);

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  role            text not null,                    -- 'user' | 'assistant' | 'tool'
  content         text,
  tool_calls      jsonb,
  created_at      timestamptz not null default now(),
  constraint messages_role_chk check (role in ('user','assistant','tool'))
);
create index messages_conv_idx on public.messages (conversation_id, created_at);

-- ----------------------------------------------------------------------------
-- receipts : uploaded receipt metadata + extraction.
-- ----------------------------------------------------------------------------
create table public.receipts (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  storage_path          text not null,              -- path within the 'receipts' bucket
  extracted             jsonb,                       -- validated OCR output
  confidence            real,                        -- overall 0..1
  linked_transaction_id uuid references public.transactions(id) on delete set null,
  status                text not null default 'pending', -- 'pending'|'confirmed'|'rejected'
  created_at            timestamptz not null default now(),
  constraint receipts_status_chk check (status in ('pending','confirmed','rejected'))
);
create index receipts_user_status_idx on public.receipts (user_id, status);

-- ----------------------------------------------------------------------------
-- ingest_errors : quarantine for rows that fail validation (never silently drop).
-- ----------------------------------------------------------------------------
create table public.ingest_errors (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  raw_row    jsonb not null,
  reason     text not null,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- Row-Level Security  — the entire multi-tenant isolation story.
-- Enable on every user-scoped table, then one policy per table.
-- ============================================================================
alter table public.profiles      enable row level security;
alter table public.transactions  enable row level security;
alter table public.rollups       enable row level security;
alter table public.subscriptions enable row level security;
alter table public.anomalies     enable row level security;
alter table public.budgets       enable row level security;
alter table public.user_memory   enable row level security;
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;
alter table public.receipts      enable row level security;
alter table public.ingest_errors enable row level security;

-- profiles keys on id (== auth user id); all others key on user_id.
create policy "profiles_own" on public.profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

create policy "transactions_own" on public.transactions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "rollups_own" on public.rollups
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "subscriptions_own" on public.subscriptions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "anomalies_own" on public.anomalies
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "budgets_own" on public.budgets
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "user_memory_own" on public.user_memory
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "conversations_own" on public.conversations
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "messages_own" on public.messages
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "receipts_own" on public.receipts
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "ingest_errors_own" on public.ingest_errors
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================================
-- Storage : private 'receipts' bucket, scoped so each user sees only their
-- own folder (path convention: {user_id}/{receipt_id}.{ext}).
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

create policy "receipts_storage_own"
  on storage.objects for all
  using (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ============================================================================
-- Seed : canonical category list (optional; categorizer may add more).
-- Stored as a simple reference table the app can read without RLS concerns.
-- ============================================================================
create table if not exists public.categories (
  name text primary key
);
insert into public.categories (name) values
  ('groceries'), ('dining'), ('transport'), ('utilities'), ('rent'),
  ('subscriptions'), ('shopping'), ('health'), ('entertainment'),
  ('travel'), ('income'), ('transfers'), ('fees'), ('uncategorized')
on conflict (name) do nothing;

alter table public.categories enable row level security;
create policy "categories_read_all" on public.categories
  for select using (true);

-- ============================================================================
-- Notes for the implementer
-- ============================================================================
-- * Rollup recompute (batch job): upsert with
--     insert into rollups (...) values (...) on conflict (user_id, period_type,
--     period_start, category) do update set ...
-- * getBudgetStatus must apply user_memory rules of type
--   'exclude_category_from_budget' before comparing spend to limit_cents.
-- * Verify the Supabase server-client + RLS-bound-JWT setup for Next.js App
--   Router against current @supabase/ssr docs; getting the cookie/JWT binding
--   wrong silently breaks tenant isolation even though the policies are correct.
