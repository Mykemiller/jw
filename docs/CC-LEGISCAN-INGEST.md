# CC-LEGISCAN-INGEST-1.0 — LegiScan legislative ingestion (FAR-347)

Ingests data-center-related state legislation from the **LegiScan free public tier**
for all 50 states + DC, lands it idempotently, refreshes weekly, and feeds
`pfi_extract_trend_features.legislative_activity_delta` — retiring the last
unticketed PFI indicator gap (`legiscan_not_ingested`).

Supabase project `ycadmmngkdhvpcsrcuaq`. State-level only. No JPAS/JPS writes (L9).

## What shipped (built + applied)

| Artifact | Where | State |
|---|---|---|
| `ref_legiscan_bills`, `legiscan_run_log` | `migrations/20260719000001_legiscan_landing_tables.sql` | ✅ applied |
| `legiscan-refresh` edge function (verify_jwt=false) | `functions/legiscan-refresh/index.ts` | ✅ deployed |
| Weekly cron (Sun 05:00 UTC, jobid 135) | `migrations/20260719000002_legiscan_weekly_cron.sql` | ✅ applied |
| PFI wiring (Step 5) | `migrations/pending/legiscan_pfi_legislative_activity_delta.sql` | ⛔ gated — not applied |

## Idempotency (L6)

`getSearchRaw&state=ALL` returns `{bill_id, change_hash, relevance}` per bill. The
function compares each `change_hash` to the stored value and calls `getBill` **only**
for new/changed bills (D1). Upsert is keyed on `bill_id`; unchanged bills are
touched (`last_seen_at`, `last_run_id`) without spending a `getBill` query.

## Query budget (L4)

Free tier = 30,000 queries/month. Each `getSearchRaw` page and each `getBill` = 1
query. `legiscan_run_log` records `queries_used` and `month_to_date_queries`; a run
aborts (`status='aborted_budget'`) before crossing **25,000** MTD. Weekly steady
state targets < 500 queries; backfill ≤ 5,000.

## Go-live runbook (after Myke confirms the key)

1. **Set the secret** (edge-function secrets, NOT Vercel — L10):
   `LEGISCAN_API_KEY=<key>`.
2. **Backfill** — current + prior sessions, all states:
   ```
   -- server-side (pg_net) invoke; or POST with Bearer <service-role|cron token>
   select public.cron_http_post(
     'https://ycadmmngkdhvpcsrcuaq.supabase.co/functions/v1/legiscan-refresh',
     '{"years":[2,2024]}'::jsonb, 'cron_caller_token', 400000);
   ```
   Confirm in `legiscan_run_log`: `status='success'`, `queries_used` ≤ 5,000, and
   `ref_legiscan_bills` has ≥ 40 states with ≥ 1 bill:
   ```
   select count(distinct state_abbr) states, count(*) bills from ref_legiscan_bills;
   ```
3. **Apply the PFI wiring** — `migrations/pending/legiscan_pfi_legislative_activity_delta.sql`
   (top block). Force one run and verify:
   ```
   select public.pfi_extract_trend_features(current_date);
   select count(*) filter (where legislative_activity_delta is not null) non_null,
          bool_or(indicator_gaps ? 'legiscan_not_ingested') gap_present
   from pfi_trend_features where run_date = current_date;   -- expect non_null > 0, gap_present = false
   ```
4. The weekly cron (jobid 135) is already scheduled; it began no-op'ing
   (`skipped_no_key`) and starts real ingestion automatically once the key is set.

## Dry-run behaviour (current state, no key)

Every invocation writes a `legiscan_run_log` row with `status='skipped_no_key'` and
makes **zero** LegiScan calls. Verified 2026-07-19 (run_id 1, HTTP 200).

## Open decisions (flagged for Myke — FAR-347)

- **D1** per-bill hearing/calendar detail: recommend search + change_hash-triggered
  `getBill` only in 1.0 (implemented as such).
- **D2** full bill text (`getBillText`): deferred; store LegiScan URLs only.
- **D3** cross-reference `ncsl_moratorium_bills`: note overlap, no join in 1.0.

## Rollback

Drop `ref_legiscan_bills` + `legiscan_run_log`; `cron.unschedule('legiscan-refresh-weekly')`;
delete the `legiscan-refresh` edge function; revert `pfi_extract_trend_features` to the
v1.3 body (bottom of the pending file). No downstream JPAS/JPS contamination possible (L9).
