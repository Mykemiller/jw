-- CC-BUILD-SUBSTATION-INVENTORY-1.0 / FAR-372 — EIA operator enrichment
--
-- Fills substations.operator_name (a null enrichment target on the HIFLD seed —
-- HIFLD carries no owner field) by point-in-polygon of each substation's geom
-- against ref_utility_territory_geoms (EIA utility service territories, 2,931
-- MULTIPOLYGON rows, SRID 4326). When a point falls inside multiple overlapping
-- territories, the smallest-area (most specific / local) territory wins.
--
-- operator_source = 'eia_territory_match'. This is a service-territory proxy for
-- ownership, not a deed — the substation's confidence_tier (about geocoding) is
-- unchanged. No JPAS/JPS/JDS writes.
--
-- Run 2026-07-20: 74,805 / 75,327 (99.3%) matched, 2,223 distinct operators.
-- The ~522 nulls are points outside any mapped territory (offshore / gaps).
--
-- Refresh: select public.match_substation_operators();   -- re-runs null rows.
-- Note: a full-table run exceeds a 60s client cap; when driving from a
-- statement-timeout-bound client, bucket it, e.g.:
--   select public.match_substation_operators(true, 8, g)
--   from generate_series(0,7) g;

create or replace function public.match_substation_operators(
  p_only_null boolean default true,
  p_buckets   int     default 1,   -- >1 to split the table into hash buckets
  p_bucket    int     default 0    -- which bucket (0..p_buckets-1) to process
)
returns int
language sql
security definer
set search_path = public, extensions
as $$
  with m as (
    select distinct on (s.id) s.id as sid, u.name as uname
    from public.substations s
    join public.ref_utility_territory_geoms u
      on ST_Intersects(u.geom_full, s.geom)
    where s.geom is not null
      and (not p_only_null or s.operator_name is null)
      and (p_buckets <= 1 or abs(hashtext(s.id::text)) % p_buckets = p_bucket)
    order by s.id, ST_Area(u.geom_full) asc   -- smallest containing territory wins
  ),
  upd as (
    update public.substations s
    set operator_name   = m.uname,
        operator_source = 'eia_territory_match'
    from m
    where s.id = m.sid
    returning 1
  )
  select count(*)::int from upd;
$$;

comment on function public.match_substation_operators(boolean,int,int) is
  'CC-BUILD-SUBSTATION-INVENTORY-1.0 (FAR-372): fill substations.operator_name via point-in-polygon against ref_utility_territory_geoms (smallest containing EIA territory wins). operator_source=eia_territory_match. p_only_null skips already-set rows; p_buckets/p_bucket split the run for statement-timeout-bound clients.';
