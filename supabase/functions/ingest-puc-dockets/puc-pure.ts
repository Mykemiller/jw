// puc-pure.ts — CC-INGEST-PUC-DOCKETS-1.0 (FAR-353) pure parsing + classification
// logic for the ingest-puc-dockets edge function. DELIBERATELY Deno-free so the
// node test runner imports it directly (edge fn + tests share ONE source).

export type MatchMode = "word" | "phrase";

export interface KeywordRule {
  keyword: string;
  match_mode: MatchMode;
  category: "dc_relevance" | "signal";
  signal_type?: string | null;
  jps_dimension?: string | null;
  sentiment?: number | null;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function keywordRegex(rule: Pick<KeywordRule, "keyword" | "match_mode">): RegExp {
  const kw = escapeRegExp(rule.keyword.trim().toLowerCase()).replace(/\s+/g, "\\s+");
  return rule.match_mode === "word"
    ? new RegExp(`\\b${kw}\\b`, "i")
    : new RegExp(kw, "i");
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function wordCount(text: string): number {
  const t = normalizeText(text);
  return t === "" ? 0 : t.split(" ").length;
}

export function classifyDcRelevance(
  text: string,
  rules: KeywordRule[],
): { relevant: boolean; matched: string[] } {
  const t = normalizeText(text).toLowerCase();
  const matched: string[] = [];
  for (const r of rules) {
    if (r.category !== "dc_relevance") continue;
    if (keywordRegex(r).test(t)) matched.push(r.keyword);
  }
  return { relevant: matched.length > 0, matched };
}

// Allowed puc_signals.signal_type values — MUST mirror the puc_signals_signal_type_check
// DB constraint. Signal rules with a signal_type outside this set are SKIPPED: a CHECK
// violation on insert otherwise throws and aborts the whole state run (found under the
// FAR-353 remediation backfill — puc_keyword_map carried 'substation_construction' +
// 'transmission_project' rules absent from the CHECK). Capturing those grid-buildout
// signals needs BOTH this set and the DB CHECK expanded — a follow-up, not done here.
export const ALLOWED_SIGNAL_TYPES = new Set<string>([
  "capacity_constraint",
  "capacity_expansion",
  "rate_increase",
  "rate_decrease",
  "dc_tariff",
  "large_load_approval",
  "irp_favorable",
  "irp_unfavorable",
  "renewable_commitment",
  "moratorium_power",
]);

export interface ExtractedSignal {
  signal_type: string;
  jps_dimension: string | null;
  keyword: string;
  signal_text: string;
  sentiment_score: number | null;
  magnitude_mw: number | null;
}

export function extractMagnitudeMw(text: string): number | null {
  const m = /(\d[\d,]*(?:\.\d+)?)\s*(?:mw\b|megawatts?\b)/i.exec(text);
  if (!m) return null;
  const v = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(v) || v <= 0 || v > 100000) return null;
  return v;
}

export function snippetAround(text: string, index: number, radius = 180): string {
  const t = normalizeText(text);
  const start = Math.max(0, index - radius);
  const end = Math.min(t.length, index + radius);
  return `${start > 0 ? "…" : ""}${t.slice(start, end)}${end < t.length ? "…" : ""}`;
}

export function extractSignals(text: string, rules: KeywordRule[]): ExtractedSignal[] {
  const t = normalizeText(text);
  const lower = t.toLowerCase();
  const out: ExtractedSignal[] = [];
  const seen = new Set<string>();
  for (const r of rules) {
    if (r.category !== "signal" || !r.signal_type) continue;
    if (!ALLOWED_SIGNAL_TYPES.has(r.signal_type)) continue;
    const m = keywordRegex(r).exec(lower);
    if (!m) continue;
    const dedupeKey = `${r.signal_type}:${r.keyword.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const snippet = snippetAround(t, m.index);
    out.push({
      signal_type: r.signal_type,
      jps_dimension: r.jps_dimension ?? null,
      keyword: r.keyword,
      signal_text: snippet,
      sentiment_score: r.sentiment ?? null,
      magnitude_mw: extractMagnitudeMw(snippet),
    });
  }
  return out;
}

export function docketHashBasis(d: {
  state_fips: string;
  docket_number: string;
  docket_title?: string | null;
  utility_name?: string | null;
  docket_type?: string | null;
}): string {
  return ["puc-docket", d.state_fips, d.docket_number, d.docket_title ?? "", d.utility_name ?? "", d.docket_type ?? ""].join("|");
}

export function filingHashBasis(f: {
  state_fips: string;
  docket_number: string;
  source_url: string;
  doc_title?: string | null;
  filed_date?: string | null;
}): string {
  return ["puc-filing", f.state_fips, f.docket_number, f.source_url, f.doc_title ?? "", f.filed_date ?? ""].join("|");
}

export function signalHashBasis(s: {
  filing_source_url: string;
  signal_type: string;
  keyword: string;
}): string {
  return ["puc-signal", s.filing_source_url, s.signal_type, s.keyword.toLowerCase()].join("|");
}

const DOCKET_TYPE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(data\s*cent(?:er|re)s?|large\s+load)\b.*\btariff\b|\btariff\b.*\b(data\s*cent(?:er|re)s?|large\s+load)\b/i, "large_load_tariff"],
  [/\bintegrated\s+resource\s+plan|resource\s+plan(?:ning)?\b|\birp\b/i, "irp"],
  [/\binterconnect(?:ion)?\b/i, "interconnection"],
  [/\brate\s+case\b|\bbase\s+rates?\b|\brevenue\s+requirement\b|\bchange\s+rates\b|\brate\s+review\b/i, "rate_case"],
  [/\btransmission\b|\bccn\b|\bcertificate\s+of\s+convenience\s+and\s+necessity\b/i, "transmission"],
  [/\bmerger\b|\bacquisition\b|\bchange\s+(?:in|of)\s+control\b/i, "merger_acquisition"],
  [/\bsolar\b|\bwind\b|\brenewable\b|\bbattery\s+(?:energy\s+)?storage\b/i, "renewable_project"],
  [/\benvironmental\b|\bemissions?\b/i, "environmental"],
];

export function inferDocketType(title: string): string {
  const t = normalizeText(title);
  for (const [re, kind] of DOCKET_TYPE_PATTERNS) if (re.test(t)) return kind;
  return "other";
}

export interface TxDocketRow {
  controlNumber: string;
  filingCountInWindow: number;
  utilityName: string;
  caseStyle: string;
}

const stripTags = (html: string) =>
  normalizeText(
    html
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#32;/g, " ")
      .replace(/&nbsp;/g, " "),
  );

export function parseTxRecordCount(html: string): number | null {
  const m = /(\d[\d,]*)\s+record\(s\)\s+found/i.exec(html);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

export function parseTxDocketRows(html: string): TxDocketRow[] {
  const rows: TxDocketRow[] = [];
  const trRe = /<tr>([\s\S]*?)<\/tr>/gi;
  let tr: RegExpExecArray | null;
  while ((tr = trRe.exec(html)) !== null) {
    const cells = [...tr[1].matchAll(/<td>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    if (cells.length < 4) continue;
    const link = /\/search\/filings\/?\?[^"']*ControlNumber=(\d+)/i.exec(cells[0]);
    if (!link) continue;
    rows.push({
      controlNumber: link[1],
      filingCountInWindow: Number(stripTags(cells[1])) || 0,
      utilityName: stripTags(cells[2]),
      caseStyle: stripTags(cells[3]),
    });
  }
  return rows;
}

export interface TxFilingRow {
  itemNumber: string | null;
  filingType: string | null;
  filingParty: string | null;
  filedDate: string | null;
  description: string;
  documentsUrl: string | null;
}

export function txToIsoDate(us: string): string | null {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(us);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

export function parseTxFilingRows(html: string, baseUrl = "https://interchange.puc.texas.gov"): TxFilingRow[] {
  const rows: TxFilingRow[] = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr: RegExpExecArray | null;
  while ((tr = trRe.exec(html)) !== null) {
    const block = tr[1];
    const cells = [...block.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    if (cells.length < 5) continue;
    const link = /href="([^"]*\/search\/documents\/?\?[^"]*itemNumber=(\d+)[^"]*)"/i.exec(cells[0]);
    if (!link) continue;
    const url = link[1].replace(/&amp;/g, "&");
    rows.push({
      itemNumber: link[2],
      filedDate: txToIsoDate(stripTags(cells[1])),
      filingParty: stripTags(cells[2]) || null,
      filingType: stripTags(cells[3]) || null,
      description: stripTags(cells[4]),
      documentsUrl: url.startsWith("http") ? url : `${baseUrl}${url}`,
    });
  }
  return rows;
}

export function txNextPageHref(html: string, baseUrl = "https://interchange.puc.texas.gov"): string | null {
  const norm = html.replace(/&#32;/g, " ");
  const li = /<li class="[^"]*PagedList-skipToNext[^"]*">([\s\S]*?)<\/li>/i.exec(norm);
  if (!li) return null;
  const a = /href="([^"]+)"/i.exec(li[1]);
  if (!a) return null;
  const url = a[1].replace(/&amp;/g, "&");
  return url.startsWith("http") ? url : `${baseUrl}${url}`;
}

export interface VaDailyFiling {
  CaseNumber?: string | null;
  CaseName?: string | null;
  DocName?: string | null;
  DocID?: number | null;
  FileName?: string | null;
  DateFiled?: string | null;
}

export function vaIsUtilityCase(caseNumber: string | null | undefined): boolean {
  return typeof caseNumber === "string" && /^(PUR|PUE|PUA|PST)-/i.test(caseNumber.trim());
}

export interface VaMappedFiling {
  docket_number: string;
  utility_name: string | null;
  doc_title: string;
  filing_party: string | null;
  filed_date: string | null;
  source_url: string;
}

export function vaSplitParty(docName: string): { party: string | null; rest: string } {
  const i = docName.indexOf(" - ");
  if (i <= 0 || i > 120) return { party: null, rest: docName };
  const party = docName.slice(0, i).trim();
  if (party === "" || /^\d+$/.test(party)) return { party: null, rest: docName };
  return { party, rest: docName.slice(i + 3).trim() };
}

export function mapVaDailyFiling(row: VaDailyFiling): VaMappedFiling | null {
  const caseNo = (row.CaseNumber ?? "").trim();
  if (!vaIsUtilityCase(caseNo)) return null;
  const docName = normalizeText(row.DocName ?? "");
  const fileName = (row.FileName ?? "").trim();
  if (docName === "" && fileName === "") return null;
  const { party } = vaSplitParty(docName);
  const dateIso = row.DateFiled ? row.DateFiled.slice(0, 10) : null;
  const sourceUrl = fileName !== ""
    ? `https://scc.virginia.gov/docketsearch/DOCS/${encodeURIComponent(fileName)}`
    : `https://www.scc.virginia.gov/docketsearch#/doc/${row.DocID ?? "unknown"}`;
  return {
    docket_number: caseNo.toUpperCase(),
    utility_name: normalizeText(row.CaseName ?? "") || null,
    doc_title: docName || fileName,
    filing_party: party,
    filed_date: /^\d{4}-\d{2}-\d{2}$/.test(dateIso ?? "") ? dateIso : null,
    source_url: sourceUrl,
  };
}

export function monthsInWindow(fromIso: string, toIso: string): Array<{ year: number; month: number }> {
  const out: Array<{ year: number; month: number }> = [];
  const [fy, fm] = fromIso.split("-").map(Number);
  const [ty, tm] = toIso.split("-").map(Number);
  if (!fy || !fm || !ty || !tm) return out;
  let y = fy, m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    out.push({ year: y, month: m });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    if (out.length > 360) break;
  }
  return out;
}
