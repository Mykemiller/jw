-- CC-BUILD-SUBSTATION-INVENTORY-1.0 / FAR-372 — schema-ready substation age grade
--
-- Adds a nullable substations.commissioned_year (energization year) and a
-- read-time A–F age-grade view. Populated by ZERO rows in this ticket: no bulk
-- per-substation vintage source exists — HIFLD carries only SOURCEDATE/VAL_DATE
-- (data provenance ~2014–2015), not construction dates; EIA-860 in-service years
-- are for generators, not substations. So age_grade is NULL (ABS/unknown) for all
-- rows until a vintage source lands (scoping under FAR-372 follow-up / FAR-373).
--
-- Age drifts every year, so the grade is a VIEW (read-time), never a stored column.
-- The lifecycle-tracking architecture — bare column here vs. an effective-dated
-- event-log / JTS layer — remains FAR-373's call (D2/D3); logged there 2026-07-20.
-- Thresholds (per Myke): <=20yr=A, 21-30=B, 31-40=C, 41-50=D, >50=F.

alter table public.substations
  add column if not exists commissioned_year integer;

comment on column public.substations.commissioned_year is
  'FAR-372/FAR-373: substation energization year. Schema-ready, ZERO rows populated in this ticket (no bulk per-substation vintage source yet). Feeds substation_age_grade. Effective-dated/event-log treatment is FAR-373 territory.';

create or replace view public.substation_age_grade
with (security_invoker = true) as
select
  s.id,
  s.canonical_name,
  s.state_abbr,
  s.county_fips,
  s.commissioned_year,
  case when s.commissioned_year is not null
       then extract(year from now())::int - s.commissioned_year end as age_years,
  case
    when s.commissioned_year is null then null                                        -- ABS / unknown
    when extract(year from now())::int - s.commissioned_year <= 20 then 'A'
    when extract(year from now())::int - s.commissioned_year <= 30 then 'B'
    when extract(year from now())::int - s.commissioned_year <= 40 then 'C'
    when extract(year from now())::int - s.commissioned_year <= 50 then 'D'
    else 'F'
  end as age_grade
from public.substations s;

comment on view public.substation_age_grade is
  'FAR-372: read-time A-F substation age grade (<=20=A, 21-30=B, 31-40=C, 41-50=D, >50=F) from substations.commissioned_year. security_invoker => inherits base-table service-role-only RLS. age_grade NULL (ABS/unknown) until commissioned_year is sourced (FAR-373).';
