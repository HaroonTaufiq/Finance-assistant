alter table public.import_jobs
  add column review_decisions jsonb not null default '{}'::jsonb;
