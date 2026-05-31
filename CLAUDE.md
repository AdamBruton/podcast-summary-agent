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
feedback from the web UI. Runs in production on Railway as a single
long-lived web service (Cloudflare-Access-protected) that also schedules
the daily brief from in-process at 10:00 UTC. No separate cron service.

Reader for the brief: the project owner. Bias is business / strategy / tokenomics
over technical detail (see `config/profile.md` "Priority hierarchy" section).

---

## Tech stack — non-negotiable

- **Node 22 LTS, ESM only.** No CJS, no TypeScript, no build step. Module file
  imports use explicit `.js` extensions.
- **All JS in the Node runtime.** yt-dlp + ffmpeg invoked as subprocesses; no
  Python code runs inside the Node app or the Railway image. yt-dlp is
  installed via pip in the Docker image (apt's version lags YouTube changes by
  weeks). **Exception:** `modal_worker/` holds the WhisperX transcription
  worker, which IS Python — but it is deployed *separately* to Modal (not part
  of the Railway build) and the Node side only ever reaches it over HTTPS. See
  "Modal transcription worker" below.
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
    rss.js                   podcast RSS adapter (rss-parser → normalized episode rows + pod_<hex> IDs)
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
modal_worker/                Python, deployed SEPARATELY to Modal (not Railway). Called over HTTPS.
  hello.py                   Phase 2a smoke test (no GPU)
  whisperx_cpu_test.py       Phase 2b CPU/tiny proof of the WhisperX path
  transcribe.py              Phase 2c GPU worker: large-v3 + alignment + pyannote diarization
prompts/
  extract.md                 system prompt for extract pass
  rank.md                    system prompt for per-episode rank (bundling rules here)
  global-rank.md             system prompt for cross-episode ordering
  discovery-curate.md        system prompt for LLM-curating YouTube search results
  profile-refine.md          system prompt for feedback-driven profile suggestions
config/
  sources.yaml               channels + podcasts (RSS) + individuals/companies list; web UI edits this
  profile.md                 interest profile (tier hierarchy + themes); web UI edits this
scripts/
  ingest-podcasts.js         poll RSS feeds in sources.yaml → upsert podcast episodes (standalone; not yet wired into runDaily)
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

- `episodes` — one row per video OR podcast episode. `status` flows
  `new → transcribed → extracted → ranked → delivered`, plus `skipped`
  (with `skip_reason`). `source` is `subscribed` or `discovery`;
  `discovered_for` is the individual name if from discovery. `medium` is
  `youtube` (default) or `podcast`. For `medium='podcast'`: `feed_url`,
  `audio_url`, and `episode_page_url` are populated (NULL for YouTube),
  `channel_name` holds the show name, and `video_id` is `pod_<16 hex>`
  (a sha1 of normalized feed_url + guid|audio_url+pubdate — stable for
  idempotent dedupe; can't collide with YouTube's 11-char IDs).
- `transcripts` — one row per episode. `cues_json` is JSON
  `[{start, end, text, speaker?}]` (`speaker` present for diarized
  WhisperX output, absent for YouTube captions). `source` is `captions`,
  `transcript-io`, or `whisperx-modal`.
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

- **transcribe**: single source — **youtube-transcript.io** (third-party API).
  Sidesteps the "yt-dlp from a Railway IP gets silently degraded for caption
  fetching" problem by handing YouTube interaction off to a vendor. No
  fallback (Groq Whisper was considered and explicitly rejected — caller
  accepts missed episodes when the API can't return a transcript). Cached
  transcripts (already in DB) are reused without refetch. Requires
  `YOUTUBE_TRANSCRIPT_IO_TOKEN` env var. Rate limit: 5 req / 10 sec; the
  client retries on 429 honoring the Retry-After header.
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

**Ad-hoc URL semantics**: the `/api/summarize-url` endpoint **resets any
non-`new` status to `new` before invoking the pipeline**. When the user pastes
a URL, they're explicitly asking us to process it — prior `skipped` /
`delivered` / `ranked` shouldn't short-circuit. The daily cron path is
unchanged (it respects `delivered`/`skipped` to avoid wasted work). Don't
change this without thinking about the retry-after-failure case.

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
- **Audio download / Whisper**: REMOVED. Transcripts come from youtube-transcript.io
  (see `src/lib/transcript-io.js`). yt-dlp is no longer involved in transcription.

---

## Modal transcription worker (podcasts)

Audio podcasts have no captions, so they're transcribed by a **WhisperX worker
deployed to [Modal](https://modal.com)** — separate language (Python), separate
cloud, separate deploy lifecycle from the Node app. The Node ingestion layer
calls it over HTTPS (the Phase 2d endpoint); it never imports this code. Lives
in `modal_worker/`.

**This does NOT reintroduce Whisper for YouTube.** The "Whisper deliberately
removed" rule below still holds for YouTube (captions via youtube-transcript.io).
WhisperX-on-Modal is a *different decision for a different medium* — audio-only
sources that have no captions at all.

- **Run/deploy** (Windows): always prefix `$env:PYTHONUTF8=1` or Modal's `✓`
  glyphs crash the console with a cp1252 `charmap` error (the function still
  runs — it's purely a stdout-encoding issue). Invoke as `py -m modal ...`
  (the `modal` script isn't on PATH). `py -m modal run modal_worker/transcribe.py`
  runs it ephemerally; `py -m modal deploy modal_worker/transcribe.py` publishes
  the Phase 2d HTTPS endpoint (the FastAPI `web` app in `transcribe.py`).
- **Image recipe (load-bearing version pins):** `debian_slim(3.11)` + ffmpeg +
  matched torch trio **torch 2.7.1 / torchaudio 2.7.1 / torchvision 0.22.1** +
  **whisperx 3.7.2**. whisperx requires torch>=2.7.1; pinning the whole trio
  stops the install from pulling a mismatched torch and breaking torchvision.
- **Two mandatory compatibility shims** (both in `transcribe.py`, must run
  before any model load):
  1. `torch.load` forced to `weights_only=False` — torch 2.7 defaults it to
     True, which rejects pyannote's checkpoints (they embed omegaconf objects).
     Trusted HF sources, so this is safe. Force it (don't `setdefault`):
     `lightning_fabric` passes `weights_only=True` explicitly.
  2. `hf_hub_download`/`snapshot_download` translate `use_auth_token=` → `token=`
     — pyannote.audio 3.4 still passes the removed kwarg; the newer
     huggingface_hub that transformers needs renamed it. **No single hf_hub
     version satisfies both pyannote and transformers**, so we keep the new one
     and translate at the call site. Do NOT "fix" this by pinning hf_hub.
- **Model-weight caching:** a Modal **Volume** (`whisperx-cache`) mounted at
  `/cache`, with `HF_HOME`/`TORCH_HOME` pointed into it, so large-v3 (~3GB) +
  alignment + pyannote models download once and persist. `cache_vol.commit()`
  after a run. Without this, every cold start re-downloads ~4GB on billed GPU.
- **HF token:** the gated pyannote models (`speaker-diarization-3.1` +
  `segmentation-3.0`, both must be license-accepted) need a token, supplied as
  the Modal secret **`huggingface`** (key `HF_TOKEN`) — never in the repo.
- **HTTPS endpoint (Phase 2d) — LIVE:** the `web` FastAPI app in `transcribe.py`,
  published by `py -m modal deploy` and deployed at
  `https://adambruton--podcast-transcribe-web.modal.run`. Job-queue pattern
  (the GPU job is ~14 min, too long for one synchronous request):
  `POST /transcribe {audio_url, clip_seconds?}` → `{call_id}`;
  `GET /result/{call_id}` → `200`
  `{status:"done", result:{...cues...}}` when finished, `202`
  `{status:"pending"}` while running, `410` once Modal's result-retention
  window lapses. Auth is a **shared bearer token** from the Modal secret
  **`transcribe-auth`** (key `TRANSCRIBE_SECRET`), sent as
  `Authorization: Bearer <token>` — never in the repo. The Node side reads the
  URL + token from env as `MODAL_TRANSCRIBE_URL` / `MODAL_TRANSCRIBE_SECRET`
  (Phase 3). The web container is fastapi-only (no torch) so it cold-starts
  fast and scales to zero; the GPU image only spins up inside the spawned
  `transcribe` call.
- **Output contract:** cues `[{start, end, text, speaker}]`. `speaker` is an
  anonymous `SPEAKER_NN` diarization label (no real names).
- **Cost (grounded on a 5-min clip, L4):** ~47s GPU compute for 5 min audio →
  ~14 min / **~$0.18 per 90-min episode**; ~15 episodes/week ≈ ~$11/mo, inside
  the $30 free credit. GPU = L4 ($0.000222/s).
- **Status:** 2a hello-world, 2b CPU/tiny, 2c GPU+diarization, 2d (HTTPS
  endpoint + shared bearer-token secret) all done **and deployed**. 2d was
  smoke-tested live against a 60s clip: bad token → 401, submit → poll
  (pending → done), output contract correct (language=en, diarized cues with
  4 speakers). The Node-side transcribe router (Phase 3) is the
  remaining integration work.

---

## Database backup & restore

- **Snapshots**: `backupDatabase()` in `src/lib/backup.js` writes a gzipped
  copy to `<DATA_DIR>/backups/state-<utc-ts>.db.gz` using `VACUUM INTO`.
  That clones the live DB into a clean single-file artifact regardless of
  WAL state, so we don't have to coordinate with readers or deal with
  `-wal`/`-shm` sidecars.
- **Schedule**: backup runs at the START of `runDaily` (before any new
  writes for the day). Wrapped in try/catch — a failed backup must NOT
  block the brief from going out. Since `runDaily` is now invoked from
  in-process by the web server's scheduler, backups land on the same
  volume the UI reads from.
- **Rotation**: keep last 14 snapshots on disk, sorted by mtime. The
  pre-restore snapshots (`state.pre-restore-<ts>.db`, uncompressed) are
  NOT rotated — restores are rare and we want to keep all of them.
- **Off-site**: on Sunday UTC, the daily snapshot is also emailed via
  SendGrid as an attachment (≤ 20 MB compressed; current size ~3 KB so
  there's huge headroom). If SendGrid env isn't set, off-site is silently
  skipped. To restore: gunzip the attachment → upload via the web UI's
  "Database backup & restore" section.
- **Restore endpoint** (`POST /api/admin/restore-db`): accepts
  `application/octet-stream`, validates SQLite magic bytes
  (`Buffer.compare` against `SQLite format 3\0`), snapshots current DB to
  `state.pre-restore-<ts>.db`, writes the upload to a tmp file, calls
  `resetDb()` to close the singleton, deletes stale WAL/SHM sidecars,
  atomically renames the tmp file over `DB_PATH`, then calls `db()` to
  reopen against the new file (which surfaces any "bad upload" errors in
  the response rather than the next unrelated request). The process keeps
  running — important because Railway's `restartPolicyType=ON_FAILURE`
  does NOT restart after a `process.exit(0)`; the old "exit and let
  Railway restart" approach stranded the service.
- **Cloudflare Access protects the admin endpoints in production.** Locally
  the server binds 127.0.0.1 so no extra auth is needed. If you ever bind
  to 0.0.0.0 outside of Railway, gate `/api/admin/*` behind a token first.

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
- **Daily brief runs in-process** in the web service via an in-process
  scheduler (`scheduleDailyRun` in `src/web/server.js`) that fires at
  10:00 UTC (= 6am EDT / 5am EST). The hour is fixed in UTC, so it
  drifts an hour vs ET across DST — acceptable for a morning brief.
  The scheduler only starts when `PORT` is set (Railway mode); locally
  use `npm run brief`. Manually trigger a daily on prod via
  `POST /api/admin/run-daily` (Cloudflare Access protected,
  fire-and-forget). There is NO separate Railway cron service — that
  approach broke because Railway volumes are single-attach (each service
  gets its own mount, so the cron and web volumes silently diverged).
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
- **Railway volumes are single-attach.** Each service mounts its own
  volume; two services can't share one filesystem. We learned this the
  hard way when a separate cron service silently wrote daily-run output
  to its own `/data/state.db` while the web service kept reading from a
  different volume. Fix: keep all work inside one service (the web
  service schedules `runDaily` in-process — see "Operational notes").
- **Cloudflare Access OTPs are single-use.** If a code "doesn't work", it's
  because it was already redeemed; request a new one.

---

## Known issues / open work

State of the world at last update. Re-evaluate these every few sessions —
they're listed here so future Claude doesn't waste time rediscovering them
or quietly re-introduce them.

### Podcasts as a first-class medium (in progress)

Multi-phase effort to add audio podcasts alongside YouTube, reusing the
existing extract→rank→compose→deliver stages unchanged. The
ingestion/intelligence boundary already in this codebase (stages 1-2 vs
3-6) is the separation being preserved — podcasts add a parallel ingest +
transcribe path and otherwise flow through the same intelligence layer.

- **Phase 1 — DONE.** Schema gained `episodes.medium` + `feed_url` /
  `audio_url` / `episode_page_url` (additive `safeAlter`, existing rows
  default `medium='youtube'`). `src/lib/rss.js` parses feeds via
  rss-parser and mints `pod_<16hex>` IDs. `config/sources.yaml` has a
  `podcasts:` bucket. `scripts/ingest-podcasts.js` polls + upserts —
  **standalone, intentionally NOT wired into `runDaily` yet.** Verified
  against the real DB: 25 YouTube rows untouched, 33 podcasts ingested.
- **Phase 2 — DONE and DEPLOYED.** WhisperX-on-Modal transcription
  worker (Python, deployed separately to Modal; the one genuinely
  separate-language piece). 2a/2b/2c built the GPU worker; **2d** added the
  deployable HTTPS endpoint (the FastAPI `web` app in `transcribe.py`) with a
  shared bearer-token secret — see "Modal transcription worker" above for the
  request contract + live URL. The `transcribe-auth` secret is created and the
  app is deployed; 2d was smoke-tested live end-to-end. The Node side just
  needs `MODAL_TRANSCRIBE_URL` / `MODAL_TRANSCRIBE_SECRET` in env (Phase 3).
  The "Whisper deliberately removed" stable note below still holds **for
  YouTube** — Phase 2 does not reintroduce Whisper for captions; it adds
  WhisperX for audio-only podcast sources that have no captions at all.
  Different decision, different medium.
- **Phase 3 — NEXT.** Stage 2 (`2-transcribe.js`) becomes a router: YouTube →
  transcript-io (unchanged), podcast → POST audio_url to the Modal endpoint +
  poll `/result`, write cues with `speaker`. Needs a small Node client wrapper
  (mirroring `src/lib/transcript-io.js`) reading `MODAL_TRANSCRIBE_URL` +
  `MODAL_TRANSCRIBE_SECRET` env vars.
- **Phases 4-8 — LATER.** Wire podcasts into `runDaily`; confirm extract/
  rank work unmodified (expected, since they read only episode+transcript);
  compose URL builder becomes medium-aware (YouTube `&t=Ns` vs podcast page/
  audio link); web UI feeds editor + medium filter.

### Not yet done (work the user has acknowledged but deferred)

- **State migration to Railway: tooling is built, run it once.** Local
  `state.db` is uploaded to the production volume via the web UI
  ("Database backup & restore" → "Restore from file") or via
  `npm run upload-state-db` with `ADMIN_UPLOAD_URL` +
  `CF_ACCESS_CLIENT_ID/SECRET` set (Cloudflare service token for the
  deployment's hostname). The endpoint snapshots the existing prod DB to
  `/data/backups/state.pre-restore-<ts>.db`, swaps in the upload, and
  resets the singleton DB handle so the next query opens the new file —
  no service restart. After running it, delete this bullet.
- **No failure alerting for the daily cron.** If `npm run brief` errors
  out (rate limit, API outage, transcript-io down), no email goes out and
  no notification fires. Possible fixes: wrap the brief command in a small
  shell script that catches non-zero exit and POSTs to a notification
  webhook; or have the brief subject always include episode count so
  absence-of-mail becomes a tracking signal.
- **6 disabled sources need handle fixes.** `sources.yaml` has
  `enabled: false` on Sharp Tech, Logan Bartlett, Google DeepMind,
  Fireworks AI, Baseten, Cloudflare. Wrong handles or no `/videos` tab.
  Fix via the web UI when convenient.

### Minor product gaps (nice-to-have, not blocking)

- **Dropped candidates have no LLM rejection reason.** The rank pass only
  emits `why_matters` for SELECTED items. The episode inspector shows
  extract-time fields (category, novelty_score) for drops but no "why the
  ranker dropped this" insight. Adding rejection reasons = extend
  `rank.md` to emit a brief reason per non-selected item; ~+200 output
  tokens per episode (~$0.003).
- **No "re-rank this episode" button in the inspector UI.** Currently
  requires CLI: `node scripts/rerank.js <video_id>`. A button per row
  would let the user iterate on profile changes by re-ranking individual
  episodes from the UI.

### Hygiene / tokens to rotate

These tokens appeared in earlier debugging chat logs (the user pasted them
inline when working through CLI issues). Rotate at convenience:

- `RAILWAY_API_TOKEN` — Railway → Account Settings → Tokens
- `YOUTUBE_TRANSCRIPT_IO_TOKEN` — youtube-transcript.io → Profile
- `TRANSCRIBE_SECRET` (Modal `transcribe-auth` secret) — pasted inline during
  the 2d smoke test. Rotate via `py -m modal secret create transcribe-auth
  TRANSCRIBE_SECRET=<new-hex> --force`, then update `MODAL_TRANSCRIBE_SECRET`
  in `.env` / Railway.
- (Anthropic + SendGrid keys are also in the repo's local `.env` which is
  gitignored — not exposed, but rotate annually as standard practice.)

### What's STABLE and shouldn't be undone

- **Transcripts come from youtube-transcript.io.** yt-dlp's caption fetching
  was silently degraded by YouTube when called from Railway's datacenter
  IPs even with valid cookies. Don't reintroduce yt-dlp-based captions
  thinking "this'll work" — it works locally but not in prod.
- **Whisper fallback is deliberately removed.** It was considered and
  explicitly rejected. The user accepts missed episodes over the operational
  complexity of audio download + Groq integration + their own potential
  reliability issues.
- **Defensive type coercion in saveCandidates + upsertEpisode is load-
  bearing.** node:sqlite refuses arrays/objects/NaN/undefined for binding;
  Claude occasionally returns arrays for `supporting_quote`, yt-dlp returns
  null/undefined `duration` for live streams. Don't simplify these helpers
  back to direct binding "for cleanliness" — the gnarliness is the point.

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

# Backup / restore
npm run backup                                 # on-demand local snapshot (also via UI button)
npm run backup -- --email                      # also email a copy if SendGrid configured
$env:ADMIN_UPLOAD_URL="https://your-deployment.example.com/api/admin/restore-db"
$env:CF_ACCESS_CLIENT_ID="...";  $env:CF_ACCESS_CLIENT_SECRET="..."
npm run upload-state-db                        # push local data/state.db to prod

# Railway
railway login
railway link                                   # interactive: pick project + service
railway ssh                                    # interactive shell on the running service
```
