alter table public.import_jobs
  add column coverage_start date,
  add column coverage_end date,
  add column coverage_confirmed boolean not null default false,
  add constraint import_jobs_coverage_chk
    check (
      (coverage_start is null and coverage_end is null) or
      (coverage_start is not null and coverage_end is not null and coverage_start <= coverage_end)
    );

alter table public.subscriptions
  drop constraint subscriptions_status_chk,
  add constraint subscriptions_status_chk
    check (status in ('active', 'dismissed', 'confirmed'));
