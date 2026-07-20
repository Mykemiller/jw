# CC-PUC-DOCKETS-REMEDIATION-1.0 (FAR-353 remediation)

Follow-up to FAR-353 (CC-INGEST-PUC-DOCKETS-1.0). Two defects found in audit plus a
latent bug surfaced during backfill. Landing zone unchanged: `puc_dockets → puc_filings
→ puc_signals` only; **no** `jpas_attributes`/JPS/JDS writes; RLS stays service-role-only;
`idf_ingested` stays false (FAR-90).

## Investigation (I1–I6)

- **I1 — `filed_date` null root cause:** extractor bug, not a source omission. Both
  adapters parse a filing-level date (TX "File Stamp"; VA `DateFiled`) and store it on
  `puc_filings` (was 717/717 populated), but the docket `NormalizedDocket` never set
  `filed_date`, so `puc_dockets.filed_date` was NULL on 100% of rows.
- **I2 — depth:** TX Interchange takes arbitrary `DateFiledFrom/To` (decade+); VA Breeze
  API is monthly `Year/Month` (10+ yr). The real limiter was our own `monthsInWindow`
  24-month hard cap (now 360).
- **I3 — isolation:** gap was isolated to `puc_dockets`. `puc_filings.filed_date` fully
  populated; `puc_signals` has no own date column (inherits via `filing_id`).
- **I4 — WAF (MN/OH/WI):** all three reject the pipeline fetch from the shared Supabase
  egress IP. Re-probed 2026-07-20 with a realistic browser UA + headers: OH still returns
  the F5 "Request Rejected" page, WI 403 (Cloudflare JS challenge), MN 403. UA alone does
  not clear any — the block is egress-IP/behavioral. Needs proxy/headless.
- **I5 — backfill mechanism:** the weekly cron (`puc-dockets-weekly`) authenticates via
  `cron_http_post` reading a **vault** secret — FAR-344 compliant. Backfill is run as
  parameterized `mode:'run'` calls with explicit `from`/`to` — **not** a new cron, so no
  new secrets. (One code cap lifted: VA `monthsInWindow` 24→360.)
- **I6 — staging boundary held:** `idf_ingested` false on all signals; no jpas/JPS/JDS
  writes trace to puc. Confirmed in practice, not just registry notes.

## Fixes in this pass

1. **D1 — `filed_date`.** New `puc_reconcile_docket_filed_dates(p_state_fips)` derives the
   docket `filed_date` from the earliest filing on record (monotonic-earliest). Called by
   the extractor after each state run, and used to retroactively fix the pre-existing rows.
   Result: **100% of dockets dated** (was 0%).
2. **Latent signal_type CHECK-abort (found under backfill).** `puc_keyword_map` carried
   `substation_construction` + `transmission_project` signal rules whose `signal_type` is
   not in the `puc_signals_signal_type_check` constraint; any matching filing threw and
   aborted the whole run (never exercised by the 3-day launch window). The extractor now
   skips signal types outside `ALLOWED_SIGNAL_TYPES` instead of aborting. **Follow-up:**
   capturing those grid-buildout signals needs both the allowed set and the DB CHECK
   expanded (schema change, deliberately out of scope this pass).
3. **D2 — historical backfill.** Driven as chunked `mode:'run'` calls.
   - **VA:** reached **2025-07-07** (~12 months; 227 dockets / ~3,995 filings), 100% dated.
   - **TX:** extended to **2026-07-01**. Full TX depth **deferred**: TX docket volume is
     high (a 3-day window alone yields ~200 dockets) and the adapter has no docket-offset
     pagination, so deep windows trip the edge-function worker resource limit. Full history
     needs a throttled short-window batch or a bulk-write redesign.

## Operational constraints discovered

- The edge function does **sequential** per-row upserts; wide windows exceed the worker
  resource limit (`546 WORKER_RESOURCE_LIMIT`) mid-write, leaving orphan dockets (cleaned
  up here). Size each backfill chunk to *complete* (VA ≈ monthly/quarterly; TX ≈ days).
- No docket-offset pagination: a window returns only its first `maxDockets` dockets, so
  full coverage of a busy window requires narrowing the window, not re-running it.

## Deferred / follow-up

- Full multi-year TX+VA history via throttled short-window batches.
- `puc_signals` CHECK + `ALLOWED_SIGNAL_TYPES` expansion for `substation_construction` /
  `transmission_project`.
- D3 WAF remediation for MN/OH/WI (proxy/headless).
- D4 50-state onboarding: net-new per-state adapters (prioritize json-api / html-structured
  access kinds — FL, NY, GA, CO, IL, WA, … — mirroring the TX/VA pattern).

## Rollback

Additive + content-hash idempotent. Rollback = delete backfilled rows by state/date range
and reset `puc_sources.cursor`. No schema changes this pass (the reconcile function is
additive and idempotent).
