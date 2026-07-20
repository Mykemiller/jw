-- CC-SHOVELS-CLOSEOUT-1.0 (FAR-371 / FAR-271, A5 · D6)
-- Shovels permitting metrics per registry (metro) jurisdiction, for JPS-1.1 scorer grounding.
-- Rolls up from the county the metro's geo_key points at (county-matched permits + the county's
-- constituent places' permits). Returns a jsonb map { jurisdiction_id: { permits, median_approval_days } }.
create or replace function public.jw_shovels_metro_metrics(p_ids uuid[])
returns jsonb
language sql
security definer
set search_path to 'public'
as $function$
  with metro as (
    select id, geo_key from jurisdictions
    where id = any(p_ids) and level = 'metro' and state_abbr is not null and geo_key is not null
  ),
  county as (
    select m.id as metro_id, c.id as county_id
    from metro m join jurisdictions c on c.level='county' and c.fips_code = m.geo_key
  ),
  permits as (
    select cy.metro_id, s.issue_date, s.file_date
    from county cy join shovels_permit_snapshots s
      on s.jurisdiction_id = cy.county_id and s.jurisdiction_match_status='matched_county'
    union all
    select cy.metro_id, s.issue_date, s.file_date
    from county cy
    join jurisdiction_geo_overlap o on o.parent_jurisdiction_id = cy.county_id and o.area_fraction >= 0.01
    join shovels_permit_snapshots s on s.jurisdiction_id = o.child_jurisdiction_id and s.jurisdiction_match_status='matched_place'
  )
  select coalesce(jsonb_object_agg(metro_id, m), '{}'::jsonb)
  from (
    select p.metro_id::text as metro_id,
      jsonb_build_object(
        'permits', count(*),
        'median_approval_days',
          round(percentile_cont(0.5) within group (order by (issue_date - file_date))
            filter (where issue_date is not null and file_date is not null and issue_date >= file_date)::numeric, 1)
      ) as m
    from permits p
    group by p.metro_id
  ) x;
$function$;
