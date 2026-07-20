-- CC-PUC-DOCKETS-REMEDIATION-1.0 (FAR-353 remediation), D1.
-- Root cause: the ingest-puc-dockets adapters never set filed_date on the docket
-- record (only on puc_filings), so puc_dockets.filed_date was NULL on 100% of rows
-- while puc_filings.filed_date was fully populated. This function derives the docket
-- filed_date from the earliest filing on record for the docket.
--
-- Semantics: a docket's filed_date is the earliest filing date on record for it
-- (min over puc_filings). Monotonic-earliest — the value only ever moves earlier,
-- so incremental weekly runs converge toward the true docket open date and never
-- regress. Powers both the one-time retroactive fix of pre-existing rows and the
-- per-run reconciliation the extractor calls after writing filings.
--
-- Service-role only (RLS deny-by-default backstop unchanged); no anon grant.

create or replace function public.puc_reconcile_docket_filed_dates(p_state_fips text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer;
begin
  with mins as (
    select f.docket_id, min(f.filed_date) as min_filed
    from puc_filings f
    where f.filed_date is not null
      and f.docket_id is not null
      and (p_state_fips is null or f.state_fips = p_state_fips)
    group by f.docket_id
  )
  update puc_dockets d
     set filed_date = m.min_filed
    from mins m
   where d.id = m.docket_id
     and d.filed_date is distinct from m.min_filed
     and (d.filed_date is null or m.min_filed < d.filed_date);
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

revoke all on function public.puc_reconcile_docket_filed_dates(text) from public, anon, authenticated;
grant execute on function public.puc_reconcile_docket_filed_dates(text) to service_role;
