# Jurisdiction Watch (FAR-27)

Token-driven geographic intelligence storefront over the Jurisdiction Posture Score (JPS). Open discovery (map + leaderboard); token-gated depth (unlock a jurisdiction's 5 components). Backend is live in Supabase `ycadmmngkdhvpcsrcuaq`; this repo holds the Next.js front end, the backend migrations, and the Claude Code build plan.

## Layout
```
app/                         Next.js App Router (entry + /jurisdiction-watch page)
src/features/jurisdiction-watch/   the JW components (canvas, map, leaderboard, unlock, etc.)
supabase/migrations/         0001–0004 — the live schema, ledger, RPCs (version-controlled)
supabase/functions/jurisdiction-watch-api/   pull live source via `supabase functions download`
docs/BUILD-PLAN.md           phased Claude Code action plan
docs/REVISED-PLAN.md         architecture + the anti-sycophancy critique
CLAUDE.md                    context + invariants Claude Code reads first
```

## Local setup
```bash
cp .env.example .env.local        # fill in the __set_me__ values
npm install
npm run dev                       # http://localhost:3000/jurisdiction-watch
```
`NEXT_PUBLIC_JW_API` already points at the live edge function, so the map/leaderboard work immediately against real data.

## Launch the build with Claude Code
From the repo root:
```bash
cd jurisdiction-watch-repo
npm install
claude                            # starts Claude Code in this directory (reads CLAUDE.md automatically)
```
Then give it this kickoff prompt:
> Read CLAUDE.md and docs/BUILD-PLAN.md. Execute Phase 1, then stop at its Verify gate and show me the result. Respect every invariant in CLAUDE.md — especially: never change posture except via jw_apply_posture_run, and never expose JPS weights.

Continue phase by phase, e.g.:
> Phase 2: add GET /balance to the jurisdiction-watch-api edge function and wire the token meter. Verify, then stop.

### Headless / one-shot alternative
```bash
claude -p "Read CLAUDE.md and docs/BUILD-PLAN.md, then execute Phase 1 only and report the verify result." \
  --allowedTools "Edit,Bash,Read,Write"
```

### Recommended: connect the Supabase + Jira MCPs first
So Claude Code can run migrations, deploy functions, and update FAR-27 itself:
```bash
claude mcp add supabase -- npx -y @supabase/mcp-server-supabase --project-ref ycadmmngkdhvpcsrcuaq
# (add the Atlassian/Jira MCP similarly if you want it to post FAR-27 updates)
```

## Put it on GitHub
You push via the GitHub web UI, so the simplest path:
1. Create a new empty repo on github.com (e.g. `faraday-jurisdiction-watch`), no README.
2. Upload this folder's contents (drag-and-drop in the web UI "Add file → Upload files"), or if you prefer CLI:
   ```bash
   git init && git add . && git commit -m "Jurisdiction Watch MVP: backend live + FE + build plan"
   git branch -M main
   git remote add origin https://github.com/<you>/faraday-jurisdiction-watch.git
   git push -u origin main
   ```
3. Open the repo locally and run `claude` there (above) — or point Claude Code at the cloned repo.

## Guardrails (also in CLAUDE.md)
Posture only via `jw_apply_posture_run`; weights never leave the server; token spend only via `jw_unlock_jurisdiction`; tiers/pricing live in `jw_plans`; auth = Supabase magic-link (no Clerk); map = topojson (no Mapbox/Figma).
