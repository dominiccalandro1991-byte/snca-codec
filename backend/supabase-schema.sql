-- Nano Cloud Codec — Supabase schema (run in SQL Editor)
-- Service-role backend writes; anon client may read if RLS permits.

create table if not exists public.codec_sessions (
  id            bigserial primary key,
  k             integer not null,
  m             integer not null,
  payload_bytes integer,
  latency_ms    double precision,
  meta          jsonb,
  created_at    timestamptz not null default now()
);

create table if not exists public.codec_metrics (
  id               bigserial primary key,
  k                integer,
  m                integer,
  payload_bytes    integer,
  latency_ms       double precision,
  throughput_mbps  double precision,
  source           text default 'codec-ui',
  created_at       timestamptz not null default now()
);

create index if not exists codec_sessions_created_at_idx on public.codec_sessions (created_at desc);
create index if not exists codec_metrics_created_at_idx  on public.codec_metrics  (created_at desc);

-- RLS: enable, deny anon writes; service role bypasses RLS
alter table public.codec_sessions enable row level security;
alter table public.codec_metrics  enable row level security;

-- Optional: allow anon SELECT for dashboards
drop policy if exists "anon_read_sessions" on public.codec_sessions;
create policy "anon_read_sessions" on public.codec_sessions
  for select to anon using (true);

drop policy if exists "anon_read_metrics" on public.codec_metrics;
create policy "anon_read_metrics" on public.codec_metrics
  for select to anon using (true);

-- No insert/update/delete policies for anon → only service role can write
