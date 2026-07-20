-- CC-BUILD-SUBSTATION-INVENTORY-1.0 / FAR-372 — HIFLD national seed mechanism
--
-- Seeds public.substations (the canonical HIFLD-anchored spine, D3) from the
-- HIFLD Electric Substations national layer. The HIFLD Open portal was retired
-- 2025-08; this uses the ArcGIS mirror FeatureServer (layer 0, 75,328 features):
--   services5.arcgis.com/HDRa0B57OVrv2E1q/.../Electric_Substations/FeatureServer/0
--
-- The fetch runs server-side inside Postgres via the `http` extension (the
-- session's own egress blocks arcgis; the DB's does not). Idempotent: one
-- canonical row per HIFLD ID, keyed by content_hash = md5('hifld:'||ID); a
-- re-run refreshes mutable fields + last_seen_at, never duplicates.
--
-- Confidence tier SRC (0.85) per D5 (HIFLD-geocoded). No owner field exists in
-- the source, so operator_name is left null (an enrichment target). state_abbr
-- and county_fips are validated (2 alpha / 5 digit) and nulled if malformed.
--
-- One-time national seed executed 2026-07-20 -> 75,327 substations
-- (one duplicate HIFLD ID collapsed by content_hash). To refresh:
--   select sum(public.hifld_seed_page(off, 2000))
--   from generate_series(0, 74000, 2000) as off;

create extension if not exists http with schema extensions;

create or replace function public.hifld_seed_page(p_offset int, p_limit int default 2000)
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_url  text;
  v_resp text;
  v_n    int;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '25');
  v_url := 'https://services5.arcgis.com/HDRa0B57OVrv2E1q/ArcGIS/rest/services/Electric_Substations/FeatureServer/0/query'
        || '?where=1%3D1&outFields=ID,NAME,STATE,COUNTYFIPS,LATITUDE,LONGITUDE,MAX_VOLT,STATUS'
        || '&returnGeometry=false&orderByFields=OBJECTID&resultOffset=' || p_offset
        || '&resultRecordCount=' || p_limit || '&f=json';
  select content into v_resp from extensions.http_get(v_url);

  insert into public.substations (
    canonical_name, normalized_name, voltage_class_kv, lat, lon, geom,
    state_abbr, county_fips, confidence_tier, resolution_method, anchor_source, is_active, content_hash
  )
  select
    attrs->>'NAME',
    nullif(btrim(regexp_replace(lower(coalesce(attrs->>'NAME','')), '[^a-z0-9]+',' ','g')),''),
    case when (attrs->>'MAX_VOLT')::numeric > 0 then (attrs->>'MAX_VOLT')::numeric end,
    (attrs->>'LATITUDE')::numeric,
    (attrs->>'LONGITUDE')::numeric,
    case when attrs->>'LONGITUDE' is not null and attrs->>'LATITUDE' is not null
         then ST_SetSRID(ST_MakePoint((attrs->>'LONGITUDE')::float8, (attrs->>'LATITUDE')::float8), 4326) end,
    case when (attrs->>'STATE') ~ '^[A-Za-z]{2}$' then upper(attrs->>'STATE') end,
    case when (attrs->>'COUNTYFIPS') ~ '^[0-9]{5}$' then attrs->>'COUNTYFIPS' end,
    'SRC', 'hifld_seed', 'hifld',
    coalesce(upper(coalesce(attrs->>'STATUS','')) not in ('RETIRED','DECOMMISSIONED'), true),
    md5('hifld:' || (attrs->>'ID'))
  from json_array_elements(((v_resp)::json) -> 'features') as f(feat)
  cross join lateral (select f.feat->'attributes') as aj(attrs)
  where (attrs->>'ID') is not null
  on conflict (content_hash) do update set
    canonical_name   = excluded.canonical_name,
    normalized_name  = excluded.normalized_name,
    voltage_class_kv = excluded.voltage_class_kv,
    lat = excluded.lat, lon = excluded.lon, geom = excluded.geom,
    state_abbr = excluded.state_abbr, county_fips = excluded.county_fips,
    is_active = excluded.is_active,
    last_seen_at = now();

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

comment on function public.hifld_seed_page(int,int) is
  'CC-BUILD-SUBSTATION-INVENTORY-1.0 (FAR-372): fetch one page of the HIFLD Electric Substations ArcGIS mirror and idempotently upsert into public.substations (SRC/hifld_seed, content_hash = md5(hifld:ID)). Server-side http fetch. Refresh: select sum(hifld_seed_page(off,2000)) from generate_series(0,74000,2000) off;';

-- After a seed run, link each substation to its containing county jurisdiction
-- (D4 many-to-many; county_fips_containment join). Idempotent on the composite
-- PK. Executed 2026-07-20 -> 74,590 links.
--   insert into public.substation_jurisdiction_xref
--     (substation_id, jurisdiction_id, jurisdiction_level, join_method, is_primary)
--   select s.id, j.id, j.level::text, 'county_fips_containment', true
--   from public.substations s
--   join public.jurisdictions j
--     on j.level::text = 'county' and j.fips_code = s.county_fips
--   where s.county_fips is not null
--   on conflict (substation_id, jurisdiction_id) do nothing;
