// Faraday — Jurisdiction Watch · shovels-refresh (FAR-371 / epic FAR-263, CC-SHOVELS-CLOSEOUT-1.0)
//
// Recurring Shovels.ai permit sync. Reuses the 2026-07 seed's config/cursor/credit-accounting
// pattern (see jw_shovels_ingest_runs rows). Same filters as the seed; a rolling 60-day lookback
// window (D9 — idempotent via content_hash / shovels_permit_id upsert, so window overlap is safe);
// a hard 2,000-credit cap per run (D1). After a successful ingest it matches jurisdictions and runs
// the authoritative apply chain (jw_shovels_apply_chain), which ends in
// jw_refresh_quality_medians() + jw_recompute_us_jpas_quality(touched) — NEVER the retired
// jw_recompute_us_jpas stub.
//
// Credit discipline (D1): cap is enforced mid-pagination — once `returned` reaches the cap we stop,
// record cap_hit:true, and leave remaining states with done:false. If the last known balance is
// already below the cap we skip the run entirely and alert (never auto-purchase — Myke sign-off).
//
// Key placement (D3): the Shovels key is read from Supabase secrets only (server-side). If it is
// absent the function SKIPS cleanly (logs + records a skipped run) instead of erroring, so a cron
// firing before the key is provisioned is harmless.
//
// Auth: Bearer SUPABASE_SERVICE_ROLE_KEY or the cron caller token (matches cron_http_post).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Accept the cron caller token whether it arrives from vault (cron_http_post) or a CRON_TOKEN env.
const CRON_TOKEN = "fcron_9mK3pX7qR2vN8wYz4tB6sL1dH5jG0aE";
const CRON_TOKEN_ENV = Deno.env.get("CRON_TOKEN");
const PER_RUN_CREDIT_CAP = 2000; // D1
const LOOKBACK_DAYS = 60; // D9
const PAGE_SIZE = 100;
const SHOVELS_SEARCH = "https://api.shovels.ai/v2/permits/search";

// Same 50 states + DC as the 2026-07 seed.
const STATES = [
  "AK","AL","AR","AZ","CA","CO","CT","DC","DE","FL","GA","HI","IA","ID","IL","IN","KS","KY","LA",
  "MA","MD","ME","MI","MN","MO","MS","MT","NC","ND","NE","NH","NJ","NM","NV","NY","OH","OK","OR",
  "PA","RI","SC","SD","TN","TX","UT","VA","VT","WA","WI","WV","WY",
];

// Same filters as the seed (config.filters + minAreaParam).
const FILTERS = {
  propertyType: "commercial",
  permitTags: ["electrical", "new_construction"],
  minAreaSqft: 10001,
  minAreaParam: "min_total_building_area",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function mapPermit(p: any) {
  const addr = p.address ?? {};
  const ll = Array.isArray(addr.latlng) ? addr.latlng : [];
  return {
    shovels_permit_id: p.id,
    permit_no: p.number ?? null,
    permit_type: p.type ?? null,
    permit_subtype: p.subtype ?? null,
    status: p.status ?? null,
    description: p.description ?? null,
    file_date: p.file_date ?? null,
    issue_date: p.issue_date ?? null,
    final_date: p.final_date ?? null,
    start_date: p.start_date ?? null,
    end_date: p.end_date ?? null,
    job_value: p.job_value ?? null,
    building_area_sqft: p.property_building_area ?? null,
    property_type: p.property_type ?? null,
    tags: Array.isArray(p.tags) ? p.tags : null,
    street_no: addr.street_no ?? null,
    street: addr.street ?? null,
    city: addr.city ?? null,
    county: addr.county ?? null,
    state: addr.state ?? null,
    zipcode: addr.zip_code ?? null,
    latitude: ll.length ? ll[0] : null,
    longitude: ll.length ? ll[1] : null,
    geo_id: p.geo_ids?.jurisdiction_id ?? null,
    raw: p,
  };
}

async function postSlack(text: string) {
  // Mirrors the existing webhook pattern (app.slack_webhook_url). SLACK_WEBHOOK_URL is optional;
  // when unset this is a no-op, exactly like jw-facility-health-check when the setting is empty.
  const hook = Deno.env.get("SLACK_WEBHOOK_URL");
  if (!hook) return;
  try {
    await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (_) { /* best-effort */ }
}

async function logHealth(sb: any, started: string, success: boolean, found: number, notes: string) {
  await sb.from("automation_health_log").insert({
    auto_id: "FAR-263", crawler_id: "shovels-refresh_v1",
    run_started_at: started, run_completed_at: new Date().toISOString(),
    artifacts_found: found, artifacts_new: found, artifacts_duped: 0,
    success, errors: [], notes,
  });
}

Deno.serve(async (req: Request) => {
  const runStarted = new Date().toISOString();
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const provided = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const allowed = new Set([serviceKey, CRON_TOKEN, CRON_TOKEN_ENV].filter(Boolean) as string[]);
  if (!allowed.has(provided)) return json({ error: "Unauthorized" }, 401);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
  const key = Deno.env.get("SHOVELS_API_KEY") ?? Deno.env.get("SHOVELS_KEY");
  const runKey = `shovels-refresh-${runStarted.slice(0, 10)}`;

  // Last known credit balance (ledger), newest run that actually recorded a balance.
  // Skipped runs (no_key / low_balance) carry a null balance and must not shadow the ledger.
  const { data: lastRun } = await sb
    .from("jw_shovels_ingest_runs")
    .select("credits_remaining_last")
    .not("credits_remaining_last", "is", null)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const lastRemaining: number | null = lastRun?.credits_remaining_last ?? null;

  // D3: key is Supabase-secrets-only. Absent -> clean skip (harmless before provisioning).
  if (!key) {
    await logHealth(sb, runStarted, false, 0, "SHOVELS_API_KEY absent in Supabase secrets — refresh skipped (FAR-264 key provisioning pending)");
    await sb.from("jw_shovels_ingest_runs").insert({
      run_key: `${runKey}-skipped`, status: "skipped", started_at: runStarted,
      finished_at: new Date().toISOString(), config: { reason: "no_shovels_key" }, errors: [],
      notes: "skipped: SHOVELS_API_KEY not set in Supabase secrets",
    });
    return json({ skipped: true, reason: "no_shovels_key" });
  }

  // D1: below-cap balance -> skip + alert, never auto-purchase.
  if (lastRemaining != null && lastRemaining < PER_RUN_CREDIT_CAP) {
    await postSlack(`⚠️ Shovels refresh skipped: credit balance ${lastRemaining} < ${PER_RUN_CREDIT_CAP} per-run cap. Do NOT purchase credits without Myke's sign-off (FAR-263 / D1).`);
    await logHealth(sb, runStarted, false, 0, `low balance ${lastRemaining} < cap ${PER_RUN_CREDIT_CAP}; run skipped`);
    await sb.from("jw_shovels_ingest_runs").insert({
      run_key: `${runKey}-lowbal`, status: "skipped", started_at: runStarted,
      finished_at: new Date().toISOString(), credits_remaining_last: lastRemaining,
      config: { reason: "low_balance" }, errors: [], notes: "skipped: low credit balance",
    });
    return json({ skipped: true, reason: "low_balance", remaining: lastRemaining });
  }

  // Rolling 60-day window (D9).
  const now = new Date();
  const permitTo = now.toISOString().slice(0, 10);
  const permitFrom = new Date(now.getTime() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);

  const config = {
    cap: PER_RUN_CREDIT_CAP, lookback_days: LOOKBACK_DAYS, states: STATES,
    filters: {
      permitFrom, permitTo, permitTags: FILTERS.permitTags,
      minAreaSqft: FILTERS.minAreaSqft, propertyType: FILTERS.propertyType,
    },
    minAreaParam: FILTERS.minAreaParam,
  };

  const { data: runRow, error: runErr } = await sb
    .from("jw_shovels_ingest_runs")
    .insert({ run_key: runKey, status: "running", started_at: runStarted, config, cursor_state: {}, errors: [] })
    .select("id")
    .single();
  if (runErr || !runRow) return json({ error: "run_insert_failed", detail: runErr?.message }, 500);
  const runId = runRow.id as string;

  let requested = 0, returned = 0, stored = 0, deduped = 0, capHit = false;
  const cursorState: Record<string, unknown> = {};
  const errors: unknown[] = [];

  for (const st of STATES) {
    if (returned >= PER_RUN_CREDIT_CAP) { capHit = true; cursorState[st] = { done: false, cursor: null, returned: 0, skipped: "cap" }; continue; }
    let cursor: string | null = null;
    let stReturned = 0;
    let done = false;
    while (!done) {
      if (returned >= PER_RUN_CREDIT_CAP) { capHit = true; break; }
      const size = Math.min(PAGE_SIZE, PER_RUN_CREDIT_CAP - returned);
      const params = new URLSearchParams({
        state: st, permit_from: permitFrom, permit_to: permitTo,
        property_type: FILTERS.propertyType, permit_tags: FILTERS.permitTags.join(","),
        [FILTERS.minAreaParam]: String(FILTERS.minAreaSqft), size: String(size),
      });
      if (cursor) params.set("cursor", cursor);
      requested += size;

      let resp: Response;
      try {
        resp = await fetch(`${SHOVELS_SEARCH}?${params}`, { headers: { "X-API-Key": key } });
      } catch (e) {
        errors.push({ at: new Date().toISOString(), state: st, message: `fetch failed: ${e instanceof Error ? e.message : String(e)}` });
        break;
      }
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        errors.push({ at: new Date().toISOString(), state: st, message: `shovels ${resp.status}: ${body.slice(0, 300)}` });
        break;
      }
      const body = await resp.json();
      // Envelope-tolerant: items under items/data/results, cursor under next_cursor/cursor/nextCursor.
      const items: any[] = body.items ?? body.data ?? body.results ?? [];
      const nextCursor: string | null = body.next_cursor ?? body.cursor ?? body.nextCursor ?? null;
      const batch = items.length;
      returned += batch;
      stReturned += batch;

      if (batch > 0) {
        const rows = [];
        for (const p of items) {
          rows.push({ ...mapPermit(p), content_hash: await sha256Hex(JSON.stringify(p)) });
        }
        const { data: up, error: upErr } = await sb.rpc("jw_shovels_ingest_upsert", { p_rows: rows, p_run_id: runId });
        if (upErr) errors.push({ at: new Date().toISOString(), state: st, message: `upsert: ${upErr.message}` });
        else { stored += up?.stored ?? 0; deduped += up?.deduped ?? 0; }
      }

      cursor = nextCursor;
      done = !nextCursor || batch === 0;
    }
    cursorState[st] = { done, cursor: capHit ? cursor : null, returned: stReturned };
    if (capHit) break;
  }

  // Resolve jurisdictions for freshly-ingested rows, then run the authoritative apply chain.
  let matchRes: unknown = null, applyRes: unknown = null;
  try {
    const { data: mr } = await sb.rpc("jw_shovels_match_permits", { p_run_id: runId });
    matchRes = mr;
  } catch (e) { errors.push({ at: new Date().toISOString(), message: `match: ${e instanceof Error ? e.message : String(e)}` }); }

  if (stored > 0 || deduped > 0) {
    try {
      const { data: ar } = await sb.rpc("jw_shovels_apply_chain", { p_run_id: runId, p_trigger: "shovels-refresh" });
      applyRes = ar;
    } catch (e) { errors.push({ at: new Date().toISOString(), message: `apply_chain: ${e instanceof Error ? e.message : String(e)}` }); }
  }

  // Unmatched count for this run.
  const { count: unmatchedThisRun } = await sb
    .from("shovels_permit_snapshots")
    .select("*", { count: "exact", head: true })
    .eq("ingest_run_id", runId)
    .in("jurisdiction_match_status", ["unmatched", "unmatched_ambiguous"]);

  const creditsConsumed = returned; // credits ≈ permits returned (seed precedent)
  const creditsRemaining = lastRemaining != null ? lastRemaining - creditsConsumed : null;

  await sb.from("jw_shovels_ingest_runs").update({
    status: errors.length ? "partial" : "success",
    finished_at: new Date().toISOString(),
    permits_requested: requested, permits_returned: returned, permits_stored: stored,
    permits_deduped: deduped, permits_unmatched: unmatchedThisRun ?? 0,
    credits_consumed: creditsConsumed, credits_remaining_last: creditsRemaining,
    cursor_state: cursorState, errors,
    notes: capHit ? "cap_hit: true" : null,
    updated_at: new Date().toISOString(),
  }).eq("id", runId);

  await logHealth(sb, runStarted, errors.length === 0 && returned >= 0, stored,
    `shovels-refresh: requested=${requested} returned=${returned} stored=${stored} deduped=${deduped} cap_hit=${capHit} remaining=${creditsRemaining}`);

  // Zero rows written on a run that DID execute is a health signal (healthcheck cron also covers this).
  if (returned === 0 && errors.length === 0) {
    await postSlack(`⚠️ Shovels refresh wrote 0 rows for window ${permitFrom}..${permitTo}. Check Shovels coverage / filters.`);
  }

  return json({
    ok: errors.length === 0, run_id: runId, window: { permitFrom, permitTo },
    requested, returned, stored, deduped, cap_hit: capHit,
    credits_consumed: creditsConsumed, credits_remaining: creditsRemaining,
    match: matchRes, apply: applyRes, errors,
  });
});
