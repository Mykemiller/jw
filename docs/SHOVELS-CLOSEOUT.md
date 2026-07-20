# Shovels.ai closeout (FAR-371 / epic FAR-263)

Closeout of the Shovels.ai permitting-intelligence integration, executed against the **as-built
per-permit design** (the original aggregate/adapter/trigger spec is superseded). Supabase project
`ycadmmngkdhvpcsrcuaq`.

## What this branch adds

- **`supabase/migrations/20260719_shovels_refresh_and_jds_l2.sql`**
  - `jw_shovels_match_permits(uuid)` — name-based place→county jurisdiction matcher (mirrors the
    2026-07 seed; validated 100% place / 99.8% county).
  - `jw_shovels_run_touched(uuid)` — jurisdictions touched by a run (matched places/counties + rollup counties).
  - `jw_shovels_apply_chain(uuid,text)` — ordered post-ingest apply chain ending in the AUTHORITATIVE
    quality recompute (`jw_refresh_quality_medians` → `jw_recompute_us_jpas_quality`). Never calls the
    retired `jw_recompute_us_jpas`.
  - `jw_shovels_apply_jds_candidates(boolean)` — **replaced** to emit L2 (`construction`) vs L3
    (`permitted`) per D4. Result on the seed corpus: 117 L2 / 748 L3.
  - `jw_shovels_ingest_upsert(jsonb,uuid)` — bulk permit upsert (dedup by `shovels_permit_id`;
    `content_hash` change-detector; preserves existing jurisdiction match on conflict).
- **`supabase/migrations/20260719_shovels_metro_metrics.sql`** — `jw_shovels_metro_metrics(uuid[])`,
  the JPS-1.1 scorer-grounding helper.
- **`supabase/functions/shovels-refresh/index.ts`** — recurring sync Edge Function (deployed).
  Seed config/cursor/credit pattern; rolling 60-day lookback (D9); hard 2,000-credit cap per run (D1);
  Supabase-secrets-only key (D3) with a clean skip when `SHOVELS_API_KEY` is absent.
- **`supabase/artifacts/`** — coverage + Ambassador-gap CSVs (see that README).

## Deployed out-of-band (not in this scaffold repo)

- `jurisdiction-scorer` bumped to **JPS-1.1** (v10): injects licensed Shovels permitting metrics into
  the model context and names Shovels.ai an authorized SRC (0.85) source for the `permitting` component.
  Canonical source lives on Supabase; the change is recorded in the function header version-history.
- **pg_cron** jobs: `shovels-refresh-first` (`0 5 1 * *`), `shovels-refresh-fifteenth` (`0 5 15 * *`),
  `shovels-refresh-healthcheck` (`0 7 1,15 * *`).

## Pending external unblocks

1. **`SHOVELS_API_KEY` is not in Supabase secrets** (verified). Provision it → the recurring sync's
   live first run, and the FAR-269 Decisions API probe, can execute. The function skips cleanly until then.
2. **Airtable bulk record-write approval** → populate the 4 FAR-270 fields from
   `supabase/artifacts/shovels_registry_coverage.csv` (fields already created).
