# CLAUDE.md

Repo-level instructions for Claude. Captures design rules, invariants, and
debugged pitfalls that aren't obvious from the code. **If the code disagrees
with this file, the code is right — fix CLAUDE.md.**

---

## What this is

A podcast intelligence agent. Polls curated YouTube channels + podcast RSS
feeds, and searches YouTube for named individuals/companies daily. Transcribes
YouTube via captions (youtube-transcript.io) and podcasts via WhisperX-on-Modal,
runs two Claude passes (extract → rank, plus a cross-episode global rank),
composes an HTML brief with timestamp deep-links, sends via Resend. Tuned by
an editable `config/profile.md` + per-candidate thumbs feedback from the web UI.

Runs in production on Railway as a single long-lived web service
(Cloudflare-Access-protected) that also schedules the daily brief in-process at
08:00 UTC. **No separate cron service** (Railway volumes are single-attach — a
second service silently diverges onto its own volume).

Reader: the project owner. Bias is business / strategy / tokenomics over
technical detail (see `config/profile.md` "Priority hierarchy").

---

## Tech stack — non-negotiable

- **Node 22 LTS, ESM only.** No CJS, no TypeScript, no build step. Explicit
  `.js` import extensions.
- **All JS in the Node runtime.** yt-dlp + ffmpeg as subprocesses; no Python in
  the Node app or Railway image. yt-dlp installed via pip in Docker (apt lags
  YouTube by weeks). **Exception:** `modal_worker/` (WhisperX) is Python,
  deployed *separately* to Modal; Node only reaches it over HTTPS.
- **`node:sqlite`, not `better-sqlite3`.** Built-in, no native deps. Stricter
  binding — see gotchas below.
- **Express 5.** Dropped regex route patterns (`/:cat(channel|company)`) — use
  simple `:param` and route per-path.
- **No frontend framework.** Vanilla JS + CSS in `src/web/public/index.html`,
  one file, static-served. Adding a framework requires explicit discussion.
- **Anthropic SDK** (`@anthropic-ai/sdk`), **Claude Sonnet 4.6
  (`claude-sonnet-4-6`)** every stage. Pricing in `src/lib/claude.js#MODEL_PRICING`
  — update when bumping models.

---

## Repo layout

```
src/
  cli.js                command entry (npm run brief)
  pipeline.js           runDaily / runEpisode orchestrators
  lib/
    config.js           env, paths, source/profile loaders (+ Railway seeding on import)
    db.js               node:sqlite schema + helpers (single source of truth)
    claude.js           Anthropic wrapper: prompt caching + cost telemetry
    youtube.js          yt-dlp subprocess wrapper
    rss.js              podcast RSS adapter (rss-parser → rows + pod_<hex> IDs)
    log.js              structured logger + stage() timing
    sources-store.js    read/write config/sources.yaml via yaml Document API (preserves comments)
    profile-store.js    read/write config/profile.md as plain text
    discovery-search.js yt-dlp ytsearch + mechanical pre-filters
    global-rank.js      cross-episode global ordering pass
    number-check.js     numeric-fidelity guard
    transcript-io.js    youtube-transcript.io client (YouTube captions)
    modal-transcribe.js WhisperX-on-Modal client (podcast audio)
    mailer.js           Resend email transport (shared by deliver + backup)
    backup.js           DB snapshot/restore (VACUUM INTO)
  stages/
    1-ingest.js         channel polling + ad-hoc URL ingest + ingestPodcastsDaily()
    1b-discover.js      search → mechanical filter → LLM curate → promote
    2-transcribe.js     medium router: YouTube→transcript-io, podcast→Modal/WhisperX
    3-extract.js        chunked Claude pass → candidates
    4-rank.js           per-episode Claude pass (singles + bundles)
    5-compose.js        HTML render (medium-aware links, canonicalize, bundles)
    6-deliver.js        Resend send (or write-to-disk on --dry-run)
  web/
    server.js           Express API + static serving + in-process daily scheduler
    public/index.html   single-page UI: sources, podcasts, profile, inspector, ad-hoc URL
modal_worker/           Python, deployed SEPARATELY to Modal. Called over HTTPS.
  transcribe.py         GPU worker (large-v3 + alignment + pyannote) + FastAPI `web` endpoint
  hello.py, whisperx_cpu_test.py   earlier-phase smoke tests
prompts/                extract.md, rank.md (bundling rules), global-rank.md,
                        discovery-curate.md, profile-refine.md  (load via loadPrompt)
config/
  sources.yaml          channels + podcasts + individuals/companies; web UI edits this
  profile.md            interest profile (tier hierarchy + themes); web UI edits this
scripts/                ingest-podcasts, resolve-channels, recompose, rerank, discover,
                        discovery-audit, inspect-window, inspect-bundles, test-*, etc.
data/                   gitignored. state.db, transcripts/, briefs/, cookies.txt, backups/
```

---

## Path strategy: local vs Railway

**Detection**: presence of `RAILWAY_VOLUME_MOUNT_PATH`. Seeding logic is
top-level in `src/lib/config.js` (runs on import). Don't move config to env
vars or the DB — the file workflow is intentional.

| | Local (unset) | Railway (`/data`) |
|---|---|---|
| `DATA_DIR` | `ROOT/data` (gitignored) | `/data` (volume) |
| `CONFIG_DIR` | `ROOT/config` (git-tracked) | `/data/config` (writable, seeded from image on first empty boot) |
| Web bind | 127.0.0.1, auto-opens browser | 0.0.0.0, listens on `PORT` |

---

## Database — schema invariants

Tables (all migrations via `safeAlter` in `db.js#migrate` — never raw
`ALTER TABLE`; the helper swallows duplicate-column errors):

- `episodes` — one row per video OR podcast episode. `status`:
  `new → transcribed → extracted → ranked → delivered`, plus `skipped`
  (`skip_reason`). `source` is `subscribed`|`discovery`; `discovered_for` is the
  individual name. `medium` is `youtube` (default) or `podcast`. For podcasts:
  `feed_url`/`audio_url`/`episode_page_url` populated (NULL for YouTube),
  `channel_name` = show name, `video_id` = `pod_<16 hex>` (sha1 of normalized
  feed_url + guid|audio_url+pubdate — stable dedupe, can't collide with
  YouTube's 11-char IDs).
- `transcripts` — one per episode. `cues_json` = `[{start, end, text, speaker?}]`
  (`speaker` only for diarized WhisperX). `source` is `captions`|`transcript-io`|
  `whisperx-modal`.
- `candidates` — many per video. **IDs unstable across re-extracts**
  (saveCandidates DELETEs + re-INSERTs); referencing rows cascade.
- `rankings` — one per brief item. `candidate_id` primary; bundles store extras
  in `ranking_bundle_members`; `label` = bundle headline (NULL for singles).
  `display_quote` = rank-corrected quote for display (NULL → fall back to the
  candidate's raw `supporting_quote`). See "Quote correction" below.
- `ranking_bundle_members` — junction, ON DELETE CASCADE from both parents.
  Also carries per-member `display_quote` (same semantics as on `rankings`).
- `feedback` — per-candidate thumbs (`up`|`down`), CASCADE from candidates (so
  re-extract loses feedback).
- `discoveries` — every YouTube search result + LLM curation decision. Audit
  trail; survives non-promotion.
- `runs` + `cost_ledger` — telemetry. Every Claude call records tokens + $.

**`PRAGMA foreign_keys = ON` on every connection.** Deletes of parent rows must
clear children first OR rely on cascade. `saveCandidates` explicitly deletes
rankings first because `rankings.candidate_id` is a regular FK, not CASCADE.

---

## Pipeline contract

```
runDaily()                                 runEpisode({url, markDeliveredOnSend})
   ├─ backupDatabase()  (try/catch)            ├─ ingestEpisode(url)
   ├─ ingestDaily()                            ├─ transcribeEpisode()
   ├─ ingestPodcastsDaily()  (non-fatal)       ├─ extractEpisode()
   ├─ discoverIndividuals()                    ├─ rankEpisode()
   └─ for each resumable episode:              │
        transcribe → extract → rank            │
      composeBrief(eps) → globalRank → flat → deliver({markDeliveredOnSend?})
```
extract is skipped if status already `extracted`/`ranked`; rank always reruns on
non-delivered episodes.

Stage invariants:

- **transcribe** (medium router, `2-transcribe.js`): `youtube` →
  youtube-transcript.io (vendor sidesteps "yt-dlp caption fetch silently
  degraded from Railway IPs"). `podcast` → WhisperX-on-Modal HTTPS via
  `modal-transcribe.js` (audio has no captions). Same cue contract; differ only
  in `source` tag + per-cue `speaker`. **No fallback** (Groq Whisper rejected —
  caller accepts missed episodes); failure marks episode `skipped`. Cached
  transcripts reused. Env: `YOUTUBE_TRANSCRIPT_IO_TOKEN` (rate limit 5 req/10s,
  retries 429 honoring Retry-After) + `MODAL_TRANSCRIBE_URL`/
  `MODAL_TRANSCRIBE_SECRET` (submit then poll `/result` every 15s up to 40 min;
  GPU job ~14 min).
- **extract**: chunks long transcripts at ~240k chars with cue overlap. Filtered
  by `verifyNumericFidelity` (drops candidates whose claim has numbers absent
  from supporting_quote — the $75B-vs-$7.5B class). Skipped on re-runs when
  already `extracted`/`ranked` (deterministic + profile-independent). Model is
  `EXTRACT_MODEL`-selectable (Sonnet default, `opus` to A/B); this is the recall
  lever — extract sets the candidate ceiling rank can't recover from.
- **rank**: cheap (~$0.03). Always reruns on non-delivered so profile edits
  propagate. SINGLES `{candidate_id, rank, why_matters, corrected_quote?}` or
  BUNDLES `{candidate_ids:[...], rank, why_matters, label, corrected_quotes?}`.
  Bundling is text-signal driven in rank.md, no fixed cap. Model is
  `RANK_MODEL`-selectable (Sonnet default, `opus` to A/B). Also runs quote
  correction — see below.
- **compose**: runs global-rank for multi-episode briefs; single-episode skips
  it. Flat top-down ordinal list, no item cap. global-rank model is
  `GLOBAL_RANK_MODEL`-selectable (Sonnet default, `opus` to A/B).
- **deliver**: real mode refuses to send if `episodes.length === 0` (returns
  `{empty:true}`); ad-hoc endpoint surfaces this rather than emailing blank.

**markDeliveredOnSend**: `true` (default; daily, CLI `--episode`,
`recompose --send`) flips episodes to `delivered` so they won't reappear.
`false` (web ad-hoc URL) sends but keeps `ranked` so it also rolls into the next
daily brief.

**Ad-hoc URL** (`/api/summarize-url`): **medium-agnostic**. `ingestEpisode(url)`
auto-detects — `videoIdFromUrl` matches → YouTube; else → podcast via
`resolvePodcastEpisode` (`src/lib/podcast-resolve.js`), which accepts a direct
audio URL, an RSS feed (takes the latest item), or an episode page (scrapes the
enclosure: og:audio → JSON-LD → `<audio>`/`<source>` → `.mp3`-ish regex). Apple/
Spotify pages don't expose audio, so they fail with a clear message. Podcast
ad-hoc rows reuse the `pod_<hex>` id scheme (exported `episodeId` from rss.js).
`runEpisode({forceReprocess:true})` resets any non-`new` status to `new` after
ingest (user explicitly asked to process it — prior `skipped`/`delivered`/
`ranked` shouldn't short-circuit) and returns the resolved `video_id` (a
podcast's id isn't knowable from the pasted URL until the enclosure resolves).
Daily cron path is unchanged (respects `delivered`/`skipped`). Don't change
without considering retry-after-failure.

**Caveat (prod):** a podcast ad-hoc run is ~10-15 min (GPU) and can outlast
Cloudflare's ~100s edge timeout, so the browser may see a 524. Non-fatal — the
run finishes server-side and (markDeliveredOnSend:false) rolls into the next
daily brief, so no content is lost. If this becomes annoying, make the ad-hoc
path fire-and-forget + poll episode status from the UI.

---

## Cost discipline

- **Always cache the system prompt.** `src/lib/claude.js#complete`:
  `system: [{type:'text', text:systemPrompt, cache_control:{type:'ephemeral'}}]`.
  Non-negotiable for repeated calls (rank, global-rank, discovery-curate,
  profile-refine).
- **Always log via `recordCost`.** Automatic in `claude.complete()` when
  `telemetry.run_id` is provided; callers without a run_id (profile-refine, some
  global-rank paths) don't get cost logged — known gap, not a bug.
- **Pricing (Sonnet 4.6, USD/M tokens)**: input $3.00, output $15.00, cache_read
  $0.30, cache_write_5m $3.75. Hard-coded in `claude.js#MODEL_PRICING`.
- **Typical per-episode** (~1hr): extract $0.20 + rank $0.03 + global-rank $0.03
  ≈ $0.26. Daily with 3-5 episodes: ~$1-2 + discovery curation $0.05.

---

## Anthropic SDK conventions

- Models: `MODELS.SONNET` (default everywhere) + `MODELS.OPUS` (`claude-opus-4-8`).
  Adding a model → also add its `MODEL_PRICING` row. **The Opus pricing row is
  best-known, NOT verified** — confirm current Opus rates before trusting its $
  ledger (a wrong row only skews telemetry; `calcCost` returns 0 for unknown
  models, never blocks the call). Three independent per-pass Opus A/B knobs,
  each Sonnet by default, each `=opus` to flip: `EXTRACT_MODEL` (recall pass),
  `RANK_MODEL` (per-episode selection/synthesis), `GLOBAL_RANK_MODEL`
  (cross-episode ordering). Discovery curation stays Sonnet (no knob).
- System prompts via `loadPrompt('name')` → `prompts/name.md`. Never inline.
- `parseJsonResponse(text)` strips markdown fences + finds first `{`/`[`. Use on
  every model JSON output — models add fences even when told not to.
- Telemetry shape `{run_id?, video_id?, stage}`; `stage` is the only required field.

---

## node:sqlite — gotchas already hit

- **Strict binding.** No auto-coerce of `undefined`/`NaN`/`BigInt`/arrays/objects.
  Coerce before `.run()`. `db.js` pattern: `asStringOrNull(v)` (null→null,
  string→string, array→join, object→JSON.stringify, else String) and
  `Number.isFinite(x) ? Math.floor(x) : null` for numbers. Applied in
  `saveCandidates` + `upsertEpisode` — **load-bearing, don't simplify** (Claude
  returns arrays for `supporting_quote`; yt-dlp returns null `duration` for live
  streams).
- **Named params use `@field`** (not `:field`/`$field`).
- **"parameter N" errors** map to the Nth positional `?` OR Nth `@field` in the
  prepared statement — count carefully.
- **No CLOSE on the global db()** — module-level singleton.

---

## yt-dlp invocation patterns

All calls go through `run()` in `youtube.js` (+ `runYtDlp()` in
`discovery-search.js`), both prepending `commonArgs()`:
- `--cookies <DATA_DIR>/cookies.txt` if present (required on Railway for bot-detection)
- `--ignore-no-formats-error` always (live/premiere/members-only first-on-channel
  videos abort format selection otherwise)

Learned patterns:
- **Channel ID**: `--flat-playlist --playlist-end 1 --print "playlist:%(channel_id)s"`.
  The `playlist:` prefix is critical — per-video `%(channel_id)s` returns `"NA"`
  in flat mode.
- **Uploads listing**: `--flat-playlist --playlist-end <N> --dump-json` (line-by-line JSON).
- **Single-video metadata**: `--dump-json --skip-download` (no flat).
- **Captions** (used elsewhere, not transcription): `--write-subs --write-auto-subs`
  both — auto-subs alone misses manual/creator subs.
- **Audio download / Whisper: REMOVED.** yt-dlp is no longer involved in
  transcription.

---

## Modal transcription worker (podcasts)

Audio podcasts have no captions → transcribed by a **WhisperX worker on
[Modal](https://modal.com)** (Python, separate cloud + deploy lifecycle). Node
calls it over HTTPS, never imports it. Lives in `modal_worker/`. **This does NOT
reintroduce Whisper for YouTube** — different decision for a different medium.

- **Run/deploy** (Windows): prefix `$env:PYTHONUTF8=1` (Modal's `✓` glyphs crash
  cp1252 stdout — cosmetic). Invoke `py -m modal ...` (not on PATH).
  `run` = ephemeral, `deploy` = publishes the FastAPI `web` endpoint.
- **Image (load-bearing pins):** `debian_slim(3.11)` + ffmpeg + matched torch
  trio **torch 2.7.1 / torchaudio 2.7.1 / torchvision 0.22.1** + **whisperx 3.7.2**
  (whisperx needs torch≥2.7.1; pin the trio so install doesn't pull a mismatch).
- **nltk `punkt` + `punkt_tab` baked in (load-bearing).** whisperx alignment
  sentence-splits via nltk; data not shipped with the pip package. Missing →
  `LookupError: punkt_tab` **only on cold containers** (masquerades as flakiness).
  Image runs `nltk.downloader ... punkt punkt_tab`. Download BOTH names (nltk
  renamed punkt→punkt_tab but whisperx probes the old name first).
- **Two mandatory shims in `transcribe.py`, before any model load:**
  1. `torch.load` forced `weights_only=False` (torch 2.7 defaults True, rejects
     pyannote's omegaconf checkpoints). Force it, don't `setdefault` —
     `lightning_fabric` passes True explicitly.
  2. `hf_hub_download`/`snapshot_download` translate `use_auth_token=`→`token=`
     (pyannote 3.4 passes the removed kwarg; newer huggingface_hub renamed it).
     No single hf_hub satisfies both pyannote + transformers — don't "fix" by pinning.
- **Model-weight caching:** Modal Volume `whisperx-cache` at `/cache`,
  `HF_HOME`/`TORCH_HOME` pointed in; `cache_vol.commit()` after a run. Else every
  cold start re-downloads ~4GB on billed GPU.
- **HF token:** gated pyannote models (`speaker-diarization-3.1` +
  `segmentation-3.0`, both license-accepted) via Modal secret `huggingface`
  (key `HF_TOKEN`).
- **HTTPS endpoint — LIVE** at `https://adambruton--podcast-transcribe-web.modal.run`.
  Job-queue (GPU job ~14 min): `POST /transcribe {audio_url, clip_seconds?}` →
  `{call_id}`; `GET /result/{call_id}` → 200 `{status:"done", result:{...}}` /
  202 `{status:"pending"}` / 410 once retention lapses. Auth: shared bearer token
  from Modal secret `transcribe-auth` (key `TRANSCRIBE_SECRET`). Node reads
  `MODAL_TRANSCRIBE_URL`/`MODAL_TRANSCRIBE_SECRET`. Web container is fastapi-only
  (cold-starts fast, scales to zero); GPU image spins up only in the spawned call.
- **Output:** cues `[{start, end, text, speaker}]`; `speaker` is anonymous
  `SPEAKER_NN` (no real names).
- **Cost:** ~$0.18 per 90-min episode (L4 $0.000222/s); ~15 ep/week ≈ ~$11/mo,
  inside the $30 free credit.

---

## Database backup & restore

- **Snapshots**: `backupDatabase()` in `backup.js` → gzipped
  `<DATA_DIR>/backups/state-<ts>.db.gz` via `VACUUM INTO` (clean single file
  regardless of WAL state).
- **Schedule**: at the START of `runDaily`, try/catch (a failed backup must not
  block the brief).
- **Rotation**: keep last 14 snapshots by mtime. Pre-restore snapshots
  (`state.pre-restore-<ts>.db`, uncompressed) are NOT rotated.
- **Off-site**: Sunday UTC, daily snapshot also emailed via Resend (≤20 MB;
  ~3 KB now). Silently skipped if email env unset.
- **Restore** (`POST /api/admin/restore-db`): accepts `application/octet-stream`,
  validates SQLite magic bytes, snapshots current to `state.pre-restore-<ts>.db`,
  `resetDb()` closes singleton, deletes stale WAL/SHM, atomically renames upload
  over `DB_PATH`, reopens via `db()` (surfaces bad-upload errors in the response).
  Process keeps running — Railway `restartPolicyType=ON_FAILURE` does NOT restart
  after `process.exit(0)` (the old exit-and-restart approach stranded the service).
- **Cloudflare Access** protects admin endpoints in prod. If you ever bind
  0.0.0.0 outside Railway, gate `/api/admin/*` behind a token first.

---

## Web UI conventions

- **Errors via `setErr(elemId, message)`** (auto-fade 6s, dismissible). Never
  raw `el.textContent = err.message`.
- **No build step.** Vanilla JS + inline `<style>`/`<script>`.
- **Auth lives at Cloudflare**, not the app. No Express auth middleware — don't
  add one without first removing the Cloudflare Access policy.
- **Profile + sources edits** round-trip via the yaml Document API
  (`sources-store.js`/`profile-store.js`) — preserves comments + key order.
  Never `YAML.parse() → YAML.stringify()`.
- **Podcasts** (`sources-store.js`): `addPodcast`/`removePodcast`/`patchPodcast`
  keyed by feed **url** (names collide with channels); mutation routes carry the
  url in the request **body** (encoded slashes break path params behind proxies).
  `listEpisodesWithCounts({medium})` filters in SQL; `GET /api/episodes?medium=…`.
- **Feedback workflow**: thumbs per candidate → "Suggest refinements" collects
  feedback + profile → Claude proposes revised profile.md → user reviews diff
  (`diff` npm pkg, +/− lines) → applies or discards. Profile editor itself is
  behind an "Advanced: edit raw profile.md" `<details>`.

---

## Prompt-editing conventions

- **profile.md is the bias function.** Its "Priority hierarchy" (Tier 1/2a/2b/3)
  is the ranking rubric read by rank.md + global-rank.md. Edits ripple through both.
- **Tune via the feedback loop**, not hand-edits, when possible. Hand-edits are
  for structural changes (whole sections).
- **Don't strip the tier hierarchy** when adding themes. New themes go in
  `## Themes I care about` with a tier callout in the heading.
- **Bundling lives in rank.md** (text-signal driven, no count cap). If
  overproduction appears, tighten the "synthesis test" language, don't add a ceiling.
- **number-fidelity check** (`number-check.js`) drops candidates whose claim has
  numbers absent from supporting_quote. Belt-and-suspenders with the prompt's
  "Numbers must match" rule — don't remove.

---

## Quote correction (display-only, rank pass)

The brief's `supporting_quote` is ASR output and sometimes mis-hears words
(proper nouns, homophones). The rank pass — which understands episode context —
emits a lightly **corrected** quote per selected item (`corrected_quote` /
`corrected_quotes` keyed by candidate_id). Invariants (don't weaken):

- **Raw `supporting_quote` is never mutated.** It stays the audit trail and the
  number-fidelity input. The correction is stored separately as `display_quote`
  (on `rankings` + `ranking_bundle_members`); compose renders
  `display_quote || supporting_quote`.
- **Corrections are validated, not trusted** — `validateCorrectedQuote` in
  `number-check.js` rejects (→ falls back to raw) any correction that: invents a
  numeral not in the raw quote, drops a number the claim needs, injects too much
  new content (new-word budget — trimming filler is free, rewriting toward the
  lead-in is caught), or balloons the length. This is what keeps the
  $75B↔$7.5B class from sneaking back in via "correction".
- **It's a fix toward what was *said*, not toward `why_matters`.** rank.md says
  so explicitly; the new-word budget enforces it mechanically.
- Off-switch: `QUOTE_CORRECTION=off` shows raw quotes (A/B the feature
  independent of `RANK_MODEL`). `node scripts/test-number-check.js` covers both
  the numeric guard and the corrected-quote validator.

---

## Operational notes

- **Cookies** at `data/cookies.txt` (local) or `/data/cookies.txt` (Railway).
  Exported from logged-in Chrome via "Get cookies.txt LOCALLY". Required in prod
  (YouTube blocks datacenter IPs); optional locally on residential IPs.
- **state.db survives Railway deploys** via the volume — don't assume wipe.
- **Daily brief in-process** via `scheduleDailyRun` in `server.js`, fires 08:00
  UTC (= 4am EDT / 3am EST; moved earlier from 10:00 to buffer podcast
  transcription; drifts 1h vs ET across DST — acceptable). Scheduler only starts
  when `PORT` is set (Railway); locally use `npm run brief`. Manual prod trigger:
  `POST /api/admin/run-daily` (CF Access, fire-and-forget). No separate cron.
- **Ad-hoc URLs**: `POST /api/summarize-url` → `runEpisode({url,
  markDeliveredOnSend:false})` — intentionally not marked delivered.

---

## Common pitfalls (debugged — don't relearn)

- **PowerShell eats `$1`** in regex replacement strings — single-quote or temp file.
- **`Invoke-RestMethod -Method Post` without `-Body` hangs** on stdin — pass `-Body '{}'`.
- **PowerShell stderr-redirect makes native commands look failed** even on exit 0
  — don't add `2>&1` to npm calls.
- **Bash tool sees a different PATH** — Node/yt-dlp/ffmpeg NOT on it. Use
  PowerShell with a `$env:Path` Machine+User refresh for Node commands.
- **node:sqlite "parameter N"** → Nth positional `?` or Nth `@field`.
- **yt-dlp `--flat-playlist` returns "NA"** for per-video channel_id — use
  `--print "playlist:%(channel_id)s"`.
- **Express 5 dropped regex routes** — use simple `:param`, route per-path.
- **Railway volumes are single-attach** — two services can't share a filesystem.
  Keep all work in one service.
- **Cloudflare Access OTPs are single-use** — "doesn't work" = already redeemed.

---

## What's STABLE — don't undo

- **Transcripts come from youtube-transcript.io.** yt-dlp caption fetch is
  silently degraded from Railway datacenter IPs even with cookies — works
  locally, fails in prod. Don't reintroduce it.
- **Whisper fallback deliberately removed** (for YouTube). Considered and
  rejected; user accepts missed episodes over audio-download + Groq complexity.
  (WhisperX-on-Modal for podcasts is a separate decision — audio has no captions.)
- **Defensive coercion in saveCandidates + upsertEpisode is load-bearing** (see
  node:sqlite gotchas). Don't simplify "for cleanliness".
- **`markDelivered` flips BOTH `rankings.included_in_brief_at` AND
  `episodes.status='delivered'`.** The status flip is load-bearing — without it
  `resumableEpisodes()` re-picks the episode daily and re-sends forever. An
  idempotent backfill in `migrate()` flips historical `ranked`-but-emailed rows.
  Leave both.

---

## When NOT to do things

- Don't replace yt-dlp with a JS YouTube library (libraries break in weeks).
- Don't add a frontend framework or a DB migration framework (`safeAlter` is enough).
- Don't add auth code to Express (Cloudflare Access handles it).
- Don't commit `data/`, `.env`, or `cookies.txt` (gitignored).
- Don't bake state.db into the Docker image (volume + manual seed).

---

## Status: podcasts as a first-class medium — DONE

Phases 1-5 complete: schema (`medium` + feed/audio/page URLs, `pod_<hex>` IDs),
WhisperX-on-Modal worker (deployed + live), medium-router transcribe, end-to-end
through `runDaily` (`ingestPodcastsDaily` with a `lookbackDays=2` back-catalog
guard; podcasts transcribe sequentially), and web UI (Podcasts section + medium
filter/badge). Phases 6-8 (compose/deliver polish) are later/optional.

Podcasts reuse the extract→rank→compose→deliver stages unmodified; only ingest +
transcribe are medium-specific. Revisit sequential transcription with a cap or
parallelism if mornings get slow.

---

## Open work / deferred

- **State migration to Railway: tooling built, run once.** Upload local state.db
  via web UI ("Database backup & restore" → "Restore from file") or
  `npm run upload-state-db` with `ADMIN_UPLOAD_URL` + `CF_ACCESS_CLIENT_ID/SECRET`.
  Snapshots prod DB, swaps upload, resets singleton — no restart.
- **No failure alerting for the daily cron.** If the brief errors (rate limit,
  API outage, transcript-io down) nothing fires. Possible: catch non-zero exit →
  webhook, or always include episode count in subject so absent mail is a signal.
- **6 disabled sources need handle fixes** in sources.yaml (`enabled:false`):
  Sharp Tech, Logan Bartlett, Google DeepMind, Fireworks AI, Baseten, Cloudflare.
- **Minor gaps**: dropped candidates have no LLM rejection reason (extend rank.md,
  ~+$0.003/ep); no "re-rank this episode" button in the inspector (CLI only:
  `node scripts/rerank.js <video_id>`).
- **Tokens to rotate** (appeared inline in old debug logs): `RAILWAY_API_TOKEN`,
  `YOUTUBE_TRANSCRIPT_IO_TOKEN`, `TRANSCRIBE_SECRET` (Modal `transcribe-auth`;
  rotate via `py -m modal secret create transcribe-auth TRANSCRIBE_SECRET=<hex>
  --force` then update env). Anthropic + Resend keys live in gitignored `.env`.

---

## Useful commands

```powershell
# Local dev
npm run web                                    # web UI (http://localhost:3000)
npm run brief                                  # daily run, send email
npm run brief:dry                              # daily run, write HTML to disk
node src/cli.js --episode "<url>" --dry-run    # ad-hoc, no email

# Inspection
npm run discovery:audit [days] [decision]
node scripts/inspect-bundles.js <video_id>
node scripts/inspect-window.js <video_id> <sec>

# Iteration
npm run resolve-channels                       # populate channel_id from @handle
node scripts/rerank.js [<video_id>]            # re-rank without re-extract
node scripts/recompose.js [--send]             # re-render brief from current state

# Backup / restore
npm run backup [-- --email]                    # local snapshot (also UI button)
$env:ADMIN_UPLOAD_URL="https://<deploy>/api/admin/restore-db"
$env:CF_ACCESS_CLIENT_ID="..."; $env:CF_ACCESS_CLIENT_SECRET="..."
npm run upload-state-db                        # push local data/state.db to prod

# Railway
railway login; railway link; railway ssh
```
