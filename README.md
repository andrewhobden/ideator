# Idégeneratorn · Idea Generator

An idea board powered exclusively by **GitHub Copilot SDK/CLI**. Give a board a
goal, seed it with a thought, link or sourced lead, then branch, cross and judge
ideas. Gold ideas become Copilot project folders.

## Setup and sign-in

Requires Node 25+, Git, a GitHub account with Copilot access, and
[Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started).
There is no build step.

```bash
npm install
copilot login
npm start                 # http://localhost:8300
```

Run login as the **same operating-system user** who runs the server. In Settings,
choose **Check sign-in and models** to verify access and list your available
Copilot model IDs. Models use catalog IDs such as `gpt-6.1-sol`, not
`provider:model`. The SDK is pinned to 1.0.31 and uses its bundled CLI runtime.
The standalone CLI is used for interactive login and generated coding projects.

The app does not collect or store AI API keys or GitHub tokens. The SDK reuses
the CLI-managed sign-in across application/process restarts; it does not log out
when the app closes. **Use a working OS credential store** (for example macOS
Keychain). Copilot CLI may otherwise fall back to plaintext configuration;
do not accept that fallback for a secure persistent login. Follow the
[official authentication guidance](https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md).
`COPILOT_HOME`, if used, must be the same for login and the server.

An existing `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` environment
credential takes precedence over saved login. Do not put credentials in the
repository, app settings, browser storage or generated projects. Signing in does
not make access permanent: expired/revoked credentials, missing Copilot access,
policy restrictions and quota errors are reported. Re-run `copilot login` when
needed, or replace a managed environment credential through its secure owner.

The server is **loopback-only**, rejects non-local hosts and cross-origin
requests, and uses the local user's Copilot identity. Do not expose it through
a public reverse proxy. `PORT`, `DB_FILE` and a loopback `HOST` can be overridden.

## Features

- Independent boards with goals, creation prompts, jury guidance, model choices,
  scouts, templates and autopilot settings.
- Infinite graph canvas, family/lineage highlighting, drag-to-cross, guests
  announced across boards, spin-off boards, and exhibition mode.
- Explainable jury: originality, feasibility and impact, 1–5 each, plus a reason
  and keywords. Code assigns bronze from 9/15, silver from 11 and gold from 13.
  Vague topics do not earn medals merely because a technology is feasible.
- Server-side evolution autopilot, pacing, hourly step caps and error backoff.
- Research scout: public Hugging Face paper metadata/abstracts, ranked and
  summarized by Copilot. Only supplied paper IDs become leads.
- X scout: non-AI Brave Web Search retrieves indexed X/Twitter snippets;
  Copilot ranks and summarizes them. Only actual returned status URLs become
  leads, with search provenance and retrieval time. Model-written links/IDs
  are rejected. Coverage is incomplete: these are **not verified live posts**.
- Copilot project folders: `AGENTS.md` with brief, MVP, first steps, questions,
  lineage and verdict; `README.md`; `idea.json`; gitignored `vault/`; `git init`.
  Launch with `cd "<project>" && copilot`. Existing folders are never overwritten.
- Board summaries, keyword trends, cross-board report conclusions, project
  listings and Markdown exports. All AI roles use Copilot.
- Swedish and English UI; generated text follows the source idea's language.

## Request limits and migration

Board limits default to **100 application AI requests per local day**, with a
global default of **500**. Settings can change them; **0 blocks all AI requests**.
Every attempt is reserved atomically before submission, including manual actions,
background judges, briefs, scouts and report conclusions. Failed attempts count.
Multi-call actions consume multiple requests and cannot exceed either cap.
Counters and non-secret settings persist in SQLite across restarts.

These are **application request limits**, not GitHub billing units, premium
request multipliers, AI credits, token quotas or a guarantee of included/free
usage. SDK/service retries and model choice can affect actual GitHub usage.
GitHub plan/organization limits still apply independently.

Legacy dollar budgets are replaced, not converted into invented Copilot usage.
Historical spend records remain unchanged and are labelled separately in reports.
Legacy provider model overrides revert to Copilot defaults. On the first load,
the browser removes old saved provider keys/URLs while retaining the projects
folder and compatible non-secret preferences. Revoke obsolete keys at their
issuer if they are no longer needed; deleting browser storage cannot revoke them.
Direct external AI providers and other coding agents are no longer used.

## Mine an architecture document

Choose **Mine document** beside the regular seed field, then paste the full
document. The existing field still creates a single seed. Mining uses the
board's **Distill** Copilot model to extract distinct, standalone mechanisms,
not one summary. Dense parts typically yield 4–12 seeds; sparse/boilerplate parts
can yield fewer or none. Each candidate must have a verbatim supporting excerpt.
This checks source grounding, not the truth or originality of every model claim.

The limit is **100,000 UTF-16 characters** (the browser's character counter).
Oversized input is rejected without truncation. Non-overlapping parts cover
the entire document, each at most 10,000 characters, preferring nearby word/line
boundaries and including 500 characters of adjacent context on either side.
At most 14 parts are needed. There is one application request per uncached part,
with real per-part progress; request limits still apply to every attempt.
Allow enough daily requests for the remaining parts before starting.

Seeds are published **atomically after all parts succeed**, laid out on the
wall, and handled as ordinary seeds for judging and connections. Judging needs
additional requests; seeds without allowance remain available for later judging.
Normalized titles/pitches and strongly overlapping pitches are deduplicated
against the wall and other results. Semantic paraphrases can still need manual
review. Extraction is bounded to 12 candidates per part, not an exhaustive
guarantee that every possible interpretation becomes a seed.

Retries reuse completed parts, including after a server restart, and do not
recreate a completed import with the same document, board goal/language and
Distill model. Deleting imported seeds does not cause a retry to restore them.
Changed text/settings are a new extraction; wall deduplication still applies.
Failures keep the pasted draft while the page remains open, including after
closing/reopening the dialog. **Reloading the page loses that browser-only
draft**, so retain your original document. Keep the dialog open during mining.
The server stores a content/settings hash, derived ideas and supporting excerpts
for retries, not the full pasted document. The submitted parts are sent to
Copilot; handle sensitive architecture material under your Copilot data policy.

## X discovery with Brave Search

The X scout uses the
[Brave Web Search API](https://api-dashboard.search.brave.com/documentation/services/web-search),
not Brave's AI/summarizer or LLM endpoints. Add your own Web Search API key to
the **gitignored local `.env`**:

```dotenv
BRAVE_SEARCH_API_KEY=<your-key>
```

`npm start` and `npm run dev` load this file through Node's native env-file
support. Existing environment variables take precedence. Restart after changing
the key. Keep it server-side; never paste it into browser settings or commit it.
No subscription or credits are purchased by the application.

Scouting and Settings show whether **the running server** has loaded a key;
only that boolean is sent to the browser. “Key loaded” is not a paid API test
or a guarantee that Brave accepts the key/plan. If it is missing, start with
`npm start` from the worktree containing your `.env`, then reload the page.
A different checkout, direct `node server/index.ts` without env-file loading,
or an old/test server may not have your key.

Each manual refresh makes one search request (up to 20 results) using the
board goal/focus, X/Twitter site filters and a past-week freshness filter.
Only HTTPS X/Twitter **status** URLs returned by search are accepted; account,
search, foreign-domain and duplicate results are dropped. Copilot sees only
result titles/snippets and cannot select a source outside that retrieved set.
Stored provenance includes the result URL/title, query, retrieval time and
explicit `indexed-snippet` evidence type, not a claim that a live post was read.
Search age/freshness is not a verified X publication date. Old saved leads are
retained on empty results and failures, and are labelled separately.

**Brave charges and quotas are separate from Copilot request limits.** Check
your Brave plan/pricing and any applicable display/storage rights for search
data. Missing/rejected keys, rate limits and source failures are explicit;
they never fall back to model memory or erase saved leads. No paid Brave
call was made during migration validation: its adapter was verified with
mock responses, not the user's key.

## Development and calibration

```bash
npm test                     # offline fake Copilot/data-source regression tests
npm run typecheck            # no emitted build artifacts
npm run calibrate            # 22 real Copilot requests, separate from app caps
npm run calibrate -- --model <Copilot-catalog-ID>
```

Re-run calibration whenever the jury prompt, schema or model changes. It fails
if any weak reference earns a medal or the strong/weak mean gap is below 3.
For the migrated `gpt-6.1-sol` judge: weak mean **4.8**, max **5**; strong mean
**9.0**; gap **4.2**; run-to-run spread **0** in the observed two-run calibration.
This is a measurement, not a guarantee of future model behavior.

Generation uses isolated, single-shot SDK sessions with native structured
responses, application-side JSON Schema validation, no tools/subagents and no
discovered repository/user instructions. Completed sessions are deleted without
deleting CLI credentials. Timeout/failure aborts work before cleanup.

Validation in the migration environment used an existing **environment-backed
GitHub credential** for real structured generation and calibration. A fresh
interactive OAuth login and OS-keychain reuse were not exercised there.

## License

MIT
