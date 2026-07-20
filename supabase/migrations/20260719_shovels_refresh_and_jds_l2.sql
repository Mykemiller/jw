-- CC-SHOVELS-CLOSEOUT-1.0 (FAR-371, epic FAR-263)
-- Support objects for the recurring `shovels-refresh` sync + JDS L2 classification.
--
-- Adds, all in `public`, SECURITY DEFINER, search_path-pinned:
--   * jw_shovels_match_permits(uuid)   — place/county name matcher (mirrors the seed:
--                                        place_name_state -> county_name_state, ambiguity-aware)
--   * jw_shovels_run_touched(uuid)     — jurisdictions (matched places + rollup counties) touched by a run
--   * jw_shovels_apply_chain(uuid,text)— ordered post-ingest apply chain ending in the
--                                        AUTHORITATIVE quality recompute (never the retired stub)
--   * jw_shovels_apply_jds_candidates  — REPLACED to emit L2 ('construction') vs L3 ('permitted') per D4
--
-- Guardrail: the apply chain calls the apply functions with p_recompute=false and then does ONE
-- jw_refresh_quality_medians() + jw_recompute_us_jpas_quality(touched, ...) — it NEVER calls the
-- retired jw_recompute_us_jpas (CC-JPAS-QUALITY-AUTHORITATIVE-CUTOVER-1.0).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Jurisdiction matcher (name-based, seed-faithful)
--    Processes rows whose jurisdiction_match_status IS NULL (freshly ingested).
--    Place first (exactly-1 -> matched_place, >1 -> unmatched_ambiguous); then county
--    for still-unmatched; remainder -> unmatched. Normalization validated 100% (place)
--    / 99.8% (county) against the 2026-07 seed.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.jw_shovels_match_permits(p_run_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_place int := 0; v_county int := 0; v_ambig int := 0; v_unmatched int := 0;
begin
  -- Step 1: place match
  with tgt as (
    select id, city, state
    from shovels_permit_snapshots
    where jurisdiction_match_status is null
      and (p_run_id is null or ingest_run_id = p_run_id)
      and city is not null and btrim(city) <> ''
  ),
  m as (
    select t.id, array_agg(j.id) as jids
    from tgt t
    join jurisdictions j
      on j.level = 'place'
     and j.state_abbr = t.state
     and lower(regexp_replace(j.name, '\s+(city|town|village|borough|municipality|CDP)$', '', 'i')) = lower(t.city)
    group by t.id
  )
  update shovels_permit_snapshots s
     set jurisdiction_id        = case when cardinality(m.jids) = 1 then m.jids[1] end,
         jurisdiction_match_status = case when cardinality(m.jids) = 1 then 'matched_place' else 'unmatched_ambiguous' end,
         match_method           = case when cardinality(m.jids) = 1 then 'place_name_state' end
    from m
   where s.id = m.id;

  -- Step 2: county match for rows still unprocessed
  with tgt as (
    select id, county, state
    from shovels_permit_snapshots
    where jurisdiction_match_status is null
      and (p_run_id is null or ingest_run_id = p_run_id)
      and county is not null and btrim(county) <> ''
  ),
  m as (
    select t.id, array_agg(j.id) as jids
    from tgt t
    join jurisdictions j
      on j.level = 'county'
     and j.state_abbr = t.state
     and lower(regexp_replace(j.name, '\s+(County|Parish|Borough|Census Area|Municipality|city and borough)$', '', 'i')) = lower(t.county)
    group by t.id
  )
  update shovels_permit_snapshots s
     set jurisdiction_id        = case when cardinality(m.jids) = 1 then m.jids[1] end,
         jurisdiction_match_status = case when cardinality(m.jids) = 1 then 'matched_county' else 'unmatched_ambiguous' end,
         match_method           = case when cardinality(m.jids) = 1 then 'county_name_state' end
    from m
   where s.id = m.id;

  -- Step 3: everything still NULL is genuinely unmatched
  update shovels_permit_snapshots
     set jurisdiction_match_status = 'unmatched'
   where jurisdiction_match_status is null
     and (p_run_id is null or ingest_run_id = p_run_id);

  select
    count(*) filter (where jurisdiction_match_status = 'matched_place'),
    count(*) filter (where jurisdiction_match_status = 'matched_county'),
    count(*) filter (where jurisdiction_match_status = 'unmatched_ambiguous'),
    count(*) filter (where jurisdiction_match_status = 'unmatched')
    into v_place, v_county, v_ambig, v_unmatched
  from shovels_permit_snapshots
  where (p_run_id is null or ingest_run_id = p_run_id);

  return jsonb_build_object(
    'matched_place', v_place, 'matched_county', v_county,
    'unmatched_ambiguous', v_ambig, 'unmatched', v_unmatched);
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Touched-jurisdiction set for a run: matched places/counties + their rollup counties.
--    NULL run => the whole matched set (used for a full re-verify).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.jw_shovels_run_touched(p_run_id uuid default null)
returns uuid[]
language sql
security definer
set search_path to 'public'
as $function$
  select coalesce(array_agg(distinct x) filter (where x is not null), '{}'::uuid[])
  from (
    select s.jurisdiction_id as x
    from shovels_permit_snapshots s
    where s.jurisdiction_id is not null
      and s.jurisdiction_match_status in ('matched_place','matched_county')
      and (p_run_id is null or s.ingest_run_id = p_run_id)
    union
    select o.parent_jurisdiction_id
    from shovels_permit_snapshots s
    join jurisdiction_geo_overlap o
      on o.child_jurisdiction_id = s.jurisdiction_id and o.area_fraction >= 0.01
    join jurisdictions pj
      on pj.id = o.parent_jurisdiction_id and pj.level = 'county'
    where s.jurisdiction_id is not null
      and s.jurisdiction_match_status in ('matched_place','matched_county')
      and (p_run_id is null or s.ingest_run_id = p_run_id)
  ) u;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Ordered post-ingest apply chain.
--    apply_permitting_jpas(false) -> reg09_rollup(apply, no-recompute) -> dim_permitting
--    -> jds_candidates(true) -> refresh_quality_medians -> recompute_us_jpas_quality(touched).
--    Single authoritative quality recompute at the tail; retired stub never touched.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.jw_shovels_apply_chain(p_run_id uuid default null, p_trigger text default 'shovels-refresh')
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_perm jsonb; v_reg jsonb; v_dim jsonb; v_jds jsonb; v_med jsonb; v_rec jsonb;
  v_touched uuid[];
begin
  v_perm := jw_shovels_apply_permitting_jpas(false);
  v_reg  := jw_reg09_place_county_rollup(true, false);
  v_dim  := jw_shovels_apply_dim_permitting();
  v_jds  := jw_shovels_apply_jds_candidates(true);
  v_touched := jw_shovels_run_touched(p_run_id);
  v_med  := jw_refresh_quality_medians();
  v_rec  := jw_recompute_us_jpas_quality(v_touched, p_trigger);
  return jsonb_build_object(
    'permitting_jpas',   v_perm,
    'reg09_rollup',      v_reg,
    'dim_permitting',    v_dim,
    'jds_candidates',    v_jds,
    'touched_count',     coalesce(array_length(v_touched, 1), 0),
    'quality_medians',   v_med,
    'quality_recompute', v_rec);
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. JDS candidates with L2/L3 layering (FAR-268 / D4).
--    L2 ('construction') = qualifying candidate (matched jurisdiction, >10k sqft, dedup-by-address)
--      AND ((start_date set AND final_date null) OR status = 'active')       -- active construction
--      AND (data-center-signalled description/tags OR job_value > $5M).
--    Everything else that qualifies stays L3 ('permitted'). Dedup-by-address preserved.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.jw_shovels_apply_jds_candidates(p_recompute boolean default true)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_inserted int := 0;
  v_l2 int := 0;
  v_l3 int := 0;
  v_touched uuid[];
  v_states int := 0;
begin
  with ranked as (
    select distinct on (s.jurisdiction_id, lower(coalesce(nullif(trim(coalesce(s.street_no,'')||' '||coalesce(s.street,'')),''), 'permit:'||s.shovels_permit_id)))
           s.shovels_permit_id, s.jurisdiction_id, s.description, s.city, s.state,
           s.latitude, s.longitude, s.building_area_sqft, s.job_value,
           s.status, s.start_date, s.final_date, s.tags,
           coalesce(s.issue_date, s.file_date, s.start_date) as announced_date,
           s.permit_type
    from shovels_permit_snapshots s
    where s.building_area_sqft > 10000
      and s.jurisdiction_id is not null
      and s.jurisdiction_match_status in ('matched_place','matched_county')
    order by s.jurisdiction_id,
             lower(coalesce(nullif(trim(coalesce(s.street_no,'')||' '||coalesce(s.street,'')),''), 'permit:'||s.shovels_permit_id)),
             s.building_area_sqft desc nulls last,
             coalesce(s.issue_date, s.file_date, s.start_date) desc nulls last
  ),
  classified as (
    select r.*,
      case
        when ((r.start_date is not null and r.final_date is null) or r.status = 'active')
             and ( r.description ~* 'data\s*cent(er|re)|hyperscale|server farm|colocation|colo facility|data\s*hall'
                   or 'data_center' = any(r.tags) or 'datacenter' = any(r.tags)
                   or coalesce(r.job_value, 0) > 5000000 )
        then 'L2' else 'L3'
      end as jds_layer
    from ranked r
  ),
  ins as (
    insert into public.jw_facilities
      (jurisdiction_id, facility_name, jds_layer, status, capacity_mw, site_acres,
       city, state_abbr, lat, lng, source_name, source_url, source_confidence,
       announced_date, notes)
    select c.jurisdiction_id,
           left(coalesce(nullif(trim(c.description),''),
                         'Commercial development, '||coalesce(c.city, c.state, 'US')), 160),
           c.jds_layer,
           case when c.jds_layer = 'L2' then 'construction' else 'permitted' end,
           null, null,
           c.city, upper(c.state), c.latitude, c.longitude,
           'Shovels Permits (seed)', 'shovels-permit:'||c.shovels_permit_id, 'INF',
           c.announced_date,
           'FAR-263 '||c.jds_layer||' candidate · '||coalesce(c.building_area_sqft::text,'?')||' sqft'||
             case when c.job_value > 0 then ' · $'||round(c.job_value)::text else '' end||
             ' · '||coalesce(c.status,'?')
    from classified c
    on conflict (source_url) where source_name = 'Shovels Permits (seed)'
    do update set jurisdiction_id = excluded.jurisdiction_id,
                  facility_name   = excluded.facility_name,
                  jds_layer       = excluded.jds_layer,
                  status          = excluded.status,
                  city = excluded.city, state_abbr = excluded.state_abbr,
                  lat = excluded.lat, lng = excluded.lng,
                  announced_date = excluded.announced_date, notes = excluded.notes,
                  updated_at = now()
    returning jurisdiction_id, jds_layer
  )
  select array_agg(distinct jurisdiction_id),
         count(*),
         count(*) filter (where jds_layer = 'L2'),
         count(*) filter (where jds_layer = 'L3')
    into v_touched, v_inserted, v_l2, v_l3
  from ins;

  if p_recompute and v_inserted > 0 then
    v_states := jw_rollup_state_jds('data_event');
  end if;

  return jsonb_build_object(
    'candidates_upserted',    v_inserted,
    'l2_count',               v_l2,
    'l3_count',               v_l3,
    'jurisdictions_touched',  coalesce(array_length(v_touched, 1), 0),
    'states_rescored',        v_states);
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Bulk permit upsert used by the shovels-refresh edge function.
--    Dedup key = shovels_permit_id (UNIQUE). content_hash is the change-detector.
--    On conflict the jurisdiction_id / _match_status / _match_method columns are
--    deliberately NOT updated, so an existing match survives a re-seen permit;
--    fresh rows land with NULL match status for jw_shovels_match_permits() to resolve.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.jw_shovels_ingest_upsert(p_rows jsonb, p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_stored int; v_changed int; v_unchanged int;
begin
  create temp table _incoming on commit drop as
    select * from jsonb_to_recordset(p_rows) as x(
      shovels_permit_id text, content_hash text, permit_no text, permit_type text,
      permit_subtype text, status text, description text, file_date date, issue_date date,
      final_date date, start_date date, end_date date, job_value numeric,
      building_area_sqft numeric, property_type text, tags text[], street_no text,
      street text, city text, county text, state text, zipcode text,
      latitude numeric, longitude numeric, geo_id text, raw jsonb);

  create temp table _class on commit drop as
    select i.shovels_permit_id,
           (e.shovels_permit_id is not null) as existed,
           (e.content_hash is distinct from i.content_hash) as changed
    from _incoming i
    left join shovels_permit_snapshots e on e.shovels_permit_id = i.shovels_permit_id;

  insert into shovels_permit_snapshots as t
    (shovels_permit_id, content_hash, permit_no, permit_type, permit_subtype, status, description,
     file_date, issue_date, final_date, start_date, end_date, job_value, building_area_sqft,
     property_type, tags, street_no, street, city, county, state, zipcode, latitude, longitude,
     geo_id, raw, ingest_run_id, first_seen_at, last_seen_at)
  select shovels_permit_id, content_hash, permit_no, permit_type, permit_subtype, status, description,
     file_date, issue_date, final_date, start_date, end_date, job_value, building_area_sqft,
     property_type, tags, street_no, street, city, county, state, zipcode, latitude, longitude,
     geo_id, raw, p_run_id, now(), now()
  from _incoming
  on conflict (shovels_permit_id) do update set
     content_hash = excluded.content_hash, permit_no = excluded.permit_no,
     permit_type = excluded.permit_type, permit_subtype = excluded.permit_subtype,
     status = excluded.status, description = excluded.description,
     file_date = excluded.file_date, issue_date = excluded.issue_date,
     final_date = excluded.final_date, start_date = excluded.start_date, end_date = excluded.end_date,
     job_value = excluded.job_value, building_area_sqft = excluded.building_area_sqft,
     property_type = excluded.property_type, tags = excluded.tags,
     street_no = excluded.street_no, street = excluded.street, city = excluded.city,
     county = excluded.county, state = excluded.state, zipcode = excluded.zipcode,
     latitude = excluded.latitude, longitude = excluded.longitude, geo_id = excluded.geo_id,
     raw = excluded.raw, ingest_run_id = excluded.ingest_run_id, last_seen_at = now();

  select count(*) filter (where not existed),
         count(*) filter (where existed and changed),
         count(*) filter (where existed and not changed)
    into v_stored, v_changed, v_unchanged
  from _class;

  return jsonb_build_object('stored', v_stored, 'changed', v_changed, 'deduped', v_unchanged);
end;
$function$;
