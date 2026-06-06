# CLAUDE.md — Jurisdiction Watch (FAR-27)

This repo is **already scaffolded** (Next.js App Router + the JW feature components + the backend migrations). Do **not** run `create-next-app`. Run `npm install` and build from here. Full phased plan: `docs/BUILD-PLAN.md`.

## Live resources — consume, do NOT rebuild
Supabase project `ycadmmngkdhvpcsrcuaq`:
- Tables: `jurisdictions`, `jps_history`, `jurisdiction_signals`, `briefing_links`, `jw_plans`, `jw_watchlists`, `jw_watchlist_items`, `token_transactions` (all in `supabase/migrations/`).
- RPCs: `jw_apply_posture_run` (only sanctioned posture change), `jw_unlock_jurisdiction` (atomic/idempotent), `jw_token_balance`, `jw_grant_tokens` (100/block).
- Edge fn `jurisdiction-watch-api` (v2) — base in `NEXT_PUBLIC_JW_API`. Pull its source with `supabase functions download jurisdiction-watch-api --project-ref ycadmmngkdhvpcsrcuaq`.
- Seed: 20 jurisdictions, 18 active briefings + 2 in the Integrity Queue.

## Invariants — never violate
1. Posture (`current_tier`/`current_score`) changes ONLY via `jw_apply_posture_run()`. A DB trigger rejects manual edits — never work around it.
2. JPS **weighting model/formula is never sent to the client.** Component values (1–5) may be revealed (after unlock); weights may not.
3. Token spend goes ONLY through `jw_unlock_jurisdiction()` (atomic, idempotent). The client cache (`useTokenSession`) is UX only — never the financial guard.
4. Plan names/pricing live in the `jw_plans` table (provisional). Do NOT hardcode tier names.
5. Tokens: blocks of 100, no rollover (calendar-month cycle), unlocks last 30 days.
6. Auth is Supabase magic-link + the existing `subscribers` table. Do NOT add Clerk.
7. Map is `react-simple-maps` + topojson (no Mapbox/Figma; OA-030 is a later skin).

## Build order (verify each gate before moving on — details in docs/BUILD-PLAN.md)
1. `npm install`; confirm `/jurisdiction-watch` renders (map + leaderboard + filters + locked detail).
2. Add `GET /balance` to the edge fn; wire the header token meter.
3. Stripe 100-block checkout + idempotent webhook → `jw_grant_tokens`.
4. Supabase magic-link auth; pass real `subscriberId` into `JurisdictionWatchCanvas`.
5. (Optional) jurisdiction selector → `jw_watchlist_items`.
6. `jurisdiction-scorer` edge fn: retrieve → score-with-citations → stage in `jw_posture_proposals` → approve → `jw_apply_posture_run`; hysteresis; weekly `pg_cron`. Depends on FAR-29 enrichment + weight lock.
7. Tests + deploy (Vercel app, Supabase functions); update Jira FAR-27.

## Commands
- Dev: `npm run dev` → http://localhost:3000/jurisdiction-watch
- Deploy a function: `supabase functions deploy <name> --project-ref ycadmmngkdhvpcsrcuaq --no-verify-jwt`
- Apply a new migration: `supabase db push` (after `supabase link --project-ref ycadmmngkdhvpcsrcuaq`)
