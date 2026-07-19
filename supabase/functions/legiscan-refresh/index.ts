// legiscan-refresh — CC-LEGISCAN-INGEST-1.0 / FAR-347
// Ingests data-center-related state legislation from the LegiScan free public
// tier (30,000 queries/month) and lands it idempotently in ref_legiscan_bills,
// keyed on LegiScan change_hash (L6). Feeds pfi legislative_activity_delta.
//
// Flow (matches intl-refresh: verify_jwt=false, no app.* GUCs):
//   1. auth gate (service-role key or cron token)
//   2. LEGISCAN_API_KEY absent  -> dry-run no-op run_log row, return (build gate:
//      no live API calls until the key lands in edge-function secrets)
//   3. prefetch state_abbr -> jurisdiction_id map (state-level only, L3/L9)
//   4. for each term (L7) x year: paginate getSearchRaw&state=ALL -> {bill_id,
//      change_hash, relevance}; dedupe by bill_id across terms
//   5. compare change_hash to stored value; getBill ONLY for new/changed (D1)
//   6. upsert full rows; touch last_seen_at/last_run_id for unchanged
//   7. write run_log with query accounting; abort at 25,000 MTD (L4 safety margin
//      under the 30k ceiling)
//
// Query cost: 1 per getSearchRaw page + 1 per getBill. Weekly steady state targets
// < 500 queries; backfill <= 5,000 (L4).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// Same cron token the intl-refresh family accepts; vault 'cron_caller_token'
// decrypts to this, so cron_http_post(..., 'cron_caller_token', ...) passes.
const CRON_TOKEN = "fcron_9mK3pX7qR2vN8wYz4tB6sL1dH5jG0aE";

const API_BASE = "https://api.legiscan.com/";
const DEFAULT_TERMS = ["data center", "data centers", "datacenter"]; // L7
const DEFAULT_YEARS: Array<number | string> = [2]; // 2 = current sessions (LegiScan year code)
const MONTHLY_ABORT_CEILING = 25_000; // L4 safety margin under the 30k free-tier cap
const MAX_PAGES_PER_QUERY = 100; // 50 results/page -> 5,000 results/term-year guard
const RESULTS_PER_PAGE = 50;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

function authorized(req: Request): boolean {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const provided = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  return provided === serviceKey || provided === CRON_TOKEN;
}

function sbClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

// LegiScan numeric progress status -> label (free-tier getBill `status`).
const STATUS_LABELS: Record<string, string> = {
  "1": "Introduced", "2": "Engrossed", "3": "Enrolled",
  "4": "Passed", "5": "Vetoed", "6": "Failed",
};

async function fetchJson(url: string, tries = 3, timeoutMs = 60000): Promise<any> {
  let lastErr: unknown;
  for (let a = 0; a < tries; a++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { "User-Agent": "FaradayIntelligence-LegiScan/1.0 (data pipeline; contact: ops@faraday-intelligence.ai)" },
      });
      clearTimeout(t);
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 2000 * (a + 1)));
  }
  throw lastErr;
}

function apiUrl(key: string, op: string, params: Record<string, string | number>): string {
  const u = new URL(API_BASE);
  u.searchParams.set("key", key);
  u.searchParams.set("op", op);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.toString();
}

// Raised to abort the run cleanly when the monthly budget guard trips.
class BudgetExceeded extends Error {}

serve(async (req: Request) => {
  if (!authorized(req)) return json({ error: "Unauthorized" }, 401);

  const sb = sbClient();
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body from cron */ }

  const terms = Array.isArray(body.terms) && body.terms.length ? body.terms as string[] : DEFAULT_TERMS;
  const years = Array.isArray(body.years) && body.years.length ? body.years as Array<number | string> : DEFAULT_YEARS;
  const maxBills = typeof body.max_bills === "number" ? body.max_bills as number : Infinity;

  const KEY = Deno.env.get("LEGISCAN_API_KEY") ?? "";
  const dryRun = body.dry_run === true || !KEY;

  // Month-to-date query total (L4), summed over the current UTC calendar month.
  let mtdStart = 0;
  {
    const { data } = await sb
      .from("legiscan_run_log")
      .select("queries_used, started_at");
    if (Array.isArray(data)) {
      const now = new Date();
      mtdStart = data
        .filter((r: any) => {
          const d = new Date(r.started_at);
          return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
        })
        .reduce((s: number, r: any) => s + (r.queries_used ?? 0), 0);
    }
  }

  // Open a run_log row.
  const { data: runRow, error: runErr } = await sb
    .from("legiscan_run_log")
    .insert({ status: dryRun ? "dry_run" : "running" })
    .select("run_id")
    .single();
  if (runErr || !runRow) return json({ error: `run_log insert failed: ${runErr?.message}` }, 500);
  const runId = runRow.run_id as number;

  // --- Dry-run gate: no live API calls until LEGISCAN_API_KEY lands (I4) -------
  if (dryRun) {
    await sb.from("legiscan_run_log").update({
      finished_at: new Date().toISOString(),
      status: KEY ? "dry_run" : "skipped_no_key",
      month_to_date_queries: mtdStart,
      error: KEY ? "dry_run requested" : "LEGISCAN_API_KEY not set in edge secrets",
    }).eq("run_id", runId);
    return json({
      ok: true, dry_run: true, run_id: runId, reason: KEY ? "dry_run requested" : "no_api_key",
      message: "Built but not executed — pipeline wired; awaiting LEGISCAN_API_KEY in edge secrets.",
      terms, years, month_to_date_queries: mtdStart,
    });
  }

  // --- Live path --------------------------------------------------------------
  let queries = 0;
  const guard = () => {
    if (mtdStart + queries + 1 > MONTHLY_ABORT_CEILING) {
      throw new BudgetExceeded(`monthly budget guard: MTD ${mtdStart} + run ${queries} would exceed ${MONTHLY_ABORT_CEILING}`);
    }
  };

  try {
    // state_abbr -> jurisdiction_id (state-level only)
    const { data: jur, error: jErr } = await sb
      .from("jurisdictions").select("id, state_abbr").eq("level", "state");
    if (jErr) throw new Error(`jurisdictions load: ${jErr.message}`);
    const stateMap = new Map<string, string>();
    for (const r of jur ?? []) if (r.state_abbr) stateMap.set(String(r.state_abbr).toUpperCase(), r.id);

    // 1) getSearchRaw across terms x years, dedupe by bill_id.
    //    seen: bill_id -> { change_hash, relevance }
    const seen = new Map<number, { change_hash: string; relevance: number }>();
    for (const term of terms) {
      for (const year of years) {
        for (let page = 1; page <= MAX_PAGES_PER_QUERY; page++) {
          guard();
          const data = await fetchJson(apiUrl(KEY, "getSearchRaw", { state: "ALL", query: term, year, page }));
          queries++;
          if (data?.status !== "OK" || !data?.searchresult) {
            // LegiScan surfaces over-limit / errors here; stop this term-year.
            break;
          }
          const results = data.searchresult.results ?? [];
          for (const r of results) {
            const id = Number(r.bill_id);
            if (!Number.isFinite(id)) continue;
            const prev = seen.get(id);
            const rel = Number(r.relevance ?? 0);
            // keep the highest relevance across terms
            if (!prev || rel > prev.relevance) seen.set(id, { change_hash: String(r.change_hash ?? ""), relevance: rel });
          }
          const pageTotal = Number(data.searchresult.summary?.page_total ?? 1);
          if (results.length < RESULTS_PER_PAGE || page >= pageTotal) break;
        }
      }
    }

    const billIds = [...seen.keys()];

    // 2) Existing change_hash for the seen bills.
    const existing = new Map<number, string>();
    for (let i = 0; i < billIds.length; i += 500) {
      const chunk = billIds.slice(i, i + 500);
      const { data, error } = await sb
        .from("ref_legiscan_bills").select("bill_id, change_hash").in("bill_id", chunk);
      if (error) throw new Error(`existing hash load: ${error.message}`);
      for (const r of data ?? []) existing.set(Number(r.bill_id), r.change_hash ?? "");
    }

    // 3) Split into new/changed (need getBill) vs unchanged (touch only).
    const toFetch: number[] = [];
    const unchanged: number[] = [];
    let newCount = 0, changedCount = 0;
    for (const id of billIds) {
      const cur = seen.get(id)!.change_hash;
      if (!existing.has(id)) { toFetch.push(id); newCount++; }
      else if (existing.get(id) !== cur) { toFetch.push(id); changedCount++; }
      else unchanged.push(id);
    }

    // 4) getBill for new/changed -> full rows -> upsert.
    const nowIso = new Date().toISOString();
    const rows: any[] = [];
    let fetched = 0;
    for (const id of toFetch) {
      if (fetched >= maxBills) break;
      guard();
      const data = await fetchJson(apiUrl(KEY, "getBill", { id }));
      queries++;
      if (data?.status !== "OK" || !data?.bill) continue;
      const b = data.bill;
      const state = String(b.state ?? "").toUpperCase();
      const history = Array.isArray(b.history) ? b.history : [];
      const lastH = history.length ? history[history.length - 1] : null;
      rows.push({
        bill_id: Number(b.bill_id),
        state_abbr: state,
        jurisdiction_id: stateMap.get(state) ?? null,
        bill_number: b.bill_number ?? null,
        title: b.title ?? null,
        description: b.description ?? null,
        status: STATUS_LABELS[String(b.status)] ?? (b.status != null ? String(b.status) : null),
        status_date: b.status_date || null,
        last_action: lastH?.action ?? null,
        last_action_date: (lastH?.date || b.status_date) || null,
        session_id: b.session?.session_id ?? b.session_id ?? null,
        session_name: b.session?.session_name ?? null,
        url: b.url ?? null,
        state_url: b.state_link ?? null,
        change_hash: b.change_hash ?? seen.get(id)!.change_hash,
        search_relevance: seen.get(id)!.relevance,
        last_seen_at: nowIso,
        last_run_id: runId,
      });
      fetched++;
    }

    // upsert full rows (omit first_seen_at so it is preserved on update)
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await sb
        .from("ref_legiscan_bills").upsert(rows.slice(i, i + 200), { onConflict: "bill_id" });
      if (error) throw new Error(`upsert: ${error.message}`);
    }

    // touch unchanged
    for (let i = 0; i < unchanged.length; i += 500) {
      const chunk = unchanged.slice(i, i + 500);
      const { error } = await sb
        .from("ref_legiscan_bills")
        .update({ last_seen_at: nowIso, last_run_id: runId })
        .in("bill_id", chunk);
      if (error) throw new Error(`touch unchanged: ${error.message}`);
    }

    await sb.from("legiscan_run_log").update({
      finished_at: nowIso,
      queries_used: queries,
      bills_seen: billIds.length,
      bills_new: newCount,
      bills_changed: changedCount,
      month_to_date_queries: mtdStart + queries,
      status: "success",
    }).eq("run_id", runId);

    return json({
      ok: true, run_id: runId, queries_used: queries,
      bills_seen: billIds.length, bills_new: newCount, bills_changed: changedCount,
      bills_upserted: rows.length, month_to_date_queries: mtdStart + queries,
    });
  } catch (e) {
    const aborted = e instanceof BudgetExceeded;
    await sb.from("legiscan_run_log").update({
      finished_at: new Date().toISOString(),
      queries_used: queries,
      month_to_date_queries: mtdStart + queries,
      status: aborted ? "aborted_budget" : "error",
      error: String(e),
    }).eq("run_id", runId);
    return json({ ok: false, run_id: runId, error: String(e), queries_used: queries }, aborted ? 200 : 500);
  }
});
