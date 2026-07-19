-- ============================================================================
-- CC-LEGISCAN-INGEST-1.0 / FAR-347 — PFI wiring (Step 5)  ** DO NOT APPLY YET **
-- ============================================================================
--
-- GATED. Apply ONLY after ALL of:
--   1. LEGISCAN_API_KEY is set in Supabase edge-function secrets (I4).
--   2. The backfill run has populated ref_legiscan_bills (>= 40 states).
--   3. Backfill query spend is logged in legiscan_run_log and <= 5,000 (L4).
--
-- What it does (single-function change, L8):
--   * Adds v_legiscan_rows count.
--   * Adds a `legis` CTE computing the 14d-vs-prior-14d bill-activity delta per
--     state jurisdiction on last_action_date — matching the existing
--     opposition-delta shape exactly.
--   * Writes legislative_activity_delta with the same "guard on source-has-rows"
--     pattern the permit delta uses: NULL while the source is empty, else
--     coalesce(delta,0) so active states get a value and quiet states get 0.
--   * Drops 'legiscan_not_ingested' from indicator_gaps dynamically once
--     ref_legiscan_bills has rows.
--   * Bumps crawler_id v1.3 -> v1.4.
--
-- NO sig-1.0 weighting change (adding the legislative term to the signal-adjusted
-- model is a sig-1.1 registry decision — FAR-347 scope note).
--
-- Verify after applying: force one run and confirm the gap is gone and the delta
-- is non-NULL for active states:
--   select public.pfi_extract_trend_features(current_date);
--   select count(*) filter (where legislative_activity_delta is not null) as non_null,
--          bool_or(indicator_gaps ? 'legiscan_not_ingested')            as gap_present
--   from pfi_trend_features where run_date = current_date;
--
-- ROLLBACK: re-apply the "PRIOR BODY (v1.3)" block at the bottom of this file.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.pfi_extract_trend_features(p_run_date date DEFAULT CURRENT_DATE)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_started      timestamptz := now();
  v_total        int;
  v_inserted     int;
  v_updated      int;
  v_shovels_rows int;
  v_shovels_max  date;
  v_comfb_rows   int;
  v_legiscan_rows int;
  v_gaps         jsonb;
begin
  select count(*), max(file_date)
    into v_shovels_rows, v_shovels_max
  from shovels_permit_snapshots
  where jurisdiction_id is not null;
  select count(*) into v_comfb_rows from com_fb_raw_signals;
  -- CC-LEGISCAN-INGEST-1.0 (FAR-347): source-presence gate for the legislative delta
  select count(*) into v_legiscan_rows from ref_legiscan_bills where jurisdiction_id is not null;

  v_gaps := case when v_legiscan_rows = 0 then jsonb_build_array('legiscan_not_ingested') else '[]'::jsonb end
            || case when v_shovels_rows = 0 then jsonb_build_array('shovels_no_data')
                    when v_shovels_max < p_run_date - 7 then jsonb_build_array('shovels_stale_source')
                    else '[]'::jsonb end
            || case when v_comfb_rows = 0 then jsonb_build_array('data365_com_no_rows') else '[]'::jsonb end;

  with snaps0 as (
    -- CC-JPS-SCALE-MIGRATION-1.0: legacy 1–5 snapshots normalized onto 0–100 on read
    select jurisdiction_id, snapshot_date, jps_score,
           jps_score - lag(jps_score) over w as delta
    from (
      select jurisdiction_id, snapshot_date,
             case when scale_version = '1-5' then jps_legacy_to_100(jps_score) else jps_score end as jps_score
      from pfi_jps_snapshots
      where snapshot_date > p_run_date - 84 and snapshot_date <= p_run_date
    ) raw
    window w as (partition by jurisdiction_id order by snapshot_date)
  ),
  snaps as (
    select *, lag(delta) over (partition by jurisdiction_id order by snapshot_date) as prev_delta
    from snaps0
  ),
  trend as (
    select jurisdiction_id,
           regr_slope(jps_score, snapshot_date - (p_run_date - 84))
             filter (where snapshot_date > p_run_date - 42)              as slope_6w,
           regr_slope(jps_score, snapshot_date - (p_run_date - 84))      as slope_12w,
           stddev_samp(jps_score)                                        as volatility,
           (array_agg(jps_score order by snapshot_date desc))[1]
             - (array_agg(jps_score order by snapshot_date)
                  filter (where snapshot_date > p_run_date - 42))[1]     as momentum,
           count(*) filter (where delta is not null and prev_delta is not null
                            and sign(delta) <> 0 and sign(prev_delta) <> 0
                            and sign(delta) <> sign(prev_delta))         as direction_change_count,
           (p_run_date - max(snapshot_date)
              filter (where abs(coalesce(delta, 0)) >= 2.5))::int        as days_since_material
    from snaps
    group by jurisdiction_id
  ),
  opp as (
    select jurisdiction_id,
           count(*) filter (where created_at >= p_run_date - 14 and created_at < p_run_date)::numeric
         - count(*) filter (where created_at >= p_run_date - 28 and created_at < p_run_date - 14)::numeric
             as opposition_delta
    from opposition_signals
    where created_at >= p_run_date - 28 and created_at < p_run_date
    group by jurisdiction_id
  ),
  jds as (
    select jurisdiction_id, jds_normalized - lag_jds as jds_delta
    from (select jurisdiction_id, jds_normalized,
                 lag(jds_normalized) over (partition by jurisdiction_id order by scored_at) as lag_jds,
                 row_number() over (partition by jurisdiction_id order by scored_at desc) as rn
          from jds_scores) x
    where rn = 1
  ),
  permits as (
    select jurisdiction_id,
           count(*) filter (where file_date >  v_shovels_max - 14
                              and file_date <= v_shovels_max)::numeric
         - count(*) filter (where file_date >  v_shovels_max - 28
                              and file_date <= v_shovels_max - 14)::numeric
             as permit_delta
    from shovels_permit_snapshots
    where jurisdiction_id is not null
      and file_date > v_shovels_max - 28
    group by jurisdiction_id
  ),
  legis as (
    -- CC-LEGISCAN-INGEST-1.0 (FAR-347): 14d-vs-prior-14d bill-activity delta,
    -- same shape as opp above, keyed on last_action_date (when the bill moved).
    select jurisdiction_id,
           count(*) filter (where last_action_date >= p_run_date - 14 and last_action_date < p_run_date)::numeric
         - count(*) filter (where last_action_date >= p_run_date - 28 and last_action_date < p_run_date - 14)::numeric
             as legislative_delta
    from ref_legiscan_bills
    where jurisdiction_id is not null
      and last_action_date >= p_run_date - 28 and last_action_date < p_run_date
    group by jurisdiction_id
  ),
  pop as (select distinct jurisdiction_id from pfi_jps_snapshots),
  up as (
    insert into pfi_trend_features
      (jurisdiction_id, run_date, slope_6w, slope_12w, volatility, momentum,
       direction_change_count, days_since_last_material_change,
       legislative_activity_delta, permit_velocity_delta,
       opposition_signal_delta, jds_density_delta, indicator_gaps)
    select p.jurisdiction_id, p_run_date,
           t.slope_6w, t.slope_12w, t.volatility, t.momentum,
           t.direction_change_count, t.days_since_material,
           case when v_legiscan_rows > 0 then coalesce(l.legislative_delta, 0) end,
           case when v_shovels_rows > 0 then coalesce(pm.permit_delta, 0) end,
           coalesce(o.opposition_delta, 0),
           d.jds_delta,
           v_gaps
    from pop p
    left join trend   t  using (jurisdiction_id)
    left join opp     o  using (jurisdiction_id)
    left join jds     d  using (jurisdiction_id)
    left join permits pm using (jurisdiction_id)
    left join legis   l  using (jurisdiction_id)
    on conflict (jurisdiction_id, run_date) do update
      set slope_6w = excluded.slope_6w,
          slope_12w = excluded.slope_12w,
          volatility = excluded.volatility,
          momentum = excluded.momentum,
          direction_change_count = excluded.direction_change_count,
          days_since_last_material_change = excluded.days_since_last_material_change,
          legislative_activity_delta = excluded.legislative_activity_delta,
          permit_velocity_delta = excluded.permit_velocity_delta,
          opposition_signal_delta = excluded.opposition_signal_delta,
          jds_density_delta = excluded.jds_density_delta,
          indicator_gaps = excluded.indicator_gaps
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted),
         count(*) filter (where not inserted),
         count(*)
    into v_inserted, v_updated, v_total
  from up;

  insert into automation_health_log
    (auto_id, crawler_id, run_started_at, run_completed_at,
     artifacts_found, artifacts_new, artifacts_duped, errors, success, notes)
  values
    ('AUTO-189', 'pfi_extract_trend_features_v1.4', v_started, now(),
     v_total, v_inserted, v_updated, v_gaps, true,
     'PFI trend features for ' || p_run_date::text || ' (gaps in errors column)');

  return jsonb_build_object(
    'run_date', p_run_date, 'processed', v_total,
    'inserted', v_inserted, 'updated', v_updated, 'indicator_gaps', v_gaps,
    'shovels_data_through', v_shovels_max);
exception when others then
  insert into automation_health_log
    (auto_id, crawler_id, run_started_at, run_completed_at,
     artifacts_found, artifacts_new, artifacts_duped, errors, success, notes)
  values
    ('AUTO-189', 'pfi_extract_trend_features_v1.4', v_started, now(),
     0, 0, 0, jsonb_build_array(jsonb_build_object('error', sqlerrm)), false,
     'PFI trend features FAILED for ' || p_run_date::text);
  raise;
end $function$;


-- ============================================================================
-- ROLLBACK — PRIOR BODY (v1.3), captured verbatim before the change.
-- Re-apply this block to revert; 'legiscan_not_ingested' resumes logging
-- harmlessly and legislative_activity_delta returns to always-NULL.
-- ============================================================================
/*
CREATE OR REPLACE FUNCTION public.pfi_extract_trend_features(p_run_date date DEFAULT CURRENT_DATE)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_started      timestamptz := now();
  v_total        int;
  v_inserted     int;
  v_updated      int;
  v_shovels_rows int;
  v_shovels_max  date;
  v_comfb_rows   int;
  v_gaps         jsonb;
begin
  select count(*), max(file_date)
    into v_shovels_rows, v_shovels_max
  from shovels_permit_snapshots
  where jurisdiction_id is not null;
  select count(*) into v_comfb_rows from com_fb_raw_signals;

  v_gaps := jsonb_build_array('legiscan_not_ingested')
            || case when v_shovels_rows = 0 then jsonb_build_array('shovels_no_data')
                    when v_shovels_max < p_run_date - 7 then jsonb_build_array('shovels_stale_source')
                    else '[]'::jsonb end
            || case when v_comfb_rows = 0 then jsonb_build_array('data365_com_no_rows') else '[]'::jsonb end;

  with snaps0 as (
    select jurisdiction_id, snapshot_date, jps_score,
           jps_score - lag(jps_score) over w as delta
    from (
      select jurisdiction_id, snapshot_date,
             case when scale_version = '1-5' then jps_legacy_to_100(jps_score) else jps_score end as jps_score
      from pfi_jps_snapshots
      where snapshot_date > p_run_date - 84 and snapshot_date <= p_run_date
    ) raw
    window w as (partition by jurisdiction_id order by snapshot_date)
  ),
  snaps as (
    select *, lag(delta) over (partition by jurisdiction_id order by snapshot_date) as prev_delta
    from snaps0
  ),
  trend as (
    select jurisdiction_id,
           regr_slope(jps_score, snapshot_date - (p_run_date - 84))
             filter (where snapshot_date > p_run_date - 42)              as slope_6w,
           regr_slope(jps_score, snapshot_date - (p_run_date - 84))      as slope_12w,
           stddev_samp(jps_score)                                        as volatility,
           (array_agg(jps_score order by snapshot_date desc))[1]
             - (array_agg(jps_score order by snapshot_date)
                  filter (where snapshot_date > p_run_date - 42))[1]     as momentum,
           count(*) filter (where delta is not null and prev_delta is not null
                            and sign(delta) <> 0 and sign(prev_delta) <> 0
                            and sign(delta) <> sign(prev_delta))         as direction_change_count,
           (p_run_date - max(snapshot_date)
              filter (where abs(coalesce(delta, 0)) >= 2.5))::int        as days_since_material
    from snaps
    group by jurisdiction_id
  ),
  opp as (
    select jurisdiction_id,
           count(*) filter (where created_at >= p_run_date - 14 and created_at < p_run_date)::numeric
         - count(*) filter (where created_at >= p_run_date - 28 and created_at < p_run_date - 14)::numeric
             as opposition_delta
    from opposition_signals
    where created_at >= p_run_date - 28 and created_at < p_run_date
    group by jurisdiction_id
  ),
  jds as (
    select jurisdiction_id, jds_normalized - lag_jds as jds_delta
    from (select jurisdiction_id, jds_normalized,
                 lag(jds_normalized) over (partition by jurisdiction_id order by scored_at) as lag_jds,
                 row_number() over (partition by jurisdiction_id order by scored_at desc) as rn
          from jds_scores) x
    where rn = 1
  ),
  permits as (
    select jurisdiction_id,
           count(*) filter (where file_date >  v_shovels_max - 14
                              and file_date <= v_shovels_max)::numeric
         - count(*) filter (where file_date >  v_shovels_max - 28
                              and file_date <= v_shovels_max - 14)::numeric
             as permit_delta
    from shovels_permit_snapshots
    where jurisdiction_id is not null
      and file_date > v_shovels_max - 28
    group by jurisdiction_id
  ),
  pop as (select distinct jurisdiction_id from pfi_jps_snapshots),
  up as (
    insert into pfi_trend_features
      (jurisdiction_id, run_date, slope_6w, slope_12w, volatility, momentum,
       direction_change_count, days_since_last_material_change,
       legislative_activity_delta, permit_velocity_delta,
       opposition_signal_delta, jds_density_delta, indicator_gaps)
    select p.jurisdiction_id, p_run_date,
           t.slope_6w, t.slope_12w, t.volatility, t.momentum,
           t.direction_change_count, t.days_since_material,
           null,
           case when v_shovels_rows > 0 then coalesce(pm.permit_delta, 0) end,
           coalesce(o.opposition_delta, 0),
           d.jds_delta,
           v_gaps
    from pop p
    left join trend   t  using (jurisdiction_id)
    left join opp     o  using (jurisdiction_id)
    left join jds     d  using (jurisdiction_id)
    left join permits pm using (jurisdiction_id)
    on conflict (jurisdiction_id, run_date) do update
      set slope_6w = excluded.slope_6w,
          slope_12w = excluded.slope_12w,
          volatility = excluded.volatility,
          momentum = excluded.momentum,
          direction_change_count = excluded.direction_change_count,
          days_since_last_material_change = excluded.days_since_last_material_change,
          legislative_activity_delta = excluded.legislative_activity_delta,
          permit_velocity_delta = excluded.permit_velocity_delta,
          opposition_signal_delta = excluded.opposition_signal_delta,
          jds_density_delta = excluded.jds_density_delta,
          indicator_gaps = excluded.indicator_gaps
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted),
         count(*) filter (where not inserted),
         count(*)
    into v_inserted, v_updated, v_total
  from up;

  insert into automation_health_log
    (auto_id, crawler_id, run_started_at, run_completed_at,
     artifacts_found, artifacts_new, artifacts_duped, errors, success, notes)
  values
    ('AUTO-189', 'pfi_extract_trend_features_v1.3', v_started, now(),
     v_total, v_inserted, v_updated, v_gaps, true,
     'PFI trend features for ' || p_run_date::text || ' (gaps in errors column)');

  return jsonb_build_object(
    'run_date', p_run_date, 'processed', v_total,
    'inserted', v_inserted, 'updated', v_updated, 'indicator_gaps', v_gaps,
    'shovels_data_through', v_shovels_max);
exception when others then
  insert into automation_health_log
    (auto_id, crawler_id, run_started_at, run_completed_at,
     artifacts_found, artifacts_new, artifacts_duped, errors, success, notes)
  values
    ('AUTO-189', 'pfi_extract_trend_features_v1.3', v_started, now(),
     0, 0, 0, jsonb_build_array(jsonb_build_object('error', sqlerrm)), false,
     'PFI trend features FAILED for ' || p_run_date::text);
  raise;
end $function$;
*/
