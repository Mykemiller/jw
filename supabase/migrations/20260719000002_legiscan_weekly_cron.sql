-- CC-LEGISCAN-INGEST-1.0 / FAR-347 — weekly refresh cron (L5)
-- Sunday 05:00 UTC: lands the week's LegiScan data BEFORE the PFI pipeline runs
-- (pfi_capture_snapshots 06:00, pfi_extract_trend_features 06:30, jobids 29/30),
-- so the legislative_activity_delta computed that morning sees fresh bills.
--
-- Direct HTTP invoke via cron_http_post + vault 'cron_caller_token' (no app.* GUCs,
-- I6). Body '{}' -> edge fn defaults: terms = data center variants (L7),
-- years = [2] (current sessions — the only window the 14d/28d delta reads).
-- While LEGISCAN_API_KEY is unset the function no-ops (skipped_no_key), so this
-- schedule is safe to land now; it starts ingesting the moment the key arrives.

select cron.schedule(
  'legiscan-refresh-weekly',
  '0 5 * * 0',
  $$
    select public.cron_http_post(
      'https://ycadmmngkdhvpcsrcuaq.supabase.co/functions/v1/legiscan-refresh',
      '{}'::jsonb, 'cron_caller_token', 400000);
  $$
);
