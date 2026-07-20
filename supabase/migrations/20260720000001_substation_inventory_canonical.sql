-- CC-BUILD-SUBSTATION-INVENTORY-1.0 / FAR-372
-- Canonical, jurisdiction-cross-referenced substation inventory.
--
-- Reference-layer build only. Zero writes to jpas_attributes, jurisdictions
-- score/dim columns, JPS, or JDS. HIFLD Electric Substations is the canonical
-- spine (D3); FERC-text-parsed and PUC-derived mentions are matched *against*
-- HIFLD anchors, never resolved bottom-up from noisy text.
--
-- Three-table split (entity resolution needs an audit trail separate from the
-- resolved canonical record):
--   (a) substations                    — canonical resolved entity dimension
--   (b) substation_source_mentions     — raw evidence / entity-resolution audit
--   (c) substation_jurisdiction_xref   — many-to-many jurisdiction crosswalk (D4)
--
-- Conventions: content-hash idempotent upsert; RLS enabled service-role-only
-- from creation (mirrors ref_ferc_queue / puc_signals / puc_filings — no table
-- ships in the disabled-RLS state ref_ferc_queue originally shipped in);
-- first/last_seen provenance (mirrors ref_utility_territory_geoms). This
-- migration is re-runnable (create ... if not exists; drop policy if exists).
--
-- Drone-sourced columns / source_type values are schema-ready but populated
-- with ZERO real rows — Rocket Plan 2.0's drone program is not live.
-- No historical/lifecycle columns (commissioned_year / retired_year, etc.):
-- deferred entirely to FAR-373's review.

begin;

-- ---------------------------------------------------------------------------
-- (a) substations — canonical resolved entity, HIFLD-anchored
-- ---------------------------------------------------------------------------
create table if not exists public.substations (
  id                    uuid primary key default gen_random_uuid(),
  canonical_name        text        not null,
  normalized_name       text        not null,      -- lowercased/stripped, for D2 match
  voltage_class_kv      numeric,
  lat                   numeric,
  lon                   numeric,
  geom                  geometry(Point, 4326),
  state_abbr            character(2),
  county_fips           character(5),
  operator_name         text,
  operator_source       text,                       -- e.g. 'eia_utility_territories'
  total_capacity_mva    numeric,                     -- nullable, enrichment target
  spare_capacity_mw     numeric,                     -- nullable, enrichment target
  confidence_tier       text        not null,        -- VRF/SRC/INF/EST/ABS per D5
  resolution_method     text        not null,        -- hifld_seed | ferc_text_parse | manual_review | drone_survey
  anchor_source         text        default 'hifld',
  mention_count         integer     default 0,
  is_active             boolean     default true,
  content_hash          text        not null,
  first_seen_at         timestamptz not null default now(),
  last_seen_at          timestamptz not null default now()
);

comment on table public.substations is
  'CC-BUILD-SUBSTATION-INVENTORY-1.0 (FAR-372): canonical substation entity dimension, HIFLD-anchored spine (D3). Enriched over time by FERC-text-parse, PUC, and (future) drone survey. Pure reference layer — no JPAS/JPS/JDS writes. content_hash-keyed idempotent upsert.';
comment on column public.substations.confidence_tier is
  'D5 evidentiary tier: hifld_seed=SRC(0.85), ferc_text_parse no-coords=EST(0.30), drone_survey GPS=VRF(1.00), puc_docket=SRC(0.85). Entity-mention confidence, NOT a JPAS attribute confidence multiplier.';
comment on column public.substations.resolution_method is
  'How this canonical row was established: hifld_seed | ferc_text_parse | manual_review | drone_survey.';

-- content-hash is the idempotency key for the upsert (ON CONFLICT target)
create unique index if not exists substations_content_hash_key
  on public.substations (content_hash);
-- D2 auto-merge lookup: exact normalized name + voltage + county
create index if not exists substations_resolve_match_idx
  on public.substations (normalized_name, voltage_class_kv, county_fips);
create index if not exists substations_county_fips_idx
  on public.substations (county_fips);
create index if not exists substations_state_abbr_idx
  on public.substations (state_abbr);
-- spatial join target for D4 centroid_distance_km cross-ref
create index if not exists substations_geom_gix
  on public.substations using gist (geom);

-- ---------------------------------------------------------------------------
-- (b) substation_source_mentions — raw evidence / entity-resolution audit trail
-- ---------------------------------------------------------------------------
create table if not exists public.substation_source_mentions (
  id                    uuid primary key default gen_random_uuid(),
  substation_id         uuid references public.substations(id),  -- NULL until resolved (D2)
  source_type           text        not null,        -- ferc_queue | puc_filing | drone_mission | hifld
  source_table          text        not null,
  source_record_id      text        not null,
  raw_mention_text      text,
  extracted_voltage_kv  numeric,
  extracted_name_frag   text,
  county_fips_hint      character(5),
  state_abbr_hint       character(2),
  resolution_status     text        not null default 'unresolved',  -- D2: unresolved | auto_matched | human_reviewed | rejected
  content_hash          text        not null,
  captured_at           timestamptz not null default now()
);

comment on table public.substation_source_mentions is
  'CC-BUILD-SUBSTATION-INVENTORY-1.0 (FAR-372): raw evidence + entity-resolution audit trail. Every FERC/PUC/drone/HIFLD mention lands here, resolved or not. substation_id NULL until resolved. Per D2, only exact normalized-name + voltage_kv + county auto-merges; all else stays resolution_status=unresolved for human review — never silently auto-merged on partial/fuzzy signal.';
comment on column public.substation_source_mentions.source_type is
  'D7: puc_filing is an ACCEPTED value (schema-ready) but NLP extraction against puc_filings.raw_text is future scope — not built here. drone_mission is schema-ready with zero real rows.';

create unique index if not exists substation_source_mentions_content_hash_key
  on public.substation_source_mentions (content_hash);
create index if not exists substation_source_mentions_substation_idx
  on public.substation_source_mentions (substation_id);
create index if not exists substation_source_mentions_source_idx
  on public.substation_source_mentions (source_type, source_table, source_record_id);
-- human-review queue: WHERE resolution_status = 'unresolved'
create index if not exists substation_source_mentions_status_idx
  on public.substation_source_mentions (resolution_status);
create index if not exists substation_source_mentions_county_hint_idx
  on public.substation_source_mentions (county_fips_hint);

-- ---------------------------------------------------------------------------
-- (c) substation_jurisdiction_xref — many-to-many crosswalk (D4)
--     Mirrors grid_boundary_jurisdictions. A substation can be proximate to /
--     serve more than one jurisdiction. No single primary_jurisdiction_id on
--     substations itself. Idempotency is the composite PK (no content_hash col).
-- ---------------------------------------------------------------------------
create table if not exists public.substation_jurisdiction_xref (
  substation_id         uuid        not null references public.substations(id),
  jurisdiction_id       uuid        not null references public.jurisdictions(id),
  jurisdiction_level    text,
  join_method           text        not null,        -- county_fips_containment | centroid_distance_km
  distance_km           numeric,
  is_primary            boolean     default false,
  computed_at           timestamptz not null default now(),
  primary key (substation_id, jurisdiction_id)
);

comment on table public.substation_jurisdiction_xref is
  'CC-BUILD-SUBSTATION-INVENTORY-1.0 (FAR-372): many-to-many substation<->jurisdiction crosswalk (D4), mirroring grid_boundary_jurisdictions. Idempotent via composite PK. NOTE (I3): county_fips_containment join is well-supported (containing_county_fips ~90% populated overall, ~100% at place/cousub); centroid_distance_km is only viable against county-level rows — census_centroid is populated ONLY for county jurisdictions (sub-county centroids are null; FAR-361/366-adjacent gap, documented not fixed here).';
comment on column public.substation_jurisdiction_xref.join_method is
  'county_fips_containment (substation.county_fips -> jurisdictions.fips_code / containing_county_fips) | centroid_distance_km (county centroids only, per I3).';

create index if not exists substation_jurisdiction_xref_jurisdiction_idx
  on public.substation_jurisdiction_xref (jurisdiction_id);

-- ---------------------------------------------------------------------------
-- RLS — enabled service-role-only from creation, per D6/Locked (no exceptions).
-- Explicit service-role policy mirrors ref_ferc_queue / puc_signals /
-- puc_filings (the direct source precedents for this ticket's data).
-- ---------------------------------------------------------------------------
alter table public.substations                  enable row level security;
alter table public.substation_source_mentions   enable row level security;
alter table public.substation_jurisdiction_xref enable row level security;

drop policy if exists "service role only" on public.substations;
create policy "service role only" on public.substations
  for all using (auth.role() = 'service_role');

drop policy if exists "service role only" on public.substation_source_mentions;
create policy "service role only" on public.substation_source_mentions
  for all using (auth.role() = 'service_role');

drop policy if exists "service role only" on public.substation_jurisdiction_xref;
create policy "service role only" on public.substation_jurisdiction_xref
  for all using (auth.role() = 'service_role');

commit;
