# Pending migrations — apply only when their gate opens

These are built and reviewed but **intentionally not applied** to
`ycadmmngkdhvpcsrcuaq`. `supabase db push` should skip this directory (it is not a
timestamped migration at the top level).

## `legiscan_pfi_legislative_activity_delta.sql` — FAR-347 Step 5 (PFI wiring)

Modifies `pfi_extract_trend_features` to compute `legislative_activity_delta` from
`ref_legiscan_bills` and drop the `legiscan_not_ingested` indicator gap.

**Gate — apply only after ALL of:**
1. `LEGISCAN_API_KEY` is set in Supabase edge-function secrets.
2. The backfill run has populated `ref_legiscan_bills` (target ≥ 40 states).
3. Backfill query spend is logged in `legiscan_run_log` and ≤ 5,000.

**Apply:** run the top (uncommented) `CREATE OR REPLACE FUNCTION` block via
`apply_migration`, then force one run and verify (queries in the file header).

**Rollback:** re-apply the commented "PRIOR BODY (v1.3)" block at the bottom of the
file. The gap resumes logging harmlessly and the delta returns to always-NULL.
