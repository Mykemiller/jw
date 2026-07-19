-- CC-LEGISCAN-INGEST-1.0 / FAR-347
-- Landing tables for LegiScan free-tier data-center legislative ingestion.
-- Feeds pfi_extract_trend_features.legislative_activity_delta (last unticketed
-- indicator gap: legiscan_not_ingested). State-level only (L3, L9). No JPAS writes.
--
-- Pattern: intl-refresh (verify_jwt=false edge fn, no app.* GUCs). Idempotency by
-- LegiScan change_hash (L6). Service-role written; RLS on with no public policy
-- (deny-by-default) — the SECURITY DEFINER pfi function reads as owner and the
-- edge function reads/writes as service role, both of which bypass RLS.

begin;

-- ---------------------------------------------------------------------------
-- ref_legiscan_bills — one row per LegiScan bill (data-center-related)
-- ---------------------------------------------------------------------------
create table if not exists public.ref_legiscan_bills (
  bill_id          bigint       primary key,                 -- LegiScan bill_id
  state_abbr       text         not null,
  jurisdiction_id  uuid         references public.jurisdictions(id),
  bill_number      text,
  title            text,
  description      text,
  status           text,                                     -- LegiScan status label
  status_date      date,
  last_action      text,
  last_action_date date,
  session_id       bigint,
  session_name     text,
  url              text,                                     -- LegiScan bill url
  state_url        text,                                     -- state_link (state's own url)
  change_hash      text,                                     -- LegiScan change_hash (idempotency key, L6)
  search_relevance integer,                                  -- getSearchRaw relevance
  first_seen_at    timestamptz  not null default now(),
  last_seen_at     timestamptz  not null default now(),
  last_run_id      bigint
);

comment on table public.ref_legiscan_bills is
  'CC-LEGISCAN-INGEST-1.0 (FAR-347): data-center-related state legislation from the LegiScan free public tier. change_hash-keyed idempotent landing table; feeds pfi legislative_activity_delta. State-level only.';

-- PFI delta query: count bills by jurisdiction whose last_action_date falls in
-- the 14d / prior-14d windows. This composite index serves that grouping.
create index if not exists ref_legiscan_bills_juris_action_idx
  on public.ref_legiscan_bills (jurisdiction_id, last_action_date);
create index if not exists ref_legiscan_bills_state_idx
  on public.ref_legiscan_bills (state_abbr);
create index if not exists ref_legiscan_bills_last_action_idx
  on public.ref_legiscan_bills (last_action_date);

-- ---------------------------------------------------------------------------
-- legiscan_run_log — per-run query accounting (L4 budget tracking)
-- ---------------------------------------------------------------------------
create table if not exists public.legiscan_run_log (
  run_id                bigint generated always as identity primary key,
  started_at            timestamptz not null default now(),
  finished_at           timestamptz,
  queries_used          integer     not null default 0,
  bills_seen            integer     not null default 0,
  bills_new             integer     not null default 0,
  bills_changed         integer     not null default 0,
  month_to_date_queries integer,                             -- MTD incl. this run (L4 ceiling 30k)
  status                text        not null default 'running',
  error                 text
);

comment on table public.legiscan_run_log is
  'CC-LEGISCAN-INGEST-1.0 (FAR-347): per-run LegiScan query accounting. Free tier ceiling 30,000/month; runs abort at a 25,000 MTD safety margin.';

create index if not exists legiscan_run_log_started_idx
  on public.legiscan_run_log (started_at desc);

-- ---------------------------------------------------------------------------
-- RLS — deny-by-default. No public policies: only service role (edge fn) and
-- table owner (SECURITY DEFINER pfi fn) touch these, both bypass RLS.
-- ---------------------------------------------------------------------------
alter table public.ref_legiscan_bills enable row level security;
alter table public.legiscan_run_log  enable row level security;

commit;
