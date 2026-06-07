# podcast-summary-agent

A daily intelligence brief surfacing high-signal moments from tech/AI podcasts,
biased by an editable interest profile. Polls a set of YouTube channels and
podcast RSS feeds (and optionally searches YouTube for named people /
companies), pulls transcripts (YouTube captions via youtube-transcript.io;
podcast audio via a WhisperX-on-Modal GPU worker), runs Claude over them to
extract and rank notable claims, and emails an HTML brief with timestamp
deep-links. Tune the bias by editing `config/profile.md` through the included
web UI.

Architecture notes and design rules live in [`CLAUDE.md`](./CLAUDE.md). This
README is just the "how do I run it?" guide.

---

## Local quickstart

Requires Node 22.5+.

```bash
git clone <this-repo>
cd podcast-summary-agent
npm install

# bring your own keys (see "Required accounts" below)
cp .env.example .env
# edit .env

# open the web UI on http://localhost:3000 (auto-opens your browser)
npm run web
```

From the UI you can edit `config/sources.yaml` (channels + watched
individuals/companies) and `config/profile.md` (the ranking bias).

Then run the pipeline:

```bash
npm run brief:dry          # full daily run, writes HTML to data/briefs/, no email sent
npm run brief              # same but emails via Resend
```

The web UI binds to `127.0.0.1` locally, so it's only reachable from your own
machine. Nothing is shared with anyone else's deployment.

---

## Required accounts

You need a few third-party accounts. All have free tiers that are plenty for
personal use.

| Service | What it's for | Env var | Sign up |
|---|---|---|---|
| **Anthropic** | LLM (Claude) for extract + rank passes | `ANTHROPIC_API_KEY` | https://console.anthropic.com |
| **youtube-transcript.io** | Fetching YouTube captions | `YOUTUBE_TRANSCRIPT_IO_TOKEN` | https://www.youtube-transcript.io |
| **Resend** | Sending the daily brief email | `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_TO` | https://resend.com |
| **Modal** | GPU transcription of **podcast** audio (WhisperX) | `MODAL_TRANSCRIBE_URL`, `MODAL_TRANSCRIBE_SECRET` | https://modal.com |
| **Hugging Face** | Gated diarization models the Modal worker loads | (Modal secret, not a Node env var) | https://huggingface.co |

Anthropic + youtube-transcript.io are the only hard requirements for a
**YouTube-only** setup. The rest are conditional:

- **Resend** is optional if you only ever run `--dry-run` (the HTML lands in
  `data/briefs/` and you can open it directly). `MAIL_FROM`'s domain must be
  verified in Resend before it will deliver.
- **Modal + Hugging Face** are only needed if you ingest **podcast RSS feeds**.
  Podcasts have no captions, so they're transcribed on a GPU worker — see
  "Podcast transcription worker (Modal)" below. Skip both for a YouTube-only
  brief.

Typical per-day Anthropic spend with a handful of episodes is ~$1–2. See the
"Cost discipline" section of CLAUDE.md.

---

## Optional: YouTube cookies

If you deploy to a datacenter IP (Railway, Fly, etc.), YouTube may block
unauthenticated requests for video metadata. To work around this, export your
logged-in YouTube cookies and place them at `data/cookies.txt`:

1. Install the "Get cookies.txt LOCALLY" browser extension.
2. Log into YouTube in your browser.
3. Export cookies for `youtube.com`, save as `data/cookies.txt`.
4. On Railway: upload it to the persistent volume (or paste via SSH).

You can usually skip this when running locally on a residential connection.

---

## Podcast transcription worker (Modal)

Audio podcasts have no captions, so podcast episodes are transcribed by a
[WhisperX](https://github.com/m-bain/whisperX) worker running on
[Modal](https://modal.com) (GPU). It's a **separate Python service** with its
own deploy lifecycle — the Node app never imports it, only calls it over HTTPS.
Lives in `modal_worker/transcribe.py`.

**You only need this if you ingest podcast RSS feeds.** A YouTube-only setup can
skip the whole section (those go through youtube-transcript.io instead). Without
it, podcast episodes ingest fine but immediately fail to transcribe, get marked
`skipped`, and never reach the brief.

### One-time worker setup

1. **Create a Modal account** (https://modal.com), install the CLI, and
   authenticate:

   ```bash
   pip install modal
   python -m modal token new
   ```

2. **Create a Hugging Face account** and accept the license on both gated
   pyannote models (one click each, while logged in):
   - https://huggingface.co/pyannote/speaker-diarization-3.1
   - https://huggingface.co/pyannote/segmentation-3.0

   Then create a **read** token at https://huggingface.co/settings/tokens.

3. **Create the two Modal secrets** the worker expects:

   ```bash
   # HF token for the gated diarization models (injected into the worker as HF_TOKEN)
   python -m modal secret create huggingface HF_TOKEN=hf_xxx

   # Shared bearer token the Node app uses to authenticate to the worker.
   # Use any long random hex — you'll reuse the SAME value as
   # MODAL_TRANSCRIBE_SECRET when wiring up the Node app below.
   python -m modal secret create transcribe-auth TRANSCRIBE_SECRET=<random-hex>
   ```

4. **Deploy the worker.** On Windows, prefix `$env:PYTHONUTF8=1` first (Modal's
   `✓` glyphs crash cp1252 stdout — cosmetic, but it aborts the command):

   ```bash
   python -m modal deploy modal_worker/transcribe.py
   ```

   Modal prints the published endpoint, e.g.
   `https://<your-username>--podcast-transcribe-web.modal.run`. That URL is your
   `MODAL_TRANSCRIBE_URL`.

### Wiring it to the Node app

Set two env vars — locally in `.env`, and in production on Railway:

```
MODAL_TRANSCRIBE_URL=https://<your-username>--podcast-transcribe-web.modal.run
MODAL_TRANSCRIBE_SECRET=<the same hex you used for the transcribe-auth secret>
```

`MODAL_TRANSCRIBE_SECRET` must match the `TRANSCRIBE_SECRET` value inside the
`transcribe-auth` Modal secret, or the worker returns 401.

The worker scales to zero between jobs; a 90-minute episode is ~14 min of GPU
(~$0.18). Model weights are cached on a Modal volume so cold starts don't
re-download ~4 GB each run. Deeper details (image pins, the two load-bearing
shims, the job-queue contract) are in the "Modal transcription worker" section
of [`CLAUDE.md`](./CLAUDE.md).

---

## Production deployment (Railway)

Railway is what's tested. Any host that can run Node 22 and persist a volume
will work — substitute as needed. No separate cron job needed: the daily
brief is scheduled from inside the web service's Node process.

### One-time Railway setup

1. **Create a Railway project.** https://railway.app → New Project → Empty Project.
2. **Add a single service** pointed at your fork of this repo. It uses
   `railway.json`, which runs `npm run web` and exposes a `/healthz`
   healthcheck. The service stays running 24/7 and serves both the web UI
   and the daily brief (via an in-process `setTimeout` that fires at 08:00
   UTC = 4am EDT / 3am EST — see `scheduleDailyRun` in `src/web/server.js`).
3. **Attach a persistent volume** to the service. Mount path: `/data`.
   Railway sets the env var `RAILWAY_VOLUME_MOUNT_PATH=/data` automatically,
   which switches the code into production-paths mode (state.db, transcripts,
   briefs, cookies, and `/data/config/` all live on the volume).
4. **Set environment variables** on the service:

   ```
   ANTHROPIC_API_KEY=sk-ant-...
   YOUTUBE_TRANSCRIPT_IO_TOKEN=...
   RESEND_API_KEY=re_...
   MAIL_FROM=you@yourdomain.com
   MAIL_TO=you@yourdomain.com
   # Only if you ingest podcasts (see "Podcast transcription worker" above):
   MODAL_TRANSCRIBE_URL=https://<your-username>--podcast-transcribe-web.modal.run
   MODAL_TRANSCRIBE_SECRET=<hex matching the transcribe-auth Modal secret>
   ```

   > **Don't forget the two `MODAL_*` vars if you use podcasts.** They live on
   > the Modal side too, so it's easy to deploy the Node app without them — in
   > which case every podcast silently fails to transcribe.

5. **Expose the service** at a public domain. Settings → Networking →
   Generate Domain (or attach a custom one). At this point the UI is reachable
   on the public internet **with no auth** — set up Cloudflare Access before
   sending anyone the URL (see next section).

6. **Seed your configuration.** On first boot, the service copies the
   committed `config/profile.md` and `config/sources.yaml` from the image into
   `/data/config/`. After that, edits via the web UI persist on the volume
   across deploys. If you want to migrate an existing local `state.db`, use
   the UI's "Database backup & restore → Restore from file" button.

### Triggering a daily run manually

Once deployed, the scheduler logs a line at startup like
`daily brief scheduled {"at":"YYYY-MM-DDT08:00:00.000Z","in_hours":"N.NN"}`.
If you want to fire a run on demand (e.g. to test after a config change), POST
to `/api/admin/run-daily`. Returns immediately; the pipeline runs in the
background. Watch Railway service logs for `daily run finished {ms: NNNNN}`.

```bash
curl -X POST \
  -H "CF-Access-Client-Id: <service-token-id>" \
  -H "CF-Access-Client-Secret: <service-token-secret>" \
  https://your-deployment.example.com/api/admin/run-daily
```

### Putting Cloudflare Access in front of the web UI

The Express server has no built-in auth — auth lives at Cloudflare. This setup
is free, takes about 10 minutes, and gives you SSO/email-OTP login.

1. **Point the domain through Cloudflare.** Add your domain to Cloudflare (or
   use a subdomain you already manage there). Create a `CNAME` record pointing
   to the Railway-provided hostname.
2. **Enable Zero Trust** at https://one.dash.cloudflare.com → Zero Trust →
   Access → Applications → Add an application → **Self-hosted**.
3. **Add an Access policy.** Application domain: your chosen hostname.
   Policy: `Include` → `Emails` → list the addresses (yours + anyone you
   want to share UI access with). Action: `Allow`. Identity provider:
   `One-time PIN` (email OTP) is the simplest.
4. **Done.** Anyone hitting the hostname now gets a Cloudflare email-OTP
   challenge before reaching the app.

If you only need to access the UI from your own machine, you can skip auth
entirely: set `RAILWAY_TCP_PROXY_PORT` or use `railway ssh` to tunnel into the
container and access the UI via SSH port-forwarding. Just **do not expose the
web service on a public hostname without auth** — the `/api/admin/*` endpoints
allow database restore.

---

## Env vars reference

| Variable | Required? | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Claude API key |
| `YOUTUBE_TRANSCRIPT_IO_TOKEN` | yes | Transcript service token |
| `RESEND_API_KEY` | for email | Omit to use `--dry-run` only |
| `MAIL_FROM` | for email | Domain must be verified in Resend |
| `MAIL_TO` | for email | Recipient address |
| `MODAL_TRANSCRIBE_URL` | for podcasts | Modal worker endpoint; see "Podcast transcription worker (Modal)" |
| `MODAL_TRANSCRIBE_SECRET` | for podcasts | Must match the `transcribe-auth` Modal secret's `TRANSCRIBE_SECRET` |
| `RAILWAY_VOLUME_MOUNT_PATH` | auto-set by Railway | Triggers production-paths mode when present |
| `PORT` | auto-set by Railway | Web server binds `0.0.0.0:$PORT` when set |
| `WEB_PORT` | optional, local only | Default 3000; binds `127.0.0.1` |

---

## Useful commands

```bash
npm run web                            # web UI
npm run brief                          # daily run, send email
npm run brief:dry                      # daily run, write HTML to disk only
node src/cli.js --episode "<url>"      # ad-hoc, single video
npm run resolve-channels               # populate channel_id from @handle
npm run discovery:audit                # inspect recent discovery decisions
npm run backup                         # snapshot state.db to data/backups/
```

For everything else — architecture, schema invariants, cost notes, known
pitfalls — see [`CLAUDE.md`](./CLAUDE.md).
