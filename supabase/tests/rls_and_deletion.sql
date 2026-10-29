begin;

select plan(39);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('a0000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'anna-a@example.test', '', now(), now(), now()),
  ('b0000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'anna-b@example.test', '', now(), now(), now());

insert into public.financial_settings (user_id, currency)
values
  ('a0000000-0000-4000-8000-000000000001', 'USD'),
  ('b0000000-0000-4000-8000-000000000002', 'USD');

insert into public.import_jobs (id, user_id, file_fingerprint, status, affected_months, row_count)
values
  ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'test-a', 'complete', '{2024-01-01}', 1),
  ('b1000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'test-b', 'complete', '{2024-01-01}', 1);

insert into public.transactions (id, user_id, txn_date, amount_cents, currency, transaction_kind, category, source, content_hash, import_job_id)
values
  ('a2000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '2024-01-05', -100, 'USD', 'expense', 'dining', 'csv', 'test-a', 'a1000000-0000-4000-8000-000000000001'),
  ('b2000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', '2024-01-05', -200, 'USD', 'expense', 'dining', 'csv', 'test-b', 'b1000000-0000-4000-8000-000000000002');

insert into public.rollups (user_id, period_type, period_start, currency, category, total_spend_cents, net_spend_cents)
values
  ('a0000000-0000-4000-8000-000000000001', 'month', '2024-01-01', 'USD', '__all__', 100, 100),
  ('b0000000-0000-4000-8000-000000000002', 'month', '2024-01-01', 'USD', '__all__', 200, 200);

insert into public.subscriptions (user_id, merchant_norm, avg_amount_cents, last_seen, status)
values
  ('a0000000-0000-4000-8000-000000000001', 'STREAM-A', 100, '2024-01-05', 'dismissed'),
  ('b0000000-0000-4000-8000-000000000002', 'STREAM-B', 200, '2024-01-05', 'active');

insert into public.anomalies (user_id, transaction_id, type, score, reason)
values
  ('a0000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'new_merchant', 1, 'synthetic'),
  ('b0000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000002', 'new_merchant', 1, 'synthetic');

insert into public.budgets (user_id, category, limit_cents)
values
  ('a0000000-0000-4000-8000-000000000001', 'dining', 1000),
  ('b0000000-0000-4000-8000-000000000002', 'dining', 2000);

insert into public.user_memory (user_id, kind, type, params)
values
  ('a0000000-0000-4000-8000-000000000001', 'fact', 'income_day', '{"day":1}'),
  ('b0000000-0000-4000-8000-000000000002', 'fact', 'income_day', '{"day":2}');

insert into public.conversations (id, user_id, title)
values
  ('a3000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'A'),
  ('b3000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'B');

insert into public.messages (conversation_id, user_id, role, content)
values
  ('a3000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'user', 'synthetic A'),
  ('b3000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'user', 'synthetic B');

insert into public.receipts (user_id, storage_path, status)
values
  ('a0000000-0000-4000-8000-000000000001', 'test/a.png', 'pending'),
  ('b0000000-0000-4000-8000-000000000002', 'test/b.png', 'pending');

insert into public.ingest_errors (user_id, raw_row, reason)
values
  ('a0000000-0000-4000-8000-000000000001', '{"row":"a"}', 'synthetic'),
  ('b0000000-0000-4000-8000-000000000002', '{"row":"b"}', 'synthetic');

insert into public.analytics_events (user_id, user_hash, event_key, event_name, mode)
values
  ('a0000000-0000-4000-8000-000000000001', repeat('a', 64), 'test-a', 'report_completed', 'qa'),
  ('b0000000-0000-4000-8000-000000000002', repeat('b', 64), 'test-b', 'report_completed', 'qa');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select is((select count(*)::integer from public.transactions), 1, 'account A sees only its transactions');
select is((select count(*)::integer from public.analytics_events), 1, 'account A sees only its analytics');
select is(
  public.acquire_user_write_lock(
    'a0000000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000001',
    90
  ),
  true,
  'account A can acquire its durable write lock'
);
select is(
  (select generation from public.read_user_dataset_snapshot('a0000000-0000-4000-8000-000000000001')),
  1::bigint,
  'a newly acquired account lock creates the first dataset generation'
);
select is(
  (select write_in_progress from public.read_user_dataset_snapshot('a0000000-0000-4000-8000-000000000001')),
  true,
  'readers can detect an active dataset mutation'
);
select is(
  public.acquire_user_write_lock(
    'a0000000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000002',
    90
  ),
  false,
  'a second request cannot acquire the active account write lock'
);
select is(
  public.renew_user_write_lock(
    'a0000000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000001',
    90
  ),
  true,
  'the owner can renew its live write lease'
);
select is(
  public.release_user_write_lock(
    'a0000000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000002'
  ),
  false,
  'a request cannot release another request write lock'
);
select is(
  public.release_user_write_lock(
    'a0000000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000001'
  ),
  true,
  'the lock owner can release its write lock'
);
select is(
  (select write_in_progress from public.read_user_dataset_snapshot('a0000000-0000-4000-8000-000000000001')),
  false,
  'release marks the durable lock idle without deleting its generation'
);
select is(
  public.acquire_user_write_lock(
    'a0000000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000003',
    90
  ),
  true,
  'the next writer can acquire the expired lease'
);
select is(
  (select generation from public.read_user_dataset_snapshot('a0000000-0000-4000-8000-000000000001')),
  2::bigint,
  'each writer advances the durable dataset generation'
);
select public.release_user_write_lock(
  'a0000000-0000-4000-8000-000000000001',
  'a4000000-0000-4000-8000-000000000003'
);
select is(
  public.reserve_user_ai_request(
    'a0000000-0000-4000-8000-000000000001',
    'a5000000-0000-4000-8000-000000000001',
    1,
    3600,
    60
  ),
  'reserved',
  'account A can reserve one bounded AI request'
);
select is(
  public.reserve_user_ai_request(
    'a0000000-0000-4000-8000-000000000001',
    'a5000000-0000-4000-8000-000000000002',
    1,
    3600,
    60
  ),
  'busy',
  'a concurrent AI request is denied while the slot is active'
);
select is(
  public.release_user_ai_request(
    'a0000000-0000-4000-8000-000000000001',
    'a5000000-0000-4000-8000-000000000001'
  ),
  true,
  'the AI request owner can release its slot'
);
select is(
  public.reserve_user_ai_request(
    'a0000000-0000-4000-8000-000000000001',
    'a5000000-0000-4000-8000-000000000003',
    1,
    3600,
    60
  ),
  'limited',
  'hourly request quota is enforced after the slot is released'
);
select is(
  public.replace_monthly_rollups(
    'a0000000-0000-4000-8000-000000000001',
    '2024-01-01',
    '[
      {"category":"__all__","currency":"USD","total_spend_cents":100,"total_refund_cents":0,"net_spend_cents":100,"total_income_cents":0,"total_unknown_inflow_cents":0,"txn_count":1},
      {"category":"other","currency":"USD","total_spend_cents":100,"total_refund_cents":0,"net_spend_cents":100,"total_income_cents":0,"total_unknown_inflow_cents":0,"txn_count":1}
    ]'::jsonb
  ),
  2,
  'a corrected month is replaced as one complete category set'
);
select is(
  (select count(*)::integer from public.rollups where user_id = 'a0000000-0000-4000-8000-000000000001' and category = 'dining'),
  0,
  'the category removed by correction is deleted from the rollup'
);
select is(
  (select total_spend_cents from public.rollups where user_id = 'a0000000-0000-4000-8000-000000000001' and category = 'other'),
  100::bigint,
  'the replacement category carries the corrected amount'
);
select throws_ok(
  $$select public.replace_monthly_rollups(
    'a0000000-0000-4000-8000-000000000001',
    '2024-01-01',
    '[{"category":null,"currency":"USD","total_spend_cents":0,"total_refund_cents":0,"net_spend_cents":0,"total_income_cents":0,"total_unknown_inflow_cents":0,"txn_count":0}]'::jsonb
  )$$,
  '23502',
  null,
  'an invalid replacement fails as a database transaction'
);
select is(
  (select count(*)::integer from public.rollups where user_id = 'a0000000-0000-4000-8000-000000000001' and category = 'other'),
  1,
  'a failed replacement retains the previous complete month'
);
insert into public.subscriptions (user_id, merchant_norm, avg_amount_cents, last_seen, lifecycle_status)
values ('a0000000-0000-4000-8000-000000000001', 'STREAM-A', 150, '2024-02-05', 'active')
on conflict (user_id, merchant_norm) do update
set avg_amount_cents = excluded.avg_amount_cents,
    last_seen = excluded.last_seen,
    lifecycle_status = excluded.lifecycle_status;
select is((select status from public.subscriptions where merchant_norm = 'STREAM-A'), 'dismissed', 'subscription recomputation preserves the user review state');
reset role;
insert into public.user_ai_slots (user_id, slot_token, expires_at)
values ('a0000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001', now() + interval '1 minute');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select lives_ok('select public.delete_my_financial_data()', 'account A can delete its finance data');
select is((select count(*)::integer from public.transactions), 0, 'account A transactions are deleted');
select is((select count(*)::integer from public.import_jobs), 0, 'account A import history is deleted');
select is((select count(*)::integer from public.financial_settings), 0, 'account A settings are deleted');
select is((select count(*)::integer from public.rollups), 0, 'account A rollups are deleted');
select is((select count(*)::integer from public.subscriptions), 0, 'account A recurring reviews are deleted');
select is((select count(*)::integer from public.anomalies), 0, 'account A anomalies are deleted');
select is((select count(*)::integer from public.budgets), 0, 'account A budgets are deleted');
select is((select count(*)::integer from public.user_memory), 0, 'account A memories are deleted');
select is((select count(*)::integer from public.conversations), 0, 'account A conversations are deleted');
select is((select count(*)::integer from public.messages), 0, 'account A messages are deleted');
select is((select count(*)::integer from public.receipts), 0, 'account A receipt records are deleted');
select is((select count(*)::integer from public.ingest_errors), 0, 'account A import errors are deleted');
select is((select count(*)::integer from public.analytics_events), 0, 'account A analytics are deleted');
select is(
  public.reserve_user_ai_request(
    'a0000000-0000-4000-8000-000000000001',
    'a5000000-0000-4000-8000-000000000004',
    1,
    3600,
    60
  ),
  'reserved',
  'deletion removes the active AI slot and quota bucket'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'b0000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select is((select count(*)::integer from public.transactions), 1, 'account B data survives account A deletion');
select is((select count(*)::integer from public.analytics_events), 1, 'account B analytics survive account A deletion');
reset role;

select * from finish();
rollback;
