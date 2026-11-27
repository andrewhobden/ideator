# Idea Generator

Node 25 runs the TypeScript server directly; the frontend is vanilla ES modules.
No build step. Port 8300, loopback only.

## Commands

- `npm start`: start the app (`PORT`, loopback `HOST`, `DB_FILE` overrides).
- `npm test`: offline regression tests with fake Copilot transport and data sources.
- `npm run typecheck`: check TypeScript and SDK API compatibility without emitting files.
- `npm run calibrate [-- --model <Copilot catalog ID>]`: real judge against weak
  and strong references. Consumes Copilot usage. Re-run when the judge prompt,
  schema or model changes; report the actual result.

## Layout

- `server/copilot.ts`: the sole AI transport, SDK lifecycle, authentication,
  isolated structured sessions, and secret-free settings.
- `server/llm.ts`: prompts and schemas, including `JUDGE_SYSTEM`.
- `server/engine.ts`: operations, per-call request reservations, background judge
  queue (max 3), and per-board event bus.
- `server/autopilot.ts`: scheduler and pure `rateCheck()`.
- `server/leads.ts`: public source retrieval and Copilot-ranked leads.
- `server/project.ts`: Copilot project folders and `AGENTS.md`.
- `server/db.ts`: SQLite, reports, historical spend, durable request ledger.
- `server/app.ts`: local-only HTTP, SSE and Markdown exports.
- `public/js/score.js` and `evolve.js`: pure modules shared with the server/tests.
- `public/js/app.js`: main UI; `dashboard.js` and `report.js`: trends and reports.

## Invariants

- All AI runs through GitHub Copilot SDK/CLI. Do not restore external provider
  routing, API-key forms or alternative coding agents.
- Authentication belongs to Copilot CLI and the OS credential store, never
  localStorage, the app database, generated files or logs. Never promise that
  revoked/expired credentials remain valid.
- Generation sessions have no tools, subagents or discovered custom instructions.
  Model-written URLs are not proof that a source was retrieved.
- X discovery uses non-AI Brave Web Search and a server-only
  `BRAVE_SEARCH_API_KEY` from the gitignored `.env`. Never inspect/print the
  user's key. Search snippets are not verified live posts; preserve their URLs,
  retrieval time and provenance. Do not make paid source calls without approval.
- The medal comes from code: three 1-5 scores, bronze from 9, silver from 11,
  gold from 13. Keep weak-reference calibration meaningful.
- Reserve each AI attempt before awaiting it. Failed attempts count; 0 blocks
  requests. These app limits are not GitHub billing quotas. Preserve historical
  dollar records without recording new Copilot calls as free dollars.
- Only non-secret preferences persist in browser settings and the server DB.
  Migrate away legacy secrets and provider-prefixed models.
- Put untrusted text into DOM text nodes, never `innerHTML`.
- Generated project directories never overwrite: non-recursive `mkdir`, suffix
  `-2` if a name is taken. Keep the vault gitignored.
