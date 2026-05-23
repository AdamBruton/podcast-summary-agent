# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                                       # one-time
npm run brief                                     # daily run, send via SendGrid
npm run brief:dry                                 # daily run, write HTML to data/briefs/<date>.html
node src/cli.js --episode "<youtube-url>" --dry-run   # single-episode dry run (useful for prompt iteration)
node src/cli.js --lookback 7 --dry-run            # daily run with a wider window than the default 2 days
npm run resolve-channels                          # populate empty channel_id fields in config/sources.yaml
node scripts/inspect-window.js <video_id> <timestamp_sec>   # dump candidates + raw cues around a timestamp (extract-vs-rank diagnosis)
node scripts/test-canonicalize.js                 # sanity-check the caption-term canonicalization regex table
```

There is no test framework. `scripts/test-canonicalize.js` is a hand-rolled assertion script — add a similar script if you need tests for a new bit of pure logic.

Node 22.5+ required (uses built-in `node:sqlite`, which emits an `ExperimentalWarning` — expected, not a bug).

External binaries: **yt-dlp** (use `pip install -U yt-dlp`, not apt — the apt version is usually stale enough that YouTube extraction breaks) and **ffmpeg**.

## Architecture

Six-stage linear pipeline; each stage is one file in `src/stages/` and writes its output to SQLite (`data/state.db`) so re-runs resume from where they crashed.

```
ingest → transcribe → extract → rank → compose → deliver
 (yt-dlp) (captions   (Claude   (Claude  (HTML)  (SendGrid
          or Groq)    extract)  rank)             or disk)
```

**Episode status state machine** lives in the `episodes.status` column: `new → transcribed → extracted → ranked → delivered`, plus a terminal `skipped` with `skip_reason`. `pipeline.js` resumes any episode whose status is in `RESUMABLE` (everything between `new` and `ranked`), so killing a run mid-way and re-running is safe and cheap.

**Two-pass Claude** (`src/lib/claude.js` wraps the SDK):
- *Extract* (`prompts/extract.md`) reads the full transcript and emits candidate moments — biased for recall.
- *Rank* (`prompts/rank.md`) reads candidates + `config/profile.md` and selects the top N — biased for precision against the user's interest profile.
- Both system prompts are passed with `cache_control: ephemeral`. When the daily run processes multiple episodes the second+ calls hit cache, making per-episode cost ~$0.05 instead of ~$0.20. **If you change either prompt, the cache invalidates** — verify the new run still amortizes by checking `cache_read_input_tokens` in the logs.
- Per-call token usage is written to `cost_ledger`; `runs.total_usd` is the rollup.
- Model and pricing are hardcoded in `MODELS` and `MODEL_PRICING` constants. **When upgrading the model, update both** — pricing is per-million tokens and the `cache_write_5m` rate matters.

**Transcript sourcing** (`src/stages/2-transcribe.js`): YouTube auto-captions first (free, via yt-dlp `--write-auto-subs`). Falls back to Groq Whisper if `GROQ_API_KEY` is set. The 25 MB Groq upload cap is checked *after* download but before upload — episodes that exceed it get `status='skipped'` rather than retrying forever. Captions arrive as overlapping rolling cues; `dedupeRollingCues()` in `src/lib/youtube.js` collapses them.

**Long-transcript chunking** (`src/stages/3-extract.js`): >240k chars splits into chunks with 8 cues of overlap so claims spanning a boundary aren't lost. Chunks are deduped by `(timestamp ±10s, first 50 chars of claim)`.

**Caption-term canonicalization** (`src/stages/5-compose.js`): auto-captions reliably mangle domain terms ("cloud code" → Claude Code, "tranium" → Trainium, "gawatts" → gigawatts). `CANONICAL_TERMS` is a word-boundaried regex table applied only to `supporting_quote` before HTML render. **When you spot a new mangling, add it there** — model-generated `claim` fields arrive clean and are not rewritten.

## Configuration model

- `config/sources.yaml` — three sections (`channels`, `individuals`, `companies`). `loadSources()` flattens channels + companies into a single channel list and silently drops entries with `enabled: false`. `individuals` is a separate list used by the ranker. Empty `channel_id` fields are populated in-place by `npm run resolve-channels` using the yaml `Document` API (preserves comments and key order).
- `config/profile.md` — free-form markdown describing what the user cares about. Loaded verbatim into the rank prompt. Edit this to bias ranking; no code changes needed.
- `prompts/extract.md`, `prompts/rank.md` — system prompts. Plain markdown.

## Env, secrets, network

`requireEnv()` validates lazily — env vars are only required by the stages that use them, so dry runs work without SendGrid creds. `dotenv` is loaded with `override: true` so the project `.env` wins over a stale shell-set variable.

**YouTube 403 on cloud / CI IPs**: YouTube blocks anonymous requests from non-residential IP ranges. Set `YT_COOKIES_FILE` (Netscape-format cookies.txt exported from a logged-in browser) and every yt-dlp call (`src/lib/youtube.js` `cookieArgs()`) threads `--cookies` through. Unset is the right default on a laptop. `cookies.txt` is gitignored.

**Cost guardrail**: `--max-usd <amount>` (or `MAX_USD_PER_RUN` env) sets a per-run budget. Implementation is a single `checkBudget()` call at the end of every `claude.complete()` — queries `SUM(cost_ledger.usd_cost)` for the active run, throws `BudgetExceededError` when over. In daily mode, `runDaily()` catches the error from the per-episode loop and composes a brief from episodes already ranked; the partially-processed episode resumes on next run. Test logic without paying for real Claude calls: `node scripts/test-budget.js` populates `cost_ledger` directly and asserts threshold behavior.

## Foreign-key gotcha when re-extracting

`rankings.candidate_id` has a FK to `candidates.id`. To re-run extract on an already-extracted episode you must delete rankings *first*, then candidates — `saveCandidates()` already does this in the right order, but any future code that touches these tables must respect the same order or sqlite will reject the delete.
