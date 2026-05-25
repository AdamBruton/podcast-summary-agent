# CLAUDE.md

Repo-level instructions for Claude. Loaded automatically when working in this
repo. Captures the design rules, invariants, and debugged pitfalls that aren't
obvious from reading the code.

If the code disagrees with this file, the code is right and this file is stale —
fix CLAUDE.md.

---

## What this is

A podcast intelligence agent. Polls a curated set of YouTube channels + searches
YouTube for named individuals/companies daily, transcribes via captions (with
optional Whisper fallback), runs two Claude passes (extract → rank, plus a
cross-episode global rank), composes an HTML brief with timestamp deep-links,
sends via SendGrid. Tuned by an editable profile.md and per-candidate thumbs
feedback from the web UI. Runs in production on Railway with a Cloudflare-Access-
protected web UI at `brief.adambruton.co` and a daily cron service.

Reader for the brief: the project owner. Bias is business / strategy / tokenomics
over technical detail (see `config/profile.md` "Priority hierarchy" section).

---

## Tech stack — non-negotiable

- **Node 22 LTS, ESM only.** No CJS, no TypeScript, no build step. Module file
  imports use explicit `.js` extensions.
- **All JS.** yt-dlp + ffmpeg invoked as subprocesses; no Python code in this
  codebase. yt-dlp is installed via pip in the Docker image (apt's version
  lags YouTube changes by weeks).
- **`node:sqlite` not `better-sqlite3`.** Built-in, no native deps, no
  VS-build-tools requirement on Windows or Alpine in Docker. See "node:sqlite
  gotchas" below — it's stricter than other SQLite bindings.
- **Express 5** for the web server. Note: Express 5 dropped regex route
  patterns (`/:cat(channel|company)`) — use simple `:param` and route
  per-path instead.
- **No frontend framework.** Vanilla JS + CSS in `src/web/public/index.html`,
  one file. Static-served by Express.
- **Anthropic SDK** (`@anthropic-ai/sdk`) for all LLM calls. **Claude Sonnet 4.6
  (`claude-sonnet-4-6`)** for every stage. Pricing constants live in
  `src/lib/claude.js#MODEL_PRICING`. When bumping models, update there.

---

## Repo layout

```
src/
  cli.js                     command-line entry (npm run brief)
  pipeline.js                runDaily / runEpisode orchestrators
  lib/
    config.js                env, paths, source/profile loaders
    db.js                    node:sqlite schema + helpers (single source of truth)
    claude.js                Anthropic SDK wrapper with prompt caching + cost telemetry
    youtube.js               yt-dlp subprocess wrapper (resolveHandle, fetchCaptions, etc.)
    log.js                   tiny structured logger + stage() timing wrapper
    sources-store.js         read/write config/sources.yaml via yaml Document API (preserves comments)
    profile-store.js         read/write config/profile.md as plain text
    discovery-search.js      yt-dlp ytsearch + mechanical pre-filters
    global-rank.js           cross-episode global ordering pass
    number-check.js          numeric-fidelity guard for extracted candidates
  stages/
    1-ingest.js              channel polling + ad-hoc URL ingest
    1b-discover.js           discovery: search → mechanical filter → LLM curate → promote
    2-transcribe.js          captions-first, Groq Whisper fallback
    3-extract.js             chunked Claude pass producing candidates
    4-rank.js                per-episode Claude pass (singles + bundles)
    5-compose.js             HTML render incl. canonicalize + bundle layout
    6-deliver.js             SendGrid send (or write-to-disk on --dry-run)
  web/
    server.js                Express API + static file serving
    public/index.html        single-page UI: sources, profile, episode inspector, ad-hoc URL
prompts/
  extract.md                 system prompt for extract pass
  rank.md                    system prompt for per-episode rank (bundling rules here)
  global-rank.md             system prompt for cross-episode ordering
  discovery-curate.md        system prompt for LLM-curating YouTube search results
  profile-refine.md          system prompt for feedback-driven profile suggestions
config/
  sources.yaml               channels + individuals/companies list; web UI edits this
  profile.md                 interest profile (tier hierarchy + themes); web UI edits this
scripts/
  resolve-channels.js        one-time / on-demand: populate channel_id from @handle
  recompose.js               re-render the current ranked pool (with optional --send)
  rerank.js                  re-run rank pass on existing episodes (no re-extract)
  discover.js                standalone discovery run (with --promote or test mode)
  discovery-audit.js         inspect approve/reject/filtered decisions
  inspect-window.js          dump candidates + transcript around a timestamp
  inspect-bundles.js         dump bundle structure for an episode
  test-canonicalize.js       sanity test for the term-canonicalization table
  test-number-check.js       sanity test for the numeric-fidelity guard
data/                        gitignored. state.db, transcripts/, briefs/, cookies.txt
```

---

## Path strategy: local vs Railway

**Detection**: presence of `RAILWAY_VOLUME_MOUNT_PATH` env var. Set by Railway
when a volume is mounted; absent locally.

**Local** (RAILWAY_VOLUME_MOUNT_PATH unset):
- `DATA_DIR = ROOT/data` (gitignored)
- `CONFIG_DIR = ROOT/config` (git-tracked — UI edits commit-friendly)
- Web UI binds 127.0.0.1, auto-opens browser
- DB, transcripts, briefs, cookies all in `./data/`

**Railway** (RAILWAY_VOLUME_MOUNT_PATH = `/data`):
- `DATA_DIR = /data` (persistent volume)
- `CONFIG_DIR = /data/config` (writable, persists across deploys; seeded from
  image's `ROOT/config` on first boot if empty)
- Web UI binds 0.0.0.0, listens on `PORT` env var
- DB, transcripts, briefs, cookies all in `/data/`

The seeding logic is in `src/lib/config.js`'s top-level code (runs on import).
Don't move config to env vars or to the DB; the file workflow is intentional.

---

## Database — schema invariants

Tables (all migrations via `safeAlter` in `src/lib/db.js#migrate`):

- `episodes` — one row per video. `status` flows
  `new → transcribed → extracted → ranked → delivered`, plus `skipped`
  (with `skip_reason`). `source` is `subscribed` or `discovery`;
  `discovered_for` is the individual name if from discovery.
- `transcripts` — one row per video. `cues_json` is JSON `[{start, end, text}]`.
  `source` is `captions` or `whisper`.
- `candidates` — many per video. Output of extract pass. **IDs are unstable
  across re-extracts** (saveCandidates DELETEs and re-INSERTs); anything
  referencing candidate_id (rankings, feedback, bundle_members) cascades.
- `rankings` — one per brief item. `candidate_id` is the primary; bundles
  store extras in `ranking_bundle_members`. `label` is the bundle headline
  (NULL for singles).
- `ranking_bundle_members` — junction for bundles. ON DELETE CASCADE from
  both rankings and candidates.
- `feedback` — per-candidate thumbs (`up` | `down`). ON DELETE CASCADE
  from candidates, so re-extract loses feedback.
- `discoveries` — every YouTube search result ever seen + the LLM curation
  decision. Audit trail; survives even when not promoted.
- `runs` + `cost_ledger` — telemetry. Every Claude call records tokens + $
  with `{run_id, video_id, stage, model, ...}`.

**Critical**: `PRAGMA foreign_keys = ON;` is set on every connection. Code
that deletes parent rows must clear child rows first OR rely on the cascade.
`saveCandidates` explicitly deletes rankings first because candidate_id
isn't cascade'd in that direction (rankings.candidate_id is a regular FK,
not CASCADE).

**Schema changes**: use `safeAlter(d, 'ALTER TABLE ...')` (the helper
swallows duplicate-column errors), never raw `ALTER TABLE` — existing
databases need the column-already-exists tolerance.

---

## Pipeline contract

```
runDaily()                                 runEpisode({url, markDeliveredOnSend})
   ├─ ingestDaily()                            ├─ ingestEpisode(url)
   ├─ discoverIndividuals()                    │
   └─ for each resumable episode:              │
        ├─ transcribeEpisode()                 ├─ transcribeEpisode()
        ├─ extractEpisode()    ← skipped if    ├─ extractEpisode()
        │                        status        │
        │                        already       │
        │                        extracted/    │
        │                        ranked        │
        ├─ rankEpisode()       ← always reruns ├─ rankEpisode()
        └─ →                                   │
      composeBrief(eps) ─→ globalRank ─→ flat ─→ deliver({markDeliveredOnSend?})
```

Stage invariants:

- **transcribe**: captions-first via yt-dlp (`--write-subs --write-auto-subs`).
  If no captions AND no GROQ_API_KEY → mark `skipped`. If audio > 25MB → mark
  `skipped`. Cached transcripts (already in DB) are reused without refetch.
- **extract**: chunks long transcripts at ~240k chars with cue overlap.
  Output filtered by `verifyNumericFidelity` (drops candidates whose claim
  contains numbers not present in the supporting_quote — catches the
  $75B-vs-$7.5B paraphrase-hallucination class). Skipped on re-runs when
  status is already `extracted` or `ranked` (extract is deterministic-ish
  and profile-independent — re-running burns tokens for the same output).
- **rank**: cheap (~$0.03). Always re-runs on non-delivered episodes so
  profile edits propagate. Output can be SINGLES `{candidate_id, rank,
  why_matters}` or BUNDLES `{candidate_ids: [...], rank, why_matters, label}`.
  rank.md tells the model when to bundle (text-signal driven, no fixed cap).
- **compose**: always runs the global-rank pass for multi-episode briefs.
  Single-episode briefs skip global-rank (per-episode rank is already
  optimal). Renders as a flat top-down ordinal list. No item cap — reader
  scans top-down and stops when done.
- **deliver**: in real mode (not --dry-run) refuses to send if `episodes.length
  === 0` (returns `{empty: true}`). Ad-hoc URL endpoint surfaces this as a
  user-visible error rather than silently emailing a blank brief.

**markDeliveredOnSend semantics**:
- `true` (default): after send, episodes get status `delivered`; won't appear
  in future briefs. Used by daily run, CLI `--episode`, and `recompose --send`.
- `false`: send but don't mark delivered. Episode stays in `ranked` state and
  rolls up into the next daily brief alongside other content. Used by the
  web UI's ad-hoc URL endpoint (the user explicitly wants both: immediate
  brief AND inclusion in tomorrow's roundup).

---

## Cost discipline

- **Always cache the system prompt.** Pattern in `src/lib/claude.js#complete`:
  `system: [{type: 'text', text: systemPrompt, cache_control: {type: 'ephemeral'}}]`.
  This is non-negotiable for repeated calls (rank, global-rank, discovery-curate,
  profile-refine all reuse the same system across calls in a run).
- **Always log via `recordCost`.** `claude.complete()` does this automatically
  when `telemetry.run_id` is provided; callers that don't have a run_id
  (e.g. profile-refine, global-rank in some paths) just don't get cost logged
  — that's a known gap, not a bug.
- **Pricing (Sonnet 4.6, USD per million tokens)**: input $3.00, output $15.00,
  cache_read $0.30, cache_write_5m $3.75. Hard-coded in `claude.js#MODEL_PRICING`.
- **Typical per-episode cost** (steady state, single ~1hr episode):
  extract $0.20 + rank $0.03 + global-rank $0.03 (amortized) ≈ $0.26.
  Daily cron with 3-5 new episodes: ~$1-2 + discovery curation $0.05.

---

## Anthropic SDK conventions

- Models live in `MODELS.SONNET` only (right now there's just one). When adding
  a model, also add its pricing row to `MODEL_PRICING`.
- All system prompts go through `loadPrompt('name')` which reads `prompts/name.md`.
  Add new prompts as `prompts/<thing>.md`, never inline.
- `parseJsonResponse(text)` strips markdown fences (```json ... ```) and finds
  the first `{` or `[`. Use it on every model JSON output — models love adding
  fences even when told not to.
- Telemetry shape: `{run_id?, video_id?, stage}`. `stage` is the only required
  field; if `run_id` is missing, cost isn't logged but the call still runs.

---

## node:sqlite — gotchas we've already hit

- **Strict type binding.** No auto-coerce of `undefined`, `NaN`, `BigInt`,
  arrays, objects. Coerce before `.run()`. Pattern in `db.js`:
  ```js
  function asStringOrNull(v) {
    if (v == null) return null;
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.join(' ');
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
  // numbers:
  Number.isFinite(x) ? Math.floor(x) : null
  ```
  Applied in `saveCandidates` and `upsertEpisode` after we hit the
  "Provided value cannot be bound to SQLite parameter N" class of bugs.
- **Named params use `@field` syntax** (not `:field` or `$field`).
- **Error messages say "parameter N"** for both positional AND named bindings —
  to find which field N maps to, count positional `?`s OR named `@field`s in
  the prepared statement.
- **No CLOSE on the global db().** Module-level singleton; tests will need
  manual handling if we ever add them.

---

## yt-dlp invocation patterns

All yt-dlp calls go through `run()` in `src/lib/youtube.js` (and the parallel
`runYtDlp()` in `src/lib/discovery-search.js`). Both prepend `commonArgs()`:

- `--cookies <DATA_DIR>/cookies.txt` if the file exists (required on Railway
  for YouTube bot-detection)
- `--ignore-no-formats-error` always (metadata operations don't need a
  downloadable format; without this, live-stream/premieres/members-only
  first-on-channel videos abort format selection)

Other learned patterns:

- **Channel ID resolution**: `--flat-playlist --playlist-end 1 --print
  "playlist:%(channel_id)s"`. The `playlist:` scope prefix is critical —
  the per-video `%(channel_id)s` field returns literal `"NA"` in flat mode.
- **Channel uploads listing**: `--flat-playlist --playlist-end <N> --dump-json`
  → parse line-by-line JSON, each line is one video's flat metadata.
- **Full metadata for a single video**: `--dump-json --skip-download` (no flat).
- **Captions**: `--write-subs --write-auto-subs --sub-langs "en.*,en"
  --sub-format vtt --skip-download --convert-subs vtt`. Manual subs preferred;
  auto fallback.
- **Audio for Whisper**: `-x --audio-format mp3 --postprocessor-args
  "ffmpeg:-ac 1 -ar 16000 -ab 32k"` — keeps file under Groq's 25MB upload
  cap for episodes up to ~1.7hr.

---

## Web UI conventions

- **Errors flow through `setErr(elemId, message)`** in `index.html`. Auto-fade
  after 6s, dismissible × button. Never use raw `el.textContent = err.message`.
- **No build step.** Vanilla JS + inline `<style>` + inline `<script>`. Adding
  a framework requires explicit discussion.
- **Auth lives at Cloudflare**, not in the app. The Express server has no auth
  middleware. Don't add one without first removing the Cloudflare Access
  policy — otherwise duplication.
- **Profile + sources edits**: web UI writes through `sources-store.js` /
  `profile-store.js`, both of which round-trip via the yaml Document API
  (preserves comments and key order). Don't `YAML.parse() → YAML.stringify()`
  — that destroys all comments.
- **Feedback workflow**: thumbs on each candidate in the episode inspector
  → "Suggest refinements" button collects all feedback + current profile
  → Claude proposes revised profile.md → user reviews diff (via `diff` npm
  package, rendered as +/− lines) → applies or discards.

---

## Prompt-editing conventions

- **profile.md is the bias function.** Its "Priority hierarchy" section
  (Tier 1 / 2a / 2b / 3) is read by `rank.md` and `global-rank.md` as the
  ranking rubric. Edits to the hierarchy ripple through both passes.
- **Tune via the feedback loop**, not by hand-editing, when possible. The
  LLM-driven refinement workflow is the intended path. Hand-edits are for
  structural changes (adding/removing whole sections).
- **Don't strip the tier hierarchy** when adding new themes. New themes go
  inside `## Themes I care about` with a tier callout in their heading
  (e.g. `### Cybersecurity, identity, edge compute  (Tier 1)`).
- **Bundling instructions live in rank.md.** Text-signal driven, no fixed
  count cap. If overproduction becomes a problem, tighten the "synthesis test"
  language rather than reintroducing a numeric ceiling.
- **The number-fidelity check** (`src/lib/number-check.js`) drops candidates
  whose claim contains numbers not present in the supporting_quote. Catches
  the $75B-paraphrased-as-$7.5B class. Don't remove this; the prompt's
  "Numbers must match" rule is belt-and-suspenders with the code check.

---

## Operational notes

- **Cookies file** lives at `data/cookies.txt` (local) or `/data/cookies.txt`
  (Railway volume). Exported from a logged-in Chrome via the "Get cookies.txt
  LOCALLY" extension. Required for production (YouTube blocks unauthenticated
  datacenter IPs); optional locally on residential IPs.
- **state.db survives Railway deploys** via the persistent volume. Don't
  re-deploy code changes assuming state will be wiped.
- **Cron service** on Railway runs `npm run brief` daily at 11:00 UTC (= 7am ET).
  Shares the same volume as the web service. Cron restart policy: never (it
  should run once and exit).
- **Ad-hoc URLs** flow through `POST /api/summarize-url` → `runEpisode({url,
  markDeliveredOnSend: false})`. Intentionally NOT marked delivered so they
  also appear in the next daily brief.
- **The web UI's profile editor** is behind a `<details>` disclosure
  ("Advanced: edit raw profile.md"). The primary tuning surface is the
  Suggest-refinements button driven by thumbs feedback.

---

## Common pitfalls we've debugged (so future Claude doesn't relearn)

- **PowerShell eats `$1` in regex replacement strings** — wrap in single
  quotes or use a temp file.
- **PowerShell `Invoke-RestMethod -Method Post` without `-Body`** hangs
  waiting for stdin. Always pass `-Body '{}'` for empty bodies.
- **PowerShell stderr-redirect makes native commands look like they
  failed** even when exit was 0. Don't add `2>&1` to npm calls.
- **Bash tool sees a different PATH** than the project's interactive
  PowerShell. Node/yt-dlp/ffmpeg are NOT on its PATH. Use PowerShell with
  `$env:Path = ... + Machine + User` refresh for Node commands.
- **node:sqlite parameter N errors** map to the Nth bound value in
  positional binds, or to the Nth `@field` in the prepared statement for
  named binds — count carefully when debugging.
- **yt-dlp `--flat-playlist` returns "NA"** for per-video `channel_id`.
  Use `--print "playlist:%(channel_id)s"` for the playlist-scoped value.
- **yt-dlp `--write-auto-subs` alone misses manual / creator-uploaded
  subs.** Use both `--write-subs --write-auto-subs`.
- **Express 5 dropped regex route patterns** like `/:cat(channel|company)`.
  Use simple `:param` and route per-path.
- **Railway volumes must be attached separately to each service** that
  needs access. The web service and cron service both need the same mount.
- **Cloudflare Access OTPs are single-use.** If a code "doesn't work", it's
  because it was already redeemed; request a new one.

---

## When NOT to do things

- Don't add a JS YouTube library to replace yt-dlp. yt-dlp tracks YouTube's
  daily changes; libraries break in weeks.
- Don't add a frontend framework. The single-page UI doesn't need React/Vue/
  Svelte; the cost of a build pipeline isn't worth the abstraction.
- Don't add a database migration framework. `safeAlter` in db.js is enough.
- Don't add auth code to Express. Cloudflare Access handles it.
- Don't commit `data/`, `.env`, or `cookies.txt`. Gitignored.
- Don't rewrite saveCandidates / upsertEpisode to skip sanitization. node:sqlite
  is strict; the coercion layers are load-bearing.
- Don't bake state.db into the Docker image. Use volume + manual seed.

---

## Useful commands

```powershell
# Local dev
npm run web                                    # web UI on http://localhost:3000
npm run brief                                  # daily run, send email
npm run brief:dry                              # daily run, write HTML to disk
node src/cli.js --episode "<url>" --dry-run    # ad-hoc, no email

# Inspection
npm run discovery:audit [days] [decision]      # recent discoveries
node scripts/inspect-bundles.js <video_id>     # bundle structure
node scripts/inspect-window.js <video_id> <sec>  # candidates near a timestamp

# Iteration
npm run resolve-channels                       # populate channel_id from @handle
node scripts/rerank.js [<video_id>]            # re-rank without re-extract
node scripts/recompose.js [--send]             # re-render brief from current state

# Railway
railway login
railway link                                   # interactive: pick project + service
railway ssh                                    # interactive shell on the running service
```
