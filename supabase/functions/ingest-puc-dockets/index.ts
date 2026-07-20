// ingest-puc-dockets — CC-INGEST-PUC-DOCKETS-1.0 (FAR-353) — AUTO-188 (provisional)
// Three-stage state-PUC ingestion: puc_dockets → puc_filings → puc_signals.
// FAR-353 remediation (CC-PUC-DOCKETS-REMEDIATION-1.0): D1 docket filed_date is
// reconciled from the earliest filing on record after each state run; the VA
// month-window cap is lifted for deep backfill; signal types outside the DB
// CHECK are skipped (see puc-pure ALLOWED_SIGNAL_TYPES) so one bad keyword rule
// can no longer abort a whole run. Historical backfill is driven as chunked
// mode:'run' calls with explicit from/to (I5) — not a new cron.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  classifyDcRelevance,
  docketHashBasis,
  extractSignals,
  filingHashBasis,
  inferDocketType,
  type KeywordRule,
  mapVaDailyFiling,
  monthsInWindow,
  normalizeText,
  parseTxDocketRows,
  parseTxFilingRows,
  parseTxRecordCount,
  signalHashBasis,
  txNextPageHref,
  type VaDailyFiling,
  wordCount,
} from "./puc-pure.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_TOKEN = "fcron_9mK3pX7qR2vN8wYz4tB6sL1dH5jG0aE"; // house token (intl pattern)

const AUTO_ID = "AUTO-188";
const CRAWLER_ID = "ingest-puc-dockets_v1.0";
const UA = "FaradayIntelligence-Research/1.0 (contact: ops@faraday-intelligence.ai)";

const TX_BASE = "https://interchange.puc.texas.gov";
const VA_API = "https://www.scc.virginia.gov/DocketSearchAPI/breeze/DailyFilings/GetAllDailyFilings";

function authorized(req: Request): boolean {
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return (provided !== "" && provided === SERVICE_ROLE) || provided === CRON_TOKEN;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 1), { status, headers: { "content-type": "application/json" } });

async function sha256(basis: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(basis));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/json;q=0.9" } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return await res.text();
}

const isoToday = () => new Date().toISOString().slice(0, 10);
const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const usDate = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
};

type Sb = ReturnType<typeof createClient>;

interface SourceRow {
  state_abbr: string;
  state_fips: string;
  status: string;
  cursor: Record<string, unknown>;
}

interface StateRunResult {
  state: string;
  window: { from: string; to: string };
  dockets_seen: number;
  dockets_upserted: number;
  filings_upserted: number;
  filings_dc_relevant: number;
  signals_inserted: number;
  requests: number;
  truncated: boolean;
  resolve?: unknown;
  earliest_filed?: string | null;
  error?: string;
}

interface NormalizedDocket {
  docket_number: string;
  docket_title: string | null;
  utility_name: string | null;
  source_url: string;
  filed_date?: string | null;
}

interface NormalizedFiling {
  docket_number: string;
  source_url: string;
  doc_title: string | null;
  filing_type: string | null;
  filing_party: string | null;
  filed_date: string | null;
  raw_text: string;
}

async function upsertDockets(
  sb: Sb,
  stateFips: string,
  sourceKey: string,
  dockets: NormalizedDocket[],
  rules: KeywordRule[],
): Promise<{ idByNumber: Map<string, string>; dcByNumber: Map<string, boolean>; upserted: number }> {
  const idByNumber = new Map<string, string>();
  const dcByNumber = new Map<string, boolean>();
  if (dockets.length === 0) return { idByNumber, dcByNumber, upserted: 0 };

  const numbers = dockets.map((d) => d.docket_number);
  const { data: existing, error: exErr } = await sb
    .from("puc_dockets")
    .select("id, docket_number, content_hash, dc_relevant")
    .eq("state_fips", stateFips)
    .in("docket_number", numbers);
  if (exErr) throw new Error(`select puc_dockets: ${exErr.message}`);
  const existingByNumber = new Map((existing ?? []).map((r) => [r.docket_number as string, r]));

  let upserted = 0;
  for (const d of dockets) {
    const title = d.docket_title ?? "";
    const dc = classifyDcRelevance(`${title} ${d.utility_name ?? ""}`, rules).relevant;
    const docketType = inferDocketType(title);
    const hash = await sha256(docketHashBasis({
      state_fips: stateFips,
      docket_number: d.docket_number,
      docket_title: title,
      utility_name: d.utility_name,
      docket_type: docketType,
    }));
    const prior = existingByNumber.get(d.docket_number);
    const dcFinal = dc || (prior?.dc_relevant as boolean ?? false);
    dcByNumber.set(d.docket_number, dcFinal);

    if (prior && prior.content_hash === hash && (prior.dc_relevant as boolean) === dcFinal) {
      idByNumber.set(d.docket_number, prior.id as string);
      await sb.from("puc_dockets").update({ last_seen_at: new Date().toISOString() }).eq("id", prior.id as string);
      continue;
    }
    const { data: up, error: upErr } = await sb
      .from("puc_dockets")
      .upsert({
        state_fips: stateFips,
        docket_number: d.docket_number,
        docket_title: title || null,
        docket_type: docketType,
        utility_name: d.utility_name,
        filed_date: d.filed_date ?? undefined,
        dc_relevant: dcFinal,
        source_url: d.source_url,
        content_hash: hash,
        source_key: sourceKey,
        last_seen_at: new Date().toISOString(),
        last_updated: isoToday(),
      }, { onConflict: "state_fips,docket_number" })
      .select("id, docket_number")
      .single();
    if (upErr) throw new Error(`upsert puc_dockets ${d.docket_number}: ${upErr.message}`);
    idByNumber.set(d.docket_number, up.id as string);
    upserted += 1;
  }
  return { idByNumber, dcByNumber, upserted };
}

async function upsertFilingsAndSignals(
  sb: Sb,
  stateFips: string,
  filings: NormalizedFiling[],
  docketIds: Map<string, string>,
  docketDc: Map<string, boolean>,
  docketTitles: Map<string, string>,
  rules: KeywordRule[],
): Promise<{ filings_upserted: number; filings_dc_relevant: number; signals_inserted: number }> {
  let filingsUpserted = 0, filingsDc = 0, signalsInserted = 0;

  for (const f of filings) {
    const docketId = docketIds.get(f.docket_number);
    if (!docketId) continue;
    const rawText = normalizeText(f.raw_text);
    const ownDc = classifyDcRelevance(rawText, rules).relevant;
    const dcRelevant = ownDc || (docketDc.get(f.docket_number) ?? false);
    const hash = await sha256(filingHashBasis({
      state_fips: stateFips,
      docket_number: f.docket_number,
      source_url: f.source_url,
      doc_title: f.doc_title,
      filed_date: f.filed_date,
    }));

    const { data: up, error: upErr } = await sb
      .from("puc_filings")
      .upsert({
        docket_id: docketId,
        state_fips: stateFips,
        filing_type: f.filing_type,
        filing_party: f.filing_party,
        filed_date: f.filed_date ?? undefined,
        doc_title: f.doc_title,
        source_url: f.source_url,
        raw_text: rawText || null,
        word_count: wordCount(rawText),
        dc_relevant: dcRelevant,
        content_hash: hash,
      }, { onConflict: "docket_id,source_url" })
      .select("id")
      .single();
    if (upErr) throw new Error(`upsert puc_filings ${f.source_url}: ${upErr.message}`);
    filingsUpserted += 1;
    if (dcRelevant) filingsDc += 1;

    const context = `${f.doc_title ?? ""} ${rawText} ${docketTitles.get(f.docket_number) ?? ""}`;
    const signals = extractSignals(context, rules);
    for (const s of signals) {
      const sHash = await sha256(signalHashBasis({
        filing_source_url: f.source_url,
        signal_type: s.signal_type,
        keyword: s.keyword,
      }));
      const { error: sErr } = await sb.from("puc_signals").upsert({
        filing_id: up.id as string,
        state_fips: stateFips,
        signal_type: s.signal_type,
        signal_text: s.signal_text,
        jps_dimension: s.jps_dimension,
        sentiment_score: s.sentiment_score,
        magnitude_mw: s.magnitude_mw,
        keyword: s.keyword,
        content_hash: sHash,
        idf_ingested: false,
      }, { onConflict: "filing_id,content_hash", ignoreDuplicates: true });
      if (sErr) throw new Error(`insert puc_signals: ${sErr.message}`);
    }
    signalsInserted += signals.length;
  }
  return { filings_upserted: filingsUpserted, filings_dc_relevant: filingsDc, signals_inserted: signalsInserted };
}

async function runTexas(
  sb: Sb,
  src: SourceRow,
  rules: KeywordRule[],
  fromIso: string,
  toIso: string,
  maxDockets: number,
  maxPages: number,
): Promise<StateRunResult> {
  const res: StateRunResult = {
    state: "TX", window: { from: fromIso, to: toIso },
    dockets_seen: 0, dockets_upserted: 0, filings_upserted: 0,
    filings_dc_relevant: 0, signals_inserted: 0, requests: 0, truncated: false,
  };

  let url: string | null =
    `${TX_BASE}/search/search/?UtilityType=E&ItemMatch=1&DocumentType=ALL` +
    `&DateFiledFrom=${encodeURIComponent(usDate(fromIso))}&DateFiledTo=${encodeURIComponent(usDate(toIso))}`;
  const docketRows: ReturnType<typeof parseTxDocketRows> = [];
  let pages = 0;
  while (url && pages < maxPages) {
    const html = await fetchText(url);
    res.requests += 1;
    pages += 1;
    docketRows.push(...parseTxDocketRows(html));
    if (pages === 1) res.dockets_seen = parseTxRecordCount(html) ?? docketRows.length;
    url = txNextPageHref(html, TX_BASE);
  }
  if (url) res.truncated = true;

  const work = docketRows.slice(0, maxDockets);
  if (docketRows.length > maxDockets) res.truncated = true;

  const dockets: NormalizedDocket[] = work.map((r) => ({
    docket_number: r.controlNumber,
    docket_title: r.caseStyle,
    utility_name: r.utilityName || null,
    source_url: `${TX_BASE}/search/filings/?ControlNumber=${r.controlNumber}`,
  }));
  const { idByNumber, dcByNumber, upserted } = await upsertDockets(sb, src.state_fips, "puc:tx", dockets, rules);
  res.dockets_upserted = upserted;
  const titles = new Map(dockets.map((d) => [d.docket_number, d.docket_title ?? ""]));

  const filings: NormalizedFiling[] = [];
  for (const r of work) {
    if (r.filingCountInWindow === 0) continue;
    let fUrl: string | null =
      `${TX_BASE}/search/filings/?ControlNumber=${r.controlNumber}&UtilityType=E&ItemMatch=1&DocumentType=ALL` +
      `&DateFiledFrom=${encodeURIComponent(usDate(fromIso))}&DateFiledTo=${encodeURIComponent(usDate(toIso))}`;
    let fPages = 0;
    while (fUrl && fPages < 3) {
      const html = await fetchText(fUrl);
      res.requests += 1;
      fPages += 1;
      for (const row of parseTxFilingRows(html, TX_BASE)) {
        if (!row.documentsUrl) continue;
        filings.push({
          docket_number: r.controlNumber,
          source_url: row.documentsUrl,
          doc_title: row.description || null,
          filing_type: row.filingType,
          filing_party: row.filingParty,
          filed_date: row.filedDate,
          raw_text: [row.description, row.filingParty ? `Party: ${row.filingParty}` : "", row.filingType ? `Type: ${row.filingType}` : ""].filter(Boolean).join(" | "),
        });
      }
      fUrl = txNextPageHref(html, TX_BASE);
    }
    if (fUrl) res.truncated = true;
  }

  const wrote = await upsertFilingsAndSignals(sb, src.state_fips, filings, idByNumber, dcByNumber, titles, rules);
  Object.assign(res, wrote);
  return res;
}

async function runVirginia(
  sb: Sb,
  src: SourceRow,
  rules: KeywordRule[],
  fromIso: string,
  toIso: string,
  maxDockets: number,
): Promise<StateRunResult> {
  const res: StateRunResult = {
    state: "VA", window: { from: fromIso, to: toIso },
    dockets_seen: 0, dockets_upserted: 0, filings_upserted: 0,
    filings_dc_relevant: 0, signals_inserted: 0, requests: 0, truncated: false,
  };

  const mapped: NonNullable<ReturnType<typeof mapVaDailyFiling>>[] = [];
  for (const { year, month } of monthsInWindow(fromIso, toIso)) {
    const url = `${VA_API}?$filter=${encodeURIComponent(`Year eq ${year} and Month eq ${month}`)}`;
    const body = await fetchText(url);
    res.requests += 1;
    const rows = JSON.parse(body) as VaDailyFiling[];
    for (const row of rows) {
      const m = mapVaDailyFiling(row);
      if (!m) continue;
      if (m.filed_date && (m.filed_date < fromIso || m.filed_date > toIso)) continue;
      mapped.push(m);
    }
  }

  const byDocket = new Map<string, typeof mapped>();
  for (const m of mapped) {
    const list = byDocket.get(m.docket_number) ?? [];
    list.push(m);
    byDocket.set(m.docket_number, list);
  }
  res.dockets_seen = byDocket.size;
  const docketNumbers = [...byDocket.keys()].slice(0, maxDockets);
  if (byDocket.size > docketNumbers.length) res.truncated = true;

  const dockets: NormalizedDocket[] = docketNumbers.map((n) => {
    const list = byDocket.get(n)!;
    return {
      docket_number: n,
      docket_title: list[0].utility_name,
      utility_name: list[0].utility_name,
      source_url: `https://www.scc.virginia.gov/docketsearch#/caseSearch/${encodeURIComponent(n)}`,
    };
  });
  const { idByNumber, dcByNumber, upserted } = await upsertDockets(sb, src.state_fips, "puc:va", dockets, rules);
  res.dockets_upserted = upserted;
  const titles = new Map(dockets.map((d) => [d.docket_number, d.docket_title ?? ""]));

  const filings: NormalizedFiling[] = docketNumbers.flatMap((n) =>
    byDocket.get(n)!.map((m) => ({
      docket_number: n,
      source_url: m.source_url,
      doc_title: m.doc_title,
      filing_type: null,
      filing_party: m.filing_party,
      filed_date: m.filed_date,
      raw_text: m.doc_title,
    }))
  );
  const wrote = await upsertFilingsAndSignals(sb, src.state_fips, filings, idByNumber, dcByNumber, titles, rules);
  Object.assign(res, wrote);
  return res;
}

async function probe(states: string[]): Promise<unknown[]> {
  const targets: Record<string, string> = {
    TX: `${TX_BASE}/`,
    VA: `${VA_API}?$filter=${encodeURIComponent("Year eq 2026 and Month eq 1")}`,
  };
  const out: unknown[] = [];
  for (const s of states) {
    const url = targets[s];
    if (!url) { out.push({ state: s, error: "no live adapter" }); continue; }
    try {
      const t0 = Date.now();
      const res = await fetch(url, { headers: { "user-agent": UA } });
      out.push({ state: s, url, status: res.status, ms: Date.now() - t0 });
    } catch (e) {
      out.push({ state: s, url, error: String(e) });
    }
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (!authorized(req)) return json({ error: "Unauthorized" }, 401);
  let payload: {
    mode?: string; states?: string[]; from?: string; to?: string;
    maxDockets?: number; maxPages?: number;
  };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "bad json body" }, 400);
  }
  const mode = payload.mode ?? "status";
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  if (mode === "status") {
    const { data: sources } = await sb.from("puc_sources")
      .select("state_abbr, state_fips, access_kind, status, cursor").order("state_abbr");
    const { count: dockets } = await sb.from("puc_dockets").select("id", { count: "exact", head: true });
    const { count: filings } = await sb.from("puc_filings").select("id", { count: "exact", head: true });
    const { count: signals } = await sb.from("puc_signals").select("id", { count: "exact", head: true });
    return json({ ok: true, totals: { dockets, filings, signals }, sources });
  }

  if (mode === "probe") {
    return json({ ok: true, results: await probe(payload.states ?? ["TX", "VA"]) });
  }

  if (mode !== "run") return json({ error: `unknown mode ${mode}` }, 400);

  const wanted = payload.states ?? ["TX", "VA"];
  const { data: srcRows, error: srcErr } = await sb.from("puc_sources")
    .select("state_abbr, state_fips, status, cursor")
    .in("state_abbr", wanted);
  if (srcErr) return json({ error: srcErr.message }, 500);

  const { data: kwRows, error: kwErr } = await sb.from("puc_keyword_map")
    .select("keyword, match_mode, category, signal_type, jps_dimension, sentiment")
    .eq("active", true);
  if (kwErr) return json({ error: kwErr.message }, 500);
  const rules = (kwRows ?? []) as unknown as KeywordRule[];

  const startedAt = new Date().toISOString();
  const results: StateRunResult[] = [];

  for (const src of (srcRows ?? []) as unknown as SourceRow[]) {
    if (src.status !== "live") {
      results.push({
        state: src.state_abbr, window: { from: "", to: "" },
        dockets_seen: 0, dockets_upserted: 0, filings_upserted: 0,
        filings_dc_relevant: 0, signals_inserted: 0, requests: 0, truncated: false,
        error: `source status is '${src.status}' — not live`,
      });
      continue;
    }
    const cursorTo = typeof src.cursor?.last_to === "string" ? src.cursor.last_to as string : null;
    const from = payload.from ?? (cursorTo ? new Date(new Date(cursorTo).getTime() - 3 * 86400000).toISOString().slice(0, 10) : isoDaysAgo(14));
    const to = payload.to ?? isoToday();
    const maxDockets = payload.maxDockets ?? 80;
    const maxPages = payload.maxPages ?? 5;

    try {
      const r = src.state_abbr === "TX"
        ? await runTexas(sb, src, rules, from, to, maxDockets, maxPages)
        : src.state_abbr === "VA"
        ? await runVirginia(sb, src, rules, from, to, maxDockets)
        : { state: src.state_abbr, window: { from, to }, dockets_seen: 0, dockets_upserted: 0, filings_upserted: 0, filings_dc_relevant: 0, signals_inserted: 0, requests: 0, truncated: false, error: "no adapter" } as StateRunResult;

      if (!r.error) {
        r.resolve = (await sb.rpc("puc_resolve_docket_jurisdictions", { p_state_abbr: src.state_abbr })).data;

        await sb.rpc("puc_reconcile_docket_filed_dates", { p_state_fips: src.state_fips });
        const { data: earliestRows } = await sb.from("puc_dockets")
          .select("filed_date").eq("state_fips", src.state_fips)
          .not("filed_date", "is", null).order("filed_date", { ascending: true }).limit(1);
        const earliestFiled = earliestRows && earliestRows.length ? earliestRows[0].filed_date as string : null;
        r.earliest_filed = earliestFiled;

        const prevTo = typeof src.cursor?.last_to === "string" ? src.cursor.last_to as string : null;
        const prevFrom = typeof src.cursor?.last_from === "string" ? src.cursor.last_from as string : null;
        const prevEarliest = typeof src.cursor?.earliest_filed === "string" ? src.cursor.earliest_filed as string : null;
        const newLastTo = prevTo && prevTo > to ? prevTo : to;
        const newLastFrom = prevFrom && prevFrom < from ? prevFrom : from;
        const newEarliest = [earliestFiled, prevEarliest].filter(Boolean).sort()[0] as string | undefined ?? null;

        await sb.from("puc_sources").update({
          cursor: {
            ...src.cursor,
            last_from: newLastFrom,
            last_to: newLastTo,
            last_run_at: new Date().toISOString(),
            earliest_filed: newEarliest,
          },
          updated_at: new Date().toISOString(),
        }).eq("state_abbr", src.state_abbr);
      }
      results.push(r);
    } catch (e) {
      results.push({
        state: src.state_abbr, window: { from, to },
        dockets_seen: 0, dockets_upserted: 0, filings_upserted: 0,
        filings_dc_relevant: 0, signals_inserted: 0, requests: 0, truncated: false,
        error: String(e),
      });
    }
  }

  const ok = results.every((r) => !r.error);
  const totals = results.reduce((a, r) => ({
    found: a.found + r.dockets_seen,
    fresh: a.fresh + r.filings_upserted,
  }), { found: 0, fresh: 0 });

  await sb.from("automation_health_log").insert({
    auto_id: AUTO_ID,
    crawler_id: CRAWLER_ID,
    run_started_at: startedAt,
    run_completed_at: new Date().toISOString(),
    artifacts_found: totals.found,
    artifacts_new: totals.fresh,
    success: ok,
    errors: ok ? null : results.filter((r) => r.error).map((r) => ({ state: r.state, error: r.error })),
    notes: `puc-dockets run ${JSON.stringify(results.map((r) => ({ s: r.state, d: r.dockets_upserted, f: r.filings_upserted, sig: r.signals_inserted })))}`.slice(0, 900),
  });

  return json({ ok, results });
});
